import { createHash } from 'node:crypto';

/**
 * One real exchange from your past: someone wrote `incoming`, a human (you) answered with `reply`.
 * Channel-agnostic, so any export (chat, email, SMS...) can be turned into these.
 */
export interface HistoryPair {
  /** Stable identity. Seeding twice never duplicates a pair with the same id. */
  id: string;
  /** Where it happened, e.g. `sms`, `email`, `chat`. */
  channel: string;
  threadId?: string;
  /** Who wrote `incoming`. */
  sender: string;
  incoming: string;
  /** What the human actually answered. */
  reply: string;
  incomingAt?: string;
  replyAt?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** Deterministic id for a pair that does not bring its own. */
export function pairHash(p: Pick<HistoryPair, 'channel' | 'sender' | 'incoming' | 'reply'>): string {
  const h = createHash('sha256').update([p.channel, p.sender, p.incoming, p.reply].join('\u0000')).digest('hex');
  return `pair_${h.slice(0, 16)}`;
}

/** Why a raw record was rejected. */
export interface InvalidRecord {
  index: number;
  reason: string;
}

/**
 * Turns one raw JSON value into a clean `HistoryPair`, or says why not.
 * Lenient on what is optional (`channel`/`sender` default to "unknown"); strict that `incoming` and `reply` are text.
 */
export function normalizePair(raw: unknown): { pair: HistoryPair } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'not an object' };
  const r = raw as Record<string, unknown>;
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const incoming = text(r.incoming);
  const reply = text(r.reply);
  if (!incoming) return { error: 'missing "incoming" text' };
  if (!reply) return { error: 'missing "reply" text' };
  const channel = text(r.channel) ?? 'unknown';
  const sender = text(r.sender) ?? 'unknown';
  const id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id).trim() : '';
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : undefined;
  const meta = typeof r.metadata === 'object' && r.metadata !== null && !Array.isArray(r.metadata) ? (r.metadata as Record<string, unknown>) : undefined;
  const pair: HistoryPair = {
    id: id || pairHash({ channel, sender, incoming, reply }),
    channel,
    ...(text(r.threadId) ? { threadId: text(r.threadId)! } : {}),
    sender,
    incoming,
    reply,
    ...(text(r.incomingAt) ? { incomingAt: text(r.incomingAt)! } : {}),
    ...(text(r.replyAt) ? { replyAt: text(r.replyAt)! } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(meta ? { metadata: meta } : {}),
  };
  return { pair };
}
