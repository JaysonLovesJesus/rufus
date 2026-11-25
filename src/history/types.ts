import { createHash } from 'node:crypto';

/** One earlier turn in the thread, before `incoming`. */
export interface PriorMessage {
  sender: string;
  isFromMe: boolean;
  text: string;
  timestamp?: string;
}

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
  // ---- Situational context (optional; older pairs simply lack these) ----
  /** True for a group chat (more than one other person in the thread). */
  isGroup?: boolean;
  /** The last few turns before `incoming`, oldest first. `[]` means `incoming` opened the thread. */
  priorMessages?: PriorMessage[];
  /** Milliseconds between the previous turn in this thread and `incoming`: live chat (minutes), same day, or a cold restart. */
  gapSincePreviousMs?: number;
  /** Milliseconds from `incoming` to `reply`. */
  replyDelayMs?: number;
  /** Hour of day (0-23) `incoming` arrived. */
  incomingHour?: number;
  /** Day of week (0 = Sunday ... 6 = Saturday) `incoming` arrived. */
  incomingDayOfWeek?: number;
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
  const num = (v: unknown, lo = 0, hi = Infinity): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
  const int = (v: unknown, lo: number, hi: number): number | undefined => (Number.isInteger(v) ? num(v, lo, hi) : undefined);
  const prior: PriorMessage[] | undefined = Array.isArray(r.priorMessages)
    ? r.priorMessages.flatMap((m): PriorMessage[] => {
        if (typeof m !== 'object' || m === null) return [];
        const o = m as Record<string, unknown>;
        const t = text(o.text);
        if (!t) return [];
        return [{ sender: text(o.sender) ?? 'unknown', isFromMe: o.isFromMe === true, text: t, ...(text(o.timestamp) ? { timestamp: text(o.timestamp)! } : {}) }];
      })
    : undefined;
  const gap = num(r.gapSincePreviousMs);
  const delay = num(r.replyDelayMs);
  const hour = int(r.incomingHour, 0, 23);
  const dow = int(r.incomingDayOfWeek, 0, 6);
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
    ...(typeof r.isGroup === 'boolean' ? { isGroup: r.isGroup } : {}),
    ...(prior ? { priorMessages: prior } : {}),
    ...(gap !== undefined ? { gapSincePreviousMs: gap } : {}),
    ...(delay !== undefined ? { replyDelayMs: delay } : {}),
    ...(hour !== undefined ? { incomingHour: hour } : {}),
    ...(dow !== undefined ? { incomingDayOfWeek: dow } : {}),
  };
  return { pair };
}
