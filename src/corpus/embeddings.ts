// Cached, incremental embeddings: natural, example-driven learning needs to find the past moments that look like this one,
// by meaning and by shape, without re-reading (or re-paying for) everything each time.
//
//   EmbeddingProvider   { id, dimensions, embed(texts) }: `local` (offline, $0, zero dependencies), `ollama` (local neural,
//                       $0), `gemini` and `http` (an OpenAI-compatible /embeddings endpoint). Plain `fetch`, keys in headers only.
//   EmbeddingCache      <workspace>/corpus/embeddings.jsonl: one `{ id, model, hash, vector }` per line. `sync(items, provider)`
//                       embeds ONLY new or changed items (same id + model + SHA-256 of the text = already done), so adding one
//                       email, note or reply costs one embedding, not a rebuild.
//   cosineSimilarity    the pure-TS dot product behind retrieval.
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoryPair } from '../history/types';
import type { EmbeddingConfig } from '../types';
import type { CorpusItem } from './types';

// ---------- Interface ----------

export interface EmbeddingProvider {
  /** Names the vector space (`local-hash-256`, `ollama:nomic-embed-text`, ...). Cached vectors are only compared within one id. */
  id: string;
  /** Length of every vector. Remote providers learn it from their first response when the config does not say. */
  dimensions: number;
  /** One L2-normalized vector per text, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

/** One thing to embed: a stable id and the text that represents it. */
export interface EmbedItem {
  id: string;
  text: string;
}

export interface CachedVector {
  id: string;
  /** The `EmbeddingProvider.id` that produced it. */
  model: string;
  /** SHA-256 (hex) of the exact text that was embedded. */
  hash: string;
  vector: number[];
}

export interface SyncReport {
  /** Embedded now: new items, or items whose text changed. */
  embedded: number;
  /** Already cached with the same model and text hash: skipped. */
  cached: number;
  /** Items considered (`embedded + cached`). */
  total: number;
}

/** A query already embedded against a cache: what `queryCorpus` and `retrieveSimilarExamples` take as `embeddings`. */
export interface EmbeddingLookup {
  model: string;
  /** The embedded query text. */
  query: number[];
  /** The cached vector for an item id, if there is one. */
  vector(id: string): number[] | undefined;
}

// ---------- Math ----------

/** Cosine similarity in [-1, 1]. Zero vectors and vectors of different lengths score 0. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Scale to unit length (a zero vector stays zero). */
export function normalizeVector(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  if (n === 0) return v.slice();
  const s = 1 / Math.sqrt(n);
  return v.map((x) => x * s);
}

// ---------- Local provider: hashed character trigrams + words ----------

export const LOCAL_DIMENSIONS = 256;

const LOCAL_STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'my', 'is', 'it', 'at', 'by', 'me', 'i', 'you', 'we', 'be', 'so', 'do', 'if', 'as', 'that', 'this', 'are', 'was']);

/** Lowercased word tokens (letters and digits, any script). */
export const tokenize = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** FNV-1a over UTF-16 code units, with a seed so one string can yield two independent hashes. */
function fnv(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic, offline embedding (feature hashing). Each word, each character trigram of each word (`^dent`, `ent`, `nti`,
 * ...: this is what makes `reschedule` close to `rescheduling` and `appt` close to `appointment`) and each adjacent word pair
 * is hashed into one of `dimensions` buckets with a +/- sign, then the vector is scaled to unit length. Same text, same
 * vector, every machine. It catches morphology and shared wording, not synonyms: use `ollama` or `gemini` for those.
 */
export function localEmbed(text: string, dimensions = LOCAL_DIMENSIONS): number[] {
  const counts = new Map<string, number>();
  const bump = (feature: string, weight: number): void => void counts.set(feature, (counts.get(feature) ?? 0) + weight);
  const toks = tokenize(text);
  toks.forEach((w, i) => {
    const stop = LOCAL_STOP.has(w);
    bump(`w:${w}`, stop ? 0.25 : 1);
    const padded = `^${w}$`;
    if (padded.length <= 3) bump(`t:${padded}`, stop ? 0.1 : 0.5);
    else for (let k = 0; k + 3 <= padded.length; k++) bump(`t:${padded.slice(k, k + 3)}`, stop ? 0.1 : 0.5);
    const next = toks[i + 1];
    if (next !== undefined && !(stop && LOCAL_STOP.has(next))) bump(`b:${w} ${next}`, 0.6);
  });
  const v = new Array<number>(dimensions).fill(0);
  for (const [feature, weight] of counts) {
    const slot = fnv(feature, 0) % dimensions;
    const sign = fnv(feature, 0x9e3779b9) & 1 ? 1 : -1;
    // Sublinear: a word repeated ten times counts about 3x, not 10x.
    v[slot]! += sign * (weight >= 1 ? 1 + Math.log(weight) : weight);
  }
  return normalizeVector(v);
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  constructor(readonly dimensions: number = LOCAL_DIMENSIONS) {
    this.id = `local-hash-${dimensions}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => localEmbed(t, this.dimensions));
  }
}

// ---------- Remote providers (plain fetch, keys in headers only) ----------

const DEFAULT_TIMEOUT_MS = 60_000;

/** Remove anything that looks like the configured key (or a Google / bearer key) from text that may reach a log or the user. */
function scrub(text: string, key: string | undefined): string {
  let out = text;
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]').replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]');
}

async function postJson(opts: { label: string; url: string; headers?: Record<string, string>; body: unknown; fetchImpl: typeof fetch; timeoutMs?: number; key?: string }): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await opts.fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`${opts.label} embedding request timed out after ${timeoutMs}ms.`);
    throw new Error(`${opts.label} embedding request failed: ${scrub((err as Error).message ?? String(err), opts.key)}`);
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  if (!res.ok) throw new Error(`${opts.label} embedding request failed: ${res.status} ${scrub(raw, opts.key).slice(0, 300)}`.trim());
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${opts.label} embedding response was not JSON.`);
  }
}

const isVector = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

function checkVectors(label: string, got: unknown, expected: number): number[][] {
  if (!Array.isArray(got) || got.length !== expected || !got.every(isVector)) {
    throw new Error(`${label} returned ${Array.isArray(got) ? got.length : 0} usable vector(s) for ${expected} text(s).`);
  }
  return (got as number[][]).map(normalizeVector);
}

const chunked = <T>(xs: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_MODEL = 'nomic-embed-text';

/** Local neural embeddings through Ollama (`POST /api/embed`). $0, nothing leaves your machine. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  dimensions: number;
  constructor(
    private readonly cfg: Pick<EmbeddingConfig, 'model' | 'baseUrl' | 'dimensions' | 'timeoutMs'> = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.id = `ollama:${cfg.model ?? OLLAMA_DEFAULT_MODEL}`;
    this.dimensions = cfg.dimensions ?? 768;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const base = (this.cfg.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const out: number[][] = [];
    for (const batch of chunked(texts, 32)) {
      const data = (await postJson({ label: 'Ollama', url: `${base}/api/embed`, body: { model: this.cfg.model ?? OLLAMA_DEFAULT_MODEL, input: batch }, fetchImpl: this.fetchImpl, timeoutMs: this.cfg.timeoutMs })) as { embeddings?: unknown };
      out.push(...checkVectors('Ollama', data.embeddings, batch.length));
    }
    if (out[0]) this.dimensions = out[0].length;
    return out;
  }
}

export const GEMINI_EMBEDDING_DEFAULT_MODEL = 'gemini-embedding-001';
export const GEMINI_EMBEDDING_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini embeddings (`models/<model>:batchEmbedContents`, the batch form of `embedContent`). The key travels in `x-goog-api-key`, never a URL. */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  dimensions: number;
  constructor(
    private readonly cfg: Pick<EmbeddingConfig, 'model' | 'baseUrl' | 'dimensions' | 'apiKey' | 'apiKeyEnv' | 'timeoutMs'> = {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.dimensions = cfg.dimensions ?? 768;
    this.id = `gemini:${cfg.model ?? GEMINI_EMBEDDING_DEFAULT_MODEL}:${this.dimensions}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const envName = this.cfg.apiKeyEnv ?? 'GEMINI_API_KEY';
    const key = this.cfg.apiKey || this.env[envName] || undefined;
    if (!key) throw new Error(`Gemini API key missing: set the ${envName} environment variable (or "apiKey" in the embeddings config).`);
    const model = this.cfg.model ?? GEMINI_EMBEDDING_DEFAULT_MODEL;
    const base = (this.cfg.baseUrl ?? GEMINI_EMBEDDING_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const out: number[][] = [];
    for (const batch of chunked(texts, 100)) {
      const body = {
        requests: batch.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: 'SEMANTIC_SIMILARITY', outputDimensionality: this.dimensions })),
      };
      const data = (await postJson({ label: 'Gemini', url: `${base}/models/${encodeURIComponent(model)}:batchEmbedContents`, headers: { 'x-goog-api-key': key }, body, fetchImpl: this.fetchImpl, timeoutMs: this.cfg.timeoutMs, key })) as { embeddings?: Array<{ values?: unknown }> };
      out.push(...checkVectors('Gemini', (data.embeddings ?? []).map((e) => e.values), batch.length));
    }
    return out;
  }
}

/** Any OpenAI-compatible `/embeddings` endpoint (OpenAI, OpenRouter, vLLM, LM Studio, ...). The key goes in the `authorization` header only. */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  dimensions: number;
  constructor(
    private readonly cfg: Pick<EmbeddingConfig, 'model' | 'baseUrl' | 'dimensions' | 'apiKey' | 'apiKeyEnv' | 'timeoutMs'> & { baseUrl: string; model: string },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.id = `http:${cfg.model}`;
    this.dimensions = cfg.dimensions ?? 0;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const key = this.cfg.apiKey || this.env[this.cfg.apiKeyEnv ?? 'RUFUS_API_KEY'] || undefined;
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    const out: number[][] = [];
    for (const batch of chunked(texts, 64)) {
      const data = (await postJson({ label: 'HTTP', url: `${base}/embeddings`, headers: key ? { authorization: `Bearer ${key}` } : {}, body: { model: this.cfg.model, input: batch, ...(this.cfg.dimensions ? { dimensions: this.cfg.dimensions } : {}) }, fetchImpl: this.fetchImpl, timeoutMs: this.cfg.timeoutMs, key })) as { data?: Array<{ embedding?: unknown; index?: number }> };
      const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      out.push(...checkVectors('HTTP embeddings endpoint', rows.map((r) => r.embedding), batch.length));
    }
    if (out[0]) this.dimensions = out[0].length;
    return out;
  }
}

/** Build the configured provider. No config means `local`: free, offline, works immediately. */
export function createEmbeddingProvider(cfg: EmbeddingConfig = {}, fetchImpl: typeof fetch = fetch, env: Record<string, string | undefined> = process.env): EmbeddingProvider {
  switch (cfg.type ?? 'local') {
    case 'local':
      return new LocalEmbeddingProvider(cfg.dimensions ?? LOCAL_DIMENSIONS);
    case 'ollama':
      return new OllamaEmbeddingProvider(cfg, fetchImpl);
    case 'gemini':
      return new GeminiEmbeddingProvider(cfg, fetchImpl, env);
    case 'http':
      if (!cfg.baseUrl || !cfg.model) throw new Error('The "http" embedding provider needs "baseUrl" and "model" (an OpenAI-compatible /embeddings endpoint).');
      return new HttpEmbeddingProvider({ ...cfg, baseUrl: cfg.baseUrl, model: cfg.model }, fetchImpl, env);
    default:
      throw new Error(`Unknown embedding provider "${String((cfg as { type?: unknown }).type)}". Use local, ollama, gemini or http.`);
  }
}

// ---------- What gets embedded ----------

const MAX_EMBED_CHARS = 1500;

/** The searchable text of a corpus item. A human reply's `priorProposal` rides along, clearly labeled as someone else's words. */
export function embedTextOfItem(item: CorpusItem): string {
  const prior = (item.metadata as { priorProposal?: unknown } | undefined)?.priorProposal;
  const parts = [item.title, item.summary, item.actor, item.domain, ...(item.tags ?? []), typeof prior === 'string' && prior ? `[In response to proposal: ${prior}]` : undefined];
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(' · ').slice(0, MAX_EMBED_CHARS);
}

export const corpusEmbedItems = (items: CorpusItem[]): EmbedItem[] => items.map((i) => ({ id: i.id, text: embedTextOfItem(i) }));

/** The cache id of a history pair. Only what *they* wrote (`incoming`) is embedded: the thing a new message is matched against. */
export const pairEmbedId = (p: Pick<HistoryPair, 'id'>): string => `pair:${p.id}`;

export const pairEmbedItems = (pairs: HistoryPair[]): EmbedItem[] => pairs.map((p) => ({ id: pairEmbedId(p), text: p.incoming.slice(0, MAX_EMBED_CHARS) }));

// ---------- The cache ----------

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const round5 = (v: number[]): number[] => v.map((x) => Math.round(x * 1e5) / 1e5);

/**
 * `<workspace>/corpus/embeddings.jsonl`: one `{ id, model, hash, vector }` per line, so a vector is reused as long as its id,
 * model and text hash match. Written atomically (temp file + rename). A missing file is an empty cache; a corrupt line is skipped.
 */
export class EmbeddingCache {
  constructor(readonly file: string) {}

  private async readAll(): Promise<CachedVector[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: CachedVector[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Partial<CachedVector>;
        if (typeof r.id === 'string' && typeof r.model === 'string' && typeof r.hash === 'string' && isVector(r.vector)) out.push(r as CachedVector);
      } catch {
        // a corrupt line is skipped, never fatal
      }
    }
    return out;
  }

  /** Every cached vector made by `model`, by item id. */
  async load(model: string): Promise<Map<string, CachedVector>> {
    return new Map((await this.readAll()).filter((e) => e.model === model).map((e) => [e.id, e] as const));
  }

  /** How many vectors are cached, per model. */
  async stats(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const e of await this.readAll()) out[e.model] = (out[e.model] ?? 0) + 1;
    return out;
  }

  /**
   * Make sure every item has a current vector from `provider`. Items whose id, model and text hash already match are skipped,
   * so the second run over unchanged data embeds nothing and an edited item is re-embedded alone. Progress is saved if the
   * provider fails part-way. With `prune`, vectors of this model for ids that are not in `items` are dropped.
   */
  async sync(items: EmbedItem[], provider: EmbeddingProvider, opts: { prune?: boolean; chunkSize?: number } = {}): Promise<SyncReport> {
    const all = await this.readAll();
    const key = (model: string, id: string): string => `${model}\u0000${id}`;
    const entries = new Map(all.map((e) => [key(e.model, e.id), e] as const));

    const unique = new Map<string, { id: string; text: string; hash: string }>();
    for (const it of items) if (it.text.trim()) unique.set(it.id, { id: it.id, text: it.text, hash: sha256(it.text) });
    const todo = [...unique.values()].filter((it) => entries.get(key(provider.id, it.id))?.hash !== it.hash);

    let embedded = 0;
    let changed = false;
    let failure: unknown;
    try {
      for (const batch of chunked(todo, Math.max(1, opts.chunkSize ?? 128))) {
        const vectors = await provider.embed(batch.map((b) => b.text));
        if (vectors.length !== batch.length) throw new Error(`Embedding provider ${provider.id} returned ${vectors.length} vector(s) for ${batch.length} text(s).`);
        batch.forEach((b, i) => entries.set(key(provider.id, b.id), { id: b.id, model: provider.id, hash: b.hash, vector: round5(vectors[i]!) }));
        embedded += batch.length;
        changed = true;
      }
    } catch (err) {
      failure = err;
    }
    if (opts.prune && failure === undefined) {
      for (const [k, e] of [...entries]) {
        if (e.model === provider.id && !unique.has(e.id)) {
          entries.delete(k);
          changed = true;
        }
      }
    }
    if (changed) await this.write([...entries.values()]);
    if (failure !== undefined) throw failure;
    return { embedded, cached: unique.size - embedded, total: unique.size };
  }

  /** Embed `queryText` and pair it with this cache's vectors for `provider`. `undefined` when nothing is cached for that model yet. */
  async lookup(provider: EmbeddingProvider, queryText: string): Promise<EmbeddingLookup | undefined> {
    const byId = await this.load(provider.id);
    if (!byId.size || !queryText.trim()) return undefined;
    const [query] = await provider.embed([queryText.slice(0, MAX_EMBED_CHARS)]);
    return query ? { model: provider.id, query, vector: (id) => byId.get(id)?.vector } : undefined;
  }

  private async write(entries: CachedVector[]): Promise<void> {
    const sorted = [...entries].sort((a, b) => a.model.localeCompare(b.model) || a.id.localeCompare(b.id));
    const tmp = `${this.file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, sorted.map((e) => JSON.stringify(e)).join('\n') + (sorted.length ? '\n' : ''), 'utf8');
    await fs.rename(tmp, this.file);
  }
}
