import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChiefOfStaff,
  Engine,
  FakeProvider,
  MasterLoop,
  UnifiedDaemon,
  appendSignal,
  assignNumbers,
  defineFlow,
  formatCheckin,
  formatLoopItem,
  freshStartState,
  inboxSensor,
  parseLoopReply,
  requestCheckin,
  type IncomingMessage,
  type LiveChannel,
  type LoopRun,
  type SignalHandler,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 8, 0);
const HOUR = 3_600_000;

/** In-memory chat with NO button support: a card sent with buttons would throw. */
class PlainChat implements LiveChannel {
  sent: string[] = [];
  inbox: IncomingMessage[] = [];
  buttons = 0;
  private n = 0;
  constructor(private readonly clock: () => Date) {}
  async send(text: string) {
    this.sent.push(text);
  }
  async sendCard(): Promise<void> {
    this.buttons++;
    throw new Error('this chat app cannot show buttons');
  }
  async poll(since?: string) {
    return this.inbox.filter((m) => !since || !m.at || m.at >= since);
  }
  human(text: string) {
    this.n++;
    this.inbox.push({ id: `in_${this.n}`, text, at: new Date(this.clock().getTime() + this.n * 1000).toISOString() });
  }
  last(): string {
    return this.sent.at(-1) ?? '';
  }
}

interface Draft {
  reply: string;
}

/** All code: drafts "Re: <text>", commits to `log`. Urgency comes from the signal. */
function draftHandler(log: string[]): SignalHandler<Draft> {
  return {
    id: 'draft',
    match: { surface: 'chat' },
    plan: (s) => ({ goal: `Answer ${s.actor ?? 'them'}`, actionType: 'reply.chat', route: 'code' }),
    execute: (_p, s) => ({ reply: `Re: ${s.text}` }),
    commit: (out) => void log.push(typeof out === 'string' ? out : (out as Draft).reply),
  };
}

const approve = defineFlow<{ who: string }, { decision: string }>({ id: 'approve', name: 'Approve', description: 'one question' }, async (ctx) => {
  const a = await ctx.human('ok', { title: `Approve ${ctx.input.who}?`, summary: 'Go?', options: ['Yes', 'No'] });
  return { decision: a.choice! };
});

async function setup(opts: { chief?: string; checkinEveryMs?: number; channel?: boolean } = {}) {
  const dir = await tempDir();
  let t = NOW;
  const clock = () => t;
  const log: string[] = [];
  const chat = new PlainChat(clock);
  const engine = new Engine({ store: dir, provider: new FakeProvider(() => opts.chief ?? 'Chief here.'), flows: [approve] });
  const loop = new MasterLoop({ dir, sensors: [inboxSensor(dir)], handlers: [draftHandler(log)], now: clock });
  const printed: string[] = [];
  const daemon = new UnifiedDaemon({
    loop,
    engine,
    ...(opts.channel === false ? {} : { channel: chat }),
    output: (x) => void printed.push(x),
    chief: new ChiefOfStaff({ engine, loop }),
    checkinEveryMs: opts.checkinEveryMs ?? 2 * HOUR,
    now: clock,
  });
  let k = 0;
  const signal = (text: string, urgency: 'urgent' | 'normal' = 'normal', actor = 'Sam') => appendSignal(dir, { surface: 'chat', kind: 'message.received', text, actor, urgency }, new Date(t.getTime() + ++k * 1000));
  return { dir, chat, engine, loop, daemon, log, printed, signal, advance: (ms: number) => void (t = new Date(t.getTime() + ms)) };
}

describe('parseLoopReply: dead-simple plain-text answers', () => {
  it.each([
    ['1', { kind: 'decision', verdict: 'accept' }],
    ['y', { kind: 'decision', verdict: 'accept' }],
    ['Yes!', { kind: 'decision', verdict: 'accept' }],
    ['ok', { kind: 'decision', verdict: 'accept' }],
    ['👍', { kind: 'decision', verdict: 'accept' }],
    ['1 but keep it short', { kind: 'decision', verdict: 'accept', note: 'but keep it short' }],
    ['2', { kind: 'decision', verdict: 'reject' }],
    ['n', { kind: 'decision', verdict: 'reject' }],
    ['no', { kind: 'decision', verdict: 'reject' }],
    ['2 too formal', { kind: 'decision', verdict: 'reject', note: 'too formal' }],
    ['no: not this week', { kind: 'decision', verdict: 'reject', note: 'not this week' }],
    ['edit: Thursday works, 12:30?', { kind: 'decision', verdict: 'edit', edit: 'Thursday works, 12:30?' }],
    ['Edit Sure thing', { kind: 'decision', verdict: 'edit', edit: 'Sure thing' }],
    ['#2 1', { kind: 'decision', verdict: 'accept', ref: 2 }],
    ['#3 2 wrong person', { kind: 'decision', verdict: 'reject', note: 'wrong person', ref: 3 }],
    ['#1 edit: See you at 8', { kind: 'decision', verdict: 'edit', edit: 'See you at 8', ref: 1 }],
    ['#4 See you at 8', { kind: 'decision', verdict: 'edit', edit: 'See you at 8', ref: 4 }],
    ['checkin', { kind: 'checkin' }],
    ['Check-in', { kind: 'checkin' }],
    ['now', { kind: 'checkin' }],
  ])('%s', (text, expected) => {
    expect(parseLoopReply(text)).toEqual(expected);
  });

  it.each(['', '   ', 'what is on today?', 'No problem at all', 'editing is hard', 'okay so here is the thing', '#2'])('not a loop reply: %j', (text) => {
    expect(parseLoopReply(text)).toBeUndefined();
  });
});

describe('formatLoopItem: short plain text, no buttons', () => {
  const run = (over: Partial<LoopRun>): LoopRun => ({
    id: 'loop_1',
    sensorId: 'beeper',
    handlerId: 'message.triage',
    signal: { id: 's', surface: 'chat', kind: 'message.received', text: 'Can we move to 3?', actor: 'Sam' },
    status: 'awaiting_human_verify',
    actionType: 'reply.chat',
    goal: 'Draft a concise reply',
    result: { label: 'batch', reply: 'Sure, 3 works.' },
    replans: 0,
    trail: [],
    aiCalls: 1,
    spectrum: { code: 1, fast: 1, smart: 0, human: 1 },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  });

  it('verify: the incoming message, the draft, and the reply line', () => {
    expect(formatLoopItem(run({}), 1)).toBe('Sam texted "Can we move to 3?" — want me to reply "Sure, 3 works."? (1 to send, 2 to skip, or type your own version)');
    expect(formatLoopItem(run({ urgency: 'urgent' }), 2, { multi: true })).toBe('#2 Heads up: Sam texted "Can we move to 3?" — want me to reply "Sure, 3 works."? (#2 1 to send, #2 2 to skip, or #2 + your own version)');
  });

  it('plan and human-step items, and a promotion hint', () => {
    expect(formatLoopItem(run({ status: 'awaiting_human_plan', goal: 'Book the venue', question: 'Which date?' }), 3)).toBe('Sam texted "Can we move to 3?". Want me to book the venue? Which date? (1 to go ahead, 2 to drop it, or type a better plan)');
    expect(formatLoopItem(run({ status: 'awaiting_human_execute', humanStep: 'Record the intro video', signal: { id: 's', surface: 'anchor', kind: 'x' } }), 1)).toBe("Your turn: Record the intro video. (1 when it's done, 2 to skip)");
    expect(formatLoopItem(run({ promotionHint: 'Stop checking?' }), 1)).toMatch(/\nStop checking\?$/);
  });

  it('a check-in lists every item with its number', () => {
    expect(formatCheckin([])).toBe('All clear: nothing is waiting on you.');
    const text = formatCheckin([
      { run: run({}), n: 1 },
      { run: run({ id: 'loop_2', signal: { id: 't', surface: 'chat', kind: 'm', text: 'Lunch?', actor: 'Alex' } }), n: 2 },
    ]);
    expect(text).toContain('2 things waiting on you. Start each answer with its number, like "#1 1".');
    expect(text).toContain('#2 Alex texted "Lunch?"');
    expect(text).toContain('(#2 1 to send, #2 2 to skip');
  });

  it('assignNumbers keeps numbers stable and reuses the smallest free one', () => {
    const s = freshStartState();
    expect(assignNumbers(s, [{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual({ a: 1, b: 2, c: 3 });
    expect(assignNumbers(s, [{ id: 'a' }, { id: 'c' }, { id: 'd' }])).toEqual({ a: 1, c: 3, d: 2 });
  });
});

describe('rufus start: the unified daemon', () => {
  it('urgent items go out right away; normal ones wait for the check-in window, together', async () => {
    const s = await setup();
    await s.signal('Lunch Thursday?');
    await s.signal('The server is down', 'urgent', 'Ops');
    await s.signal('Any notes on the deck?', 'normal', 'Alex');
    const first = await s.daemon.tick();
    expect(first.loop!.signals).toBe(3);
    expect(first.sentNow).toHaveLength(1);
    expect(first.batched).toHaveLength(2);
    expect(s.chat.sent).toEqual(['Heads up: Ops texted "The server is down" — want me to reply "Re: The server is down"? (1 to send, 2 to skip, or type your own version)']);

    s.advance(HOUR);
    const quiet = await s.daemon.tick();
    expect(quiet.batched).toHaveLength(2);
    expect(quiet.loop!.cost).toBe(0);
    expect(s.chat.sent).toHaveLength(1); // no spam in between

    s.advance(HOUR + 1);
    const due = await s.daemon.tick();
    expect(due.checkin).toHaveLength(2);
    expect(s.chat.sent).toHaveLength(2);
    expect(s.chat.last()).toMatch(/^2 things waiting on you\./);
    expect(s.chat.last()).toContain('#1 Sam texted "Lunch Thursday?"');
    expect(s.chat.last()).toContain('#3 Alex texted "Any notes on the deck?"');
    expect(s.chat.buttons).toBe(0);
  });

  it('"1" accepts the one open item: trust, commit and an example, all from a plain-text reply', async () => {
    const s = await setup();
    await s.signal('Are you free at 3?', 'urgent');
    await s.daemon.tick();
    s.chat.human('1');
    const r = await s.daemon.tick();
    expect(r.decided).toEqual([{ runId: expect.stringMatching(/^loop_/), n: 1, verdict: 'accept', status: 'accepted' }]);
    expect(s.log).toEqual(['Re: Are you free at 3?']);
    expect(s.chat.last()).toBe('#1 approved. Done.');
    expect((await s.loop.trust.get('reply.chat')).accepted).toBe(1);
    expect(await s.loop.pending()).toEqual([]);
  });

  it('several open: a bare "1" asks for the number; "#2 2 <reason>" rejects; "#1 edit: ..." applies your version', async () => {
    const s = await setup();
    await s.signal('First?', 'urgent');
    await s.signal('Second?', 'urgent');
    await s.daemon.tick();
    expect(s.chat.sent[1]).toContain('(#2 1 to send'); // the second one already knows it is not alone
    s.chat.human('1');
    await s.daemon.tick();
    expect(s.chat.last()).toBe('2 items are waiting. Start with the number, like "#1 1" or "#1 2".');
    s.chat.human('#2 2 too blunt');
    s.chat.human('#1 edit: Yes, see you then.');
    const r = await s.daemon.tick();
    expect(r.decided.map((d) => `${d.n}:${d.verdict}:${d.status}`)).toEqual(['2:reject:rejected', '1:edit:edited']);
    expect(s.log).toEqual(['Yes, see you then.']);
    expect((await s.loop.trust.get('reply.chat')).rejected).toBe(1);
    expect(s.chat.sent.slice(-2)).toEqual(['#2 rejected.', '#1 saved with your edit. Done.']);
  });

  it('plain typed text right after a lone item is your edit; a question goes to the chief instead', async () => {
    const s = await setup({ chief: 'You have one reply waiting.' });
    await s.signal('Dinner tonight?', 'urgent');
    await s.daemon.tick();
    s.chat.human('what does it say?');
    await s.daemon.tick();
    expect(s.chat.last()).toBe('You have one reply waiting.');
    expect(await s.loop.pending()).toHaveLength(1);
    s.chat.human("Can't tonight, tomorrow works");
    const r = await s.daemon.tick();
    expect(r.decided[0]).toMatchObject({ n: 1, verdict: 'edit', status: 'edited' });
    expect(s.log).toEqual(["Can't tonight, tomorrow works"]);
  });

  it('"checkin" in chat sends the one-screen summary and everything waiting, at once', async () => {
    const s = await setup();
    await s.signal('Lunch?');
    await s.signal('Deck notes?');
    await s.daemon.tick();
    expect(s.chat.sent).toEqual([]);
    s.chat.human('checkin');
    const r = await s.daemon.tick();
    expect(r.checkin).toHaveLength(2);
    expect(s.chat.last()).toMatch(/^Now: 2026-11-25 08:00/);
    expect(s.chat.last()).toContain('Waiting on you (2):');
    expect(s.chat.last()).toContain('2 things waiting on you.');
    s.chat.human('#2 1');
    expect((await s.daemon.tick()).decided).toMatchObject([{ n: 2, verdict: 'accept' }]);
    expect(s.log).toEqual(['Re: Deck notes?']);
  });

  it('`rufus now` (a check-in request) makes the running daemon deliver the batch on its next pass', async () => {
    const s = await setup();
    await s.signal('Lunch?');
    await s.daemon.tick();
    expect(s.chat.sent).toEqual([]);
    await requestCheckin(s.dir);
    const r = await s.daemon.tick();
    expect(r.checkin).toHaveLength(1);
    expect(s.chat.last()).toBe('Sam texted "Lunch?" — want me to reply "Re: Lunch?"? (1 to send, 2 to skip, or type your own version)');
    await expect(access(path.join(s.dir, 'checkin.request'))).rejects.toThrow(); // consumed
  });

  it('never answers itself from an echo of its own message', async () => {
    const s = await setup();
    await s.signal('Hi?', 'urgent');
    await s.daemon.tick();
    s.chat.human(s.chat.sent[0]!); // the chat app echoes our own text back
    const r = await s.daemon.tick();
    expect(r.decided).toEqual([]);
    expect(await s.loop.pending()).toHaveLength(1);
  });

  it('flow cards ride along as plain text; with a card open, bare answers go to the card and "#n" to loop items', async () => {
    const s = await setup();
    await s.engine.start('approve', { who: 'Robin' });
    await s.signal('Quick one?', 'urgent');
    const r1 = await s.daemon.tick();
    expect(r1.sentNow).toHaveLength(1);
    expect(r1.bridge!.delivered).toHaveLength(1);
    expect(s.chat.sent.some((m) => m.startsWith('YOUR TURN: Approve Robin?'))).toBe(true);
    expect(s.chat.buttons).toBe(0);

    s.chat.human('1');
    const r2 = await s.daemon.tick();
    expect(r2.bridge!.answered).toHaveLength(1); // the card took it
    expect(r2.decided).toEqual([]);
    expect(await s.engine.pending()).toEqual([]);

    s.chat.human('#1 2');
    expect((await s.daemon.tick()).decided).toMatchObject([{ n: 1, verdict: 'reject' }]);
  });

  it('chat can answer with just a reaction (here: the emoji, since this app cannot react) or with silence', async () => {
    const r = await setup({ chief: 'REACT: 👍' });
    await r.daemon.tick();
    r.chat.human('ok thanks');
    await r.daemon.tick();
    expect(r.chat.sent).toEqual(['👍']);

    const q = await setup({ chief: 'NO_REPLY' });
    await q.daemon.tick();
    q.chat.human('heading out');
    await q.daemon.tick();
    expect(q.chat.sent).toEqual([]);
  });

  it('a two-bubble chat reply goes out as two short messages, never one dense wall', async () => {
    const s = await setup({ chief: 'Moved it to 2pm.\n---\nWant me to let Sam know?' });
    await s.daemon.tick();
    s.chat.human('move my 1pm an hour later');
    await s.daemon.tick();
    expect(s.chat.sent).toEqual(['Moved it to 2pm.', 'Want me to let Sam know?']);
  });

  it('without a chat channel, items print to the terminal', async () => {
    const s = await setup({ channel: false });
    await s.signal('Ping?', 'urgent');
    await s.daemon.tick();
    expect(s.printed).toEqual(['Heads up: Sam texted "Ping?" — want me to reply "Re: Ping?"? (1 to send, 2 to skip, or type your own version)']);
  });
});

describe('CLI: rufus now, rufus start, rufus decide #n, and the pruned help', () => {
  const lines = () => {
    const out: string[] = [];
    return { out, io: { out: (l: string) => void out.push(l), err: (l: string) => void out.push(l) } };
  };

  it('rufus now: Anchor, what waits on you, what ran on its own, Earned Trust; and it asks for a check-in', async () => {
    const dir = await tempDir();
    const run = async (...args: string[]) => {
      const c = lines();
      await main(['--dir', dir, ...args], c.io, { now: () => NOW });
      return c.out.join('\n');
    };
    await run('anchor', 'goal', 'Ship the beta', '--priority', 'high');
    await run('anchor', 'block', '07:30-09:00', 'focus', 'Deep work', '--date', '2026-11-25');
    await appendSignal(dir, { surface: 'anchor', kind: 'schedule.request', text: 'Gym', data: { range: '12:00-13:00', kind: 'personal', date: '2026-11-25' } }, new Date(NOW.getTime() - 2000));
    await appendSignal(dir, { surface: 'chat', kind: 'message.received', text: 'ok thanks', actor: 'Sam' }, new Date(NOW.getTime() - 1000));
    const started = await run('start', '--once');
    expect(started).toContain('Sensed 2 new signal(s); 2 handled');
    expect(started).toContain('item(s) waiting for the next check-in');

    const now = await run('now');
    expect(now).toContain('Now: 2026-11-25 08:00');
    expect(now).toContain('Today:\n  > 07:30-09:00 focus Deep work');
    expect(now).toContain('Goals: [high] Ship the beta');
    expect(now).toContain('Waiting on you (1):');
    expect(now).toMatch(/\[#1\] verify: schedule\.block: Put "Gym"/);
    expect(now).not.toContain('verify: triage.ignore'); // an acknowledgement never waits on you
    expect(now).toContain('Done on its own (last 24h): 1');
    expect(now).toContain("triage.ignore: Ignore Sam's chat message");
    expect(now).toContain('Earned Trust:');
    await access(path.join(dir, 'checkin.request'));

    expect(await run('decide', '#1', 'accept')).toMatch(/Recorded accept on loop_[0-9a-f]+: now accepted \(applied\)\./);
    await appendSignal(dir, { surface: 'chat', kind: 'message.received', text: '👍', actor: 'Alex' }, NOW);
    await run('start', '--once');
    const after = await run('now');
    expect(after).toContain('Done on its own (last 24h): 2');
    expect(after).toContain("triage.ignore: Ignore Alex's chat message");
    expect(after).toContain('schedule.block  check  accepted 1');
    await expect(run('decide', '#9', 'accept')).rejects.toThrow('Nothing is waiting as #9');
  });

  it('rufus start --once talks through the chat channel in plain text', async () => {
    const dir = await tempDir();
    const chat = new PlainChat(() => NOW);
    await appendSignal(dir, { surface: 'chat', kind: 'message.received', text: 'Call me asap, it is urgent', actor: 'Ops', data: { chatId: 'c1' } }, NOW);
    const c = lines();
    await main(['--dir', dir, 'start', '--once'], c.io, { channel: chat, now: () => NOW });
    expect(chat.sent).toEqual(['Heads up: your turn: Reply to Ops (chat): "Call me asap, it is urgent". (1 when it\'s done, 2 to skip)']);
    expect(c.out.join('\n')).toContain('sent 1 item(s) right away');
    expect(chat.buttons).toBe(0);
  });

  it('a SOUL.md and a config with tools and sensors are picked up by rufus start', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'SOUL.md'), 'Be brief.', 'utf8');
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, tools: { commands: { 'calendar.read': { command: process.execPath, args: ['-e', 'console.log("[]")'] } } }, sensors: { commands: [{ id: 'calendar', command: process.execPath, args: ['-e', 'console.log(JSON.stringify([{id:"e1",title:"Standup"}]))'] }] } }), 'utf8');
    const c = lines();
    await main(['--dir', dir, 'start', '--once'], c.io, { now: () => NOW });
    expect(c.out.join('\n')).not.toMatch(/problem/);
    const state = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir, 'loop-state.json'), 'utf8')) as { cursors: Record<string, string> };
    expect(JSON.parse(state.cursors.calendar!)).toEqual({ seen: ['e1'] }); // baseline: remembered, not emitted
  });

  it('--help leads with the primary commands and keeps the rest under Advanced / Legacy', async () => {
    const c = lines();
    await main(['--help'], c.io);
    const help = c.out.join('\n');
    const primary = help.indexOf('Primary commands:');
    const legacy = help.indexOf('Advanced / Legacy:');
    expect(primary).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(primary);
    for (const cmd of ['start', 'now', 'anchor', 'trust', 'decide', 'chat', 'collect', 'embed']) expect(help.slice(primary, legacy)).toMatch(new RegExp(`\\n  ${cmd}\\b`));
    for (const cmd of ['bridge', 'loop', 'signal', 'replay', 'backtest', 'mine', 'seed']) expect(help.slice(legacy)).toMatch(new RegExp(`\\n  ${cmd}\\b`));
  });
});
