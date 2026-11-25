// A small, dependency-free subset of iCalendar recurrence (RRULE): enough to say "what does this repeating event do in
// the next 7 days?". All math is UTC (there is no time zone database here). Unsupported parts are ignored, not guessed.
import { DAY_MS } from '../recency';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface Recurrence {
  freq: Freq;
  interval: number;
  /** Weekdays (0 = Sunday ... 6 = Saturday), each with an optional ordinal for MONTHLY (`1MO` = first Monday, `-1FR` = last Friday). */
  byDay?: Array<{ day: number; nth?: number }>;
  until?: number;
  count?: number;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NAMED: Record<string, Freq> = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY', annually: 'YEARLY' };

/** `FREQ=WEEKLY;BYDAY=MO,WE`, or a plain word like `weekly`. `undefined` when it is not a recurrence we understand. */
export function parseRRule(input: string): Recurrence | undefined {
  const named = NAMED[input.trim().toLowerCase()];
  if (named) return { freq: named, interval: 1 };
  const parts = new Map(
    input
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((kv) => kv.split('=') as [string, string | undefined])
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k.trim().toUpperCase(), v!.trim()] as const),
  );
  const freq = parts.get('FREQ')?.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return undefined;
  const interval = Math.max(1, Number(parts.get('INTERVAL') ?? 1) || 1);
  const byDay = parts
    .get('BYDAY')
    ?.split(',')
    .flatMap((d) => {
      const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim());
      return m ? [{ day: DAYS.indexOf(m[2]!.toUpperCase()), ...(m[1] ? { nth: Number(m[1]) } : {}) }] : [];
    });
  const untilRaw = parts.get('UNTIL');
  const until = untilRaw ? icsToMs(untilRaw) : undefined;
  const count = parts.get('COUNT') ? Number(parts.get('COUNT')) : undefined;
  return { freq, interval, ...(byDay?.length ? { byDay } : {}), ...(until !== undefined ? { until } : {}), ...(count && count > 0 ? { count } : {}) };
}

/** `20261201T150000Z` / `20261201` -> epoch ms (UTC). */
export function icsToMs(v: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/.exec(v.trim());
  if (!m) return undefined;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
}

export function describeRecurrence(r: Recurrence): string {
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  const every = r.interval === 1 ? ({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[r.freq]) : `every ${r.interval} ${unit}s`;
  const ord = (n: number): string => (n < 0 ? 'last ' : `${['', '1st', '2nd', '3rd', '4th', '5th'][n] ?? `${n}th`} `);
  const on = r.byDay?.length ? ` on ${r.byDay.map((d) => `${d.nth ? ord(d.nth) : ''}${DAY_NAMES[d.day]}`).join(', ')}` : '';
  return `${every}${on}`;
}

const MAX_STEPS = 20000;

/** The `n`-th (1-based) or last (-1) given weekday of a month, as a day-of-month, or `undefined` if the month lacks it. */
function nthWeekday(year: number, month: number, day: number, nth: number): number | undefined {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstHit = 1 + ((day - first + 7) % 7);
  if (nth > 0) {
    const d = firstHit + (nth - 1) * 7;
    return d <= daysInMonth ? d : undefined;
  }
  let d = firstHit;
  while (d + 7 <= daysInMonth) d += 7;
  return d;
}

/** Start times (epoch ms) of occurrences falling in `[fromMs, toMs]`, oldest first, at most `max`. The series begins at `startMs`. */
export function occurrencesBetween(startMs: number, r: Recurrence, fromMs: number, toMs: number, max = 100): number[] {
  const out: number[] = [];
  const start = new Date(startMs);
  const timeOfDay = startMs - Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const day0 = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  let produced = 0;
  const limitMs = Math.min(toMs, r.until ?? Infinity);
  /** Returns false when generation should stop. */
  const emit = (t: number): boolean => {
    if (t < startMs) return true;
    if (t > limitMs) return false;
    produced++;
    if (r.count !== undefined && produced > r.count) return false;
    if (t >= fromMs) out.push(t);
    return out.length < max;
  };
  for (let step = 0; step < MAX_STEPS; step++) {
    const k = step * r.interval;
    if (r.freq === 'DAILY') {
      const t = day0 + k * DAY_MS + timeOfDay;
      if (!emit(t)) break;
      if (t > limitMs) break;
    } else if (r.freq === 'WEEKLY') {
      const weekStart = day0 - start.getUTCDay() * DAY_MS + k * 7 * DAY_MS;
      const days = (r.byDay?.length ? r.byDay.map((d) => d.day) : [start.getUTCDay()]).sort((a, b) => a - b);
      let stop = false;
      for (const d of days) if (!emit(weekStart + d * DAY_MS + timeOfDay)) stop = true;
      if (stop || weekStart > limitMs) break;
    } else if (r.freq === 'MONTHLY') {
      const y = start.getUTCFullYear() + Math.floor((start.getUTCMonth() + k) / 12);
      const m = (start.getUTCMonth() + k) % 12;
      const days = r.byDay?.length
        ? r.byDay.map((d) => (d.nth ? nthWeekday(y, m, d.day, d.nth) : undefined)).filter((d): d is number => d !== undefined)
        : [start.getUTCDate()];
      let stop = false;
      for (const d of days.sort((a, b) => a - b)) {
        const t = Date.UTC(y, m, d) + timeOfDay;
        if (new Date(t).getUTCMonth() !== m) continue; // 31st in a 30-day month: skipped, like iCalendar
        if (!emit(t)) stop = true;
      }
      if (stop || Date.UTC(y, m, 1) > limitMs) break;
    } else {
      const y = start.getUTCFullYear() + k;
      const t = Date.UTC(y, start.getUTCMonth(), start.getUTCDate()) + timeOfDay;
      if (new Date(t).getUTCMonth() === start.getUTCMonth() && !emit(t)) break;
      if (t > limitMs) break;
    }
  }
  return out;
}
