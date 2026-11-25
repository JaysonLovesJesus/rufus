import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CausalityError,
  FakeProvider,
  FileStore,
  backtest,
  causalSnapshot,
  formatBacktest,
  knownMs,
  localEmbed,
  momentMs,
  pickEvenly,
  scoreMoment,
  tokenF1,
  toneAgreement,
  wordDiff,
  type BacktestReport,
  type CorpusItem,
  type EmbeddingLookup,
  type HistoryPair,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const DAY = 86_400_000;
const T0 = Date.parse('2025-01-01T10:00:00Z');
const at = (day: number, minutes = 0): string => new Date(T0 + day * DAY + minutes * 60_000).toISOString();

const TOPICS: Array<[string, string]> = [
  ['hey are we still on for the meeting tomorrow at 3?', 'yep 3 works'],
  ['can you send me the invoice for march', 'sending it now'],
  ['what time does the call start', '3pm'],
  ['did you see the parking directions i sent', 'yes thanks'],
  ['can we reschedule the meeting to friday', 'friday works for me'],
  ['hello! could you review the proposal draft when you get a chance?', 'Hello, will do by Thursday. Thank you!'],
];

/** A deterministic history: one exchange per day, answered ten minutes later, alternating contacts and channels. */
function history(n: number): HistoryPair[] {
  return Array.from({ length: n }, (_, i) => {
    const [incoming, reply] = TOPICS[i % TOPICS.length]!;
    return {
      id: `p${String(i).padStart(2, '0')}`,
      channel: i % 3 === 0 ? 'email' : 'sms',
      sender: i % 2 ? 'Alex' : 'Sam',
      incoming,
      reply,
      incomingAt: at(i),
      replyAt: at(i, 10),
    };
  });
}

const corpusItem = (id: string, day: number, summary: string, extra: Partial<CorpusItem> = {}): CorpusItem => ({ id, source: 'file', kind: 'note', title: id, summary, timestamp: at(day, 5), ...extra });

const byId = (r: BacktestReport, id: string) => r.moments.find((m) => m.id === id);

describe('causalSnapshot: strictly before T', () => {
  it('keeps only pairs whose whole exchange was known before T, and drops the moment itself', () => {
    const t = Date.parse(at(5));
    const pairs: HistoryPair[] = [
      ...history(8), // p00..p04 are fully known before day 5; p05 starts exactly at T; p06, p07 are later
      { id: 'slow', channel: 'sms', sender: 'Sam', incoming: 'old question', reply: 'late answer', incomingAt: at(2), replyAt: at(5, 1) }, // asked before T, answered after: the reply is future
      { id: 'untimed', channel: 'sms', sender: 'Sam', incoming: 'when', reply: 'who knows' },
    ];
    const snap = causalSnapshot(t, pairs, [], 'p05');
    expect(snap.pairs.map((p) => p.id)).toEqual(['p00', 'p01', 'p02', 'p03', 'p04']);
    expect(snap.pairs.every((p) => knownMs(p)! < t)).toBe(true);
  });

  it('is strict at the boundary: an item at exactly T is not visible, one millisecond earlier is', () => {
    const t = Date.parse(at(3));
    const early: HistoryPair = { id: 'early', channel: 'sms', sender: 'Sam', incoming: 'a', reply: 'b', incomingAt: new Date(t - 2).toISOString(), replyAt: new Date(t - 1).toISOString() };
    const exact: HistoryPair = { id: 'exact', channel: 'sms', sender: 'Sam', incoming: 'c', reply: 'd', incomingAt: new Date(t - 5).toISOString(), replyAt: new Date(t).toISOString() };
    const items = [corpusItem('before', 0, 'x', { timestamp: new Date(t - 1).toISOString() }), corpusItem('at', 0, 'y', { timestamp: new Date(t).toISOString() }), corpusItem('after', 0, 'z', { timestamp: new Date(t + 1).toISOString() })];
    const snap = causalSnapshot(t, [early, exact], items);
    expect(snap.pairs.map((p) => p.id)).toEqual(['early']);
    expect(snap.corpus.map((c) => c.id)).toEqual(['before']);
  });

  it('drops corpus items it cannot date, and chat exchanges that merely repeat pairs with their reply text', () => {
    const t = Date.parse(at(9));
    const chat = corpusItem('chat1', 1, 'Sam: hi → hello', { source: 'chat', kind: 'exchange' });
    const bad = { ...corpusItem('bad', 1, 'x'), timestamp: 'not a date' };
    const snap = causalSnapshot(t, [], [chat, bad, corpusItem('ok', 1, 'fine')]);
    expect(snap.corpus.map((c) => c.id)).toEqual(['ok']);
  });

  it('timestamps: a moment is when the message arrived; a pair becomes history when it was answered', () => {
    expect(momentMs({ incomingAt: at(1), replyAt: at(2) })).toBe(Date.parse(at(1)));
    expect(momentMs({ replyAt: at(2) })).toBe(Date.parse(at(2)));
    expect(knownMs({ incomingAt: at(1), replyAt: at(2) })).toBe(Date.parse(at(2)));
    expect(momentMs({})).toBeUndefined();
  });
});

describe('backtest: zero future leakage', () => {
  it('a moment is predicted identically with or without anything that happened after it', async () => {
    const pairs = history(24);
    const corpus = [corpusItem('n-early', 2, 'meeting notes about the proposal'), corpusItem('n-mid', 9, 'invoice march parking'), corpusItem('n-late', 20, 'meeting reschedule friday')];
    const full = await backtest({ pairs, corpus, count: 1000, minHistory: 3, topK: 3, recent: 2 });
    expect(full.evaluated).toBe(21);

    for (const m of full.moments.filter((x) => [3, 8, 14, 20].includes(Number(x.id.slice(1))))) {
      const t = Date.parse(m.at);
      // The world as it was at T, plus the moment itself, and nothing else.
      const cut = await backtest({
        pairs: pairs.filter((p) => p.id === m.id || (knownMs(p) ?? Infinity) < t),
        corpus: corpus.filter((c) => Date.parse(c.timestamp) < t),
        count: 1000,
        minHistory: 3,
        topK: 3,
        recent: 2,
      });
      const twin = byId(cut, m.id)!;
      expect(twin, m.id).toBeDefined();
      expect(twin.prediction).toEqual(m.prediction);
      expect(twin.examples).toEqual(m.examples);
      expect(twin.corpusHits).toEqual(m.corpusHits);
      expect(twin.codeCall).toEqual(m.codeCall);
      expect(twin.history).toEqual(m.history);
      expect(twin.scores).toEqual(m.scores);
    }
  });

  it('a future twin of the question, with a unique future reply, is never retrieved or predicted (offline)', async () => {
    const pairs = [
      ...history(12),
      // After every moment above: the same question, answered with a marker that must never surface.
      { id: 'future', channel: 'sms', sender: 'Sam', incoming: TOPICS[0]![0], reply: 'ZZ-FUTURE-ZZ', incomingAt: at(40), replyAt: at(40, 3) },
    ];
    const corpus = [corpusItem('future-note', 41, 'ZZ-FUTURE-ZZ meeting tomorrow at 3 still on')];
    const r = await backtest({ pairs, corpus, count: 1000, minHistory: 3 });
    expect(r.moments.length).toBeGreaterThan(5);
    for (const m of r.moments.filter((x) => x.id !== 'future')) {
      expect(JSON.stringify(m)).not.toContain('ZZ-FUTURE-ZZ');
      expect(m.examples.map((e) => e.id)).not.toContain('future');
      expect(m.corpusHits.map((h) => h.id)).not.toContain('future-note');
      for (const e of m.examples) expect(Date.parse(e.at)).toBeLessThan(Date.parse(m.at));
      for (const h of m.corpusHits) expect(Date.parse(h.at)).toBeLessThan(Date.parse(m.at));
      expect(m.history.pairs).toBe(pairs.filter((p) => p.id !== 'future' && (knownMs(p) ?? Infinity) < Date.parse(m.at)).length);
    }
    // The last moment's own prediction cannot see itself either (its answer is the "actual").
    const last = r.moments.find((x) => x.id === 'future')!;
    expect(last.examples.length).toBeGreaterThan(0);
    expect(last.prediction.text).not.toBe('ZZ-FUTURE-ZZ');
  });

  it('AI mode: no prompt ever contains a future pair, a future corpus item, or the answer being predicted', async () => {
    const pairs = [
      ...history(14),
      { id: 'future', channel: 'sms', sender: 'Sam', incoming: TOPICS[0]![0], reply: 'ZZ-FUTURE-ZZ', incomingAt: at(40), replyAt: at(40, 3) },
    ];
    pairs[9] = { ...pairs[9]!, reply: 'UNIQUE-ANSWER-9' };
    const corpus = [corpusItem('past-note', 2, 'the proposal draft and the meeting'), corpusItem('future-note', 41, 'ZZ-FUTURE-ZZ meeting')];
    const provider = new FakeProvider(() => 'on it');
    const r = await backtest({ pairs, corpus, count: 1000, minHistory: 3, mode: 'ai', provider, providerName: 'smart' });

    expect(provider.calls).toHaveLength(r.evaluated);
    const moment9 = r.moments.find((m) => m.id === 'p09')!;
    for (const [i, call] of provider.calls.entries()) {
      const text = `${call.system}\n${call.messages.map((m) => m.content).join('\n')}`;
      expect(text, `call ${i}`).not.toContain('ZZ-FUTURE-ZZ');
      if (r.moments[i]!.id === 'p09') expect(text).not.toContain('UNIQUE-ANSWER-9');
      expect(text).toContain(`It is ${r.moments[i]!.at}`);
    }
    // Later moments may legitimately learn from p09 once it has happened.
    const later = provider.calls[r.moments.findIndex((m) => m.id === 'p11')]!;
    expect(`${later.messages[0]!.content}`).toContain('UNIQUE-ANSWER-9');
    expect(moment9.prediction).toMatchObject({ text: 'on it', basis: 'ai' });
  });

  it('a vector cache that already holds vectors for future items still cannot surface them', async () => {
    const pairs = [
      ...history(10),
      { id: 'future', channel: 'sms', sender: 'Sam', incoming: TOPICS[1]![0], reply: 'ZZ-FUTURE-ZZ', incomingAt: at(60), replyAt: at(60, 1) },
    ];
    const vectors = new Map<string, number[]>(pairs.map((p) => [`pair:${p.id}`, localEmbed(p.incoming)]));
    const embeddings = async (text: string): Promise<EmbeddingLookup> => ({ model: 'local', query: localEmbed(text), vector: (id) => vectors.get(id) });
    const r = await backtest({ pairs, count: 1000, minHistory: 3, embeddings });
    for (const m of r.moments.filter((x) => x.id !== 'future')) {
      expect(m.examples.map((e) => e.id)).not.toContain('future');
      expect(m.prediction.text).not.toBe('ZZ-FUTURE-ZZ');
    }
  });

  it('two exchanges at the same instant, or one answered after the other began, cannot see each other', async () => {
    const same = (id: string, incoming: string, reply: string): HistoryPair => ({ id, channel: 'sms', sender: 'Sam', incoming, reply, incomingAt: at(5), replyAt: at(5, 5) });
    const pairs = [...history(5), same('twinA', 'can we reschedule', 'AAA-REPLY'), same('twinB', 'can we reschedule', 'BBB-REPLY')];
    const r = await backtest({ pairs, count: 1000, minHistory: 3 });
    const a = byId(r, 'twinA')!;
    const b = byId(r, 'twinB')!;
    expect(a.examples.map((e) => e.id)).not.toContain('twinB');
    expect(b.examples.map((e) => e.id)).not.toContain('twinA');
    expect(a.prediction.text).not.toBe('BBB-REPLY');
    expect(b.prediction.text).not.toBe('AAA-REPLY');
  });

  it('prior messages stamped at or after the moment are dropped from its situation', async () => {
    const pairs = history(8);
    pairs[6] = { ...pairs[6]!, isGroup: false, priorMessages: [{ sender: 'Alex', isFromMe: false, text: 'EARLIER-OK', timestamp: at(6, -30) }, { sender: 'Alex', isFromMe: false, text: 'LEAKED-LATER', timestamp: at(6, 30) }] };
    const provider = new FakeProvider(() => 'ok');
    const r = await backtest({ pairs, count: 1000, minHistory: 3, mode: 'ai', provider });
    const call = provider.calls[r.moments.findIndex((m) => m.id === 'p06')]!;
    expect(call.messages[0]!.content).toContain('EARLIER-OK');
    expect(call.messages[0]!.content).not.toContain('LEAKED-LATER');
  });

  it('reports the strict check it ran, and CausalityError exists for the day it ever fails', async () => {
    const r = await backtest({ pairs: history(10), count: 3, minHistory: 3 });
    expect(r.causality).toMatchObject({ strict: true, violations: 0 });
    expect(r.causality.itemsChecked).toBeGreaterThan(0);
    expect(new CausalityError('x').name).toBe('CausalityError');
  });
});

describe('backtest: choosing moments', () => {
  it('spreads N moments evenly across the timeline, in order, or takes the newest N', async () => {
    expect(pickEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toEqual([2, 4, 6, 8, 10]);
    expect(pickEvenly([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(pickEvenly([1, 2, 3, 4, 5], 2, 'latest')).toEqual([4, 5]);
    const spread = await backtest({ pairs: history(30), count: 5, minHistory: 3 });
    expect(spread.moments).toHaveLength(5);
    expect(spread.moments.map((m) => m.at)).toEqual([...spread.moments.map((m) => m.at)].sort());
    const latest = await backtest({ pairs: history(30), count: 3, minHistory: 3, pick: 'latest' });
    expect(latest.moments.map((m) => m.id)).toEqual(['p27', 'p28', 'p29']);
  });

  it('is deterministic: the same data gives the same report', async () => {
    const a = await backtest({ pairs: history(20), count: 6 });
    const b = await backtest({ pairs: [...history(20)].reverse(), count: 6 });
    expect(b).toEqual(a);
  });

  it('--channel limits which moments are tested, while history from every channel stays visible', async () => {
    const r = await backtest({ pairs: history(24), channel: 'email', count: 1000, minHistory: 3 });
    expect(r.moments.length).toBeGreaterThan(0);
    expect(r.moments.every((m) => m.channel === 'email')).toBe(true);
    expect(r.skipped.wrongChannel).toBeGreaterThan(0);
    const m = r.moments.at(-1)!;
    expect(m.history.pairs).toBe(Number(m.id.slice(1))); // every earlier pair, sms included
  });

  it('skips untimed pairs and moments with too little history, and says so', async () => {
    const pairs = [...history(6), { id: 'u', channel: 'sms', sender: 'Sam', incoming: 'x', reply: 'y' }];
    const r = await backtest({ pairs, count: 1000, minHistory: 3 });
    expect(r.skipped).toMatchObject({ untimed: 1, notEnoughHistory: 3 });
    expect(r.moments.map((m) => m.id)).toEqual(['p03', 'p04', 'p05']);
    expect(formatBacktest(r).join('\n')).toContain('Not eligible: 1 without a timestamp, 3 with fewer than 3 earlier pairs.');
  });

  it('says what to do when there is nothing to score', async () => {
    const r = await backtest({ pairs: history(2), count: 5 });
    expect(r.scoreboard).toBeUndefined();
    expect(formatBacktest(r).join('\n')).toContain('Nothing to score.');
  });
});

describe('backtest: prediction and scoring', () => {
  it('offline baseline: the nearest real earlier example becomes the prediction, and a repeated pattern is nailed', async () => {
    const r = await backtest({ pairs: history(24), count: 1000, minHistory: 6 });
    const m = byId(r, 'p12')!; // topic 0 again, earlier seen at p00 and p06
    expect(m.prediction).toMatchObject({ text: 'yep 3 works', basis: 'nearest-example' });
    expect(m.scores).toMatchObject({ length: { exact: true }, greeting: { match: true }, tokens: 1, overall: 100 });
    expect(m.diff).toBe('yep 3 works');
    const b = r.scoreboard!;
    expect(b.moments).toBe(r.evaluated);
    expect(b.overall).toBeGreaterThan(80);
    expect(b.length.exact.count).toBeGreaterThanOrEqual(b.length.baseline.count);
  });

  it('falls back to the newest reply to the same contact, then the channel, then nothing', async () => {
    const pairs: HistoryPair[] = [
      { id: 'a', channel: 'sms', sender: 'Sam', incoming: 'alpha beta', reply: 'one', incomingAt: at(1), replyAt: at(1, 1) },
      { id: 'b', channel: 'sms', sender: 'Sam', incoming: 'gamma delta', reply: 'two', incomingAt: at(2), replyAt: at(2, 1) },
      { id: 'c', channel: 'email', sender: 'Kim', incoming: 'epsilon', reply: 'three', incomingAt: at(3), replyAt: at(3, 1) },
      { id: 'q1', channel: 'sms', sender: 'Sam', incoming: 'zeta eta theta', reply: 'x', incomingAt: at(4), replyAt: at(4, 1) },
      { id: 'q2', channel: 'sms', sender: 'Lee', incoming: 'iota kappa lambda', reply: 'y', incomingAt: at(5), replyAt: at(5, 1) },
      { id: 'q3', channel: 'chat', sender: 'Zed', incoming: 'mu nu xi', reply: 'z', incomingAt: at(6), replyAt: at(6, 1) },
    ];
    const r = await backtest({ pairs, count: 100, minHistory: 3 });
    expect(byId(r, 'q1')!.prediction).toMatchObject({ basis: 'same-sender-recent', text: 'two' });
    expect(byId(r, 'q2')!.prediction).toMatchObject({ basis: 'channel-recent', text: 'x' });
    expect(byId(r, 'q3')!.prediction).toMatchObject({ basis: 'none', text: '' });
  });

  it("scores code's own greeting and length call against what the human did, causally", async () => {
    const r = await backtest({ pairs: history(24), count: 1000, minHistory: 6 });
    const b = r.scoreboard!;
    expect(b.codeCall.length.of).toBe(r.evaluated);
    expect(b.codeCall.greeting.of).toBeLessThanOrEqual(r.evaluated);
    for (const m of r.moments) expect(['greet', 'optional', 'skip']).toContain(m.codeCall.greet);
  });

  it('AI mode: needs a provider, records the label, strips quotes, and counts a failing moment as failed, not as a score', async () => {
    await expect(backtest({ pairs: history(8), mode: 'ai' })).rejects.toThrow('needs a provider');
    const provider = new FakeProvider((_req, n) => {
      if (n === 1) throw new Error('rate limited');
      return '"yep 3 works"';
    });
    const r = await backtest({ pairs: history(10), count: 3, minHistory: 3, mode: 'ai', provider, providerName: 'fast', pick: 'latest' });
    expect(r).toMatchObject({ mode: 'ai', provider: 'fast', failed: 1, evaluated: 2 });
    expect(r.moments[0]!.prediction).toMatchObject({ basis: 'ai', text: 'yep 3 works' });
    expect(r.moments[1]).toMatchObject({ prediction: { basis: 'error', error: 'rate limited' } });
    expect(r.moments[1]!.scores).toBeUndefined();
    expect(formatBacktest(r).join('\n')).toContain('predicted: failed (rate limited)');
  });

  it('a provider that is down for embeddings only costs the semantic part', async () => {
    const r = await backtest({ pairs: history(10), count: 3, minHistory: 3, embeddings: async () => Promise.reject(new Error('down')) });
    expect(r.evaluated).toBe(3);
  });

  it('formats a scoreboard and a readable side-by-side for quick grading', async () => {
    const text = formatBacktest(await backtest({ pairs: history(24), count: 4, minHistory: 6 })).join('\n');
    expect(text).toContain('Time-travel backtest: offline baseline');
    expect(text).toContain('Causality: strict.');
    expect(text).toContain('Scoreboard (4 moments)');
    expect(text).toMatch(/incoming : .+\n\s+actual\s+: .+\n\s+predicted: .+\n\s+diff\s+: .+\n\s+score\s+: /);
    expect(formatBacktest(await backtest({ pairs: history(24), count: 4, minHistory: 6 }), { diffs: 1 }).join('\n').match(/incoming :/g)).toHaveLength(1);
  });
});

describe('backtest scoring helpers', () => {
  it('token F1, tone and the word diff', () => {
    expect(tokenF1('see you at 3', 'see you at 3')).toBe(1);
    expect(tokenF1('see you at 3', 'nothing shared')).toBe(0);
    expect(tokenF1('', '')).toBe(1);
    expect(tokenF1('a b', '')).toBe(0);
    expect(tokenF1('see you at 3', 'see you at 4')).toBeCloseTo(0.75);
    expect(toneAgreement('ok sure', 'ok fine')).toBe(1);
    expect(toneAgreement('Ok sure.', 'ok sure!')).toBeCloseTo(2 / 5);
    expect(wordDiff('see you at 3', 'see you at 4')).toBe('see you at [-3-] {+4+}');
    expect(wordDiff('same', 'same')).toBe('same');
    expect(wordDiff('', 'new')).toBe('{+new+}');
  });

  it('scoreMoment: exact length and greeting at 100, one band off gets half the length credit', () => {
    const bands = { briefMax: 3, detailedMin: 8 };
    expect(scoreMoment('yep works', 'yep works', bands).overall).toBe(100);
    const off = scoreMoment('yep works', 'yep that works for me today ok', bands);
    expect(off.length).toMatchObject({ actual: 'brief', predicted: 'medium', exact: false, withinOne: true });
    expect(scoreMoment('hi there', 'ok then', bands).greeting.match).toBe(false);
  });
});

describe('rufus backtest (cli)', () => {
  const lines = () => {
    const out: string[] = [];
    return { out, io: { out: (l: string) => void out.push(l), err: (l: string) => void out.push(l) } };
  };
  const seeded = async (n = 24) => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    await store.init();
    await store.writeText(store.pairsFile, history(n).map((p) => JSON.stringify(p)).join('\n') + '\n');
    return dir;
  };

  it('prints a scoreboard offline by default, and --json prints the whole report', async () => {
    const dir = await seeded();
    const text = lines();
    await main(['--dir', dir, 'backtest', '--count', '5'], text.io);
    expect(text.out.join('\n')).toContain('Scoreboard (5 moments)');

    const json = lines();
    await main(['--dir', dir, 'backtest', '--count', '5', '--json', '--channel', 'sms'], json.io);
    const report = JSON.parse(json.out.join('\n')) as BacktestReport;
    expect(report).toMatchObject({ mode: 'offline', channel: 'sms', causality: { strict: true, violations: 0 } });
    expect(report.moments.length).toBeLessThanOrEqual(5);
    expect(report.moments.every((m) => m.channel === 'sms')).toBe(true);
  });

  it('--limit trims the side-by-side blocks, --latest takes the newest moments', async () => {
    const dir = await seeded();
    const c = lines();
    await main(['--dir', dir, 'backtest', '--count', '4', '--limit', '2', '--latest'], c.out && c.io);
    const text = c.out.join('\n');
    expect(text.match(/incoming :/g)).toHaveLength(2);
    expect(text).toContain('Scoreboard (4 moments)');
  });

  it('runs a live provider with --provider (and implies --mode ai), using only earlier examples', async () => {
    const dir = await seeded(12);
    const script = "process.stdin.resume();process.stdin.on('end',()=>console.log('yep 3 works'))";
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, providers: { fast: { type: 'command', command: process.execPath, args: ['-e', script] } } }));
    const c = lines();
    await main(['--dir', dir, 'backtest', '--count', '3', '--provider', 'fast', '--json'], c.io);
    const report = JSON.parse(c.out.join('\n')) as BacktestReport;
    expect(report).toMatchObject({ mode: 'ai', provider: 'fast', evaluated: 3, failed: 0 });
    expect(report.moments.every((m) => m.prediction.text === 'yep 3 works')).toBe(true);
  });

  it('rejects a bad mode, an offline --provider, and an unknown provider; says so when there is no history', async () => {
    const dir = await seeded(10);
    await expect(main(['--dir', dir, 'backtest', '--mode', 'dream'], lines().io)).rejects.toThrow('--mode must be offline or ai');
    await expect(main(['--dir', dir, 'backtest', '--mode', 'offline', '--provider', 'fast'], lines().io)).rejects.toThrow('needs --mode ai');
    await expect(main(['--dir', dir, 'backtest', '--provider', 'nope'], lines().io)).rejects.toThrow('Unknown AI provider "nope"');
    await expect(main(['--dir', dir, 'backtest', '--count', '0'], lines().io)).rejects.toThrow('--count needs a positive number');
    const empty = lines();
    await main(['--dir', await tempDir(), 'backtest'], empty.io);
    expect(empty.out.join('\n')).toContain('No history yet');
  });

  it('is in the usage text', async () => {
    const c = lines();
    await main(['--help'], c.io);
    expect(c.out.join('\n')).toContain('backtest [--count N]');
  });
});
