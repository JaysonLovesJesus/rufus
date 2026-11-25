import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeItem, type CorpusItem } from './types';

export interface AddReport {
  added: number;
  /** Same id, different content: replaced (a note you edited, a page you visited again). */
  updated: number;
  /** Same id, same content: nothing to do. */
  unchanged: number;
  /** Items that were not valid `CorpusItem`s, with why. */
  rejected: Array<{ index: number; reason: string }>;
  /** Items in the corpus afterwards. */
  total: number;
}

/**
 * The local corpus: one JSON object per line in `<workspace>/corpus/items.jsonl`. Deduplicated by `id` (collecting twice
 * changes nothing), and written atomically (temp file + rename), so a crash never leaves a half-written file.
 */
export class CorpusStore {
  constructor(readonly file: string) {}

  /** Every valid item, oldest first. A missing file is an empty corpus; a corrupt line is skipped. */
  async load(): Promise<CorpusItem[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const items: CorpusItem[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = normalizeItem(JSON.parse(line));
        if ('item' in r) items.push(r.item);
      } catch {
        // a corrupt line is skipped, never fatal
      }
    }
    return items;
  }

  /** Merge `items` into the corpus (by id) and save. With `dryRun`, report what would change and write nothing. */
  async add(items: unknown[], opts: { dryRun?: boolean } = {}): Promise<AddReport> {
    const byId = new Map((await this.load()).map((i) => [i.id, i] as const));
    const report: AddReport = { added: 0, updated: 0, unchanged: 0, rejected: [], total: 0 };
    items.forEach((raw, index) => {
      const r = normalizeItem(raw);
      if ('error' in r) return void report.rejected.push({ index, reason: r.error });
      const before = byId.get(r.item.id);
      if (!before) report.added++;
      else if (JSON.stringify(before) === JSON.stringify(r.item)) report.unchanged++;
      else report.updated++;
      byId.set(r.item.id, r.item);
    });
    report.total = byId.size;
    if (!opts.dryRun && (report.added || report.updated)) {
      const sorted = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
      await this.write(sorted);
    }
    return report;
  }

  private async write(items: CorpusItem[]): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), 'utf8');
    await fs.rename(tmp, this.file);
  }
}
