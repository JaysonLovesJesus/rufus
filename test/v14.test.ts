import { describe, expect, it } from 'vitest';
import {
  ChiefOfStaff,
  CorpusStore,
  Engine,
  FakeProvider,
  FileStore,
  MasterLoop,
  TelegramChannel,
  UnifiedDaemon,
  acceptNudge,
  clock12,
  emptyAnchor,
  formatCheckin,
  formatLoopItem,
  formatNudge,
  loadChatHistory,
  messageTriageHandler,
  parseChatShape,
  parseLoopReply,
  saveAnchor,
  speakableTitle,
  upsertScheduleBlock,
  type Anchor,
  type IncomingMessage,
  type LiveChannel,
  type LoopRun,
  type LoopSignal,
  type ScheduleBlock,
  type Sensor,
} from '../src';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 8, 0); // a Wednesday
const TOKEN = '123456:TEST-TOKEN';
const CHAT = '4242';

type Call = { method: string; params: any };
function fakeTelegram(handlers: Record<string, (params: any) => unknown> = {}) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    const method = u.slice(u.lastIndexOf('/') + 1);
    const params = init.body ? JSON.parse(init.body as string) : {};
    calls.push({ method, params });
    const result = handlers[method]?.(params) ?? true;
    if (result instanceof Response) return result;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls, of: (m: string) => calls.filter((c) => c.method === m) };
}

const reaction = (update_id: number, emoji: string, extra: Record<string, unknown> = {}) => ({
  update_id,
  message_reaction: {
    chat: { id: Number(CHAT) },
    message_id: 77,
    user: { id: 7, is_bot: false },
    date: 1_800_000_000,
    old_reaction: [],
    new_reaction: [{ type: 'emoji', emoji }],
    ...extra,
  },
});

describe('Telegram: typing, reactions out, reactions in', () => {
  it('typing() sends the "typing" chat action to the configured chat', async () => {
    const t = fakeTelegram();
    await new TelegramChannel({ token: TOKEN, chatId: CHAT, fetch: t.fn }).typing();
    expect(t.calls).toEqual([{ method: 'sendChatAction', params: { chat_id: CHAT, action: 'typing' } }]);
  });

  it('react() puts an emoji reaction on a message by its numeric id', async () => {
    const t = fakeTelegram();
    await new TelegramChannel({ token: TOKEN, chatId: CHAT, fetch: t.fn }).react('42', '👍');
    expect(t.calls).toEqual([{ method: 'setMessageReaction', params: { chat_id: CHAT, message_id: 42, reaction: [{ type: 'emoji', emoji: '👍' }] } }]);
  });

  it('typing and react are best effort: an API error or a dead network never throws', async () => {
    const bad = fakeTelegram({ sendChatAction: () => new Response('{"ok":false,"description":"Bad Request"}', { status: 400 }), setMessageReaction: () => new Response('nope', { status: 500 }) });
    const ch = new TelegramChannel({ token: TOKEN, chatId: CHAT, fetch: bad.fn });
    await expect(ch.typing()).resolves.toBeUndefined();
    await expect(ch.react('42', '👍')).resolves.toBeUndefined();
    const offline = new TelegramChannel({ token: TOKEN, chatId: CHAT, fetch: (async () => { throw new Error('ENOTFOUND'); }) as typeof fetch });
    await expect(offline.typing()).resolves.toBeUndefined();
    await expect(offline.react('1', '❤️')).resolves.toBeUndefined();
    // A message id that is not a Telegram number is skipped without a call.
    const t = fakeTelegram();
    await new TelegramChannel({ token: TOKEN, chatId: CHAT, fetch: t.fn }).react('in_3', '👍');
    expect(t.calls).toEqual([]);
  });

  it('poll asks for message_reaction updates and turns an added emoji into a readable message', async () => {
    const t = fakeTelegram({
      getUpdates: () => [
        reaction(1, '👍'),
        reaction(2, '🔥', { old_reaction: [{ type: 'emoji', emoji: '🔥' }] }), // nothing new added
        reaction(3, '👍', { new_reaction: [] }), // a reaction removed
        reaction(4, '👍', { user: { id: 8, is_bot: true } }), // a bot
        reaction(5, '👍', { chat: { id: 999 } }), // another chat
        reaction(6, 'x', { new_reaction: [{ type: 'custom_emoji', custom_emoji_id: '123' }] }), // no plain emoji
        { update_id: 7, message: { message_id: 55, date: 1_800_000_000, text: 'ok thanks', chat: { id: Number(CHAT) }, from: { id: 7, is_bot: false } } },
      ],
    });
    const got = await new TelegramChannel({ token: TOKEN, chatId: CHAT, fetch: t.fn }).poll();
    expect(t.of('getUpdates')[0]!.params.allowed_updates).toEqual(['message', 'callback_query', 'message_reaction']);
    const at = new Date(1_800_000_000_000).toISOString();
    expect(got).toEqual([
      { id: 'tg_1', text: '[reacted 👍]', reaction: { emoji: '👍', targetMessageId: '77' }, at },
      { id: 'tg_7', text: 'ok thanks', messageId: '55', at },
    ]);
  });
});

describe('parseChatShape: the chief picks bubbles, a reaction, or silence', () => {
  it.each([
    ['NO_REPLY', { silent: true }],
    ['no_reply.', { silent: true }],
    ['REACT: 👍', { react: '👍' }],
    ['react:❤️', { react: '❤️' }],
    ['Sure, moved to 2pm.', { bubbles: ['Sure, moved to 2pm.'] }],
    ['Done, gym is at 6pm now.\n---\nWant me to tell Sam?', { bubbles: ['Done, gym is at 6pm now.', 'Want me to tell Sam?'] }],
    ['a\n---\nb\n---\nc\n---\nd', { bubbles: ['a', 'b', 'c\nd'] }],
    ['REACT: thumbs up please', { bubbles: ['REACT: thumbs up please'] }],
  ])('%j', (raw, shape) => {
    expect(parseChatShape(raw)).toEqual(shape);
  });
});

/** A chat app with a typing indicator and reactions, recording everything in order. */
class LiveChat implements LiveChannel {
  sent: string[] = [];
  events: string[] = [];
  reactions: Array<{ messageId: string; emoji: string }> = [];
  inbox: IncomingMessage[] = [];
  private n = 0;
  constructor(private readonly clock: () => Date) {}
  async send(text: string) {
    this.sent.push(text);
    this.events.push(`send:${text}`);
  }
  async poll(since?: string) {
    return this.inbox.filter((m) => !since || !m.at || m.at >= since);
  }
  async typing() {
    this.events.push('typing');
  }
  async react(messageId: string, emoji: string) {
    this.reactions.push({ messageId, emoji });
    this.events.push(`react:${messageId}:${emoji}`);
  }
  human(text: string, extra: Partial<IncomingMessage> = {}) {
    this.n++;
    this.inbox.push({ id: `in_${this.n}`, text, messageId: String(100 + this.n), at: new Date(this.clock().getTime() + this.n * 1000).toISOString(), ...extra });
  }
}

/** Same, but a chat app that cannot react or show typing (e.g. a plain bridge). */
class PlainChat extends LiveChat {
  declare react: never;
  declare typing: never;
}
Object.defineProperty(PlainChat.prototype, 'react', { value: undefined });
Object.defineProperty(PlainChat.prototype, 'typing', { value: undefined });

async function daemonSetup(script: ConstructorParameters<typeof FakeProvider>[0], opts: { chat?: LiveChat; bubblePauseMs?: number } = {}) {
  const dir = await tempDir();
  const clock = () => NOW;
  const provider = new FakeProvider(script);
  const engine = new Engine({ store: dir, provider, flows: [] });
  const loop = new MasterLoop({ dir, now: clock });
  const chat = opts.chat ?? new LiveChat(clock);
  const daemon = new UnifiedDaemon({ loop, engine, channel: chat, heartbeat: false, now: clock, bubblePauseMs: opts.bubblePauseMs ?? 0 });
  await daemon.tick(); // first pass: listen from now on
  return { dir, chat, provider, daemon, loop, engine };
}

describe('a stream, not forced back-and-forth', () => {
  it('"ok thanks" gets a 👍 reaction on that message, not a robotic reply', async () => {
    const s = await daemonSetup(() => 'REACT: 👍');
    s.chat.human('ok thanks');
    await s.daemon.tick();
    expect(s.chat.sent).toEqual([]);
    expect(s.chat.reactions).toEqual([{ messageId: '101', emoji: '👍' }]);
    expect(s.chat.events).toEqual(['typing', 'react:101:👍']); // typing while the model thinks, then the reaction
    const history = await loadChatHistory(s.dir, 10);
    expect(history.map((h) => [h.role, h.text])).toEqual([
      ['user', 'ok thanks'],
      ['assistant', '[reacted 👍]'],
    ]);
  });

  it('the system prompt teaches the shapes and natural phrasing (12-hour times, no tags)', async () => {
    const s = await daemonSetup(() => 'NO_REPLY');
    s.chat.human('cool');
    await s.daemon.tick();
    const system = s.provider.calls[0]!.system;
    expect(system).toContain('REACT: 👍');
    expect(system).toContain('NO_REPLY');
    expect(system).toContain('---');
    expect(system).toMatch(/12-hour.*2pm/);
    expect(system).toContain('(focus)');
  });

  it('NO_REPLY sends nothing at all (and remembers no assistant turn)', async () => {
    const s = await daemonSetup(() => 'NO_REPLY');
    s.chat.human('heading out now');
    await s.daemon.tick();
    expect(s.chat.sent).toEqual([]);
    expect(s.chat.reactions).toEqual([]);
    expect(s.chat.events).toEqual(['typing']);
    expect((await loadChatHistory(s.dir, 10)).map((h) => h.role)).toEqual(['user']);
  });

  it('two short bubbles arrive one after the other, with typing in between', async () => {
    const s = await daemonSetup(() => 'Moved gym to 6pm.\n---\nWant me to tell Sam?');
    s.chat.human('push gym back an hour');
    await s.daemon.tick();
    expect(s.chat.sent).toEqual(['Moved gym to 6pm.', 'Want me to tell Sam?']);
    expect(s.chat.events).toEqual(['typing', 'send:Moved gym to 6pm.', 'typing', 'send:Want me to tell Sam?']);
  });

  it('bubbles wait a brief pause between them', async () => {
    const s = await daemonSetup(() => 'one\n---\ntwo', { bubblePauseMs: 40 });
    s.chat.human('hi there, what is up');
    const t0 = Date.now();
    await s.daemon.tick();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(s.chat.sent).toEqual(['one', 'two']);
  });

  it('a chat app that cannot react gets the emoji as a tiny message instead', async () => {
    const s = await daemonSetup(() => 'REACT: 🙏', { chat: new PlainChat(() => NOW) });
    s.chat.human('thanks!!');
    await s.daemon.tick();
    expect(s.chat.sent).toEqual(['🙏']);
  });

  it('an emoji reaction from the human is seen (remembered) but never answered or read as an edit of a waiting item', async () => {
    const s = await daemonSetup(() => {
      throw new Error('no model call for a reaction');
    });
    s.chat.human('[reacted 👍]', { reaction: { emoji: '👍', targetMessageId: '9' }, messageId: undefined });
    const r = await s.daemon.tick();
    expect(r.decided).toEqual([]);
    expect(s.chat.sent).toEqual([]);
    expect(s.provider.calls).toHaveLength(0);
    expect((await loadChatHistory(s.dir, 10)).map((h) => h.text)).toEqual(['[reacted 👍]']);
  });
});

describe('natural nudges and Verify messages', () => {
  const block = (over: Partial<ScheduleBlock>): ScheduleBlock => ({ id: 'b1', start: '14:00', end: '15:00', title: 'Chapel', kind: 'focus', status: 'planned', ...over });

  it('clock12 speaks the casual 12-hour way', () => {
    expect(['00:00', '00:15', '09:00', '09:30', '12:00', '12:45', '14:00', '23:59', 'soon'].map(clock12)).toEqual(['12am', '12:15am', '9am', '9:30am', '12pm', '12:45pm', '2pm', '11:59pm', 'soon']);
  });

  it('a heads-up is one short casual line: no "Heads-up:", no (focus), no 14:00', () => {
    const text = formatNudge(block({}), new Date(2026, 10, 25, 13, 50));
    expect(text).toBe('Chapel is in 10 min (2pm)');
    expect(text).not.toMatch(/\(focus\)|14:00|Heads-up/);
    expect(formatNudge(block({ title: 'Weekly planning sync (event) - review the Q3 board, budget and hiring plan', start: '09:30' }), new Date(2026, 10, 25, 9, 25))).toBe('Weekly planning sync is in 5 min (9:30am)');
    expect(speakableTitle('A really very long block title that goes on and on about many things at once')).toBe('A really very long block title that goes on and');
  });

  it('acceptNudge keeps a good model line and refuses rambling, tags or a 24-hour clock', () => {
    expect(acceptNudge('"Chapel in 10, grab your jacket"')).toBe('Chapel in 10, grab your jacket');
    expect(acceptNudge('Chapel (focus) starts soon')).toBeUndefined();
    expect(acceptNudge('Chapel starts at 14:00')).toBeUndefined();
    expect(acceptNudge('Line one\nline two')).toBeUndefined();
    expect(acceptNudge('x'.repeat(200))).toBeUndefined();
  });

  async function heartbeatDaemon(model: ConstructorParameters<typeof FakeProvider>[0] | undefined) {
    const dir = await tempDir();
    let t = new Date(2026, 10, 25, 13, 49);
    const clock = () => t;
    let a: Anchor = emptyAnchor(t);
    a = upsertScheduleBlock(a, { start: '14:00', end: '15:00', title: 'Chapel', kind: 'focus' }).anchor;
    await saveAnchor(dir, a, t);
    const chat = new LiveChat(clock);
    const provider = model ? new FakeProvider(model) : undefined;
    const engine = new Engine({ store: dir, flows: [], ...(provider ? { providers: { fast: provider } } : {}) });
    const daemon = new UnifiedDaemon({ loop: new MasterLoop({ dir, now: clock }), engine, channel: chat, chief: false, heartbeat: { phrasing: 'ai' }, now: clock });
    await daemon.tick();
    t = new Date(2026, 10, 25, 13, 50);
    await daemon.tick();
    return { chat, provider };
  }

  it('with phrasing "ai", one fast-tier call words the heads-up', async () => {
    const { chat, provider } = await heartbeatDaemon(() => 'Chapel in 10 min, heads up');
    expect(chat.sent).toEqual(['Chapel in 10 min, heads up']);
    expect(provider!.calls[0]!.messages[0]!.content).toContain('Starts: 2pm, in 10 min.');
  });

  it('with phrasing "ai" but no model (or a bad line), the casual code line goes out', async () => {
    expect((await heartbeatDaemon(undefined)).chat.sent).toEqual(['Chapel is in 10 min (2pm)']);
    expect((await heartbeatDaemon(() => 'Heads-up: Chapel (focus) starts at 14:00.')).chat.sent).toEqual(['Chapel is in 10 min (2pm)']);
  });

  const run = (over: Partial<LoopRun>): LoopRun => ({
    id: 'loop_1',
    sensorId: 'beeper',
    handlerId: 'message.triage',
    signal: { id: 's', surface: 'chat', kind: 'message.received', text: 'are we still on for tonight?', actor: 'Robin' },
    status: 'awaiting_human_verify',
    actionType: 'reply.chat',
    goal: 'Draft a concise reply',
    result: { label: 'batch', reply: 'Yes! See you at 7.' },
    urgency: 'urgent',
    replans: 0,
    trail: [],
    aiCalls: 1,
    spectrum: { code: 1, fast: 1, smart: 0, human: 1 },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  });

  it('a Verify item reads like an assistant texting, with no [#1] or (urgent) form fields', () => {
    const text = formatLoopItem(run({ urgency: 'normal' }), 1);
    expect(text).toBe('Robin texted "are we still on for tonight?" — want me to reply "Yes! See you at 7."? (1 to send, 2 to skip, or type your own version)');
    const urgent = formatLoopItem(run({}), 1);
    expect(urgent).not.toMatch(/\[#|\(urgent\)|Draft:|Reply:/);
    expect(urgent.startsWith('Heads up: Robin texted')).toBe(true);
    expect(formatLoopItem(run({ signal: { id: 'e', surface: 'email', kind: 'email.received', text: 'Invoice attached', actor: 'Billing' } }), 1)).toContain('Billing emailed "Invoice attached"');
    expect(formatCheckin([{ run: run({}), n: 1 }, { run: run({ id: 'loop_2' }), n: 2 }])).toMatch(/^2 things waiting on you\./);
  });

  it('parseLoopReply still reads 1, 2, y, n, edit: and natural feedback', () => {
    expect(parseLoopReply('1')).toEqual({ kind: 'decision', verdict: 'accept' });
    expect(parseLoopReply('y')).toEqual({ kind: 'decision', verdict: 'accept' });
    expect(parseLoopReply('2')).toEqual({ kind: 'decision', verdict: 'reject' });
    expect(parseLoopReply('n')).toEqual({ kind: 'decision', verdict: 'reject' });
    expect(parseLoopReply('edit: See you at 8!')).toEqual({ kind: 'decision', verdict: 'edit', edit: 'See you at 8!' });
    expect(parseLoopReply("2 that's just a WhatsApp call alert, ignore those")).toEqual({ kind: 'decision', verdict: 'reject', note: "that's just a WhatsApp call alert, ignore those" });
  });
});

describe('rejection-driven learning in triage', () => {
  /** A sensor that hands out whatever is queued, once. */
  function queueSensor() {
    const queue: LoopSignal[] = [];
    const sensor: Sensor = { id: 'beeper', surface: 'chat', poll: () => ({ signals: queue.splice(0), nextCursor: 'x' }) };
    return { sensor, push: (s: LoopSignal) => void queue.push(s) };
  }
  const msg = (id: string, text: string, actor: string): LoopSignal => ({ id, surface: 'chat', kind: 'message.received', text, actor, data: { chatId: `c-${actor}` } });

  it('a past rejection with a note reaches the triage prompt, so the next similar message is ignored', async () => {
    const dir = await tempDir();
    const q = queueSensor();
    // A model that, like a real one, follows the human's notes it is shown.
    const provider = new FakeProvider((req) => {
      const prompt = req.messages.map((m) => m.content).join('\n');
      if (/Triage this/.test(prompt)) {
        return /ignore those/.test(prompt) && /call alert/i.test(prompt) ? '{"label":"ignore","reason":"you said to ignore call alerts"}' : '{"label":"batch","reason":"might need an answer"}';
      }
      return '{"reply":"Sorry I missed your call!"}';
    });
    const loop = new MasterLoop({ dir, sensors: [q.sensor], handlers: [messageTriageHandler()], providers: { fast: provider }, now: () => NOW });

    q.push(msg('1', 'Missed WhatsApp voice call', 'Dana'));
    const first = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(first.status).toBe('awaiting_human_verify');
    await loop.resolveHumanDecision(first.id, { verdict: 'reject', note: "that's just a WhatsApp call alert, ignore those" });
    const saved = (await new CorpusStore(new FileStore(dir).corpusFile).load()).filter((i) => i.source === 'feedback');
    expect(saved.map((i) => i.summary).join('\n')).toContain('ignore those');

    const before = provider.calls.length;
    q.push(msg('2', 'Missed WhatsApp video call', 'Lee'));
    const second = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    const triagePrompt = provider.calls[before]!.messages[0]!.content;
    expect(triagePrompt).toContain("Note: that's just a WhatsApp call alert, ignore those");
    expect(triagePrompt).toContain('If the human previously rejected a similar message');
    expect(triagePrompt).toContain('classify as "ignore"');
    expect(second).toMatchObject({ status: 'completed', actionType: 'triage.ignore' });
    expect(provider.calls.length).toBe(before + 1); // no draft for an ignored message
  });

  it('without past decisions, the triage prompt carries no learning block', async () => {
    const dir = await tempDir();
    const q = queueSensor();
    const provider = new FakeProvider(['{"label":"batch","reason":"x"}', '{"reply":"Sure."}']);
    const loop = new MasterLoop({ dir, sensors: [q.sensor], handlers: [messageTriageHandler()], providers: { fast: provider }, now: () => NOW });
    q.push(msg('1', 'Lunch Thursday?', 'Sam'));
    await loop.runOnce();
    expect(provider.calls[0]!.messages[0]!.content).not.toContain('past decisions');
  });
});

describe('ChiefOfStaff reply shapes (no daemon)', () => {
  it('handle() returns bubbles / react / silent; handleMessage never prints an empty line', async () => {
    const dir = await tempDir();
    const replies = ['a\n---\nb', 'REACT: 👍', 'NO_REPLY'];
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => replies.shift()!), flows: [] });
    const chief = new ChiefOfStaff({ engine, now: () => NOW });
    expect(await chief.handle('tell me two things')).toMatchObject({ text: 'a\n\nb', bubbles: ['a', 'b'] });
    expect(await chief.handle('ok')).toMatchObject({ text: '👍', react: '👍' });
    expect(await chief.handleMessage('k')).toBe('(no reply needed)');
  });
});
