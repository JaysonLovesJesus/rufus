import { clip, stableId, type CorpusItem } from '../corpus/types';
import { noiseKind } from './noise';

/**
 * v18, Emoji Reaction Learning. Plenty of messages never got a sentence back: the human just put a 👍, ❤️ or 😂 on them.
 * Those are examples too. This module turns a chat's messages into clean `(incoming message -> your emoji reaction)`
 * corpus items (`source: 'chat_reaction'`), and answers, by code at $0, whether a new message looks like the ones you only
 * reacted to, so triage can suggest a reaction (or nothing) instead of drafting an unnecessary sentence.
 */

export const REACTION_SOURCE = 'chat_reaction';
/** A text reply this soon after a message counts as answering it, even when they wrote again in between. */
export const DEFAULT_REPLY_WINDOW_MS = 30 * 60_000;
/** A message of yours this long after theirs is a new conversation, not an answer. */
const MAX_TURN_MS = 12 * 3_600_000;

export interface ReactionLike {
  emoji: string;
  participantId?: string;
  isMe?: boolean;
}

/** One message of a chat, as Beeper (or any export) gives it. Oldest first. */
export interface ChatMessageLike {
  id?: string;
  chatId?: string;
  text?: string;
  isSender?: boolean;
  senderName?: string;
  timestamp?: string;
  isDeleted?: boolean;
  reactions?: ReactionLike[];
}

export interface ReactionExtractOptions {
  /** Chat id for items whose messages do not carry one. */
  chatId?: string;
  /** Who wrote to you, when the messages do not say (a 1:1 chat's title). */
  sender?: string;
  replyWindowMs?: number;
  /** Timestamp for messages without one. Default: skip them. */
  now?: Date;
}

/** How you answered one incoming message: a reaction only, a text reply, or not at all (yet). */
export interface ResponseOutcome {
  message: ChatMessageLike;
  outcome: 'reaction' | 'text' | 'none';
  emoji?: string;
}

const ms = (t?: string): number | undefined => {
  const v = t ? Date.parse(t) : NaN;
  return Number.isNaN(v) ? undefined : v;
};

/**
 * For each incoming message: did you write back (a message of yours before their next message, or within
 * `replyWindowMs`), react only, or do nothing? Deleted, empty and noise messages (passcodes, tapback echoes) are left out.
 */
export function responseOutcomes(messages: readonly ChatMessageLike[], opts: Pick<ReactionExtractOptions, 'replyWindowMs'> = {}): ResponseOutcome[] {
  const windowMs = opts.replyWindowMs ?? DEFAULT_REPLY_WINDOW_MS;
  const list = messages.filter((m) => !m.isDeleted);
  const out: ResponseOutcome[] = [];
  const isReply = (x: ChatMessageLike): boolean => !!x.isSender && !!(x.text ?? '').trim() && !noiseKind(x.text ?? '');
  list.forEach((m, i) => {
    const text = (m.text ?? '').trim();
    if (m.isSender || !text || noiseKind(text)) return;
    const at = ms(m.timestamp);
    const after = list.slice(i + 1);
    const theirNext = after.findIndex((x) => !x.isSender);
    const mineNext = after.findIndex(isReply);
    let texted = false;
    if (mineNext !== -1) {
      const gap = at !== undefined && ms(after[mineNext]!.timestamp) !== undefined ? ms(after[mineNext]!.timestamp)! - at : undefined;
      // Before their next message (and the same day) it answers this one; after it, only within the reply window.
      const inTurn = theirNext === -1 || mineNext < theirNext;
      texted = gap === undefined ? inTurn : (inTurn && gap <= MAX_TURN_MS) || gap <= windowMs;
    }
    const mine = (m.reactions ?? []).find((r) => r.isMe === true && r.emoji.trim());
    if (texted) out.push({ message: m, outcome: 'text' });
    else if (mine) out.push({ message: m, outcome: 'reaction', emoji: mine.emoji.trim() });
    else out.push({ message: m, outcome: 'none' });
  });
  return out;
}

/**
 * Clean `(incoming -> your emoji reaction)` examples from one chat's messages (oldest first): messages you reacted to and
 * did NOT also answer in text. Each becomes a `CorpusItem` with `source: 'chat_reaction'`, the emoji in `tags` and
 * `metadata.emoji`, and the incoming text in `metadata.text`.
 */
export function extractReactionExamples(messages: readonly ChatMessageLike[], opts: ReactionExtractOptions = {}): CorpusItem[] {
  return responseOutcomes(messages, opts).flatMap((o): CorpusItem[] => {
    if (o.outcome !== 'reaction' || !o.emoji) return [];
    const m = o.message;
    const at = ms(m.timestamp) ?? opts.now?.getTime();
    if (at === undefined) return [];
    const text = (m.text ?? '').trim();
    const sender = m.senderName ?? opts.sender ?? 'someone';
    const chatId = m.chatId ?? opts.chatId;
    return [
      {
        id: stableId('reaction', chatId ?? '', m.id ?? '', text, new Date(at).toISOString()),
        source: REACTION_SOURCE,
        kind: 'reaction',
        summary: clip(`${sender}: ${text} → reacted ${o.emoji}`, 300),
        actor: sender,
        timestamp: new Date(at).toISOString(),
        tags: [o.emoji],
        metadata: { emoji: o.emoji, text: clip(text, 300), ...(chatId ? { chatId } : {}), ...(m.id ? { messageId: m.id } : {}) },
      },
    ];
  });
}

// ---------- the triage hint ----------

const tokens = (s: string): Set<string> => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+|\p{Extended_Pictographic}/gu) ?? []).filter((t) => t.length > 1 || /\p{Extended_Pictographic}|\p{N}/u.test(t)));

/** Word (and emoji) overlap of two short texts, 0-1 (Jaccard). */
export function textSimilarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

/** One past message and how you answered it. */
export interface PastResponse {
  text: string;
  outcome: 'reaction' | 'text';
  emoji?: string;
}

/** The incoming text of a corpus item: a reaction's `metadata.text`, or the `sender: incoming → reply` of a chat exchange. */
export function pastResponseOf(item: CorpusItem): PastResponse | undefined {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  if (item.source === REACTION_SOURCE) {
    const text = typeof meta.text === 'string' ? meta.text : /^[^:]*:\s*(.*?)\s*→ reacted\s*\S+$/u.exec(item.summary)?.[1];
    const emoji = typeof meta.emoji === 'string' ? meta.emoji : item.tags?.[0];
    return text ? { text, outcome: 'reaction', ...(emoji ? { emoji } : {}) } : undefined;
  }
  if (item.source === 'chat' && item.kind === 'exchange') {
    const s = item.summary;
    const colon = s.indexOf(': ');
    const arrow = s.lastIndexOf(' → ');
    if (colon === -1 || arrow <= colon) return undefined;
    return { text: s.slice(colon + 2, arrow), outcome: 'text' };
  }
  return undefined;
}

export interface ReactionHint {
  /** The emoji you used most on messages like this. */
  emoji: string;
  /** Similar past messages you only reacted to. */
  reactions: number;
  /** Similar past messages you answered in text. */
  replies: number;
  /** Enough evidence for code to suggest a reaction without asking a model: 2+ reaction-only, and more than text replies. */
  strong: boolean;
  /** Up to three of the closest examples, one line each. */
  examples: string[];
  reason: string;
}

export const DEFAULT_MIN_SIMILARITY = 0.4;

/**
 * Do messages like `text` usually get just an emoji from you? Compares `text` with past responses (reaction-only and text
 * replies) by word overlap. `undefined` when no similar message got a reaction-only answer.
 */
export function reactionHint(text: string, past: readonly PastResponse[], opts: { minSimilarity?: number; minStrong?: number } = {}): ReactionHint | undefined {
  const min = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const seen = new Set<string>();
  const similar = past
    .filter((p) => {
      const key = `${p.outcome}\u0000${p.text.trim().toLowerCase()}\u0000${p.emoji ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((p) => ({ p, sim: textSimilarity(text, p.text) }))
    .filter((x) => x.sim >= min)
    .sort((a, b) => b.sim - a.sim);
  const reacted = similar.filter((x) => x.p.outcome === 'reaction' && x.p.emoji);
  if (!reacted.length) return undefined;
  const replies = similar.filter((x) => x.p.outcome === 'text').length;
  const counts = new Map<string, number>();
  for (const x of reacted) counts.set(x.p.emoji!, (counts.get(x.p.emoji!) ?? 0) + 1);
  const emoji = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const strong = reacted.length >= (opts.minStrong ?? 2) && reacted.length > replies;
  return {
    emoji,
    reactions: reacted.length,
    replies,
    strong,
    examples: reacted.slice(0, 3).map((x) => `"${clip(x.p.text, 120)}" → ${x.p.emoji}`),
    reason: `you usually just react ${emoji} to messages like this (${reacted.length} time${reacted.length === 1 ? '' : 's'}${replies ? `, ${replies} text repl${replies === 1 ? 'y' : 'ies'}` : ''})`,
  };
}

/** Past responses from a chat's own messages (oldest first): what you reacted to, and what you answered in text. */
export function pastResponsesFromThread(messages: readonly ChatMessageLike[], opts: Pick<ReactionExtractOptions, 'replyWindowMs'> = {}): PastResponse[] {
  return responseOutcomes(messages, opts).flatMap((o): PastResponse[] =>
    o.outcome === 'none' ? [] : [{ text: (o.message.text ?? '').trim(), outcome: o.outcome, ...(o.emoji ? { emoji: o.emoji } : {}) }],
  );
}
