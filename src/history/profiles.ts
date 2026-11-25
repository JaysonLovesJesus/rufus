// Code-first relationship and context profiling. Every number here is exact arithmetic over your own pairs:
// no AI, no I/O. `buildContactProfiles` summarises the history; `buildSituationalContext` looks one message up in it.
import type { ReplyHabit } from './extract';
import type { PriorMessage, HistoryPair } from './types';
import { DEFAULT_BUCKETS, EMOJI, GREETING, OTHER_BUCKET, SIGN_OFF, classify, median, percentile, snippet, words, type IntentBucket } from './stats';

// ---------- Vocabulary ----------

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

export function styleOf(pairs: HistoryPair[]): StyleSlice {
  const replies = pairs.map((p) => p.reply.trim());
  const n = replies.length;
  const rate = (k: number, of = n): number => (of ? round3(k / of) : 0);
  const counts = replies.map(words).sort((a, b) => a - b);
  const withLetter = replies.filter((r) => /\p{L}/u.test(r));
  const lower = withLetter.filter((r) => {
    const first = /\p{L}/u.exec(r)![0];
    return first === first.toLowerCase() && first !== first.toUpperCase();
  }).length;
  const delays = pairs.map(delayMins).filter((m): m is number => m !== undefined);
  return {
    count: n,
    medianWords: median(counts),
    p90Words: percentile(counts, 0.9),
    greetingRate: rate(replies.filter((r) => GREETING.test(r)).length),
    signOffRate: rate(replies.filter((r) => SIGN_OFF.test(r)).length),
    emojiRate: rate(replies.filter((r) => EMOJI.test(r)).length),
    exclamationRate: rate(replies.filter((r) => r.includes('!')).length),
    lowercaseRate: rate(lower, withLetter.length),
    ...(delays.length ? { medianReplyMins: round1(median(delays)) } : {}),
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

export interface ProfileOptions {
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
    for (const r of RHYTHMS) if (rhythms.has(r)) byRhythm[r] = styleOf(rhythms.get(r)!);
    return {
      sender,
      channels: [...new Set(group.map((p) => p.channel))].sort(),
      tier,
      dmCount: group.filter((p) => chatKindOf(p) === 'dm').length,
      groupCount: group.filter((p) => chatKindOf(p) === 'group').length,
      ...(live !== undefined ? { liveShare: live } : {}),
      ...replyRate(habitsBySender.get(sender)),
      style: styleOf(group),
      byRhythm,
    };
  });
  contacts.sort((a, b) => byCountThenName(a.style, b.style, a.sender, b.sender));

  const byTier: TierProfile[] = TIERS.map((tier) => {
    const members = pairs.filter((p) => tierOfSender.get(p.sender) === tier);
    return { tier, contacts: contacts.filter((c) => c.tier === tier).length, ...styleOf(members) };
  });
  const byChatKind: ChatKindProfile[] = (['dm', 'group'] as const)
    .map((kind) => ({ kind, group: pairs.filter((p) => chatKindOf(p) === kind) }))
    .filter((e) => e.group.length)
    .map(({ kind, group }) => ({ kind, ...styleOf(group) }));
  const byChannel: ChannelProfile[] = [...groupBy(pairs, (p) => p.channel).entries()]
    .map(([channel, group]) => ({ channel, ...styleOf(group), ...replyRate(habitsByChannel.get(channel)) }))
    .sort((a, b) => byCountThenName(a, b, a.channel, b.channel));
  const byRhythm: RhythmProfile[] = RHYTHMS.map((rhythm) => ({ rhythm, group: pairs.filter((p) => rhythmOf(p) === rhythm) }))
    .filter((e) => e.group.length)
    .map(({ rhythm, group }) => ({ rhythm, ...styleOf(group) }));
  const byChannelIntent: ChannelIntentProfile[] = [...groupBy(pairs, (p) => `${p.channel}\u0000${classify(p, buckets)}`).entries()]
    .map(([k, group]) => {
      const [channel, intent] = k.split('\u0000') as [string, string];
      return { channel, intent, ...styleOf(group) };
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
  /** One compact line for a prompt. */
  voiceHint: string;
}

export interface SituationOptions extends ProfileOptions {
  /** Examples to return (clamped to 2-4). Default 3. */
  examples?: number;
  /** A slice needs at least this many pairs to be trusted. Default 3. */
  minSlice?: number;
  /** Pre-built profiles for `pairs` (build once, look up many times). */
  profiles?: ContactProfiles;
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
    ['channel+chat+intent', () => (intent === OTHER_BUCKET.id ? undefined : styleOf(pairs.filter((p) => sameChat(p) && classify(p, buckets) === intent)))],
    ['channel+chat', () => styleOf(pairs.filter(sameChat))],
    ['channel', () => styleOf(pairs.filter((p) => p.channel === input.channel))],
    ['overall', () => styleOf(pairs)],
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
    style = styleOf(pairs);
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
  let voiceHint: string;
  if (!style) voiceHint = `${who}${rhythmText ? `, ${rhythmText}` : ''}: no history to learn from yet.`;
  else {
    const from = basisText(styleBasis, style.count) ? ` (from ${basisText(styleBasis, style.count)})` : '';
    const thin = style.count < minSlice ? ' (thin evidence)' : '';
    voiceHint = `${who}${rhythmText ? `, ${rhythmText}` : ''}: ${describeStyle(style)}${from}${thin}`;
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
    voiceHint,
  };
}
