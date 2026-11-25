import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChiefOfStaff,
  CorpusStore,
  EmbeddingCache,
  Engine,
  FakeProvider,
  LocalEmbeddingProvider,
  MasterLoop,
  ToolRegistry,
  UnifiedDaemon,
  appendSignal,
  emptyAnchor,
  gatherBoard,
  inboxSensor,
  isBareVerdict,
  loadChatHistory,
  messageTriageHandler,
  noteItem,
  parseLoopReply,
  parseProtectWindows,
  parseThought,
  protectedNow,
  rememberNote,
  saveAnchor,
  thinkInterval,
  withEditedDraft,
  type AiRequest,
  type IncomingMessage,
  type LiveChannel,
  type ToolDefinition,
} from '../src';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 14, 0); // a Wednesday, 2pm local
const MIN = 60_000;

/** The exact voice note that once got sent to a contact as an "edit" of a pending reply. */
const VOICE_NOTE =
  "The calls you see through beeper you don't need to worry about. Those are just call alerts from WhatsApp, so you can ignore them, and keep your messages to me a bit less dense.";

class Chat implements LiveChannel {
  sent: string[] = [];
  inbox: IncomingMessage[] = [];
  typing = async (): Promise<void> => {
    this.typed++;
  };
  typed = 0;
  private n = 0;
  constructor(private readonly clock: () => Date) {}
  async send(text: string) {
    this.sent.push(text);
  }
  async poll(since?: string) {
    return this.inbox.filter((m) => !since || !m.at || m.at >= since);
  }
  human(text: string) {
    this.n++;
    this.inbox.push({ id: `in_${this.n}`, text, at: new Date(this.clock().getTime() + this.n).toISOString() });
  }
  humanReact(emoji = '👍') {
    this.n++;
    this.inbox.push({ id: `in_${this.n}`, text: `[reacted ${emoji}]`, at: new Date(this.clock().getTime() + this.n).toISOString(), reaction: { emoji, targetMessageId: 'm1' } });
  }
  last(): string {
    return this.sent.at(-1) ?? '';
  }
}

/** A fake `beeper.send`: external, records every call. It must never run without an explicit send. */
function fakeSend(calls: Array<Record<string, unknown>>): ToolDefinition {
  return { name: 'beeper.send', description: 'Send a chat message.', sensitivity: ['external'], async execute(args) {
    calls.push(args);
    return { ok: true };
  } };
}

interface SetupOpts {
  /** What the Chief of Staff (and the think-beat) answers. */
  chief?: (req: AiRequest, n: number) => string;
  think?: (req: AiRequest) => string;
  thinkEveryMs?: number;
  start?: Date;
}

async function setup(opts: SetupOpts = {}) {
  const dir = await tempDir();
  let t = opts.start ?? NOW;
  const clock = () => t;
  const sends: Array<Record<string, unknown>> = [];
  const chat = new Chat(clock);
  const chiefCalls: AiRequest[] = [];
  const thinkCalls: AiRequest[] = [];
  const engine = new Engine({
    store: dir,
    provider: new FakeProvider((req, n) => {
      if (req.meta?.flowId === 'think') {
        thinkCalls.push(req);
        return opts.think ? opts.think(req) : 'SILENT';
      }
      chiefCalls.push(req);
      return opts.chief ? opts.chief(req, n) : 'Got it.';
    }),
  });
  // The loop's own model: triage label, then the drafted reply.
  const loopAi = new FakeProvider((req) => (/Triage this/.test(String(req.messages[0]!.content)) ? '{"label":"batch","reason":"a question"}' : '{"reply":"Yes, see you at 7."}'));
  const loop = new MasterLoop({ dir, sensors: [inboxSensor(dir)], handlers: [messageTriageHandler()], tools: new ToolRegistry({ tools: [fakeSend(sends)] }), providers: { fast: loopAi }, now: clock });
  const daemon = new UnifiedDaemon({
    loop,
    engine,
    channel: chat,
    chief: new ChiefOfStaff({ engine, loop, now: clock }),
    checkinEveryMs: 2 * 60 * MIN,
    bubblePauseMs: 0,
    ...(opts.thinkEveryMs ? { think: { everyMs: opts.thinkEveryMs } } : {}),
    now: clock,
  });
  let k = 0;
  const incoming = (text: string, actor = 'Robin', urgency: 'urgent' | 'normal' = 'urgent') =>
    appendSignal(dir, { surface: 'chat', kind: 'message.received', text, actor, urgency, data: { chatId: `c-${actor.toLowerCase()}` } }, new Date(t.getTime() + ++k * 1000));
  return { dir, chat, engine, loop, loopAi, daemon, sends, chiefCalls, thinkCalls, incoming, clock, advance: (ms: number) => void (t = new Date(t.getTime() + ms)) };
}

// ---------- 1. Ironclad external-send safety ----------

describe('v15 send safety: parseLoopReply only reads explicit commands', () => {
  it.each([
    VOICE_NOTE,
    'Yes I think so, but tell him I am running late',
    'No worries, I will handle Robin myself',
    'send him my love',
    '1 more thing: can you check my calendar?',
    'Sounds good to me',
    'edit the draft to be warmer', // no "edit:" keyword
    'Y not just call her?',
  ])('conversation is never a decision, even with one item open: %j', (text) => {
    expect(parseLoopReply(text, 1)).toBeUndefined();
  });

  it('a long reason is not a reason: "2 <voice note>" stays chat', () => {
    expect(parseLoopReply(`2 ${VOICE_NOTE}`, 1)).toBeUndefined();
    expect(parseLoopReply('2 not now', 1)).toEqual({ kind: 'decision', verdict: 'reject', note: 'not now' });
  });

  it('isBareVerdict spots a bare command (to ask which item), but not "#n" or chat', () => {
    expect(isBareVerdict('send')).toBe(true);
    expect(isBareVerdict('edit: hi')).toBe(true);
    expect(isBareVerdict('#1 send')).toBe(false);
    expect(isBareVerdict(VOICE_NOTE)).toBe(false);
  });
});

describe('v15 send safety: the daemon', () => {
  it('EXACT INCIDENT: one pending beeper.send item + a conversational voice note -> chief chat, beeper.send never called', async () => {
    const s = await setup({ chief: () => "Got it, I'll ignore those call alerts." });
    await s.incoming('are we still on for tonight?');
    await s.daemon.tick();
    expect(s.chat.last()).toContain('Robin texted "are we still on for tonight?"');
    expect(await s.loop.pending()).toHaveLength(1);
    expect(parseLoopReply(VOICE_NOTE, 1)).toBeUndefined();

    s.chat.human(VOICE_NOTE);
    const r = await s.daemon.tick();
    expect(r.decided).toEqual([]);
    expect(s.sends).toEqual([]); // NEVER sent to Robin
    expect(s.chiefCalls.some((c) => String(c.messages[0]!.content).includes('The calls you see through beeper'))).toBe(true);
    expect(s.chat.last()).toBe("Got it, I'll ignore those call alerts.");
    const [still] = await s.loop.pending();
    expect(still).toMatchObject({ status: 'awaiting_human_verify', result: { reply: 'Yes, see you at 7.' } });
  });

  it('"#1 <free text>" is not an edit either: it explains the exact commands and sends nothing', async () => {
    const s = await setup();
    await s.incoming('lunch?');
    await s.daemon.tick();
    s.chat.human('#1 tell her I can do Friday');
    const r = await s.daemon.tick();
    expect(r.decided).toEqual([]);
    expect(s.sends).toEqual([]);
    expect(s.chat.last()).toBe('For #1, reply "#1 send", "#1 skip", or "#1 edit: <your version>".');
  });

  it('several items open: a bare "send" asks which one and sends nothing', async () => {
    const s = await setup();
    await s.incoming('lunch?', 'Robin');
    await s.incoming('dinner?', 'Alex');
    await s.daemon.tick();
    s.chat.human('send');
    await s.daemon.tick();
    expect(s.sends).toEqual([]);
    expect(s.chat.last()).toBe('2 items are waiting. Start with the number, like "#1 1" or "#1 2".');
  });

  it('edit: on an external item updates the draft and asks for #1 send; only an explicit send sends it', async () => {
    const s = await setup();
    await s.incoming('are we still on for tonight?');
    await s.daemon.tick();

    s.chat.human('edit: Running 10 min late, see you at 7:10!');
    const r = await s.daemon.tick();
    expect(s.sends).toEqual([]);
    expect(r.decided).toMatchObject([{ n: 1, verdict: 'edit', status: 'awaiting_human_verify' }]);
    expect(s.chat.last()).toBe('Updated draft for Robin: "Running 10 min late, see you at 7:10!" — reply #1 send to send it, or #1 skip to drop it.');
    const [run] = await s.loop.pending();
    expect(run).toMatchObject({ status: 'awaiting_human_verify', result: { reply: 'Running 10 min late, see you at 7:10!', chatId: 'c-robin' }, edits: [{ text: 'Running 10 min late, see you at 7:10!' }] });
    expect(run!.committed).toBeUndefined();
    // The edit is recorded as an example right away.
    const corpus = await new CorpusStore(path.join(s.dir, 'corpus', 'items.jsonl')).load();
    expect(corpus.some((i) => i.source === 'feedback' && i.kind === 'verify.edit' && /Running 10 min late/.test(i.summary))).toBe(true);

    // More chat in between still sends nothing.
    s.chat.human('hmm actually let me think about it');
    await s.daemon.tick();
    expect(s.sends).toEqual([]);

    s.chat.human('#1 send');
    const sent = await s.daemon.tick();
    expect(sent.decided).toMatchObject([{ n: 1, verdict: 'accept', status: 'accepted' }]);
    expect(s.sends).toEqual([{ chatId: 'c-robin', text: 'Running 10 min late, see you at 7:10!' }]);
    expect(s.chat.last()).toBe('#1 approved. Done.');
    expect((await s.loop.trust.get('reply.chat')).edited).toBe(1); // the human's version went out: trust records an edit
  });

  it('a bare "1" after the held edit sends it too; "#1 skip" would have dropped it', async () => {
    const s = await setup();
    await s.incoming('call later?');
    await s.daemon.tick();
    s.chat.human('edit: Sure, after 6');
    await s.daemon.tick();
    s.chat.human('1');
    await s.daemon.tick();
    expect(s.sends).toEqual([{ chatId: 'c-robin', text: 'Sure, after 6' }]);

    const t = await setup();
    await t.incoming('call later?');
    await t.daemon.tick();
    t.chat.human('edit: Sure, after 6');
    await t.daemon.tick();
    t.chat.human('#1 skip');
    expect((await t.daemon.tick()).decided).toMatchObject([{ verdict: 'reject', status: 'rejected' }]);
    expect(t.sends).toEqual([]);
  });

  it('MasterLoop: an edit of a money/login/external plan is held; a non-sensitive one commits as before', async () => {
    const dir = await tempDir();
    const paid: unknown[] = [];
    const committed: unknown[] = [];
    const loop = new MasterLoop({
      dir,
      sensors: [{ id: 'x', surface: 'x', poll: () => ({ signals: [{ id: 'p', surface: 'x', kind: 'pay' }, { id: 'n', surface: 'x', kind: 'note' }] }) }],
      handlers: [
        { id: 'pay', match: { kind: 'pay' }, plan: () => ({ goal: 'Pay the invoice', actionType: 'pay.invoice', route: 'code', sensitivity: ['money'] }), execute: () => ({ amount: 10 }), commit: (o) => void paid.push(o) },
        { id: 'note', match: { kind: 'note' }, plan: () => ({ goal: 'Save a note', actionType: 'note.save', route: 'code' }), execute: () => 'draft note', commit: (o) => void committed.push(o) },
      ],
      now: () => NOW,
    });
    const r = await loop.runOnce();
    const [pay, note] = r.runs;
    const held = await loop.resolveHumanDecision(pay!.runId, { verdict: 'edit', editedOutput: { amount: 12 } });
    expect(held.held).toBe(true);
    expect(paid).toEqual([]);
    expect((await loop.getRun(pay!.runId)).result).toEqual({ amount: 12 });
    await loop.resolveHumanDecision(pay!.runId, { verdict: 'accept' });
    expect(paid).toEqual([{ amount: 12 }]);

    const plain = await loop.resolveHumanDecision(note!.runId, { verdict: 'edit', editedOutput: 'my note' });
    expect(plain.held).toBeUndefined();
    expect(committed).toEqual(['my note']);
  });

  it('withEditedDraft keeps the recipient and rewrites every draft field of a chat action', () => {
    expect(withEditedDraft({ label: 'batch', reply: 'old', chatId: 'c1', to: 'Robin' }, 'new')).toEqual({ label: 'batch', reply: 'new', chatId: 'c1', to: 'Robin' });
    expect(withEditedDraft({ tool: 'beeper.send', args: { to: 'Robin', text: 'old' }, summary: 'x', text: 'old' }, 'new')).toEqual({ tool: 'beeper.send', args: { to: 'Robin', text: 'new' }, summary: 'beeper.send to Robin: "new"', text: 'new' });
    expect(withEditedDraft('old', 'new')).toBe('new');
    expect(withEditedDraft({ a: 1 }, 'new')).toEqual({ a: 1, reply: 'new' });
  });
});

describe('v15 send safety: stale items expire', () => {
  it('a delivered item older than 60 min expires cleanly and a later "1" cannot trigger it', async () => {
    const s = await setup({ chief: () => 'Nothing is waiting on you right now.' });
    await s.incoming('are we still on for tonight?');
    await s.daemon.tick();
    expect(await s.loop.pending()).toHaveLength(1);

    s.advance(61 * MIN);
    s.chat.human('1');
    const r = await s.daemon.tick();
    expect(r.expired).toHaveLength(1);
    expect(r.decided).toEqual([]);
    expect(s.sends).toEqual([]);
    expect(await s.loop.pending()).toEqual([]);
    const run = await s.loop.getRun(r.expired![0]!);
    expect(run).toMatchObject({ status: 'expired', expiredReason: expect.stringContaining('60 min') });
    expect(run.committed).toBeUndefined();
    await expect(s.loop.resolveHumanDecision(run.id, { verdict: 'accept' })).rejects.toThrow(/not waiting for a decision \(it is expired\)/);
    expect(s.sends).toEqual([]);
  });

  it('within 60 min it still works; the clock starts when the item reaches you, not when it was sensed', async () => {
    const s = await setup();
    await s.incoming('lunch tomorrow?', 'Robin', 'normal'); // batched for the 2h check-in: not on your screen yet
    await s.daemon.tick();
    s.advance(2 * 60 * MIN + 1);
    const due = await s.daemon.tick();
    expect(due.checkin).toHaveLength(1);
    expect(due.expired).toBeUndefined(); // sensed 2h ago, but it only just reached you
    s.advance(59 * MIN);
    s.chat.human('send');
    const r = await s.daemon.tick();
    expect(r.decided).toMatchObject([{ verdict: 'accept', status: 'accepted' }]);
    expect(s.sends).toHaveLength(1);
  });

  it('MasterLoop.expireStale expires only Verify items past their TTL', async () => {
    const dir = await tempDir();
    let t = NOW;
    const loop = new MasterLoop({
      dir,
      sensors: [{ id: 'x', surface: 'x', poll: () => ({ signals: [{ id: 'v', surface: 'x', kind: 'v' }, { id: 'h', surface: 'x', kind: 'h' }] }) }],
      handlers: [
        { id: 'v', match: { kind: 'v' }, plan: () => ({ goal: 'Reply', actionType: 'reply.x', route: 'code', sensitivity: ['external'] }), execute: () => 'hi' },
        { id: 'h', match: { kind: 'h' }, plan: () => ({ goal: 'Record it', actionType: 'video.record', route: 'human' }), execute: () => undefined },
      ],
      now: () => t,
    });
    await loop.runOnce();
    t = new Date(NOW.getTime() + 30 * MIN);
    expect(await loop.expireStale()).toEqual([]);
    t = new Date(NOW.getTime() + 61 * MIN);
    const gone = await loop.expireStale();
    expect(gone.map((r) => r.status)).toEqual(['expired']);
    expect((await loop.pending()).map((r) => r.status)).toEqual(['awaiting_human_execute']);
  });
});

// ---------- 2. Proactive Jarvis think-beat ----------

describe('v15 think-beat', () => {
  it('SILENT sends nothing; the first pass only starts the clock', async () => {
    const s = await setup({ thinkEveryMs: 45 * MIN, think: () => 'SILENT' });
    expect((await s.daemon.tick()).thought).toBe('started');
    expect(s.thinkCalls).toHaveLength(0);
    s.advance(20 * MIN);
    expect((await s.daemon.tick()).thought).toBe('skipped: not due');
    s.advance(26 * MIN);
    const r = await s.daemon.tick();
    expect(r.thought).toBe('silent');
    expect(s.thinkCalls).toHaveLength(1);
    expect(s.chat.sent).toEqual([]);
  });

  it('a useful thought is sent naturally (typing first) and recorded in chat history; the prompt carries the live board', async () => {
    const s = await setup({ thinkEveryMs: 45 * MIN, think: () => "You've got the whole afternoon open — want to block 3-5 for the launch post?" });
    await saveAnchor(s.dir, { ...emptyAnchor(NOW), goals: [{ id: 'launch', title: 'Ship the launch post', priority: 'high', horizon: 'week', active: true }], schedule: { date: '2026-11-25', blocks: [{ id: 'gym', start: '07:00', end: '08:00', title: 'Gym', kind: 'personal', status: 'done' }] } }, NOW);
    await s.daemon.tick();
    s.advance(45 * MIN);
    const r = await s.daemon.tick();
    expect(r.thought).toBe('sent');
    expect(s.chat.sent).toEqual(["You've got the whole afternoon open — want to block 3-5 for the launch post?"]);
    expect(s.chat.typed).toBeGreaterThan(0);
    const prompt = String(s.thinkCalls[0]!.messages[0]!.content);
    expect(prompt).toContain('Now: Wednesday 2026-11-25, 14:45');
    expect(prompt).toContain('[high/week] Ship the launch post');
    expect(prompt).toContain('07:00-08:00 personal Gym (done)');
    expect(prompt).toContain('You are waking up on your own periodic beat.');
    expect(prompt).toContain('reply with exactly `SILENT`');
    const history = await loadChatHistory(s.dir, 5);
    expect(history.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringContaining('whole afternoon open') });
  });

  it('two ignored nudges back off (the interval doubles); any reply or reaction resets it', async () => {
    let n = 0;
    const s = await setup({ thinkEveryMs: 45 * MIN, think: () => `Thought ${++n}` });
    await s.daemon.tick();
    s.advance(45 * MIN);
    await s.daemon.tick(); // nudge 1
    s.advance(45 * MIN);
    await s.daemon.tick(); // nudge 2, both unanswered
    expect(s.chat.sent).toEqual(['Thought 1', 'Thought 2']);
    s.advance(45 * MIN);
    expect((await s.daemon.tick()).thought).toBe('skipped: not due'); // backed off: now 90 min
    s.advance(45 * MIN);
    expect((await s.daemon.tick()).thought).toBe('sent'); // nudge 3 after 90 min
    s.advance(90 * MIN);
    expect((await s.daemon.tick()).thought).toBe('skipped: not due'); // 3 unanswered: 180 min
    expect(thinkInterval(45 * MIN, 0)).toBe(45 * MIN);
    expect(thinkInterval(45 * MIN, 2)).toBe(90 * MIN);
    expect(thinkInterval(45 * MIN, 3)).toBe(180 * MIN);
    expect(thinkInterval(45 * MIN, 20)).toBe(16 * 45 * MIN);

    s.chat.humanReact('👍'); // the human reacted: back-off resets
    await s.daemon.tick();
    s.advance(45 * MIN);
    expect((await s.daemon.tick()).thought).toBe('sent');
    expect(s.chat.sent.filter((m) => m.startsWith('Thought'))).toHaveLength(4);
  });

  it('never mid-conversation, in quiet hours, or in a protected window (Sabbath, a protected block)', async () => {
    const s = await setup({ thinkEveryMs: 45 * MIN, think: () => 'Hey!' });
    await s.daemon.tick();
    s.advance(44 * MIN);
    s.chat.human('what is on today?');
    await s.daemon.tick();
    s.advance(2 * MIN);
    expect((await s.daemon.tick()).thought).toBe('skipped: in conversation');

    const late = await setup({ thinkEveryMs: 45 * MIN, think: () => 'Hey!', start: new Date(2026, 10, 25, 22, 30) });
    await late.daemon.tick();
    late.advance(50 * MIN);
    expect((await late.daemon.tick()).thought).toBe('skipped: quiet hours');
    expect(late.thinkCalls).toHaveLength(0);

    const sat = new Date(2026, 10, 28, 10, 0); // Saturday morning
    const sabbath = await setup({ thinkEveryMs: 45 * MIN, think: () => 'Hey!', start: sat });
    await saveAnchor(sabbath.dir, { ...emptyAnchor(sat), boundaries: [{ id: 'sabbath', rule: 'Keep the Sabbath quiet', kind: 'protect_time', when: 'fri 18:00 - sat 18:00' }] }, sat);
    await sabbath.daemon.tick();
    sabbath.advance(60 * MIN);
    expect((await sabbath.daemon.tick()).thought).toBe('skipped: protected: Keep the Sabbath quiet');
    sabbath.advance(8 * 60 * MIN); // 19:00 Saturday: the window has closed
    expect((await sabbath.daemon.tick()).thought).toBe('sent');
    expect(sabbath.thinkCalls).toHaveLength(1);
    expect(sabbath.chat.sent).toEqual(['Hey!']);
  });

  it('parseThought: SILENT / empty / NO_REPLY are silence; one or two bubbles otherwise', () => {
    for (const raw of ['SILENT', ' silent. ', '`SILENT`', '', 'NO_REPLY', 'TOOL_CALL: {"tool":"x"}']) expect(parseThought(raw)).toBeUndefined();
    expect(parseThought('Want me to block 3-5 for the deck?')).toEqual(['Want me to block 3-5 for the deck?']);
    expect(parseThought('Quick one.\n---\nThe report is due Friday.\n---\nAnd a third')).toHaveLength(2);
  });

  it('protect_time windows: spans, single days, daily ranges, and windows written in the rule text', () => {
    expect(parseProtectWindows('fri 18:00 - sat 18:00')).toEqual([[5 * 1440 + 18 * 60, 6 * 1440 + 18 * 60]]);
    expect(parseProtectWindows('sunday')).toEqual([[0, 1440]]);
    expect(parseProtectWindows('22:00-07:00')).toHaveLength(7);
    expect(parseProtectWindows('the monthly review')).toEqual([]);
    const anchor = { ...emptyAnchor(NOW), boundaries: [{ id: 's', rule: 'Sabbath rest, Friday 18:00 - Saturday 18:00', kind: 'protect_time' as const }] };
    expect(protectedNow(anchor, new Date(2026, 10, 27, 19, 0))).toEqual({ rule: 'Sabbath rest, Friday 18:00 - Saturday 18:00' });
    expect(protectedNow(anchor, new Date(2026, 10, 27, 17, 59))).toBeUndefined();
    const block = { ...emptyAnchor(NOW), schedule: { date: '2026-11-25', blocks: [{ id: 'f', start: '13:00', end: '15:00', title: 'Family time', kind: 'protected' as const, status: 'planned' as const }] } };
    expect(protectedNow(block, NOW)).toEqual({ rule: 'Family time' });
  });

  it('gatherBoard glances at fast read-only tools and skips slow or failing ones', async () => {
    const dir = await tempDir();
    const tools = new ToolRegistry({
      tools: [
        { name: 'calendar.read', description: 'x', readOnly: true, execute: () => [{ title: 'Call with the printer', start: '16:00' }] },
        { name: 'slow.read', description: 'x', readOnly: true, execute: () => new Promise((r) => setTimeout(() => r('late'), 200)) },
        { name: 'broken.read', description: 'x', readOnly: true, execute: () => { throw new Error('down'); } },
        { name: 'beeper.send', description: 'x', sensitivity: ['external'], execute: () => 'never' },
      ],
    });
    const loop = new MasterLoop({ dir, tools, now: () => NOW });
    const board = await gatherBoard({ dir, loop, now: NOW, tools, glance: ['calendar.read', 'slow.read', 'broken.read', 'beeper.send'], toolTimeoutMs: 20 });
    expect(board).toContain('calendar.read: [{"title":"Call with the printer","start":"16:00"}]');
    expect(board).not.toContain('slow.read');
    expect(board).not.toContain('broken.read');
    expect(board).not.toContain('beeper.send');
  });
});

// ---------- 3. Conversational self-learning ----------

describe('v15 conversational learning', () => {
  it('chat feedback is saved to corpus/items.jsonl and shapes the very next triage', async () => {
    const s = await setup({
      chief: (req) =>
        String(req.messages.at(-1)!.content).startsWith('TOOL_RESULT')
          ? "Got it, I'll ignore WhatsApp call alerts from now on."
          : 'TOOL_CALL: {"tool":"remember","args":{"text":"Ignore WhatsApp call alerts; they need no reply","kind":"feedback","verdict":"reject","about":"WhatsApp"}}',
    });
    await s.daemon.tick();
    s.chat.human(VOICE_NOTE);
    await s.daemon.tick();
    expect(s.chat.last()).toBe("Got it, I'll ignore WhatsApp call alerts from now on.");

    const items = await new CorpusStore(path.join(s.dir, 'corpus', 'items.jsonl')).load();
    const note = items.find((i) => i.tags?.includes('human_note'));
    expect(note).toMatchObject({ source: 'feedback', kind: 'feedback', actor: 'WhatsApp', metadata: { verdict: 'reject', note: 'Ignore WhatsApp call alerts; they need no reply' } });
    expect(note!.tags).toEqual(expect.arrayContaining(['reply.chat', 'reply.email', 'reject']));

    // The next message is triaged with that note in the prompt.
    await s.incoming('Missed WhatsApp call from Alex', 'Alex');
    await s.daemon.tick();
    const triage = s.loopAi.calls.map((c) => String(c.messages[0]!.content)).find((c) => c.includes('Missed WhatsApp call from Alex'));
    expect(triage).toContain('Ignore WhatsApp call alerts; they need no reply');
    expect(triage).toContain('If the human previously rejected a similar message');

    // ... and the chief sees it next time it is relevant.
    s.chat.human('any WhatsApp call alerts today?');
    await s.daemon.tick();
    expect(s.chiefCalls.at(-1)!.system).toContain('Ignore WhatsApp call alerts');
  });

  it('"remember: ..." is a $0 command; the note is a preference and carries "note"', async () => {
    const s = await setup();
    await s.daemon.tick();
    s.chat.human('remember: keep messages to me less dense');
    await s.daemon.tick();
    expect(s.chat.last()).toBe('Got it, I\'ll keep that in mind: "keep messages to me less dense".');
    expect(s.chiefCalls).toHaveLength(0);
    const items = await new CorpusStore(path.join(s.dir, 'corpus', 'items.jsonl')).load();
    expect(items).toEqual([expect.objectContaining({ source: 'feedback', kind: 'preference', metadata: expect.objectContaining({ verdict: 'note' }) })]);
  });

  it('the think-beat respects saved notes (they are on its board)', async () => {
    const s = await setup({ thinkEveryMs: 45 * MIN });
    await rememberNote(s.dir, { text: "I'm meeting the pastor on Friday at 10am" }, { now: NOW });
    await s.daemon.tick();
    s.advance(45 * MIN);
    await s.daemon.tick();
    expect(String(s.thinkCalls[0]!.messages[0]!.content)).toContain("I'm meeting the pastor on Friday at 10am");
  });

  it('notes are embedded into the cache when embeddings exist (local provider), and kept once per text', async () => {
    const dir = await tempDir();
    const cache = new EmbeddingCache(path.join(dir, 'corpus', 'embeddings.jsonl'));
    const local = new LocalEmbeddingProvider();
    await cache.sync([{ id: 'seed', text: 'something already embedded' }], local);
    const r = await rememberNote(dir, { text: 'Ignore call alerts', verdict: 'reject' }, { now: NOW });
    expect(r.embedded).toBe(true);
    expect((await cache.load(local.id)).has(r.item.id)).toBe(true);
    await rememberNote(dir, { text: 'Ignore call alerts', verdict: 'reject' }, { now: new Date(NOW.getTime() + MIN) });
    expect((await new CorpusStore(path.join(dir, 'corpus', 'items.jsonl')).load()).filter((i) => i.source === 'feedback')).toHaveLength(1);

    const plain = await tempDir();
    expect((await rememberNote(plain, { text: 'Prefer mornings' }, { now: NOW })).embedded).toBe(false); // no cache: nothing to embed into
    await expect(readFile(path.join(plain, 'corpus', 'embeddings.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('noteItem guesses kind and verdict from plain words', () => {
    expect(noteItem({ text: 'ignore WhatsApp call alerts' }, NOW).metadata).toMatchObject({ kind: 'feedback', verdict: 'reject' });
    expect(noteItem({ text: 'keep messages less dense' }, NOW).metadata).toMatchObject({ kind: 'preference', verdict: 'note' });
    expect(noteItem({ text: "I'm meeting the pastor soon" }, NOW).metadata).toMatchObject({ kind: 'fact', verdict: 'note' });
  });
});
