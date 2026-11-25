import { dayFor, loadAnchor, localDate, overlaps, saveAnchor, slugify, toMinutes, type Anchor, type ScheduleBlock } from '../anchor/anchor';
import type { ToolRegistry } from '../tools/tools';

/**
 * v17, Real Calendar Sync. Reads today's real events through the read-only `calendar.read` tool and mirrors them into
 * `anchor.json` as `source: "calendar"` blocks, so the heartbeat, the think-beat and the day planner all see the real day.
 *
 *   - Only `source: "calendar"` blocks are ever added, moved or removed. Anything you or Rufus planned stays as it is.
 *   - A calendar event that now overlaps one of your own blocks is reported as a conflict (nothing is moved for you).
 *   - Plain code, $0: no model call. A failing or unreadable `calendar.read` changes nothing.
 */

export const CALENDAR_TOOL = 'calendar.read';
export const CALENDAR_SOURCE = 'calendar';
/** An event without an end lasts this long. */
const DEFAULT_EVENT_MINUTES = 30;

/** One real event for today, in local `HH:MM` (end may be `24:00`). */
export interface CalendarEvent {
  /** The calendar's own id, when it gave one. */
  id?: string;
  title: string;
  start: string;
  end: string;
}

/** A synced calendar block that overlaps one of your own (non-calendar) blocks. */
export interface CalendarConflict {
  event: ScheduleBlock;
  blocks: ScheduleBlock[];
}

export interface CalendarSyncResult {
  /** Calendar blocks on today's schedule after the sync. */
  synced: number;
  /** Ids of calendar blocks that are new. */
  added: string[];
  /** Ids of calendar blocks that are gone from the calendar (removed from the Anchor). */
  removed: string[];
  /** Ids of calendar blocks whose time or title changed. */
  updated: string[];
  /** Calendar events that collide with your own blocks. */
  conflicts: CalendarConflict[];
  /** True when `anchor.json` was written. */
  changed: boolean;
  /** Why nothing was synced (no `calendar.read` tool). */
  skipped?: string;
}

const p2 = (n: number): string => String(n).padStart(2, '0');
const hhmm = (d: Date): string => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const fromMinutes = (m: number): string => (m >= 1440 ? '24:00' : `${p2(Math.floor(m / 60))}:${p2(m % 60)}`);
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

type When = { kind: 'clock'; minutes: number } | { kind: 'instant'; at: Date } | { kind: 'allDay' };

/** `"14:00"`, an ISO time, epoch (s or ms), or Google's `{ dateTime }` / `{ date }` (all-day). */
function readWhen(v: unknown): When | undefined {
  const o = obj(v);
  if (o) {
    if (text(o.dateTime)) return readWhen(o.dateTime);
    if (text(o.date)) return { kind: 'allDay' };
    return undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return { kind: 'instant', at: new Date(v > 1e11 ? v : v * 1000) };
  const t = text(v);
  if (!t) return undefined;
  const clock = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    return h < 24 && m < 60 ? { kind: 'clock', minutes: h * 60 + m } : h === 24 && m === 0 ? { kind: 'clock', minutes: 1440 } : undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { kind: 'allDay' };
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? { kind: 'instant', at: new Date(ms) } : undefined;
}

/** The event list inside whatever `calendar.read` printed: an array, or `{ events | items | data: [...] }`. */
function eventList(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  const o = obj(raw);
  if (!o) return undefined;
  for (const k of ['events', 'items', 'data', 'results']) if (Array.isArray(o[k])) return o[k] as unknown[];
  return undefined;
}

/**
 * Today's timed events from a `calendar.read` result, sorted by start. All-day events, cancelled ones and events on other
 * days are left out; an event crossing midnight is clipped to today. Returns `undefined` when the output has no event list
 * at all (so a broken tool never wipes the calendar blocks).
 */
export function parseCalendarEvents(raw: unknown, now: Date): CalendarEvent[] | undefined {
  const list = eventList(raw);
  if (!list) return undefined;
  const today = localDate(now);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const out: CalendarEvent[] = [];
  for (const item of list) {
    const r = obj(item);
    if (!r) continue;
    if (r.allDay === true || /^cancel/i.test(text(r.status) ?? '')) continue;
    const title = text(r.title) ?? text(r.summary) ?? text(r.name) ?? '(busy)';
    const s = readWhen(r.start ?? r.startsAt ?? r.startTime ?? r.dtstart);
    if (!s || s.kind === 'allDay') continue;
    const e = readWhen(r.end ?? r.endsAt ?? r.endTime ?? r.dtend);
    if (e?.kind === 'allDay') continue;
    let a: number;
    let z: number;
    if (s.kind === 'clock') {
      // A bare clock time is today's, unless the event says which day it is on.
      const date = text(r.date);
      if (date && date !== today) continue;
      a = s.minutes;
      z = e?.kind === 'clock' ? e.minutes : e?.kind === 'instant' ? Math.round((e.at.getTime() - dayStart) / 60_000) : a + DEFAULT_EVENT_MINUTES;
    } else {
      const startMs = s.at.getTime();
      const endMs = e?.kind === 'instant' ? e.at.getTime() : e?.kind === 'clock' ? dayStart + e.minutes * 60_000 : startMs + DEFAULT_EVENT_MINUTES * 60_000;
      if (startMs >= dayEnd || endMs <= dayStart) continue; // not today
      a = startMs <= dayStart ? 0 : toMinutes(hhmm(s.at));
      z = endMs >= dayEnd ? 1440 : Math.round((endMs - dayStart) / 60_000);
    }
    a = Math.max(0, Math.min(1440, a));
    z = Math.max(0, Math.min(1440, z));
    if (z <= a) continue;
    const id = text(r.id) ?? text(r.uid) ?? text(r.eventId);
    out.push({ ...(id ? { id } : {}), title, start: fromMinutes(a), end: fromMinutes(z) });
  }
  return out.sort((x, y) => toMinutes(x.start) - toMinutes(y.start) || x.title.localeCompare(y.title));
}

/** The Anchor block id of an event: stable across syncs, so a moved event is an update, not a remove + add. */
export function calendarBlockId(ev: CalendarEvent): string {
  return ev.id ? `cal-${slugify(ev.id)}` : `cal-${ev.start.replace(':', '')}-${slugify(ev.title)}`;
}

const sortBlocks = (blocks: ScheduleBlock[]): ScheduleBlock[] => [...blocks].sort((a, b) => toMinutes(a.start) - toMinutes(b.start) || a.id.localeCompare(b.id));

/**
 * Merges today's events into the Anchor. Pure. Replaces today's `source: "calendar"` blocks with the events (keeping the
 * status of a block you already marked done or skipped), keeps every other block, and reports conflicts.
 */
export function mergeCalendarEvents(anchor: Anchor, events: CalendarEvent[], now: Date): { anchor: Anchor; result: CalendarSyncResult } {
  const today = localDate(now);
  const { anchor: base, day } = dayFor(anchor, today);
  const mine = day.blocks.filter((b) => b.source !== CALENDAR_SOURCE);
  const before = new Map(day.blocks.filter((b) => b.source === CALENDAR_SOURCE).map((b) => [b.id, b]));

  const fresh = new Map<string, ScheduleBlock>();
  for (const ev of events) {
    let id = calendarBlockId(ev);
    for (let n = 2; fresh.has(id); n++) id = `${calendarBlockId(ev)}-${n}`;
    const prev = before.get(id);
    fresh.set(id, { id, start: ev.start, end: ev.end, title: ev.title, kind: 'meeting', source: CALENDAR_SOURCE, status: prev?.status ?? 'planned' });
  }
  const added = [...fresh.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !fresh.has(id));
  const updated = [...fresh.values()].filter((b) => {
    const p = before.get(b.id);
    return p && (p.start !== b.start || p.end !== b.end || p.title !== b.title);
  }).map((b) => b.id);

  const conflicts: CalendarConflict[] = [];
  for (const ev of fresh.values()) {
    if (ev.status === 'skipped') continue;
    const hit = mine.filter((b) => b.status !== 'skipped' && overlaps(b, ev));
    if (hit.length) conflicts.push({ event: ev, blocks: hit });
  }

  const changed = base !== anchor || added.length > 0 || removed.length > 0 || updated.length > 0;
  const next: Anchor = changed ? { ...base, schedule: { date: today, blocks: sortBlocks([...mine, ...fresh.values()]) } } : anchor;
  return { anchor: next, result: { synced: fresh.size, added, removed, updated, conflicts, changed } };
}

/**
 * Reads today's events with `calendar.read` (read-only, if registered) and mirrors them into `<dir>/anchor.json`.
 * Writes only when something changed. Throws when the tool fails or prints something that is not an event list; the
 * Anchor is then left untouched.
 */
export async function syncCalendarToAnchor(dir: string, tools: ToolRegistry, now: Date): Promise<CalendarSyncResult> {
  const tool = tools.get(CALENDAR_TOOL);
  if (!tool || !tool.readOnly) return { synced: 0, added: [], removed: [], updated: [], conflicts: [], changed: false, skipped: `no read-only ${CALENDAR_TOOL} tool` };
  const today = localDate(now);
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const raw = await tools.call(CALENDAR_TOOL, { date: today, day: 'today', from: from.toISOString(), to: to.toISOString() }, { dir, now, stage: 'execute' });
  const events = parseCalendarEvents(raw, now);
  if (!events) throw new Error(`${CALENDAR_TOOL} did not return a list of events, so the schedule was left as it is.`);
  const anchor = await loadAnchor(dir, now);
  const { anchor: next, result } = mergeCalendarEvents(anchor, events, now);
  if (result.changed) await saveAnchor(dir, next, now);
  return result;
}

/** Conflict keys, for telling the human about each collision once. */
export const conflictKey = (date: string, c: CalendarConflict): string => `${date}:${c.event.id}@${c.event.start}:${c.blocks.map((b) => b.id).sort().join(',')}`;
