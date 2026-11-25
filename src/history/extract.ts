import { createHash } from 'node:crypto';
import { addNoise, cleanMessageText, emptyNoise, isPlaceholderText, noiseKind, type NoiseCounts } from './noise';
import type { HistoryPair, PriorMessage } from './types';

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
  /** Set when the export knows this is a group chat. Otherwise a thread with two or more other people counts as one. */
  isGroup?: boolean;
}

export interface ExtractOptions {
  /** Sender ids that also count as "me" (in addition to `isFromMe`). */
  selfIds?: string[];
  /** A reply only answers an incoming message sent at most this long before it. Default 24 hours. */
  maxGapMs?: number;
  /** Consecutive messages from one sender join into one turn when at most this far apart. Default 10 minutes. */
  burstGapMs?: number;
  /** Keep one-time passcodes and bare tapback/reaction echoes instead of skipping them. Default false. */
  includeNoise?: boolean;
  /** How many earlier turns to attach as `priorMessages`. Default 4; 0 attaches none. */
  priorMessageCount?: number;
  /** Fixed UTC offset in minutes used for `incomingHour` / `incomingDayOfWeek` (e.g. -300). Default: this machine's local time. */
  utcOffsetMinutes?: number;
}

/** How often you answer one sender on one channel: the silence behind the pairs. */
export interface ReplyHabit {
  channel: string;
  sender: string;
  isGroup: boolean;
  /** Incoming turns you answered (these are the pairs). */
  answered: number;
  /** Incoming turns you never answered in time. */
  unanswered: number;
}

export interface ExtractResult {
  pairs: HistoryPair[];
  /** Messages skipped as automated codes or reaction echoes (zero with `includeNoise`), plus media sync placeholders (always skipped). */
  noise: NoiseCounts;
  /** Per channel + sender: answered vs. unanswered incoming turns. Sorted by volume. */
  ignored: ReplyHabit[];
}

export const DEFAULT_MAX_GAP_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BURST_GAP_MS = 10 * 60 * 1000;

/** Placeholders chat exports leave where an image, sticker or file was. */
const MEDIA_ONLY = /^\s*(?:[\[<(]\s*)?(?:image|photo|picture|video|audio|voice(?: message| note)?|sticker|gif|attachment|file|document|media|contact|location|live location)(?:\s+(?:omitted|attached|removed|sent))?(?:\s*[\]>)])?\s*$|^\s*<media omitted>\s*$|^\s*[￼\s]+$/i;

/**
 * Text worth learning from: plain text (HTML bodies from Beeper/Matrix bridges are flattened and entities decoded), and
 * not just a media or sync placeholder (`<image omitted>`, `Old photo. Media will be requested from your phone ...`).
 */
export function cleanText(text: unknown): string {
  const t = cleanMessageText(text);
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

const PRIOR_TEXT_MAX = 280;
const clip = (t: string): string => (t.length > PRIOR_TEXT_MAX ? `${t.slice(0, PRIOR_TEXT_MAX - 1)}…` : t);

/**
 * Chronological messages -> `(incoming -> your reply)` pairs, plus what was skipped.
 *  - HTML bodies become plain text. Empty, media-only and sync-placeholder messages are ignored (placeholders are
 *    counted as `noise.placeholder`); so are one-time passcodes and bare tapbacks (unless `includeNoise`).
 *  - A burst of consecutive messages from one sender becomes one turn (joined with newlines).
 *  - A pair is someone else's turn followed directly by one of yours, within `maxGapMs`.
 *  - Every pair carries its situation: group or DM, the last few turns, the gap since the previous turn, how fast you
 *    answered, and the hour and weekday it arrived.
 *  - Incoming turns you never answered produce no pair but are counted per channel + sender in `ignored`.
 * Pure: no I/O, and the same input always gives the same ids.
 */
export function extractHistoryFromMessages(messages: HistoryMessage[], opts: ExtractOptions = {}): ExtractResult {
  const selfIds = new Set(opts.selfIds ?? []);
  const maxGap = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  const burstGap = opts.burstGapMs ?? DEFAULT_BURST_GAP_MS;
  const priorN = Math.max(0, Math.floor(opts.priorMessageCount ?? 4));
  const noise = emptyNoise();
  const habits = new Map<string, ReplyHabit>();

  const threads = new Map<string, HistoryMessage[]>();
  for (const m of messages) {
    const key = `${m.channel}\u0000${m.threadId}`;
    const list = threads.get(key);
    if (list) list.push(m);
    else threads.set(key, [m]);
  }

  const iso = (ms: number): string | undefined => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);
  const clock = (ms: number): { hour: number; dow: number } => {
    if (opts.utcOffsetMinutes !== undefined) {
      const d = new Date(ms + opts.utcOffsetMinutes * 60000);
      return { hour: d.getUTCHours(), dow: d.getUTCDay() };
    }
    const d = new Date(ms);
    return { hour: d.getHours(), dow: d.getDay() };
  };

  const pairs: HistoryPair[] = [];
  for (const thread of threads.values()) {
    const ordered = thread.every((m) => Number.isFinite(toMs(m.timestamp)))
      ? thread.map((m, i) => ({ m, i })).sort((a, b) => toMs(a.m.timestamp) - toMs(b.m.timestamp) || a.i - b.i).map(({ m }) => m)
      : thread; // unparseable timestamps: trust the order given

    const turns: Turn[] = [];
    for (const m of ordered) {
      const text = cleanText(m.text);
      if (!text) {
        // Sync placeholders are counted (so a report can say how many there were); plain empties are not.
        if (typeof m.text === 'string' && isPlaceholderText(m.text)) addNoise(noise, 'placeholder');
        continue;
      }
      if (!opts.includeNoise) {
        const kind = noiseKind(text);
        if (kind) {
          addNoise(noise, kind);
          continue;
        }
      }
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

    const first = thread[0]!;
    const others = new Set(turns.filter((t) => !t.mine).map((t) => t.sender));
    const isGroup = thread.some((m) => m.isGroup === true) || others.size >= 2;

    for (let i = 0; i < turns.length; i++) {
      const incoming = turns[i]!;
      if (incoming.mine) continue;
      const habitKey = `${first.channel}\u0000${incoming.sender}\u0000${isGroup}`;
      const habit = habits.get(habitKey) ?? { channel: first.channel, sender: incoming.sender, isGroup, answered: 0, unanswered: 0 };
      habits.set(habitKey, habit);

      const reply = turns[i + 1];
      const answered =
        !!reply && reply.mine && !(Number.isFinite(reply.firstMs) && Number.isFinite(incoming.lastMs) && reply.firstMs - incoming.lastMs > maxGap);
      if (!answered || !reply) {
        habit.unanswered++;
        continue;
      }
      habit.answered++;

      const previous = turns[i - 1];
      const gap = previous && Number.isFinite(incoming.firstMs) && Number.isFinite(previous.lastMs) ? Math.max(0, incoming.firstMs - previous.lastMs) : undefined;
      const delay = Number.isFinite(reply.firstMs) && Number.isFinite(incoming.lastMs) ? Math.max(0, reply.firstMs - incoming.lastMs) : undefined;
      const prior: PriorMessage[] | undefined = priorN
        ? turns.slice(Math.max(0, i - priorN), i).map((t) => ({
            sender: t.sender,
            isFromMe: t.mine,
            text: clip(t.texts.join('\n')),
            ...(iso(t.firstMs) ? { timestamp: iso(t.firstMs)! } : {}),
          }))
        : undefined;
      const when = Number.isFinite(incoming.firstMs) ? clock(incoming.firstMs) : undefined;
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
        isGroup,
        ...(prior ? { priorMessages: prior } : {}),
        ...(gap !== undefined ? { gapSincePreviousMs: gap } : {}),
        ...(delay !== undefined ? { replyDelayMs: delay } : {}),
        ...(when ? { incomingHour: when.hour, incomingDayOfWeek: when.dow } : {}),
      });
    }
  }
  // Threads were walked one at a time; put the result in time order (stable, so untimed pairs keep their place).
  const sorted = pairs.map((p, i) => ({ p, i })).sort((a, b) => (a.p.incomingAt ?? '').localeCompare(b.p.incomingAt ?? '') || a.i - b.i).map(({ p }) => p);
  const ignored = [...habits.values()].sort(
    (a, b) => b.answered + b.unanswered - (a.answered + a.unanswered) || a.channel.localeCompare(b.channel) || a.sender.localeCompare(b.sender),
  );
  return { pairs: sorted, noise, ignored };
}

/** Like `extractHistoryFromMessages`, keeping only the pairs. */
export function extractPairsFromMessages(messages: HistoryMessage[], opts: ExtractOptions = {}): HistoryPair[] {
  return extractHistoryFromMessages(messages, opts).pairs;
}
