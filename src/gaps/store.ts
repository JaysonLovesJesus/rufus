import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LosslessEvent } from '../types';
import type { EventConnector } from '../events/connectors';
import { genericEvent } from '../events/ingest';

export type GapSource = 'owner' | 'observed';
export type GapStatus = 'proposed' | 'open' | 'waiting' | 'closed';

export interface Gap {
  id: string;
  parentId?: string;
  title: string;
  source: GapSource;
  status: GapStatus;
  target: string;
  reality: string;
  evidenceIds: string[];
  waitingOn?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The Gap Board (`gaps.json`):
 * A tangible, code-enforced tree of real Gaps (parent -> sub-gaps).
 * - Observed gaps start as `proposed` and require owner approval before becoming `open`.
 * - Gaps can ONLY be marked `closed` by a passing blind `brain.verify` check.
 */
export class GapStore {
  readonly filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, 'gaps.json');
  }

  async list(): Promise<Gap[]> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Gap[];
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private async save(gaps: Gap[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(gaps, null, 2)}\n`, 'utf8');
  }

  async get(id: string): Promise<Gap | undefined> {
    return (await this.list()).find((g) => g.id === id);
  }

  async create(opts: {
    title: string;
    target: string;
    reality: string;
    source: GapSource;
    parentId?: string;
    evidenceIds?: string[];
    now?: Date;
  }): Promise<Gap> {
    const gaps = await this.list();
    const ts = (opts.now ?? new Date()).toISOString();
    // Owner-instructed gaps or sub-gaps under an already-open parent start `open`; top-level observed gaps start `proposed`.
    const parentOpen = opts.parentId ? gaps.some((g) => g.id === opts.parentId && (g.status === 'open' || g.status === 'waiting')) : false;
    const status: GapStatus = opts.source === 'owner' || parentOpen ? 'open' : 'proposed';
    const gap: Gap = {
      id: `gap_${randomUUID().slice(0, 6)}`,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      title: opts.title.trim(),
      source: opts.source,
      status,
      target: opts.target.trim(),
      reality: opts.reality.trim(),
      evidenceIds: [...(opts.evidenceIds ?? [])],
      createdAt: ts,
      updatedAt: ts,
    };
    gaps.push(gap);
    await this.save(gaps);
    return gap;
  }

  async approve(id: string, now = new Date()): Promise<Gap | undefined> {
    const gaps = await this.list();
    const g = gaps.find((x) => x.id === id);
    if (!g) return undefined;
    g.status = 'open';
    g.updatedAt = now.toISOString();
    await this.save(gaps);
    return g;
  }

  async update(
    id: string,
    patch: { reality?: string; target?: string; status?: Exclude<GapStatus, 'closed'>; waitingOn?: string | null; addEvidence?: string[] },
    now = new Date(),
  ): Promise<Gap | undefined> {
    const gaps = await this.list();
    const g = gaps.find((x) => x.id === id);
    if (!g) return undefined;
    if (patch.reality !== undefined) g.reality = patch.reality.trim();
    if (patch.target !== undefined) g.target = patch.target.trim();
    if (patch.status !== undefined) g.status = patch.status;
    if (patch.waitingOn === null) delete g.waitingOn;
    else if (patch.waitingOn !== undefined) g.waitingOn = patch.waitingOn.trim();
    if (patch.addEvidence?.length) {
      g.evidenceIds = [...new Set([...g.evidenceIds, ...patch.addEvidence])];
    }
    g.updatedAt = now.toISOString();
    await this.save(gaps);
    return g;
  }

  /** Code-enforced closure: ONLY called when blind `brain.verify` passes. */
  async closeVerified(id: string, verifiedReality: string, evidenceId?: string, now = new Date()): Promise<Gap | undefined> {
    const gaps = await this.list();
    const g = gaps.find((x) => x.id === id);
    if (!g) return undefined;
    g.status = 'closed';
    g.reality = verifiedReality.trim();
    delete g.waitingOn;
    if (evidenceId) g.evidenceIds = [...new Set([...g.evidenceIds, evidenceId])];
    g.updatedAt = now.toISOString();
    await this.save(gaps);
    return g;
  }

  /** Renders a crisp, compact Gap Board for The Desk. */
  async formatForDesk(): Promise<string> {
    const gaps = await this.list();
    const active = gaps.filter((g) => g.status !== 'closed');
    if (!active.length) {
      return '(empty — no open Gaps yet. Not having qualified Gaps IS the top Gap: investigate what is connected and align with the user on real Goals/Gaps.)';
    }
    const byParent = new Map<string | undefined, Gap[]>();
    for (const g of active) {
      const list = byParent.get(g.parentId) ?? [];
      list.push(g);
      byParent.set(g.parentId, list);
    }
    const lines: string[] = [];
    const render = (parentId: string | undefined, depth: number) => {
      for (const g of byParent.get(parentId) ?? []) {
        const pad = '  '.repeat(depth);
        const wait = g.waitingOn ? ` | waitingOn: ${g.waitingOn}` : '';
        lines.push(`${pad}- [${g.id} | ${g.status} | ${g.source}] ${g.title}${wait}`);
        lines.push(`${pad}  Target:  ${g.target}`);
        lines.push(`${pad}  Reality: ${g.reality}`);
        render(g.id, depth + 1);
      }
    };
    render(undefined, 0);
    // Also render any orphan sub-gaps whose parent was closed
    const shown = new Set(lines.join('\n').match(/gap_[a-z0-9]+/g) ?? []);
    for (const g of active) {
      if (!shown.has(g.id)) {
        lines.push(`- [${g.id} | ${g.status} | ${g.source}] ${g.title}${g.waitingOn ? ` | waitingOn: ${g.waitingOn}` : ''}`);
        lines.push(`  Target:  ${g.target}`);
        lines.push(`  Reality: ${g.reality}`);
      }
    }
    return lines.join('\n');
  }
}

/**
 * Gap Board Trigger Connector:
 * - Empty board (0 active, 0 proposed, 0 waiting): emits `gap/empty_board` so "not having a gap IS the gap" wakes Rufus.
 * - Unblocked `open` gap(s) with no `waitingOn`: emits `gap/open_work` so Rufus stays in motion on real work.
 * - All gaps `waiting` or `proposed`: stays completely silent (zero spam).
 * Uses a fingerprint + cooldown so unchanged state never spams back-to-back wakes.
 */
export function gapConnector(workspaceDir: string, opts: { intervalMs?: number; cooldownMs?: number } = {}): EventConnector {
  const store = new GapStore(workspaceDir);
  const cooldownMs = opts.cooldownMs ?? 15 * 60_000;
  let lastFingerprint = '';
  let lastEmittedAt = 0;

  return {
    id: 'gaps',
    intervalMs: opts.intervalMs ?? 60_000,
    async poll(): Promise<LosslessEvent[]> {
      const gaps = await store.list();
      const nonClosed = gaps.filter((g) => g.status !== 'closed');
      const now = Date.now();

      // Case 1: Empty Gap Board -> not having a gap IS the gap!
      if (nonClosed.length === 0) {
        const fp = 'empty_board';
        if (fp === lastFingerprint && now - lastEmittedAt < cooldownMs) return [];
        lastFingerprint = fp;
        lastEmittedAt = now;
        return [
          genericEvent({
            id: `gap_empty_${Math.floor(now / Math.max(1000, cooldownMs))}`,
            source: 'gap',
            kind: 'empty_board',
            text: 'Gap Board is empty. Not having qualified Gaps is the top Gap: call brain.investigate to see current reality across connected projects/feeds, then propose concrete Gaps (or ask the owner to align on top Goals).',
            timestamp: new Date(now).toISOString(),
          }),
        ];
      }

      // Case 2: Unblocked `open` Gaps -> wake to advance real work!
      const unblocked = nonClosed.filter((g) => g.status === 'open' && !g.waitingOn);
      if (unblocked.length > 0) {
        const fp = `open:${unblocked.map((g) => `${g.id}@${g.updatedAt}`).join(',')}`;
        if (fp === lastFingerprint && now - lastEmittedAt < cooldownMs) return [];
        lastFingerprint = fp;
        lastEmittedAt = now;
        const summary = unblocked.map((g) => `${g.id} ("${g.title}")`).join(', ');
        return [
          genericEvent({
            id: `gap_open_${Math.floor(now / Math.max(1000, cooldownMs))}_${unblocked[0]!.id}`,
            source: 'gap',
            kind: 'open_work',
            text: `Unblocked open Gap(s) on the Gap Board ready for progress: ${summary}. Pick the highest-leverage next move.`,
            timestamp: new Date(now).toISOString(),
          }),
        ];
      }

      // Case 3: Everything is `proposed` (awaiting owner) or `waiting` (awaiting job/reply) -> stay silent.
      return [];
    },
  };
}
