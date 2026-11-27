import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { LosslessEvent } from '../types';
import type { SensePoll } from './health';
import { genericEvent, messageEvent } from './ingest';
import { watchConnector } from './watches';

const execFileAsync = promisify(execFile);

/** What a poll may return besides its events: items it saw but could not read. */
export interface PollResult {
  events: LosslessEvent[];
  parseFailures?: number;
}

/** Any pluggable data input feeding the single continuous heartbeat -> Lossless Event Store -> SetFit Bouncer. */
export interface EventConnector {
  readonly id: string;
  readonly intervalMs: number;
  poll(): Promise<LosslessEvent[] | PollResult>;
}

/**
 * Runs all registered data connectors inside ONE continuous heartbeat.
 * Each connector polls at its own natural cadence; only brand-new events are returned for the Bouncer.
 * Every poll's outcome (events, errors, parse failures, latency) is returned so sense health can be tracked.
 */
export class HeartbeatHub {
  private readonly connectors: EventConnector[] = [];
  private readonly lastPoll = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  add(connector: EventConnector): void {
    this.connectors.push(connector);
  }

  list(): readonly EventConnector[] {
    return this.connectors;
  }

  /**
   * Polls every connector whose interval has elapsed and returns all freshly sensed events.
   * A connector still polling from an earlier tick is skipped, and `onPoll` gets each poll as soon as it lands,
   * so one slow sense never holds back the others (watch timers included).
   */
  async tick(nowMs = Date.now(), onPoll?: (poll: SensePoll) => Promise<void> | void): Promise<{ events: LosslessEvent[]; errors: string[]; polls: SensePoll[] }> {
    const polls: SensePoll[] = [];
    await Promise.all(
      this.connectors.map(async (c) => {
        if (this.inFlight.has(c.id)) return;
        const prev = this.lastPoll.get(c.id) ?? 0;
        if (prev && nowMs - prev < c.intervalMs) return;
        this.lastPoll.set(c.id, nowMs);
        this.inFlight.add(c.id);
        const t0 = Date.now();
        const at = new Date(nowMs).toISOString();
        let poll: SensePoll;
        try {
          const found = await c.poll();
          const res = Array.isArray(found) ? { events: found } : found;
          poll = { id: c.id, intervalMs: c.intervalMs, at, ok: true, ms: Date.now() - t0, events: res.events ?? [], parseFailures: res.parseFailures ?? 0 };
        } catch (err) {
          poll = { id: c.id, intervalMs: c.intervalMs, at, ok: false, ms: Date.now() - t0, events: [], parseFailures: 0, error: err instanceof Error ? err.message : String(err) };
        } finally {
          this.inFlight.delete(c.id);
        }
        polls.push(poll);
        await onPoll?.(poll);
      }),
    );
    return {
      events: polls.flatMap((p) => p.events),
      errors: polls.filter((p) => !p.ok).map((p) => `${p.id}: ${p.error}`),
      polls,
    };
  }
}

/** Small per-sense state file (cursors, snapshots) so a restart neither replays nor loses what changed while down. */
export function senseState<T extends object>(statePath: string | undefined, initial: () => T) {
  let cache: T | undefined;
  let fresh = false;
  return {
    async load(): Promise<{ state: T; firstRun: boolean }> {
      if (cache) return { state: cache, firstRun: false };
      try {
        cache = statePath ? (JSON.parse(await fs.readFile(statePath, 'utf8')) as T) : undefined;
      } catch {
        cache = undefined;
      }
      if (!cache) {
        cache = initial();
        fresh = true;
      }
      const firstRun = fresh;
      fresh = false;
      return { state: cache, firstRun };
    },
    async save(): Promise<void> {
      if (!statePath || !cache) return;
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cache), 'utf8');
      await fs.rename(tmp, statePath);
    },
  };
}

export const senseStatePath = (workspaceDir: string, id: string) => path.join(workspaceDir, 'sense-state', `${id}.json`);

interface BeeperChat {
  id: string;
  title?: string;
  name?: string;
  network?: string;
  type?: string;
  unreadCount?: number;
  unreadMentionsCount?: number;
  isMuted?: boolean;
  isPinned?: boolean;
  isLowPriority?: boolean;
  isArchived?: boolean;
  lastActivity?: string;
  participants?: { items?: Array<{ id: string; isSelf?: boolean }> };
  preview?: { id?: string; sortKey?: string; timestamp?: string };
}

interface BeeperMessage {
  id: string;
  senderID?: string;
  senderName?: string;
  timestamp?: string;
  sortKey?: string;
  type?: string;
  text?: string;
  isSender?: boolean;
  isDeleted?: boolean;
  isHidden?: boolean;
  mentions?: string[] | null;
  attachments?: unknown[];
  linkedMessageID?: string;
}

/** Sort keys are numeric strings in practice; compare them as numbers when they are. */
function compareSortKeys(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
  return a.localeCompare(b);
}

const MEDIA_TAG: Record<string, string> = { VOICE: '[voice note]', AUDIO: '[audio]', IMAGE: '[image]', VIDEO: '[video]', STICKER: '[sticker]', FILE: '[file]' };

/** Bouncer-readable tags for a chat: learned signals, not hard rules. */
export function beeperChatFeatures(chat: BeeperChat, mentionsOwner: boolean): string[] {
  return [
    `chat:${chat.type === 'group' ? 'group' : 'dm'}`,
    chat.isMuted ? 'muted:true' : '',
    chat.isPinned ? 'pinned:true' : '',
    chat.isLowPriority ? 'low_priority:true' : '',
    chat.isArchived ? 'archived:true' : '',
    mentionsOwner || (chat.unreadMentionsCount ?? 0) > 0 ? 'mentions_owner:true' : '',
  ].filter(Boolean);
}

/**
 * Local Beeper Desktop API connector (WhatsApp, iMessage, SMS, etc.).
 * Reads every chat by cursor (the last message sort key seen), read or unread, so no message is lost to a preview.
 * The owner's own messages and Rufus's echoes are skipped.
 */
export function beeperConnector(opts: {
  baseUrl?: string;
  token: string;
  intervalMs?: number;
  statePath?: string;
  /** Sender names that are Rufus himself (his Telegram bot shows up in Beeper too). */
  selfNames?: string[];
  /** Texts Rufus sent recently: an identical message coming back through Beeper is his own echo. */
  recentSent?: () => Promise<string[]>;
  chatLimit?: number;
  now?: () => Date;
}): EventConnector {
  const base = (opts.baseUrl || 'http://localhost:23373').replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${opts.token}` };
  const selfNames = new Set((opts.selfNames ?? ['Rufus']).map((n) => n.trim().toLowerCase()));
  const now = opts.now ?? (() => new Date());
  const store = senseState(opts.statePath, () => ({ since: now().toISOString(), cursors: {} as Record<string, string> }));
  const getJson = async <T>(p: string): Promise<T> => {
    const res = await fetch(`${base}${p}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Beeper ${p.split('?')[0]} -> ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    id: 'beeper',
    intervalMs: opts.intervalMs ?? 30_000,
    async poll() {
      const { state, firstRun } = await store.load();
      const chats = (await getJson<{ items?: BeeperChat[] }>(`/v1/chats?limit=${opts.chatLimit ?? 50}`)).items ?? [];
      const sent = new Set(((await opts.recentSent?.().catch(() => [])) ?? []).map((t) => t.trim()));
      const out: LosslessEvent[] = [];
      let parseFailures = 0;
      for (const chat of chats) {
        const latest = chat.preview?.sortKey;
        const cursor = state.cursors[chat.id];
        if (!latest) continue;
        if (cursor && compareSortKeys(latest, cursor) <= 0) continue;
        if (!cursor && firstRun) {
          state.cursors[chat.id] = latest; // first run ever: start from now, not from history
          continue;
        }
        const msgPath = `/v1/chats/${encodeURIComponent(chat.id)}/messages`;
        const msgs = new Map<string, BeeperMessage>();
        let pageCursor = cursor;
        for (let page = 0; page < 5; page++) {
          const res = await getJson<{ items?: BeeperMessage[]; hasMore?: boolean; newestCursor?: string }>(
            pageCursor ? `${msgPath}?cursor=${encodeURIComponent(pageCursor)}&direction=after` : msgPath,
          );
          for (const m of res.items ?? []) msgs.set(m.id, m);
          if (!pageCursor || !res.hasMore || !res.newestCursor || res.newestCursor === pageCursor) break;
          pageCursor = res.newestCursor;
        }
        const ownerId = chat.participants?.items?.find((p) => p.isSelf)?.id;
        const isGroup = chat.type === 'group';
        const network = chat.network || 'Beeper';
        const title = chat.title || chat.name;
        const ordered = [...msgs.values()]
          .filter((m) => m.sortKey && (cursor ? compareSortKeys(m.sortKey, cursor) > 0 : Date.parse(m.timestamp ?? '') > Date.parse(state.since)))
          .sort((x, y) => compareSortKeys(x.sortKey!, y.sortKey!));
        for (const m of ordered) {
          if (!state.cursors[chat.id] || compareSortKeys(m.sortKey!, state.cursors[chat.id]!) > 0) state.cursors[chat.id] = m.sortKey!;
          if (m.isSender || m.isHidden || m.type === 'REACTION') continue;
          const sender = (m.senderName || (isGroup ? 'someone' : title) || 'unknown').trim();
          if (selfNames.has(sender.toLowerCase())) continue;
          const body = m.text?.trim() ?? '';
          if (body && sent.has(body)) continue; // Rufus's own message, echoed back
          const tag = m.type ? MEDIA_TAG[m.type] : undefined;
          const text = tag ? `${tag}${body ? ` ${body}` : ''}` : body;
          if (!text) continue; // nothing to read (a system notice or an empty edit)
          if (!m.timestamp) parseFailures++;
          const mentionsOwner = !!ownerId && (m.mentions ?? []).includes(ownerId);
          out.push(
            messageEvent({
              id: `beeper_${chat.id}_${m.id}`,
              channel: network,
              actor: sender,
              text,
              timestamp: m.timestamp || now().toISOString(),
              threadId: chat.id,
              ...(m.isDeleted ? { deleted: true } : {}),
              audience: { from: sender, to: isGroup ? 'group' : 'owner', direction: 'incoming', network, chatType: isGroup ? 'group' : 'dm', ...(title ? { chatTitle: title } : {}) },
              metadata: {
                chatTitle: title,
                chatType: isGroup ? 'group' : 'dm',
                network,
                messageType: m.type ?? 'TEXT',
                sortKey: m.sortKey,
                unreadCount: chat.unreadCount ?? 0,
                unreadMentionsCount: chat.unreadMentionsCount ?? 0,
                isMuted: !!chat.isMuted,
                isPinned: !!chat.isPinned,
                isLowPriority: !!chat.isLowPriority,
                isArchived: !!chat.isArchived,
                mentionsOwner,
                features: beeperChatFeatures(chat, mentionsOwner),
              },
            }),
          );
        }
        if (!state.cursors[chat.id]) state.cursors[chat.id] = latest;
      }
      await store.save();
      return { events: out, parseFailures };
    },
  };
}

/** Runs a reader command, feeding its JSON args on stdin, and returns stdout. */
export function runReader(command: string, args: string[], input: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(command)}: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
    child.stdin?.end(JSON.stringify(input));
  });
}

/** Parses a reader's JSON array output. Throws on anything else, so a broken reader shows up as a failing sense. */
export function parseJsonArray(stdout: string, reader: string): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout.trim() || '[]');
  } catch {
    throw new Error(`${reader} printed something that is not JSON: ${stdout.trim().slice(0, 80)}`);
  }
  if (!Array.isArray(data)) throw new Error(`${reader} printed JSON that is not a list`);
  return data;
}

interface GmailItem {
  id?: string;
  subject?: string;
  from?: string;
  fromEmail?: string;
  snippet?: string;
  date?: string;
  labels?: string[];
}

/** Turns the Gmail reader's JSON into one event per email, keyed by the Gmail message id. */
export function parseGmail(stdout: string): PollResult {
  const items = parseJsonArray(stdout, 'gmail reader') as GmailItem[];
  const events: LosslessEvent[] = [];
  let parseFailures = 0;
  for (const m of items) {
    if (!m || typeof m !== 'object' || !m.id) {
      parseFailures++;
      continue;
    }
    const labels = Array.isArray(m.labels) ? m.labels.map(String) : [];
    const sender = (m.from || m.fromEmail || 'unknown sender').trim();
    const subject = (m.subject || '(no subject)').trim();
    const snippet = (m.snippet || '').trim();
    const when = m.date && !Number.isNaN(Date.parse(m.date)) ? new Date(m.date).toISOString() : undefined;
    if (!when) parseFailures++;
    events.push(
      genericEvent({
        id: `email_${m.id}`,
        source: 'email',
        kind: 'unread',
        actor: sender,
        text: snippet ? `${subject} — ${snippet}` : subject,
        timestamp: when ?? new Date().toISOString(),
        metadata: {
          gmailId: m.id,
          subject,
          ...(m.fromEmail ? { fromEmail: m.fromEmail } : {}),
          labels,
          // The inbox category (updates, promo...) is a signal for the Bouncer to weigh, not a filter.
          features: labels.map((l) => `category:${l}`),
        },
      }),
    );
  }
  return { events, parseFailures };
}

/** Command-backed Gmail connector: every unread inbox email, all categories, each with its own stable id. */
export function gmailConnector(opts: { command: string; args: string[]; intervalMs?: number; timeoutMs?: number }): EventConnector {
  return {
    id: 'gmail',
    intervalMs: opts.intervalMs ?? 3 * 60_000,
    async poll() {
      const args = opts.args.map((a) => a.replace(/\{query\}/g, 'newer_than:1d is:unread'));
      // `all`: include the Updates tab, where confirmations and tickets land.
      return parseGmail(await runReader(opts.command, args, { all: true }, opts.timeoutMs ?? 120_000));
    },
  };
}

export interface CalendarItem {
  id: string;
  title: string;
  start: string;
  end: string;
  calendar?: string;
  location?: string | null;
  allDay?: boolean;
}

interface CalendarState {
  /** Up to when the last fetch could see: only events starting before this can be "new" or "deleted". */
  horizon: string;
  events: Record<string, CalendarItem>;
  alerted: string[];
}

/** The calendar event's own id: the reader appends "|<start>", which changes when the event moves. */
const calendarKey = (id: string) => (id.includes('|') ? id.slice(0, id.lastIndexOf('|')) : id);
const keyHash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/** Local wall-clock time for a calendar moment, e.g. "Fri 7:45 AM" (the daemon runs in the owner's time zone). */
export function localWhen(iso: string, allDay = false): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return allDay ? day : `${day} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

const describeItem = (e: CalendarItem) =>
  `${e.title} (${localWhen(e.start, e.allDay)}${e.allDay ? '' : `–${new Date(e.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`}${e.calendar ? `, ${e.calendar}` : ''}${e.location ? `, ${e.location}` : ''})`;

/**
 * Diffs one calendar fetch against the last: events created, changed or deleted, and events about to start.
 * Keyed by the calendar's own event id; all times shown in local time.
 */
export function diffCalendar(prev: CalendarState | undefined, items: CalendarItem[], now: Date, horizonMs: number): { events: LosslessEvent[]; state: CalendarState } {
  const at = now.toISOString();
  const nowMs = now.getTime();
  const current: Record<string, CalendarItem> = {};
  for (const it of items) {
    const key = calendarKey(it.id);
    if (!current[key]) current[key] = it;
  }
  const out: LosslessEvent[] = [];
  const meta = (key: string, e: CalendarItem) => ({ calendarEventId: key, title: e.title, start: e.start, end: e.end, ...(e.calendar ? { calendar: e.calendar } : {}), allDay: !!e.allDay });
  if (prev) {
    const prevHorizon = Date.parse(prev.horizon);
    for (const [key, e] of Object.entries(current)) {
      const old = prev.events[key];
      if (!old) {
        // An event that just slid into view at the far end of the window was not created now.
        if (Date.parse(e.start) < prevHorizon) {
          out.push(genericEvent({ id: `cal_created_${keyHash(key)}`, source: 'calendar', kind: 'event_created', text: `New calendar event: ${describeItem(e)}`, timestamp: at, metadata: meta(key, e) }));
        }
      } else if (old.title !== e.title || old.start !== e.start || old.end !== e.end || (old.location ?? null) !== (e.location ?? null)) {
        out.push(
          genericEvent({
            id: `cal_changed_${keyHash(`${key}|${e.start}|${e.end}|${e.title}|${e.location ?? ''}`)}`,
            source: 'calendar',
            kind: 'event_changed',
            text: `Calendar event changed: ${describeItem(old)} is now ${describeItem(e)}`,
            timestamp: at,
            metadata: { ...meta(key, e), before: { title: old.title, start: old.start, end: old.end } },
          }),
        );
      }
    }
    for (const [key, old] of Object.entries(prev.events)) {
      const start = Date.parse(old.start);
      // Gone while it was still ahead and inside what this fetch could see: deleted, not just over.
      if (!current[key] && start > nowMs && start < nowMs + horizonMs) {
        out.push(genericEvent({ id: `cal_deleted_${keyHash(key)}`, source: 'calendar', kind: 'event_deleted', text: `Calendar event removed: ${describeItem(old)}`, timestamp: at, metadata: meta(key, old) }));
      }
    }
  }
  const alerted = new Set(prev?.alerted ?? []);
  for (const [key, e] of Object.entries(current)) {
    if (e.allDay) continue;
    const mins = Math.round((Date.parse(e.start) - nowMs) / 60_000);
    const alertKey = `${key}|${e.start}`;
    if (mins >= 10 && mins <= 25 && !alerted.has(alertKey)) {
      alerted.add(alertKey);
      out.push(genericEvent({ id: `cal_upcoming_${keyHash(alertKey)}`, source: 'calendar', kind: 'upcoming', text: `Upcoming in ~${mins} min: ${describeItem(e)}`, timestamp: at, metadata: meta(key, e) }));
    }
  }
  // Forget alerts for events that are over.
  const keep = [...alerted].filter((k) => Date.parse(k.slice(k.lastIndexOf('|') + 1)) > nowMs - 86_400_000);
  return { events: out, state: { horizon: new Date(nowMs + horizonMs).toISOString(), events: current, alerted: keep } };
}

/** Google Calendar connector: polls the calendar reader and emits what changed and what is about to start. */
export function calendarConnector(opts: { command: string; args?: string[]; days?: number; intervalMs?: number; statePath?: string; now?: () => Date }): EventConnector {
  const days = opts.days ?? 3;
  const now = opts.now ?? (() => new Date());
  const store = senseState<{ snapshot?: CalendarState }>(opts.statePath, () => ({}));
  return {
    id: 'calendar',
    intervalMs: opts.intervalMs ?? 3 * 60_000,
    async poll() {
      const { state } = await store.load();
      const raw = parseJsonArray(await runReader(opts.command, opts.args ?? [], { days }, 90_000), 'calendar reader') as CalendarItem[];
      const items = raw.filter((e) => e && typeof e.id === 'string' && typeof e.title === 'string' && !Number.isNaN(Date.parse(e.start)));
      const diff = diffCalendar(state.snapshot, items, now(), days * 86_400_000);
      state.snapshot = diff.state;
      await store.save();
      return { events: diff.events, parseFailures: raw.length - items.length };
    },
  };
}

export interface BrowserVisit {
  url: string;
  title: string;
  /** Last visit time, ms since epoch. */
  at: number;
  browser: string;
}

const COCOA_EPOCH_MS = Date.UTC(2001, 0, 1);
const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000;

/** Yab keeps one row per page with its last visit (Cocoa seconds). */
export function readYabHistory(raw: string): BrowserVisit[] {
  const data = JSON.parse(raw) as unknown;
  const list = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown[] })?.items) ? (data as { items: unknown[] }).items : [];
  return (list as Array<{ url?: unknown; title?: unknown; last?: unknown }>)
    .filter((v) => v && typeof v.url === 'string' && typeof v.last === 'number')
    .map((v) => ({ url: v.url as string, title: String(v.title || v.url), at: Math.round(COCOA_EPOCH_MS + (v.last as number) * 1000), browser: 'Yab' }));
}

async function readChromiumHistory(dbPath: string, browser: string): Promise<BrowserVisit[]> {
  const tmp = path.join(os.tmpdir(), `rufus-hist-${process.pid}-${Date.now()}.sqlite`);
  try {
    await fs.copyFile(dbPath, tmp); // the live file is locked while the browser runs
    const { stdout } = await execFileAsync('sqlite3', ['-separator', '\t', tmp, 'SELECT last_visit_time, url, title FROM urls ORDER BY last_visit_time DESC LIMIT 50;'], { timeout: 5000 });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [t, url = '', title = ''] = line.split('\t');
        return { url, title: title.trim() || url, at: Math.round(Number(t) / 1000 - CHROMIUM_EPOCH_OFFSET_MS), browser };
      })
      .filter((v) => v.url && v.at > 0 && !/^(chrome|ardia|about|devtools):/.test(v.url));
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** The browsers this Mac has: Yab's JSON history, and Chromium-style History files (Ardia, Ask, Chrome, Arc, Brave). */
export function defaultBrowserSources(home = os.homedir()): Array<{ browser: string; path: string; format: 'yab' | 'chromium' }> {
  const support = path.join(home, 'Library', 'Application Support');
  return [
    { browser: 'Yab', path: path.join(support, 'Yab', 'history.json'), format: 'yab' },
    { browser: 'Ardia', path: path.join(support, 'com.ardia.browser', 'Chromium', 'Default', 'History'), format: 'chromium' },
    { browser: 'Ask', path: path.join(support, 'AskBrowser', 'Default', 'History'), format: 'chromium' },
    { browser: 'Chrome', path: path.join(support, 'Google', 'Chrome', 'Default', 'History'), format: 'chromium' },
    { browser: 'Arc', path: path.join(support, 'Arc', 'User Data', 'Default', 'History'), format: 'chromium' },
    { browser: 'Brave', path: path.join(support, 'BraveSoftware', 'Brave-Browser', 'Default', 'History'), format: 'chromium' },
  ];
}

/**
 * Browser history connector: one event per page visit since the last poll, keyed by URL plus visit time.
 * The first run only records where history stands, so old history never floods in.
 */
export function browserConnector(opts: { sources?: ReturnType<typeof defaultBrowserSources>; intervalMs?: number; statePath?: string }): EventConnector {
  const sources = opts.sources ?? defaultBrowserSources();
  const store = senseState(opts.statePath, () => ({ since: {} as Record<string, number> }));
  return {
    id: 'browser-history',
    intervalMs: opts.intervalMs ?? 2 * 60_000,
    async poll() {
      const { state } = await store.load();
      const out: LosslessEvent[] = [];
      let parseFailures = 0;
      let readAny = false;
      const errors: string[] = [];
      for (const src of sources) {
        if (!(await fs.stat(src.path).then((s) => s.isFile()).catch(() => false))) continue;
        let visits: BrowserVisit[];
        try {
          visits = src.format === 'yab' ? readYabHistory(await fs.readFile(src.path, 'utf8')) : await readChromiumHistory(src.path, src.browser);
          readAny = true;
        } catch (err) {
          errors.push(`${src.browser}: ${err instanceof Error ? err.message : String(err)}`);
          parseFailures++;
          continue;
        }
        const newest = visits.reduce((m, v) => Math.max(m, v.at), 0);
        const since = state.since[src.browser];
        if (since === undefined) {
          state.since[src.browser] = newest; // baseline
          continue;
        }
        const fresh = visits.filter((v) => v.at > since).sort((x, y) => x.at - y.at).slice(-25);
        for (const v of fresh) {
          out.push(
            genericEvent({
              id: `br_${keyHash(`${v.url}@${v.at}`)}`,
              source: 'browser',
              kind: 'visit',
              text: `Visited ${v.title} (${v.url})`,
              timestamp: new Date(v.at).toISOString(),
              metadata: { url: v.url, title: v.title, browser: v.browser, features: [`browser:${v.browser}`] },
            }),
          );
        }
        if (newest > since) state.since[src.browser] = newest;
      }
      await store.save();
      if (!readAny && errors.length) throw new Error(errors.join('; '));
      return { events: out, parseFailures };
    },
  };
}

export interface RepoSource {
  name: string;
  dir: string;
}

/** Project repos named in `<workspace>/projects/*.md` (`**Repo:**` / `**Repos:**` lines with backticked paths). */
export async function discoverRepos(workspaceDir: string): Promise<RepoSource[]> {
  const projDir = path.join(workspaceDir, 'projects');
  const files = (await fs.readdir(projDir).catch(() => [])).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort();
  const out: RepoSource[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const raw = await fs.readFile(path.join(projDir, f), 'utf8').catch(() => '');
    const line = /\*\*Repos?:\*\*(.*)$/im.exec(raw)?.[1] ?? '';
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const dir = m[1]!.replace(/^~(?=\/)/, os.homedir());
      if (!path.isAbsolute(dir) || seen.has(dir)) continue;
      if (!(await fs.stat(path.join(dir, '.git')).catch(() => null))) continue;
      seen.add(dir);
      out.push({ name: `${f.replace(/\.md$/, '')}/${path.basename(dir)}`, dir });
    }
  }
  return out;
}

interface RepoState {
  commits: Record<string, string[]>;
  deploys: Record<string, Record<string, string>>;
  ci: Record<string, Record<string, string>>;
}

/**
 * Project repos sense: new commits on any local branch, CI runs finishing (GitHub CLI, when installed),
 * and deploys changing state (Vercel CLI, for repos linked with `.vercel/`). This is reality for gaps that depend on shipping.
 */
export function repoConnector(opts: {
  repos: () => Promise<RepoSource[]>;
  intervalMs?: number;
  statePath?: string;
  ghBin?: string;
  vercelBin?: string;
  now?: () => Date;
}): EventConnector {
  const now = opts.now ?? (() => new Date());
  const store = senseState<RepoState>(opts.statePath, () => ({ commits: {}, deploys: {}, ci: {} }));
  const run = async (bin: string, args: string[], cwd: string) => (await execFileAsync(bin, args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  const exists = (p: string | undefined) => (p ? fs.stat(p).then(() => true).catch(() => false) : Promise.resolve(false));
  return {
    id: 'repos',
    intervalMs: opts.intervalMs ?? 5 * 60_000,
    async poll() {
      const { state } = await store.load();
      state.ci ??= {};
      const out: LosslessEvent[] = [];
      let parseFailures = 0;
      const at = now().toISOString();
      const repos = await opts.repos();
      const hasGh = await exists(opts.ghBin);
      for (const repo of repos) {
        // Commits on every local branch since the last poll.
        try {
          const log = await run('git', ['log', '--branches', '-n', '30', '--format=%H%x09%aI%x09%an%x09%D%x09%s'], repo.dir);
          const rows = log.split('\n').filter(Boolean).map((l) => l.split('\t'));
          const known = state.commits[repo.dir];
          const shas = rows.map((r) => r[0]!).filter(Boolean);
          if (known) {
            const knownSet = new Set(known);
            for (const r of rows.filter((x) => x[0] && !knownSet.has(x[0])).reverse()) {
              const [sha = '', when = '', author = '', refs = '', subject = ''] = r;
              out.push(
                genericEvent({
                  id: `commit_${sha.slice(0, 16)}`,
                  source: 'repo',
                  kind: 'commit',
                  actor: author,
                  text: `New commit in ${repo.name}${refs ? ` (${refs})` : ''}: ${subject}`,
                  timestamp: Number.isNaN(Date.parse(when)) ? at : new Date(when).toISOString(),
                  metadata: { repo: repo.name, dir: repo.dir, sha, refs, features: [`repo:${repo.name}`] },
                }),
              );
            }
          }
          state.commits[repo.dir] = [...new Set([...shas, ...(known ?? [])])].slice(0, 200);
        } catch {
          parseFailures++;
        }

        // CI runs (GitHub Actions) finishing.
        if (hasGh) {
          try {
            const runs = JSON.parse(await run(opts.ghBin!, ['run', 'list', '--limit', '10', '--json', 'databaseId,name,status,conclusion,headBranch,url,updatedAt'], repo.dir)) as Array<{
              databaseId: number;
              name?: string;
              status?: string;
              conclusion?: string;
              headBranch?: string;
              url?: string;
              updatedAt?: string;
            }>;
            const prev = state.ci[repo.dir];
            const next: Record<string, string> = {};
            for (const r of runs) {
              const st = r.status === 'completed' ? r.conclusion || 'completed' : r.status || 'unknown';
              next[String(r.databaseId)] = st;
              if (prev && prev[String(r.databaseId)] !== st && r.status === 'completed') {
                out.push(
                  genericEvent({
                    id: `ci_${r.databaseId}_${st}`,
                    source: 'repo',
                    kind: st === 'success' ? 'ci_passed' : 'ci_failed',
                    text: `CI ${r.name ?? 'run'} on ${repo.name}${r.headBranch ? ` (${r.headBranch})` : ''} finished: ${st}`,
                    timestamp: r.updatedAt && !Number.isNaN(Date.parse(r.updatedAt)) ? new Date(r.updatedAt).toISOString() : at,
                    metadata: { repo: repo.name, runId: r.databaseId, conclusion: st, ...(r.url ? { url: r.url } : {}) },
                  }),
                );
              }
            }
            state.ci[repo.dir] = next;
          } catch {
            /* no GitHub remote or not signed in: commits and deploys still count */
          }
        }

        // Deploys (Vercel) changing state.
        if ((await exists(opts.vercelBin)) && (await exists(path.join(repo.dir, '.vercel', 'project.json')))) {
          try {
            const data = JSON.parse(await run(opts.vercelBin!, ['ls', '--format', 'json'], repo.dir)) as {
              deployments?: Array<{ url: string; state?: string; target?: string | null; createdAt?: number; meta?: { gitCommitRef?: string; gitCommitMessage?: string } }>;
            };
            const prev = state.deploys[repo.dir];
            const next: Record<string, string> = {};
            for (const d of (data.deployments ?? []).slice(0, 10)) {
              const st = String(d.state ?? 'UNKNOWN').toUpperCase();
              next[d.url] = st;
              if (prev && prev[d.url] !== st && ['READY', 'ERROR', 'CANCELED'].includes(st)) {
                out.push(
                  genericEvent({
                    id: `deploy_${keyHash(d.url)}_${st.toLowerCase()}`,
                    source: 'repo',
                    kind: st === 'READY' ? 'deploy_ready' : 'deploy_failed',
                    text: `${d.target === 'production' ? 'Production' : 'Preview'} deploy of ${repo.name}${d.meta?.gitCommitRef ? ` (${d.meta.gitCommitRef})` : ''} is ${st}: ${d.meta?.gitCommitMessage?.split('\n')[0] ?? d.url}`,
                    timestamp: at,
                    metadata: { repo: repo.name, url: d.url, state: st, target: d.target ?? 'preview' },
                  }),
                );
              }
            }
            state.deploys[repo.dir] = next;
          } catch {
            /* offline or signed out of Vercel: try again next poll */
          }
        }
      }
      await store.save();
      return { events: out, parseFailures };
    },
  };
}

/** Auto-discovers custom workspace connectors in `<workspace>/connectors/*.mjs` exporting `poll()` (and optional `intervalMs`). */
export async function loadCustomConnectors(workspaceDir: string): Promise<EventConnector[]> {
  const dir = path.join(workspaceDir, 'connectors');
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.mjs') && !f.startsWith('.')).sort();
  const out: EventConnector[] = [];
  for (const f of files) {
    try {
      const full = path.join(dir, f);
      const stat = await fs.stat(full);
      const mod = (await import(/* @vite-ignore */ `${pathToFileURL(full).href}?m=${Math.round(stat.mtimeMs)}`)) as {
        id?: string;
        intervalMs?: number;
        poll?: () => Promise<LosslessEvent[]>;
      };
      if (typeof mod.poll === 'function') {
        out.push({
          id: mod.id || f.replace(/\.mjs$/, ''),
          intervalMs: mod.intervalMs ?? 60_000,
          poll: mod.poll,
        });
      }
    } catch {
      /* skip broken connector */
    }
  }
  return out;
}

type CommandCfg = { command?: string; args?: string[]; timeoutMs?: number };

/** Convenience loader: builds all configured connectors from workspace + optional ~/.rufus/config.json. */
export async function buildDefaultConnectors(
  workspaceDir: string,
  opts: { recentSent?: () => Promise<string[]> } = {},
): Promise<EventConnector[]> {
  const out: EventConnector[] = [];
  let beeperCfg: { token?: string; baseUrl?: string; url?: string; apiUrl?: string } | undefined;
  let gmailCmd: CommandCfg | undefined;
  let calendarCmd: CommandCfg | undefined;

  for (const cfgPath of [path.join(workspaceDir, 'config.json'), path.join(os.homedir(), '.rufus', 'config.json')]) {
    try {
      const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
        beeper?: { token?: string; baseUrl?: string; url?: string; apiUrl?: string };
        tools?: { commands?: Record<string, CommandCfg> };
      };
      if (!beeperCfg && cfg.beeper?.token) beeperCfg = cfg.beeper;
      if (!gmailCmd && cfg.tools?.commands?.['gmail.read']?.command) gmailCmd = cfg.tools.commands['gmail.read'];
      if (!calendarCmd && cfg.tools?.commands?.['calendar.read']?.command) calendarCmd = cfg.tools.commands['calendar.read'];
    } catch {
      /* ignore */
    }
  }

  const statePath = (id: string) => senseStatePath(workspaceDir, id);
  if (beeperCfg?.token) {
    const baseUrl = beeperCfg.baseUrl || beeperCfg.url || beeperCfg.apiUrl;
    out.push(beeperConnector({ token: beeperCfg.token, ...(baseUrl ? { baseUrl } : {}), statePath: statePath('beeper'), ...(opts.recentSent ? { recentSent: opts.recentSent } : {}) }));
  }
  if (gmailCmd?.command) {
    out.push(gmailConnector({ command: gmailCmd.command, args: gmailCmd.args ?? [], ...(gmailCmd.timeoutMs ? { timeoutMs: gmailCmd.timeoutMs } : {}) }));
  }
  if (calendarCmd?.command) {
    out.push(calendarConnector({ command: calendarCmd.command, args: calendarCmd.args ?? [], statePath: statePath('calendar') }));
  }
  out.push(watchConnector(workspaceDir));
  out.push(browserConnector({ statePath: statePath('browser-history') }));
  out.push(
    repoConnector({
      repos: () => discoverRepos(workspaceDir),
      statePath: statePath('repos'),
      ghBin: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((p) => existsSync(p)),
      vercelBin: ['/opt/homebrew/bin/vercel', '/usr/local/bin/vercel'].find((p) => existsSync(p)),
    }),
  );
  // A built-in sense replaces a workspace connector of the same id.
  const builtIn = new Set(out.map((c) => c.id));
  out.push(...(await loadCustomConnectors(workspaceDir)).filter((c) => !builtIn.has(c.id)));
  return out;
}
