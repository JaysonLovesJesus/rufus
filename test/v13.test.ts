import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAT_HISTORY_FILE,
  ChiefOfStaff,
  CorpusStore,
  Engine,
  FakeProvider,
  MasterLoop,
  ToolRegistry,
  UnifiedDaemon,
  anchorUpdateTool,
  beeperSensor,
  blocksToNudge,
  concise,
  emptyAnchor,
  inQuietHours,
  isSmallTalk,
  loadAnchor,
  loadChatHistory,
  messageTriageHandler,
  parseToolCall,
  relevantHits,
  saveAnchor,
  startSignalWebhook,
  upsertScheduleBlock,
  type Anchor,
  type CorpusItem,
  type IncomingMessage,
  type LiveChannel,
  type Sensor,
  type ToolDefinition,
} from '../src';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 8, 0); // a Wednesday
const MIN = 60_000;

class Chat implements LiveChannel {
  sent: string[] = [];
  inbox: IncomingMessage[] = [];
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
    this.inbox.push({ id: `in_${this.n}`, text, at: new Date(this.clock().getTime() + this.n * 1000).toISOString() });
  }
}

function withBlocks(now: Date, blocks: Array<{ start: string; end: string; title: string; kind?: 'focus' | 'meeting' | 'break' | 'personal' }>): Anchor {
  let a = emptyAnchor(now);
  for (const b of blocks) a = upsertScheduleBlock(a, { ...b, kind: b.kind ?? 'focus' }).anchor;
  return a;
}

const fact = (id: string, title: string, summary: string): CorpusItem => ({ id, source: 'file', kind: 'note', title, summary, timestamp: NOW.toISOString() });

async function chiefSetup(script: ConstructorParameters<typeof FakeProvider>[0], opts: { tools?: ToolRegistry; loop?: boolean } = {}) {
  const dir = await tempDir();
  let t = NOW;
  const clock = () => t;
  const provider = new FakeProvider(script);
  const engine = new Engine({ store: dir, provider, flows: [] });
  const loop = opts.loop ? new MasterLoop({ dir, now: clock, ...(opts.tools ? { tools: opts.tools } : {}) }) : undefined;
  const chief = new ChiefOfStaff({ engine, now: clock, ...(opts.tools ? { tools: opts.tools } : {}), ...(loop ? { loop } : {}) });
  return { dir, provider, engine, chief, loop, advance: (ms: number) => void (t = new Date(t.getTime() + ms)) };
}

describe('time awareness', () => {
  it('the chat snapshot and system prompt carry the exact local date, weekday, time and the current + next block', async () => {
    const { dir, provider, chief } = await chiefSetup(() => 'You have Deep work until 09:00.');
    await saveAnchor(dir, withBlocks(NOW, [{ start: '07:30', end: '09:00', title: 'Deep work' }, { start: '12:00', end: '13:00', title: 'Gym', kind: 'personal' }]), NOW);
    await chief.handle('what am I doing right now?');
    const req = provider.calls[0]!;
    const snap = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(req.messages[0]!.content)![1]!);
    expect(snap.now).toMatchObject({ date: '2026-11-25', weekday: 'Wednesday', time: '08:00', currentBlock: { start: '07:30', title: 'Deep work' }, nextBlock: { start: '12:00', title: 'Gym' } });
    expect(req.system).toContain('## Right now\nWednesday 2026-11-25, 08:00 local time');
    expect(req.system).toContain('Now: 07:30-09:00 focus Deep work. Next: 12:00-13:00 personal Gym.');
  });

  it('a schedule from another day is never shown as today', async () => {
    const { dir, provider, chief } = await chiefSetup(() => 'ok');
    await saveAnchor(dir, withBlocks(new Date(2026, 10, 24, 8, 0), [{ start: '08:30', end: '09:00', title: 'Old standup' }]), new Date(2026, 10, 24, 8, 0));
    await chief.handle('what is next?');
    expect(provider.calls[0]!.system).toContain('Nothing scheduled right now. Nothing else scheduled today.');
  });
});

describe('corpus relevance cutoff', () => {
  const movie = fact('movie', 'Movie night picks', 'Watch the new space movie on Friday with popcorn.');
  const beta = fact('beta', 'Beta launch', 'The beta release needs the export fix first.');

  it('small talk never triggers a corpus lookup, and unrelated memories never reach a normal reply', async () => {
    const { dir, provider, chief } = await chiefSetup(() => 'Morning!');
    await new CorpusStore(path.join(dir, 'corpus', 'items.jsonl')).add([movie, beta]);
    await chief.handle('hi');
    await chief.handle('ok thanks');
    await chief.handle('can you check whether the beta export is fixed');
    expect(provider.calls[0]!.system).not.toContain('popcorn');
    expect(provider.calls[1]!.system).not.toContain('popcorn');
    expect(provider.calls[2]!.system).not.toContain('popcorn');
    expect(provider.calls[2]!.system).toContain('The beta release needs the export fix first.');
  });

  it('relevantHits drops weak and stray-word hits; isSmallTalk spots greetings', () => {
    expect(isSmallTalk('Hi Rufus!')).toBe(true);
    expect(isSmallTalk('good morning')).toBe(true);
    expect(isSmallTalk('move my gym block')).toBe(false);
    const hit = (score: number, matched: string[], similarity?: number) => ({ item: movie, score, matched, ...(similarity !== undefined ? { similarity } : {}) });
    expect(relevantHits([hit(0.2, ['movie'])], 'movie tonight?')).toEqual([]); // below the score floor
    expect(relevantHits([hit(2, ['night'])], 'late night call with the landlord about rent deposit')).toEqual([]); // one stray word of many
    expect(relevantHits([hit(2, ['movie'])], 'which movie tonight?')).toHaveLength(1);
    expect(relevantHits([hit(0.9, [], 0.8)], 'film for the weekend')).toHaveLength(1); // semantic match
    expect(relevantHits([hit(5, ['hi'])], 'hi')).toEqual([]);
  });
});

describe('short-term conversation memory', () => {
  it('remembers the last turns (with times) in chat-history.jsonl and shows them on the next message', async () => {
    const { dir, provider, chief, advance } = await chiefSetup((_req, n) => (n === 0 ? 'Booked lunch with Sam at 12.' : 'Moved it to 1pm.'));
    await chief.handle('book lunch with Sam at noon');
    advance(10_000);
    await chief.handle('actually make it 1pm');
    const second = provider.calls[1]!.messages[0]!.content;
    expect(second).toContain('Recent conversation (oldest first, local times):');
    expect(second).toContain('[08:00] Them: book lunch with Sam at noon');
    expect(second).toContain('[08:00] You (Rufus): Booked lunch with Sam at 12.');
    expect(second.indexOf('Recent conversation')).toBeLessThan(second.indexOf('Their message:\nactually make it 1pm'));
    const turns = await loadChatHistory(dir);
    expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual(['user:book lunch with Sam at noon', 'assistant:Booked lunch with Sam at 12.', 'user:actually make it 1pm', 'assistant:Moved it to 1pm.']);
  });

  it('keeps only the last 12 turns in the prompt', async () => {
    const { provider, chief } = await chiefSetup((_req, n) => `reply ${n}`);
    for (let i = 0; i < 9; i++) await chief.handle(`message number ${i}`);
    const last = provider.calls.at(-1)!.messages[0]!.content;
    expect(last).not.toContain('message number 1\n');
    expect((last.match(/\] (Them|You \(Rufus\)):/g) ?? []).length).toBe(12);
    expect(last).toContain('Them: message number 2');
  });

  it('historyTurns: 0 turns memory off', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(() => 'ok');
    const off = new ChiefOfStaff({ engine: new Engine({ store: dir, provider, flows: [] }), historyTurns: 0 });
    await off.handle('hello there');
    await off.handle('hello again');
    await expect(readFile(path.join(dir, CHAT_HISTORY_FILE), 'utf8')).rejects.toThrow();
    expect(provider.calls[1]!.messages[0]!.content).not.toContain('Recent conversation');
  });
});

describe('message coalescing', () => {
  it('two chat messages in one poll get ONE short reply that answers both', async () => {
    const dir = await tempDir();
    const clock = () => NOW;
    const provider = new FakeProvider(() => 'Got it: 4pm instead.');
    const engine = new Engine({ store: dir, provider, flows: [] });
    const chat = new Chat(clock);
    const daemon = new UnifiedDaemon({ loop: new MasterLoop({ dir, now: clock }), engine, channel: chat, heartbeat: false, now: clock });
    await daemon.tick(); // start listening
    chat.human('can you move my 3pm');
    chat.human('actually make it 4');
    const r = await daemon.tick();
    expect(chat.sent).toEqual(['Got it: 4pm instead.']);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.messages[0]!.content).toContain('Their message:\ncan you move my 3pm\nactually make it 4');
    expect(r.bridge?.merged).toBe(1);
  });

  it('commands are never merged into chat', async () => {
    const dir = await tempDir();
    const clock = () => NOW;
    const provider = new FakeProvider(() => 'Hello.');
    const engine = new Engine({ store: dir, provider, flows: [] });
    const chat = new Chat(clock);
    const daemon = new UnifiedDaemon({ loop: new MasterLoop({ dir, now: clock }), engine, channel: chat, heartbeat: false, now: clock });
    await daemon.tick();
    chat.human('hey');
    chat.human('flows');
    await daemon.tick();
    expect(chat.sent).toHaveLength(2);
    expect(provider.calls).toHaveLength(1);
  });

  it('concise() keeps whole sentences under the limit unless detail was asked for', () => {
    const long = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    expect(concise(long, 'what is up').length).toBeLessThanOrEqual(600);
    expect(concise(long, 'what is up')).toMatch(/here\.$/);
    expect(concise(long, 'explain in detail')).toBe(long);
  });
});

function calendarTool(log: string[]): ToolDefinition {
  return {
    name: 'calendar.read',
    description: 'Read calendar events.',
    readOnly: true,
    execute: () => {
      log.push('calendar.read');
      return { events: [{ title: 'Dentist', start: '15:00' }] };
    },
  };
}

function sendTool(log: string[]): ToolDefinition {
  return {
    name: 'beeper.send',
    description: 'Send a chat message.',
    readOnly: false,
    sensitivity: ['external'],
    execute: (args) => {
      log.push(`sent:${String(args.text)}`);
      return { ok: true };
    },
  };
}

describe('act first, reply second (tools in chat)', () => {
  it('without tools the old "cannot take actions" rule stays; with tools it is gone and the tools are listed', async () => {
    const plain = await chiefSetup(() => 'ok');
    await plain.chief.handle('hello there friend');
    expect(plain.provider.calls[0]!.system).toContain('You cannot take actions yourself');

    const armed = await chiefSetup(() => 'ok', { tools: new ToolRegistry({ tools: [calendarTool([])] }) });
    await armed.chief.handle('hello there friend');
    expect(armed.provider.calls[0]!.system).not.toContain('You cannot take actions yourself');
    expect(armed.provider.calls[0]!.system).toContain('calendar.read (read-only: runs now)');
    expect(armed.provider.calls[0]!.system).toContain('TOOL_CALL: {"tool":"<name>","args":{...}}');
  });

  it('runs a read-only tool BEFORE writing the final reply', async () => {
    const log: string[] = [];
    const { provider, chief } = await chiefSetup(
      (req, n) => {
        log.push(`model:${n}`);
        if (n === 0) return 'TOOL_CALL: {"tool":"calendar.read","args":{"day":"today"}}';
        expect(req.messages.at(-1)!.content).toContain('TOOL_RESULT calendar.read:');
        expect(req.messages.at(-1)!.content).toContain('Dentist');
        return 'Just the dentist at 3pm today.';
      },
      { tools: new ToolRegistry({ tools: [calendarTool(log)] }) },
    );
    const reply = await chief.handle("what's on my calendar today?");
    expect(reply).toMatchObject({ text: 'Just the dentist at 3pm today.', via: 'chat', toolsUsed: ['calendar.read'] });
    expect(log).toEqual(['model:0', 'calendar.read', 'model:1']);
    expect(provider.calls).toHaveLength(2);
    expect(reply.text).not.toContain('TOOL_CALL');
  });

  it('stops after 3 tool steps and never leaks a TOOL_CALL into the reply', async () => {
    const log: string[] = [];
    const { provider, chief } = await chiefSetup(() => 'TOOL_CALL: {"tool":"calendar.read","args":{}}', { tools: new ToolRegistry({ tools: [calendarTool(log)] }) });
    const reply = await chief.handle('check my calendar over and over');
    expect(log).toHaveLength(3);
    expect(provider.calls).toHaveLength(4);
    expect(reply.text).not.toContain('TOOL_CALL');
  });

  it('parseToolCall reads the marker, fenced JSON, or nothing', () => {
    expect(parseToolCall('TOOL_CALL: {"tool":"files.read","args":{"path":"a {b}.txt"}}')).toEqual({ tool: 'files.read', args: { path: 'a {b}.txt' } });
    expect(parseToolCall('```json\n{"tool":"beeper.read","args":{"chatId":"c1"}}\n```')).toEqual({ tool: 'beeper.read', args: { chatId: 'c1' } });
    expect(parseToolCall('Sure, {"a":1} is JSON but not a call.')).toBeUndefined();
    expect(parseToolCall('All clear today.')).toBeUndefined();
  });

  it('a side-effect tool is never run from chat: it becomes a Verify item delivered in the same tick, and runs on "1"', async () => {
    const dir = await tempDir();
    const clock = () => NOW;
    const log: string[] = [];
    const tools = new ToolRegistry({ tools: [sendTool(log)] });
    const provider = new FakeProvider((_req, n) => (n === 0 ? 'TOOL_CALL: {"tool":"beeper.send","args":{"chatId":"c-sam","to":"Sam","text":"Running 10 min late"}}' : 'Ready to tell Sam you are running 10 min late. Reply 1 to send.'));
    const engine = new Engine({ store: dir, provider, flows: [] });
    const chat = new Chat(clock);
    const loop = new MasterLoop({ dir, tools, now: clock });
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, heartbeat: false, now: clock });
    await daemon.tick();
    chat.human('tell Sam I am running 10 min late');
    await daemon.tick();
    expect(log).toEqual([]); // nothing sent yet
    expect(chat.sent[0]).toBe('Ready to tell Sam you are running 10 min late. Reply 1 to send.');
    expect(chat.sent[1]).toMatch(/^Heads up: ready to beeper\.send to Sam/);
    expect(chat.sent[1]).not.toContain('(urgent)');
    expect(chat.sent[1]).toContain('Running 10 min late');
    const pending = await loop.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: 'awaiting_human_verify', actionType: 'chief.beeper.send' });

    chat.human('1');
    await daemon.tick();
    expect(log).toEqual(['sent:Running 10 min late']);
    expect(chat.sent.at(-1)).toContain('#1 approved. Done.');
  });

  it('anchor.update edits the schedule right away when asked in chat, and the next message sees it', async () => {
    const dir = await tempDir();
    const clock = () => NOW;
    await saveAnchor(dir, withBlocks(NOW, [{ start: '09:00', end: '10:00', title: 'Study with Pat' }, { start: '12:00', end: '13:00', title: 'Gym', kind: 'personal' }]), NOW);
    const provider = new FakeProvider((_req, n) => (n === 0 ? 'TOOL_CALL: {"tool":"anchor.update","args":{"op":"remove_block","titleOrId":"study"}}' : n === 1 ? 'Done, the study block is gone.' : 'Next up is Gym at noon.'));
    const engine = new Engine({ store: dir, provider, flows: [] });
    const chat = new Chat(clock);
    const loop = new MasterLoop({ dir, now: clock });
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, heartbeat: false, now: clock });
    await daemon.tick();
    chat.human('remove Study with Pat');
    await daemon.tick();
    expect(chat.sent).toEqual(['Done, the study block is gone.']);
    expect((await loadAnchor(dir, NOW)).schedule.blocks.map((b) => b.title)).toEqual(['Gym']);
    expect(await loop.pending()).toEqual([]); // private and local: no Verify item

    chat.human("what's next?");
    await daemon.tick();
    expect(provider.calls[2]!.system).not.toContain('Study with Pat');
    expect(provider.calls[2]!.system).toContain('Next: 12:00-13:00 personal Gym.');
  });

  it('anchor.update: add, move, ambiguous and missing matches', async () => {
    const dir = await tempDir();
    await saveAnchor(dir, withBlocks(NOW, [{ start: '09:00', end: '10:00', title: 'Study A' }, { start: '10:00', end: '11:00', title: 'Study B' }]), NOW);
    const tool = anchorUpdateTool();
    const ctx = { dir, now: NOW, stage: 'commit' as const };
    expect((await tool.execute({ op: 'add_block', start: '14:00', end: '15:00', title: 'Call mom', kind: 'personal' }, ctx)).done).toBe('Added 14:00-15:00 personal Call mom.');
    expect((await tool.execute({ op: 'move_block', titleOrId: 'call mom', start: '16:00', end: '17:00' }, ctx)).done).toBe('Moved Call mom from 14:00-15:00 to 16:00-17:00.');
    await expect(tool.execute({ op: 'remove_block', titleOrId: 'study' }, ctx)).rejects.toThrow('matches more than one');
    await expect(tool.execute({ op: 'remove_block', titleOrId: 'yoga' }, ctx)).rejects.toThrow('No block today matches "yoga"');
    expect((await loadAnchor(dir, NOW)).schedule.blocks.map((b) => `${b.start} ${b.title}`)).toEqual(['09:00 Study A', '10:00 Study B', '16:00 Call mom']);
  });
});

describe('triage.ignore and Beeper self-loop', () => {
  it('an acknowledgement auto-completes at $0 and never waits for a human verify', async () => {
    const dir = await tempDir();
    const sensor: Sensor = { id: 's', surface: 'chat', poll: (c) => (c ? { signals: [] } : { signals: [{ id: '1', surface: 'chat', kind: 'message.received', text: 'ok thanks', actor: 'Sam' }], nextCursor: '1' }) };
    const loop = new MasterLoop({ dir, sensors: [sensor], handlers: [messageTriageHandler()], now: () => NOW });
    const r = await loop.runOnce();
    expect(r.cost).toBe(0);
    expect(r.runs[0]).toMatchObject({ status: 'completed', actionType: 'triage.ignore' });
    expect(await loop.pending()).toEqual([]);
  });

  it('a chat titled "Rufus" (any case) is never sensed, and ignoreChatTitles is configurable', async () => {
    const at = (m: number) => new Date(NOW.getTime() + m * MIN).toISOString();
    const chats = [
      { id: 'c-self', title: 'RUFUS', type: 'single', lastActivity: at(5) },
      { id: 'c-ops', title: 'Ops Desk', type: 'single', lastActivity: at(5) },
      { id: 'c-sam', title: 'Sam', type: 'single', lastActivity: at(5) },
    ];
    const msgs: Record<string, Array<Record<string, unknown>>> = {
      'c-self': [{ id: 'r1', text: 'Heads-up: Deep work starts at 09:00', timestamp: at(5), senderName: 'Rufus' }],
      'c-ops': [{ id: 'o1', text: 'ticket', timestamp: at(5), senderName: 'Ops' }],
      'c-sam': [{ id: 's1', text: 'hello', timestamp: at(5), senderName: 'Sam' }],
    };
    const fetchFake = (async (url: string | URL) => {
      const u = new URL(String(url));
      const m = /^\/v1\/chats\/([^/]+)\/messages$/.exec(u.pathname);
      return new Response(JSON.stringify({ items: u.pathname === '/v1/chats' ? chats : m ? (msgs[decodeURIComponent(m[1]!)] ?? []) : [] }), { status: 200 });
    }) as typeof fetch;
    const ctx = { dir: '/tmp', anchor: emptyAnchor(NOW), now: NOW };
    const sensor = beeperSensor({ fetch: fetchFake });
    const first = await sensor.poll(undefined, ctx);
    const second = await sensor.poll(first.nextCursor, ctx);
    expect(second.signals.map((s) => s.id).sort()).toEqual(['c-ops:o1', 'c-sam:s1']);

    const custom = beeperSensor({ fetch: fetchFake, ignoreChatTitles: ['rufus', 'ops desk'] });
    const c2 = await custom.poll((await custom.poll(undefined, ctx)).nextCursor, ctx);
    expect(c2.signals.map((s) => s.id)).toEqual(['c-sam:s1']);
  });
});

describe('proactive heartbeat', () => {
  it('sends one heads-up ~10 minutes before a real block, never for breaks, never twice, never in quiet hours', async () => {
    const dir = await tempDir();
    let t = new Date(2026, 10, 25, 8, 49);
    const clock = () => t;
    await saveAnchor(dir, withBlocks(t, [{ start: '09:00', end: '10:00', title: 'Deep work' }, { start: '08:55', end: '09:00', title: 'Coffee', kind: 'break' }]), t);
    const chat = new Chat(clock);
    const daemon = new UnifiedDaemon({ loop: new MasterLoop({ dir, now: clock }), engine: new Engine({ store: dir, flows: [] }), channel: chat, now: clock });
    await daemon.tick();
    expect(chat.sent).toEqual([]); // 11 minutes out: not yet
    t = new Date(2026, 10, 25, 8, 50);
    const r = await daemon.tick();
    expect(chat.sent).toEqual(['Deep work is in 10 min (9am)']);
    expect(r.proactive).toHaveLength(1);
    t = new Date(2026, 10, 25, 8, 55);
    await daemon.tick();
    expect(chat.sent).toHaveLength(1);

    const a = withBlocks(new Date(2026, 10, 25, 22, 50), [{ start: '23:00', end: '23:30', title: 'Late call', kind: 'meeting' }]);
    expect(blocksToNudge(a, new Date(2026, 10, 25, 22, 50), [])).toHaveLength(1);
    expect(inQuietHours(new Date(2026, 10, 25, 22, 50))).toBe(true);
    expect(inQuietHours(new Date(2026, 10, 25, 6, 59))).toBe(true);
    expect(inQuietHours(new Date(2026, 10, 25, 7, 0))).toBe(false);
    expect(inQuietHours(new Date(2026, 10, 25, 23, 0), false)).toBe(false);
  });

  it('the first phone.unlocked of the morning gets a short good-morning brief (once a day)', async () => {
    const dir = await tempDir();
    let t = new Date(2026, 10, 25, 7, 15);
    const clock = () => t;
    await saveAnchor(dir, withBlocks(t, [{ start: '09:00', end: '10:00', title: 'Deep work' }, { start: '12:00', end: '13:00', title: 'Gym', kind: 'personal' }]), t);
    const hook = await startSignalWebhook({ dir, token: 'a-very-long-test-token', port: 0, now: clock });
    try {
      const chat = new Chat(clock);
      const loop = new MasterLoop({ dir, now: clock });
      const { inboxSensor } = await import('../src');
      loop.addSensor(inboxSensor(dir));
      const daemon = new UnifiedDaemon({ loop, engine: new Engine({ store: dir, flows: [] }), channel: chat, now: clock });
      await daemon.tick();
      const post = () => fetch(`${hook.url}/signal`, { method: 'POST', headers: { authorization: 'Bearer a-very-long-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'phone.unlocked' }) });
      expect((await post()).status).toBe(202);
      await daemon.tick();
      expect(chat.sent).toHaveLength(1);
      const brief = chat.sent[0]!;
      expect(brief.split('\n')).toHaveLength(3);
      expect(brief).toContain("Good morning. It's Wednesday, 07:15.");
      expect(brief).toContain('Today: 09:00 Deep work, 12:00 Gym.');
      expect(brief).toContain('Nothing is waiting on you.');
      expect(await loop.pending()).toEqual([]); // the unlock itself is never a Verify item

      t = new Date(2026, 10, 25, 7, 40);
      await post();
      await daemon.tick();
      expect(chat.sent).toHaveLength(1); // once a day
    } finally {
      await hook.close();
    }
  });
});

describe('POST /signal webhook', () => {
  it('needs the Bearer token, validates the body, and appends to inbox.jsonl', async () => {
    const dir = await tempDir();
    await expect(startSignalWebhook({ dir, token: 'short', port: 0 })).rejects.toThrow('at least 16 characters');
    const hook = await startSignalWebhook({ dir, token: 'secret-token-0123456789', port: 0, now: () => NOW });
    try {
      const post = (body: unknown, token?: string, p = '/signal', method = 'POST') =>
        fetch(`${hook.url}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
      expect((await post({ kind: 'phone.unlocked' })).status).toBe(401);
      expect((await post({ kind: 'phone.unlocked' }, 'secret-token-0123456780')).status).toBe(401);
      expect((await post({ kind: 'phone.unlocked' }, 'secret-token-0123456789', '/nope')).status).toBe(404);
      expect((await post(undefined, 'secret-token-0123456789', '/signal', 'GET')).status).toBe(405);
      expect((await post('{not json', 'secret-token-0123456789')).status).toBe(400);
      expect((await post({ kind: 'bad kind!' }, 'secret-token-0123456789')).status).toBe(400);
      expect((await post({ kind: 'x', data: [1] }, 'secret-token-0123456789')).status).toBe(400);
      expect((await post('x'.repeat(20_000), 'secret-token-0123456789')).status).toBe(413);

      const ok = await post({ kind: 'app.opened', text: 'Maps', data: { pkg: 'maps' } }, 'secret-token-0123456789');
      expect(ok.status).toBe(202);
      const { id } = (await ok.json()) as { id: string };
      const lines = (await readFile(path.join(dir, 'inbox.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toEqual([{ id, surface: 'phone', kind: 'app.opened', text: 'Maps', timestamp: NOW.toISOString(), data: { pkg: 'maps' } }]);
    } finally {
      await hook.close();
    }
  });
});
