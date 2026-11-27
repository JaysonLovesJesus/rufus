import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cosineSimilarity, createLocalEmbedder, type Embedder, type Vector } from '../embed';
import type { LosslessEvent, Provenance } from '../types';

interface StoredRecord {
  event: LosslessEvent;
  vector: Vector;
  /** Term counts for keyword (BM25) scoring. */
  terms: Map<string, number>;
  length: number;
}


async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

export interface MemoryHit {
  event: LosslessEvent;
  score: number;
}

/** A hit from a multi-query recall, labelled with the query (the trigger or a gap) it was picked for. */
export interface RecallHit extends MemoryHit {
  serves: string;
}

/** What Rufus said or did counts for less than what was observed or what the owner said; a claim the owner contradicted counts for less still. */
const PROVENANCE_WEIGHT: Record<Provenance, number> = { observed: 1, owner_said: 1, rufus_claimed: 0.65 };
const SUPERSEDED_WEIGHT = 0.3;
/** Share of relevance from exact words (BM25), so names, codes and addresses are found verbatim; the rest is meaning (cosine). */
const KEYWORD_WEIGHT = 0.3;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Recency only nudges: an old memory keeps at least RECENCY_FLOOR of its score, halving the rest every RECENCY_HALF_LIFE_DAYS. */
const RECENCY_FLOOR = 0.75;
const RECENCY_HALF_LIFE_DAYS = 30;
/** MMR trade-off between relevance and not repeating what was already picked. */
const MMR_LAMBDA = 0.7;

/** Where an event came from. Senses may set it; otherwise it follows from who produced the event. */
export function provenanceOf(e: LosslessEvent): Provenance {
  if (e.provenance) return e.provenance;
  // What the owner writes to Rufus, and what he writes to other people (sensed from his chats), are both his own words.
  if (e.kind === 'owner_direct' || e.kind === 'owner_sent') return 'owner_said';
  // Rufus's own messages, actions and self-set watches, including his messages echoed back by another channel.
  if (e.kind === 'assistant_sent' || e.source === 'self' || e.source === 'watch' || /^rufus$/i.test(e.actor ?? '')) return 'rufus_claimed';
  return 'observed';
}

export function supersededBy(e: LosslessEvent): string | undefined {
  const by = e.metadata?.supersededBy;
  return typeof by === 'string' && by ? by : undefined;
}

/** Lowercased letter/number runs with accents folded, so "não" matches "nao" and booking codes like QXZT77120 stay whole. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

function termCounts(text: string): { terms: Map<string, number>; length: number } {
  const terms = new Map<string, number>();
  const toks = tokenize(text);
  for (const t of toks) terms.set(t, (terms.get(t) ?? 0) + 1);
  return { terms, length: toks.length };
}

/**
 * Lossless append-only Event Store + local vector index.
 * Preserves every detail (exact timestamps, deleted flags, reactions, threadId, actor, metadata)
 * and retrieves top-K semantically relevant moments in milliseconds at $0.
 */
export class EventStore {
  readonly filePath: string;
  readonly vectorCachePath: string;
  private readonly embedder: Embedder;
  private records: StoredRecord[] = [];
  private seenIds = new Set<string>();
  private loaded = false;
  /** Keyword index stats: how many records contain each term, and the summed record length. */
  private docFreq = new Map<string, number>();
  private totalLength = 0;

  constructor(opts: { workspaceDir: string; embedder?: Embedder }) {
    this.filePath = path.join(opts.workspaceDir, 'events.jsonl');
    this.vectorCachePath = path.join(opts.workspaceDir, 'events.vectors.jsonl');
    this.embedder = opts.embedder ?? createLocalEmbedder();
  }

  private get modelId(): string {
    return this.embedder.modelId ?? 'default';
  }

  private eventText(e: LosslessEvent): string {
    return [
      e.source,
      e.kind,
      e.actor ?? '',
      e.channel ?? '',
      e.deleted ? 'deleted' : '',
      e.text,
      ...(e.reactions ?? []).map((r) => `reaction ${r.emoji} ${r.actor ?? ''}`),
    ]
      .filter(Boolean)
      .join(' ');
  }

  private async loadVectorCache(): Promise<Map<string, Vector>> {
    const map = new Map<string, Vector>();
    try {
      const raw = await fs.readFile(this.vectorCachePath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { id?: string; model?: string; vector?: Vector };
          if (entry.id && entry.model === this.modelId && Array.isArray(entry.vector)) {
            map.set(entry.id, entry.vector);
          }
        } catch {
          /* skip corrupt line */
        }
      }
    } catch {
      /* no cache yet */
    }
    return map;
  }

  private async appendVectorCache(id: string, vector: Vector): Promise<void> {
    await fs.mkdir(path.dirname(this.vectorCachePath), { recursive: true });
    await fs.appendFile(this.vectorCachePath, `${JSON.stringify({ id, model: this.modelId, vector })}\n`, 'utf8');
  }

  private async rewriteVectorCache(): Promise<void> {
    await fs.mkdir(path.dirname(this.vectorCachePath), { recursive: true });
    const content = this.records.map((r) => JSON.stringify({ id: r.event.id, model: this.modelId, vector: r.vector })).join('\n');
    await writeAtomic(this.vectorCachePath, content ? `${content}\n` : '');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const events: LosslessEvent[] = [];
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as LosslessEvent;
          if (!event.id || this.seenIds.has(event.id)) continue;
          this.seenIds.add(event.id);
          events.push(event);
        } catch {
          /* skip corrupt line */
        }
      }
    } catch {
      /* new store */
    }
    if (!events.length) return;

    const cached = await this.loadVectorCache();
    const missing: Array<{ idx: number; event: LosslessEvent }> = [];
    const vectors: Array<Vector | undefined> = events.map((event, idx) => {
      const hit = cached.get(event.id);
      if (!hit) missing.push({ idx, event });
      return hit;
    });

    if (missing.length) {
      const texts = missing.map((m) => this.eventText(m.event));
      const computed = this.embedder.embedBatch
        ? await this.embedder.embedBatch(texts)
        : await Promise.all(texts.map((t) => this.embedder.embed(t)));
      for (let i = 0; i < missing.length; i++) {
        vectors[missing[i]!.idx] = computed[i]!;
      }
    }

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      this.addRecord({ ...event, provenance: provenanceOf(event) }, vectors[i]!);
    }
    if (missing.length) await this.rewriteVectorCache().catch(() => undefined);
  }

  private addRecord(event: LosslessEvent, vector: Vector): StoredRecord {
    const rec: StoredRecord = { event, vector, ...termCounts(this.eventText(event)) };
    this.records.push(rec);
    this.indexTerms(rec, 1);
    return rec;
  }

  private indexTerms(rec: StoredRecord, sign: 1 | -1): void {
    for (const t of rec.terms.keys()) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + sign);
    this.totalLength += sign * rec.length;
  }

  /** A message from "Rufus" whose text Rufus already logged as sent is his own message echoed back by another channel, not new reality. */
  private isEchoOfSent(event: LosslessEvent): boolean {
    if (event.source !== 'message' || event.kind === 'assistant_sent' || !/^rufus$/i.test(event.actor ?? '')) return false;
    const key = tokenize(event.text).join(' ');
    if (!key) return false;
    return this.records.some((r) => r.event.kind === 'assistant_sent' && tokenize(r.event.text).join(' ') === key);
  }

  /** Appends a lossless event (deduplicating by id). Returns true if newly added. */
  async append(incoming: LosslessEvent): Promise<boolean> {
    await this.load();
    if (this.seenIds.has(incoming.id)) return false;
    this.seenIds.add(incoming.id);
    if (this.isEchoOfSent(incoming)) return false;
    const event: LosslessEvent = { ...incoming, provenance: provenanceOf(incoming) };
    const vector = await this.embedder.embed(this.eventText(event));
    this.addRecord(event, vector);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
    await this.appendVectorCache(event.id, vector).catch(() => undefined);
    return true;
  }

  /** Updates an existing event in place (e.g. marking deleted=true or adding a reaction without losing history). */
  /** Scores each text against the query with this store's embedder (cosine), so code can rank things by meaning. */
  async similarity(query: string, texts: readonly string[]): Promise<number[]> {
    if (!texts.length) return [];
    const q = await this.embedder.embed(query);
    const vs = this.embedder.embedBatch ? await this.embedder.embedBatch([...texts]) : await Promise.all(texts.map((t) => this.embedder.embed(t)));
    return vs.map((v) => cosineSimilarity(q, v));
  }

  async update(id: string, patch: Partial<Pick<LosslessEvent, 'deleted' | 'reactions' | 'metadata' | 'text'>>): Promise<boolean> {
    await this.load();
    const rec = this.records.find((r) => r.event.id === id);
    if (!rec) return false;
    rec.event = {
      ...rec.event,
      ...patch,
      ...(patch.reactions ? { reactions: [...(rec.event.reactions ?? []), ...patch.reactions] } : {}),
      ...(patch.metadata ? { metadata: { ...(rec.event.metadata ?? {}), ...patch.metadata } } : {}),
    };
    rec.vector = await this.embedder.embed(this.eventText(rec.event));
    this.indexTerms(rec, -1);
    Object.assign(rec, termCounts(this.eventText(rec.event)));
    this.indexTerms(rec, 1);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Write a copy and swap it in, so a crash mid-rewrite can never cut the log.
    await writeAtomic(this.filePath, `${this.records.map((r) => JSON.stringify(r.event)).join('\n')}\n`);
    await this.rewriteVectorCache().catch(() => undefined);
    return true;
  }

  async close(): Promise<void> {
    await this.embedder.close?.();
  }

  async count(): Promise<number> {
    await this.load();
    return this.records.length;
  }

  async has(id: string): Promise<boolean> {
    await this.load();
    return this.seenIds.has(id);
  }

  async recent(limit = 20): Promise<LosslessEvent[]> {
    await this.load();
    return this.records.slice(-limit).map((r) => r.event);
  }

  async get(id: string): Promise<LosslessEvent | undefined> {
    await this.load();
    return this.records.find((r) => r.event.id === id)?.event;
  }

  /** Marks one of Rufus's claims as superseded by a later fact (usually the owner contradicting it). The claim stays, ranked low and labelled. */
  async supersede(claimId: string, byEventId: string, opts: { reason?: string; at?: string } = {}): Promise<boolean> {
    return this.update(claimId, {
      metadata: {
        supersededBy: byEventId,
        supersededAt: opts.at ?? new Date().toISOString(),
        ...(opts.reason ? { supersededReason: opts.reason } : {}),
      },
    });
  }

  private candidates(opts: { excludeIds?: string[]; source?: string }): StoredRecord[] {
    const exclude = new Set(opts.excludeIds ?? []);
    return this.records.filter((r) => !exclude.has(r.event.id) && (!opts.source || r.event.source === opts.source));
  }

  /**
   * Hybrid relevance of every candidate to one query: meaning (cosine) plus exact words (BM25, scaled to this query's best match),
   * then nudged by recency and weighted by provenance so the facts outrank Rufus's own claims.
   */
  private async scoreAll(query: string, recs: readonly StoredRecord[], nowMs: number): Promise<number[]> {
    const qVec = await (this.embedder.embedQuery ? this.embedder.embedQuery(query) : this.embedder.embed(query));
    const qTerms = [...new Set(tokenize(query))];
    const n = this.records.length || 1;
    const avgLen = this.totalLength / n || 1;
    const idf = qTerms.map((t) => {
      const df = this.docFreq.get(t) ?? 0;
      return Math.log(1 + (n - df + 0.5) / (df + 0.5));
    });
    const bm25 = recs.map((r) => {
      let s = 0;
      qTerms.forEach((t, i) => {
        const tf = r.terms.get(t) ?? 0;
        if (tf) s += idf[i]! * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * r.length) / avgLen)));
      });
      return s;
    });
    const maxBm25 = Math.max(0, ...bm25);
    return recs.map((r, i) => {
      const meaning = cosineSimilarity(qVec, r.vector);
      const words = maxBm25 > 0 ? bm25[i]! / maxBm25 : 0;
      const rel = (1 - KEYWORD_WEIGHT) * meaning + KEYWORD_WEIGHT * words;
      if (rel <= 0) return rel;
      const ageDays = Math.max(0, (nowMs - Date.parse(r.event.timestamp)) / 86_400_000) || 0;
      const recency = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
      const trust = PROVENANCE_WEIGHT[provenanceOf(r.event)] * (supersededBy(r.event) ? SUPERSEDED_WEIGHT : 1);
      return rel * recency * trust;
    });
  }

  async search(query: string, k = 6, opts: { excludeIds?: string[]; source?: string; now?: Date } = {}): Promise<MemoryHit[]> {
    await this.load();
    const recs = this.candidates(opts);
    if (!recs.length) return [];
    const scores = await this.scoreAll(query, recs, (opts.now ?? new Date()).getTime());
    return recs
      .map((r, i) => ({ event: r.event, score: scores[i]! }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
  }

  /**
   * One search per query (the trigger, and each gap in play), merged with MMR: the queries take turns picking their most relevant
   * memory that is not a near-repeat of one already picked. Each hit is labelled with the query it was picked for.
   */
  async searchEach(
    queries: ReadonlyArray<{ key: string; text: string }>,
    k = 6,
    opts: { excludeIds?: string[]; source?: string; now?: Date } = {},
  ): Promise<RecallHit[]> {
    await this.load();
    const recs = this.candidates(opts);
    const live = queries.filter((q) => q.text.trim());
    if (!recs.length || !live.length || k <= 0) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const pools = await Promise.all(
      live.map(async (q) => {
        const scores = await this.scoreAll(q.text, recs, nowMs);
        const ranked = recs.map((_, i) => i).filter((i) => scores[i]! > 0).sort((a, b) => scores[b]! - scores[a]!).slice(0, k * 4);
        return { key: q.key, ranked, scores, top: ranked.length ? scores[ranked[0]!]! : 0 };
      }),
    );
    const picked: RecallHit[] = [];
    const pickedIdx: number[] = [];
    let progress = true;
    while (picked.length < k && progress) {
      progress = false;
      for (const pool of pools) {
        if (picked.length >= k) break;
        let best = -1;
        let bestMmr = -Infinity;
        for (const i of pool.ranked) {
          if (pickedIdx.includes(i)) continue;
          const rel = pool.scores[i]! / (pool.top || 1);
          const redundancy = pickedIdx.length ? Math.max(...pickedIdx.map((j) => cosineSimilarity(recs[i]!.vector, recs[j]!.vector))) : 0;
          const mmr = MMR_LAMBDA * rel - (1 - MMR_LAMBDA) * redundancy;
          if (mmr > bestMmr) {
            bestMmr = mmr;
            best = i;
          }
        }
        if (best < 0) continue;
        pickedIdx.push(best);
        picked.push({ event: recs[best]!.event, score: pool.scores[best]!, serves: pool.key });
        progress = true;
      }
    }
    return picked;
  }
}
