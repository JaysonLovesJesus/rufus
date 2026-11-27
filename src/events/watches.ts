import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LosslessEvent } from '../types';
import type { EventConnector } from './connectors';
import { genericEvent } from './ingest';

const execFileAsync = promisify(execFile);

export interface WatchItem {
  id: string;
  kind: 'timer' | 't3_thread';
  label: string;
  gapId?: string;
  fireAt?: string;
  threadId?: string;
  createdAt: string;
  fired?: boolean;
}

/**
 * Simple human productivity tool: Alarms & Async Watches (`watches.json`).
 * Deterministic code checks timers & running T3 Code threads at zero LLM cost and emits an event when due/done.
 */
export class WatchStore {
  readonly filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, 'watches.json');
  }

  async list(): Promise<WatchItem[]> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as WatchItem[];
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private async save(items: WatchItem[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  }

  async add(item: Omit<WatchItem, 'id' | 'createdAt' | 'fired'>, now = new Date()): Promise<WatchItem> {
    const list = await this.list();
    const created: WatchItem = {
      ...item,
      id: `watch_${randomUUID().slice(0, 6)}`,
      createdAt: now.toISOString(),
      fired: false,
    };
    list.push(created);
    await this.save(list);
    return created;
  }

  async markFired(id: string): Promise<void> {
    const list = await this.list();
    const hit = list.find((w) => w.id === id);
    if (!hit) return;
    hit.fired = true;
    await this.save(list.filter((w) => !w.fired));
  }

  async active(): Promise<WatchItem[]> {
    return (await this.list()).filter((w) => !w.fired);
  }
}

export function watchConnector(workspaceDir: string, intervalMs = 30_000): EventConnector {
  const store = new WatchStore(workspaceDir);
  const t3Bin = path.join(os.homedir(), '.local', 'bin', 't3');
  return {
    id: 'watches',
    intervalMs,
    async poll(): Promise<LosslessEvent[]> {
      const active = await store.active();
      if (!active.length) return [];
      const now = Date.now();
      const events: LosslessEvent[] = [];

      for (const w of active) {
        if (w.kind === 'timer' && w.fireAt && Date.parse(w.fireAt) <= now) {
          await store.markFired(w.id);
          events.push(
            genericEvent({
              id: `watch_fired_${w.id}`,
              source: 'watch',
              kind: 'timer_due',
              text: `Watch fired (${w.id}${w.gapId ? ` / ${w.gapId}` : ''}): ${w.label}`,
              timestamp: new Date(now).toISOString(),
              metadata: { watchId: w.id, ...(w.gapId ? { gapId: w.gapId } : {}) },
            }),
          );
        } else if (w.kind === 't3_thread' && w.threadId) {
          try {
            const { stdout } = await execFileAsync(t3Bin, ['thread', 'show', w.threadId, '--json'], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
            const info = JSON.parse(stdout) as { status?: string; state?: string; latestRun?: { status?: string } };
            const st = String(info.latestRun?.status || info.status || info.state || '').toLowerCase();
            if (['completed', 'idle', 'failed', 'error', 'cancelled', 'interrupted'].includes(st)) {
              await store.markFired(w.id);
              events.push(
                genericEvent({
                  id: `watch_fired_${w.id}`,
                  source: 'watch',
                  kind: 't3_thread_finished',
                  text: `T3 thread ${w.threadId} finished (status: ${st})${w.gapId ? ` for ${w.gapId}` : ''}: ${w.label}`,
                  timestamp: new Date(now).toISOString(),
                  metadata: { watchId: w.id, threadId: w.threadId, status: st, ...(w.gapId ? { gapId: w.gapId } : {}) },
                }),
              );
            }
          } catch {
            /* check again next tick */
          }
        }
      }
      return events;
    },
  };
}
