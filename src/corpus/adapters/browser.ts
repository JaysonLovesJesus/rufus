// Browser adapter: a generic history export (JSON array / JSONL of { url, title, visitCount, lastVisitAt }), or, when the
// `sqlite3` CLI is available, a Chromium-family (Chrome, Arc, Edge, Brave) or Safari history database. A database is
// never opened in place: it is copied to a temp folder and queried read-only, so a running browser is never disturbed.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readHead } from '../fsutil';
import { cleanDomain, clip, limitNewest, parseJsonRecords, stableId, type CollectOptions, type CorpusItem, type SourceAdapter } from '../types';

const run = promisify(execFile);

export interface BrowserOptions extends CollectOptions {
  /** Keep query strings and fragments in stored URLs. Default false: they often carry tokens and search terms. */
  keepQuery?: boolean;
  /** The sqlite3 binary (default `sqlite3` on PATH). Only needed for database files. */
  sqlite3?: string;
}

const CHROMIUM_EPOCH_MS = 11644473600000; // 1601-01-01 -> 1970-01-01
const COCOA_EPOCH_S = 978307200; // 2001-01-01 -> 1970-01-01

/** A visit time as epoch ms. Numbers: > 1e16 Chromium microseconds, > 1e11 milliseconds, otherwise Unix seconds. Strings: ISO or numeric. */
export function parseVisitTime(v: unknown, epoch: 'auto' | 'chromium' | 'cocoa' = 'auto'): number | undefined {
  let n: number | undefined;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim()) n = /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined;
  if (n === undefined) {
    if (typeof v !== 'string') return undefined;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (epoch === 'chromium') return n / 1000 - CHROMIUM_EPOCH_MS;
  if (epoch === 'cocoa') return (n + COCOA_EPOCH_S) * 1000;
  if (n > 1e16) return n / 1000 - CHROMIUM_EPOCH_MS;
  if (n > 1e11) return n;
  return n * 1000;
}

const first = (r: Record<string, unknown>, keys: string[]): unknown => keys.map((k) => r[k]).find((v) => v !== undefined && v !== null && v !== '');

interface Visit {
  url: string;
  title?: string;
  visits: number;
  at: number;
}

/** One history row (generic or database) -> a visit, or `undefined` if it has no usable web address or time. */
export function visitFromRecord(raw: unknown, epoch: 'auto' | 'chromium' | 'cocoa' = 'auto'): Visit | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const url = first(r, ['url', 'URL', 'href']);
  if (typeof url !== 'string') return undefined;
  const at = parseVisitTime(first(r, ['lastVisitAt', 'lastVisitTime', 'last_visit_time', 'lastVisit', 'visitedAt', 'visit_time', 'timestamp', 'date', 'time']), epoch);
  if (at === undefined) return undefined;
  const title = first(r, ['title', 'name']);
  const count = Number(first(r, ['visitCount', 'visit_count', 'visits', 'count']) ?? 1);
  return { url, ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}), visits: Number.isFinite(count) && count > 0 ? Math.floor(count) : 1, at };
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Merge visits to the same page (summing visit counts, newest time wins) into corpus items. Non-web schemes are dropped. */
export function visitsToItems(visits: Visit[], opts: { keepQuery?: boolean } = {}): CorpusItem[] {
  const pages = new Map<string, { visit: Visit; host: string; shown: string }>();
  for (const v of visits) {
    let u: URL;
    try {
      u = new URL(v.url);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    const pathname = u.pathname.replace(/\/+$/, '') || '';
    const shown = `${u.protocol}//${u.host.replace(/^www\./i, '')}${pathname}${opts.keepQuery ? `${u.search}${u.hash}` : ''}`;
    const prev = pages.get(shown);
    if (!prev) pages.set(shown, { visit: { ...v }, host: u.hostname, shown });
    else {
      prev.visit.visits += v.visits;
      if (v.at > prev.visit.at) prev.visit.at = v.at;
      prev.visit.title ??= v.title;
    }
  }
  return [...pages.values()].map(({ visit, host, shown }) => {
    const domain = IPV4.test(host) ? undefined : cleanDomain(host);
    const where = domain ?? host;
    const pathText = new URL(shown).pathname === '/' ? '' : new URL(shown).pathname;
    const title = visit.title ?? `${where}${pathText}`;
    return {
      id: stableId('browser', shown),
      source: 'browser',
      kind: 'visit',
      title: clip(title, 200),
      summary: clip(`${title} (${where}${pathText}) · ${visit.visits} visit${visit.visits === 1 ? '' : 's'}`, 500),
      ...(domain ? { domain } : {}),
      timestamp: new Date(visit.at).toISOString(),
      metadata: { url: shown, visitCount: visit.visits },
    };
  });
}

const SQLITE_MAGIC = 'SQLite format 3\0';

async function sqliteJson(bin: string, db: string, sql: string): Promise<Array<Record<string, unknown>>> {
  try {
    const { stdout } = await run(bin, ['-readonly', '-json', db, sql], { maxBuffer: 256 * 1024 * 1024 });
    return stdout.trim() ? (JSON.parse(stdout) as Array<Record<string, unknown>>) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('The sqlite3 command is not installed, so a browser database cannot be read. Export your history to JSON ({ url, title, visitCount, lastVisitAt } per row) and collect that instead.');
    throw new Error(`Could not read the browser database: ${(err as Error).message.split('\n')[0]}`);
  }
}

/** Rows from a Chromium or Safari history database, read from a throwaway copy. */
export async function readHistoryDatabase(file: string, opts: { sqlite3?: string; limit?: number } = {}): Promise<{ rows: Array<Record<string, unknown>>; epoch: 'chromium' | 'cocoa' }> {
  const bin = opts.sqlite3 ?? 'sqlite3';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rufus-history-'));
  try {
    const copy = path.join(dir, 'history.db');
    await fs.copyFile(file, copy);
    for (const suffix of ['-wal', '-shm']) await fs.copyFile(`${file}${suffix}`, `${copy}${suffix}`).catch(() => undefined);
    const tables = new Set((await sqliteJson(bin, copy, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => String(r.name)));
    const limit = Math.max(1, Math.floor(opts.limit ?? 50000));
    if (tables.has('urls')) {
      const rows = await sqliteJson(bin, copy, `SELECT url, title, visit_count AS visitCount, last_visit_time AS lastVisit FROM urls ORDER BY last_visit_time DESC LIMIT ${limit}`);
      return { rows, epoch: 'chromium' };
    }
    if (tables.has('history_items') && tables.has('history_visits')) {
      const rows = await sqliteJson(
        bin,
        copy,
        `SELECT hi.url AS url, hi.visit_count AS visitCount, MAX(hv.visit_time) AS lastVisit, (SELECT title FROM history_visits WHERE history_item = hi.id ORDER BY visit_time DESC LIMIT 1) AS title FROM history_items hi JOIN history_visits hv ON hv.history_item = hi.id GROUP BY hi.id ORDER BY lastVisit DESC LIMIT ${limit}`,
      );
      return { rows, epoch: 'cocoa' };
    }
    throw new Error('This database does not look like Chromium (urls table) or Safari (history_items table) history.');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export const browserAdapter: SourceAdapter<BrowserOptions> = {
  id: 'browser',
  source: 'browser',
  async collect(options: BrowserOptions): Promise<CorpusItem[]> {
    const file = path.resolve(options.path);
    let head: Buffer;
    try {
      head = await readHead(file, 16);
    } catch {
      throw new Error(`Path not found: ${options.path}`);
    }
    let visits: Visit[];
    if (head.toString('latin1').startsWith(SQLITE_MAGIC)) {
      const { rows, epoch } = await readHistoryDatabase(file, { sqlite3: options.sqlite3, limit: options.limit ? options.limit * 4 : undefined });
      visits = rows.flatMap((r) => visitFromRecord(r, epoch) ?? []);
    } else {
      const { records } = parseJsonRecords(await fs.readFile(file, 'utf8'));
      visits = records.flatMap((r) => visitFromRecord(r) ?? []);
    }
    return limitNewest(visitsToItems(visits, options), options.limit);
  },
};
