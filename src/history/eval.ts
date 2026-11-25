// Out-of-sample check: how close does Rufus get to what you actually did, on replies it has never seen?
// Pure and offline ($0.00). Everything is learned from the OLDER pairs only; the NEWEST pairs are only ever scored.
import type { CandidateRule } from './mine';
import { analyzeHistory, type AnalyzeOptions, type ConditionalRule } from './mine';
import { buildContactProfiles, buildSituationalContext, type LengthBand } from './profiles';
import { GREETING, SIGN_OFF, median, percentile, round1, words } from './stats';
import type { HistoryPair } from './types';
import type { Count } from './contrast';

export interface HoldoutOptions extends AnalyzeOptions {
  /** Share (0-1) of the newest pairs held out for scoring. Default 0.2. */
  holdoutFraction?: number;
  /** Fewest training pairs; below it nothing is evaluated. Default 10. */
  minTrain?: number;
  /** Fewest held-out pairs; below it nothing is evaluated. Default 5. */
  minTest?: number;
}

export interface HoldoutSplit {
  train: HistoryPair[];
  test: HistoryPair[];
  /** `time` when every pair has a valid timestamp; otherwise the order the pairs were given in (seed order). */
  orderedBy: 'time' | 'input-order';
}

const stamp = (p: HistoryPair): number => Date.parse(p.incomingAt ?? p.replyAt ?? '');

/** Oldest-first, then cut: the first `1 - fraction` is for learning, the last `fraction` is never looked at while learning. */
export function splitHoldout(pairs: HistoryPair[], fraction = 0.2): HoldoutSplit {
  const f = Math.min(0.9, Math.max(0.01, fraction));
  const timed = pairs.every((p) => Number.isFinite(stamp(p)));
  const ordered = timed ? pairs.map((p, i) => ({ p, i })).sort((a, b) => stamp(a.p) - stamp(b.p) || a.i - b.i).map(({ p }) => p) : [...pairs];
  const testN = Math.max(1, Math.round(ordered.length * f));
  return { train: ordered.slice(0, ordered.length - testN), test: ordered.slice(-testN), orderedBy: timed ? 'time' : 'input-order' };
}

const count = (c: number, of: number): Count => ({ count: c, of, pct: of ? round1((c / of) * 100) : 0 });

/** Does `reply` satisfy this invariant? `undefined` when the rule is not one this check knows. */
export function invariantHolds(rule: Pick<CandidateRule, 'id' | 'rule'>, reply: string): boolean | undefined {
  const r = reply.trim();
  switch (rule.id) {
    case 'short-replies':
      return words(r) < 20;
    case 'word-cap': {
      const cap = Number(/at most (\d+) words/.exec(rule.rule)?.[1]);
      return Number.isFinite(cap) ? words(r) <= cap : undefined;
    }
    case 'no-em-dash':
      return !r.includes('—');
    case 'no-trailing-period':
      return !(/\.$/.test(r) && !/\.\.$/.test(r));
    case 'no-exclamation':
      return !r.includes('!');
    case 'no-emoji':
      return !/\p{Extended_Pictographic}/u.test(r);
    case 'lowercase-start': {
      const first = /\p{L}/u.exec(r)?.[0];
      return first === undefined ? true : first === first.toLowerCase() && first !== first.toUpperCase();
    }
    case 'no-greeting':
      return !GREETING.test(r);
    case 'no-sign-off':
      return !SIGN_OFF.test(r);
    default:
      return undefined;
  }
}

export interface HoldoutEvaluation {
  evaluated: true;
  fraction: number;
  orderedBy: HoldoutSplit['orderedBy'];
  train: { count: number; from?: string; to?: string; invariants: number; conditionalRules: number };
  test: { count: number; from?: string; to?: string };
  /** Held-out replies whose sender had at least one pair in the training part. The rest are cold-start contacts. */
  knownContacts: Count;
  greeting: {
    /** `greetHint` of `greet` predicts a greeting; `skip` / `optional` predict none. Scored against what you did. */
    match: Count;
    /** Always predicting what you do most often in training. */
    baseline: Count;
    /** Accuracy on only the decisive calls (`greet` or `skip`); `optional` is a shrug and left out. */
    decisive: Count;
  };
  length: {
    /** The band the reply's real word count falls in (brief up to `bands.briefMax`, detailed above `bands.detailedMin`) is the band predicted. */
    match: Count;
    /** ... or one band away. */
    withinOneBand: Count;
    /** Always predicting the band your global median falls in. */
    baseline: Count;
    bands: { briefMax: number; detailedMin: number };
  };
  invariants?: { passAll: Count; each: Array<{ id: string; rule: string; passed: Count }> };
  /** Conditional rules learned on the training part only (what the held-out check is based on). */
  logic: ConditionalRule[];
}

export type HoldoutResult = HoldoutEvaluation | { evaluated: false; reason: string };

const BAND_ORDER: LengthBand[] = ['brief', 'medium', 'detailed'];

/**
 * Learn from the oldest `1 - holdoutFraction` of your pairs (profiles, invariants, conditional logic), then score
 * `buildSituationalContext` on the newest `holdoutFraction` it has never seen: did it call the greeting and the reply
 * length the way you actually wrote them? Compared with a naive baseline so a high number cannot hide over-fitting.
 */
export function evaluateHoldout(pairs: HistoryPair[], opts: HoldoutOptions = {}): HoldoutResult {
  const fraction = opts.holdoutFraction ?? 0.2;
  const { train, test, orderedBy } = splitHoldout(pairs, fraction);
  const minTrain = opts.minTrain ?? 10;
  const minTest = opts.minTest ?? 5;
  if (train.length < minTrain || test.length < minTest) return { evaluated: false, reason: `needs at least ${minTrain} older and ${minTest} newer pairs to check out of sample (have ${train.length} + ${test.length}).` };

  // Everything below sees `train` only.
  const learned = analyzeHistory(train, opts);
  const profiles = buildContactProfiles(train, { buckets: opts.buckets });
  const known = new Set(train.map((p) => p.sender));

  const trainWords = train.map((p) => words(p.reply)).sort((a, b) => a - b);
  const briefMax = Math.ceil(median(trainWords));
  const detailedMin = Math.max(briefMax, percentile(trainWords, 0.75));
  const bandOf = (w: number): LengthBand => (w <= briefMax ? 'brief' : w > detailedMin ? 'detailed' : 'medium');
  const baselineBand = bandOf(median(trainWords));
  const trainGreetRate = train.filter((p) => GREETING.test(p.reply.trim())).length / train.length;
  const baselineGreets = trainGreetRate > 0.5;

  let greetMatch = 0;
  let greetBaseline = 0;
  let decisive = 0;
  let decisiveOk = 0;
  let lenMatch = 0;
  let lenNear = 0;
  let lenBaseline = 0;
  let knownCount = 0;
  const passAll = { n: 0 };
  const perInvariant = new Map<string, number>();
  for (const p of test) {
    const ctx = buildSituationalContext(
      { channel: p.channel, sender: p.sender, incoming: p.incoming, ...(p.isGroup !== undefined ? { isGroup: p.isGroup } : {}), ...(p.gapSincePreviousMs !== undefined ? { gapSincePreviousMs: p.gapSincePreviousMs } : {}), ...(p.priorMessages ? { priorMessages: p.priorMessages } : {}) },
      train,
      { profiles, buckets: opts.buckets },
    );
    if (known.has(p.sender)) knownCount++;
    const greeted = GREETING.test(p.reply.trim());
    if ((ctx.greetHint === 'greet') === greeted) greetMatch++;
    if (baselineGreets === greeted) greetBaseline++;
    if (ctx.greetHint !== 'optional') {
      decisive++;
      if ((ctx.greetHint === 'greet') === greeted) decisiveOk++;
    }
    const actual = bandOf(words(p.reply));
    if (ctx.lengthBand === actual) lenMatch++;
    if (Math.abs(BAND_ORDER.indexOf(ctx.lengthBand) - BAND_ORDER.indexOf(actual)) <= 1) lenNear++;
    if (baselineBand === actual) lenBaseline++;
    const checks = learned.invariants.map((r) => [r, invariantHolds(r, p.reply)] as const).filter((c): c is readonly [CandidateRule, boolean] => c[1] !== undefined);
    if (checks.every(([, ok]) => ok)) passAll.n++;
    for (const [r, ok] of checks) if (ok) perInvariant.set(r.id, (perInvariant.get(r.id) ?? 0) + 1);
  }
  const n = test.length;
  const span = (list: HistoryPair[]): { from?: string; to?: string } => {
    const d = list.map((p) => p.incomingAt ?? p.replyAt).filter((x): x is string => !!x && Number.isFinite(Date.parse(x)));
    return d.length ? { from: d.reduce((a, b) => (a < b ? a : b)).slice(0, 10), to: d.reduce((a, b) => (a > b ? a : b)).slice(0, 10) } : {};
  };
  return {
    evaluated: true,
    fraction,
    orderedBy,
    train: { count: train.length, ...span(train), invariants: learned.invariants.length, conditionalRules: learned.conditionalRules.length },
    test: { count: n, ...span(test) },
    knownContacts: count(knownCount, n),
    greeting: { match: count(greetMatch, n), baseline: count(greetBaseline, n), decisive: count(decisiveOk, decisive) },
    length: { match: count(lenMatch, n), withinOneBand: count(lenNear, n), baseline: count(lenBaseline, n), bands: { briefMax, detailedMin } },
    ...(learned.invariants.length
      ? { invariants: { passAll: count(passAll.n, n), each: learned.invariants.map((r) => ({ id: r.id, rule: r.rule, passed: count(perInvariant.get(r.id) ?? 0, n) })) } }
      : {}),
    logic: learned.conditionalRules,
  };
}

const pc = (c: Count): string => `${round1(c.pct)}% (${c.count}/${c.of})`;

/** Three compact lines for the bottom of `rufus mine`. */
export function formatHoldout(h: HoldoutResult): string[] {
  if (!h.evaluated) return ['', `Out-of-sample holdout check: skipped, ${h.reason}`];
  const when = h.test.from ? ` (${h.test.from} to ${h.test.to})` : '';
  const order = h.orderedBy === 'time' ? 'oldest' : 'earliest';
  return [
    '',
    `Out-of-sample holdout check (learned from the ${order} ${h.train.count} pairs, scored on the newest ${h.test.count} it never saw${when}; ${h.knownContacts.pct}% went to known contacts):`,
    `  greeting call ${pc(h.greeting.match)} vs ${pc(h.greeting.baseline)} for always guessing your usual (decisive calls only: ${pc(h.greeting.decisive)}); length band ${pc(h.length.match)} exact, ${pc(h.length.withinOneBand)} within one band, vs ${pc(h.length.baseline)} for the global median.`,
    h.invariants
      ? `  invariants: ${pc(h.invariants.passAll)} of unseen replies satisfy all ${h.invariants.each.length} mined invariant(s). Scores that do not beat the baselines are not learning; a near-perfect score on few replies may be over-fit.`
      : '  invariants: none mined, so nothing to check. Scores that do not beat the baselines are not learning.',
  ];
}
