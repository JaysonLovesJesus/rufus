import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  FakeProvider,
  FileStore,
  DEFAULT_BUCKETS,
  analyzeHistory,
  createProviders,
  defineFlow,
  extractPairsFromMessages,
  formatExamples,
  loadPairs,
  mineHistory,
  pairHash,
  representativeSample,
  seedHistory,
  synthesizeHistory,
  type HistoryInput,
  type HistoryMessage,
  type HistoryPair,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

function capture() {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(`ERR ${l}`) } };
}

const msg = (id: string, sender: string, text: string, at: string, over: Partial<HistoryMessage> = {}): HistoryMessage => ({
  id,
  threadId: 't1',
  channel: 'chat',
  sender,
  isFromMe: sender === 'me',
  text,
  timestamp: at,
  ...over,
});

describe('extractPairsFromMessages', () => {
  it('turns a chronological chat into (incoming -> my reply) pairs, merging bursts and ignoring media', () => {
    const pairs = extractPairsFromMessages([
      msg('1', 'Sam Rivera', 'hey are you free thursday?', '2026-01-05T10:00:00Z'),
      msg('2', 'Sam Rivera', '[image]', '2026-01-05T10:00:20Z'),
      msg('3', 'Sam Rivera', 'maybe around 3pm', '2026-01-05T10:00:40Z'),
      msg('4', 'me', '   ', '2026-01-05T10:02:00Z'),
      msg('5', 'me', 'thursday 3pm works', '2026-01-05T10:05:00Z'),
      msg('6', 'me', 'see you then', '2026-01-05T10:05:30Z'),
      msg('7', 'Sam Rivera', '<Media omitted>', '2026-01-05T10:09:00Z'),
      msg('8', 'Sam Rivera', 'great', '2026-01-05T10:20:00Z'),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      channel: 'chat',
      threadId: 't1',
      sender: 'Sam Rivera',
      incoming: 'hey are you free thursday?\nmaybe around 3pm',
      reply: 'thursday 3pm works\nsee you then',
      incomingAt: '2026-01-05T10:00:00.000Z',
      replyAt: '2026-01-05T10:05:00.000Z',
      metadata: { incomingMessageIds: ['1', '3'], replyMessageIds: ['5', '6'] },
    });
    expect(pairs[0]!.id).toMatch(/^pair_[0-9a-f]{16}$/);
  });

  it('respects maxGapMs, drops unanswered messages and my unprompted ones, and honours selfIds', () => {
    const pairs = extractPairsFromMessages(
      [
        msg('1', 'me', 'unprompted hello', '2026-01-05T09:00:00Z'),
        msg('2', 'Alex Chen', 'quick question', '2026-01-05T10:00:00Z'),
        msg('3', 'me', 'much later answer', '2026-01-07T10:00:00Z'), // 2 days later: too late
        msg('4', 'Alex Chen', 'ping', '2026-01-07T11:00:00Z'),
        msg('5', 'u-42', 'on it', '2026-01-07T11:05:00Z', { isFromMe: false }), // my other account
        msg('6', 'Priya Patel', 'never answered', '2026-01-07T12:00:00Z'),
      ],
      { selfIds: ['u-42'], maxGapMs: 60 * 60 * 1000 },
    );
    expect(pairs.map((p) => [p.sender, p.incoming, p.reply])).toEqual([['Alex Chen', 'ping', 'on it']]);
  });

  it('keeps threads apart, sorts unordered input, splits a group chat by sender, and is deterministic', () => {
    const input = [
      msg('b2', 'me', 'b-reply', '2026-02-01T10:01:00Z', { threadId: 'tb' }),
      msg('a1', 'Sam Rivera', 'a-question', '2026-02-01T09:00:00Z', { threadId: 'ta' }),
      msg('b1', 'Alex Chen', 'b-question', '2026-02-01T10:00:00Z', { threadId: 'tb' }),
      msg('a2', 'me', 'a-reply', '2026-02-01T09:02:00Z', { threadId: 'ta' }),
      msg('g1', 'Sam Rivera', 'group one', '2026-02-02T10:00:00Z', { threadId: 'tg' }),
      msg('g2', 'Alex Chen', 'group two', '2026-02-02T10:00:30Z', { threadId: 'tg' }),
      msg('g3', 'me', 'group reply', '2026-02-02T10:01:00Z', { threadId: 'tg' }),
    ];
    const pairs = extractPairsFromMessages(input);
    expect(pairs.map((p) => `${p.threadId}:${p.sender}:${p.incoming}->${p.reply}`)).toEqual([
      'ta:Sam Rivera:a-question->a-reply',
      'tb:Alex Chen:b-question->b-reply',
      'tg:Alex Chen:group two->group reply',
    ]);
    expect(extractPairsFromMessages([...input].reverse()).map((p) => p.id)).toEqual(pairs.map((p) => p.id));
  });

  it('accepts epoch milliseconds and Date timestamps, and a burst gap that splits turns', () => {
    const t0 = Date.parse('2026-03-01T10:00:00Z');
    const pairs = extractPairsFromMessages(
      [
        msg('1', 'Sam Rivera', 'first', '', { timestamp: t0 }),
        msg('2', 'Sam Rivera', 'second, an hour later', '', { timestamp: new Date(t0 + 60 * 60 * 1000) }),
        msg('3', 'me', 'answer', '', { timestamp: t0 + 61 * 60 * 1000 }),
      ],
      { burstGapMs: 5 * 60 * 1000 },
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ incoming: 'second, an hour later', reply: 'answer' });
  });
});

/** A flow that drafts a short reply to a historical message. */
const replyFlow = (onCode?: () => void) =>
  defineFlow<HistoryInput>({ id: 'reply', name: 'Reply', description: 'Reply briefly', role: 'assistant' }, async (ctx) => {
    const facts = await ctx.code('facts', () => (onCode?.(), { words: ctx.input.incoming.split(/\s+/).length }));
    const draft = await ctx.ai('draft', {
      prompt: 'Reply to the message in at most 5 words.',
      context: { incoming: ctx.input.incoming, facts },
      verify: (t: string) => (t.trim().split(/\s+/).length <= 5 ? { ok: true } : { ok: false, reason: 'Use at most 5 words.' }),
    });
    await ctx.human('review', { title: 'Send?', summary: draft, options: ['Send'] });
    return draft;
  });

const pair = (n: number, over: Partial<HistoryPair> = {}): HistoryPair => ({
  id: `p${n}`,
  channel: 'chat',
  sender: n % 2 ? 'Sam Rivera' : 'Alex Chen',
  incoming: `message number ${n}?`,
  reply: n % 2 ? 'sounds good' : 'on my way now please wait for the long reply here today ok',
  incomingAt: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
  replyAt: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T10:30:00.000Z`,
  ...over,
});

const writeJsonl = (file: string, rows: unknown[]) => writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

describe('seedHistory (rufus seed)', () => {
  it('saves normalized pairs atomically, deduplicates by id and by content hash, and reports invalid records', async () => {
    const dir = await tempDir();
    const engine = new Engine({ store: dir, flows: [replyFlow()] });
    const file = path.join(dir, 'in.jsonl');
    const noId = { channel: 'sms', sender: 'Priya Patel', incoming: 'are we on?', reply: 'yes' };
    await writeJsonl(file, [pair(1), pair(2), pair(1), noId, { ...noId }, { incoming: 'no reply field' }, 'not an object']);
    await writeFile(file, (await readFile(file, 'utf8')) + 'garbage line\n');

    const r = await seedHistory(engine, file, { flowId: 'reply' });
    expect(r).toMatchObject({ read: 8, duplicatesInFile: 2, considered: 3, added: 3, casesAdded: 3, totalPairs: 3, alreadySeeded: 0 });
    expect(r.invalid.map((i) => i.reason)).toEqual(expect.arrayContaining(['missing "reply" text', 'not an object', 'not valid JSON']));

    const saved = await loadPairs(new FileStore(dir));
    expect(saved.map((p) => p.id)).toEqual(['p1', 'p2', pairHash({ channel: 'sms', sender: 'Priya Patel', incoming: 'are we on?', reply: 'yes' })]);
    expect((await readdir(path.join(dir, 'history'))).sort()).toEqual(['pairs.jsonl']); // no temp files left

    // Seeding the same file again changes nothing; a new pair adds only itself.
    await writeJsonl(file, [pair(1), pair(2), noId, pair(3)]);
    const again = await seedHistory(engine, file, { flowId: 'reply' });
    expect(again).toMatchObject({ added: 1, alreadySeeded: 3, casesAdded: 1, totalPairs: 4 });
    expect(await engine.cases.forFlow('reply')).toHaveLength(4);
    expect(await loadPairs(new FileStore(dir))).toHaveLength(4);
  });

  it('reads a JSON array, honours --limit (most recent N) and --dry-run, and rejects unknown flows or files', async () => {
    const dir = await tempDir();
    const engine = new Engine({ store: dir, flows: [replyFlow()] });
    const file = path.join(dir, 'in.json');
    await writeFile(file, JSON.stringify([pair(1), pair(2), pair(3), pair(4)]));

    const dry = await seedHistory(engine, file, { flowId: 'reply', dryRun: true, limit: 2 });
    expect(dry).toMatchObject({ dryRun: true, considered: 2, added: 2, casesAdded: 2, totalPairs: 0 });
    expect(await loadPairs(new FileStore(dir))).toEqual([]);
    expect(await engine.cases.forFlow('reply')).toEqual([]);

    await seedHistory(engine, file, { flowId: 'reply', limit: 2 });
    expect((await loadPairs(new FileStore(dir))).map((p) => p.id)).toEqual(['p3', 'p4']);

    await expect(seedHistory(engine, file, { flowId: 'nope' })).rejects.toThrow(/not registered/);
    await expect(seedHistory(engine, path.join(dir, 'missing.json'), { flowId: 'reply' })).rejects.toThrow(/No such file/);
    await expect(seedHistory(engine, file, { flowId: 'reply', limit: 0 })).rejects.toThrow(/positive/);
  });

  it('seeded cases replay and compare on Day 1: real input, real code step, human reply as the "before"', async () => {
    const dir = await tempDir();
    let codeRuns = 0;
    const flow = replyFlow(() => void codeRuns++);
    const provider = new FakeProvider((req) => (req.messages.length > 1 ? 'Sounds good' : 'Yes that sounds good to me for sure'));
    const engine = new Engine({ store: dir, provider, flows: [flow] });
    const file = path.join(dir, 'in.jsonl');
    await writeJsonl(file, [pair(1), pair(2), pair(3)]);
    await seedHistory(engine, file, { flowId: 'reply' });

    const [first] = await engine.cases.forFlow('reply');
    expect(first).toMatchObject({ seeded: true, stepKey: 'ai:draft', stepName: 'draft', edited: true, humanText: 'sounds good', aiDraft: null });
    expect(first!.input).toMatchObject({ channel: 'chat', sender: 'Sam Rivera', incoming: 'message number 1?' });

    const report = await engine.replay('reply');
    expect(report).toMatchObject({ total: 3, passed: 3, failed: 0, skipped: 0 });
    // The ai step saw the real incoming message and the code step's output, and was retried once to pass verify.
    expect(provider.calls[0]!.messages[0]!.content).toContain('message number 1?');
    expect(provider.calls[0]!.messages[0]!.content).toContain('"words": 3');
    expect(report.results[0]).toMatchObject({ attempts: 2 });
    // "before": did the human's real reply pass today's verify? pair(2)'s 12-word reply did not.
    expect(report.results.map((r) => r.before)).toEqual(['passed', 'failed', 'passed']);
    expect(report.results.map((r) => r.change)).toEqual(['unchanged', 'improved', 'unchanged']);
    expect(codeRuns).toBe(3); // seeded cases run the flow's code on the historical input, once per case

    // Real history also teaches: it shows up as examples in later prompts.
    const examples = provider.calls.at(-1)!.system;
    expect(examples).toContain('Human replied: "sounds good"');
    expect(examples).not.toContain('Draft:');

    const cmp = await new Engine({ store: dir, provider: new FakeProvider((req) => (req.messages.length > 1 ? 'Sounds good' : 'Sounds good')), flows: [flow] }).compare('reply');
    expect(cmp).toMatchObject({ total: 3, plain: { passed: 3 }, assisted: { passed: 3 }, delta: 0 });
  });

  it('says how to fix the step name when the flow has no such ai step', async () => {
    const dir = await tempDir();
    const engine = new Engine({ store: dir, provider: new FakeProvider(['x']), flows: [replyFlow()] });
    const file = path.join(dir, 'in.jsonl');
    await writeJsonl(file, [pair(1)]);
    await seedHistory(engine, file, { flowId: 'reply', step: 'write-reply' });
    const report = await engine.replay('reply');
    expect(report).toMatchObject({ total: 1, skipped: 1 });
    expect(report.results[0]!.reason).toMatch(/Seed with --step/);
  });

  it('formatExamples shows seeded cases as real replies', () => {
    const c = { id: 'c', flowId: 'f', runId: 'r', at: 'a', input: { incoming: 'hi' }, stepKey: 'ai:draft', stepName: 'draft', aiDraft: null, humanChoice: null, humanText: 'hello', edited: true, seeded: true as const };
    expect(formatExamples([c])).toContain('Human replied: "hello"');
  });
});

/** 20 pairs with exactly known numbers. */
function voicePairs(): HistoryPair[] {
  const rows: Array<[string, string, string?]> = [
    ...Array.from({ length: 10 }, (_, i) => [`can we meet tomorrow at ${i + 1}pm?`, 'sounds good'] as [string, string]), // 10 scheduling, 2 words
    ...Array.from({ length: 4 }, () => ['please confirm the booking', 'yep all confirmed'] as [string, string]), // 4 confirmation, 3 words
    ...Array.from({ length: 2 }, () => ['any update on this?', 'working on it now'] as [string, string]), // 2 follow-up, 4 words
    ...Array.from({ length: 2 }, () => ["what's the address?", 'sending it over soon'] as [string, string]), // 2 logistics, 4 words
    ['do you like pizza?', 'always down for pizza yes'], // 1 question, 5 words... 
    ['thanks so much', `${'ok '.repeat(29)}fine.`], // 1 other, 30 words, trailing period
  ];
  return rows.map(([incoming, reply], i) => ({
    id: `v${i}`,
    channel: i < 15 ? 'sms' : 'email',
    sender: i < 8 ? 'Sam Rivera' : i < 14 ? 'Alex Chen' : 'Priya Patel',
    incoming,
    reply,
  }));
}

describe('analyzeHistory: deterministic, offline, exact', () => {
  const a = analyzeHistory(voicePairs());

  it('counts volume by channel and top contacts', () => {
    expect(a.total).toBe(20);
    expect(a.byChannel).toEqual([
      { channel: 'sms', count: 15, pct: 75 },
      { channel: 'email', count: 5, pct: 25 },
    ]);
    expect(a.topContacts.map((c) => [c.sender, c.count])).toEqual([['Sam Rivera', 8], ['Alex Chen', 6], ['Priya Patel', 6]]);
  });

  it('fingerprints the voice with exact numbers', () => {
    expect(a.voice.replies).toBe(20);
    expect(a.voice.words).toEqual({ median: 2.5, p90: 4, max: 30 });
    expect(a.voice.shortReplies).toEqual({ count: 19, pct: 95 });
    expect(a.voice.lowercaseStart).toEqual({ count: 20, pct: 100 });
    expect(a.voice.trailingPeriod).toEqual({ count: 1, pct: 5 });
    expect(a.voice.emDashes.total).toBe(0);
    expect(a.voice.exclamation.count).toBe(0);
    expect(a.voice.greetings.rate.count).toBe(0);
    expect(a.voice.signOffs.rate.count).toBe(0);
  });

  it('derives candidate rules straight from the numbers, each with its exact support', () => {
    const byId = Object.fromEntries(a.rules.map((r) => [r.id, r]));
    expect(byId['short-replies']).toMatchObject({ layer: 'principle', support: { count: 19, of: 20 } });
    expect(byId['word-cap']).toMatchObject({ layer: 'code', rule: 'Keep replies to at most 5 words.', support: { count: 19, of: 20 } });
    expect(byId['no-em-dash']).toMatchObject({ layer: 'code', support: { count: 20, of: 20 } });
    expect(byId['no-trailing-period']).toMatchObject({ layer: 'code', support: { count: 19, of: 20 } });
    expect(byId['lowercase-start']).toMatchObject({ layer: 'code', support: { count: 20, of: 20 } });
    expect(byId['no-greeting'].layer).toBe('principle');
    expect(byId['no-em-dash']!.evidence).toBe('20 of 20 replies (100%): no em dash');
  });

  it('proposes nothing it cannot back: a rule needs the share, and enough pairs', () => {
    const mixed = voicePairs().map((p, i) => (i % 2 ? { ...p, reply: `Okay — sure!` } : p));
    const m = analyzeHistory(mixed);
    expect(m.voice.emDashes).toMatchObject({ total: 10, repliesWith: { count: 10, pct: 50 } });
    expect(m.rules.map((r) => r.id)).not.toContain('no-em-dash');
    expect(m.rules.map((r) => r.id)).not.toContain('no-exclamation');

    const few = analyzeHistory(voicePairs().slice(0, 5));
    expect(few.rules).toEqual([]);
    expect(few.notes[0]).toMatch(/at least 10 are needed/);
    expect(analyzeHistory(voicePairs().slice(0, 5), { minPairs: 3 }).rules.length).toBeGreaterThan(0);
  });

  it('detects greetings, sign-offs, em dashes and lowercase style', () => {
    const v = analyzeHistory([
      { id: '1', channel: 'c', sender: 's', incoming: 'x', reply: 'Hey Sam, yes. Thanks!' },
      { id: '2', channel: 'c', sender: 's', incoming: 'x', reply: 'hey there — yep, thanks' },
      { id: '3', channel: 'c', sender: 's', incoming: 'x', reply: 'Good morning, cheers' },
    ]).voice;
    expect(v.greetings).toMatchObject({ rate: { count: 3 }, top: [{ text: 'hey', count: 2 }, { text: 'good morning', count: 1 }] });
    expect(v.signOffs.rate.count).toBe(3);
    expect(v.emDashes).toMatchObject({ total: 1, repliesWith: { count: 1 } });
    expect(v.lowercaseStart.count).toBe(1);
    expect(v.exclamation.count).toBe(1);
  });

  it('clusters by channel + intent with exact counts, medians and samples; counts add up to the total', () => {
    expect(a.intents).toEqual([
      { bucket: 'scheduling', label: 'Scheduling', count: 10, pct: 50 },
      { bucket: 'confirmation', label: 'Confirmations', count: 4, pct: 20 },
      { bucket: 'follow-up', label: 'Follow-ups', count: 2, pct: 10 },
      { bucket: 'logistics', label: 'Logistics', count: 2, pct: 10 },
      { bucket: 'other', label: 'Everything else', count: 1, pct: 5 },
      { bucket: 'question', label: 'Questions', count: 1, pct: 5 },
    ]);
    expect(a.clusters.reduce((n, c) => n + c.count, 0)).toBe(20);
    const sched = a.clusters.find((c) => c.bucket === 'scheduling')!;
    expect(sched).toMatchObject({ channel: 'sms', count: 10, medianReplyWords: 2 });
    expect(sched.samples).toHaveLength(3);
    expect(sched.samples[0]).toMatchObject({ reply: 'sounds good' });
  });

  it('takes custom buckets (first match wins)', () => {
    const c = analyzeHistory(voicePairs(), { buckets: [{ id: 'pizza', label: 'Pizza talk', pattern: /pizza/i }] });
    expect(c.intents).toEqual([
      { bucket: 'other', label: 'Everything else', count: 19, pct: 95 },
      { bucket: 'pizza', label: 'Pizza talk', count: 1, pct: 5 },
    ]);
  });

  it('handles an empty history', () => {
    const e = analyzeHistory([]);
    expect(e).toMatchObject({ total: 0, rules: [], clusters: [], byChannel: [] });
  });
});

const SYNTH = JSON.stringify({
  blueprints: [
    { name: 'Scheduling replies', frequency: '10 of 20 messages (50%)', trigger: 'a message mentioning a time', code: 'look up free slots', ai: 'phrase the confirmation', human: 'approve before sending' },
  ],
  lessons: [
    { rule: 'Keep replies to at most 5 words.', layer: 'code', support: '19/20 replies' },
    { rule: 'Include my free slots when someone asks for a time.', layer: 'context' },
    { rule: 'Sound relaxed.', layer: 'principle' },
  ],
});

describe('mine --ai (synthesis)', () => {
  it('sends code-assembled stats and a small sample, never names or the whole history', async () => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    const many = Array.from({ length: 60 }, (_, i) => ({ ...voicePairs()[i % 20]!, id: `m${i}` }));
    await store.writeText(store.pairsFile, many.map((p) => JSON.stringify(p)).join('\n') + '\n');
    const smart = new FakeProvider([SYNTH]);
    const engine = new Engine({ store, providers: { smart } });

    const report = await mineHistory(engine, { ai: true, provider: 'smart', sampleSize: 8 });
    expect(report.pairsAnalyzed).toBe(60);
    expect(report.ai).toMatchObject({ provider: 'smart', attempts: 1 });
    expect(report.ai!.blueprints[0]).toMatchObject({ name: 'Scheduling replies', human: 'approve before sending' });
    expect(report.ai!.lessons.map((l) => l.layer)).toEqual(['code', 'context', 'principle']);

    expect(smart.calls).toHaveLength(1);
    const sent = smart.calls[0]!.messages[0]!.content;
    expect(sent).toContain('"totalPairs": 60');
    expect(sent).toContain('"no-em-dash"');
    expect(sent).not.toContain('Sam Rivera'); // names withheld
    expect(sent).not.toContain('Alex Chen');
    const sample = JSON.parse(/"sample": (\[[\s\S]*?\n {2}\])/.exec(sent)![1]!) as unknown[];
    expect(sample).toHaveLength(8); // capped, nowhere near all 60
  });

  it('retries once on malformed output, accepts fenced JSON, and validates layers', async () => {
    const pairs = voicePairs();
    const bad = new FakeProvider(['not json at all', `Here you go:\n\`\`\`json\n${SYNTH}\n\`\`\``]);
    const ok = await synthesizeHistory(bad, analyzeHistory(pairs), pairs);
    expect(ok.attempts).toBe(2);
    expect(bad.calls[1]!.messages.at(-1)!.content).toMatch(/failed an automatic check: Could not parse the output: no JSON object found/);

    const wrongLayer = JSON.stringify({ blueprints: [], lessons: [{ rule: 'x', layer: 'vibes' }] });
    const never = new FakeProvider([wrongLayer, wrongLayer, wrongLayer]);
    await expect(synthesizeHistory(never, analyzeHistory(pairs), pairs)).rejects.toThrow(/layer must be one of: code, context, principle/);
  });

  it('is off by default (offline, no provider call), and an unknown provider name fails clearly', async () => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    await store.writeText(store.pairsFile, voicePairs().map((p) => JSON.stringify(p)).join('\n') + '\n');
    const fake = new FakeProvider([SYNTH]);
    const engine = new Engine({ store, provider: fake });
    const offline = await mineHistory(engine);
    expect(offline.ai).toBeUndefined();
    expect(offline.analysis.total).toBe(20);
    expect(fake.calls).toHaveLength(0);
    await expect(mineHistory(engine, { ai: true, provider: 'smart' })).rejects.toThrow(/Unknown AI provider "smart"/);
    expect((await mineHistory(engine, { limit: 5 })).pairsAnalyzed).toBe(5);
  });

  it('picks a representative sample: every big intent shows up, evenly, within the cap', () => {
    const pairs = voicePairs();
    const s = representativeSample(pairs, DEFAULT_BUCKETS, 6);
    expect(s).toHaveLength(6);
    expect(new Set(s.map((x) => x.intent))).toEqual(new Set(['scheduling', 'confirmation', 'follow-up', 'logistics', 'other', 'question']));
    expect(s.every((x) => !('sender' in x))).toBe(true);
    expect(representativeSample(pairs, DEFAULT_BUCKETS, 500)).toHaveLength(20);
  });
});

describe('fast / smart model tiers', () => {
  it('routes phrasing to "fast" and judgment to "smart" from config.json, and createProviders builds both', async () => {
    const dir = await tempDir();
    const cfg = {
      version: 1,
      provider: { type: 'command', command: 'echo', args: ['default'] },
      providers: {
        fast: { type: 'openai-compatible', baseUrl: 'http://localhost:1/v1', model: 'haiku-like' },
        smart: { type: 'command', command: 'echo', args: ['smart'] },
      },
    };
    const built = createProviders(cfg as never);
    expect(Object.keys(built.providers).sort()).toEqual(['fast', 'smart']);

    const fast = new FakeProvider(['fast phrasing']);
    const smart = new FakeProvider(['smart judgment']);
    const flow = defineFlow({ id: 'tiers', name: 'Tiers', description: 'two tiers' }, async (ctx) => {
      const decision = await ctx.ai('decide', { prompt: 'Decide.', provider: 'smart' });
      const text = await ctx.ai('phrase', { prompt: 'Phrase it.', provider: 'fast' });
      return { decision, text };
    });
    const engine = new Engine({ store: dir, providers: { fast, smart }, flows: [flow] });
    expect(await engine.start('tiers')).toMatchObject({ status: 'completed', output: { decision: 'smart judgment', text: 'fast phrasing' } });
    expect(smart.calls.map((c) => c.meta.step)).toEqual(['decide']);
    expect(fast.calls.map((c) => c.meta.step)).toEqual(['phrase']);
  });

  it('replay and compare take --provider to try a cheaper tier on the same cases', async () => {
    const dir = await tempDir();
    const smart = new FakeProvider(() => 'Sounds good');
    const fast = new FakeProvider(() => 'Sounds good');
    const flow = defineFlow<HistoryInput>({ id: 'reply', name: 'Reply', description: 'r', provider: 'smart' }, async (ctx) => {
      const draft = await ctx.ai('draft', { prompt: 'Reply.', context: { m: ctx.input.incoming } });
      await ctx.human('review', { title: 't', summary: draft, options: ['Send'] });
    });
    const engine = new Engine({ store: dir, providers: { smart, fast }, flows: [flow] });
    const file = path.join(dir, 'in.jsonl');
    await writeJsonl(file, [pair(1), pair(2)]);
    await seedHistory(engine, file, { flowId: 'reply' });

    await engine.replay('reply');
    expect([smart.calls.length, fast.calls.length]).toEqual([2, 0]);
    await engine.replay('reply', { provider: 'fast' });
    expect([smart.calls.length, fast.calls.length]).toEqual([2, 2]);
    await engine.compare('reply', { provider: 'fast' });
    expect([smart.calls.length, fast.calls.length]).toEqual([2, 6]); // plain + assisted per case
  });
});

describe('rufus seed / mine (CLI)', () => {
  it('parses seed arguments and validates them', async () => {
    const dir = await tempDir();
    const c = capture();
    await expect(main(['--dir', dir, 'seed'], c.io)).rejects.toThrow(/Usage: rufus seed <file/);
    await expect(main(['--dir', dir, 'seed', 'x.jsonl'], c.io)).rejects.toThrow(/Usage: rufus seed/);
    await expect(main(['--dir', dir, 'seed', 'x.jsonl', '--flow', 'triage-draft', '--limit', '0'], c.io)).rejects.toThrow(/positive number/);
    await expect(main(['--dir', dir, 'seed', path.join(dir, 'nope.jsonl'), '--flow', 'triage-draft'], c.io)).rejects.toThrow(/No such file/);
    await expect(main(['--dir', dir, 'seed', 'x.jsonl', '--flow'], c.io)).rejects.toThrow(/--flow needs a value/);
    await expect(main(['--dir', dir, 'seed', 'x.jsonl', '--flow', 'ghost'], c.io)).rejects.toThrow(/not registered/);
  });

  it('seed --dry-run writes nothing; seed then mine works offline end to end', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'history.jsonl');
    await writeJsonl(file, voicePairs());

    const dry = capture();
    await main(['--dir', dir, 'seed', file, '--flow', 'triage-draft', '--step', 'draft', '--dry-run'], dry.io);
    expect(dry.lines[0]).toBe('Dry run: would add 20 new pair(s) and 20 replay case(s) for "triage-draft" (step "draft"). Nothing was written.');
    await expect(readFile(path.join(dir, 'history', 'pairs.jsonl'), 'utf8')).rejects.toThrow();

    const seeded = capture();
    await main(['--dir', dir, 'seed', file, '--flow', 'triage-draft', '--limit', '16'], seeded.io);
    expect(seeded.lines[0]).toBe('Seeded "triage-draft": 16 new pair(s) saved, 16 replay case(s) added (step "draft"). 16 pair(s) in history.');
    expect(seeded.lines.join('\n')).toContain('Next: rufus replay triage-draft');

    const mined = capture();
    await main(['--dir', dir, 'mine', '--save'], mined.io);
    const text = mined.lines.join('\n');
    expect(text).toContain('16 real reply pair(s)');
    expect(text).toContain('How you write:');
    expect(text).toContain('Scheduling: 6 (37.5%)');
    expect(text).toContain('[code] Do not use em dashes.  (16/16)');
    expect(text).toContain('Add --ai for workflow blueprints');
    expect(text).toContain(`Saved ${path.join(dir, 'history', 'mine-report.json')}`);
    const saved = JSON.parse(await readFile(path.join(dir, 'history', 'mine-report.json'), 'utf8'));
    expect(saved.analysis.total).toBe(16);
  });

  it('mine --json prints the report; mine on an empty workspace points at seed', async () => {
    const dir = await tempDir();
    const none = capture();
    await main(['--dir', dir, 'mine'], none.io);
    expect(none.lines).toEqual(['No history yet. Run: rufus seed <file> --flow <flowId>']);

    await new FileStore(dir).writeText(path.join(dir, 'history', 'pairs.jsonl'), voicePairs().map((p) => JSON.stringify(p)).join('\n') + '\n');
    const j = capture();
    await main(['--dir', dir, 'mine', '--json', '--limit', '10'], j.io);
    const report = JSON.parse(j.lines.join('\n'));
    expect(report.pairsAnalyzed).toBe(10);
    expect(report.ai).toBeUndefined();
  });

  it('mine --ai uses --provider, else "smart" if configured; rejects unknown providers and --provider without --ai', async () => {
    const dir = await tempDir();
    await new FileStore(dir).writeText(path.join(dir, 'history', 'pairs.jsonl'), voicePairs().map((p) => JSON.stringify(p)).join('\n') + '\n');
    // A tiny "model" on the command provider, answering the mine prompt with fixed JSON.
    const script = (tag: string) => `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify({ ...JSON.parse(SYNTH), blueprints: [{ ...JSON.parse(SYNTH).blueprints[0], name: tag }] }))}))`;
    const cmd = (tag: string) => ({ type: 'command', command: process.execPath, args: ['-e', script(tag)] });
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, provider: cmd('from-default'), providers: { fast: cmd('from-fast'), smart: cmd('from-smart') } }));

    const smartRun = capture();
    await main(['--dir', dir, 'mine', '--ai'], smartRun.io);
    const text = smartRun.lines.join('\n');
    expect(text).toContain('Workflow blueprints (AI, smart provider):');
    expect(text).toContain('1. from-smart (10 of 20 messages (50%))');
    expect(text).toContain("rufus propose 'global' 'Keep replies to at most 5 words.' --layer code");
    expect(text).toContain("--layer context");

    const fastRun = capture();
    await main(['--dir', dir, 'mine', '--ai', '--provider', 'fast', '--scope', 'flow:inbox'], fastRun.io);
    expect(fastRun.lines.join('\n')).toContain('1. from-fast');
    expect(fastRun.lines.join('\n')).toContain("rufus propose 'flow:inbox' ");

    await expect(main(['--dir', dir, 'mine', '--ai', '--provider', 'ghost'], capture().io)).rejects.toThrow(/Unknown AI provider "ghost". Configured: fast, smart/);
    await expect(main(['--dir', dir, 'mine', '--provider', 'fast'], capture().io)).rejects.toThrow(/only applies with --ai/);
    await expect(main(['--dir', dir, 'compare', 'triage-draft', '--provider', 'ghost'], capture().io)).rejects.toThrow(/Unknown AI provider "ghost"/);
  });

  it('config.mine buckets and thresholds are honoured', async () => {
    const dir = await tempDir();
    await new FileStore(dir).writeText(path.join(dir, 'history', 'pairs.jsonl'), voicePairs().map((p) => JSON.stringify(p)).join('\n') + '\n');
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, mine: { buckets: [{ id: 'pizza', label: 'Pizza talk', pattern: 'PIZZA' }], minShare: 1 } }));
    const c = capture();
    await main(['--dir', dir, 'mine'], c.io);
    const text = c.lines.join('\n');
    expect(text).toContain('Pizza talk: 1 (5%)');
    expect(text).not.toContain('Keep replies to at most'); // 19/20 < 100%
    expect(text).toContain('[code] Do not use em dashes.');
  });
});
