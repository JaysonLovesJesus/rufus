import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RufusConfig, RunRecord } from '../types';

export const newId = (prefix: string): string => `${prefix}_${randomBytes(4).toString('hex')}`;

/**
 * Plain, readable JSON files inside a workspace directory:
 *   runs/<runId>.json   lessons.json   config.json
 * Writes are atomic (temp file + rename).
 */
export class FileStore {
  constructor(readonly dir: string) {}

  get runsDir(): string {
    return path.join(this.dir, 'runs');
  }
  get lessonsFile(): string {
    return path.join(this.dir, 'lessons.json');
  }
  get configFile(): string {
    return path.join(this.dir, 'config.json');
  }
  get flowsDir(): string {
    return path.join(this.dir, 'flows');
  }

  /** Idempotent: creates the workspace layout if missing. */
  async init(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
    await fs.mkdir(this.flowsDir, { recursive: true });
    if (!(await exists(this.configFile))) {
      await this.writeJson(this.configFile, { version: 1 } satisfies RufusConfig);
    }
    if (!(await exists(this.lessonsFile))) {
      await this.writeJson(this.lessonsFile, { version: 1, lessons: [] });
    }
  }

  async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw err;
    }
  }

  async writeJson(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, file);
  }

  loadConfig(): Promise<RufusConfig> {
    return this.readJson<RufusConfig>(this.configFile, { version: 1 });
  }

  saveRun(run: RunRecord): Promise<void> {
    run.updatedAt = new Date().toISOString();
    return this.writeJson(path.join(this.runsDir, `${run.id}.json`), run);
  }

  async getRun(id: string): Promise<RunRecord> {
    const run = await this.readJson<RunRecord | null>(path.join(this.runsDir, `${id}.json`), null);
    if (!run) throw new Error(`No run with id "${id}".`);
    return run;
  }

  async listRuns(): Promise<RunRecord[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.runsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const runs = await Promise.all(
      files.filter((f) => f.endsWith('.json')).map((f) => this.readJson<RunRecord | null>(path.join(this.runsDir, f), null)),
    );
    return runs.filter((r): r is RunRecord => r !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Find the run waiting on a card. Accepts a full card id or a unique prefix. */
  async findRunByCard(cardRef: string): Promise<RunRecord> {
    const waiting = (await this.listRuns()).filter((r) => r.status === 'waiting_human' && r.pendingCardId);
    const hits = waiting.filter((r) => r.pendingCardId === cardRef);
    const matches = hits.length ? hits : waiting.filter((r) => r.pendingCardId!.startsWith(cardRef));
    if (matches.length === 0) throw new Error(`No pending card matching "${cardRef}".`);
    if (matches.length > 1) throw new Error(`"${cardRef}" matches more than one pending card; use more characters.`);
    return matches[0]!;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
