import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LosslessEvent } from '../types';

/**
 * The owner's time, sensed rather than kept by hand: his time zone comes from his devices (the phone when a phone
 * sense reports one, else the Mac), and when he is free comes from his calendar plus the windows of his standing gaps.
 */

export interface SensedTimeZone {
  timeZone: string;
  /** Which device said so. */
  from: 'phone' | 'mac' | 'system';
}

/** A phone report this old or newer beats the Mac: the phone is the device that travels with him. */
const PHONE_FRESH_MS = 24 * 60 * 60_000;

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The Mac's own zone: /etc/localtime links into the zoneinfo database. */
async function macTimeZone(localtime = '/etc/localtime'): Promise<string | undefined> {
  try {
    const target = await fs.readlink(localtime);
    const tz = /zoneinfo\/(.+)$/.exec(target)?.[1];
    return isTimeZone(tz) ? tz : undefined;
  } catch {
    return undefined;
  }
}

/** The owner's time zone right now: a fresh phone report (any sensed event carrying metadata.timeZone), else the Mac. */
export async function senseTimeZone(opts: { events?: readonly LosslessEvent[]; now?: Date; localtime?: string } = {}): Promise<SensedTimeZone> {
  const now = (opts.now ?? new Date()).getTime();
  const phone = (opts.events ?? [])
    .filter((e) => isTimeZone(e.metadata?.timeZone) && now - Date.parse(e.timestamp) <= PHONE_FRESH_MS && e.provenance !== 'rufus_claimed')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .pop();
  if (phone) return { timeZone: String(phone.metadata!.timeZone), from: 'phone' };
  const mac = await macTimeZone(opts.localtime);
  if (mac) return { timeZone: mac, from: 'mac' };
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', from: 'system' };
}

// ---------------- Windows ("21:15-06:00" daily, "Fri 17:00-Sat 18:30" weekly) ----------------

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface Window {
  /** Minutes into the day (daily) or into the week from Sunday 00:00 (weekly). */
  from: number;
  to: number;
  weekly: boolean;
}

function parseEnd(s: string): { day?: number; min: number } | undefined {
  const m = /^(?:([a-z]{3})[a-z]*\s+)?(\d{1,2}):(\d{2})$/i.exec(s.trim());
  if (!m) return undefined;
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) return undefined;
  const day = m[1] ? DAYS.indexOf(m[1].toLowerCase()) : undefined;
  if (day === -1) return undefined;
  return { ...(day !== undefined ? { day } : {}), min: h * 60 + min };
}

/** Reads a window in the owner's local time; undefined when it is not one. */
export function parseWindow(text: unknown): Window | undefined {
  if (typeof text !== 'string') return undefined;
  const [a, b, ...rest] = text.split(/\s*[-–]\s*/);
  if (!a || !b || rest.length) return undefined;
  const from = parseEnd(a);
  const to = parseEnd(b);
  if (!from || !to) return undefined;
  const weekly = from.day !== undefined || to.day !== undefined;
  if (weekly && (from.day === undefined || to.day === undefined)) return undefined;
  return weekly ? { from: from.day! * 1440 + from.min, to: to.day! * 1440 + to.min, weekly } : { from: from.min, to: to.min, weekly };
}

/** The local weekday and minute of an instant in a time zone. */
export function localClock(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: DAYS.indexOf(get('weekday').toLowerCase().slice(0, 3)), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function inWindow(w: Window, at: Date, timeZone: string): boolean {
  const c = localClock(at, timeZone);
  const m = w.weekly ? c.day * 1440 + c.minute : c.minute;
  return w.from <= w.to ? m >= w.from && m < w.to : m >= w.from || m < w.to;
}

const STEP_MS = 5 * 60_000;
const SCAN_MS = 8 * 24 * 60 * 60_000;

/** The next instant (at or after `from`) where the window's state flips to `want`, scanning in 5-minute steps. */
function nextFlip(w: Window, from: Date, timeZone: string, want: boolean): Date | undefined {
  const start = Math.ceil(from.getTime() / STEP_MS) * STEP_MS;
  for (let t = start; t <= from.getTime() + SCAN_MS; t += STEP_MS) if (inWindow(w, new Date(t), timeZone) === want) return new Date(t);
  return undefined;
}

export const nextWindowStart = (w: Window, from: Date, timeZone: string) => (inWindow(w, from, timeZone) ? from : nextFlip(w, from, timeZone, true));
export const windowEnd = (w: Window, from: Date, timeZone: string) => (inWindow(w, from, timeZone) ? nextFlip(w, from, timeZone, false) : from);

// ---------------- Availability ----------------

export interface Busy {
  start: number;
  end: number;
  why: string;
}

/** Events this long are seasons on a shared calendar (a school break), not times he is busy. */
const MAX_BUSY_MS = 12 * 60 * 60_000;

/** Timed events from the calendar sense's last read (`sense-state/calendar.json`). */
export async function calendarBusy(workspaceDir: string, now: Date, horizonMs = 2 * 24 * 60 * 60_000): Promise<Busy[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(workspaceDir, 'sense-state', 'calendar.json'), 'utf8')) as {
      snapshot?: { events?: Record<string, { title?: string; start?: string; end?: string; allDay?: boolean }> };
    };
    return Object.values(raw.snapshot?.events ?? {})
      .map((e) => ({ start: Date.parse(e.start ?? ''), end: Date.parse(e.end ?? ''), why: `calendar: ${e.title ?? 'event'}`, allDay: !!e.allDay }))
      .filter((e) => !e.allDay && Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > now.getTime() && e.start < now.getTime() + horizonMs && e.end - e.start <= MAX_BUSY_MS)
      .map(({ start, end, why }) => ({ start, end, why }))
      .sort((a, b) => a.start - b.start);
  } catch {
    return [];
  }
}

/** A standing gap whose window says when it applies: during it the owner is not free for anything else. */
export interface WindowedGap {
  id: string;
  title: string;
  window: string;
}

/** Why the owner is not free at this instant (a calendar event, or a standing gap's window), if he is not. */
export function awayReason(at: Date, opts: { busy: readonly Busy[]; windows: readonly WindowedGap[]; timeZone: string }): { why: string; until: Date } | undefined {
  const t = at.getTime();
  const b = opts.busy.find((x) => x.start <= t && t < x.end);
  if (b) return { why: b.why, until: new Date(b.end) };
  for (const g of opts.windows) {
    const w = parseWindow(g.window);
    if (w && inWindow(w, at, opts.timeZone)) {
      const until = windowEnd(w, at, opts.timeZone);
      if (until) return { why: `${g.id} "${g.title}" (${g.window})`, until };
    }
  }
  return undefined;
}

/** The first time at or after `from` when the owner is free: past calendar events and standing-gap windows. */
export function nextOwnerFree(from: Date, opts: { busy: readonly Busy[]; windows: readonly WindowedGap[]; timeZone: string }): Date {
  let at = from;
  for (let i = 0; i < 20; i++) {
    const away = awayReason(at, opts);
    if (!away) return at;
    at = away.until;
  }
  return at;
}

/** The Desk's line on the owner's time: his zone, and when he is busy or away over the next day. */
export function availabilityText(opts: { now: Date; tz: SensedTimeZone; busy: readonly Busy[]; windows: readonly WindowedGap[]; format: (d: Date) => string }): string {
  const lines = [`Owner's time zone: ${opts.tz.timeZone} (sensed from the ${opts.tz.from === 'system' ? 'system clock' : opts.tz.from}).`];
  const nowAway = awayReason(opts.now, { busy: opts.busy, windows: opts.windows, timeZone: opts.tz.timeZone });
  lines.push(nowAway ? `Right now he is not free: ${nowAway.why}, until ${opts.format(nowAway.until)}. Pings hold to his free time; work never does.` : 'Right now he is free.');
  const day = opts.now.getTime() + 24 * 60 * 60_000;
  const coming = opts.busy.filter((b) => b.start > opts.now.getTime() && b.start < day).map((b) => `${opts.format(new Date(b.start))}–${opts.format(new Date(b.end))} ${b.why}`);
  for (const g of opts.windows) {
    const w = parseWindow(g.window);
    const start = w ? nextWindowStart(w, opts.now, opts.tz.timeZone) : undefined;
    if (start && start.getTime() > opts.now.getTime() && start.getTime() < day) coming.push(`from ${opts.format(start)}: ${g.id} "${g.title}" (${g.window})`);
  }
  if (coming.length) lines.push(`Next 24h: ${coming.join('; ')}.`);
  return lines.join(' ');
}

/** The zone the daemon runs in right now: the daemon sets TZ from the sensed zone on every wake. */
export function ownerTimeZoneNow(): string {
  return isTimeZone(process.env.TZ) ? process.env.TZ! : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
