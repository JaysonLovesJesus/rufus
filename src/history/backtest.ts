// Chronological time-travel backtest: pick real past moments, rewind to just before each one, predict what you did, and
// compare with what you actually did. The rewind is strict: at moment T only pairs and corpus items from BEFORE T exist.
// Offline mode ($0, deterministic) predicts with the nearest real example; AI mode asks a provider with the same causal view.
import type { CorpusItem } from '../corpus/types';
import { cosineSimilarity, localEmbed, tokenize, type EmbeddingLookup } from '../corpus/embeddings';
import { queryCorpus } from '../corpus';
import { toMs } from '../recency';
import type { AiProvider } from '../types';
import type { Count } from './contrast';
import { buildSituationalContext, retrieveSimilarExamples, type GreetHint, type LengthBand, type RetrievedExample, type SituationalContext } from './profiles';
import { GREETING, median, percentile, round1, snippet, words } from './stats';
import type { HistoryPair, PriorMessage } from './types';

// ---------- Time ----------

/** When the moment happened: the incoming message arrived (else, when it was answered). `undefined` if the pair has no usable timestamp. */
export const momentMs = (p: Pick<HistoryPair, 'incomingAt' | 'replyAt'>): number | undefined => toMs(p.incomingAt) ?? toMs(p.replyAt);

/** When the whole exchange, your reply included, became known. A pair is only history for a later moment once this has passed. */
export const knownMs = (p: Pick<HistoryPair, 'incomingAt' | 'replyAt'>): number | undefined => toMs(p.replyAt) ?? toMs(p.incomingAt);

/** The world as it was strictly before `atMs`. Nothing at or after it is in here. */
export interface CausalSnapshot {
  atMs: number;
  at: string;
  /** Oldest first. Every pair's whole exchange (incoming AND your reply) was known strictly before `atMs`. */
  pairs: HistoryPair[];
  /** Oldest first. Every item's timestamp is strictly before `atMs`. */
  corpus: CorpusItem[];
}

/** Raised if anything at or after T is ever found inside a snapshot, a retrieval or a prompt. A backtest never reports past one. */
export class CausalityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CausalityError';
  }
}

/**
 * The strictly causal view at `atMs`: only pairs whose reply was already known (`knownMs < atMs`) and only corpus items with
 * `timestamp < atMs`. Pairs and items with no readable timestamp are dropped, because they cannot be proven to be in the
 * past. `exceptId` removes the moment itself. Chat exchanges that were turned into corpus items (they carry the reply text
 * under the incoming time) are dropped too: the pairs are the chat history.
 */
export function causalSnapshot(atMs: number, pairs: HistoryPair[], corpus: CorpusItem[] = [], exceptId?: string): CausalSnapshot {
  const past = pairs
    .map((p, i) => ({ p, i, t: knownMs(p) }))
    .filter((x): x is { p: HistoryPair; i: number; t: number } => x.t !== undefined && x.t < atMs && x.p.id !== exceptId)
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.p);
  const items = corpus
    .map((c, i) => ({ c, i, t: toMs(c.timestamp) }))
    .filter((x): x is { c: CorpusItem; i: number; t: number } => x.t !== undefined && x.t < atMs && !(x.c.source === 'chat' && x.c.kind === 'exchange'))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.c);
  return { atMs, at: new Date(atMs).toISOString(), pairs: past, corpus: items };
}

// ---------- Types ----------

export interface BacktestOptions {
  pairs: HistoryPair[];
  /** Life corpus items (emails, notes, pages, events). Optional; only items before each moment are ever seen. */
  corpus?: CorpusItem[];
  /** How many real moments to test. Default 20. */
  count?: number;
  /** Only test moments on this channel. History from every channel stays visible. */
  channel?: string;
  /** `offline` (default): deterministic nearest-real-example baseline, $0. `ai`: ask `provider` with the same causal view. */
  mode?: 'offline' | 'ai';
  /** Required for `mode: 'ai'`. */
  provider?: AiProvider;
  /** A label for the report (`fast`, `smart`, ...). */
  providerName?: string;
  /** `spread` (default): moments evenly spaced across the timeline. `latest`: the newest N. */
  pick?: 'spread' | 'latest';
  /** Similar real examples to retrieve per moment. Default 4. */
  topK?: number;
  /** Plus this many of the newest real examples (same contact first). Default 2. */
  recent?: number;
  /** A moment needs at least this many earlier pairs to be tested (a cold start tells you nothing). Default 3. */
  minHistory?: number;
  /** Cached vectors for hybrid retrieval: embed the text and pair it with your cache. Only the moment's own incoming text is embedded. */
  embeddings?: (queryText: string) => Promise<EmbeddingLookup | undefined>;
}

export interface BacktestExample {
  id: string;
  /** ISO time the exchange was known. Always strictly before the moment. */
  at: string;
  kind: 'similar' | 'recent';
  similarity?: number;
  because: string[];
}

export interface ToneProfile {
  lowercaseStart: boolean;
  exclamation: boolean;
  emoji: boolean;
  endsWithPeriod: boolean;
  question: boolean;
}

export type PredictionBasis = 'nearest-example' | 'same-sender-recent' | 'channel-recent' | 'ai' | 'none' | 'error';

export interface MomentScores {
  length: { actual: LengthBand; predicted: LengthBand; exact: boolean; withinOne: boolean };
  greeting: { actual: boolean; predicted: boolean; match: boolean };
  /** Share (0-1) of the five tone features (lowercase start, `!`, emoji, trailing period, question) that agree. */
  tone: number;
  /** F1 (0-1) over the words both texts use. */
  tokens: number;
  /** Cosine (0-1) between local hashed vectors of the two texts: shared wording and morphology, not synonyms. */
  meaning: number;
  /** 0-100: 25 length (half credit one band off) + 15 greeting + 15 tone + 25 tokens + 20 meaning. */
  overall: number;
}

export interface BacktestMoment {
  index: number;
  id: string;
  at: string;
  channel: string;
  sender: string;
  incoming: string;
  /** What the human really wrote. Never visible to the predictor. */
  actual: string;
  /** What existed at `at`: everything here is strictly earlier. */
  history: { pairs: number; corpus: number; newestPair?: string; newestCorpus?: string };
  examples: BacktestExample[];
  corpusHits: Array<{ id: string; at: string; source: string; title?: string }>;
  /** Code's own call from the causal history: greet or not, and how long. Scored separately from the predicted text. */
  codeCall: { greet: GreetHint; band: LengthBand; scored: { greeting?: boolean; length: boolean } };
  prediction: { text: string; basis: PredictionBasis; error?: string };
  scores?: MomentScores;
  /** `[-only in actual-]{+only in predicted+}` over the words, for a quick read. */
  diff?: string;
}

export interface BacktestScoreboard {
  /** Moments predicted and scored. */
  moments: number;
  length: { exact: Count; withinOne: Count; baseline: Count };
  greeting: { match: Count; baseline: Count };
  /** Means over all scored moments (0-1; `overall` 0-100). */
  tone: number;
  tokens: number;
  meaning: number;
  overall: number;
  /** Code's own call (before any model) versus what you did. `greeting` counts only decisive calls (greet / skip). */
  codeCall: { length: Count; greeting: Count };
  /** Best and worst moments by `overall`, for the read-through. */
  best: number[];
  worst: number[];
}

export interface BacktestReport {
  mode: 'offline' | 'ai';
  provider?: string;
  requested: number;
  evaluated: number;
  failed: number;
  channel?: string;
  pick: 'spread' | 'latest';
  topK: number;
  recent: number;
  minHistory: number;
  /** Every pair and corpus item that was inspected for a moment was checked strictly earlier than it. */
  causality: { strict: true; itemsChecked: number; violations: 0 };
  skipped: { untimed: number; wrongChannel: number; notEnoughHistory: number };
  scoreboard?: BacktestScoreboard;
  moments: BacktestMoment[];
}

// ---------- Scoring ----------

const BAND_ORDER: LengthBand[] = ['brief', 'medium', 'detailed'];

const count = (c: number, of: number): Count => ({ count: c, of, pct: of ? round1((c / of) * 100) : 0 });
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function toneOf(text: string): ToneProfile {
  const t = text.trim();
  const first = /\p{L}/u.exec(t)?.[0];
  return {
    lowercaseStart: first !== undefined && first === first.toLowerCase() && first !== first.toUpperCase(),
    exclamation: t.includes('!'),
    emoji: /\p{Extended_Pictographic}/u.test(t),
    endsWithPeriod: /\.$/.test(t) && !/\.\.$/.test(t),
    question: t.includes('?'),
  };
}

export const toneAgreement = (a: string, b: string): number => {
  const x = toneOf(a);
  const y = toneOf(b);
  const keys = Object.keys(x) as Array<keyof ToneProfile>;
  return keys.filter((k) => x[k] === y[k]).length / keys.length;
};

/** F1 over the sets of words two texts use. Two empty texts agree; one empty text does not. */
export function tokenF1(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (!x.size && !y.size) return 1;
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  if (!shared) return 0;
  const p = shared / y.size;
  const r = shared / x.size;
  return (2 * p * r) / (p + r);
}

export const meaningSimilarity = (a: string, b: string): number => (a.trim() && b.trim() ? Math.max(0, cosineSimilarity(localEmbed(a), localEmbed(b))) : 0);

/**
 * `[-word-]` for words only in `actual`, `{+word+}` for words only in `predicted`, plain words in both (longest common
 * subsequence). Texts are clipped to 80 words so a long message cannot make this slow.
 */
export function wordDiff(actual: string, predicted: string): string {
  const a = actual.trim().split(/\s+/).filter(Boolean).slice(0, 80);
  const b = predicted.trim().split(/\s+/).filter(Boolean).slice(0, 80);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push(a[i++]!), j++;
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) out.push(`{+${b[j++]}+}`);
    else out.push(`[-${a[i++]}-]`);
  }
  return out.join(' ');
}

interface Bands {
  briefMax: number;
  detailedMin: number;
}

/** Length bands from the replies you had written by then: brief up to your median, detailed above your 75th percentile. */
function bandsFrom(pairs: HistoryPair[]): Bands {
  const w = pairs.map((p) => words(p.reply)).sort((a, b) => a - b);
  const briefMax = Math.ceil(median(w));
  return { briefMax, detailedMin: Math.max(briefMax, percentile(w, 0.75)) };
}

const bandOf = (n: number, b: Bands): LengthBand => (n <= b.briefMax ? 'brief' : n > b.detailedMin ? 'detailed' : 'medium');
const bandDistance = (a: LengthBand, b: LengthBand): number => Math.abs(BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b));

export function scoreMoment(actual: string, predicted: string, bands: Bands): MomentScores {
  const la = bandOf(words(actual), bands);
  const lp = bandOf(words(predicted), bands);
  const exact = la === lp;
  const withinOne = bandDistance(la, lp) <= 1;
  const ga = GREETING.test(actual.trim());
  const gp = GREETING.test(predicted.trim());
  const tone = toneAgreement(actual, predicted);
  const tokens = tokenF1(actual, predicted);
  const meaning = meaningSimilarity(actual, predicted);
  const lengthCredit = exact ? 1 : withinOne ? 0.5 : 0;
  const overall = 100 * (0.25 * lengthCredit + 0.15 * (ga === gp ? 1 : 0) + 0.15 * tone + 0.25 * tokens + 0.2 * meaning);
  return {
    length: { actual: la, predicted: lp, exact, withinOne },
    greeting: { actual: ga, predicted: gp, match: ga === gp },
    tone: round3(tone),
    tokens: round3(tokens),
    meaning: round3(meaning),
    overall: round1(overall),
  };
}

// ---------- Choosing moments ----------

interface Candidate {
  pair: HistoryPair;
  t: number;
}

/** Evenly spaced picks across a chronological list (or its newest N). Deterministic. */
export function pickEvenly<T>(items: T[], n: number, how: 'spread' | 'latest' = 'spread'): T[] {
  const k = Math.max(0, Math.floor(n));
  if (k >= items.length) return [...items];
  if (how === 'latest') return items.slice(items.length - k);
  return Array.from({ length: k }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / k)]!);
}

// ---------- Predicting ----------

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

interface Seen {
  snapshot: CausalSnapshot;
  similar: RetrievedExample[];
  recent: HistoryPair[];
  byId: Map<string, HistoryPair>;
  corpusHits: ReturnType<typeof queryCorpus>;
  context: SituationalContext;
}

function exampleBlock(pairs: Array<{ p: HistoryPair; note: string }>): string {
  if (!pairs.length) return '(no earlier exchanges)';
  return pairs.map(({ p, note }, i) => `Example ${i + 1} (${note}, ${p.channel}, from ${p.sender})\nThey wrote: ${snippet(p.incoming, 400)}\nYou replied: ${snippet(p.reply, 400)}`).join('\n\n');
}

function aiPrompt(m: { channel: string; sender: string; incoming: string; at: string; prior: PriorMessage[] }, seen: Seen): { system: string; user: string } {
  const examples = [...seen.similar.map((e) => ({ p: seen.byId.get(e.id)!, note: `similar, sim ${e.similarity}` })), ...seen.recent.map((p) => ({ p, note: 'recent' }))].filter((e) => e.p);
  const parts = [
    `It is ${m.at}. Everything below happened before now; nothing later is known.`,
    `Situation: ${seen.context.voiceHint}`,
    ...(m.prior.length ? ['Earlier in this thread:', ...m.prior.map((x) => `${x.isFromMe ? 'You' : x.sender}: ${snippet(x.text, 240)}`)] : []),
    'Real examples of what you did in similar and recent moments:',
    exampleBlock(examples),
    ...(seen.corpusHits.length ? ['Related things from your life before now:', ...seen.corpusHits.map((h) => `- [${h.item.source}/${h.item.kind}, ${h.item.timestamp.slice(0, 10)}] ${h.item.title ?? ''} ${snippet(h.item.summary, 200)}`.replace(/\s+/g, ' '))] : []),
    `New message on ${m.channel} from ${m.sender}:\n${m.incoming}`,
    'Write the reply you would actually send. Output only the reply text.',
  ];
  return {
    system: 'You predict how one specific person replies to a message, from real examples of what they did. Match their length, tone, greeting habits and wording. Output only the reply text, with no quotes or commentary.',
    user: parts.join('\n\n'),
  };
}

function offlineReply(seen: Seen, sender: string, channel: string): { text: string; basis: PredictionBasis } {
  const nearest = seen.similar.find((e) => e.similarity >= 0.25);
  const nearestPair = nearest && seen.byId.get(nearest.id);
  if (nearestPair) return { text: nearestPair.reply, basis: 'nearest-example' };
  const newest = (match: (p: HistoryPair) => boolean): HistoryPair | undefined => [...seen.snapshot.pairs].reverse().find(match);
  const sameSender = newest((p) => p.sender === sender);
  if (sameSender) return { text: sameSender.reply, basis: 'same-sender-recent' };
  const sameChannel = newest((p) => p.channel === channel);
  if (sameChannel) return { text: sameChannel.reply, basis: 'channel-recent' };
  return { text: '', basis: 'none' };
}

// ---------- The backtest ----------

/**
 * Time-travel backtest. For each sampled real moment (a pair at time T): rewind to a snapshot of only what existed before
 * T, retrieve the closest and the most recent real examples from that snapshot (the v9 hybrid retriever), predict the
 * reply (offline: the nearest real example's reply; ai: the provider, shown those same examples), then score it against
 * what the human really wrote. A strict check runs on every retrieval; one item at or after T throws `CausalityError`.
 */
export async function backtest(opts: BacktestOptions): Promise<BacktestReport> {
  const mode = opts.mode ?? 'offline';
  if (mode === 'ai' && !opts.provider) throw new Error('mode "ai" needs a provider.');
  const requested = Math.max(1, Math.floor(opts.count ?? 20));
  const topK = Math.max(1, Math.floor(opts.topK ?? 4));
  const recentN = Math.max(0, Math.floor(opts.recent ?? 2));
  const minHistory = Math.max(0, Math.floor(opts.minHistory ?? 3));
  const pick = opts.pick ?? 'spread';
  const corpus = opts.corpus ?? [];

  // The timeline: every pair with a time, oldest first.
  const skipped = { untimed: 0, wrongChannel: 0, notEnoughHistory: 0 };
  const timeline: Candidate[] = [];
  for (const pair of opts.pairs) {
    const t = momentMs(pair);
    if (t === undefined) skipped.untimed++;
    else timeline.push({ pair, t });
  }
  timeline.sort((a, b) => a.t - b.t);
  const known = timeline.map((c) => knownMs(c.pair)!).sort((a, b) => a - b);
  const visibleBefore = (t: number): number => {
    let lo = 0;
    let hi = known.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (known[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const eligible = timeline.filter((c) => {
    if (opts.channel !== undefined && c.pair.channel !== opts.channel) return !!(skipped.wrongChannel++, false);
    if (visibleBefore(c.t) - (knownMs(c.pair)! < c.t ? 1 : 0) < minHistory) return !!(skipped.notEnoughHistory++, false);
    return true;
  });
  const chosen = pickEvenly(eligible, requested, pick);

  let itemsChecked = 0;
  const moments: BacktestMoment[] = [];
  let failed = 0;
  const baseline = { band: [] as boolean[], greet: [] as boolean[] };

  for (const [index, { pair, t }] of chosen.entries()) {
    const snapshot = causalSnapshot(t, opts.pairs, corpus, pair.id);
    for (const p of snapshot.pairs) {
      itemsChecked++;
      const k = knownMs(p);
      if (k === undefined || k >= t) throw new CausalityError(`Pair ${p.id} (known ${p.replyAt ?? p.incomingAt}) is not strictly before moment ${pair.id} (${new Date(t).toISOString()}).`);
    }
    for (const c of snapshot.corpus) {
      itemsChecked++;
      if (!(Date.parse(c.timestamp) < t)) throw new CausalityError(`Corpus item ${c.id} (${c.timestamp}) is not strictly before moment ${pair.id}.`);
    }

    // The moment's own thread context is, by construction, earlier; drop any prior message that claims otherwise.
    const prior = (pair.priorMessages ?? []).filter((m) => m.timestamp === undefined || (toMs(m.timestamp) ?? Infinity) < t);
    let embeddings: EmbeddingLookup | undefined;
    try {
      embeddings = await opts.embeddings?.(pair.incoming);
    } catch {
      embeddings = undefined; // a provider that is down only costs the semantic part
    }

    const similar = retrieveSimilarExamples(pair.incoming, snapshot.pairs, { limit: topK, sender: pair.sender, channel: pair.channel, embeddings });
    const similarIds = new Set(similar.map((e) => e.id));
    const newestFirst = [...snapshot.pairs].reverse();
    const recent = [
      ...newestFirst.filter((p) => p.sender === pair.sender && !similarIds.has(p.id)),
      ...newestFirst.filter((p) => p.sender !== pair.sender && p.channel === pair.channel && !similarIds.has(p.id)),
    ].slice(0, recentN);
    const byId = new Map(snapshot.pairs.map((p) => [p.id, p] as const));
    const corpusHits = queryCorpus(snapshot.corpus, { query: pair.incoming, limit: 3, now: t, embeddings });
    const context = buildSituationalContext(
      { channel: pair.channel, sender: pair.sender, incoming: pair.incoming, ...(pair.isGroup !== undefined ? { isGroup: pair.isGroup } : {}), ...(pair.gapSincePreviousMs !== undefined ? { gapSincePreviousMs: pair.gapSincePreviousMs } : {}), ...(prior.length || pair.priorMessages ? { priorMessages: prior } : {}) },
      snapshot.pairs,
      { examples: 3, embeddings },
    );

    // Strict check on what retrieval returned.
    const seenExamples: BacktestExample[] = [];
    for (const [kind, ids] of [['similar', similar.map((e) => e.id)], ['recent', recent.map((p) => p.id)]] as const) {
      for (const id of ids) {
        const p = byId.get(id);
        if (!p || (knownMs(p) ?? Infinity) >= t) throw new CausalityError(`Retrieved example ${id} for moment ${pair.id} is not strictly before it.`);
        itemsChecked++;
        const ex = similar.find((e) => e.id === id && kind === 'similar');
        seenExamples.push({ id, at: new Date(knownMs(p)!).toISOString(), kind, ...(ex ? { similarity: ex.similarity, because: ex.because } : { because: ['recent'] }) });
      }
    }
    for (const h of corpusHits) {
      itemsChecked++;
      if (!(Date.parse(h.item.timestamp) < t)) throw new CausalityError(`Corpus hit ${h.item.id} for moment ${pair.id} is not strictly before it.`);
    }

    const seen: Seen = { snapshot, similar, recent, byId, corpusHits, context };
    const bands = bandsFrom(snapshot.pairs);
    const moment: BacktestMoment = {
      index,
      id: pair.id,
      at: new Date(t).toISOString(),
      channel: pair.channel,
      sender: pair.sender,
      incoming: pair.incoming,
      actual: pair.reply,
      history: {
        pairs: snapshot.pairs.length,
        corpus: snapshot.corpus.length,
        ...(snapshot.pairs.length ? { newestPair: new Date(knownMs(snapshot.pairs.at(-1)!)!).toISOString() } : {}),
        ...(snapshot.corpus.length ? { newestCorpus: snapshot.corpus.at(-1)!.timestamp } : {}),
      },
      examples: seenExamples,
      corpusHits: corpusHits.map((h) => ({ id: h.item.id, at: h.item.timestamp, source: h.item.source, ...(h.item.title ? { title: h.item.title } : {}) })),
      codeCall: {
        greet: context.greetHint,
        band: context.lengthBand,
        scored: {
          ...(context.greetHint !== 'optional' ? { greeting: (context.greetHint === 'greet') === GREETING.test(pair.reply.trim()) } : {}),
          length: context.lengthBand === bandOf(words(pair.reply), bands),
        },
      },
      prediction: { text: '', basis: 'none' },
    };

    if (mode === 'offline') {
      moment.prediction = offlineReply(seen, pair.sender, pair.channel);
    } else {
      const { system, user } = aiPrompt({ channel: pair.channel, sender: pair.sender, incoming: pair.incoming, at: moment.at, prior }, seen);
      try {
        const raw = await opts.provider!.complete({ system, messages: [{ role: 'user', content: user }], meta: { runId: 'backtest', flowId: 'backtest', step: `moment-${index + 1}`, attempt: 1 } });
        moment.prediction = { text: raw.trim().replace(/^["“](.*)["”]$/s, '$1').trim(), basis: 'ai' };
      } catch (err) {
        moment.prediction = { text: '', basis: 'error', error: err instanceof Error ? err.message : String(err) };
        failed++;
      }
    }

    if (moment.prediction.basis !== 'error') {
      moment.scores = scoreMoment(pair.reply, moment.prediction.text, bands);
      moment.diff = wordDiff(pair.reply, moment.prediction.text);
      // The naive baselines a prediction has to beat, learned from the same causal snapshot.
      const wordsOf = snapshot.pairs.map((p) => words(p.reply)).sort((a, b) => a - b);
      baseline.band.push(bandOf(median(wordsOf), bands) === moment.scores.length.actual);
      const greetsMost = snapshot.pairs.filter((p) => GREETING.test(p.reply.trim())).length / Math.max(1, snapshot.pairs.length) > 0.5;
      baseline.greet.push(greetsMost === moment.scores.greeting.actual);
    }
    moments.push(moment);
  }

  const scored = moments.filter((m): m is BacktestMoment & { scores: MomentScores } => m.scores !== undefined);
  const n = scored.length;
  const decisive = scored.filter((m) => m.codeCall.scored.greeting !== undefined);
  const ranked = scored.map((m) => m).sort((a, b) => b.scores.overall - a.scores.overall || a.index - b.index);
  const scoreboard: BacktestScoreboard | undefined = n
    ? {
        moments: n,
        length: {
          exact: count(scored.filter((m) => m.scores.length.exact).length, n),
          withinOne: count(scored.filter((m) => m.scores.length.withinOne).length, n),
          baseline: count(baseline.band.filter(Boolean).length, n),
        },
        greeting: { match: count(scored.filter((m) => m.scores.greeting.match).length, n), baseline: count(baseline.greet.filter(Boolean).length, n) },
        tone: round3(mean(scored.map((m) => m.scores.tone))),
        tokens: round3(mean(scored.map((m) => m.scores.tokens))),
        meaning: round3(mean(scored.map((m) => m.scores.meaning))),
        overall: round1(mean(scored.map((m) => m.scores.overall))),
        codeCall: { length: count(scored.filter((m) => m.codeCall.scored.length).length, n), greeting: count(decisive.filter((m) => m.codeCall.scored.greeting).length, decisive.length) },
        best: ranked.slice(0, 3).map((m) => m.index),
        worst: ranked.slice(-3).reverse().map((m) => m.index),
      }
    : undefined;

  return {
    mode,
    ...(mode === 'ai' ? { provider: opts.providerName ?? 'provider' } : {}),
    requested,
    evaluated: n,
    failed,
    ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
    pick,
    topK,
    recent: recentN,
    minHistory,
    causality: { strict: true, itemsChecked, violations: 0 },
    skipped,
    ...(scoreboard ? { scoreboard } : {}),
    moments,
  };
}

// ---------- Formatting ----------

const pc = (c: Count): string => `${round1(c.pct)}% (${c.count}/${c.of})`;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** A readable scoreboard, then one side-by-side block per moment (`diffs` of them; default all). */
export function formatBacktest(r: BacktestReport, opts: { diffs?: number } = {}): string[] {
  const who = r.mode === 'ai' ? `AI (${r.provider})` : 'offline baseline (nearest real example, $0)';
  const lines = [`Time-travel backtest: ${who}. ${r.evaluated} of ${r.requested} requested moment(s) scored${r.failed ? `, ${r.failed} failed` : ''}${r.channel ? ` on ${r.channel}` : ''}.`];
  const s = r.skipped;
  const why = [s.untimed ? `${s.untimed} without a timestamp` : '', s.wrongChannel ? `${s.wrongChannel} on other channels` : '', s.notEnoughHistory ? `${s.notEnoughHistory} with fewer than ${r.minHistory} earlier pairs` : ''].filter(Boolean);
  if (why.length) lines.push(`Not eligible: ${why.join(', ')}.`);
  lines.push(`Causality: strict. At each moment only pairs and corpus items from before it were visible (${r.causality.itemsChecked} checked, ${r.causality.violations} from the future).`);
  if (!r.scoreboard) {
    lines.push('', 'Nothing to score. Seed more history with timestamps (rufus seed ...) or lower --count / the history minimum.');
    return lines;
  }
  const b = r.scoreboard;
  lines.push(
    '',
    `Scoreboard (${b.moments} moments)`,
    `  overall           ${b.overall}/100`,
    `  length band       ${pc(b.length.exact)} exact, ${pc(b.length.withinOne)} within one band; always guessing your median: ${pc(b.length.baseline)}`,
    `  greeting          ${pc(b.greeting.match)}; always guessing your usual: ${pc(b.greeting.baseline)}`,
    `  tone              ${pct(b.tone)} of tone features agree`,
    `  words             ${pct(b.tokens)} word overlap (F1); meaning ${pct(b.meaning)} (local vectors)`,
    `  code's own call   length ${pc(b.codeCall.length)}, greeting ${b.codeCall.greeting.of ? pc(b.codeCall.greeting) : 'no decisive calls'}`,
  );
  const shown = r.moments.slice(0, opts.diffs ?? r.moments.length);
  if (shown.length) lines.push('', 'Side by side (grade each: would you have sent the predicted one?)');
  for (const m of shown) {
    lines.push('', `#${m.index + 1}  ${m.at.slice(0, 16).replace('T', ' ')}  ${m.channel}  from ${m.sender}  (${m.history.pairs} earlier pairs${m.history.corpus ? `, ${m.history.corpus} corpus items` : ''})`);
    lines.push(`  incoming : ${snippet(m.incoming, 200)}`);
    lines.push(`  actual   : ${snippet(m.actual, 200)}`);
    if (m.scores) {
      lines.push(`  predicted: ${snippet(m.prediction.text, 200) || '(nothing)'}  [${m.prediction.basis}]`);
      lines.push(`  diff     : ${m.diff}`);
      lines.push(`  score    : ${m.scores.overall}/100  length ${m.scores.length.actual}→${m.scores.length.predicted}${m.scores.length.exact ? ' ✓' : ''}  greeting ${m.scores.greeting.match ? '✓' : '✗'}  tone ${pct(m.scores.tone)}  words ${pct(m.scores.tokens)}  meaning ${pct(m.scores.meaning)}`);
    } else {
      lines.push(`  predicted: failed (${m.prediction.error ?? 'unknown error'})`);
    }
    if (m.examples.length) lines.push(`  evidence : ${m.examples.map((e) => `${e.kind} ${e.at.slice(0, 10)}${e.similarity !== undefined ? ` sim ${e.similarity}` : ''}`).join(', ')}`);
  }
  lines.push('', 'A prediction that does not beat the always-guess baselines is not learning. Add --json for every number, or --provider fast|smart for a live AI run.');
  return lines;
}
