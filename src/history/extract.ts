import { createHash } from 'node:crypto';
import type { HistoryPair } from './types';

/** One message from any chronological export. */
export interface HistoryMessage {
  id: string;
  threadId: string;
  channel: string;
  sender: string;
  /** True when the human whose style you are learning wrote it. */
  isFromMe: boolean;
  text: string;
  /** ISO string, epoch milliseconds or a Date. */
  timestamp: string | number | Date;
}

export interface ExtractOptions {
  /** Sender ids that also count as "me" (in addition to `isFromMe`). */
  selfIds?: string[];
  /** A reply only answers an incoming message sent at most this long before it. Default 24 hours. */
  maxGapMs?: number;
  /** Consecutive messages from one sender join into one turn when at most this far apart. Default 10 minutes. */
  burstGapMs?: number;
}

export const DEFAULT_MAX_GAP_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BURST_GAP_MS = 10 * 60 * 1000;

/** Placeholders chat exports leave where an image, sticker or file was. */
const MEDIA_ONLY = /^\s*(?:[\[<(]\s*)?(?:image|photo|picture|video|audio|voice(?: message| note)?|sticker|gif|attachment|file|document|media|contact|location|live location)(?:\s+(?:omitted|attached|removed|sent))?(?:\s*[\]>)])?\s*$|^\s*<media omitted>\s*$|^\s*[￼\s]+$/i;

/** Text worth learning from: non-empty and not just a media placeholder. */
export function cleanText(text: unknown): string {
  if (typeof text !== 'string') return '';
  const t = text.replace(/\r\n?/g, '\n').trim();
  return !t || MEDIA_ONLY.test(t) ? '' : t;
}

const toMs = (t: HistoryMessage['timestamp']): number => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t));

interface Turn {
  mine: boolean;
  sender: string;
  texts: string[];
  ids: string[];
  firstMs: number;
  lastMs: number;
}

/**
 * Chronological messages -> `(incoming -> your reply)` pairs.
 *  - Empty and media-only messages are ignored.
 *  - A burst of consecutive messages from one sender becomes one turn (joined with newlines).
 *  - A pair is someone else's turn followed directly by one of yours, within `maxGapMs`.
 *  - Your messages with nothing to answer, and incoming turns you never answered, produce no pair.
 * Pure: no I/O, and the same input always gives the same ids.
 */
export function extractPairsFromMessages(messages: HistoryMessage[], opts: ExtractOptions = {}): HistoryPair[] {
  const selfIds = new Set(opts.selfIds ?? []);
  const maxGap = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const burstGap = opts.burstGapMs ?? DEFAULT_BURST_GAP_MS;

  const threads = new Map<string, HistoryMessage[]>();
  for (const m of messages) {
    const key = `${m.channel}\u0000${m.threadId}`;
    const list = threads.get(key);
    if (list) list.push(m);
    else threads.set(key, [m]);
  }

  const pairs: HistoryPair[] = [];
  for (const thread of threads.values()) {
    const ordered = thread.every((m) => Number.isFinite(toMs(m.timestamp)))
      ? thread.map((m, i) => ({ m, i })).sort((a, b) => toMs(a.m.timestamp) - toMs(b.m.timestamp) || a.i - b.i).map(({ m }) => m)
      : thread; // unparseable timestamps: trust the order given

    const turns: Turn[] = [];
    for (const m of ordered) {
      const text = cleanText(m.text);
      if (!text) continue;
      const mine = m.isFromMe || selfIds.has(m.sender);
      const ms = toMs(m.timestamp);
      const last = turns.at(-1);
      const sameSender = last && last.mine === mine && (mine || last.sender === m.sender);
      const close = last ? !(Number.isFinite(ms) && Number.isFinite(last.lastMs)) || ms - last.lastMs <= burstGap : false;
      if (last && sameSender && close) {
        last.texts.push(text);
        last.ids.push(m.id);
        last.lastMs = ms;
      } else {
        turns.push({ mine, sender: m.sender, texts: [text], ids: [m.id], firstMs: ms, lastMs: ms });
      }
    }

    for (let i = 1; i < turns.length; i++) {
      const incoming = turns[i - 1]!;
      const reply = turns[i]!;
      if (incoming.mine || !reply.mine) continue;
      if (Number.isFinite(reply.firstMs) && Number.isFinite(incoming.lastMs) && reply.firstMs - incoming.lastMs > maxGap) continue;
      const first = thread[0]!;
      const iso = (ms: number): string | undefined => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);
      const id = `pair_${createHash('sha256').update([first.channel, first.threadId, ...incoming.ids, '->', ...reply.ids].join('\u0000')).digest('hex').slice(0, 16)}`;
      pairs.push({
        id,
        channel: first.channel,
        threadId: first.threadId,
        sender: incoming.sender,
        incoming: incoming.texts.join('\n'),
        reply: reply.texts.join('\n'),
        ...(iso(incoming.firstMs) ? { incomingAt: iso(incoming.firstMs)! } : {}),
        ...(iso(reply.firstMs) ? { replyAt: iso(reply.firstMs)! } : {}),
        metadata: { incomingMessageIds: incoming.ids, replyMessageIds: reply.ids },
      });
    }
  }
  // Threads were walked one at a time; put the result in time order (stable, so untimed pairs keep their place).
  return pairs.map((p, i) => ({ p, i })).sort((a, b) => (a.p.incomingAt ?? '').localeCompare(b.p.incomingAt ?? '') || a.i - b.i).map(({ p }) => p);
}
