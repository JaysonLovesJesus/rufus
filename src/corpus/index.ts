// The unified local activity corpus: chats, email, browsing, files and calendar as one list of `CorpusItem`s, plus code-first
// ways to read it. Everything here is deterministic arithmetic over local data: $0, no AI, no network, milliseconds.
import path from 'node:path';
import type { HistoryPair } from '../history/types';
import { DAY_MS, rankWeights, recencyWeight, resolveRecencyMode, toMs, type TimeLike } from '../recency';
import { aiPromptsAdapter } from './adapters/ai-prompts';
import { cosineSimilarity, type EmbeddingLookup } from './embeddings';
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
export { aiPromptsAdapter, cleanPromptText, humanPrompts, tagPrompt, type AiPromptsOptions, type PromptKind } from './adapters/ai-prompts';
export { browserAdapter, parseVisitTime, visitFromRecord, visitsToItems, type BrowserOptions } from './adapters/browser';
export { calendarAdapter, parseIcs, type CalendarOptions } from './adapters/calendar';
export { emailAdapter, parseAddress, splitMbox, type EmailOptions } from './adapters/email';
export { parseRRule, occurrencesBetween, describeRecurrence, type Recurrence } from './recurrence';
export * from './embeddings';

// ---------- Collecting ----------

/** The built-in adapters, by the id used on the command line. */
export const ADAPTERS: Record<string, SourceAdapter<any>> = {
  files: filesAdapter,
  browser: browserAdapter,
  calendar: calendarAdapter,
  email: emailAdapter,
  'ai-prompts': aiPromptsAdapter,
};

/** `files`, `browser`, `calendar`, `email` or `ai-prompts` (the singular `file` also works). */
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

// ---------- Recency ----------

/** Corpus items weigh by observation rank by default: the Nth newest item counts half as much as the newest. */
export const DEFAULT_CORPUS_HALF_LIFE_OBSERVATIONS = 200;

interface WeightKnobs {
  halfLifeDays?: number;
  halfLifeObservations?: number;
}

/**
 * Per-item weight. Default is evidence pace (`halfLifeObservations`, 200): ten messages in two days move the picture as much
 * as ten over six months. `halfLifeDays` (explicit only) switches to a calendar timer; `0` turns weighting off. Future and
 * unreadable timestamps (upcoming events) count fully and take no rank.
 */
function corpusWeigher(items: CorpusItem[], nowMs: number, o: WeightKnobs): { weigh: (i: CorpusItem) => number; mode: ReturnType<typeof resolveRecencyMode> } {
  const mode = resolveRecencyMode(o, DEFAULT_CORPUS_HALF_LIFE_OBSERVATIONS);
  if (mode.kind === 'off') return { weigh: () => 1, mode };
  if (mode.kind === 'days') return { weigh: (i) => recencyWeight(i.timestamp, nowMs, mode.half), mode };
  const past = items.filter((i) => (toMs(i.timestamp) ?? Infinity) <= nowMs);
  const weights = rankWeights(past.map((i) => i.timestamp), mode.half);
  const byItem = new Map(past.map((i, k) => [i, weights[k]!] as const));
  return { weigh: (i) => byItem.get(i) ?? 1, mode };
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

const AUTOMATED_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|alerts?|mailer[-_.]?daemon|postmaster|bounces?)(?:[-_.+].*)?$/i;
const AUTOMATED_HOST_LABELS = new Set(['accounts', 'business-updates', 'messages', 'notifications', 'notification', 'alerts', 'noreply', 'no-reply']);

/**
 * Deterministic: is this email from a machine (security notice, digest, receipt robot) rather than a person or a portal you
 * use? Looks at the sender address (`noreply`, `no-reply`, `donotreply`, `notifications`, `alerts`, `mailer-daemon`) and at
 * sender domains that start with `accounts.`, `business-updates.`, `messages.`.
 */
export function isAutomatedSender(item: Pick<CorpusItem, 'source' | 'actor' | 'domain' | 'metadata'>): boolean {
  if (item.source !== 'email') return false;
  const from = (item.metadata as { from?: unknown } | undefined)?.from;
  const address = typeof from === 'string' ? from : item.actor?.includes('@') ? item.actor : undefined;
  const local = address?.split('@')[0]?.trim();
  if (local && AUTOMATED_LOCAL.test(local)) return true;
  const parts = item.domain?.toLowerCase().split('.') ?? [];
  return parts.length >= 3 && AUTOMATED_HOST_LABELS.has(parts[0]!);
}

/** Folder names that say nothing about which project a file belongs to. */
export const GENERIC_FOLDERS = new Set(['outbox', 'inbox', 'docs', 'doc', 'notes', 'private', 'tmp', 'temp', 'src', 'data', 'assets', 'archive', 'drafts', 'logs']);
const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}(?:[-_T ].*)?$/;
const isGenericFolder = (name: string): boolean => GENERIC_FOLDERS.has(name.toLowerCase()) || DATE_FOLDER.test(name);

/** The nearest folder at or above `dir` that names a project; `dir` itself when everything above is generic. */
export function projectFolderOf(dir: string): string {
  let cur = dir;
  while (isGenericFolder(path.basename(cur))) {
    const up = path.dirname(cur);
    if (up === cur || !path.basename(up)) return dir;
    cur = up;
  }
  return cur;
}

/** Shortest trailing path (`name`, then `parent/name`, ...) that tells every folder apart. */
function uniqueLabels(dirs: string[]): Map<string, string> {
  const segs = new Map(dirs.map((d) => [d, d.split(/[\\/]+/).filter(Boolean)] as const));
  const out = new Map<string, string>();
  for (const d of dirs) {
    const parts = segs.get(d)!;
    let n = 1;
    const label = (k: number): string => parts.slice(-k).join('/') || d;
    while (n < parts.length && dirs.some((o) => o !== d && label(n) === segs.get(o)!.slice(-n).join('/'))) n++;
    out.set(d, label(n));
  }
  return out;
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
  /** A short, unambiguous label (`project-a`, or `parent/project-a` when two projects share a name). */
  name: string;
  path: string;
  files: number;
  weight: number;
  lastModified: string;
}

export interface AutomatedSender {
  /** Sender domain of machine-sent mail (notifications, alerts, digests). */
  domain: string;
  count: number;
  weight: number;
  lastSeen: string;
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
  /** Set only when a calendar half-life was passed explicitly. */
  halfLifeDays?: number;
  /** Set when weighting follows observation rank (the default, 200 items). */
  halfLifeObservations?: number;
  total: number;
  span?: { from: string; to: string };
  bySource: SourceVolume[];
  /** Most active websites and human email senders, recency-weighted (automated mail is listed apart in `automated`). */
  domains: DomainActivity[];
  /** Notification / alert / digest senders, kept out of `domains` so real sites and people are not buried. */
  automated: AutomatedSender[];
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
  /** Calendar decay, used only when passed: days for an item's weight to halve. `0` or `Infinity` turns weighting off. */
  halfLifeDays?: number;
  /** Rank decay (the default, 200): the Nth newest item weighs half the newest, however long those N took. Wins over `halfLifeDays`. */
  halfLifeObservations?: number;
  /** How many domains / projects / files to list. Default 8. */
  topN?: number;
  /** How far ahead "upcoming" looks. Default 7 days. */
  horizonDays?: number;
  /** Domains that are never counted (default: the common mail providers). */
  ignoreDomains?: string[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A Life Context Snapshot: what the corpus says about your life *lately*. Every number is recency-weighted by observation
 * rank (exponential decay, `halfLifeObservations` default 200), so what you did in your latest items outweighs old history at the
 * pace of the evidence, not a wall-clock timer, yet nothing is thrown away. Pass `halfLifeDays` for a calendar decay instead.
 * Pure and deterministic for a given `now`.
 */
export function buildCorpusSummary(items: CorpusItem[], opts: SummaryOptions = {}): CorpusSummary {
  const nowMs = toMs(opts.now) ?? Date.now();
  const { weigh: w, mode } = corpusWeigher(items, nowMs, opts);
  const topN = Math.max(1, Math.floor(opts.topN ?? 8));
  const horizonDays = opts.horizonDays ?? 7;
  const ignore = new Set((opts.ignoreDomains ?? GENERIC_MAIL_DOMAINS).map((d) => d.toLowerCase()));

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
  const autos = new Map<string, { weight: number; count: number; last: string }>();
  for (const i of items) {
    if (!i.domain || (i.source !== 'browser' && i.source !== 'email') || (i.source === 'email' && ignore.has(i.domain))) continue;
    if (isAutomatedSender(i)) {
      const a = autos.get(i.domain) ?? { weight: 0, count: 0, last: i.timestamp };
      a.weight += w(i);
      a.count++;
      if (i.timestamp > a.last) a.last = i.timestamp;
      autos.set(i.domain, a);
      continue;
    }
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

  const automated: AutomatedSender[] = [...autos.entries()]
    .map(([domain, a]) => ({ domain, count: a.count, weight: r2(a.weight), lastSeen: a.last }))
    .sort((a, b) => b.weight - a.weight || a.domain.localeCompare(b.domain))
    .slice(0, topN);

  // Files and projects.
  const files = items.filter((i) => i.source === 'file' && i.path);
  const folders = new Map<string, { files: number; weight: number; last: string }>();
  for (const f of files) {
    const dir = projectFolderOf(path.dirname(f.path!));
    const e = folders.get(dir) ?? { files: 0, weight: 0, last: f.timestamp };
    e.files++;
    e.weight += w(f);
    if (f.timestamp > e.last) e.last = f.timestamp;
    folders.set(dir, e);
  }
  const labels = uniqueLabels([...folders.keys()]);
  const projects: ProjectActivity[] = [...folders.entries()]
    .map(([dir, e]) => ({ name: labels.get(dir) ?? (path.basename(dir) || dir), path: dir, files: e.files, weight: r2(e.weight), lastModified: e.last }))
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path))
    .slice(0, topN);
  const recentFiles = [...files]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id))
    .slice(0, topN)
    .map((f) => ({ title: f.title ?? path.basename(f.path!), path: f.path!, timestamp: f.timestamp, weight: r2(w(f)), tags: f.tags ?? [] }));

  return {
    now: iso(nowMs),
    ...(mode.kind === 'days' ? { halfLifeDays: mode.half } : {}),
    ...(mode.kind === 'rank' ? { halfLifeObservations: mode.half } : {}),
    total: items.length,
    ...(stamps.length ? { span: { from: stamps[0]!, to: stamps.at(-1)! } } : {}),
    bySource: [...bySource.entries()]
      .map(([source, e]) => ({ source, count: e.count, weight: r2(e.weight), share: totalWeight ? Math.round((e.weight / totalWeight) * 1000) / 1000 : 0, newest: e.newest }))
      .sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source)),
    domains: domains.slice(0, topN),
    automated,
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
  /** Calendar recency decay, used only when passed (days to halve). `0` or `Infinity` ranks by relevance alone. */
  halfLifeDays?: number;
  /** Rank decay (the default, 200): the Nth newest candidate weighs half the newest. Wins over `halfLifeDays`. */
  halfLifeObservations?: number;
  /** Near-duplicates (same source, same normalized title) are collapsed to `maxPerTitle`. Default true; `false` keeps every one. */
  dedupeTitles?: boolean;
  /** How many items with the same source and title may appear. Default 2. */
  maxPerTitle?: number;
  /** When several sources match, guarantee each a share of the top results so one noisy source cannot fill them all. Default true. */
  diversify?: boolean;
  /**
   * Cached vectors for hybrid retrieval (`await cache.lookup(provider, query)`). With them, an item's relevance blends keyword
   * match and cosine similarity, so a note that says "rescheduling" is found by "reschedule" even with no shared exact word.
   * Items with no cached vector are scored by keywords alone. Without this option the search is keyword-only, as before.
   */
  embeddings?: EmbeddingLookup;
  /** Share of relevance given to vector similarity when `embeddings` is passed (0-1). Default 0.5. */
  semanticWeight?: number;
  /** Cosine similarity below this counts as no semantic match (0-1). Default 0.25 (hashed local vectors score unrelated text around 0.2); raise it for neural models, whose unrelated pairs still score around 0.3-0.5. */
  minSimilarity?: number;
}

export interface CorpusHit {
  item: CorpusItem;
  /** Relevance x recency; higher is better. */
  score: number;
  /** Cosine similarity to the query (0-1, after `minSimilarity`), when vectors were used and this item has one. */
  similarity?: number;
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
 * weak new one, but between equals the newer wins. With `embeddings` (cached vectors) it is hybrid: keyword relevance and
 * cosine similarity are blended, then weighted by observation recency, then spread across sources.
 */
export function queryCorpus(items: CorpusItem[], opts: QueryOptions = {}): CorpusHit[] {
  const nowMs = toMs(opts.now) ?? Date.now();
  const limit = Math.max(1, Math.floor(opts.limit ?? 10));
  const sources = opts.sources?.length ? new Set(opts.sources.map((s) => (s === 'files' ? 'file' : s))) : undefined;
  const since = opts.sinceDays !== undefined ? nowMs - opts.sinceDays * DAY_MS : undefined;
  const terms = [...new Set(words(opts.query ?? '').filter((t) => !STOP.has(t)))];
  const phrase = terms.length > 1 ? terms.join(' ') : undefined;
  const lookup = opts.embeddings;
  const semanticWeight = Math.min(1, Math.max(0, opts.semanticWeight ?? 0.5));
  const minSimilarity = Math.min(0.99, Math.max(0, opts.minSimilarity ?? 0.25));
  const maxRelevance = terms.length * 3 + (phrase ? 2 : 0); // an exact title hit on every word, plus the phrase bonus

  // Recency is ranked among the candidates you asked about (their sources and period), at the pace of the evidence.
  const candidates = items.filter((item) => (!sources || sources.has(item.source)) && (since === undefined || Date.parse(item.timestamp) >= since));
  const { weigh } = corpusWeigher(candidates, nowMs, opts);

  const hits: CorpusHit[] = [];
  for (const item of candidates) {
    const recency = weigh(item);
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
    const vec = lookup?.vector(item.id);
    const similarity = vec ? Math.max(0, (cosineSimilarity(lookup!.query, vec) - minSimilarity) / (1 - minSimilarity)) : 0;
    if (!matched.length && similarity <= 0) continue;
    if (matched.length && phrase && words(`${item.title ?? ''} ${item.summary}`).join(' ').includes(phrase)) relevance += 2;
    const blended = lookup ? (1 - semanticWeight) * Math.min(1, relevance / maxRelevance) + semanticWeight * similarity : relevance;
    hits.push({ item, score: Math.round(blended * (0.3 + 0.7 * recency) * 1000) / 1000, matched, ...(lookup && vec ? { similarity: Math.round(similarity * 1000) / 1000 } : {}) });
  }
  let ranked = hits.sort((a, b) => b.score - a.score || b.item.timestamp.localeCompare(a.item.timestamp) || a.item.id.localeCompare(b.item.id));

  if (opts.dedupeTitles !== false) {
    const maxPer = Math.max(1, Math.floor(opts.maxPerTitle ?? 2));
    const seen = new Map<string, number>();
    ranked = ranked.filter((h) => {
      const title = normalizeTitle(h.item.title);
      if (!title) return true;
      const key = `${h.item.source}\u0000${title}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return n <= maxPer;
    });
  }
  if (opts.diversify === false || sources?.size === 1) return ranked.slice(0, limit);
  return diversify(ranked, limit);
}

/** `Captions.TXT`, `captions.txt ` and `captions (2).txt` are the same thing for deduplication. */
const normalizeTitle = (t: string | undefined): string => (t ?? '').toLowerCase().replace(/\(\d+\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Keep the best `floor` items of every matching source (floor = limit / (2 x sources), at least 1), then fill the rest by
 * score. The result stays sorted by score. With one matching source this is a plain top-N.
 */
function diversify(ranked: CorpusHit[], limit: number): CorpusHit[] {
  const bySource = new Map<string, CorpusHit[]>();
  for (const h of ranked) bySource.set(h.item.source, [...(bySource.get(h.item.source) ?? []), h]);
  if (bySource.size < 2) return ranked.slice(0, limit);
  const floor = Math.max(1, Math.floor(limit / (2 * bySource.size)));
  const picked = new Set<CorpusHit>();
  // Sources are visited best-first, so with more sources than slots the strongest sources win.
  for (const hs of [...bySource.values()].sort((a, b) => b[0]!.score - a[0]!.score)) {
    for (const h of hs.slice(0, floor)) if (picked.size < limit) picked.add(h);
  }
  for (const h of ranked) if (picked.size < limit) picked.add(h);
  return ranked.filter((h) => picked.has(h));
}

// ---------- Plain-English output ----------

const day = (t: string): string => t.slice(0, 10);

export function formatCorpusSummary(s: CorpusSummary): string[] {
  if (!s.total) return ['The corpus is empty. Collect something first: rufus collect files ./notes  (also: calendar, browser, email).'];
  const basis = s.halfLifeObservations !== undefined ? `observation-weighted, half-life ${Math.round(s.halfLifeObservations)} items` : s.halfLifeDays !== undefined ? `recency-weighted, half-life ${Math.round(s.halfLifeDays)} days` : 'unweighted';
  const lines = [`Life Context Snapshot (${basis}): ${s.total} item(s)${s.span ? ` from ${day(s.span.from)} to ${day(s.span.to)}` : ''}.`, '', 'By source (raw count, share of recent activity):'];
  for (const v of s.bySource) lines.push(`  ${v.source}: ${v.count} (${Math.round(v.share * 100)}% of recent activity, newest ${day(v.newest)})`);
  if (s.domains.length) {
    lines.push('', 'Active sites & human contacts:');
    for (const d of s.domains) lines.push(`  ${d.domain}: ${d.count} ${d.count === 1 ? 'visit/email' : 'visits/emails'} on ${d.activeDays} day(s), last ${day(d.lastSeen)} (${d.sources.join('+')})${d.category ? ` [${d.category}]` : ''}${d.recurring ? ' - recurring' : ''}`);
  }
  if (s.automated.length) lines.push('', `Automated alerts / digests: ${s.automated.map((a) => `${a.domain} (${a.count})`).join(', ')}.`);
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
    const proposal = (i.metadata as { context?: unknown } | undefined)?.context;
    return `${day(i.timestamp)}  [${i.source}/${i.kind}] ${i.title ?? i.summary}${who}${i.title ? `\n            ${clip(i.summary, 140)}` : ''}${i.path ? `\n            ${i.path}` : ''}${typeof proposal === 'string' && proposal ? `\n            ${clip(proposal, 160)}` : ''}`;
  });
}
