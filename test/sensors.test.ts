import { describe, expect, it } from 'vitest';
import {
  BeeperApi,
  FakeProvider,
  MasterLoop,
  ToolRegistry,
  beeperSensor,
  beeperTools,
  buildSensors,
  classifyByCode,
  commandSensor,
  commandTool,
  emptyAnchor,
  messageTriageHandler,
  type CommandRunner,
  type LoopSignal,
  type Sensor,
  type SensorContext,
} from '../src';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 8, 0);
const sctx = (now: Date = NOW): SensorContext => ({ dir: '/tmp', anchor: emptyAnchor(now), now });
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();

/** A fake Beeper Desktop: chats and their messages, plus a log of every request. */
function fakeBeeper(chats: Array<Record<string, unknown>>, messages: Record<string, Array<Record<string, unknown>>>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: decodeURIComponent(u.pathname), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    let body: unknown = { pendingMessageID: 'pm_1' };
    if (method === 'GET' && u.pathname === '/v1/chats') body = { items: chats };
    const m = /^\/v1\/chats\/([^/]+)\/messages$/.exec(u.pathname);
    if (method === 'GET' && m) body = { items: messages[decodeURIComponent(m[1]!)] ?? [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe('beeperSensor', () => {
  it('first pass only sets the cursor; then new human messages become chat signals', async () => {
    const chats = [
      { id: 'c-sam', title: 'Sam Rivera', type: 'single', network: 'whatsapp', lastActivity: at(5) },
      { id: 'c-team', title: 'Launch team', type: 'group', lastActivity: at(6) },
      { id: 'c-bot', title: 'Rufus Bot', type: 'single', lastActivity: at(6) },
      { id: 'c-ignored', title: 'Newsletter', type: 'single', lastActivity: at(6) },
      { id: 'c-control', title: 'Rufus', type: 'single', lastActivity: at(6) },
      { id: 'c-muted', title: 'Muted', type: 'single', isMuted: true, lastActivity: at(6) },
      { id: 'c-quiet', title: 'Quiet', type: 'single', lastActivity: at(-60) },
    ];
    const messages = {
      'c-sam': [
        { id: 'old', text: 'from yesterday', timestamp: at(-600), senderName: 'Sam Rivera' },
        { id: 'm1', text: 'Can we move to 3?', timestamp: at(5), senderName: 'Sam Rivera' },
        { id: 'm2', text: 'Sure', timestamp: at(5), isSender: true },
        { id: 'm3', text: 'oops', timestamp: at(5), isDeleted: true },
        { id: 'm4', text: '', type: 'IMAGE', timestamp: at(5) },
      ],
      'c-team': [{ id: 't1', text: 'Deploy is done', timestamp: at(6), senderName: 'Alex' }],
      'c-bot': [{ id: 'b1', text: 'YOUR TURN', timestamp: at(6) }],
      'c-ignored': [{ id: 'n1', text: 'Sale!', timestamp: at(6) }],
      'c-control': [{ id: 'r1', text: '1', timestamp: at(6) }],
      'c-muted': [{ id: 'x1', text: 'hi', timestamp: at(6) }],
      'c-quiet': [{ id: 'q1', text: 'never read', timestamp: at(-60) }],
    };
    const b = fakeBeeper(chats, messages);
    const sensor = beeperSensor({ fetch: b.fetch, ignoreChatIds: ['c-ignored'], controlChatId: 'c-control' });

    const first = await sensor.poll(undefined, sctx());
    expect(first.signals).toEqual([]);
    expect(b.calls).toHaveLength(0); // no history read, ever, on Day 1
    expect(JSON.parse(first.nextCursor!)).toEqual({ since: NOW.toISOString(), seen: [] });

    const second = await sensor.poll(first.nextCursor, sctx());
    expect(second.signals).toEqual([
      {
        id: 'c-sam:m1',
        surface: 'chat',
        kind: 'message.received',
        text: 'Can we move to 3?',
        actor: 'Sam Rivera',
        timestamp: at(5),
        data: { chatId: 'c-sam', messageId: 'm1', chatTitle: 'Sam Rivera', network: 'whatsapp', isGroup: false },
      },
      expect.objectContaining({ id: 'c-team:t1', actor: 'Alex', data: expect.objectContaining({ isGroup: true }) }),
    ]);
    const read = b.calls.filter((c) => c.path.endsWith('/messages')).map((c) => c.path);
    expect(read).toEqual(['/v1/chats/c-sam/messages', '/v1/chats/c-team/messages']); // bot, ignored, control, muted and quiet chats never read

    const third = await sensor.poll(second.nextCursor, sctx());
    expect(third.signals).toEqual([]); // nothing twice
  });

  it('groups: false skips group chats; a custom bot pattern applies to senders too', async () => {
    const b = fakeBeeper(
      [
        { id: 'g', title: 'Family', type: 'group' },
        { id: 's', title: 'Pat', type: 'single' },
      ],
      { g: [{ id: '1', text: 'dinner?', timestamp: at(1) }], s: [{ id: '2', text: 'alert', timestamp: at(1), senderName: 'Alerts Daemon' }, { id: '3', text: 'call?', timestamp: at(2), senderName: 'Pat' }] },
    );
    const sensor = beeperSensor({ api: new BeeperApi({ fetch: b.fetch }), groups: false, botPattern: 'daemon' });
    const cursor = JSON.stringify({ since: NOW.toISOString(), seen: [] });
    expect((await sensor.poll(cursor, sctx())).signals.map((s) => s.text)).toEqual(['call?']);
  });
});

describe('commandSensor', () => {
  const events = (ids: string[]) => JSON.stringify({ events: ids.map((id) => ({ id, summary: `Event ${id}`, organizer: 'Dana', start: '2026-11-25T15:00:00Z' })) });

  it('remembers what is already there on the first pass, then emits only new items ($0, code only)', async () => {
    let out = events(['a', 'b']);
    const calls: string[][] = [];
    const run: CommandRunner = async (cmd, args) => (calls.push([cmd, ...args]), out);
    const sensor = commandSensor({ id: 'calendar', command: 'cal', args: ['--json'], kind: 'calendar.event', run });
    const first = await sensor.poll(undefined, sctx());
    expect(first.signals).toEqual([]);
    out = events(['a', 'b', 'c']);
    const second = await sensor.poll(first.nextCursor, sctx());
    expect(second.signals).toEqual([
      { id: 'c', surface: 'calendar', kind: 'calendar.event', text: 'Event c', actor: 'Dana', timestamp: '2026-11-25T15:00:00Z', data: { id: 'c', summary: 'Event c', organizer: 'Dana', start: '2026-11-25T15:00:00Z' } },
    ]);
    expect((await sensor.poll(second.nextCursor, sctx())).signals).toEqual([]);
    expect(calls[0]).toEqual(['cal', '--json']);
  });

  it('baseline: false emits everything on the first pass; itemsPath, fields and urgency are configurable', async () => {
    const run: CommandRunner = async () => JSON.stringify({ data: { threads: [{ threadId: 't1', snippet: 'Invoice overdue', from: 'billing@example.com' }] } });
    const sensor = commandSensor({ id: 'mail', surface: 'email', kind: 'email.received', command: 'mail', itemsPath: 'data.threads', idField: 'threadId', textField: 'snippet', baseline: false, urgency: 'urgent', run });
    const { signals } = await sensor.poll(undefined, sctx());
    expect(signals).toEqual([expect.objectContaining({ id: 't1', surface: 'email', kind: 'email.received', text: 'Invoice overdue', actor: 'billing@example.com', urgency: 'urgent' })]);
  });

  it('fails clearly on non-JSON output or a failing command (the loop retries next pass)', async () => {
    await expect(commandSensor({ id: 'x', command: 'c', run: async () => 'Usage: c [opts]' }).poll(undefined, sctx())).rejects.toThrow('sensor x: the command did not print JSON');
    await expect(
      commandSensor({ id: 'y', command: 'c', run: async () => {
        throw new Error('timed out after 30s: c');
      } }).poll(undefined, sctx()),
    ).rejects.toThrow('sensor y: timed out after 30s: c');
    expect(() => commandSensor({ id: '', command: 'c' })).toThrow('needs an id');
  });
});

describe('buildSensors (config.json)', () => {
  it('builds the Beeper sensor (skipping your Rufus chat) and command sensors', async () => {
    const b = fakeBeeper([{ id: 'ctl', title: 'Rufus' }, { id: 'p', title: 'Pat' }], { ctl: [{ id: '1', text: '1', timestamp: at(1) }], p: [{ id: '2', text: 'hello?', timestamp: at(1) }] });
    const sensors = buildSensors(
      { version: 1, beeper: { chatId: 'ctl', token: 't' }, sensors: { beeper: { groups: true }, commands: [{ id: 'calendar', command: 'cal' }] } },
      { env: {}, fetch: b.fetch, run: async () => '[]' },
    );
    expect(sensors.map((s) => s.id)).toEqual(['beeper', 'calendar']);
    const { signals } = await sensors[0]!.poll(JSON.stringify({ since: NOW.toISOString(), seen: [] }), sctx());
    expect(signals.map((s) => s.text)).toEqual(['hello?']);
  });

  it('refuses a Beeper sensor without Beeper configured, and builds nothing by default', () => {
    expect(() => buildSensors({ version: 1, sensors: { beeper: true } }, { env: {} })).toThrow('Beeper is not configured');
    expect(buildSensors({ version: 1 }, { env: {} })).toEqual([]);
  });
});

describe('messageTriageHandler', () => {
  const sensorOf = (signals: LoopSignal[]): Sensor => ({ id: 'beeper', surface: 'chat', poll: (c) => (c ? { signals: [] } : { signals, nextCursor: '1' }) });
  const msg = (id: string, text: string, over: Partial<LoopSignal> = {}): LoopSignal => ({ id, surface: 'chat', kind: 'message.received', text, actor: 'Sam Rivera', data: { chatId: 'c-sam' }, ...over });

  it('classifyByCode: acknowledgements are ignored, urgent words are urgent, the rest needs judgment', () => {
    expect(classifyByCode('ok thanks!')).toEqual({ label: 'ignore', reason: 'a short acknowledgement, nothing to answer' });
    expect(classifyByCode('👍')?.label).toBe('ignore');
    expect(classifyByCode('Sounds good.')?.label).toBe('ignore');
    expect(classifyByCode('URGENT: the server is down, call me')?.label).toBe('urgent');
    expect(classifyByCode('Can we move lunch to Thursday?')).toBeUndefined();
    expect(classifyByCode('ok so about the contract, can you check clause 4 tonight')).toBeUndefined();
  });

  it('without a model: acknowledgements complete silently at $0; real messages become your step, urgent ones flagged', async () => {
    const dir = await tempDir();
    const loop = new MasterLoop({ dir, sensors: [sensorOf([msg('1', 'ok thanks'), msg('2', 'Help, call me asap'), msg('3', 'Lunch Thursday?')])], handlers: [messageTriageHandler()], now: () => NOW });
    const r = await loop.runOnce();
    expect(r.cost).toBe(0);
    const runs = await Promise.all(r.runs.map((x) => loop.getRun(x.runId)));
    expect(runs.map((x) => [x.status, x.actionType, x.urgency])).toEqual([
      ['completed', 'triage.ignore', 'normal'],
      ['awaiting_human_execute', 'reply.chat', 'urgent'],
      ['awaiting_human_execute', 'reply.chat', 'normal'],
    ]);
    expect(runs[2]!.humanStep).toBe('Reply to Sam Rivera (chat): "Lunch Thursday?"');
  });

  it('with a model: triage + a concise draft; sent through beeper.send only after your yes', async () => {
    const dir = await tempDir();
    const b = fakeBeeper([], {});
    const provider = new FakeProvider(['{"label":"batch","reason":"a scheduling question"}', '{"reply":"Thursday works. 12:30?"}']);
    const loop = new MasterLoop({ dir, sensors: [sensorOf([msg('1', 'Lunch Thursday?')])], handlers: [messageTriageHandler()], tools: new ToolRegistry({ tools: beeperTools({ fetch: b.fetch }) }), providers: { fast: provider }, now: () => NOW });
    await loop.trust.promote('reply.chat'); // even autonomous: an external send always asks
    const r = await loop.runOnce();
    const run = await loop.getRun(r.runs[0]!.runId);
    expect(run).toMatchObject({ status: 'awaiting_human_verify', actionType: 'reply.chat', urgency: 'normal', result: { label: 'batch', reply: 'Thursday works. 12:30?', chatId: 'c-sam', to: 'Sam Rivera' } });
    expect(run.plan!.sensitivity).toEqual(['external']);
    expect(run.approvals).toEqual(['Always ask before anything external is sent.']);
    expect(provider.calls[1]!.messages[0]!.content).toContain('Lunch Thursday?');
    expect(b.calls).toHaveLength(0);

    const done = await loop.resolveHumanDecision(run.id, { verdict: 'accept' });
    expect(done.run.committed).toBe(true);
    expect(b.calls).toEqual([{ method: 'POST', path: '/v1/chats/c-sam/messages', body: { text: 'Thursday works. 12:30?' } }]);
  });

  it('your typed edit becomes the draft, and is what gets sent once you say send (v15: an edit never sends by itself)', async () => {
    const dir = await tempDir();
    const b = fakeBeeper([], {});
    const provider = new FakeProvider(['{"label":"urgent","reason":"x"}', '{"reply":"Yes."}']);
    const loop = new MasterLoop({ dir, sensors: [sensorOf([msg('1', 'Are you coming tonight?')])], handlers: [messageTriageHandler()], tools: new ToolRegistry({ tools: beeperTools({ fetch: b.fetch }) }), providers: { fast: provider }, now: () => NOW });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run.urgency).toBe('urgent');
    const held = await loop.resolveHumanDecision(run.id, { verdict: 'edit', editedOutput: 'Yes, around 8.' });
    expect(held).toMatchObject({ held: true, run: { status: 'awaiting_human_verify', result: { reply: 'Yes, around 8.', chatId: 'c-sam' } } });
    expect(b.calls).toEqual([]);
    await loop.resolveHumanDecision(run.id, { verdict: 'accept' });
    expect(b.calls.map((c) => c.body)).toEqual([{ text: 'Yes, around 8.' }]);
  });

  it('a draft with a placeholder fails the cross-check and is re-drafted', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(['{"label":"batch","reason":"x"}', '{"reply":"Hi [Name], sure."}', '{"label":"batch","reason":"x"}', '{"reply":"Sure, Thursday."}']);
    const loop = new MasterLoop({ dir, sensors: [sensorOf([msg('1', 'Thursday ok?')])], handlers: [messageTriageHandler()], providers: { fast: provider }, now: () => NOW });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run.trail.map((t) => t.outcome)).toEqual(['failed', 'passed']);
    expect(run.trail[0]!.reason).toBe('the draft has a placeholder like [Name]');
    expect(provider.calls[3]!.messages[0]!.content).toContain('Your last draft failed a check: the draft has a placeholder like [Name]');
    expect((run.result as { reply: string }).reply).toBe('Sure, Thursday.');
  });

  it('email replies are saved as drafts with gmail.draft, never sent; a missing tool says so', async () => {
    const dir = await tempDir();
    const drafted: unknown[] = [];
    const tools = new ToolRegistry({ tools: [commandTool('gmail.draft', { command: 'mail' }, async (_c, _a, o) => (drafted.push(JSON.parse(o.input!)), '{"ok":true}'))] });
    const email = msg('e1', 'Can you send the deck?', { surface: 'email', kind: 'email.received', actor: 'dana@example.com', data: { threadId: 'th1' } });
    const loop = new MasterLoop({ dir, sensors: [sensorOf([email])], handlers: [messageTriageHandler()], tools, providers: { fast: new FakeProvider(['{"label":"batch","reason":"x"}', '{"reply":"Attached, see deck v2."}']) }, now: () => NOW });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run.plan!.uses).toEqual(['gmail.draft']);
    expect((await loop.resolveHumanDecision(run.id, { verdict: 'accept' })).run.committed).toBe(true);
    expect(drafted).toEqual([{ threadId: 'th1', to: 'dana@example.com', text: 'Attached, see deck v2.' }]);

    const dir2 = await tempDir();
    const bare = new MasterLoop({ dir: dir2, sensors: [sensorOf([email])], handlers: [messageTriageHandler()], providers: { fast: new FakeProvider(['{"label":"batch","reason":"x"}', '{"reply":"Will do."}']) }, now: () => NOW });
    const run2 = await bare.getRun((await bare.runOnce()).runs[0]!.runId);
    const r2 = await bare.resolveHumanDecision(run2.id, { verdict: 'accept' });
    expect(r2.run.committed).toBe(false);
    expect(r2.run.commitError).toMatch(/no "gmail.draft" tool is configured/);
  });
});
