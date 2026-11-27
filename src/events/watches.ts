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
  /** Set on the quick return code schedules when a wake ends without a next move; drives backoff. */
  resumeAttempt?: number;
  /** A quick return serves every gap the wake left stranded, in one wake (gapId is the first of them). */
  gapIds?: string[];
  /** How many times in a row checking a thread failed. */
  checkFailures?: number;
  /** The thread state last seen (status|pending|blocked), so code wakes Rufus on a change, not on every check. */
  lastState?: string;
}

/** What a T3 thread needs, read from `t3 thread show --json` (`{"thread":{"status",...}}`). */
export type ThreadPhase = 'finished' | 'running' | 'needs_input' | 'blocked';

export interface ThreadState {
  phase: ThreadPhase;
  status: string;
  pendingRequests: number;
  blocked: boolean;
  updatedAt?: string;
  /** Compact signature of the state, for change detection. */
  signature: string;
}

const FINISHED_STATUSES = new Set(['completed', 'idle', 'failed', 'error', 'cancelled', 'canceled', 'interrupted', 'stopped']);
const RUNNING_STATUSES = new Set(['running', 'waiting', 'starting', 'queued', 'pending', 'working', 'active', 'busy', 'in_progress']);

/**
 * Reads a thread's state from `t3 thread show --json`. Throws on a shape or status this code doesn't know,
 * so the check counts as failed (and the watch fires after repeated failures) instead of silently never firing.
 */
export function readThreadState(stdout: string): ThreadState {
  const raw = JSON.parse(stdout) as Record<string, unknown>;
  const t = (raw.thread && typeof raw.thread === 'object' ? raw.thread : raw) as Record<string, unknown>;
  const latestRun = t.latestRun && typeof t.latestRun === 'object' ? (t.latestRun as Record<string, unknown>) : undefined;
  const status = String(t.status ?? latestRun?.status ?? t.state ?? '').toLowerCase();
  if (!FINISHED_STATUSES.has(status) && !RUNNING_STATUSES.has(status)) {
    throw new Error(`unrecognised T3 thread status ${JSON.stringify(status)}`);
  }
  const pendingRequests = Number(t.pendingRequestCount ?? 0) || 0;
  const blocked = t.blockedOnThreadWait === true;
  const phase: ThreadPhase = FINISHED_STATUSES.has(status) ? 'finished' : pendingRequests > 0 ? 'needs_input' : blocked ? 'blocked' : 'running';
  return {
    phase,
    status,
    pendingRequests,
    blocked,
    ...(typeof t.updatedAt === 'string' ? { updatedAt: t.updatedAt } : {}),
    signature: `${status}|${pendingRequests}|${blocked ? 1 : 0}`,
  };
}

/**
 * Should this check wake Rufus? A finished thread always does. A thread that needs input or is blocked does when that is
 * new: a change from the state last seen, or (on the first check) something that happened after the watch was set.
 */
export function threadNeedsRufus(w: Pick<WatchItem, 'lastState' | 'createdAt'>, s: ThreadState): boolean {
  if (s.phase === 'finished') return true;
  if (s.phase === 'running') return false;
  if (w.lastState !== undefined) return w.lastState !== s.signature;
  return !s.updatedAt || Date.parse(s.updatedAt) >= Date.parse(w.createdAt);
}

/** True when the watch is a next move for this gap (its own gap, or one of the gaps a quick return serves). */
export function servesGap(w: Pick<WatchItem, 'gapId' | 'gapIds'>, gapId: string): boolean {
  return w.gapId === gapId || !!w.gapIds?.includes(gapId);
}

/** After this many failed checks in a row (~10 minutes), a thread watch fires so Rufus can find another way. */
const MAX_THREAD_CHECK_FAILURES = 20;

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

  /** Counts a failed check on a watch; returns the new count. */
  async bumpFailures(id: string): Promise<number> {
    const list = await this.list();
    const hit = list.find((w) => w.id === id);
    if (!hit) return 0;
    hit.checkFailures = (hit.checkFailures ?? 0) + 1;
    await this.save(list);
    return hit.checkFailures;
  }

  async resetFailures(id: string): Promise<void> {
    const list = await this.list();
    const hit = list.find((w) => w.id === id);
    if (!hit || !hit.checkFailures) return;
    delete hit.checkFailures;
    await this.save(list);
  }

  /** Records a successful thread check: clears failures and remembers the state seen. */
  async noteThreadState(id: string, signature: string): Promise<void> {
    const list = await this.list();
    const hit = list.find((w) => w.id === id);
    if (!hit || (hit.lastState === signature && !hit.checkFailures)) return;
    delete hit.checkFailures;
    hit.lastState = signature;
    await this.save(list);
  }

  async active(): Promise<WatchItem[]> {
    return (await this.list()).filter((w) => !w.fired);
  }

  /** Removes watches the predicate rejects as dead, and rewrites the rest (e.g. re-attached to a gap). Returns the removed ones. */
  async reconcile(fix: (w: WatchItem) => WatchItem | null): Promise<WatchItem[]> {
    const list = await this.list();
    const kept: WatchItem[] = [];
    const retired: WatchItem[] = [];
    let changed = false;
    for (const w of list) {
      const next = fix(w);
      if (!next) {
        retired.push(w);
        changed = true;
      } else {
        if (next !== w) changed = true;
        kept.push(next);
      }
    }
    if (changed) await this.save(kept);
    return retired;
  }
}

/** Timers due within this long of one that is due fire with it, so they run as one wake. */
export const WATCH_MERGE_MS = 3 * 60_000;

export function watchConnector(workspaceDir: string, intervalMs = 30_000, opts: { t3Bin?: string } = {}): Omit<EventConnector, 'poll'> & { poll(): Promise<LosslessEvent[]> } {
  const store = new WatchStore(workspaceDir);
  const t3Bin = opts.t3Bin ?? path.join(os.homedir(), '.local', 'bin', 't3');
  return {
    id: 'watches',
    intervalMs,
    async poll(): Promise<LosslessEvent[]> {
      const active = await store.active();
      if (!active.length) return [];
      const now = Date.now();
      const events: LosslessEvent[] = [];
      const anyDue = active.some((w) => w.kind === 'timer' && w.fireAt && Date.parse(w.fireAt) <= now);
      const dueBy = anyDue ? now + WATCH_MERGE_MS : now;

      for (const w of active) {
        if (w.kind === 'timer' && w.fireAt && Date.parse(w.fireAt) <= dueBy) {
          await store.markFired(w.id);
          events.push(
            genericEvent({
              id: `watch_fired_${w.id}`,
              source: 'watch',
              kind: 'timer_due',
              text: `Watch fired (${w.id}${w.gapId ? ` / ${w.gapId}` : ''}): ${w.label}`,
              timestamp: new Date(now).toISOString(),
              metadata: { watchId: w.id, ...(w.gapId ? { gapId: w.gapId } : {}), ...(w.gapIds?.length ? { gapIds: w.gapIds } : {}), ...(w.resumeAttempt ? { resumeAttempt: w.resumeAttempt } : {}) },
            }),
          );
        } else if (w.kind === 't3_thread' && w.threadId) {
          try {
            const { stdout } = await execFileAsync(t3Bin, ['thread', 'show', w.threadId, '--json'], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
            const s = readThreadState(stdout);
            if (threadNeedsRufus(w, s)) {
              await store.markFired(w.id);
              const what =
                s.phase === 'finished'
                  ? `finished (status: ${s.status})`
                  : s.phase === 'needs_input'
                    ? `needs input (${s.pendingRequests} pending request${s.pendingRequests === 1 ? '' : 's'}); answer it with t3.thread send if you can`
                    : 'is blocked waiting on another thread';
              events.push(
                genericEvent({
                  id: s.phase === 'finished' ? `watch_fired_${w.id}` : `watch_fired_${w.id}_${s.phase}`,
                  source: 'watch',
                  kind: s.phase === 'finished' ? 't3_thread_finished' : `t3_thread_${s.phase}`,
                  text: `T3 thread ${w.threadId} ${what}${w.gapId ? ` for ${w.gapId}` : ''}: ${w.label}`,
                  timestamp: new Date(now).toISOString(),
                  metadata: { watchId: w.id, threadId: w.threadId, status: s.status, phase: s.phase, ...(w.gapId ? { gapId: w.gapId } : {}) },
                }),
              );
            } else {
              await store.noteThreadState(w.id, s.signature);
            }
          } catch {
            // A thread that can't be checked is not a next move forever: after repeated failures, wake Rufus to find another way.
            if ((await store.bumpFailures(w.id)) >= MAX_THREAD_CHECK_FAILURES) {
              await store.markFired(w.id);
              events.push(
                genericEvent({
                  id: `watch_fired_${w.id}`,
                  source: 'watch',
                  kind: 't3_thread_unreachable',
                  text: `Could not check T3 thread ${w.threadId}${w.gapId ? ` for ${w.gapId}` : ''} after ${MAX_THREAD_CHECK_FAILURES} tries: ${w.label}`,
                  timestamp: new Date(now).toISOString(),
                  metadata: { watchId: w.id, threadId: w.threadId, ...(w.gapId ? { gapId: w.gapId } : {}) },
                }),
              );
            }
          }
        }
      }
      return events;
    },
  };
}
