import { localDate, toMinutes, type Anchor, type ScheduleBlock } from '../anchor/anchor';
import type { LoopPlan, SignalHandler } from '../engine/loop';
import { scheduleNow, timeFacts } from '../soul/soul';

/**
 * The schedule heartbeat: plain code, $0, run on every `rufus start` pass. Rufus starts the conversation when it matters:
 *  - a short heads-up ~10 minutes before a real (non-break) Anchor block starts, once per block;
 *  - a 2-3 line good-morning brief on the first `phone.unlocked` of the morning (from MacroDroid/Tasker via `POST /signal`).
 * Nothing is sent during quiet hours.
 */

export interface HeartbeatOptions {
  /** Minutes before a block starts to send its heads-up. Default 10. */
  leadMinutes?: number;
  /** `HH:MM-HH:MM` (may wrap midnight) when nothing proactive is sent. Default `22:00-07:00`; `false` for none. */
  quietHours?: string | false;
  /** Send a good-morning brief on the first phone unlock of the morning. Default true. */
  morningBrief?: boolean;
  /** The morning ends at this local time (`HH:MM`): later unlocks get no brief. Default `12:00`. */
  morningUntil?: string;
  /**
   * How heads-ups are worded. `code` (default, $0): a short casual line like "Chapel is in 10 min (9:30am)". `ai`: one
   * fast-tier model call words it like a friend would (falls back to the code line if the model fails or rambles).
   */
  phrasing?: 'code' | 'ai';
}

export const DEFAULT_LEAD_MINUTES = 10;
export const DEFAULT_QUIET_HOURS = '22:00-07:00';
const KEEP_NUDGED = 200;

const minutesOf = (d: Date): number => d.getHours() * 60 + d.getMinutes();

/** True when `now` falls inside `range` (`22:00-07:00` wraps past midnight). */
export function inQuietHours(now: Date, range: string | false | undefined = DEFAULT_QUIET_HOURS): boolean {
  if (!range) return false;
  const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(range);
  if (!m) return false;
  const start = toMinutes(m[1]!);
  const end = toMinutes(m[2]!);
  const t = minutesOf(now);
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

const nudgeKey = (date: string, b: ScheduleBlock): string => `${date}:${b.id}@${b.start}`;

/** Blocks starting within `leadMinutes` that have not had a heads-up yet. Breaks and skipped/done blocks never nudge. */
export function blocksToNudge(anchor: Anchor, now: Date, nudged: readonly string[], leadMinutes = DEFAULT_LEAD_MINUTES): ScheduleBlock[] {
  const date = localDate(now);
  if (anchor.schedule.date !== date) return [];
  const t = minutesOf(now);
  return anchor.schedule.blocks
    .filter((b) => b.kind !== 'break' && b.status === 'planned')
    .filter((b) => {
      const until = toMinutes(b.start) - t;
      return until > 0 && until <= leadMinutes;
    })
    .filter((b) => !nudged.includes(nudgeKey(date, b)))
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

/** "09:00" -> "9am", "14:30" -> "2:30pm", "00:15" -> "12:15am". Anything else is returned as is. */
export function clock12(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]) % 24;
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 || 12;
  return m[2] === '00' ? `${h12}${suffix}` : `${h12}:${m[2]}${suffix}`;
}

/** A block title as a person would say it: no `(focus)`-style tags, no trailing details after a dash or colon, short. */
export function speakableTitle(title: string, max = 48): string {
  let t = title.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const head = t.split(/\s+[-–—|:]\s+|:\s+/)[0]!.trim();
  if (head.length >= 3) t = head;
  if (t.length > max) {
    const cut = t.slice(0, max);
    t = (cut.lastIndexOf(' ') > max / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[\s,;.]+$/, '');
  }
  return t || title.trim();
}

/** "Chapel is in 10 min (9:30am)": short, casual, 12-hour time, no metadata tags. */
export function formatNudge(block: ScheduleBlock, now: Date): string {
  const mins = toMinutes(block.start) - minutesOf(now);
  return `${speakableTitle(block.title)} is in ${mins} min (${clock12(block.start)})`;
}

/** The prompt for an AI-worded heads-up (fast tier). */
export function nudgePrompt(block: ScheduleBlock, now: Date): string {
  const mins = toMinutes(block.start) - minutesOf(now);
  return [
    'Write a one-line heads-up text to your human, like a friend who keeps their schedule would: casual, warm, under 12 words.',
    'Use the 12-hour time if you mention it (like 9:30am). No tags like (focus), no emoji walls, no greeting.',
    `Next up: ${block.title}`,
    `Starts: ${clock12(block.start)}, in ${mins} min.`,
    'Reply with the text only.',
  ].join('\n');
}

/** A model-worded heads-up, if it is usable: one short line, no tags, no 24-hour clock. Otherwise undefined. */
export function acceptNudge(raw: string): string | undefined {
  const t = raw.trim().replace(/^["'“]|["'”]$/g, '').trim();
  if (!t || t.length > 140 || t.includes('\n')) return undefined;
  if (/\((focus|event|personal|admin|break|urgent|deep)\)/i.test(t) || /\b([01]\d|2[0-3]):[0-5]\d\b(?!\s*[ap]m)/i.test(t)) return undefined;
  return t;
}

/** Records a nudge, keeping the list short. */
export function markNudged(nudged: readonly string[] | undefined, anchor: Anchor, block: ScheduleBlock): string[] {
  return [...(nudged ?? []), nudgeKey(anchor.schedule.date, block)].slice(-KEEP_NUDGED);
}

/** The good-morning brief: 2-3 short lines, all from code. */
export function formatMorningBrief(anchor: Anchor, now: Date, waiting: number): string {
  const t = timeFacts(now, anchor);
  const today = anchor.schedule.date === t.date ? anchor.schedule.blocks.filter((b) => b.status !== 'skipped' && b.kind !== 'break' && toMinutes(b.end) > minutesOf(now)) : [];
  const sorted = [...today].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  const shown = sorted.slice(0, 4).map((b) => `${speakableTitle(b.title)} at ${clock12(b.start)}`);
  const { current } = scheduleNow(anchor, now);
  const lines = [`Good morning. It's ${t.weekday}, ${clock12(t.time)}.`];
  lines.push(
    shown.length
      ? `Today: ${shown.join(', ')}${sorted.length > shown.length ? ` (+${sorted.length - shown.length} more)` : ''}.${current ? ` You're in ${speakableTitle(current.title)} now.` : ''}`
      : 'Nothing on the schedule today.',
  );
  lines.push(waiting ? `${waiting === 1 ? 'One thing is' : `${waiting} things are`} waiting on you; say "checkin" when you want ${waiting === 1 ? 'it' : 'them'}.` : 'Nothing is waiting on you.');
  return lines.join('\n');
}

/** True for the morning window: after quiet hours end and before `morningUntil`. */
export function isMorning(now: Date, opts: Pick<HeartbeatOptions, 'morningUntil' | 'quietHours'> = {}): boolean {
  const until = toMinutes(opts.morningUntil ?? '12:00');
  const t = minutesOf(now);
  return t >= 4 * 60 && t < until && !inQuietHours(now, opts.quietHours ?? DEFAULT_QUIET_HOURS);
}

// ---------- phone signals ----------

/** Signals an Android automation app (MacroDroid, Tasker) can push through `POST /signal`. */
export const PHONE_KINDS: readonly string[] = ['phone.unlocked', 'phone.locked', 'app.opened', 'app.closed', 'location.changed'];

interface PhonePlan extends LoopPlan {
  kind: string;
}

/**
 * Phone context signals are facts, not work: recorded at $0 and completed on their own (never a Verify item). The
 * daemon reads `phone.unlocked` to send the good-morning brief.
 */
export const phoneSignalHandler: SignalHandler<{ kind: string; data?: Record<string, unknown> }, PhonePlan> = {
  id: 'phone.signal',
  match: (s) => PHONE_KINDS.includes(s.kind) || (s.surface === 'phone' && /^[a-z0-9]+(\.[a-z0-9_-]+)+$/i.test(s.kind)),
  maxReplans: 0,
  plan: (s) => ({
    goal: `Note ${s.kind}${s.text ? `: ${s.text}` : ''}`,
    actionType: s.kind.replace(/[^a-z0-9.]+/gi, '.').replace(/^\.+|\.+$/g, '') || 'phone.signal',
    route: 'code',
    urgency: 'normal',
    autoComplete: true,
    kind: s.kind,
  }),
  execute: (plan, s) => ({ kind: plan.kind, ...(s.data ? { data: s.data } : {}) }),
};
