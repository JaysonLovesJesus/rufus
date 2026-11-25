// The unified local activity corpus: chats, email, browsing, files and calendar as one list of `CorpusItem`s, plus code-first
// ways to read it. Everything here is deterministic arithmetic over local data: $0, no AI, no network, milliseconds.
import path from 'node:path';
import type { HistoryPair } from '../history/types';
import { DAY_MS, recencyWeight, resolveHalfLife, toMs, type TimeLike } from '../recency';
import { browserAdapter } from './adapters/browser';
import { calendarAdapter } from './adapters/calendar';
import { emailAdapter } from './adapters/email';
import { filesAdapter } from './adapters/files';
import { describeRecurrence, occurrencesBetween, parseRRule } from './recurrence';
import { CorpusStore, type AddReport } from './store';
import { clip, stableId, type CollectOptions, type CorpusItem, type SourceAdapter } from './types';

export { CorpusStore, type AddReport } from './store';
export { clip, normalizeItem, stableId, type CollectOptions, type CorpusItem, type SourceAdapter } from './types';
export { filesAdapter, type FilesOptions } from './adapters/files';
export { browserAdapter, parseVisitTime, visitFromRecord, visitsToItems, type BrowserOptions } from './adapters/browser';
export { calendarAdapter, parseIcs, type CalendarOptions } from './adapters/calendar';
export { emailAdapter, parseAddress, splitMbox, type EmailOptions } from './adapters/email';
export { parseRRule, occurrencesBetween, describeRecurrence, type Recurrence } from './recurrence';

// ---------- Collecting ----------

/** The built-in adapters, by the id used on the command line. */
export const ADAPTERS: Record<string, SourceAdapter<any>> = {
  files: filesAdapter,
  browser: browserAdapter,
  calendar: calendarAdapter,
  email: emailAdapter,
};

/** `files`, `browser`, `calendar` or `email` (the singular `file` also works). */
export function getAdapter(id: string): SourceAdapter<any> {
  const key = id === 'file' ? 'files' : id;
  const a = ADAPTERS[key];
  if (!a) throw new Error(`Unknown source "${id}". Choose one of: ${Object.keys(ADAPTERS).join(', ')}.`);
  return a;
}

export interface CollectResult {
  adapter: string;
  /** What the adapter read (after `limit`). */
  items: CorpusItem[];
  report: AddReport;
  dryRun: boolean;
}

/** Read a source with its adapter and merge the items into the corpus (deduplicated by id). With `dryRun`, nothing is written. */
export async function collectInto<O extends CollectOptions>(store: CorpusStore, adapter: SourceAdapter<O>, options: O, opts: { dryRun?: boolean } = {}): Promise<CollectResult> {
  const items = await adapter.collect(options);
  const report = await store.add(items, { dryRun: opts.dryRun });
  return { adapter: adapter.id, items, report, dryRun: !!opts.dryRun };
}

/** Your answered chats (`rufus seed`) as corpus items, so one query can span chats too. Pairs with no timestamp are skipped. */
export function corpusItemsFromPairs(pairs: HistoryPair[]): CorpusItem[] {
  return pairs.flatMap((p): CorpusItem[] => {
    const at = toMs(p.incomingAt ?? p.replyAt);
    if (at === undefined) return [];
    return [
      {
        id: stableId('chat', p.id),
        source: 'chat',
        kind: 'exchange',
        summary: clip(`${p.sender}: ${p.incoming} → ${p.reply}`, 300),
        actor: p.sender,
        timestamp: new Date(at).toISOString(),
        tags: [p.channel],
        metadata: { channel: p.channel },
      },
    ];
  });
}

// ---------- Life context snapshot ----------

/** Mail providers say nothing about which service you rely on, so they are not "portals". */
export const GENERIC_MAIL_DOMAINS = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'fastmail.com', 'hey.com'];

export type DomainCategory = 'banking' | 'travel' | 'docs' | 'scheduling';

const CATEGORY_WORDS: Array<[DomainCategory, string[]]> = [
  ['banking', ['bank', 'credit', 'loan', 'mortgage', 'insurance', 'invest', 'broker', 'finance', 'tax', 'payroll', 'pay']],
  ['travel', ['air', 'airline', 'airlines', 'flight', 'flights', 'hotel', 'hotels', 'travel', 'trip', 'trips', 'rail', 'railway', 'cruise', 'stay', 'stays']],
  ['scheduling', ['calendar', 'cal', 'schedule', 'scheduling', 'appointment', 'appointments', 'meet', 'meeting']],
  ['docs', ['docs', 'drive', 'wiki', 'notes', 'sheets', 'slides', 'paper', 'pages', 'confluence']],
];

/** A rough, keyword-only guess at what a site is for (banking, travel, scheduling, docs); `undefined` when nothing in the name says. */
export function categoryOfDomain(domain: string): DomainCategory | undefined {
  const tokens = domain.toLowerCase().split(/[.-]/);
  for (const [category, words] of CATEGORY_WORDS) if (words.some((w) => tokens.some((t) => (w.length >= 5 ? t.includes(w) : t === w)))) return category;
  return undefined;
}

export interface SourceVolume {
  source: string;
  /** Raw number of items. */
  count: number;
  /** Recency-weighted volume: what this source says about your life lately. */
  weight: number;
  /** Share (0-1) of the total recency-weighted volume. */
  share: number;
  newest: string;
}

export interface DomainActivity {
  domain: string;
  /** Recency-weighted activity (browser visit counts add up logarithmically, so one page with thousands of visits cannot drown the rest). */
  weight: number;
  /** Raw visits plus emails. */
  count: number;
  sources: string[];
  /** Different calendar days it showed up on. */
  activeDays: number;
  lastSeen: string;
  /** Seen on 3 or more different days, or 10 or more times: a place you keep coming back to. */
  recurring: boolean;
  category?: DomainCategory;
}

export interface ProjectActivity {
  /** The folder's name. */
  name: string;
  path: string;
  files: number;
  weight: number;
  lastModified: string;
}

export interface UpcomingCommitment {
  title: string;
  start: string;
  end?: string;
  location?: string;
  attendees?: string[];
  recurring: boolean;
}

export interface RecurringCommitment {
  title: string;
  /** `weekly`, `every 2 weeks on Mon, Wed`, ... or `repeats` when the cadence is unknown. */
  cadence: string;
  /** The next occurrence from now, when it can be worked out. */
  next?: string;
  attendees?: string[];
  location?: string;
}

export interface CorpusSummary {
  now: string;
  halfLifeDays?: number;
  total: number;
  span?: { from: string; to: string };
  bySource: SourceVolume[];
  /** Most active websites and email senders, recency-weighted. */
  domains: DomainActivity[];
  /** The `domains` you keep coming back to. */
  portals: DomainActivity[];
  /** Folders of notes you have been working in lately. */
  projects: ProjectActivity[];
  recentFiles: Array<{ title: string; path: string; timestamp: string; weight: number; tags: string[] }>;
  calendar: { horizonDays: number; upcoming: UpcomingCommitment[]; recurring: RecurringCommitment[] };
}

export interface SummaryOptions {
  /** Reference "today". Default: now. */
  now?: TimeLike;
  /** Days for an item's weight to halve. Default 90, so this quarter outweighs two years ago. `0` or `Infinity` turns weighting off. */
  halfLifeDays?: number;
  /** How many domains / projects / files to list. Default 8. */
  topN?: number;
  /** How far ahead "upcoming" looks. Default 7 days. */
  horizonDays?: number;
  /** Domains that are never counted (default: the common mail providers). */
  ignoreDomains?: string[];
}

export const DEFAULT_CORPUS_HALF_LIFE_DAYS = 90;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A Life Context Snapshot: what the corpus says about your life *lately*. Every number is recency-weighted
 * (exponential decay, `halfLifeDays` default 90), so last month outweighs two years ago, yet nothing is thrown away.
 * Pure and deterministic for a given `now`.
 */
export function buildCorpusSummary(items: CorpusItem[], opts: SummaryOptions = {}): CorpusSummary {
  const nowMs = toMs(opts.now) ?? Date.now();
  const half = resolveHalfLife(opts.halfLifeDays, DEFAULT_CORPUS_HALF_LIFE_DAYS);
  const topN = Math.max(1, Math.floor(opts.topN ?? 8));
  const horizonDays = opts.horizonDays ?? 7;
  const ignore = new Set((opts.ignoreDomains ?? GENERIC_MAIL_DOMAINS).map((d) => d.toLowerCase()));
  const w = (i: CorpusItem): number => recencyWeight(i.timestamp, nowMs, half);

  const stamps = items.map((i) => i.timestamp).sort();
  const totalWeight = items.reduce((s, i) => s + w(i), 0);

  const bySource = new Map<string, { count: number; weight: number; newest: string }>();
  for (const i of items) {
    const e = bySource.get(i.source) ?? { count: 0, weight: 0, newest: i.timestamp };
    e.count++;
    e.weight += w(i);
    if (i.timestamp > e.newest) e.newest = i.timestamp;
    bySource.set(i.source, e);
  }

  // Domains: where you browse and who emails you, weighted by recency.
  const doms = new Map<string, { weight: number; count: number; sources: Set<string>; days: Set<string>; last: string }>();
  for (const i of items) {
    if (!i.domain || (i.source !== 'browser' && i.source !== 'email') || (i.source === 'email' && ignore.has(i.domain))) continue;
    const visits = i.source === 'browser' ? Math.max(1, Number((i.metadata as { visitCount?: unknown } | undefined)?.visitCount) || 1) : 1;
    const e = doms.get(i.domain) ?? { weight: 0, count: 0, sources: new Set<string>(), days: new Set<string>(), last: i.timestamp };
    e.weight += w(i) * (1 + Math.log(visits));
    e.count += visits;
    e.sources.add(i.source);
    e.days.add(i.timestamp.slice(0, 10));
    if (i.timestamp > e.last) e.last = i.timestamp;
    doms.set(i.domain, e);
  }
  const domains: DomainActivity[] = [...doms.entries()]
    .map(([domain, e]): DomainActivity => {
      const category = categoryOfDomain(domain);
      return {
        domain,
        weight: r2(e.weight),
        count: e.count,
        sources: [...e.sources].sort(),
        activeDays: e.days.size,
        lastSeen: e.last,
        recurring: e.days.size >= 3 || e.count >= 10,
        ...(category ? { category } : {}),
      };
    })
    .sort((a, b) => b.weight - a.weight || a.domain.localeCompare(b.domain));

  // Files and projects.
  const files = items.filter((i) => i.source === 'file' && i.path);
  const folders = new Map<string, { files: number; weight: number; last: string }>();
  for (const f of files) {
    const dir = path.dirname(f.path!);
    const e = folders.get(dir) ?? { files: 0, weight: 0, last: f.timestamp };
    e.files++;
    e.weight += w(f);
    if (f.timestamp > e.last) e.last = f.timestamp;
    folders.set(dir, e);
  }
  const projects: ProjectActivity[] = [...folders.entries()]
    .map(([dir, e]) => ({ name: path.basename(dir) || dir, path: dir, files: e.files, weight: r2(e.weight), lastModified: e.last }))
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path))
    .slice(0, topN);
  const recentFiles = [...files]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id))
    .slice(0, topN)
    .map((f) => ({ title: f.title ?? path.basename(f.path!), path: f.path!, timestamp: f.timestamp, weight: r2(w(f)), tags: f.tags ?? [] }));

  return {
    now: iso(nowMs),
    ...(half !== undefined ? { halfLifeDays: half } : {}),
    total: items.length,
    ...(stamps.length ? { span: { from: stamps[0]!, to: stamps.at(-1)! } } : {}),
    bySource: [...bySource.entries()]
      .map(([source, e]) => ({ source, count: e.count, weight: r2(e.weight), share: totalWeight ? Math.round((e.weight / totalWeight) * 1000) / 1000 : 0, newest: e.newest }))
      .sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source)),
    domains: domains.slice(0, topN),
    portals: domains.filter((d) => d.recurring).slice(0, topN),
    projects,
    recentFiles,
    calendar: { horizonDays, ...calendarOutlook(items, nowMs, horizonDays) },
  };
}

function calendarOutlook(items: CorpusItem[], nowMs: number, horizonDays: number): { upcoming: UpcomingCommitment[]; recurring: RecurringCommitment[] } {
  const horizon = nowMs + horizonDays * DAY_MS;
  const upcoming: UpcomingCommitment[] = [];
  const recurring: RecurringCommitment[] = [];
  for (const e of items.filter((i) => i.source === 'calendar' && i.kind === 'event')) {
    const m = (e.metadata ?? {}) as { end?: string; location?: string; attendees?: string[]; rrule?: string; recurring?: boolean };
    const start = Date.parse(e.timestamp);
    const length = m.end ? Math.max(0, Date.parse(m.end) - start) : 0;
    const common = { title: e.title ?? e.summary, ...(m.location ? { location: m.location } : {}), ...(m.attendees?.length ? { attendees: m.attendees } : {}) };
    const rule = m.rrule ? parseRRule(m.rrule) : undefined;
    if (rule || m.recurring) {
      const next = rule ? occurrencesBetween(start, rule, nowMs, nowMs + 400 * DAY_MS, 1)[0] : undefined;
      if (rule?.until !== undefined && rule.until < nowMs && next === undefined) continue; // the series has ended
      recurring.push({ title: common.title, cadence: rule ? describeRecurrence(rule) : 'repeats', ...(next !== undefined ? { next: iso(next) } : {}), ...(m.attendees?.length ? { attendees: m.attendees } : {}), ...(m.location ? { location: m.location } : {}) });
      if (rule) for (const t of occurrencesBetween(start, rule, nowMs, horizon, 20)) upcoming.push({ ...common, start: iso(t), ...(length ? { end: iso(t + length) } : {}), recurring: true });
    } else if (start <= horizon && start + length >= nowMs) upcoming.push({ ...common, start: e.timestamp, ...(m.end ? { end: m.end } : {}), recurring: false });
  }
  upcoming.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  recurring.sort((a, b) => (a.next ?? '9').localeCompare(b.next ?? '9') || a.title.localeCompare(b.title));
  return { upcoming: upcoming.slice(0, 25), recurring: recurring.slice(0, 25) };
}

// ---------- Query ----------

export interface QueryOptions {
  /** Words to look for. Empty: the most recent items. */
  query?: string;
  /** Only these sources (`email`, `browser`, `file`, `calendar`, `chat`). */
  sources?: string[];
  /** Only items from the last N days (future items, like upcoming events, always pass). */
  sinceDays?: number;
  /** Default 10. */
  limit?: number;
  now?: TimeLike;
  /** Recency half-life in days. Default 90. `0` or `Infinity` ranks by relevance alone. */
  halfLifeDays?: number;
}

export interface CorpusHit {
  item: CorpusItem;
  /** Relevance x recency; higher is better. */
  score: number;
  /** The query words that matched, so you can see why it came back. */
  matched: string[];
}

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'my', 'is', 'it', 'at', 'by', 'me', 'i']);
const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Fields searched, and how much a hit in each counts. */
const FIELDS: Array<[(i: CorpusItem) => string, number]> = [
  [(i) => i.title ?? '', 3],
  [(i) => (i.tags ?? []).join(' '), 2.5],
  [(i) => `${i.actor ?? ''} ${i.domain ?? ''}`, 2],
  [(i) => `${i.source} ${i.kind}`, 1.5],
  [(i) => i.summary, 1],
  [(i) => i.path ?? '', 0.7],
];

/**
 * Fast, deterministic keyword lookup across every source, ranked by relevance x recency. Call it inside any flow's
 * `ctx.code` step to hand the AI the exact emails, notes, events and sites that matter, at $0. A query word matches a
 * field word exactly (full credit) or as a prefix (70%). Recency softens, never erases: a perfect old match still beats a
 * weak new one, but between equals the newer wins.
 */
export function queryCorpus(items: CorpusItem[], opts: QueryOptions = {}): CorpusHit[] {
  const nowMs = toMs(opts.now) ?? Date.now();
  const half = resolveHalfLife(opts.halfLifeDays, DEFAULT_CORPUS_HALF_LIFE_DAYS);
  const limit = Math.max(1, Math.floor(opts.limit ?? 10));
  const sources = opts.sources?.length ? new Set(opts.sources.map((s) => (s === 'files' ? 'file' : s))) : undefined;
  const since = opts.sinceDays !== undefined ? nowMs - opts.sinceDays * DAY_MS : undefined;
  const terms = [...new Set(words(opts.query ?? '').filter((t) => !STOP.has(t)))];
  const phrase = terms.length > 1 ? terms.join(' ') : undefined;

  const hits: CorpusHit[] = [];
  for (const item of items) {
    if (sources && !sources.has(item.source)) continue;
    const at = Date.parse(item.timestamp);
    if (since !== undefined && at < since) continue;
    const recency = recencyWeight(at, nowMs, half);
    if (!terms.length) {
      hits.push({ item, score: recency, matched: [] });
      continue;
    }
    const fieldWords = FIELDS.map(([get, weight]) => ({ weight, words: words(get(item)) }));
    let relevance = 0;
    const matched: string[] = [];
    for (const t of terms) {
      let best = 0;
      for (const f of fieldWords) {
        for (const fw of f.words) {
          const q = fw === t ? 1 : t.length >= 3 && fw.startsWith(t) ? 0.7 : 0;
          if (q * f.weight > best) best = q * f.weight;
        }
      }
      if (best > 0) {
        relevance += best;
        matched.push(t);
      }
    }
    if (!matched.length) continue;
    if (phrase && words(`${item.title ?? ''} ${item.summary}`).join(' ').includes(phrase)) relevance += 2;
    hits.push({ item, score: Math.round(relevance * (0.3 + 0.7 * recency) * 1000) / 1000, matched });
  }
  return hits.sort((a, b) => b.score - a.score || b.item.timestamp.localeCompare(a.item.timestamp) || a.item.id.localeCompare(b.item.id)).slice(0, limit);
}

// ---------- Plain-English output ----------

const day = (t: string): string => t.slice(0, 10);

export function formatCorpusSummary(s: CorpusSummary): string[] {
  if (!s.total) return ['The corpus is empty. Collect something first: rufus collect files ./notes  (also: calendar, browser, email).'];
  const basis = s.halfLifeDays !== undefined ? `recency-weighted, half-life ${Math.round(s.halfLifeDays)} days` : 'unweighted';
  const lines = [`Life Context Snapshot (${basis}): ${s.total} item(s)${s.span ? ` from ${day(s.span.from)} to ${day(s.span.to)}` : ''}.`, '', 'By source (raw count, share of recent activity):'];
  for (const v of s.bySource) lines.push(`  ${v.source}: ${v.count} (${Math.round(v.share * 100)}% of recent activity, newest ${day(v.newest)})`);
  if (s.domains.length) {
    lines.push('', 'Top active sites and senders:');
    for (const d of s.domains) lines.push(`  ${d.domain}: ${d.count} ${d.count === 1 ? 'visit/email' : 'visits/emails'} on ${d.activeDays} day(s), last ${day(d.lastSeen)} (${d.sources.join('+')})${d.category ? ` [${d.category}]` : ''}${d.recurring ? ' - recurring' : ''}`);
  }
  if (s.projects.length) {
    lines.push('', 'Recently active projects (folders):');
    for (const p of s.projects) lines.push(`  ${p.name}: ${p.files} file(s), last edited ${day(p.lastModified)}`);
    lines.push('Recently edited files:');
    for (const f of s.recentFiles.slice(0, 5)) lines.push(`  ${day(f.timestamp)}  ${f.title}`);
  }
  const { upcoming, recurring, horizonDays } = s.calendar;
  if (upcoming.length || recurring.length) {
    lines.push('', `Calendar, next ${horizonDays} days:`);
    if (!upcoming.length) lines.push('  nothing scheduled.');
    for (const u of upcoming) lines.push(`  ${u.start.slice(0, 16).replace('T', ' ')}  ${u.title}${u.location ? ` @ ${u.location}` : ''}${u.recurring ? ' (recurring)' : ''}`);
    if (recurring.length) {
      lines.push('Recurring commitments:');
      for (const r of recurring) lines.push(`  ${r.title}: ${r.cadence}${r.next ? `, next ${r.next.slice(0, 16).replace('T', ' ')}` : ''}`);
    }
  }
  return lines;
}

export function formatHits(hits: CorpusHit[], query?: string): string[] {
  if (!hits.length) return [query ? `Nothing in the corpus matches "${query}".` : 'The corpus is empty.'];
  return hits.map((h) => {
    const i = h.item;
    const who = i.actor ? ` · ${i.actor}` : i.domain ? ` · ${i.domain}` : '';
    return `${day(i.timestamp)}  [${i.source}/${i.kind}] ${i.title ?? i.summary}${who}${i.title ? `\n            ${clip(i.summary, 140)}` : ''}${i.path ? `\n            ${i.path}` : ''}`;
  });
}
