import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLocalEmbedder, topKBySimilarity, type Embedder, type Vector } from '../embed';
import type { LosslessEvent } from '../types';

interface StoredRecord {
  event: LosslessEvent;
  vector: Vector;
}

/**
 * Lossless append-only Event Store + local vector index.
 * Preserves every detail (exact timestamps, deleted flags, reactions, threadId, actor, metadata)
 * and retrieves top-K semantically relevant moments in milliseconds at $0.
 */
export class EventStore {
  readonly filePath: string;
  private readonly embedder: Embedder;
  private records: StoredRecord[] = [];
  private seenIds = new Set<string>();
  private loaded = false;

  constructor(opts: { workspaceDir: string; embedder?: Embedder }) {
    this.filePath = path.join(opts.workspaceDir, 'events.jsonl');
    this.embedder = opts.embedder ?? createLocalEmbedder();
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

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as LosslessEvent;
          if (!event.id || this.seenIds.has(event.id)) continue;
          this.seenIds.add(event.id);
          const vector = await this.embedder.embed(this.eventText(event));
          this.records.push({ event, vector });
        } catch {
          /* skip corrupt line */
        }
      }
    } catch {
      /* new store */
    }
  }

  /** Appends a lossless event (deduplicating by id). Returns true if newly added. */
  async append(event: LosslessEvent): Promise<boolean> {
    await this.load();
    if (this.seenIds.has(event.id)) return false;
    this.seenIds.add(event.id);
    const vector = await this.embedder.embed(this.eventText(event));
    this.records.push({ event, vector });
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
    return true;
  }

  /** Updates an existing event in place (e.g. marking deleted=true or adding a reaction without losing history). */
  async update(id: string, patch: Partial<Pick<LosslessEvent, 'deleted' | 'reactions' | 'metadata'>>): Promise<boolean> {
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
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${this.records.map((r) => JSON.stringify(r.event)).join('\n')}\n`, 'utf8');
    return true;
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

  async search(
    query: string,
    k = 6,
    opts: { excludeIds?: string[]; source?: string } = {},
  ): Promise<Array<{ event: LosslessEvent; score: number }>> {
    await this.load();
    const exclude = new Set(opts.excludeIds ?? []);
    const candidates = this.records
      .filter((r) => !exclude.has(r.event.id) && (!opts.source || r.event.source === opts.source))
      .map((r) => ({ item: r.event, vector: r.vector }));
    if (!candidates.length) return [];
    const qVec = await this.embedder.embed(query);
    return topKBySimilarity(qVec, candidates, k).map((r) => ({ event: r.item, score: r.score }));
  }
}
