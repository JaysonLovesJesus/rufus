// Ideals vs. habits. Explicit human lessons ("no em dashes", "skip the greeting") are stated ideals; your history is a
// descriptive baseline. Ideals win while they are fresh, but people evolve and sometimes do not know what they want, so
// a deterministic drift check surfaces a saved lesson that your recent replies keep contradicting: a human decision
// (keep as aspiration, refine into conditional logic, or retire), never a silent permanent wall. Pure code, $0.
import { EMOJI, SIGN_OFF, words } from './stats';
import type { HistoryPair } from './types';
import { toMs } from '../recency';

/** A saved lesson, or just its rule text. `LessonStore` lessons fit as they are. */
export type LessonInput = string | { id?: string; rule: string; hardened?: boolean; updatedAt?: string };

export const ruleOf = (l: LessonInput): string => (typeof l === 'string' ? l : l.rule).trim();

/** One mechanically checkable claim extracted from a lesson's text. */
export interface LessonCheck {
  id: string;
  /** Plain-English claim, e.g. `no em dashes`. */
  label: string;
  /** True when this reply breaks the claim. */
  violates(reply: string): boolean;
  /** Whether the claim says anything about this reply (default: every reply). */
  applies?(reply: string): boolean;
  /** Greeting stance, when the claim is about greetings. */
  greet?: 'greet' | 'skip';
  /** Hard word cap, when the claim is about length. */
  maxWords?: number;
}

const NEG = String.raw`(?:no|never|avoid|skip|drop|omit|without|stop|don'?t|do not|not)`;
const POS = String.raw`(?:always|must|should|please|make sure to|remember to)`;
// A rule that is conditional ("only in group chats", "unless they greeted") is branching logic, not a wall: unchecked.
const CONDITIONAL = /\b(?:when|if|unless|except|only|whenever|during|for (?:new|close|group|inner|regular|occasional|cold|live)|in (?:groups?|dms?|live|cold|group chats?))\b/i;

const lowerStart = (r: string): boolean | undefined => {
  const first = /\p{L}/u.exec(r)?.[0];
  return first === undefined ? undefined : first === first.toLowerCase() && first !== first.toUpperCase();
};
const GREETING_START = /^\W*(hi+|hey+|hello|hiya|yo|howdy|good (?:morning|afternoon|evening)|morning|evening)\b/i;

/** Every deterministic claim a lesson makes (empty when it is conditional, or about taste code cannot measure). */
export function checksForRule(rule: string): LessonCheck[] {
  const r = rule.trim();
  if (!r || CONDITIONAL.test(r)) return [];
  const has = (re: RegExp): boolean => re.test(r);
  const out: LessonCheck[] = [];
  const neg = (topic: string): boolean => has(new RegExp(String.raw`\b${NEG}\b[^.;]{0,40}\b(?:${topic})`, 'i'));

  if (neg(String.raw`greetings?|greet\b|hi\b|hello|hey\b`))
    out.push({ id: 'no-greeting', label: 'no greeting', greet: 'skip', violates: (x) => GREETING_START.test(x.trim()) });
  else if (has(new RegExp(String.raw`\b${POS}\b[^.;]{0,30}\b(?:greet|open with (?:a )?(?:greeting|hi|hello|hey)|start with (?:a )?(?:greeting|hi|hello|hey)|say (?:hi|hello|hey))`, 'i')))
    out.push({ id: 'greeting', label: 'always greet', greet: 'greet', violates: (x) => !GREETING_START.test(x.trim()) });

  if (neg(String.raw`em[- ]?dash`)) out.push({ id: 'no-em-dash', label: 'no em dashes', violates: (x) => x.includes('—') });
  if (neg(String.raw`exclamation`)) out.push({ id: 'no-exclamation', label: 'no exclamation marks', violates: (x) => x.includes('!') });
  if (neg(String.raw`emoji`)) out.push({ id: 'no-emoji', label: 'no emoji', violates: (x) => EMOJI.test(x) });
  if (neg(String.raw`sign[- ]?offs?|signoffs?|closings?`))
    out.push({ id: 'no-sign-off', label: 'no sign-off', violates: (x) => SIGN_OFF.test(x.trim()) });
  else if (has(new RegExp(String.raw`\b${POS}\b[^.;]{0,30}\b(?:sign[- ]?off|sign off|close with)`, 'i')))
    out.push({ id: 'sign-off', label: 'always sign off', violates: (x) => !SIGN_OFF.test(x.trim()) });
  if (has(new RegExp(String.raw`\b${NEG}\b[^.;]{0,30}\b(?:end(?:ing)?|finish(?:ing)?)\b[^.;]{0,30}\bperiod\b|\b(?:no|without)\s+(?:a\s+)?(?:trailing|final)\s+period`, 'i')))
    out.push({ id: 'no-trailing-period', label: 'no trailing period', violates: (x) => /\.$/.test(x.trim()) && !/\.\.$/.test(x.trim()) });
  if (has(new RegExp(String.raw`\b(?:start|begin)\b[^.;]{0,25}\blowercase\b`, 'i')))
    out.push({ id: 'lowercase-start', label: 'start lowercase', applies: (x) => lowerStart(x) !== undefined, violates: (x) => lowerStart(x) === false });

  const cap = /\b(at most|no more than|not more than|up to|within|max(?:imum)?(?: of)?|under|fewer than|less than|below)\s+(\d{1,3})\s+words?\b/i.exec(r);
  if (cap) {
    const exclusive = /^(?:under|fewer than|less than|below)$/i.test(cap[1]!);
    const max = Number(cap[2]) - (exclusive ? 1 : 0);
    if (max >= 1) out.push({ id: 'word-cap', label: `at most ${max} words`, maxWords: max, violates: (x) => words(x) > max });
  }
  return out;
}

export interface IdealConstraints {
  greet?: 'greet' | 'skip';
  maxWords?: number;
  /** Rules behind each, for explaining an override. */
  from: { greet?: string; maxWords?: string };
}

/** The runtime stance explicit lessons impose on a reply (greeting, length); conflicting greeting lessons cancel out. */
export function idealConstraints(lessons: LessonInput[]): IdealConstraints {
  const out: IdealConstraints = { from: {} };
  const greets = new Set<'greet' | 'skip'>();
  for (const l of lessons) {
    for (const c of checksForRule(ruleOf(l))) {
      if (c.greet) {
        greets.add(c.greet);
        out.from.greet = ruleOf(l);
        out.greet = c.greet;
      }
      if (c.maxWords !== undefined && (out.maxWords === undefined || c.maxWords < out.maxWords)) {
        out.maxWords = c.maxWords;
        out.from.maxWords = ruleOf(l);
      }
    }
  }
  if (greets.size > 1) {
    delete out.greet;
    delete out.from.greet;
  }
  return out;
}

// ---------- Drift ----------

export interface DriftOptions {
  /** Judge the last N applicable replies, however long they took (a strategy can change in two days). Default 15. */
  windowSize?: number;
  /** Fewest applicable recent replies before drift can be called. Default 5. */
  minSamples?: number;
  /** Share (0-1) of the window that must break the lesson. Default 0.4. */
  minRate?: number;
}

export interface LessonDrift {
  lessonId?: string;
  rule: string;
  /** Which claim in the rule is contradicted (`no-em-dash`, `word-cap`, ...). */
  check: string;
  claim: string;
  recent: { violations: number; of: number; rate: number };
  allTime: { violations: number; of: number; rate: number };
  /** A question for the human, not an instruction. */
  message: string;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Oldest first: undated replies are treated as oldest, ties keep their given order. */
export function chronological(pairs: HistoryPair[]): HistoryPair[] {
  return pairs
    .map((p, i) => ({ p, i, t: toMs(p.replyAt ?? p.incomingAt) ?? -Infinity }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t < b.t ? -1 : 1))
    .map((e) => e.p);
}

/**
 * Saved lessons that your latest replies keep contradicting. A lesson is an ideal, so it stays in force (see
 * `buildSituationalContext`), but when 40% or more of the last 15 applicable replies break it (at least 5 of them
 * seen), Rufus says so and asks: keep it as an aspiration, refine it into conditional logic, or retire it. The window
 * counts observations, not days, so a fast shift shows up immediately and a slow channel is not misjudged by an
 * arbitrary cutoff. Hardened lessons (already enforced in code) and conditional ones are skipped.
 */
export function detectLessonDrift(lessons: LessonInput[], pairs: HistoryPair[], opts: DriftOptions = {}): LessonDrift[] {
  const windowSize = Math.max(1, Math.floor(opts.windowSize ?? 15));
  const minSamples = opts.minSamples ?? 5;
  const minRate = opts.minRate ?? 0.4;
  const ordered = chronological(pairs);
  const out: LessonDrift[] = [];
  const seen = new Set<string>();
  for (const l of lessons) {
    if (typeof l !== 'string' && l.hardened) continue;
    const rule = ruleOf(l);
    for (const c of checksForRule(rule)) {
      const key = `${rule}\u0000${c.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const applicable = ordered.filter((p) => !c.applies || c.applies(p.reply));
      const recent = applicable.slice(-windowSize);
      if (recent.length < minSamples) continue;
      const violations = recent.filter((p) => c.violates(p.reply)).length;
      const rate = violations / recent.length;
      if (rate < minRate) continue;
      const allViolations = applicable.filter((p) => c.violates(p.reply)).length;
      const allRate = applicable.length ? allViolations / applicable.length : 0;
      out.push({
        ...(typeof l !== 'string' && l.id ? { lessonId: l.id } : {}),
        rule,
        check: c.id,
        claim: c.label,
        recent: { violations, of: recent.length, rate: round3(rate) },
        allTime: { violations: allViolations, of: applicable.length, rate: round3(allRate) },
        message: `Saved lesson "${rule}" disagrees with ${violations}/${recent.length} of your latest replies (${pct(rate)}; ${pct(allRate)} of all history). Keep it as an aspiration, refine it into conditional logic, or retire it?`,
      });
    }
  }
  return out.sort((a, b) => b.recent.rate - a.recent.rate || a.rule.localeCompare(b.rule));
}
