// Code-first relationship and context profiling. Every number here is exact arithmetic over your own pairs:
// no AI, no I/O. `buildContactProfiles` summarises the history; `buildSituationalContext` looks one message up in it.
import type { ReplyHabit } from './extract';
import type { PriorMessage, HistoryPair } from './types';
import { idealConstraints, detectLessonDrift, ruleOf, type DriftOptions, type LessonDrift, type LessonInput } from './ideals';
import { rankWeights, recencyWeight, resolveRecencyMode, toMs, type TimeLike } from '../recency';
import { DEFAULT_BUCKETS, EMOJI, GREETING, OTHER_BUCKET, SIGN_OFF, classify, median, percentile, snippet, words, type IntentBucket } from './stats';

// ---------- Vocabulary ----------

export { detectLessonDrift, checksForRule, type DriftOptions, type LessonDrift, type LessonInput } from './ideals';

export type ClosenessTier = 'inner-circle' | 'regular' | 'occasional' | 'new';
export const TIERS: ClosenessTier[] = ['inner-circle', 'regular', 'occasional', 'new'];

/** Conversation rhythm: how long since the previous turn in the thread when `incoming` arrived. */
export type Rhythm = 'live' | 'same-day' | 'cold';
export const RHYTHMS: Rhythm[] = ['live', 'same-day', 'cold'];

export type ChatKind = 'dm' | 'group';

/** Live back-and-forth is under 10 minutes; a cold restart is more than 24 hours. */
export const LIVE_GAP_MS = 10 * 60 * 1000;
export const COLD_GAP_MS = 24 * 60 * 60 * 1000;

export const RHYTHM_LABELS: Record<Rhythm, string> = { live: 'live back-and-forth', 'same-day': 'same-day', cold: 'cold restart' };

export interface TierThresholds {
  /** Pairs with one contact for `inner-circle`. Default 20. */
  innerCircle: number;
  /** ... for `regular`. Default 5. */
  regular: number;
  /** ... for `occasional`. Default 2. (One pair is `new`.) */
  occasional: number;
  /** A contact with at least this many pairs, most of them live (< 10 min), is inner-circle early. Default 10. */
  rapidMinPairs: number;
  /** ... and this share of them live. Default 0.5. */
  rapidShare: number;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = { innerCircle: 20, regular: 5, occasional: 2, rapidMinPairs: 10, rapidShare: 0.5 };

// ---------- Pair -> situation ----------

export const chatKindOf = (p: Pick<HistoryPair, 'isGroup'>): ChatKind | undefined => (p.isGroup === undefined ? undefined : p.isGroup ? 'group' : 'dm');

export function rhythmFromGap(gapMs: number): Rhythm {
  return gapMs < LIVE_GAP_MS ? 'live' : gapMs <= COLD_GAP_MS ? 'same-day' : 'cold';
}

/** Rhythm of a pair, if known: from the gap; a thread opener (empty `priorMessages`) is a cold restart. */
export function rhythmOf(p: Pick<HistoryPair, 'gapSincePreviousMs' | 'priorMessages'>): Rhythm | undefined {
  if (p.gapSincePreviousMs !== undefined) return rhythmFromGap(p.gapSincePreviousMs);
  return Array.isArray(p.priorMessages) && p.priorMessages.length === 0 ? 'cold' : undefined;
}

// ---------- Deterministic features of an incoming message ----------

/** Incoming-message features that can explain when your behavior changes. `undefined` = unknown (not enough data on the pair). */
export interface IncomingFeatures {
  /** The incoming message opens with a greeting ("hi", "hey", "good morning", ...). */
  theyGreeted: boolean;
  /** At least 24 h since the previous turn (or the incoming message opened the thread). */
  coldRestart?: boolean;
  /** Under 10 min since the previous turn. */
  liveChat?: boolean;
  /** The sender is a `new` or `occasional` contact. */
  newOrOccasional?: boolean;
  /** The incoming message is 30 words or more. */
  longIncoming: boolean;
  /** Two or more question marks, or two or more list items. */
  multiQuestion: boolean;
  isGroup?: boolean;
  isDm?: boolean;
}

export const LONG_INCOMING_WORDS = 30;
const LIST_ITEM = /^\s*(?:[-*\u2022]|\d+[.)])\s+\S/gm;

/** How many separate asks an incoming message makes: its question marks, or its list items when there are more of those. */
export function questionCount(text: string): { count: number; kind: 'questions' | 'items' } {
  const marks = text.match(/\?/g)?.length ?? 0;
  const items = text.match(LIST_ITEM)?.length ?? 0;
  return items > marks ? { count: items, kind: 'items' } : { count: marks, kind: 'questions' };
}

export interface FeatureInput {
  incoming: string;
  isGroup?: boolean;
  gapSincePreviousMs?: number;
  priorMessages?: unknown[];
}

/** Pure, deterministic. `tier` is the sender's closeness tier (leave `undefined` when unknown). */
export function incomingFeatures(x: FeatureInput, tier?: ClosenessTier): IncomingFeatures {
  const opener = Array.isArray(x.priorMessages) && x.priorMessages.length === 0;
  const gap = x.gapSincePreviousMs;
  return {
    theyGreeted: GREETING.test(x.incoming.trim()),
    ...(gap !== undefined ? { coldRestart: gap >= COLD_GAP_MS, liveChat: gap < LIVE_GAP_MS } : opener ? { coldRestart: true, liveChat: false } : {}),
    ...(tier ? { newOrOccasional: tier === 'new' || tier === 'occasional' } : {}),
    longIncoming: words(x.incoming) >= LONG_INCOMING_WORDS,
    multiQuestion: questionCount(x.incoming).count >= 2,
    ...(x.isGroup !== undefined ? { isGroup: x.isGroup, isDm: !x.isGroup } : {}),
  };
}

// ---------- Style slices ----------

/** Exact style statistics over a group of your replies. Rates are 0-1 (three decimals). */
export interface StyleSlice {
  count: number;
  medianWords: number;
  p90Words: number;
  greetingRate: number;
  signOffRate: number;
  emojiRate: number;
  exclamationRate: number;
  /** Of replies that contain a letter, the share starting with a lowercase letter. */
  lowercaseRate: number;
  /** Median minutes from incoming to reply, over pairs that carry a delay. */
  medianReplyMins?: number;
  /** How many different senders these replies went to. A slice with 1-2 senders is a person, not a pattern. */
  distinctContacts: number;
  /** Share (0-1) of this slice's replies that went to its single most frequent sender. */
  topContactShare: number;
  /** Only when recency-weighted: how many replies' worth of evidence the weights leave (Kish effective sample size). `count` stays the raw number of replies. */
  effectiveCount?: number;
}

/**
 * When a slice (a channel, a closeness tier, DM vs. group, ...) is allowed to become a generalized rule. Without
 * this, one chatty person on a quiet channel looks like "how you write on that channel" (confounding).
 */
export interface SliceGate {
  /** Fewest replies in the slice. Default 30. */
  minSlicePairs: number;
  /** Fewest different contacts. Default 5. */
  minDistinctContacts: number;
  /** No single contact may make up more than this share (0-1) of the slice. Default 0.4. */
  maxTopContactShare: number;
  /** Share of a slice's contacts that must individually deviate the same way as the slice. Default 0.6. */
  minContactAgreement: number;
}

export const DEFAULT_SLICE_GATE: SliceGate = { minSlicePairs: 30, minDistinctContacts: 5, maxTopContactShare: 0.4, minContactAgreement: 0.6 };

/** Why a slice is too thin or too concentrated to generalize, or `undefined` when it passes the gate. */
export function sliceGateIssue(s: Pick<StyleSlice, 'count' | 'distinctContacts' | 'topContactShare'>, gate: Partial<SliceGate> = {}): string | undefined {
  const g = { ...DEFAULT_SLICE_GATE, ...gate };
  const pct = `${Math.round(s.topContactShare * 100)}%`;
  if (s.count < g.minSlicePairs) return `only ${s.count} repl${s.count === 1 ? 'y' : 'ies'} (need ${g.minSlicePairs})`;
  if (s.distinctContacts < g.minDistinctContacts) return `only ${s.distinctContacts} contact${s.distinctContacts === 1 ? '' : 's'} (need ${g.minDistinctContacts}); top contact ${pct}`;
  if (s.topContactShare > g.maxTopContactShare) return `top contact is ${pct} of it (max ${Math.round(g.maxTopContactShare * 100)}%)`;
  return undefined;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

const delayMins = (p: HistoryPair): number | undefined => {
  if (p.replyDelayMs !== undefined && p.replyDelayMs >= 0) return p.replyDelayMs / 60000;
  if (p.incomingAt && p.replyAt) {
    const m = (Date.parse(p.replyAt) - Date.parse(p.incomingAt)) / 60000;
    if (Number.isFinite(m) && m >= 0) return m;
  }
  return undefined;
};

// ---------- Recency weighting ----------

/** Observation-rank decay is the default: the Nth newest reply counts half as much as the newest, however long those N took. */
export const DEFAULT_HALF_LIFE_OBSERVATIONS = 100;
/** Only used when `halfLifeDays` is passed explicitly (e.g. `--half-life 180`); there is no default calendar timer. */
export const DEFAULT_HALF_LIFE_DAYS = 180;

export interface WeightOptions {
  /** Reference "today" (default: now). Weights are only relative, so this rarely changes a result. */
  now?: TimeLike;
  /** Calendar decay, only when passed: days for a reply's weight to halve. `0` or `Infinity` turns weighting off. */
  halfLifeDays?: number;
  /** Rank-based decay (the default, 100): the Nth newest reply weighs half the newest, whether those N spanned two days or two months. Wins over `halfLifeDays`. */
  halfLifeObservations?: number;
}

const timeOf = (p: HistoryPair): string | undefined => p.incomingAt ?? p.replyAt;

/** Per-pair weight function for `pairs`, or `undefined` when weighting is off. Slices of the same pair objects share it. */
export function pairWeigher(pairs: HistoryPair[], o: WeightOptions = {}): ((p: HistoryPair) => number) | undefined {
  const times = pairs.map(timeOf);
  const mode = resolveRecencyMode(o, DEFAULT_HALF_LIFE_OBSERVATIONS);
  if (mode.kind === 'off') return undefined;
  const now = toMs(o.now) ?? Date.now();
  const weights = mode.kind === 'rank' ? rankWeights(times, mode.half) : times.map((t) => recencyWeight(t, now, mode.half));
  const byPair = new Map(pairs.map((p, i) => [p, weights[i]!] as const));
  return (p) => byPair.get(p) ?? 1;
}

/** Weighted quantile (0-1) of `values`; on an exact boundary the two neighbours are averaged, like an ordinary median. */
function weightedQuantile(values: number[], weights: number[], q: number): number {
  if (!values.length) return 0;
  const order = values.map((v, i) => ({ v, w: weights[i]! })).sort((a, b) => a.v - b.v);
  const total = order.reduce((s, e) => s + e.w, 0);
  const target = total * q;
  let acc = 0;
  for (let i = 0; i < order.length; i++) {
    acc += order[i]!.w;
    if (acc > target + total * 1e-12) return order[i]!.v;
    if (Math.abs(acc - target) <= total * 1e-12 && i + 1 < order.length) return (order[i]!.v + order[i + 1]!.v) / 2;
  }
  return order.at(-1)!.v;
}

/** Effectively equal weights (within 2%) add nothing but rounding noise: keep the plain, exact arithmetic. */
const nearlyUniform = (w: number[]): boolean => !w.length || Math.min(...w) / Math.max(...w) > 0.98;

/**
 * Exact style statistics over a group of replies. With a `weight` function, rates, medians and the 90th percentile
 * are recency-weighted (`count` and the contact breadth numbers stay raw, because evidence gates count real replies).
 */
export function styleOf(pairs: HistoryPair[], weight?: (p: HistoryPair) => number): StyleSlice {
  const replies = pairs.map((p) => p.reply.trim());
  const n = replies.length;
  const ws = weight ? pairs.map(weight) : undefined;
  const w = ws && !nearlyUniform(ws) ? ws : undefined;
  const wAt = (i: number): number => (w ? w[i]! : 1);
  const share = (pred: (i: number) => boolean, base: (i: number) => boolean = () => true): number => {
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      if (!base(i)) continue;
      den += wAt(i);
      if (pred(i)) num += wAt(i);
    }
    return den ? round3(num / den) : 0;
  };
  const counts = replies.map(words);
  const sortedCounts = [...counts].sort((a, b) => a - b);
  const hasLetter = replies.map((r) => /\p{L}/u.test(r));
  const isLower = replies.map((r) => {
    const first = /\p{L}/u.exec(r)?.[0];
    return first !== undefined && first === first.toLowerCase() && first !== first.toUpperCase();
  });
  const delayed = pairs.map(delayMins);
  const delayIdx = delayed.flatMap((m, i) => (m === undefined ? [] : [i]));
  const perSender = new Map<string, number>();
  for (const p of pairs) perSender.set(p.sender, (perSender.get(p.sender) ?? 0) + 1);
  const q = (x: number): number => (w ? weightedQuantile(counts, w, x) : x === 0.5 ? median(sortedCounts) : percentile(sortedCounts, x));
  const medianDelay = delayIdx.length
    ? w
      ? weightedQuantile(delayIdx.map((i) => delayed[i]!), delayIdx.map((i) => w[i]!), 0.5)
      : median(delayIdx.map((i) => delayed[i]!))
    : undefined;
  const sumW = w ? w.reduce((a, b) => a + b, 0) : 0;
  return {
    count: n,
    distinctContacts: perSender.size,
    topContactShare: n ? round3(Math.max(...perSender.values()) / n) : 0,
    medianWords: q(0.5),
    p90Words: q(0.9),
    greetingRate: share((i) => GREETING.test(replies[i]!)),
    signOffRate: share((i) => SIGN_OFF.test(replies[i]!)),
    emojiRate: share((i) => EMOJI.test(replies[i]!)),
    exclamationRate: share((i) => replies[i]!.includes('!')),
    lowercaseRate: share((i) => isLower[i]!, (i) => hasLetter[i]!),
    ...(medianDelay !== undefined ? { medianReplyMins: round1(medianDelay) } : {}),
    ...(w ? { effectiveCount: round1((sumW * sumW) / w.reduce((a, b) => a + b * b, 0)) } : {}),
  };
}

// ---------- Profiles ----------

export interface ContactProfile {
  sender: string;
  channels: string[];
  tier: ClosenessTier;
  dmCount: number;
  groupCount: number;
  /** Share of this contact's pairs that were live (< 10 min); only over pairs whose rhythm is known. */
  liveShare?: number;
  /** answered / (answered + unanswered), when `replyHabits` were supplied. */
  replyRate?: number;
  unanswered?: number;
  style: StyleSlice;
  byRhythm: Partial<Record<Rhythm, StyleSlice>>;
}

export interface TierProfile extends StyleSlice {
  tier: ClosenessTier;
  contacts: number;
}
export interface ChatKindProfile extends StyleSlice {
  kind: ChatKind;
}
export interface ChannelProfile extends StyleSlice {
  channel: string;
  replyRate?: number;
  unanswered?: number;
}
export interface RhythmProfile extends StyleSlice {
  rhythm: Rhythm;
}
export interface ChannelIntentProfile extends StyleSlice {
  channel: string;
  intent: string;
}

export interface ContactProfiles {
  total: number;
  contacts: ContactProfile[];
  /** Always all four tiers; `count` 0 when nobody is in one. */
  byTier: TierProfile[];
  /** Only kinds that appear (legacy pairs without `isGroup` are not guessed). */
  byChatKind: ChatKindProfile[];
  byChannel: ChannelProfile[];
  /** Only rhythms that appear. */
  byRhythm: RhythmProfile[];
  byChannelIntent: ChannelIntentProfile[];
  /** Pairs with `isGroup` / a known rhythm, so callers can tell "no data" from "no difference". */
  known: { chatKind: number; rhythm: number };
}

export interface ProfileOptions extends WeightOptions {
  buckets?: IntentBucket[];
  tiers?: Partial<TierThresholds>;
  /** From `extractHistoryFromMessages(...).ignored`: adds reply rates (how often you stay quiet). */
  replyHabits?: ReplyHabit[];
}

export function closenessTier(count: number, liveShare: number | undefined, t: TierThresholds = DEFAULT_TIER_THRESHOLDS): ClosenessTier {
  if (count >= t.innerCircle || (count >= t.rapidMinPairs && liveShare !== undefined && liveShare >= t.rapidShare)) return 'inner-circle';
  if (count >= t.regular) return 'regular';
  if (count >= t.occasional) return 'occasional';
  return 'new';
}

const groupBy = <T>(items: T[], key: (t: T) => string | undefined): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    if (k === undefined) continue;
    const list = m.get(k);
    if (list) list.push(i);
    else m.set(k, [i]);
  }
  return m;
};

const byCountThenName = (a: { count: number }, b: { count: number }, an: string, bn: string): number => b.count - a.count || an.localeCompare(bn);

/** Who is close: tier of each sender, from their own pair history (and rhythm, when known). */
export function tierBySender(pairs: HistoryPair[], thresholds: Partial<TierThresholds> = {}): Map<string, ClosenessTier> {
  const t = { ...DEFAULT_TIER_THRESHOLDS, ...thresholds };
  const out = new Map<string, ClosenessTier>();
  for (const [sender, group] of groupBy(pairs, (p) => p.sender)) out.set(sender, closenessTier(group.length, liveShareOf(group), t));
  return out;
}

function liveShareOf(group: HistoryPair[]): number | undefined {
  const rhythms = group.map(rhythmOf).filter((r): r is Rhythm => r !== undefined);
  return rhythms.length ? round3(rhythms.filter((r) => r === 'live').length / rhythms.length) : undefined;
}

/**
 * Deterministic relationship profiles from real history. A contact is a sender (across channels). Tier by pair count:
 * `inner-circle` >= 20 (or >= 10 and mostly live), `regular` 5-19, `occasional` 2-4, `new` 1. Aggregates by tier,
 * DM vs. group, channel, conversation rhythm and channel x intent all use the same exact statistics.
 */
export function buildContactProfiles(pairs: HistoryPair[], opts: ProfileOptions = {}): ContactProfiles {
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;
  const thresholds = { ...DEFAULT_TIER_THRESHOLDS, ...opts.tiers };
  const weight = pairWeigher(pairs, opts);
  const habitsBySender = new Map<string, { answered: number; unanswered: number }>();
  const habitsByChannel = new Map<string, { answered: number; unanswered: number }>();
  for (const h of opts.replyHabits ?? []) {
    for (const [map, key] of [[habitsBySender, h.sender], [habitsByChannel, h.channel]] as const) {
      const e = map.get(key) ?? { answered: 0, unanswered: 0 };
      e.answered += h.answered;
      e.unanswered += h.unanswered;
      map.set(key, e);
    }
  }
  const replyRate = (e?: { answered: number; unanswered: number }): { replyRate?: number; unanswered?: number } =>
    e && e.answered + e.unanswered ? { replyRate: round3(e.answered / (e.answered + e.unanswered)), unanswered: e.unanswered } : {};

  const bySender = groupBy(pairs, (p) => p.sender);
  const tierOfSender = new Map<string, ClosenessTier>();
  const contacts: ContactProfile[] = [...bySender.entries()].map(([sender, group]) => {
    const live = liveShareOf(group);
    const tier = closenessTier(group.length, live, thresholds);
    tierOfSender.set(sender, tier);
    const rhythms = groupBy(group, (p) => rhythmOf(p));
    const byRhythm: Partial<Record<Rhythm, StyleSlice>> = {};
    for (const r of RHYTHMS) if (rhythms.has(r)) byRhythm[r] = styleOf(rhythms.get(r)!, weight);
    return {
      sender,
      channels: [...new Set(group.map((p) => p.channel))].sort(),
      tier,
      dmCount: group.filter((p) => chatKindOf(p) === 'dm').length,
      groupCount: group.filter((p) => chatKindOf(p) === 'group').length,
      ...(live !== undefined ? { liveShare: live } : {}),
      ...replyRate(habitsBySender.get(sender)),
      style: styleOf(group, weight),
      byRhythm,
    };
  });
  contacts.sort((a, b) => byCountThenName(a.style, b.style, a.sender, b.sender));

  const byTier: TierProfile[] = TIERS.map((tier) => {
    const members = pairs.filter((p) => tierOfSender.get(p.sender) === tier);
    return { tier, contacts: contacts.filter((c) => c.tier === tier).length, ...styleOf(members, weight) };
  });
  const byChatKind: ChatKindProfile[] = (['dm', 'group'] as const)
    .map((kind) => ({ kind, group: pairs.filter((p) => chatKindOf(p) === kind) }))
    .filter((e) => e.group.length)
    .map(({ kind, group }) => ({ kind, ...styleOf(group, weight) }));
  const byChannel: ChannelProfile[] = [...groupBy(pairs, (p) => p.channel).entries()]
    .map(([channel, group]) => ({ channel, ...styleOf(group, weight), ...replyRate(habitsByChannel.get(channel)) }))
    .sort((a, b) => byCountThenName(a, b, a.channel, b.channel));
  const byRhythm: RhythmProfile[] = RHYTHMS.map((rhythm) => ({ rhythm, group: pairs.filter((p) => rhythmOf(p) === rhythm) }))
    .filter((e) => e.group.length)
    .map(({ rhythm, group }) => ({ rhythm, ...styleOf(group, weight) }));
  const byChannelIntent: ChannelIntentProfile[] = [...groupBy(pairs, (p) => `${p.channel}\u0000${classify(p, buckets)}`).entries()]
    .map(([k, group]) => {
      const [channel, intent] = k.split('\u0000') as [string, string];
      return { channel, intent, ...styleOf(group, weight) };
    })
    .sort((a, b) => byCountThenName(a, b, `${a.channel}/${a.intent}`, `${b.channel}/${b.intent}`));

  return {
    total: pairs.length,
    contacts,
    byTier,
    byChatKind,
    byChannel,
    byRhythm,
    byChannelIntent,
    known: { chatKind: pairs.filter((p) => chatKindOf(p)).length, rhythm: pairs.filter((p) => rhythmOf(p)).length },
  };
}

// ---------- Runtime lookup ----------

export interface SituationInput {
  channel: string;
  sender: string;
  isGroup?: boolean;
  incoming: string;
  gapSincePreviousMs?: number;
  priorMessages?: Array<Pick<PriorMessage, 'sender' | 'isFromMe' | 'text'> & { timestamp?: string }>;
}

export type StyleBasis = 'contact+rhythm' | 'contact' | 'channel+chat+intent' | 'channel+chat' | 'channel' | 'overall' | 'none';

export interface SituationExample {
  id: string;
  channel: string;
  incoming: string;
  reply: string;
  /** Why it was picked, most specific first: `same sender`, `same channel+dm`, `same intent`, `same rhythm`. */
  because: string[];
}

export interface SituationalContext {
  /** The contact's tier; `new` for someone with no history. */
  tier: ClosenessTier;
  /** True when this sender has past pairs. */
  known: boolean;
  /** Past exchanges with this sender (0 if unknown). */
  contactPairs: number;
  chatKind?: ChatKind;
  rhythm?: Rhythm;
  rhythmLabel?: string;
  intent: string;
  /** Style to imitate, and which slice of history it came from. */
  style?: StyleSlice;
  styleBasis: StyleBasis;
  /** Past exchanges that look most like this one. */
  examples: SituationExample[];
  /** Deterministic facts about the incoming message that drive the hints below. */
  features: IncomingFeatures;
  /** Whether to open with a greeting, decided in code from the incoming message and the rhythm. */
  greetHint: GreetHint;
  greetReason: string;
  /** How long the reply should be, decided in code from the incoming message and your own style. */
  lengthBand: LengthBand;
  lengthReason: string;
  /** Rough target for `brief`; the 90th percentile for `detailed`. Only when there is history to base it on. */
  approxWords?: number;
  /**
   * A short block for a prompt: who, the style to imitate, and the greeting / length cues. With `explicitLessons` it
   * becomes two or three labeled lines, **Ideals (override history)** above **Historical habits (descriptive baseline)**.
   */
  voiceHint: string;
  /** The explicit lessons (your stated ideals) that were applied, empty without `explicitLessons`. */
  ideals: string[];
  /** Where an ideal overrode what your history would have done (greeting, length). */
  idealOverrides: IdealOverride[];
  /** Ideals that your latest replies keep contradicting: a question for you (shown by `rufus mine`), not a silent wall. Kept out of `voiceHint` so a drafting model never sees it. */
  drift: LessonDrift[];
}

export interface IdealOverride {
  aspect: 'greeting' | 'length';
  /** What history alone would have said. */
  habit: string;
  /** What the ideal says instead. */
  ideal: string;
  rule: string;
}

export type GreetHint = 'greet' | 'optional' | 'skip';
export type LengthBand = 'brief' | 'medium' | 'detailed';

/** Greet only when it is a cold restart and they opened with a greeting; skip in a live exchange they did not open with one. */
export function greetDecision(f: IncomingFeatures, style?: Pick<StyleSlice, 'greetingRate'>): { hint: GreetHint; reason: string } {
  if (f.coldRestart && f.theyGreeted) return { hint: 'greet', reason: 'cold restart (>24h) + they greeted → brief greeting fits' };
  if (f.liveChat && !f.theyGreeted) return { hint: 'skip', reason: "live back-and-forth, they didn't greet → skip" };
  if (f.theyGreeted) return { hint: 'optional', reason: f.liveChat ? 'live chat, but they greeted → a quick mirror is fine, not needed' : 'they greeted, not a cold restart → mirror only if it feels natural' };
  if (f.coldRestart) return { hint: 'optional', reason: "cold restart (>24h), but they didn't greet → greeting optional" };
  if (style && style.greetingRate >= 0.5) return { hint: 'optional', reason: "they didn't greet, but you usually greet this kind of contact → optional" };
  return { hint: 'skip', reason: "they didn't greet → skip" };
}

/** Detailed for a multi-question or long incoming message, brief for a short ping, medium otherwise. */
export function lengthDecision(input: { incoming: string }, f: IncomingFeatures, style?: Pick<StyleSlice, 'medianWords' | 'p90Words'>): { band: LengthBand; reason: string; approxWords?: number } {
  const inWords = words(input.incoming);
  const asks = questionCount(input.incoming);
  const p90 = style && style.p90Words > style.medianWords ? Math.round(style.p90Words) : undefined;
  if (f.multiQuestion) return { band: 'detailed', reason: `incoming has ${asks.count} ${asks.kind} (${inWords} words) → detailed`, ...(p90 ? { approxWords: p90 } : {}) };
  if (f.longIncoming) return { band: 'detailed', reason: `long incoming (${inWords} words) → detailed`, ...(p90 ? { approxWords: p90 } : {}) };
  const median = style ? Math.max(1, Math.round(style.medianWords)) : undefined;
  if (inWords <= 12 && !f.coldRestart) {
    if (median !== undefined && median > 20) return { band: 'medium', reason: `short message, but you usually write ~${median} words to them → medium` };
    return { band: 'brief', reason: `short ${f.liveChat ? 'live ping' : 'message'} (${inWords} words) → brief${median !== undefined ? ` (~${median} words)` : ''}`, ...(median !== undefined ? { approxWords: median } : {}) };
  }
  return { band: 'medium', reason: `ordinary ${f.coldRestart ? 'cold-restart ' : ''}message (${inWords} words) → medium` };
}

export interface SituationOptions extends ProfileOptions {
  /** Examples to return (clamped to 2-4). Default 3. */
  examples?: number;
  /** A slice needs at least this many pairs to be trusted. Default 3. */
  minSlice?: number;
  /** Pre-built profiles for `pairs` (build once, look up many times). */
  profiles?: ContactProfiles;
  /**
   * Your stated ideals (saved lessons from `LessonStore`, or plain rule text). They are labeled **Ideals (override
   * history)** and outrank the **Historical habits (descriptive baseline)**: history describes what you did, ideals say what
   * you are working toward, so a rushed past habit never overrides a rule you wrote down.
   */
  explicitLessons?: LessonInput[];
  /** How `detectLessonDrift` judges those ideals against your latest replies. */
  drift?: DriftOptions;
}

const CHANNEL_NAMES: Record<string, string> = { whatsapp: 'WhatsApp', imessage: 'iMessage', sms: 'SMS', email: 'Email', telegram: 'Telegram', slack: 'Slack', signal: 'Signal', messenger: 'Messenger' };
export const channelName = (c: string): string => CHANNEL_NAMES[c.toLowerCase()] ?? c;
const TIER_NAMES: Record<ClosenessTier, string> = { 'inner-circle': 'Inner-circle', regular: 'Regular', occasional: 'Occasional', new: 'New' };

/** "median 6 words, casual, no greeting/sign-off" from a style slice. */
export function describeStyle(s: StyleSlice): string {
  const parts = [`median ${s.medianWords} words`];
  const lowercase = s.lowercaseRate >= 0.5;
  const greets = s.greetingRate >= 0.3;
  const signs = s.signOffRate >= 0.3;
  const bare = s.greetingRate < 0.1 && s.signOffRate < 0.1;
  if (lowercase || (s.medianWords <= 10 && bare && !greets)) parts.push('casual');
  else if (greets || signs) parts.push('more formal');
  if (lowercase && s.lowercaseRate >= 0.8) parts.push('lowercase');
  if (bare) parts.push('no greeting/sign-off');
  else {
    if (greets) parts.push('usually greets');
    if (signs) parts.push('usually signs off');
  }
  if (s.exclamationRate >= 0.3) parts.push('often uses exclamation marks');
  if (s.emojiRate >= 0.2) parts.push('uses emoji');
  return parts.join(', ');
}

/**
 * Look one incoming message up in your history, deterministically. Call it inside a flow's `ctx.code` step and hand
 * the result to `ctx.ai` as context. Style comes from the most specific slice with enough evidence:
 * this contact (in this rhythm) -> channel + DM/group + intent -> channel + DM/group -> channel -> everything.
 */
export function buildSituationalContext(input: SituationInput, pairs: HistoryPair[], opts: SituationOptions = {}): SituationalContext {
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;
  const minSlice = opts.minSlice ?? 3;
  const wantExamples = Math.min(4, Math.max(2, Math.floor(opts.examples ?? 3)));
  const profiles = opts.profiles ?? buildContactProfiles(pairs, opts);
  const weight = pairWeigher(pairs, opts);

  const contact = profiles.contacts.find((c) => c.sender === input.sender);
  const intent = classify({ incoming: input.incoming }, buckets);
  const chatKind: ChatKind | undefined = input.isGroup === undefined ? undefined : input.isGroup ? 'group' : 'dm';
  const rhythm: Rhythm | undefined =
    input.gapSincePreviousMs !== undefined ? rhythmFromGap(input.gapSincePreviousMs) : input.priorMessages && input.priorMessages.length === 0 ? 'cold' : undefined;

  // Style: most specific slice that has enough evidence.
  let style: StyleSlice | undefined;
  let styleBasis: StyleBasis = 'none';
  const sameChat = (p: HistoryPair): boolean => p.channel === input.channel && (chatKind === undefined || chatKindOf(p) === undefined || chatKindOf(p) === chatKind);
  const slices: Array<[StyleBasis, () => StyleSlice | undefined]> = [
    ['contact+rhythm', () => (contact && rhythm ? contact.byRhythm[rhythm] : undefined)],
    ['contact', () => contact?.style],
    ['channel+chat+intent', () => (intent === OTHER_BUCKET.id ? undefined : styleOf(pairs.filter((p) => sameChat(p) && classify(p, buckets) === intent), weight))],
    ['channel+chat', () => styleOf(pairs.filter(sameChat), weight)],
    ['channel', () => styleOf(pairs.filter((p) => p.channel === input.channel), weight)],
    ['overall', () => styleOf(pairs, weight)],
  ];
  for (const [basis, get] of slices) {
    const s = get();
    if (s && s.count >= minSlice) {
      style = s;
      styleBasis = basis;
      break;
    }
  }
  if (!style && pairs.length) {
    style = styleOf(pairs, weight);
    styleBasis = 'overall';
  }

  // Examples: same sender > same channel + DM/group > same intent > same rhythm; newest first within a score.
  const scored = pairs
    .map((p, i) => {
      const because: string[] = [];
      let score = 0;
      const hit = (points: number, why: string): void => {
        score += points;
        because.push(why);
      };
      if (p.sender === input.sender) hit(100, 'same sender');
      if (p.channel === input.channel && chatKind !== undefined && chatKindOf(p) === chatKind) hit(20, `same channel+${chatKind}`);
      else if (p.channel === input.channel) hit(8, 'same channel');
      if (intent !== OTHER_BUCKET.id && classify(p, buckets) === intent) hit(10, 'same intent');
      if (rhythm && rhythmOf(p) === rhythm) hit(3, 'same rhythm');
      return { p, i, score, because };
    })
    .filter((e) => e.score >= 8)
    .sort((a, b) => b.score - a.score || (b.p.incomingAt ?? '').localeCompare(a.p.incomingAt ?? '') || b.i - a.i)
    .slice(0, wantExamples);
  const examples = scored.map(({ p, because }) => ({ id: p.id, channel: p.channel, incoming: snippet(p.incoming, 240), reply: snippet(p.reply, 240), because }));

  const tier: ClosenessTier = contact?.tier ?? 'new';
  const kindName = chatKind === 'group' ? 'group chat' : chatKind === 'dm' ? 'DM' : 'chat';
  const who = contact ? `${TIER_NAMES[tier]} ${channelName(input.channel)} ${kindName} (${contact.style.count} past exchange${contact.style.count === 1 ? '' : 's'})` : `New contact on ${channelName(input.channel)} ${kindName} (no history with them)`;
  const rhythmText = rhythm === 'live' ? 'live chat' : rhythm === 'same-day' ? 'same-day thread' : rhythm === 'cold' ? 'cold restart' : undefined;
  const chan = channelName(input.channel);
  const basisText = (basis: StyleBasis, n: number): string => {
    switch (basis) {
      case 'channel+chat+intent':
        return `${n} similar ${intent} ${chan} ${kindName}s`.replace(/\s+/g, ' ');
      case 'channel+chat':
        return `${n} of your ${chan} ${kindName}s`;
      case 'channel':
        return `${n} of your ${chan} messages`;
      case 'overall':
        return `${n} of all your replies`;
      default:
        return '';
    }
  };
  const features = incomingFeatures(input, tier);
  const habitGreet = greetDecision(features, style);
  const habitLength = lengthDecision(input, features, style);
  let greet = habitGreet;
  let length = habitLength;

  // Ideals (explicit lessons) outrank habits: apply what code can enforce, and say where it changed the decision.
  const lessons = opts.explicitLessons ?? [];
  const ideals = [...new Set(lessons.map(ruleOf).filter(Boolean))];
  const idealOverrides: IdealOverride[] = [];
  const constraints = idealConstraints(lessons);
  if (constraints.greet && constraints.greet !== habitGreet.hint) {
    const rule = constraints.from.greet!;
    greet = { hint: constraints.greet, reason: `ideal "${rule}" → ${constraints.greet} (history alone said ${habitGreet.hint}: ${habitGreet.reason})` };
    idealOverrides.push({ aspect: 'greeting', habit: habitGreet.hint, ideal: constraints.greet, rule });
  }
  if (constraints.maxWords !== undefined) {
    const cap = constraints.maxWords;
    const rule = constraints.from.maxWords!;
    const capped = habitLength.approxWords === undefined || habitLength.approxWords > cap ? cap : habitLength.approxWords;
    const band: LengthBand = cap <= 20 ? 'brief' : habitLength.band === 'detailed' && cap <= 40 ? 'medium' : habitLength.band;
    if (capped !== habitLength.approxWords || band !== habitLength.band) {
      length = { band, approxWords: capped, reason: `${habitLength.reason}; ideal "${rule}" caps it at ${cap} words → ${band}` };
      idealOverrides.push({ aspect: 'length', habit: `${habitLength.band}${habitLength.approxWords !== undefined ? ` (~${habitLength.approxWords} words)` : ''}`, ideal: `${band} (≤ ${cap} words)`, rule });
    }
  }
  const drift = lessons.length ? detectLessonDrift(lessons, pairs, opts.drift) : [];

  const decisions = `greeting: ${greet.reason}; length: ${length.reason}`;
  let voiceHint: string;
  let habits: string;
  if (!style) habits = `${who}${rhythmText ? `, ${rhythmText}` : ''}: no history to learn from yet.`;
  else {
    const from = basisText(styleBasis, style.count) ? ` (from ${basisText(styleBasis, style.count)})` : '';
    const thin = style.count < minSlice ? ' (thin evidence)' : '';
    habits = `${who}${rhythmText ? `, ${rhythmText}` : ''}: ${describeStyle(style)}${from}${thin}`;
  }
  if (!ideals.length) voiceHint = `${habits}; ${decisions}`;
  else {
    voiceHint = [
      `Ideals (override history): ${ideals.join(' | ')}`,
      `Historical habits (descriptive baseline${weight ? ', recency-weighted' : ''}): ${habits}`,
      `Decision (ideals applied): ${decisions}`,
    ].join('\n');
  }

  return {
    tier,
    known: !!contact,
    contactPairs: contact?.style.count ?? 0,
    ...(chatKind ? { chatKind } : {}),
    ...(rhythm ? { rhythm, rhythmLabel: RHYTHM_LABELS[rhythm] } : {}),
    intent,
    ...(style ? { style } : {}),
    styleBasis,
    examples,
    features,
    greetHint: greet.hint,
    greetReason: greet.reason,
    lengthBand: length.band,
    lengthReason: length.reason,
    ...(length.approxWords !== undefined ? { approxWords: length.approxWords } : {}),
    voiceHint,
    ideals,
    idealOverrides,
    drift,
  };
}
