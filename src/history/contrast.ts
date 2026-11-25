// Invariants vs. contrastive conditional logic. Pure arithmetic over your own pairs: no AI, no I/O.
//
// A behavior that holds for 90-95% of replies is NOT a wall: the other 5-10% are real exceptions ("hi" when a thread
// restarts after days, a long reply to a multi-part question). A wall breaks them. So:
//   - >= `invariantMinShare` (default 98%) is a true invariant: safe as a hard check.
//   - Between 2% and 45% exceptions: compare the exception group with the norm group on deterministic features of the
//     INCOMING message and look for the `if / else`: P(exception | feature) vs. P(exception | not feature).
import { median, round1, words, GREETING, SIGN_OFF } from './stats';
import { incomingFeatures, type ClosenessTier, type IncomingFeatures } from './profiles';
import type { HistoryPair } from './types';

export type FeatureId = keyof IncomingFeatures;
export type BehaviorId = 'greeting' | 'long-reply' | 'sign-off';

/** Replies longer than this many words count as "long". */
export const LONG_REPLY_WORDS = 30;

export const FEATURE_LABELS: Record<FeatureId, string> = {
  theyGreeted: 'they greeted',
  coldRestart: 'cold restart (>24h)',
  liveChat: 'live chat (<10m)',
  newOrOccasional: 'new/occasional contact',
  longIncoming: 'long incoming (>=30 words)',
  multiQuestion: 'multi-question incoming',
  isGroup: 'group chat',
  isDm: 'DM',
};
const FEATURE_IDS = Object.keys(FEATURE_LABELS) as FeatureId[];
/** Features that say the same thing from two sides; only the better one is reported. */
const COMPLEMENT: Partial<Record<FeatureId, FeatureId>> = { isGroup: 'isDm', isDm: 'isGroup' };

export interface Count {
  count: number;
  of: number;
  /** 0-100, one decimal. */
  pct: number;
}

export interface Trigger {
  feature: FeatureId;
  label: string;
  /** Exceptions among pairs where the feature is true / false (pairs where it is unknown are left out of both). */
  whenTrue: Count;
  whenFalse: Count;
  /** whenTrue rate / whenFalse rate; `null` when it never happens when false. */
  lift: number | null;
  /** Two-proportion z-score of the difference. */
  z: number;
  /** Exceptions with this feature true, of all exceptions. */
  covers: Count;
  /** Different contacts among those exceptions. */
  contacts: number;
}

export interface ConditionalRule {
  id: string;
  behavior: BehaviorId;
  /** Where it belongs: the model needs a fact that code should fetch. */
  layer: 'context';
  /** Ready to print after `[logic]`. */
  rule: string;
  /** How many replies are on the exception side (the minority), exactly. */
  exceptions: Count;
  /** What an exception looks like: the behavior is `present` (a greeting) or `absent` (no greeting, when you usually greet). */
  exceptionIs: 'present' | 'absent';
  /** True when at least one deterministic feature separates the exceptions from the norm. */
  explained: boolean;
  triggers: Trigger[];
  /** Features that make the exception much LESS likely (e.g. live chat for greetings). At most one. */
  suppressors: Trigger[];
  /** What to do when no trigger fires. */
  otherwise: string;
}

export interface ContrastOptions {
  /** Share of replies a behavior must hold for to be a true invariant (0-1). Default 0.98. */
  invariantMinShare: number;
  /** Fewest exception cases before contrast is attempted. Default 5. */
  minExceptions: number;
  /** Exception rate range (0-1) in which contrast runs. Default: 1 - invariantMinShare up to 0.45. */
  exceptionMinRate?: number;
  exceptionMaxRate: number;
  /** A trigger's rate must be at least this many times the rest. Default 2. */
  minLift: number;
  /** ... with at least this many exceptions where it is true. Default 3. */
  minTriggerMatches: number;
  /** ... spread over at least this many different contacts (confounding guard). Default 3. */
  minTriggerContacts: number;
  /** ... explaining at least this share (0-1) of all exceptions. Default 0.2. */
  minCoverage: number;
  /** ... and the difference must have a z-score of at least this. Default 2. */
  minZ: number;
  /** Triggers named per rule. Default 3. */
  maxTriggers: number;
}

export const DEFAULT_CONTRAST: ContrastOptions = {
  invariantMinShare: 0.98,
  minExceptions: 5,
  exceptionMaxRate: 0.45,
  minLift: 2,
  minTriggerMatches: 3,
  minTriggerContacts: 3,
  minCoverage: 0.2,
  minZ: 2,
  maxTriggers: 3,
};

export const contrastOptionsFrom = (o: Partial<ContrastOptions> = {}): ContrastOptions => {
  const defined = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  return { ...DEFAULT_CONTRAST, ...defined };
};

/** A float-safe comparison for shares that sit exactly on a threshold (49/50 vs. 0.98). */
export const EPS = 1e-9;

/** True invariant: this many of `n` replies, at or above the share. */
export const isInvariantShare = (count: number, n: number, share: number): boolean => n > 0 && count / n >= share - EPS;

interface Behavior {
  id: BehaviorId;
  /** `present` side label, and the `absent` side (when the norm is to do it). */
  label: string;
  absentLabel: string;
  has: (reply: string) => boolean;
  /** What to do when no trigger fires, given the norm group. `exceptionIs` says which side the exceptions are on. */
  otherwise: (exceptionIs: 'present' | 'absent', norm: HistoryPair[]) => string;
}

const BEHAVIORS: Behavior[] = [
  {
    id: 'greeting',
    label: 'Greeting',
    absentLabel: 'Skipping the greeting',
    has: (r) => GREETING.test(r.trim()),
    otherwise: (is) => (is === 'present' ? 'jump straight in' : 'open with a greeting'),
  },
  {
    id: 'long-reply',
    label: `Long replies >${LONG_REPLY_WORDS}w`,
    absentLabel: `Short replies (<=${LONG_REPLY_WORDS}w)`,
    has: (r) => words(r) > LONG_REPLY_WORDS,
    otherwise: (is, norm) => {
      const m = Math.round(median(norm.map((p) => words(p.reply))));
      return is === 'present' ? `keep it brief (~${m} words)` : `write fuller replies (~${m} words)`;
    },
  },
  {
    id: 'sign-off',
    label: 'Sign-off',
    absentLabel: 'Skipping the sign-off',
    has: (r) => SIGN_OFF.test(r.trim()),
    otherwise: (is) => (is === 'present' ? 'no sign-off' : 'sign off'),
  },
];

const count = (c: number, of: number): Count => ({ count: c, of, pct: of ? round1((c / of) * 100) : 0 });
const pctText = (r: Count): string => (r.of && r.count / r.of < 0.01 && r.count > 0 ? `${round1(r.pct)}%` : `${Math.round(r.pct)}%`);
/** "15/118 (13%)" */
export const fmtCount = (c: Count): string => `${c.count}/${c.of} (${pctText(c)})`;
/** "35/685 = 5%" */
export const fmtShare = (c: Count): string => `${c.count}/${c.of} = ${pctText(c)}`;
export const fmtLift = (lift: number | null): string => (lift === null ? 'never otherwise' : `${lift >= 10 ? Math.round(lift) : round1(lift)}x`);

/** Pooled two-proportion z-score. */
function zScore(a: number, n1: number, b: number, n2: number): number {
  if (!n1 || !n2) return 0;
  const pooled = (a + b) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  return se ? (a / n1 - b / n2) / se : 0;
}

/** "they greeted (15/118 (13%) vs 4/347 (1%) otherwise, lift 11x)" */
export const describeTrigger = (t: Trigger): string => `${t.label} (${fmtCount(t.whenTrue)} vs ${fmtCount(t.whenFalse)} otherwise, lift ${fmtLift(t.lift)})`;

interface Row {
  pair: HistoryPair;
  features: IncomingFeatures;
}

/**
 * For each of greeting / long reply / sign-off that has real exceptions (their rate between `exceptionMinRate` and 45%,
 * at least `minExceptions` of them), find which deterministic features of the incoming message separate the exceptions
 * from the norm. Returns one rule per behavior; a rule with no trigger says so instead of inventing one.
 */
export function conditionalAnalysis(pairs: HistoryPair[], tiers: Map<string, ClosenessTier>, opts: Partial<ContrastOptions> = {}): ConditionalRule[] {
  const o = contrastOptionsFrom(opts);
  const n = pairs.length;
  if (!n) return [];
  const minRate = o.exceptionMinRate ?? 1 - o.invariantMinShare;
  const rows: Row[] = pairs.map((pair) => ({ pair, features: incomingFeatures(pair, tiers.get(pair.sender)) }));
  const out: ConditionalRule[] = [];

  for (const b of BEHAVIORS) {
    const has = pairs.map((p) => b.has(p.reply));
    const present = has.filter(Boolean).length;
    const exceptionIs: 'present' | 'absent' = present <= n - present ? 'present' : 'absent';
    const excCount = exceptionIs === 'present' ? present : n - present;
    const rate = excCount / n;
    if (rate < minRate - EPS || rate > o.exceptionMaxRate + EPS || excCount < o.minExceptions) continue;
    const isException = (i: number): boolean => (exceptionIs === 'present') === has[i]!;
    const exceptions = count(excCount, n);
    const norm = pairs.filter((_, i) => !isException(i));

    const found: Array<{ t: Trigger; excess: number }> = [];
    const suppress: Array<{ t: Trigger; excess: number }> = [];
    for (const f of FEATURE_IDS) {
      let nT = 0;
      let nF = 0;
      let aT = 0;
      let aF = 0;
      const senders = new Set<string>();
      rows.forEach((r, i) => {
        const v = r.features[f];
        if (v === undefined) return;
        if (v) {
          nT++;
          if (isException(i)) {
            aT++;
            senders.add(r.pair.sender);
          }
        } else {
          nF++;
          if (isException(i)) aF++;
        }
      });
      if (nT < 5 || nF < 5) continue;
      const rT = aT / nT;
      const rF = aF / nF;
      const z = zScore(aT, nT, aF, nF);
      const trigger = (lift: number | null, matches: number): Trigger => ({
        feature: f,
        label: FEATURE_LABELS[f],
        whenTrue: count(aT, nT),
        whenFalse: count(aF, nF),
        lift: lift === null ? null : round1(lift),
        z: round1(z),
        covers: count(matches, excCount),
        contacts: senders.size,
      });
      if (rT > rF) {
        const lift = rF > 0 ? rT / rF : null;
        if (aT < o.minTriggerMatches || senders.size < o.minTriggerContacts || aT / excCount < o.minCoverage) continue;
        if ((lift !== null && lift < o.minLift) || z < o.minZ) continue;
        found.push({ t: trigger(lift, aT), excess: aT - nT * rF });
      } else if (rF > rT) {
        // The feature makes the exception rarer (e.g. live chat suppresses greetings). Same bar, mirrored.
        const lift = rT > 0 ? rF / rT : null;
        if (nT < 10 || aF < o.minTriggerMatches || (lift !== null && lift < o.minLift) || -z < o.minZ) continue;
        suppress.push({ t: { ...trigger(lift, aT), contacts: senders.size }, excess: nT * (rF - rT) });
      }
    }

    const rank = (a: { t: Trigger; excess: number }, c: { t: Trigger; excess: number }): number => c.excess - a.excess || (c.t.lift ?? Infinity) - (a.t.lift ?? Infinity) || a.t.feature.localeCompare(c.t.feature);
    const triggers: Trigger[] = [];
    for (const { t } of found.sort(rank)) {
      if (triggers.length >= o.maxTriggers) break;
      const twin = COMPLEMENT[t.feature];
      if (twin && triggers.some((x) => x.feature === twin)) continue;
      triggers.push(t);
    }
    const suppressors = suppress.sort(rank).slice(0, 1).map((s) => s.t);

    const label = exceptionIs === 'present' ? b.label : b.absentLabel;
    const head = `${label} (${fmtShare(exceptions)})`;
    const otherwise = b.otherwise(exceptionIs, norm);
    const explained = triggers.length > 0;
    const rule = explained
      ? `${head}: much more likely when ${triggers.map(describeTrigger).join(' or ')}${suppressors.length ? `; rarely when ${suppressors.map((s) => `${s.label} (${fmtCount(s.whenTrue)} vs ${fmtCount(s.whenFalse)} otherwise)`).join(', ')}` : ''}; otherwise ${otherwise}.`
      : `${head}: ${excCount} exceptions, no single simple trigger explains them — keep flexible instead of adding a wall.`;
    out.push({ id: `logic-${b.id}`, behavior: b.id, layer: 'context', rule, exceptions, exceptionIs, explained, triggers, suppressors, otherwise });
  }
  return out;
}
