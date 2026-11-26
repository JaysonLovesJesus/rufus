import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ContinuousBrain,
  Engine,
  FakeProvider,
  MasterLoop,
  ToolRegistry,
  UnifiedDaemon,
  brainEvent,
  loadChatHistory,
  memoryWriteTool,
  parseBrainStep,
  MAX_STEPS_PER_WAKE,
  relevantProjectsSection,
  runLayer3Prepare,
  runLayer3Eval,
  writeSelfMap,
  readSelfMap,
  type AiRequest,
  type BrainEvent,
  type IncomingMessage,
  type LiveChannel,
  type ToolDefinition,
} from '../src';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 14, 0); // a Wednesday afternoon
const SATURDAY = new Date(2026, 10, 28, 10, 0);

async function put(dir: string, rel: string, text: string): Promise<void> {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

const actions = (...a: unknown[]): string => JSON.stringify({ actions: a });
const say = (text: string) => ({ type: 'say', text });
const rest = { type: 'rest' };

/** The awareness message the model saw on call `n`. */
const seenBy = (req: AiRequest): string => req.messages.map((m) => String(m.content)).join('\n');

const webSearch = (calls: unknown[] = []): ToolDefinition => ({
  name: 'web.search',
  description: 'Search the web. args: {"query":"..."}',
  readOnly: true,
  execute: (args) => {
    calls.push(args);
    return [{ title: 'Trail runners compared', snippet: 'Model A: 280g, $140. Model B: 310g, $120.' }];
  },
});
const beeperSend = (sent: unknown[]): ToolDefinition => ({
  name: 'beeper.send',
  description: 'Send a chat message to someone. args: {"chatTitle":"...","text":"..."}',
  sensitivity: ['external'],
  execute: (args) => void sent.push(args),
});
/** A write that pretends to be read-only: the brain must still never run it. */
const sneakyShell = (ran: unknown[]): ToolDefinition => ({ name: 'shell.run', description: 'Run a command', readOnly: false, execute: (a) => void ran.push(a) });

const TASTE = `export function verifyDraft(text) { return /[\\u2014\\u2013]/.test(text) ? ['no em-dashes'] : []; }`;
const BOUNDARIES = `export function canActNow(ctx) { return ctx.now.getDay() === 6 ? { allow: false, reason: 'Saturday is protected (' + ctx.action + ')' } : { allow: true }; }`;

function outlet() {
  const said: Array<{ text: string; proactive: boolean }> = [];
  const reacted: Array<{ emoji: string; messageId: string }> = [];
  return {
    said,
    reacted,
    outlet: {
      say: async (text: string, o: { proactive: boolean }) => void said.push({ text, proactive: o.proactive }),
      react: async (emoji: string, messageId: string) => void reacted.push({ emoji, messageId }),
    },
  };
}

const owner = (text: string, n: number, at = NOW): BrainEvent => brainEvent('owner_message', text, { id: `m${n}`, at: new Date(at.getTime() + n * 1000), meta: { messageId: `tg-${n}` } });

// ---------- parseBrainStep ----------

describe('v26 parseBrainStep: structured actions, robust to any model', () => {
  it('reads {"actions":[...]}, a bare array, one action, and fenced JSON', () => {
    expect(parseBrainStep(actions(say('hey'), { type: 'react', emoji: '👍' }, { type: 'tool', name: 'web.search', args: { query: 'x' } }, { type: 'continue', note: 'n' }, rest))).toEqual([
      { type: 'say', text: 'hey' },
      { type: 'react', emoji: '👍' },
      { type: 'tool', name: 'web.search', args: { query: 'x' } },
      { type: 'continue', note: 'n' },
      { type: 'rest' },
    ]);
    expect(parseBrainStep('[{"type":"say","text":"a"},{"type":"rest"}]')).toEqual([{ type: 'say', text: 'a' }, { type: 'rest' }]);
    expect(parseBrainStep('{"type":"react","emoji":"❤️","messageId":"9"}')).toEqual([{ type: 'react', emoji: '❤️', messageId: '9' }]);
    expect(parseBrainStep('```json\n{"actions":[{"type":"say","text":"fenced"}]}\n```')).toEqual([{ type: 'say', text: 'fenced' }]);
    expect(parseBrainStep('Sure thing:\n```json\n{"actions":[{"type":"rest"}]}\n```')).toEqual([{ type: 'rest' }]);
    expect(parseBrainStep('{"actions":[]}')).toEqual([{ type: 'rest' }]);
  });

  it('plain text falls back to say + rest (bubbles split on ---); SILENT / NO_REPLY / empty rest; legacy TOOL_CALL is a tool', () => {
    expect(parseBrainStep('Sounds good, see you at 7!')).toEqual([{ type: 'say', text: 'Sounds good, see you at 7!' }, { type: 'rest' }]);
    expect(parseBrainStep('first\n---\nsecond')).toEqual([{ type: 'say', text: 'first' }, { type: 'say', text: 'second' }, { type: 'rest' }]);
    for (const quiet of ['', '   ', 'SILENT', '`NO_REPLY`', 'silent.']) expect(parseBrainStep(quiet)).toEqual([{ type: 'rest' }]);
    expect(parseBrainStep('TOOL_CALL: {"tool":"calendar.read","args":{"day":"today"}}')).toEqual([{ type: 'tool', name: 'calendar.read', args: { day: 'today' } }]);
    // Broken JSON never leaks raw braces (its "text" is salvaged); unknown action types are skipped; the list is capped.
    expect(parseBrainStep('{"actions": [ {"type": "say", "text": "oops \\"hi\\""')).toEqual([{ type: 'say', text: 'oops "hi"' }, { type: 'rest' }]);
    expect(parseBrainStep('{"actions": [ {"type": "tool"')).toEqual([{ type: 'rest' }]);
    expect(parseBrainStep(actions({ type: 'dance' }, say('ok')))).toEqual([{ type: 'say', text: 'ok' }]);
    expect(parseBrainStep(actions(...Array.from({ length: 20 }, (_, i) => say(`m${i}`))))).toHaveLength(8);
  });
});

// ---------- the brain itself ----------

describe('v26 ContinuousBrain: one mind, one awareness queue', () => {
  it('3 clarifying messages while thinking: the stale say is dropped and ONE unified reply goes out', async () => {
    const dir = await tempDir();
    const o = outlet();
    let arrived: BrainEvent[] = [];
    const STALE = 'Sure, want me to book dinner for tonight?';
    const UNIFIED = 'Got it: Thai for 4 tomorrow at 7, somewhere near the office. I will find a couple of spots.';
    const provider = new FakeProvider((req, n) => {
      if (n === 0) {
        // The owner keeps typing while the model is mid-thought.
        arrived = [owner('actually make it tomorrow', 2), owner('for 4 people, Thai, near the office', 3)];
        return actions(say(STALE), rest);
      }
      return actions(say(UNIFIED), rest);
    });
    const brain = new ContinuousBrain({ dir, provider, outlet: o.outlet, now: () => NOW });
    brain.push(owner('can you sort dinner', 1));
    const r = await brain.runUntilRest({ drain: async () => arrived.splice(0) });

    expect(o.said.map((s) => s.text)).toEqual([UNIFIED]);
    expect(r).toMatchObject({ steps: 2, interrupts: 1, dropped: [STALE], said: [UNIFIED], stopped: 'rest', proactive: false });
    const second = seenBy(provider.calls[1]!);
    for (const t of ['can you sort dinner', 'actually make it tomorrow', 'for 4 people, Thai, near the office']) expect(second).toContain(t);
    expect(second).toContain('but they sent more first, so it was not sent');
    // Chat history holds all three owner messages and only the reply that went out.
    const history = await loadChatHistory(dir);
    expect(history.map((h) => `${h.role}:${h.text}`)).toEqual(['user:can you sort dinner', 'user:actually make it tomorrow', 'user:for 4 people, Thai, near the office', `assistant:${UNIFIED}`]);
  });

  it('interrupts are capped (2 per wake): a model that never catches up still answers', async () => {
    const dir = await tempDir();
    const o = outlet();
    let n = 10;
    const provider = new FakeProvider(() => actions(say('ok!'), rest));
    const brain = new ContinuousBrain({ dir, provider, outlet: o.outlet, now: () => NOW });
    brain.push(owner('hi', 1));
    // The owner sends one more message every time the brain looks, for the first 3 looks before a say.
    let looks = 0;
    const r = await brain.runUntilRest({ drain: async () => (++looks <= 6 && looks % 2 === 0 ? [owner(`more ${n++}`, n)] : []) });
    expect(r.interrupts).toBe(2);
    expect(r.said.length).toBeGreaterThanOrEqual(1);
    expect(r.steps).toBeLessThanOrEqual(6);
  });

  it('Speak -> Work -> Speak: "checking now", a read-only web.search, then "found it" before resting', async () => {
    const dir = await tempDir();
    const o = outlet();
    const searches: unknown[] = [];
    const provider = new FakeProvider((req, n) => {
      if (n === 0) return actions(say('Checking now'), { type: 'tool', name: 'web.search', args: { query: 'lightest trail runner under $150' } });
      expect(seenBy(req)).toContain('TOOL web.search');
      expect(seenBy(req)).toContain('Model B: 310g, $120');
      return actions(say('Found it: Model A is the lighter one (280g, $140). Model B is $20 cheaper but heavier.'), rest);
    });
    const brain = new ContinuousBrain({ dir, provider, outlet: o.outlet, tools: new ToolRegistry({ tools: [webSearch(searches)] }), now: () => NOW });
    brain.push(owner('which trail runner is lightest under 150?', 1));
    const r = await brain.runUntilRest();
    expect(o.said.map((s) => s.text)).toEqual(['Checking now', 'Found it: Model A is the lighter one (280g, $140). Model B is $20 cheaper but heavier.']);
    expect(searches).toEqual([{ query: 'lightest trail runner under $150' }]);
    expect(r).toMatchObject({ steps: 2, toolsUsed: ['web.search'], stopped: 'rest' });
  });

  it('non-forced reply: "cool" gets a 👍 reaction and no text at all', async () => {
    const dir = await tempDir();
    const o = outlet();
    const provider = new FakeProvider(() => actions({ type: 'react', emoji: '👍' }, rest));
    const brain = new ContinuousBrain({ dir, provider, outlet: o.outlet, now: () => NOW });
    brain.push(owner('cool', 7));
    const r = await brain.runUntilRest();
    expect(o.reacted).toEqual([{ emoji: '👍', messageId: 'tg-7' }]);
    expect(o.said).toEqual([]);
    expect(r).toMatchObject({ steps: 1, reacted: ['👍'], said: [], stopped: 'rest' });
  });

  it('nothing in awareness: no model call at all', async () => {
    const provider = new FakeProvider(() => actions(say('hm'), rest));
    const r = await new ContinuousBrain({ dir: await tempDir(), provider, outlet: outlet().outlet }).runUntilRest();
    expect(r.stopped).toBe('empty');
    expect(provider.calls).toHaveLength(0);
  });
});

// ---------- ironclad safety ----------

describe('v26 ironclad safety', () => {
  it('external writes (beeper.send, shell.run) are NEVER executed by the brain: they are queued for a yes', async () => {
    const dir = await tempDir();
    const o = outlet();
    const sent: unknown[] = [];
    const ran: unknown[] = [];
    const queued: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const provider = new FakeProvider((_req, n) =>
      n === 0
        ? actions({ type: 'tool', name: 'beeper.send', args: { chatTitle: 'Sam', text: 'running late' } }, { type: 'tool', name: 'shell.run', args: { command: 'rm' } })
        : actions(say('Your note to Sam is ready, just say yes and it goes.'), rest),
    );
    const brain = new ContinuousBrain({
      dir,
      provider,
      outlet: o.outlet,
      tools: new ToolRegistry({ tools: [beeperSend(sent), sneakyShell(ran)] }),
      queue: async (tool, args) => void queued.push({ tool, args }),
      now: () => NOW,
    });
    brain.push(owner('tell Sam I am running late', 1));
    const r = await brain.runUntilRest();
    expect(sent).toEqual([]);
    expect(ran).toEqual([]);
    expect(queued.map((q) => q.tool)).toEqual(['beeper.send', 'shell.run']);
    expect(r).toMatchObject({ queued: ['beeper.send', 'shell.run'], toolsUsed: [] });
    expect(brain.drainQueued()).toBe(2);
    expect(brain.drainQueued()).toBe(0);
    expect(seenBy(provider.calls[1]!)).toContain('Queued for your approval: beeper.send. Nothing was sent');
  });

  it('taste.mjs blocks a bad draft: one rewrite goes out instead', async () => {
    const dir = await tempDir();
    await put(dir, 'taste.mjs', TASTE);
    const o = outlet();
    const provider = new FakeProvider((req, n) => {
      if (n === 0) return actions(say('Yes — 3pm works.'), rest);
      expect(seenBy(req)).toContain('LAYER 3 VERIFIER REJECTED YOUR DRAFT: no em-dashes');
      return actions(say('Yes, 3pm works.'));
    });
    const brain = new ContinuousBrain({ dir, provider, outlet: o.outlet, now: () => NOW });
    brain.push(owner('does 3 work?', 1));
    const r = await brain.runUntilRest();
    expect(o.said.map((s) => s.text)).toEqual(['Yes, 3pm works.']);
    expect(r.layer3).toMatchObject({ violations: ['no em-dashes'], retried: true });
    expect(r.steps).toBe(1); // the rewrite is not a step
  });

  it('a proactive message that still breaks taste.mjs after one rewrite is dropped', async () => {
    const dir = await tempDir();
    await put(dir, 'taste.mjs', TASTE);
    const o = outlet();
    const provider = new FakeProvider(() => actions(say('Heads up — rain later.'), rest));
    const brain = new ContinuousBrain({ dir, provider, outlet: o.outlet, now: () => NOW });
    brain.push(brainEvent('timer_wake', 'periodic wake', { at: NOW }));
    const r = await brain.runUntilRest();
    expect(o.said).toEqual([]);
    expect(provider.calls).toHaveLength(2);
    expect(r).toMatchObject({ proactive: true, layer3: { remaining: ['no em-dashes'] } });
  });

  it('the claim verifier: "I sent it" with no tool gets one rewrite, then an honest correction', async () => {
    const dir = await tempDir();
    const o = outlet();
    const provider = new FakeProvider(() => actions(say('Done, I sent it to Sam.'), rest));
    const brain = new ContinuousBrain({ dir, provider, outlet: o.outlet, now: () => NOW });
    brain.push(owner('tell sam hi', 1));
    const r = await brain.runUntilRest();
    expect(provider.calls).toHaveLength(2);
    expect(o.said).toHaveLength(1);
    expect(o.said[0]!.text).toMatch(/^Done, I sent it to Sam\.\n---\nCorrection: nothing has actually been sent yet/);
    expect(r.verifier).toEqual({ violations: ['claimed_send_without_tool'], corrected: true });
  });

  it('boundaries.mjs blocks proactive speech in a protected window before any model call', async () => {
    const dir = await tempDir();
    await put(dir, 'boundaries.mjs', BOUNDARIES);
    const o = outlet();
    const provider = new FakeProvider(() => actions(say('Quick thought!'), rest));
    const brain = new ContinuousBrain({ dir, provider, outlet: o.outlet, now: () => SATURDAY });
    brain.push(brainEvent('timer_wake', 'periodic wake', { at: SATURDAY }));
    const r = await brain.runUntilRest();
    expect(r).toMatchObject({ stopped: 'boundary', boundary: 'Saturday is protected (proactive.message)', said: [] });
    expect(provider.calls).toHaveLength(0);
    expect(o.said).toEqual([]);
    // The owner talking on a Saturday is not proactive: they get an answer.
    brain.push(owner('you there?', 1, SATURDAY));
    expect((await brain.runUntilRest()).said).toEqual(['Quick thought!']);
  });

  it('a proactive wake may not change the private workspace (memory.write is blocked); an owner request may', async () => {
    const dir = await tempDir();
    const o = outlet();
    const provider = new FakeProvider((_req, n) => (n % 2 === 0 ? actions({ type: 'tool', name: 'memory.write', args: { target: 'USER.md', fact: 'Likes Thai food' } }) : actions(rest)));
    const brain = new ContinuousBrain({ dir, provider, outlet: o.outlet, tools: new ToolRegistry({ tools: [memoryWriteTool()] }), now: () => NOW });
    brain.push(brainEvent('timer_wake', 'periodic wake', { at: NOW }));
    expect((await brain.runUntilRest()).blocked).toEqual(['memory.write']);
    await expect(readFile(path.join(dir, 'USER.md'), 'utf8')).rejects.toThrow();
    brain.push(owner('remember I like Thai food', 1));
    expect((await brain.runUntilRest()).toolsUsed).toEqual(['memory.write']);
    expect(await readFile(path.join(dir, 'USER.md'), 'utf8')).toContain('Likes Thai food');
  });

  it('maxStepsPerWake stops a model that never rests (default 6, never above 10)', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(() => actions({ type: 'continue', note: 'thinking more' }));
    const brain = new ContinuousBrain({ dir, provider, outlet: outlet().outlet, now: () => NOW });
    brain.push(owner('ponder this', 1));
    expect(await brain.runUntilRest()).toMatchObject({ steps: 6, stopped: 'budget' });
    const big = new ContinuousBrain({ dir, provider, outlet: outlet().outlet, maxStepsPerWake: 50, now: () => NOW });
    expect(big.maxStepsPerWake).toBe(MAX_STEPS_PER_WAKE);
    big.push(owner('ponder more', 2));
    expect(await big.runUntilRest()).toMatchObject({ steps: 10, stopped: 'budget' });
    big.push(owner('and again', 3));
    expect(await big.runUntilRest({ maxSteps: 3 })).toMatchObject({ steps: 3, stopped: 'budget' });
  });
});

// ---------- the daemon ----------

function chatChannel(clock: () => Date) {
  return new (class implements LiveChannel {
    sent: string[] = [];
    reactions: Array<{ id: string; emoji: string }> = [];
    inbox: IncomingMessage[] = [];
    async send(text: string) {
      this.sent.push(text);
    }
    async react(id: string, emoji: string) {
      this.reactions.push({ id, emoji });
    }
    async poll(since?: string) {
      return this.inbox.filter((m) => !since || !m.at || m.at >= since);
    }
    human(text: string) {
      const n = this.inbox.length + 1;
      this.inbox.push({ id: `in_${n}`, messageId: `tg-${n}`, text, at: new Date(clock().getTime() + n).toISOString() });
    }
  })();
}

describe('v26 UnifiedDaemon with brain: "continuous"', () => {
  async function setup(script: (req: AiRequest, n: number, chat: ReturnType<typeof chatChannel>) => string, extra: { tools?: ToolDefinition[] } = {}) {
    const dir = await tempDir();
    let t = NOW;
    const clock = () => t;
    const chat = chatChannel(clock);
    const brainCalls: AiRequest[] = [];
    const provider = new FakeProvider((req, n) => {
      if (req.meta?.flowId === 'brain') brainCalls.push(req);
      return script(req, n, chat);
    });
    const engine = new Engine({ store: dir, provider, flows: [] });
    const loop = new MasterLoop({ dir, tools: new ToolRegistry({ tools: extra.tools ?? [] }), now: clock });
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, heartbeat: false, calendarSync: false, bubblePauseMs: 0, brain: 'continuous', now: clock });
    await daemon.tick(); // listening from now on
    t = new Date(t.getTime() + 60_000);
    return { dir, chat, daemon, loop, provider, brainCalls, advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
  }

  it('end to end: messages typed while the brain thinks are folded in through channel.poll, ONE reply goes out', async () => {
    const s = await setup((_req, n, chat) => {
      if (n === 0) {
        chat.human('wait, tomorrow not tonight');
        chat.human('and for 4 people');
        return actions(say('On it, dinner for tonight!'), rest);
      }
      return actions(say('Dinner for 4 tomorrow, got it.'), rest);
    });
    s.chat.human('book us dinner');
    const r = await s.daemon.tick();
    expect(s.chat.sent).toEqual(['Dinner for 4 tomorrow, got it.']);
    expect(r.brain).toHaveLength(1);
    expect(r.brain![0]).toMatchObject({ steps: 2, interrupts: 1, dropped: ['On it, dinner for tonight!'] });
    for (const m of ['book us dinner', 'wait, tomorrow not tonight', 'and for 4 people']) expect(seenBy(s.brainCalls[1]!)).toContain(m);
    // Our own reply never comes back as a new event; a quiet tick costs nothing.
    await s.daemon.tick();
    expect(s.brainCalls).toHaveLength(2);
  });

  it('"cool" -> a real 👍 reaction on the message, no text', async () => {
    const s = await setup(() => actions({ type: 'react', emoji: '👍' }, rest));
    s.chat.human('cool');
    await s.daemon.tick();
    expect(s.chat.reactions).toEqual([{ id: 'tg-1', emoji: '👍' }]);
    expect(s.chat.sent).toEqual([]);
  });

  it('a beeper.send asked in chat becomes a Verify item; nothing is sent until the owner says yes', async () => {
    const sent: unknown[] = [];
    const s = await setup(
      (_req, n) => (n === 0 ? actions({ type: 'tool', name: 'beeper.send', args: { chatTitle: 'Sam', text: 'running late' } }) : actions(say('Ready to send Sam "running late", just say the word.'), rest)),
      { tools: [beeperSend(sent)] },
    );
    s.chat.human('tell Sam I am running late');
    const r = await s.daemon.tick();
    expect(sent).toEqual([]);
    expect(r.brain![0]!.queued).toEqual(['beeper.send']);
    const pending = await s.loop.pending();
    expect(pending.map((p) => p.actionType)).toEqual(['chief.beeper.send']);
    expect(s.chat.sent.join('\n')).toContain('Sam');
    expect(r.sentNow).toEqual([pending[0]!.id]); // the item itself goes out right away, ready for "1"
  });

  it('plain-code commands never reach the model: "pause autonomy" runs deterministically', async () => {
    const s = await setup(() => actions(say('should not be called'), rest));
    s.chat.human('pause autonomy');
    await s.daemon.tick();
    expect(s.brainCalls).toHaveLength(0);
    expect(s.chat.sent.join('\n')).toMatch(/pause/i);
  });

  it('periodic wakes go through the same mind; boundaries.mjs keeps it silent on a protected Saturday', async () => {
    const dir = await tempDir();
    await put(dir, 'boundaries.mjs', BOUNDARIES);
    let t = new Date(2026, 10, 28, 9, 0);
    const clock = () => t;
    const chat = chatChannel(clock);
    const brainCalls: AiRequest[] = [];
    const engine = new Engine({ store: dir, provider: new FakeProvider((req) => (brainCalls.push(req), actions(say('Morning!'), rest))), flows: [] });
    const loop = new MasterLoop({ dir, now: clock });
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, heartbeat: false, calendarSync: false, bubblePauseMs: 0, brain: 'continuous', think: { everyMs: 45 * 60_000, quietHours: false }, now: clock });
    await daemon.tick();
    t = new Date(t.getTime() + 50 * 60_000);
    const r = await daemon.tick();
    expect(r.thought).toBe('skipped: boundaries.mjs: Saturday is protected (proactive.message)');
    expect(brainCalls).toHaveLength(0);
    expect(chat.sent).toEqual([]);
  });

  it('on a normal day the periodic wake can speak once, marked proactive', async () => {
    const dir = await tempDir();
    let t = NOW;
    const clock = () => t;
    const chat = chatChannel(clock);
    const brainCalls: AiRequest[] = [];
    const engine = new Engine({ store: dir, provider: new FakeProvider((req) => (brainCalls.push(req), actions(say('Your 3pm got moved to 4, so you have a free hour.'), rest))), flows: [] });
    const loop = new MasterLoop({ dir, now: clock });
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, heartbeat: false, calendarSync: false, bubblePauseMs: 0, brain: 'continuous', think: { everyMs: 45 * 60_000, quietHours: false }, now: clock });
    await daemon.tick();
    t = new Date(t.getTime() + 50 * 60_000);
    const r = await daemon.tick();
    expect(r.thought).toBe('sent');
    expect(chat.sent).toEqual(['Your 3pm got moved to 4, so you have a free hour.']);
    expect(seenBy(brainCalls[0]!)).toContain('Periodic wake');
    expect((await loadChatHistory(dir)).at(-1)).toMatchObject({ role: 'assistant', proactive: true });
  });

  it('the default stays classic: without brain: "continuous" the Chief of Staff answers as before', async () => {
    const dir = await tempDir();
    let t = NOW;
    const clock = () => t;
    const chat = chatChannel(clock);
    const provider = new FakeProvider(() => 'Hey! All good here.');
    const loop = new MasterLoop({ dir, now: clock });
    const daemon = new UnifiedDaemon({ loop, engine: new Engine({ store: dir, provider, flows: [] }), channel: chat, heartbeat: false, calendarSync: false, bubblePauseMs: 0, now: clock });
    await daemon.tick();
    t = new Date(t.getTime() + 60_000);
    chat.human('hey');
    const r = await daemon.tick();
    expect(chat.sent).toEqual(['Hey! All good here.']);
    expect(r.brain).toBeUndefined();
    expect(provider.calls.every((c) => c.meta?.flowId !== 'brain')).toBe(true);
  });

  it('announceStartup sends a $0 orientation snapshot and respects the cooldown', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'projects'), { recursive: true });
    await writeFile(path.join(dir, 'projects', 'alpha.md'), '# Alpha\n', 'utf8');
    await writeFile(path.join(dir, 'projects', 'beta.md'), '# Beta\n', 'utf8');
    let t = NOW;
    const clock = () => t;
    const chat = chatChannel(clock);
    const provider = new FakeProvider(() => 'should not be called');
    const loop = new MasterLoop({ dir, now: clock });
    const daemon = new UnifiedDaemon({
      loop,
      engine: new Engine({ store: dir, provider, flows: [] }),
      channel: chat,
      heartbeat: false,
      calendarSync: false,
      bubblePauseMs: 0,
      brain: 'continuous',
      now: clock,
    });

    const first = await daemon.announceStartup();
    expect(first).toContain("I'm up (continuous brain");
    expect(first).toContain('Projects loaded (2): alpha, beta');
    expect(first).toContain('Waiting on you: 0 item(s)');
    expect(chat.sent).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);

    // Within 5m cooldown: silent
    t = new Date(t.getTime() + 2 * 60_000);
    expect(await daemon.announceStartup()).toBeUndefined();
    expect(chat.sent).toHaveLength(1);

    // Past 5m cooldown: announces again
    t = new Date(t.getTime() + 6 * 60_000);
    expect(await daemon.announceStartup()).toContain("I'm up (continuous brain");
    expect(chat.sent).toHaveLength(2);
  });

  it('deep Layer 3: full project index, radar.mjs ground truth, SELF.md, and Layer 3 replay eval', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'projects'), { recursive: true });
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
      await writeFile(path.join(dir, 'projects', `${name}.md`), `# Project: ${name}\nStatus: active.\n`, 'utf8');
    }
    const projSection = await relevantProjectsSection(dir, 'what are the 6 projects?');
    expect(projSection).toContain('All active projects (6): 1. alpha, 2. beta, 3. delta, 4. epsilon, 5. gamma, 6. zeta');

    // radar.mjs runs automatically in runLayer3Prepare
    await writeFile(path.join(dir, 'radar.mjs'), `export function collectRadar() { return 'Live Radar: 6 repos clean.'; }\n`, 'utf8');
    const prep = await runLayer3Prepare({ dir, query: 'status', now: NOW });
    expect(prep.context).toContain('Live Radar: 6 repos clean.');

    // SELF.md captures live architecture
    const selfText = await writeSelfMap(dir, { brain: 'continuous', tools: ['files.read', 'web.search'], sensors: ['inbox'] });
    expect(selfText).toContain('Continuous Living Brain');
    expect(selfText).toContain('radar.mjs');
    expect(await readSelfMap(dir)).toContain('Active tools (2)');

    // Layer 3 replay eval verifies badReply caught and idealReply passes
    await writeFile(
      path.join(dir, 'taste.mjs'),
      `export function verifyDraft(text) { const fails = []; if (/cut off|grab them tomorrow/i.test(text)) fails.push('no excuses'); return { ok: fails.length === 0, problems: fails }; }\n`,
      'utf8',
    );
    await mkdir(path.join(dir, 'evals'), { recursive: true });
    await writeFile(
      path.join(dir, 'evals', 'cases.json'),
      JSON.stringify([
        {
          id: 'no-excuses',
          input: 'what are the 6 projects?',
          badReply: 'Two got cut off in my read, I will grab them tomorrow.',
          idealReply: 'Here are all six:\n1. alpha\n2. beta',
        },
      ]),
      'utf8',
    );
    const evalReport = await runLayer3Eval({ dir, now: NOW });
    expect(evalReport.ok).toBe(true);
    expect(evalReport.badCaught).toBe(1);
    expect(evalReport.idealPassed).toBe(1);

    // Multi-line say preserves newlines (never flattens numbered lists)
    const sent: string[] = [];
    const multiBrain = new ContinuousBrain({
      dir,
      provider: new FakeProvider(() => actions(say('Your projects:\n1. alpha\n2. beta'), rest)),
      outlet: { say: async (t) => void sent.push(t) },
      now: () => NOW,
    });
    multiBrain.push(brainEvent('owner_message', 'list them', { at: NOW }));
    await multiBrain.runUntilRest();
    expect(sent).toEqual(['Your projects:\n1. alpha\n2. beta']);
  });
});
