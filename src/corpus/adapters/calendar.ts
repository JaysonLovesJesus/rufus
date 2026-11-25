// Calendar adapter: standard `.ics` (iCalendar) files, or a JSON / JSONL list of { summary, start, end, location,
// attendees, recurring }. No time zone database: floating and TZID times are read as UTC (fine for "what is coming up").
import { promises as fs } from 'node:fs';
import { inputFiles } from '../fsutil';
import { describeRecurrence, icsToMs, parseRRule } from '../recurrence';
import { cleanDomain, clip, limitNewest, parseJsonRecords, stableId, type CollectOptions, type CorpusItem, type SourceAdapter } from '../types';

export type CalendarOptions = CollectOptions;

interface Event {
  uid?: string;
  recurrenceId?: string;
  summary: string;
  start: number;
  end?: number;
  allDay: boolean;
  location?: string;
  organizer?: string;
  attendees: string[];
  rrule?: string;
  /** Known to repeat (possibly with an unknown cadence). */
  recurring?: boolean;
  description?: string;
}

const unescapeIcs = (v: string): string => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/** `NAME;PARAM=x:value` -> pieces. The first colon outside double quotes separates parameters from the value. */
function splitProperty(line: string): { name: string; params: Record<string, string>; value: string } | undefined {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return undefined;
  const [name, ...ps] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of ps) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name!.toUpperCase(), params, value: line.slice(colon + 1) };
}

const person = (params: Record<string, string>, value: string): string => params.CN?.trim() || value.replace(/^mailto:/i, '').trim();

/** Events from the text of one `.ics` file. */
export function parseIcs(text: string): Event[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events: Event[] = [];
  let cur: Partial<Event> & { attendees: string[]; cancelled?: boolean } | undefined;
  let depth = 0; // nested components inside an event (alarms) are ignored
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      cur = { attendees: [], allDay: false };
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (/^BEGIN:/i.test(line)) {
      depth++;
      continue;
    }
    if (/^END:VEVENT$/i.test(line)) {
      if (cur.start !== undefined && !cur.cancelled) events.push({ ...cur, summary: cur.summary ?? '(no title)', start: cur.start, allDay: cur.allDay ?? false, attendees: cur.attendees });
      cur = undefined;
      continue;
    }
    if (/^END:/i.test(line)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    const prop = splitProperty(line);
    if (!prop) continue;
    const { name, params, value } = prop;
    if (name === 'SUMMARY') cur.summary = unescapeIcs(value).trim();
    else if (name === 'UID') cur.uid = value.trim();
    else if (name === 'RECURRENCE-ID') cur.recurrenceId = value.trim();
    else if (name === 'DTSTART') {
      cur.start = icsToMs(value);
      cur.allDay = params.VALUE === 'DATE' || /^\d{8}$/.test(value.trim());
    } else if (name === 'DTEND') cur.end = icsToMs(value);
    else if (name === 'LOCATION') cur.location = unescapeIcs(value).trim() || undefined;
    else if (name === 'DESCRIPTION') cur.description = unescapeIcs(value).trim() || undefined;
    else if (name === 'RRULE') cur.rrule = value.trim();
    else if (name === 'ORGANIZER') cur.organizer = person(params, value);
    else if (name === 'ATTENDEE') cur.attendees.push(person(params, value));
    else if (name === 'STATUS' && /^CANCELLED$/i.test(value.trim())) cur.cancelled = true;
  }
  return events;
}

/** One JSON event record -> event. Accepts `summary`/`title`, `start`/`startsAt`, `recurring` as `true`, `weekly` or an RRULE. */
function eventFromRecord(raw: unknown): Event | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => keys.map((k) => r[k]).find((v) => v !== undefined && v !== null && v !== '');
  const time = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? v : v * 1000;
    if (typeof v === 'string') {
      const ms = Date.parse(v);
      return Number.isFinite(ms) ? ms : undefined;
    }
    return undefined;
  };
  const start = time(pick('start', 'startsAt', 'startTime', 'dtstart'));
  if (start === undefined) return undefined;
  const summary = pick('summary', 'title', 'name');
  const startRaw = pick('start', 'startsAt', 'startTime', 'dtstart');
  const attendees = Array.isArray(r.attendees)
    ? r.attendees.flatMap((a): string[] => {
        if (typeof a === 'string') return a.trim() ? [a.trim()] : [];
        if (a && typeof a === 'object') {
          const o = a as Record<string, unknown>;
          const n = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : typeof o.email === 'string' ? o.email.trim() : '';
          return n ? [n] : [];
        }
        return [];
      })
    : [];
  const rec = r.recurring ?? r.recurrence ?? r.rrule;
  const rrule = typeof rec === 'string' && rec.trim() ? rec.trim() : undefined;
  const end = time(pick('end', 'endsAt', 'endTime', 'dtend'));
  const location = pick('location');
  return {
    uid: typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : typeof r.uid === 'string' ? r.uid : undefined,
    summary: typeof summary === 'string' && summary.trim() ? summary.trim() : '(no title)',
    start,
    ...(end !== undefined ? { end } : {}),
    allDay: r.allDay === true || (typeof startRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(startRaw)),
    ...(typeof location === 'string' ? { location: location.trim() } : {}),
    attendees,
    ...(rrule ? { rrule } : {}),
    // `recurring: true` with no rule is remembered as recurring, with an unknown cadence (never guessed).
    recurring: rec === true || !!rrule,
  };
}

const fmt = (ms: number, allDay: boolean): string => {
  const iso = new Date(ms).toISOString();
  return allDay ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
};

export function eventToItem(e: Event): CorpusItem {
  const rule = e.rrule ? parseRRule(e.rrule) : undefined;
  const recurring = !!e.recurring || !!e.rrule;
  const cadence = rule ? describeRecurrence(rule) : undefined;
  const locDomain = e.location && /^https?:\/\//i.test(e.location) ? (() => {
    try {
      return cleanDomain(new URL(e.location!).hostname);
    } catch {
      return undefined;
    }
  })() : undefined;
  const when = e.end !== undefined && !e.allDay ? `${fmt(e.start, false)}–${new Date(e.end).toISOString().slice(11, 16)}` : fmt(e.start, e.allDay);
  const parts = [e.summary, when, e.location, e.attendees.length ? `with ${e.attendees.slice(0, 6).join(', ')}${e.attendees.length > 6 ? ` +${e.attendees.length - 6}` : ''}` : undefined, recurring ? (cadence ? `repeats ${cadence}` : 'repeats') : undefined];
  return {
    id: stableId('cal', e.uid ? `${e.uid}\u0000${e.recurrenceId ?? ''}` : `${e.summary}\u0000${e.start}`),
    source: 'calendar',
    kind: 'event',
    title: clip(e.summary, 200),
    summary: clip(parts.filter(Boolean).join(' · '), 500),
    ...(e.organizer ? { actor: e.organizer } : {}),
    ...(locDomain ? { domain: locDomain } : {}),
    timestamp: new Date(e.start).toISOString(),
    tags: recurring ? ['recurring'] : [],
    metadata: {
      ...(e.end !== undefined ? { end: new Date(e.end).toISOString() } : {}),
      allDay: e.allDay,
      ...(e.location ? { location: e.location } : {}),
      attendees: e.attendees,
      recurring,
      ...(e.rrule ? { rrule: e.rrule } : {}),
    },
  };
}

export const calendarAdapter: SourceAdapter<CalendarOptions> = {
  id: 'calendar',
  source: 'calendar',
  async collect(options: CalendarOptions): Promise<CorpusItem[]> {
    const items: CorpusItem[] = [];
    for (const file of await inputFiles(options.path, ['.ics', '.json', '.jsonl'])) {
      const text = await fs.readFile(file, 'utf8');
      const events = /^\s*BEGIN:VCALENDAR/i.test(text)
        ? parseIcs(text)
        : parseJsonRecords(text).records.flatMap((r) => {
            const list = r && typeof r === 'object' && Array.isArray((r as { events?: unknown }).events) ? ((r as { events: unknown[] }).events) : [r];
            return list.flatMap((x) => eventFromRecord(x) ?? []);
          });
      items.push(...events.map(eventToItem));
    }
    return limitNewest(items, options.limit);
  },
};
