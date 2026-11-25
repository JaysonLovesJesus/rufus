import { createHash } from 'node:crypto';

/**
 * One thing that happened in your life, from any local source: a chat exchange, an email, a visited page, a note you
 * edited, a calendar event. Source-agnostic on purpose, so flows can ask one question across all of them.
 */
export interface CorpusItem {
  /** Stable identity. Collecting the same source twice never duplicates an item with the same id. */
  id: string;
  /** Where it came from: `chat`, `email`, `browser`, `file`, `calendar`, or your own. */
  source: 'chat' | 'email' | 'browser' | 'file' | 'calendar' | (string & {});
  /** What it is within the source: `note`, `visit`, `event`, `received`, `sent`, `exchange`, ... */
  kind: string;
  title?: string;
  /** A short, searchable description (capped at 500 characters). Never a full document or message body. */
  summary: string;
  /** The person or party involved (email counterpart, event organizer, chat sender). */
  actor?: string;
  /** Website or email-sender domain, lowercase, without `www.`. */
  domain?: string;
  /** Local file path, for file items. */
  path?: string;
  /** ISO 8601, UTC. When it happened (file: last modified; event: start; page: last visit). */
  timestamp: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** What every adapter takes. Adapters add their own options on top. */
export interface CollectOptions {
  /** The file, folder or export to read. */
  path: string;
  /** Keep only the N most recent items. */
  limit?: number;
}

/** A pluggable local source: read something on this machine, return normalized `CorpusItem`s. Zero network, zero dependencies. */
export interface SourceAdapter<O extends CollectOptions = CollectOptions> {
  /** Adapter name used on the command line, e.g. `files`. */
  id: string;
  /** The `CorpusItem.source` its items carry. */
  source: CorpusItem['source'];
  collect(options: O): Promise<CorpusItem[]>;
}

export const MAX_SUMMARY = 500;

export const clip = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Deterministic id: `<prefix>_<16 hex chars of sha256 over the parts>`. */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)}`;
}

/** Turns a raw value into a clean `CorpusItem`, or says why not. Used by the store, so a corrupt line never poisons a query. */
export function normalizeItem(raw: unknown): { item: CorpusItem } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'not an object' };
  const r = raw as Record<string, unknown>;
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const id = text(r.id);
  const source = text(r.source);
  const kind = text(r.kind);
  const summary = text(r.summary);
  if (!id) return { error: 'missing "id"' };
  if (!source) return { error: 'missing "source"' };
  if (!kind) return { error: 'missing "kind"' };
  if (!summary) return { error: 'missing "summary"' };
  const ts = text(r.timestamp);
  const ms = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(ms)) return { error: 'missing or unreadable "timestamp"' };
  const tags = Array.isArray(r.tags) ? [...new Set(r.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()))] : [];
  const meta = typeof r.metadata === 'object' && r.metadata !== null && !Array.isArray(r.metadata) ? (r.metadata as Record<string, unknown>) : undefined;
  const domain = text(r.domain)?.toLowerCase().replace(/^www\./, '');
  return {
    item: {
      id,
      source,
      kind,
      ...(text(r.title) ? { title: clip(text(r.title)!, 200) } : {}),
      summary: clip(summary, MAX_SUMMARY),
      ...(text(r.actor) ? { actor: text(r.actor)! } : {}),
      ...(domain ? { domain } : {}),
      ...(text(r.path) ? { path: text(r.path)! } : {}),
      timestamp: new Date(ms).toISOString(),
      ...(tags.length ? { tags } : {}),
      ...(meta ? { metadata: meta } : {}),
    },
  };
}

/** Newest first, then id: a stable order for `limit`. */
export const byNewest = (a: CorpusItem, b: CorpusItem): number => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id);

/** Applies `limit` (the N most recent items) and returns them newest first. */
export function limitNewest(items: CorpusItem[], limit?: number): CorpusItem[] {
  const sorted = [...items].sort(byNewest);
  return limit !== undefined && limit > 0 ? sorted.slice(0, Math.floor(limit)) : sorted;
}

/** `JSON array` or `JSONL` text -> raw records. A line that is not JSON is skipped and counted. */
export function parseJsonRecords(text: string): { records: unknown[]; bad: number } {
  const trimmed = text.trim();
  if (!trimmed) return { records: [], bad: 0 };
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('Expected a JSON array.');
    return { records: parsed, bad: 0 };
  }
  if (trimmed.startsWith('{')) {
    try {
      return { records: [JSON.parse(trimmed)], bad: 0 }; // one (possibly pretty-printed) object
    } catch {
      // not a single object: fall through to JSONL
    }
  }
  const records: unknown[] = [];
  let bad = 0;
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      bad++;
    }
  }
  return { records, bad };
}

/** `www.Example.org` -> `example.org`; `undefined` if `host` is not a plausible hostname. */
export function cleanDomain(host: string | undefined): string | undefined {
  const h = host?.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return h && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) && h.includes('.') ? h : undefined;
}
