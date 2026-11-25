import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BeeperApi,
  ChiefOfStaff,
  CorpusStore,
  Engine,
  FakeProvider,
  FileStore,
  MasterLoop,
  ToolRegistry,
  TrustStore,
  UnifiedDaemon,
  beeperTools,
  buildSelfReview,
  countNudges,
  emptyAnchor,
  extractReactionExamples,
  getAdapter,
  loadSelfReviews,
  loadStartState,
  messageTriageHandler,
  reactionHint,
  reactionItemsFromExport,
  saveAnchor,
  selfReviewSkipReason,
  textSimilarity,
  SELF_REVIEW_FILE,
  type ChatMessageLike,
  type ChatTurn,
  type IncomingMessage,
  type LiveChannel,
  type LoopRun,
  type LoopSignal,
  type Sensor,
} from '../src';
import { main, usage, type Io } from '../src/cli';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 19, 30); // a Wednesday, 7:30pm local
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (msFromNow: number, base = NOW): string => new Date(base.getTime() + msFromNow).toISOString();

const sig = (id: string, text: string, over: Partial<LoopSignal> = {}): LoopSignal => ({ id, surface: 'chat', kind: 'message.received', text, actor: 'Mom', timestamp: at(Number(id) * 1000 || 0), data: { chatId: 'c-mom', messageId: `m-${id}` }, ...over });

function scripted(batches: LoopSignal[][]): Sensor {
  let i = 0;
  return { id: 'beeper', surface: 'chat', poll: () => ({ signals: batches[i++] ?? [], nextCursor: String(i) }) };
}

function fakeBeeper(thread: Array<Record<string, unknown>> = []) {
  const calls: Array<{ method: string; path: string }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path: decodeURIComponent(new URL(String(url)).pathname) });
    return new Response(JSON.stringify(method === 'GET' ? { items: thread } : { pendingMessageID: 'pm_1' }), { status: 200 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

// ---------- 1. Beeper emoji reaction learning ----------

describe('v18: BeeperApi exposes structured reactions', () => {
  it('reads reactions loosely and marks yours by isMe, or by your own sender id', async () => {
    const b = fakeBeeper([
      { id: 'm1', text: 'haha that is hilarious', senderID: 'them', timestamp: at(-3 * HOUR), reactions: [{ reactionKey: '😂', participantID: 'me', emoji: true }, { reactionKey: '❤️', participantID: 'them' }] },
      { id: 'm2', text: 'see you', senderID: 'me', isSender: true, timestamp: at(-2 * HOUR) },
      { id: 'm3', text: 'night!', senderID: 'them', timestamp: at(-HOUR), reactions: [{ emoji: '👍', isMe: true }] },
      { id: 'm4', text: 'plain', senderID: 'them', timestamp: at(-30 * MIN) },
    ]);
    const msgs = await new BeeperApi({ fetch: b.fetch }).listMessages('c1');
    expect(msgs[0]!.reactions).toEqual([
      { emoji: '😂', participantId: 'me', isMe: true },
      { emoji: '❤️', participantId: 'them' },
    ]);
    expect(msgs[2]!.reactions).toEqual([{ emoji: '👍', isMe: true }]);
    expect(msgs[3]).not.toHaveProperty('reactions');
  });
});

describe('v18: extractReactionExamples', () => {
  const thread: ChatMessageLike[] = [
    // You only reacted 😂, and their next message came an hour later: a clean reaction example.
    { id: 'a', chatId: 'c-mom', text: 'haha that is so funny', senderName: 'Mom', timestamp: at(-5 * HOUR), reactions: [{ emoji: '😂', isMe: true }] },
    // You reacted AND answered in text: not a reaction-only example.
    { id: 'b', chatId: 'c-mom', text: 'can you grab milk?', senderName: 'Mom', timestamp: at(-4 * HOUR), reactions: [{ emoji: '👍', isMe: true }] },
    { id: 'c', chatId: 'c-mom', text: 'sure, on my way', isSender: true, timestamp: at(-4 * HOUR + 2 * MIN) },
    // Someone else's reaction does not count.
    { id: 'd', chatId: 'c-mom', text: 'look at this sunset', senderName: 'Mom', timestamp: at(-3 * HOUR), reactions: [{ emoji: '😍', isMe: false }] },
    // Deleted and noise messages never become examples.
    { id: 'e', chatId: 'c-mom', text: 'oops', senderName: 'Mom', isDeleted: true, timestamp: at(-2 * HOUR), reactions: [{ emoji: '👍', isMe: true }] },
    { id: 'f', chatId: 'c-mom', text: 'Your verification code is 123456', senderName: 'Mom', timestamp: at(-HOUR), reactions: [{ emoji: '👍', isMe: true }] },
  ];

  it('keeps only messages you answered with an emoji and no text, as chat_reaction corpus items', () => {
    const items = extractReactionExamples(thread);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'chat_reaction',
      kind: 'reaction',
      actor: 'Mom',
      summary: 'Mom: haha that is so funny → reacted 😂',
      tags: ['😂'],
      metadata: { emoji: '😂', text: 'haha that is so funny', chatId: 'c-mom', messageId: 'a' },
    });
    expect(extractReactionExamples(thread)[0]!.id).toBe(items[0]!.id); // stable: collecting twice never duplicates
  });

  it('a text reply after their next message still counts when it came within the reply window', () => {
    const burst: ChatMessageLike[] = [
      { id: 'x', text: 'lol', senderName: 'Sam', timestamp: at(-HOUR), reactions: [{ emoji: '😂', isMe: true }] },
      { id: 'y', text: 'also, dinner friday?', senderName: 'Sam', timestamp: at(-HOUR + MIN) },
      { id: 'z', text: 'yes!', isSender: true, timestamp: at(-HOUR + 5 * MIN) },
    ];
    expect(extractReactionExamples(burst)).toEqual([]);
  });

  it('a Beeper export collects through `rufus collect reactions`', () => {
    expect(getAdapter('reactions').source).toBe('chat_reaction');
    const items = reactionItemsFromExport([
      { chats: [{ id: 'c-sam', title: 'Sam', messages: [{ id: '1', text: 'made it home safe', senderID: 'sam', timestamp: at(-HOUR), reactions: [{ reactionKey: '❤️', participantID: 'me' }] }, { id: '2', text: 'night', senderID: 'me', isSender: true, timestamp: at(-HOUR + 14 * HOUR) }] }] },
    ]);
    expect(items.map((i) => i.summary)).toEqual(['Sam: made it home safe → reacted ❤️']);
  });
});

describe('v18: reactionHint', () => {
  const r = (text: string, emoji = '😂') => ({ text, outcome: 'reaction' as const, emoji });
  it('two similar reaction-only answers are strong; one is only a hint; text replies outweigh it', () => {
    expect(textSimilarity('haha that is so funny', 'haha so funny')).toBeGreaterThan(0.4);
    const strong = reactionHint('haha that is so funny 😂', [r('haha that is so funny'), r('haha so funny'), r('what time is dinner?', '👍')]);
    expect(strong).toMatchObject({ emoji: '😂', reactions: 2, replies: 0, strong: true });
    expect(reactionHint('haha so funny', [r('haha that is so funny')])).toMatchObject({ strong: false, reactions: 1 });
    const mixed = reactionHint('haha so funny', [r('haha so funny'), r('haha that is so funny'), { text: 'haha so funny', outcome: 'text' }, { text: 'so funny haha', outcome: 'text' }, { text: 'haha funny', outcome: 'text' }]);
    expect(mixed?.strong).toBe(false);
    expect(reactionHint('Can we move the meeting to 3pm?', [r('haha that is so funny')])).toBeUndefined();
  });
});

describe('v18: triage suggests a reaction instead of drafting a sentence', () => {
  it('similar past messages only got 😂: a react step, chosen by code with no model call', async () => {
    const dir = await tempDir();
    const corpus = new CorpusStore(new FileStore(dir).corpusFile);
    await corpus.add(
      extractReactionExamples([
        { id: 'p1', chatId: 'c-mom', text: 'haha that is so funny', senderName: 'Mom', timestamp: at(-48 * HOUR), reactions: [{ emoji: '😂', isMe: true }] },
        { id: 'p2', chatId: 'c-mom', text: 'haha so funny', senderName: 'Mom', timestamp: at(-24 * HOUR), reactions: [{ emoji: '😂', isMe: true }] },
      ]),
    );
    const provider = new FakeProvider(['{"label":"batch","reason":"x"}', '{"reply":"lol"}']);
    const loop = new MasterLoop({ dir, sensors: [scripted([[sig('1', 'haha that is so so funny')]])], handlers: [messageTriageHandler()], providers: { fast: provider }, now: () => NOW });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(provider.calls).toHaveLength(0);
    expect(run).toMatchObject({ status: 'awaiting_human_execute', actionType: 'react.chat', humanStep: 'React 😂 to Mom', plan: { label: 'react', emoji: '😂' } });
    expect(run.plan!.reason).toMatch(/usually just react 😂/);
  });

  it('learns from the live thread too (beeper.read): how you answered this chat lately', async () => {
    const dir = await tempDir();
    const b = fakeBeeper([
      { id: 'o1', text: 'goodnight sweetie', senderName: 'Mom', timestamp: at(-48 * HOUR), reactions: [{ emoji: '❤️', isMe: true }] },
      { id: 'o2', text: 'see you tomorrow', senderName: 'Mom', timestamp: at(-30 * HOUR) },
      { id: 'o4', text: 'ok!', isSender: true, timestamp: at(-29 * HOUR) }, // answers "see you tomorrow" in text
      { id: 'o3', text: 'goodnight love you', senderName: 'Mom', timestamp: at(-24 * HOUR), reactions: [{ emoji: '❤️', isMe: true }] },
      { id: 'm-1', text: 'goodnight sweetie love you', senderName: 'Mom', timestamp: at(1000) },
    ]);
    const loop = new MasterLoop({ dir, sensors: [scripted([[sig('1', 'goodnight sweetie love you')]])], handlers: [messageTriageHandler()], tools: new ToolRegistry({ tools: beeperTools({ fetch: b.fetch }) }), now: () => NOW });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run).toMatchObject({ actionType: 'react.chat', humanStep: 'React ❤️ to Mom' });
    expect(run.toolCalls).toMatchObject([{ tool: 'beeper.read', stage: 'plan', ok: true }]);
    expect(b.calls.filter((c) => c.method === 'POST')).toHaveLength(0); // never reacts or sends on its own
  });

  it('a single similar example is a hint for the model, which may answer "react"', async () => {
    const dir = await tempDir();
    await new CorpusStore(new FileStore(dir).corpusFile).add(extractReactionExamples([{ id: 'p1', text: 'look at this view from the trail', senderName: 'Sam', timestamp: at(-HOUR * 30), reactions: [{ emoji: '😍', isMe: true }] }]));
    const provider = new FakeProvider(['{"label":"react","emoji":"😍","reason":"just a photo share"}']);
    const loop = new MasterLoop({ dir, sensors: [scripted([[sig('1', 'look at this view from the summit', { actor: 'Sam', data: { chatId: 'c-sam' } })]])], handlers: [messageTriageHandler()], providers: { fast: provider }, now: () => NOW });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    const prompt = String(provider.calls[0]!.messages[0]!.content);
    expect(prompt).toContain('you usually just react 😍 to messages like this (1 time)');
    expect(prompt).toContain('"label":"react"');
    expect(provider.calls).toHaveLength(1); // no sentence was drafted
    expect(run).toMatchObject({ status: 'awaiting_human_execute', actionType: 'react.chat', humanStep: 'React 😍 to Sam' });
  });

  it('nothing similar: triage drafts as before', async () => {
    const dir = await tempDir();
    await new CorpusStore(new FileStore(dir).corpusFile).add(extractReactionExamples([{ id: 'p1', text: 'haha so funny', senderName: 'Mom', timestamp: at(-HOUR * 30), reactions: [{ emoji: '😂', isMe: true }] }]));
    const provider = new FakeProvider(['{"label":"batch","reason":"a question"}', '{"reply":"7 works"}']);
    const loop = new MasterLoop({ dir, sensors: [scripted([[sig('1', 'What time should we meet on Friday?')]])], handlers: [messageTriageHandler()], providers: { fast: provider }, now: () => NOW });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(String(provider.calls[0]!.messages[0]!.content)).not.toContain('usually just react');
    expect(run).toMatchObject({ status: 'awaiting_human_verify', actionType: 'reply.chat', result: { reply: '7 works' } });
  });
});

// ---------- 2. Daily self-review ----------

const turn = (role: ChatTurn['role'], text: string, when: number, proactive = false): ChatTurn => ({ role, text, at: at(when), ...(proactive ? { proactive: true } : {}) });

function runOf(id: string, over: Partial<LoopRun>): LoopRun {
  return { id, sensorId: 'beeper', handlerId: 'message.triage', signal: { id, surface: 'chat', kind: 'message.received' }, status: 'accepted', replans: 0, trail: [], aiCalls: 0, spectrum: { code: 0, fast: 0, smart: 0, human: 0 }, createdAt: at(-HOUR), updatedAt: at(-HOUR), ...over } as LoopRun;
}
const decided = (verdict: 'accept' | 'edit' | 'reject', when: number, note?: string): LoopRun['decision'] => ({ verdict, stage: 'verify', at: at(when), ...(note ? { note } : {}) });

async function writeRuns(dir: string, runs: LoopRun[]): Promise<void> {
  await mkdir(path.join(dir, 'loop-runs'), { recursive: true });
  for (const r of runs) await writeFile(path.join(dir, 'loop-runs', `${r.id}.json`), JSON.stringify(r));
}

async function writeHistory(dir: string, turns: ChatTurn[]): Promise<void> {
  await writeFile(path.join(dir, 'chat-history.jsonl'), turns.map((t) => JSON.stringify(t)).join('\n') + '\n');
}

describe('v18: daily self-review gate', () => {
  const anchor = emptyAnchor(NOW);
  it('after 19:00, before quiet hours, once per day, never in protected time (a Sabbath)', () => {
    expect(selfReviewSkipReason({ now: NOW, anchor })).toBeUndefined();
    expect(selfReviewSkipReason({ now: new Date(2026, 10, 25, 18, 59), anchor })).toBe('too early');
    expect(selfReviewSkipReason({ now: new Date(2026, 10, 25, 22, 30), anchor })).toBe('quiet hours');
    expect(selfReviewSkipReason({ now: NOW, anchor, state: { lastDate: '2026-11-25' } })).toBe('done today');
    expect(selfReviewSkipReason({ now: NOW, anchor, state: { lastDate: '2026-11-24' } })).toBeUndefined();
    expect(selfReviewSkipReason({ now: new Date(2026, 10, 25, 17, 0), anchor, after: '16:30' })).toBeUndefined();
    const friday = new Date(2026, 10, 27, 19, 30);
    const sabbath = { ...emptyAnchor(friday), boundaries: [{ id: 'sabbath', rule: 'Keep the Sabbath quiet', kind: 'protect_time' as const, when: 'fri 18:00 - sat 18:00' }] };
    expect(selfReviewSkipReason({ now: friday, anchor: sabbath })).toBe('protected: Keep the Sabbath quiet');
  });
});

describe('v18: daily self-review record', () => {
  it('counts nudges sent vs. ignored (bubbles close together are one nudge)', () => {
    const turns = [
      turn('assistant', 'Open afternoon, want to plan the gym?', -8 * HOUR, true),
      turn('assistant', 'Or a walk?', -8 * HOUR + 30_000, true), // second bubble of the same nudge
      turn('assistant', 'Reminder: call the bank before 5', -5 * HOUR, true),
      turn('user', 'thanks, done', -4.5 * HOUR),
      turn('assistant', 'Want me to block tomorrow morning?', -3 * HOUR, true),
      turn('assistant', 'Any plans for dinner?', -30 * MIN, true), // too recent to call ignored
      turn('assistant', 'Sure thing.', -4.5 * HOUR + 1000), // an answer, not a nudge
      turn('assistant', 'Yesterday morning nudge', -30 * HOUR, true), // outside the 24h window
    ].sort((a, b) => a.at.localeCompare(b.at));
    expect(countNudges(turns, NOW)).toEqual({ sent: 4, answered: 1, ignored: 2, pending: 1 });
  });

  it('reads chat-history, loop-runs and trust.json: verify verdicts, rejections, promotions, failed and missing tools', async () => {
    const dir = await tempDir();
    await writeHistory(dir, [turn('assistant', 'Heads up: gym at 6pm', -8 * HOUR, true), turn('assistant', 'Free evening, plan something?', -4 * HOUR, true)]);
    await writeRuns(dir, [
      runOf('r1', { actionType: 'reply.chat', decision: decided('accept', -3 * HOUR), toolCalls: [{ tool: 'beeper.send', stage: 'commit', ok: true, at: at(-3 * HOUR) }] }),
      runOf('r2', { actionType: 'reply.chat', status: 'edited', decision: decided('edit', -2 * HOUR) }),
      runOf('r3', { actionType: 'reply.email', status: 'rejected', decision: decided('reject', -2 * HOUR, 'too formal') }),
      runOf('r4', { actionType: 'reply.email', status: 'rejected', decision: decided('reject', -90 * MIN) }),
      runOf('r5', { actionType: 'reply.email', status: 'rejected', decision: decided('reject', -60 * MIN, 'never sign off with regards') }),
      runOf('r6', { actionType: 'reply.chat', status: 'expired', expiredAt: at(-30 * MIN) }),
      runOf('r7', { actionType: 'reply.chat', decision: decided('accept', -40 * HOUR) }), // yesterday: not counted
      runOf('r8', { actionType: 'calendar.check', status: 'error', toolCalls: [{ tool: 'calendar.read', stage: 'execute', ok: false, at: at(-HOUR), error: 'calendar.read: no such tool. Available: none' }] }),
      runOf('r9', { actionType: 'reply.chat', commitError: 'Approved, but no "beeper.send" tool is configured. Send it yourself.', decision: decided('accept', -20 * MIN) }),
    ]);
    const trust = new TrustStore(dir, { now: () => NOW });
    await trust.setThreshold('schedule.block', 2);
    await trust.recordFeedback('schedule.block', 'accept');
    await trust.recordFeedback('schedule.block', 'accept');

    const record = await buildSelfReview({ dir, now: NOW });
    expect(record).toMatchObject({
      date: '2026-11-25',
      nudges: { sent: 2, answered: 0, ignored: 2, pending: 0 },
      verify: { accepted: 2, edited: 1, rejected: 3, expired: 1 },
      rejections: [{ actionType: 'reply.email', count: 3, notes: ['too formal', 'never sign off with regards'] }],
      promotions: [{ actionType: 'schedule.block', consecutiveClean: 2, threshold: 2 }],
      tools: { calls: 2, failed: 0, missing: 2 },
    });
    expect(record.tools.byTool.map((t) => `${t.tool}:${t.missing}`)).toEqual(['beeper.send:1', 'calendar.read:1']);
    expect(record.insights.map((i) => i.kind)).toEqual(['promotion', 'rejections']);
    expect(record.insights[0]!.text).toContain('rufus trust promote schedule.block');
    expect(record.insights[1]!.text).toContain('turned down 3 of my reply.email items (last time: "never sign off with regards")');
  });
});

// ---------- the daemon ----------

class Chat implements LiveChannel {
  sent: string[] = [];
  inbox: IncomingMessage[] = [];
  async send(text: string) {
    this.sent.push(text);
  }
  async poll() {
    return [];
  }
}

async function daemonSetup(start: Date) {
  const dir = await tempDir();
  let t = start;
  const clock = () => t;
  const chat = new Chat();
  const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'SILENT') });
  const loop = new MasterLoop({ dir, sensors: [], handlers: [], now: clock });
  const daemon = new UnifiedDaemon({ loop, engine, channel: chat, chief: new ChiefOfStaff({ engine, loop, now: clock }), heartbeat: false, selfReview: {}, now: clock });
  return { dir, chat, daemon, set: (d: Date) => void (t = d) };
}

describe('v18: the self-review in rufus start', () => {
  it('silent when nothing is actionable, but the record is always saved, once a day', async () => {
    const s = await daemonSetup(NOW);
    await writeHistory(s.dir, [turn('assistant', 'Open evening, want to plan?', -5 * HOUR, true), turn('user', 'nah, resting', -4 * HOUR)]);
    expect((await s.daemon.tick()).reviewed).toBe('silent');
    expect(s.chat.sent).toEqual([]);
    const saved = await loadSelfReviews(s.dir);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ date: '2026-11-25', nudges: { sent: 1, answered: 1, ignored: 0 }, insights: [] });
    expect(saved[0]).not.toHaveProperty('note');
    s.set(new Date(2026, 10, 25, 21, 0));
    expect((await s.daemon.tick()).reviewed).toBe('skipped: done today');
    expect(await loadSelfReviews(s.dir)).toHaveLength(1);
    expect((await loadStartState(s.dir)).selfReview?.lastDate).toBe('2026-11-25');
  });

  it('an action ready for Earned Trust promotion: ONE brief evening note, said once (not again the next evening)', async () => {
    const s = await daemonSetup(NOW);
    const trust = new TrustStore(s.dir, { now: () => NOW });
    await trust.setThreshold('reply.chat', 1);
    await trust.recordFeedback('reply.chat', 'accept');
    const r = await s.daemon.tick();
    expect(r.reviewed).toBe('noted');
    expect(s.chat.sent).toHaveLength(1);
    expect(s.chat.sent[0]).toMatch(/^Quick one before tonight: you've OK'd my reply\.chat 1 times in a row/);
    expect(r.proactive).toEqual(s.chat.sent);
    const history = (await readFile(path.join(s.dir, 'chat-history.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as ChatTurn);
    expect(history.at(-1)).toMatchObject({ role: 'assistant', proactive: true });
    expect((await loadSelfReviews(s.dir))[0]!.note).toBe(s.chat.sent[0]);

    s.set(new Date(2026, 10, 26, 19, 45));
    expect((await s.daemon.tick()).reviewed).toBe('silent'); // still suggested, already said: no nagging
    expect(s.chat.sent).toHaveLength(1);
    expect(await loadSelfReviews(s.dir)).toHaveLength(2);
  });

  it('skips quiet hours (and writes nothing)', async () => {
    const s = await daemonSetup(new Date(2026, 10, 25, 22, 30));
    expect((await s.daemon.tick()).reviewed).toBe('skipped: quiet hours');
    await expect(readFile(path.join(s.dir, SELF_REVIEW_FILE), 'utf8')).rejects.toThrow();
  });

  it('skips a Sabbath evening', async () => {
    const friday = new Date(2026, 10, 27, 19, 30);
    const s = await daemonSetup(friday);
    await saveAnchor(s.dir, { ...emptyAnchor(friday), boundaries: [{ id: 'sabbath', rule: 'Keep the Sabbath quiet', kind: 'protect_time', when: 'fri 18:00 - sat 18:00' }] }, friday);
    expect((await s.daemon.tick()).reviewed).toBe('skipped: protected: Keep the Sabbath quiet');
  });
});

// ---------- 3. CLI help pruning ----------

function lines() {
  const out: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => out.push(l) };
  return { out, io };
}

describe('v18: rufus --help is the Jarvis core', () => {
  it('primary commands first, legacy one line each; --all spells out every legacy option', async () => {
    const c = lines();
    await main(['--help'], c.io);
    const help = c.out.join('\n');
    const legacy = help.indexOf('Advanced / Legacy:');
    for (const cmd of ['start', 'now', 'anchor', 'trust', 'decide', 'chat', 'collect', 'embed']) expect(help.slice(0, legacy)).toMatch(new RegExp(`\\n  ${cmd}\\b`));
    for (const cmd of ['bridge', 'loop', 'signal', 'seed', 'mine', 'replay', 'backtest', 'context', 'demo']) expect(help.slice(legacy)).toMatch(new RegExp(`\\n  ${cmd}\\b`));
    expect(help).toContain('rufus --help --all');
    expect(help).not.toContain('--older-than'); // legacy detail is tucked away
    expect(help).not.toContain('replay --scope');
    // Every legacy line is a single line: no wrapped option blocks.
    expect(help.slice(legacy).split('\n').filter((l) => /^\s{20,}\S/.test(l))).toEqual([]);

    const all = lines();
    await main(['--help', '--all'], all.io);
    const full = all.out.join('\n');
    expect(full).toContain('lessons [--prune [--older-than <days>]');
    expect(full).toContain('replay --scope <flow:id|role:name|global>');
    expect(full.indexOf('Primary commands:')).toBeLessThan(full.indexOf('Advanced / Legacy:'));

    const h = lines();
    await main(['help', '--all'], h.io);
    expect(h.out.join('\n')).toBe(usage({ all: true }));
  });
});
