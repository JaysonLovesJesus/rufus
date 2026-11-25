import type { Engine } from '../engine/engine';
import { runAiStep } from '../engine/ai';
import type { LessonLayer } from '../learning/layers';
import type { AiProvider, MineConfig, RufusConfig } from '../types';
import { loadPairs } from './seed';
import type { HistoryPair } from './types';
import { evaluateHoldout, formatHoldout, type HoldoutOptions, type HoldoutResult } from './eval';
import { conditionalAnalysis, contrastOptionsFrom, isInvariantShare, type ConditionalRule, type ContrastOptions } from './contrast';
import { chronological, detectLessonDrift, type DriftOptions, type LessonDrift, type LessonInput } from './ideals';
import { DEFAULT_SLICE_GATE, RHYTHM_LABELS, TIERS, DEFAULT_HALF_LIFE_OBSERVATIONS, buildContactProfiles, pairWeigher, sliceGateIssue, styleOf as styleOfPairs, type WeightOptions, tierBySender, channelName, chatKindOf, rhythmOf, type ClosenessTier, type ContactProfiles, type SliceGate, type StyleSlice } from './profiles';
import { resolveRecencyMode } from '../recency';
import { DEFAULT_BUCKETS, EMOJI, GREETING, OTHER_BUCKET, SHORT_WORDS, SIGN_OFF, classify, median, percentile, round1, snippet, tally, top, words, type IntentBucket } from './stats';

export { DEFAULT_BUCKETS, OTHER_BUCKET, SHORT_WORDS, classify, type IntentBucket };
export type { ConditionalRule };

// ---------- Deterministic analysis (no AI, $0.00) ----------

/** Compile `config.mine.buckets` (string patterns) into buckets. */
export function bucketsFromConfig(cfg?: MineConfig): IntentBucket[] | undefined {
  if (!cfg?.buckets?.length) return undefined;
  return cfg.buckets.map((b) => {
    if (!b.id || !b.pattern) throw new Error('Each mine bucket needs an "id" and a "pattern".');
    try {
      return { id: b.id, label: b.label ?? b.id, pattern: new RegExp(b.pattern, 'i') };
    } catch {
      throw new Error(`Mine bucket "${b.id}" has an invalid pattern.`);
    }
  });
}

export interface Rate {
  count: number;
  /** 0-100, one decimal. */
  pct: number;
}

export interface VoiceFingerprint {
  replies: number;
  words: { median: number; p90: number; max: number };
  /** Replies under `SHORT_WORDS` words. */
  shortReplies: Rate;
  /** First letter is lowercase (of replies that contain a letter). */
  lowercaseStart: Rate;
  trailingPeriod: Rate;
  exclamation: Rate;
  question: Rate;
  emoji: Rate;
  emDashes: { total: number; repliesWith: Rate };
  greetings: { rate: Rate; top: Array<{ text: string; count: number }> };
  signOffs: { rate: Rate; top: Array<{ text: string; count: number }> };
  /** Minutes from incoming to reply, for pairs that carry both timestamps. */
  replyDelayMinutes?: { median: number; pairs: number };
}

export interface CandidateRule {
  id: string;
  /** Where it belongs: `code` = enforce in `verify`; `principle` = a short line in the prompt. */
  layer: LessonLayer;
  rule: string;
  /** Exact: `count` of `of` replies behave this way. */
  support: { count: number; of: number };
  evidence: string;
}

export interface PairSample {
  id: string;
  incoming: string;
  reply: string;
}

export interface IntentCluster {
  bucket: string;
  label: string;
  channel: string;
  count: number;
  /** Share of all pairs, 0-100, one decimal. */
  pct: number;
  medianReplyWords: number;
  samples: PairSample[];
}

export interface HistoryAnalysis {
  total: number;
  span?: { from: string; to: string };
  byChannel: Array<{ channel: string; count: number; pct: number }>;
  topContacts: Array<{ sender: string; count: number; channels: string[] }>;
  topThreads: Array<{ threadId: string; channel: string; count: number }>;
  voice: VoiceFingerprint;
  /** True invariants (>= `invariantMinShare`, default 98%): safe as hard `verify` checks. Behaviors with real exceptions are NOT here; see `conditionalRules`. */
  invariants: CandidateRule[];
  /** The share a behavior needed to be an invariant. */
  invariantMinShare: number;
  /** Behaviors with real exceptions (2-45% of replies): the `if / else` found by comparing the exception group with the norm group. Use branching logic, not a wall. */
  conditionalRules: ConditionalRule[];
  /** Situational rules (layer `context`): only where a situation's style differs meaningfully from your overall style. */
  contextRules: CandidateRule[];
  /** Situations that differ from your overall style but were NOT turned into a rule: too few replies, too few contacts, dominated by one or two people, or only a minority of contacts agree. Handled per contact instead. */
  suppressedSlices: string[];
  /** The same history split by who, DM vs. group, channel and conversation rhythm. No contact names. */
  context: ContextBreakdown;
  intents: Array<{ bucket: string; label: string; count: number; pct: number }>;
  clusters: IntentCluster[];
  /** Recency-weighted view of your voice, and how it differs from the all-time one. Absent when every reply weighs the same. */
  recency?: RecencyReport;
  /** Saved lessons (your stated ideals) that your latest replies keep contradicting: surfaced as a question, never silently enforced forever. Empty without `lessons`. */
  drift: LessonDrift[];
  notes: string[];
}

/** History is a recency-weighted descriptive baseline: recent replies count more than old ones. */
export interface RecencyReport {
  /** How the weights were set, e.g. `half-life 180 days`. */
  basis: string;
  /** How many replies' worth of evidence the weights leave. */
  effectivePairs: number;
  weighted: StyleSlice;
  allTime: StyleSlice;
  /** Where recent behavior differs from the all-time average (your style evolving). */
  evolution: string[];
  /** Invariants that held across all history but not in your latest replies, so they are not reported as walls. */
  demotedInvariants: string[];
}

/** Situation-by-situation statistics (contact names left out; see `buildContactProfiles` for those). */
export type ContextBreakdown = Omit<ContactProfiles, 'contacts'> & { contacts: number; gate: SliceGate };

/** The header wording for the weighting in use, e.g. `observation-weighted, half-life 100 replies`. */
function recencyBasis(opts: WeightOptions): string {
  const m = resolveRecencyMode(opts, DEFAULT_HALF_LIFE_OBSERVATIONS);
  if (m.kind === 'off') return 'unweighted';
  return m.kind === 'days' ? `calendar-weighted, half-life ${Math.round(m.half)} days` : `observation-weighted, half-life ${m.half} replies`;
}

export interface AnalyzeOptions extends WeightOptions {
  /** Your stated ideals (saved lessons, or plain rule text) to check for drift against your latest replies. */
  lessons?: LessonInput[];
  /** How drift is judged (window of latest replies, minimum samples, tension rate). */
  drift?: DriftOptions;
  /** An invariant must also hold across your latest N replies (default 60); one that stopped holding is demoted, not a wall. */
  recentWindow?: number;
  buckets?: IntentBucket[];
  /** Below this many pairs no rule is proposed (too little evidence). Default 10. */
  minPairs?: number;
  /** @deprecated No longer a wall threshold: a rule is a hard invariant only at `invariantMinShare`. Kept so old configs load. */
  minShare?: number;
  /** A behavior is a true invariant (safe as a hard check) only at this share of replies (0-1). Default 0.98. */
  invariantMinShare?: number;
  /** Contrast needs at least this many exception cases. Default 5. */
  minExceptions?: number;
  /** A trigger's exception rate must be at least this many times the rest. Default 2. */
  minLift?: number;
  /** Samples kept per cluster. Default 3. */
  samplesPerCluster?: number;
  topN?: number;
  /** A situation needs at least this many replies before a context rule is proposed. Default 5. */
  minSegment?: number;
  /** A situation needs at least this many replies to become a generalized rule. Default 30. */
  minSlicePairs?: number;
  /** ... and replies to at least this many different contacts. Default 5. */
  minDistinctContacts?: number;
  /** ... with no single contact above this share (0-1) of it. Default 0.4. */
  maxTopContactShare?: number;
  /** ... and at least this share (0-1) of its contacts must individually deviate the same way. Default 0.6. */
  minContactAgreement?: number;
}

export const sliceGateFrom = (o: Partial<SliceGate> = {}): SliceGate => ({
  minSlicePairs: o.minSlicePairs ?? DEFAULT_SLICE_GATE.minSlicePairs,
  minDistinctContacts: o.minDistinctContacts ?? DEFAULT_SLICE_GATE.minDistinctContacts,
  maxTopContactShare: o.maxTopContactShare ?? DEFAULT_SLICE_GATE.maxTopContactShare,
  minContactAgreement: o.minContactAgreement ?? DEFAULT_SLICE_GATE.minContactAgreement,
});

function voiceOf(pairs: HistoryPair[]): VoiceFingerprint {
  const replies = pairs.map((p) => p.reply.trim());
  const n = replies.length;
  const rate = (count: number): Rate => ({ count, pct: n ? round1((count / n) * 100) : 0 });
  const counts = replies.map(words).sort((a, b) => a - b);
  const withLetter = replies.filter((r) => /\p{L}/u.test(r));
  const lower = withLetter.filter((r) => {
    const first = /\p{L}/u.exec(r)![0];
    return first === first.toLowerCase() && first !== first.toUpperCase();
  }).length;
  const greetings = tally(replies.filter((r) => GREETING.test(r)), (r) => GREETING.exec(r)![1]!.toLowerCase());
  const signOffs = tally(replies.filter((r) => SIGN_OFF.test(r)), (r) => SIGN_OFF.exec(r)![1]!.toLowerCase());
  const delays = pairs
    .map((p) => (p.incomingAt && p.replyAt ? (Date.parse(p.replyAt) - Date.parse(p.incomingAt)) / 60000 : NaN))
    .filter((m) => Number.isFinite(m) && m >= 0);

  return {
    replies: n,
    words: { median: median(counts), p90: percentile(counts, 0.9), max: counts.at(-1) ?? 0 },
    shortReplies: rate(counts.filter((w) => w < SHORT_WORDS).length),
    lowercaseStart: { count: lower, pct: withLetter.length ? round1((lower / withLetter.length) * 100) : 0 },
    trailingPeriod: rate(replies.filter((r) => /\.$/.test(r) && !/\.\.$/.test(r)).length),
    exclamation: rate(replies.filter((r) => r.includes('!')).length),
    question: rate(replies.filter((r) => r.includes('?')).length),
    emoji: rate(replies.filter((r) => EMOJI.test(r)).length),
    emDashes: { total: replies.reduce((s, r) => s + (r.match(/—/g)?.length ?? 0), 0), repliesWith: rate(replies.filter((r) => r.includes('—')).length) },
    greetings: { rate: rate([...greetings.values()].reduce((a, b) => a + b, 0)), top: top(greetings, 3).map(([text, count]) => ({ text, count })) },
    signOffs: { rate: rate([...signOffs.values()].reduce((a, b) => a + b, 0)), top: top(signOffs, 3).map(([text, count]) => ({ text, count })) },
    ...(delays.length ? { replyDelayMinutes: { median: round1(median(delays)), pairs: delays.length } } : {}),
  };
}

/**
 * True invariants: exactly true of at least `invariantMinShare` (default 98%) of the human's own replies. Pure arithmetic.
 * Anything below that has real exceptions and is NOT a wall: see `conditionalAnalysis` for the `if / else` instead.
 */
function invariantsFrom(pairs: HistoryPair[], v: VoiceFingerprint, share: number): CandidateRule[] {
  const n = v.replies;
  const replies = pairs.map((p) => p.reply.trim());
  const out: CandidateRule[] = [];
  const add = (id: string, layer: LessonLayer, rule: string, count: number, evidence: string): void => {
    if (isInvariantShare(count, n, share)) out.push({ id, layer, rule, support: { count, of: n }, evidence: `${count} of ${n} replies (${round1((count / n) * 100)}%): ${evidence}` });
  };

  add('short-replies', 'principle', `Keep replies short and direct (the median reply is ${v.words.median} words).`, v.shortReplies.count, `under ${SHORT_WORDS} words`);
  // A cap is a wall, so it sits at the point where `share` of replies fit under it, never at a lower percentile.
  const counts = replies.map(words).sort((a, b) => a - b);
  const cap = Math.ceil(Math.max(percentile(counts, share), 1) / 5) * 5;
  if (cap <= 100) add('word-cap', 'code', `Keep replies to at most ${cap} words.`, counts.filter((w) => w <= cap).length, `at most ${cap} words`);
  add('no-em-dash', 'code', 'Do not use em dashes.', n - v.emDashes.repliesWith.count, 'no em dash');
  add('no-trailing-period', 'code', 'Do not end a reply with a period.', n - v.trailingPeriod.count, 'no trailing period');
  add('no-exclamation', 'code', 'Do not use exclamation marks.', n - v.exclamation.count, 'no exclamation mark');
  add('no-emoji', 'code', 'Do not use emoji.', n - v.emoji.count, 'no emoji');
  const letters = replies.filter((r) => /\p{L}/u.test(r)).length;
  if (letters) add('lowercase-start', 'code', 'Start replies with a lowercase letter.', v.lowercaseStart.count, 'starts lowercase');
  add('no-greeting', 'principle', 'Skip the greeting and answer straight away.', n - v.greetings.rate.count, 'no greeting');
  add('no-sign-off', 'principle', 'Do not add a sign-off.', n - v.signOffs.rate.count, 'no sign-off');
  return out;
}

interface Segment {
  id: string;
  label: string;
  /** Conditions combined; when two situations cover exactly the same replies, the more specific one is kept. */
  depth: number;
  pairs: HistoryPair[];
}

const pctText = (rate: number): string => `${Math.round(rate * 100)}%`;

/**
 * Situational candidate rules (layer `context`). Pairs are cut by closeness tier, DM vs. group, channel and
 * conversation rhythm (alone and combined); a rule is emitted only when that situation's median reply length differs
 * from your overall median by at least 3 words and 40%, or its greeting / sign-off rate differs by 30 points.
 * Support is exact: how many replies in that situation are on the rule's side of your overall median (or do / don't greet).
 */
export function situationalRules(pairs: HistoryPair[], profiles: ContactProfiles, opts: SituationalRuleOptions = {}): CandidateRule[] {
  return situationalAnalysis(pairs, profiles, opts).rules;
}

export interface SituationalRuleOptions extends Partial<SliceGate> {
  /** Recency weight per pair (see `pairWeigher`). Support counts stay raw; the style numbers compared are weighted. */
  weight?: (p: HistoryPair) => number;
  minSegment?: number;
  max?: number;
}

/** Of the contacts in a situation, how many individually deviate (by their own median / rate) the same way as the situation does. Every contact counts once, however chatty. */
function contactAgreement(group: HistoryPair[], direction: 1 | -1, metric: (pairs: HistoryPair[]) => number, baseline: number): { agree: number; of: number } {
  const bySender = new Map<string, HistoryPair[]>();
  for (const p of group) bySender.set(p.sender, [...(bySender.get(p.sender) ?? []), p]);
  let agree = 0;
  for (const list of bySender.values()) if (Math.sign(metric(list) - baseline) === direction) agree++;
  return { agree, of: bySender.size };
}

/**
 * `situationalRules` plus a transparent list of situations that differ from your overall style but were held back.
 * A situation may only become a generalized rule when it has enough replies, enough different contacts, no
 * dominant contact, and (the confounding check) at least `minContactAgreement` of its contacts, each weighted equally,
 * individually deviate from your overall baseline the same way. Otherwise it is a person (or topic) effect, not a
 * channel / closeness / DM-group effect, and it is reported in `suppressed` and left to the per-contact lookup.
 */
export function situationalAnalysis(pairs: HistoryPair[], profiles: ContactProfiles, opts: SituationalRuleOptions = {}): { rules: CandidateRule[]; suppressed: string[] } {
  const minSegment = opts.minSegment ?? 5;
  const gate = sliceGateFrom(opts);
  const total = pairs.length;
  if (!total) return { rules: [], suppressed: [] };
  const overall = styleOfPairs(pairs, opts.weight);
  const tierOf = new Map(profiles.contacts.map((c) => [c.sender, c.tier] as const));
  const multiChannel = profiles.byChannel.length > 1;
  const segments: Segment[] = [];
  const add = (id: string, label: string, depth: number, match: (p: HistoryPair) => boolean): void => {
    const group = pairs.filter(match);
    if (group.length >= minSegment && group.length <= total * 0.9) segments.push({ id, label, depth, pairs: group });
  };
  const kinds = ['dm', 'group'] as const;
  const kindLabel = { dm: 'DMs', group: 'group chats' } as const;
  for (const tier of TIERS) add(`tier-${tier}`, `${tier} contacts`, 1, (p) => tierOf.get(p.sender) === tier);
  for (const kind of kinds) add(`kind-${kind}`, kindLabel[kind], 1, (p) => chatKindOf(p) === kind);
  if (multiChannel) for (const c of profiles.byChannel) add(`channel-${c.channel}`, `${channelName(c.channel)} messages`, 1, (p) => p.channel === c.channel);
  for (const r of ['live', 'same-day', 'cold'] as const) add(`rhythm-${r}`, `${RHYTHM_LABELS[r]} threads`, 1, (p) => rhythmOf(p) === r);
  for (const tier of TIERS) {
    for (const r of ['live', 'cold'] as const) add(`tier-${tier}-${r}`, `${tier} contacts in ${RHYTHM_LABELS[r]} threads`, 2, (p) => tierOf.get(p.sender) === tier && rhythmOf(p) === r);
    for (const c of profiles.byChannel) for (const kind of kinds) add(`tier-${tier}-${c.channel}-${kind}`, `${tier} ${channelName(c.channel)} ${kindLabel[kind]}`, 3, (p) => tierOf.get(p.sender) === tier && p.channel === c.channel && chatKindOf(p) === kind);
  }

  const seen = new Set<string>();
  const suppressed: string[] = [];
  const found: Array<{ rule: CandidateRule; weight: number }> = [];
  for (const seg of segments.map((g, i) => ({ g, i })).sort((a, b) => b.g.depth - a.g.depth || a.i - b.i).map(({ g }) => g)) {
    const signature = seg.pairs.map((p) => p.id).sort().join('|');
    if (seen.has(signature)) continue; // same replies as a broader situation already covered
    seen.add(signature);
    const st = styleOfPairs(seg.pairs, opts.weight);
    const wordGap = st.medianWords - overall.medianWords;
    const wordsDiffer = Math.abs(wordGap) >= Math.max(3, overall.medianWords * 0.4);
    const greetGap = st.greetingRate - overall.greetingRate;
    const signGap = st.signOffRate - overall.signOffRate;
    const greetDiffers = Math.abs(greetGap) >= 0.3;
    const signDiffers = Math.abs(signGap) >= 0.3;
    if (!wordsDiffer && !greetDiffers && !signDiffers) continue;

    // Guardrail: a generalized rule needs breadth (replies, contacts, no dominant contact) ...
    const what = wordsDiffer ? `${wordGap > 0 ? 'longer' : 'shorter'} replies` : greetDiffers ? (greetGap > 0 ? 'more greetings' : 'fewer greetings') : signGap > 0 ? 'more sign-offs' : 'fewer sign-offs';
    const held = (why: string): void => {
      suppressed.push(`${seg.label} (${st.count} replies across ${st.distinctContacts} contact${st.distinctContacts === 1 ? '' : 's'}; top contact ${pctText(st.topContactShare)}) — ${what} but ${why}; handled per-contact instead.`);
    };
    const issue = sliceGateIssue(st, gate);
    if (issue) {
      held(`${issue}, too thin or concentrated to generalize`);
      continue;
    }
    // ... and the pattern must hold per person, not just on average: each contact weighs the same, whatever their volume.
    const direction: 1 | -1 = (wordsDiffer ? wordGap : greetDiffers ? greetGap : signGap) > 0 ? 1 : -1;
    const metric = wordsDiffer
      ? (g: HistoryPair[]): number => median(g.map((p) => words(p.reply)))
      : greetDiffers
        ? (g: HistoryPair[]): number => g.filter((p) => GREETING.test(p.reply.trim())).length / g.length
        : (g: HistoryPair[]): number => g.filter((p) => SIGN_OFF.test(p.reply.trim())).length / g.length;
    const baseline = wordsDiffer ? overall.medianWords : greetDiffers ? overall.greetingRate : overall.signOffRate;
    const ag = contactAgreement(seg.pairs, direction, metric, baseline);
    if (ag.agree < ag.of * gate.minContactAgreement) {
      held(`only ${ag.agree} of ${ag.of} contacts individually show it (need ${pctText(gate.minContactAgreement)}), so it is likely a person or topic effect, not a pattern of the situation`);
      continue;
    }

    const replies = seg.pairs.map((p) => p.reply.trim());
    const clauses: string[] = [];
    let support: number;
    let basis: string;
    if (wordsDiffer) {
      clauses.push(wordGap > 0 ? `use fuller sentences (~${st.medianWords} words)` : `keep replies ~${st.medianWords} words`);
      support = replies.filter((r) => (wordGap > 0 ? words(r) > overall.medianWords : words(r) < overall.medianWords)).length;
      basis = `${wordGap > 0 ? 'longer' : 'shorter'} than your overall median of ${overall.medianWords} words`;
    } else if (greetDiffers) {
      support = replies.filter((r) => GREETING.test(r) === greetGap > 0).length;
      basis = greetGap > 0 ? 'open with a greeting' : 'have no greeting';
    } else {
      support = replies.filter((r) => SIGN_OFF.test(r) === signGap > 0).length;
      basis = signGap > 0 ? 'end with a sign-off' : 'have no sign-off';
    }
    if (st.greetingRate <= 0.1 && (greetDiffers || wordsDiffer)) clauses.push('no greeting');
    else if (st.greetingRate >= 0.5) clauses.push('open with a greeting');
    if (st.signOffRate >= 0.5) clauses.push('sign off');
    else if (signDiffers && st.signOffRate <= 0.1) clauses.push('no sign-off');
    if (!clauses.length) clauses.push(`keep replies ~${st.medianWords} words`);
    const n = seg.pairs.length;
    found.push({
      weight: n * (wordsDiffer ? Math.abs(wordGap) / Math.max(1, overall.medianWords) : 0.3),
      rule: {
        id: `context-${seg.id}`,
        layer: 'context',
        rule: `For ${seg.label}, ${clauses.join(', ')}.`,
        support: { count: support, of: n },
        evidence: `${support} of ${n} replies (${round1((support / n) * 100)}%) to ${seg.label} ${basis}. Median ${st.medianWords} vs ${overall.medianWords} words overall; greeting ${pctText(st.greetingRate)} vs ${pctText(overall.greetingRate)}; sign-off ${pctText(st.signOffRate)} vs ${pctText(overall.signOffRate)}.`,
      },
    });
  }
  return { rules: found.sort((a, b) => b.weight - a.weight || a.rule.id.localeCompare(b.rule.id)).slice(0, opts.max ?? 6).map((f) => f.rule), suppressed };
}

const pc0 = (r: number): string => `${Math.round(r * 100)}%`;

/** Where the recency-weighted voice differs from the all-time one: your style moving, in plain words. */
function evolutionNotes(w: StyleSlice, all: StyleSlice): string[] {
  const out: string[] = [];
  const rate = (label: string, a: number, b: number): void => {
    if (Math.abs(a - b) >= 0.1) out.push(`${label}: ${pc0(a)} lately vs ${pc0(b)} over all history (${a > b ? 'up' : 'down'}).`);
  };
  rate('Greeting rate', w.greetingRate, all.greetingRate);
  rate('Sign-off rate', w.signOffRate, all.signOffRate);
  rate('Exclamation rate', w.exclamationRate, all.exclamationRate);
  rate('Emoji rate', w.emojiRate, all.emojiRate);
  rate('Lowercase starts', w.lowercaseRate, all.lowercaseRate);
  if (Math.abs(w.medianWords - all.medianWords) >= Math.max(3, all.medianWords * 0.25)) out.push(`Median reply length: ${w.medianWords} words lately vs ${all.medianWords} over all history (${w.medianWords > all.medianWords ? 'longer' : 'shorter'}).`);
  return out;
}

/**
 * Exact, verifiable statistics about your real history: volume, voice, candidate rules and recurring intents.
 * Pure and offline. Every number can be recomputed by hand from `pairs`.
 */
export function analyzeHistory(pairs: HistoryPair[], opts: AnalyzeOptions = {}): HistoryAnalysis {
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;
  const minPairs = opts.minPairs ?? 10;
  const contrast = contrastOptionsFrom({ invariantMinShare: opts.invariantMinShare, minExceptions: opts.minExceptions, minLift: opts.minLift });
  const per = opts.samplesPerCluster ?? 3;
  const topN = opts.topN ?? 10;
  const total = pairs.length;
  const pct = (n: number): number => (total ? round1((n / total) * 100) : 0);
  const notes: string[] = [];

  const byChannel = top(tally(pairs, (p) => p.channel), 50).map(([channel, count]) => ({ channel, count, pct: pct(count) }));
  const senders = new Map<string, { count: number; channels: Set<string> }>();
  for (const p of pairs) {
    const e = senders.get(p.sender) ?? { count: 0, channels: new Set<string>() };
    e.count++;
    e.channels.add(p.channel);
    senders.set(p.sender, e);
  }
  const topContacts = [...senders.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([sender, e]) => ({ sender, count: e.count, channels: [...e.channels].sort() }));
  const threads = tally(pairs.filter((p) => p.threadId), (p) => `${p.channel}\u0000${p.threadId}`);
  const topThreads = top(threads, topN).map(([k, count]) => {
    const [channel, threadId] = k.split('\u0000');
    return { threadId: threadId!, channel: channel!, count };
  });
  const dated = pairs.map((p) => p.incomingAt ?? p.replyAt).filter((d): d is string => !!d && Number.isFinite(Date.parse(d))).sort();

  const voice = voiceOf(pairs);
  let invariants: CandidateRule[] = [];
  let conditionalRules: ConditionalRule[] = [];
  if (total < minPairs) notes.push(`Only ${total} pair(s): at least ${minPairs} are needed before proposing rules from your style.`);
  else {
    invariants = invariantsFrom(pairs, voice, contrast.invariantMinShare);
    conditionalRules = conditionalAnalysis(pairs, tierBySender(pairs), contrast);
  }

  // Recency: history is a weighted baseline. An "always" that stopped being true lately is not a wall.
  const weight = pairWeigher(pairs, opts);
  const weighted = weight ? styleOfPairs(pairs, weight) : undefined;
  let recency: RecencyReport | undefined;
  if (weight && weighted?.effectiveCount !== undefined) {
    const demoted: string[] = [];
    const recentN = Math.max(minPairs, Math.floor(opts.recentWindow ?? 60));
    if (invariants.length && total > recentN) {
      const recentPairs = chronological(pairs).slice(-recentN);
      const stillHolds = new Set(invariantsFrom(recentPairs, voiceOf(recentPairs), contrast.invariantMinShare).map((r) => r.id));
      invariants = invariants.filter((r) => {
        if (stillHolds.has(r.id)) return true;
        demoted.push(r.rule);
        return false;
      });
      for (const rule of demoted) notes.push(`"${rule}" held across all history but not in your latest ${recentN} replies, so it is not reported as an invariant (your habits moved).`);
    }
    const allTime = styleOfPairs(pairs);
    recency = {
      basis: recencyBasis(opts),
      effectivePairs: weighted.effectiveCount,
      weighted,
      allTime,
      evolution: evolutionNotes(weighted, allTime),
      demotedInvariants: demoted,
    };
  }
  const drift = opts.lessons?.length ? detectLessonDrift(opts.lessons, pairs, opts.drift) : [];

  const profiles = buildContactProfiles(pairs, { ...opts, buckets });
  const { contacts, ...rest } = profiles;
  const gate = sliceGateFrom(opts);
  const context: ContextBreakdown = { ...rest, contacts: contacts.length, gate };
  const situational = total < minPairs ? { rules: [], suppressed: [] } : situationalAnalysis(pairs, profiles, { minSegment: opts.minSegment ?? 5, ...gate, ...(weight ? { weight } : {}) });
  const contextRules = situational.rules;
  const suppressedSlices = situational.suppressed;

  const cell = new Map<string, HistoryPair[]>();
  const labels = new Map<string, string>([...buckets.map((b) => [b.id, b.label] as [string, string]), [OTHER_BUCKET.id, OTHER_BUCKET.label]]);
  for (const p of pairs) {
    const k = `${p.channel}\u0000${classify(p, buckets)}`;
    cell.set(k, [...(cell.get(k) ?? []), p]);
  }
  const clusters: IntentCluster[] = [...cell.entries()]
    .map(([k, group]) => {
      const [channel, bucket] = k.split('\u0000') as [string, string];
      const picks = evenly(group, per);
      return {
        bucket,
        label: labels.get(bucket) ?? bucket,
        channel,
        count: group.length,
        pct: pct(group.length),
        medianReplyWords: median(group.map((p) => words(p.reply))),
        samples: picks.map((p) => ({ id: p.id, incoming: snippet(p.incoming), reply: snippet(p.reply) })),
      };
    })
    .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel) || a.bucket.localeCompare(b.bucket));
  const intentCounts = tally(pairs, (p) => classify(p, buckets));
  const intents = top(intentCounts, 50).map(([bucket, count]) => ({ bucket, label: labels.get(bucket) ?? bucket, count, pct: pct(count) }));

  return {
    total,
    ...(dated.length ? { span: { from: dated[0]!, to: dated.at(-1)! } } : {}),
    byChannel,
    topContacts,
    topThreads,
    voice,
    invariants,
    invariantMinShare: contrast.invariantMinShare,
    conditionalRules,
    contextRules,
    suppressedSlices,
    context,
    intents,
    clusters,
    ...(recency ? { recency } : {}),
    drift,
    notes,
  };
}

/** `n` items spread evenly through a list (deterministic). */
function evenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]!);
}

/** " (3 contacts — person-specific, not generalized)" next to the reply count: why a small or one-person slice is not a global rule. */
const contactsNote = (c: StyleSlice, gate: SliceGate): string => {
  const n = c.distinctContacts;
  return ` (${n} contact${n === 1 ? '' : 's'}${sliceGateIssue(c, gate) ? ' — person-specific, not generalized' : ''})`;
};
const pc = (rate: number): string => `${Math.round(rate * 100)}%`;
const sliceLine = (label: string, c: StyleSlice, extra = '', gate?: SliceGate): string =>
  `  ${label}: ${c.count} repl${c.count === 1 ? 'y' : 'ies'}${gate ? contactsNote(c, gate) : ''}${extra}, median ${c.medianWords} words (90th pct ${c.p90Words}), greeting ${pc(c.greetingRate)}, sign-off ${pc(c.signOffRate)}, emoji ${pc(c.emojiRate)}, lowercase ${pc(c.lowercaseRate)}${c.medianReplyMins !== undefined ? `, replies in ~${c.medianReplyMins} min` : ''}`;

/** The situational breakdown: who, DM vs. group, channel, conversation rhythm. One flat average hides all of this. */
export function formatContext(c: ContextBreakdown): string[] {
  if (!c.total) return [];
  const lines: string[] = ['', 'Your voice by situation (a single average hides this):'];
  lines.push('  By closeness (from how often you actually talk):');
  for (const t of c.byTier.filter((t) => t.count)) lines.push(sliceLine(`  ${t.tier}`, t, '', c.gate));
  if (c.byChatKind.length) {
    lines.push('  DM vs. group chat:');
    for (const k of c.byChatKind) lines.push(sliceLine(`  ${k.kind === 'dm' ? 'DM' : 'group chat'}`, k, '', c.gate));
    if (c.known.chatKind < c.total) lines.push(`    (${c.total - c.known.chatKind} older pair(s) do not say whether they were group chats.)`);
  } else lines.push('  DM vs. group chat: unknown. Pairs from extractPairsFromMessages carry it; older ones do not.');
  lines.push('  By channel:');
  for (const ch of c.byChannel) lines.push(sliceLine(`  ${channelName(ch.channel)}`, ch, ch.replyRate !== undefined ? `, you answer ${pc(ch.replyRate)} of what arrives` : '', c.gate));
  if (c.byRhythm.length) {
    lines.push('  By conversation rhythm (time since the previous message in the thread):');
    for (const r of c.byRhythm) lines.push(sliceLine(`  ${RHYTHM_LABELS[r.rhythm]} (${r.rhythm === 'live' ? '< 10 min' : r.rhythm === 'cold' ? '> 24 h' : 'same day'})`, r));
  } else lines.push('  By conversation rhythm: unknown. Pairs from extractPairsFromMessages carry the gap; older ones do not.');
  return lines;
}

/** Plain-English report for the CLI. */
export function formatAnalysis(a: HistoryAnalysis): string[] {
  if (!a.total) return ['No history yet. Run: rufus seed <file> --flow <flowId>'];
  const v = a.voice;
  const lines = [
    `${a.total} real reply pair(s)${a.span ? ` from ${a.span.from.slice(0, 10)} to ${a.span.to.slice(0, 10)}` : ''}.`,
    `Channels: ${a.byChannel.map((c) => `${c.channel} ${c.count} (${c.pct}%)`).join(', ')}`,
    `Most frequent senders: ${a.topContacts.slice(0, 5).map((c) => `${c.sender} (${c.count})`).join(', ')}`,
    '',
    'How you write:',
    `  Reply length: median ${v.words.median} words, 90th percentile ${v.words.p90}, longest ${v.words.max}. ${v.shortReplies.count} of ${v.replies} are under ${SHORT_WORDS} words.`,
    `  Starts lowercase ${v.lowercaseStart.count}x (${v.lowercaseStart.pct}%), ends with a period ${v.trailingPeriod.count}x (${v.trailingPeriod.pct}%).`,
    `  Em dashes: ${v.emDashes.total} in ${v.emDashes.repliesWith.count} reply(ies). Exclamations ${v.exclamation.count}x (${v.exclamation.pct}%), questions ${v.question.count}x (${v.question.pct}%), emoji ${v.emoji.count}x.`,
    `  Greeting in ${v.greetings.rate.count} (${v.greetings.rate.pct}%)${v.greetings.top.length ? `, most often "${v.greetings.top[0]!.text}"` : ''}. Sign-off in ${v.signOffs.rate.count} (${v.signOffs.rate.pct}%)${v.signOffs.top.length ? `, most often "${v.signOffs.top[0]!.text}"` : ''}.`,
  ];
  if (v.replyDelayMinutes) lines.push(`  Typical reply time: ${v.replyDelayMinutes.median} minutes (${v.replyDelayMinutes.pairs} timed pairs).`);
  if (a.recency) {
    const r = a.recency;
    lines.push(`  Recency-weighted (${r.basis}, ~${r.effectivePairs} replies' worth of evidence): median ${r.weighted.medianWords} words, greeting ${pc(r.weighted.greetingRate)}, sign-off ${pc(r.weighted.signOffRate)}. History is a descriptive baseline: recent replies count more.`);
    for (const e of r.evolution) lines.push(`  Evolving: ${e}`);
  }
  lines.push('', 'What people write to you about:');
  for (const i of a.intents) lines.push(`  ${i.label}: ${i.count} (${i.pct}%)`);
  const shown = a.clusters.filter((c) => c.bucket !== OTHER_BUCKET.id).slice(0, 6);
  if (shown.length) {
    lines.push('', 'Biggest recurring patterns (channel + intent):');
    for (const c of shown) lines.push(`  ${c.channel} / ${c.label}: ${c.count} (${c.pct}%), you reply in ~${c.medianReplyWords} words. e.g. "${c.samples[0]!.incoming}" -> "${c.samples[0]!.reply}"`);
  }
  lines.push(...formatContext(a.context));
  lines.push('');
  const pctOf = (r: CandidateRule): string => `${r.support.count}/${r.support.of} = ${round1((r.support.count / r.support.of) * 100)}%`;
  lines.push('', `Invariants (safe as hard code/verify checks, ≥${round1(a.invariantMinShare * 100)}%):`);
  if (a.invariants.length) for (const r of a.invariants) lines.push(`  [invariant] ${r.rule}  (${pctOf(r)})`);
  else lines.push('  none: nothing was true of nearly every reply.');
  lines.push('', 'Conditional logic (real exceptions — use branching logic, not walls):');
  if (a.conditionalRules.length) for (const r of a.conditionalRules) lines.push(`  [logic] ${r.rule}`);
  else lines.push('  none: no behavior has enough real exceptions to contrast.');
  if (a.drift?.length) {
    lines.push('', 'Tension / drift (your saved lessons are ideals and still apply, but your latest replies disagree):');
    for (const d of a.drift) lines.push(`  [drift] ${d.message}`);
  }
  if (a.contextRules.length) {
    lines.push('', 'Situational context rules (diverse multi-contact slices):');
    for (const r of a.contextRules) lines.push(`  [${r.layer}] ${r.rule}  (${r.support.count}/${r.support.of})`);
  }
  if (a.suppressedSlices?.length) {
    lines.push('', 'Not generalized (differs from your overall style, but too thin, too concentrated, or only a few contacts agree):');
    for (const note of a.suppressedSlices) lines.push(`  ${note}`);
  }
  for (const note of a.notes) lines.push(note);
  return lines;
}

// ---------- Optional AI synthesis ----------

export interface WorkflowBlueprint {
  name: string;
  /** How often it happens, in words that quote the counts from the stats. */
  frequency: string;
  trigger: string;
  /** What exact code should do (lookups, parsing, checks). */
  code: string;
  /** What the AI should do (drafting, judging). */
  ai: string;
  /** Where the human approves. */
  human: string;
}

export interface CandidateLesson {
  rule: string;
  layer: LessonLayer;
  support?: string;
}

export interface Synthesis {
  provider: string;
  attempts: number;
  blueprints: WorkflowBlueprint[];
  lessons: CandidateLesson[];
}

export const DEFAULT_AI_SAMPLE = 24;
const MAX_BLUEPRINTS = 5;
const MAX_LESSONS = 8;

/**
 * A small, code-picked sample: round-robin over the biggest intent buckets so every recurring pattern is
 * represented, evenly spaced inside each. Message text is trimmed; names are left out.
 */
export function representativeSample(pairs: HistoryPair[], buckets: IntentBucket[], n: number, tiers?: Map<string, ClosenessTier>): Array<PairSample & { intent: string; situation?: { closeness: ClosenessTier; chat?: string; rhythm?: string } }> {
  const groups = new Map<string, HistoryPair[]>();
  for (const p of pairs) {
    const id = classify(p, buckets);
    groups.set(id, [...(groups.get(id) ?? []), p]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const picks = new Map(ordered.map(([id, g]) => [id, evenly(g, Math.min(g.length, n))]));
  const out: Array<PairSample & { intent: string; situation?: { closeness: ClosenessTier; chat?: string; rhythm?: string } }> = [];
  for (let round = 0; out.length < n; round++) {
    let any = false;
    for (const [id] of ordered) {
      const p = picks.get(id)![round];
      if (!p) continue;
      any = true;
      if (out.length < n) {
        const closeness = tiers?.get(p.sender);
        const chat = chatKindOf(p);
        const rhythm = rhythmOf(p);
        out.push({
          id: p.id,
          intent: id,
          incoming: snippet(p.incoming, 240),
          reply: snippet(p.reply, 240),
          ...(closeness ? { situation: { closeness, ...(chat ? { chat } : {}), ...(rhythm ? { rhythm } : {}) } } : {}),
        });
      }
    }
    if (!any) break;
  }
  return out;
}

function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const text = (fenced ? fenced[1]! : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(text.slice(start, end + 1));
}

const LAYERS: LessonLayer[] = ['code', 'context', 'principle'];

function parseSynthesis(raw: string): { blueprints: WorkflowBlueprint[]; lessons: CandidateLesson[] } {
  const j = extractJson(raw) as { blueprints?: unknown; lessons?: unknown };
  const str = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`"${field}" must be a non-empty string`);
    return v.trim();
  };
  if (!Array.isArray(j.blueprints)) throw new Error('"blueprints" must be an array');
  if (!Array.isArray(j.lessons)) throw new Error('"lessons" must be an array');
  const blueprints = j.blueprints.slice(0, MAX_BLUEPRINTS).map((b: Record<string, unknown>, i) => ({
    name: str(b?.name, `blueprints[${i}].name`),
    frequency: str(b?.frequency, `blueprints[${i}].frequency`),
    trigger: str(b?.trigger, `blueprints[${i}].trigger`),
    code: str(b?.code, `blueprints[${i}].code`),
    ai: str(b?.ai, `blueprints[${i}].ai`),
    human: str(b?.human, `blueprints[${i}].human`),
  }));
  const lessons = j.lessons.slice(0, MAX_LESSONS).map((l: Record<string, unknown>, i) => {
    if (!LAYERS.includes(l?.layer as LessonLayer)) throw new Error(`lessons[${i}].layer must be one of: ${LAYERS.join(', ')}`);
    return { rule: str(l.rule, `lessons[${i}].rule`), layer: l.layer as LessonLayer, ...(typeof l.support === 'string' && l.support.trim() ? { support: l.support.trim() } : {}) };
  });
  return { blueprints, lessons };
}

const SYSTEM = [
  "You help someone turn their real message history into durable AI + Code + Human workflows.",
  'You are given exact statistics computed by code and a small sample of real exchanges. Trust the statistics; the sample only illustrates them.',
  'Never invent counts. Quote the counts you are given. Do not repeat private details from the sample.',
  'Answer with one JSON object and nothing else.',
].join('\n');

/**
 * Ask a provider to name the recurring workflows and propose lessons, from code-assembled stats plus a compact
 * sample. Raw history is never sent: contact names are withheld, texts are trimmed, the sample is capped.
 */
export async function synthesizeHistory(
  provider: AiProvider,
  analysis: HistoryAnalysis,
  pairs: HistoryPair[],
  opts: { providerName?: string; sampleSize?: number; buckets?: IntentBucket[] } = {},
): Promise<Synthesis> {
  const sample = representativeSample(pairs, opts.buckets ?? DEFAULT_BUCKETS, opts.sampleSize ?? DEFAULT_AI_SAMPLE, tierBySender(pairs));
  const stats = {
    totalPairs: analysis.total,
    span: analysis.span,
    channels: analysis.byChannel,
    topContactShares: analysis.topContacts.slice(0, 5).map((c, i) => ({ contact: `contact ${i + 1}`, count: c.count })),
    voice: analysis.voice,
    // True invariants (>= 98%): safe as hard checks. Behaviors with real exceptions are NOT walls: they are conditional logic.
    invariants: analysis.invariants.map(({ id, layer, rule, support }) => ({ id, layer, rule, support })),
    conditionalRules: analysis.conditionalRules.map(({ id, behavior, layer, rule, exceptions, explained, triggers }) => ({ id, behavior, layer, rule, exceptions, explained, triggers: triggers.map(({ feature, whenTrue, whenFalse, lift }) => ({ feature, whenTrue, whenFalse, lift })) })),
    contextRules: analysis.contextRules.map(({ id, layer, rule, support }) => ({ id, layer, rule, support })),
    // Differences that were deliberately NOT generalized (confounded by one or two people). Do not turn these into rules.
    notGeneralized: analysis.suppressedSlices,
    // Situational slices, anonymized: tiers are counts of contacts, never names.
    situations: {
      byCloseness: analysis.context.byTier.filter((t) => t.count),
      byChatKind: analysis.context.byChatKind,
      byChannel: analysis.context.byChannel,
      byRhythm: analysis.context.byRhythm,
      byChannelIntent: analysis.context.byChannelIntent.slice(0, 12),
    },
    intents: analysis.intents,
    clusters: analysis.clusters.slice(0, 12).map(({ bucket, channel, count, pct, medianReplyWords }) => ({ bucket, channel, count, pct, medianReplyWords })),
  };
  const prompt = [
    'Propose how to automate the recurring parts of this person\'s replies.',
    `Return JSON: {"blueprints":[{"name","frequency","trigger","code","ai","human"}],"lessons":[{"rule","layer","support"}]}.`,
    `- At most ${MAX_BLUEPRINTS} blueprints, the most frequent first. "frequency" quotes counts from the stats. "trigger" says what starts it. "code" is what exact code does (lookups, parsing, checks, and situational lookups such as the sender's closeness tier, DM vs. group, channel and conversation rhythm). "ai" is what the model does (drafting or judging only). "human" is where the person approves.`,
    `- Reply style depends on the situation, not one global average. "stats.situations" splits the same replies by closeness tier (inner-circle, regular, occasional, new), DM vs. group, channel and conversation rhythm (live < 10 min, same-day, cold > 24 h). Make blueprints and lessons situation-aware where those slices clearly differ, and quote their exact numbers. Do not invent a situation the slices do not show.`,
    `- At most ${MAX_LESSONS} lessons. Each is one short imperative rule about how to reply. "layer" is "code" (exactly checkable, belongs in a verify function), "context" (the model needs a fact that code should fetch), or "principle" (taste or tone). Prefer the rules in the stats; "support" quotes their counts.`,
    `- "stats.invariants" are true for nearly every reply (>= 98%) and may become "code" lessons. "stats.conditionalRules" are behaviors with real exceptions: write each as an if / else lesson (layer "context") that names the trigger and quotes its rates. NEVER turn a conditional rule into a blanket ban or cap ("never greet", "max 35 words"): that breaks its real exceptions. When a conditional rule has no trigger (explained: false), keep it flexible and do not make a lesson of it.`,
  ].join('\n');

  const providerName = opts.providerName ?? 'default';
  const { value, attempts } = await runAiStep({
    provider,
    system: SYSTEM,
    step: 'mine',
    opts: { prompt, context: { stats, sample }, parse: parseSynthesis, json: true, maxRetries: 2 },
    meta: { runId: 'mine', flowId: 'mine' },
  });
  return { provider: providerName, attempts, ...value };
}

// ---------- Orchestration ----------

export interface MineOptions extends AnalyzeOptions, Pick<HoldoutOptions, 'holdoutFraction'> {
  /** Also ask a provider for blueprints and lessons. */
  ai?: boolean;
  /** Named provider for the AI pass (e.g. `smart`). */
  provider?: string;
  /** Analyze only the most recent N pairs. */
  limit?: number;
  sampleSize?: number;
}

export interface MineReport {
  generatedAt: string;
  pairsAnalyzed: number;
  analysis: HistoryAnalysis;
  /** Learned from your older pairs, scored on your newest (never seen while learning). */
  holdout?: HoldoutResult;
  ai?: Synthesis;
}

/** The provider `rufus mine --ai` uses when none is named: `config.mine.provider`, else `smart` if you configured one. */
export function defaultMineProvider(config: Pick<RufusConfig, 'providers' | 'mine'>): string | undefined {
  return config.mine?.provider ?? (config.providers?.smart ? 'smart' : undefined);
}

export async function mineHistory(engine: Engine, opts: MineOptions = {}): Promise<MineReport> {
  if (opts.limit !== undefined && !(opts.limit > 0)) throw new Error('limit must be a positive number.');
  let pairs = await loadPairs(engine.store);
  if (opts.limit !== undefined) pairs = pairs.slice(-Math.floor(opts.limit));
  const lessons = opts.lessons ?? (await engine.lessons.all()).filter((l) => !l.hardened);
  const analysis = analyzeHistory(pairs, { ...opts, lessons });
  const report: MineReport = { generatedAt: new Date().toISOString(), pairsAnalyzed: pairs.length, analysis };
  if (pairs.length) report.holdout = evaluateHoldout(pairs, opts);
  if (opts.ai && pairs.length) {
    // Resolve the provider first so an unknown name fails before any work.
    const provider = engine.providerFor(opts.provider);
    report.ai = await synthesizeHistory(provider, analysis, pairs, { providerName: opts.provider, sampleSize: opts.sampleSize, buckets: opts.buckets });
  }
  return report;
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** `rufus propose ...` line for a lesson, ready to paste. */
export function proposeCommand(l: Pick<CandidateLesson, 'rule' | 'layer'>, scope: string): string {
  return `rufus propose ${shellQuote(scope)} ${shellQuote(l.rule)} --layer ${l.layer}`;
}

export function formatMine(r: MineReport, opts: { scope?: string } = {}): string[] {
  const lines = formatAnalysis(r.analysis);
  if (r.holdout) lines.push(...formatHoldout(r.holdout));
  if (!r.ai) return lines;
  const scope = opts.scope ?? 'global';
  lines.push('', `Workflow blueprints (AI, ${r.ai.provider} provider):`);
  if (!r.ai.blueprints.length) lines.push('  none proposed.');
  r.ai.blueprints.forEach((b, i) => {
    lines.push(`  ${i + 1}. ${b.name} (${b.frequency})`, `     starts when: ${b.trigger}`, `     code: ${b.code}`, `     ai: ${b.ai}`, `     you approve: ${b.human}`);
  });
  lines.push('', 'Candidate lessons (try each with the command; replay saves it only if nothing regresses):');
  if (!r.ai.lessons.length) lines.push('  none proposed.');
  for (const l of r.ai.lessons) lines.push(`  [${l.layer}] ${l.rule}${l.support ? `  (${l.support})` : ''}`, `    ${proposeCommand(l, scope)}`);
  return lines;
}
