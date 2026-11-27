import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolManifest } from '../types';

export type TrustLevel = 'rehearse' | 'draft' | 'act_and_report' | 'act_quietly';

export interface PendingApproval {
  id: string;
  toolId: string;
  input: Record<string, unknown>;
  gapId?: string;
  createdAt: string;
}

export interface TrustTable {
  levels: Record<string, TrustLevel>;
  neverAllow: string[];
}

/**
 * 4-Level Trust Ladder (`trust.json`) + channel-agnostic verbal approval queue (`approvals.json`).
 * Levels (lowest -> highest):
 *   1. rehearse       — record what would have been done; execute NOTHING.
 *   2. draft          — queue for owner verbal/direct confirmation before executing.
 *   3. act_and_report — execute now, and report what happened to the owner.
 *   4. act_quietly    — execute silently; owner spot-checks.
 *
 * Rules:
 * - Only direct owner approval can raise a tool's trust level.
 * - A miss/denial drops trust immediately.
 * - Backwards-compatible with legacy `permissions.json` (`alwaysAllow` -> `act_and_report`).
 */
export class ApprovalStore {
  readonly approvalsPath: string;
  readonly trustPath: string;
  readonly legacyPermissionsPath: string;

  constructor(workspaceDir: string) {
    this.approvalsPath = path.join(workspaceDir, 'approvals.json');
    this.trustPath = path.join(workspaceDir, 'trust.json');
    this.legacyPermissionsPath = path.join(workspaceDir, 'permissions.json');
  }

  async readTrust(): Promise<TrustTable> {
    const table: TrustTable = { levels: {}, neverAllow: [] };
    try {
      const legacy = JSON.parse(await fs.readFile(this.legacyPermissionsPath, 'utf8')) as {
        alwaysAllow?: string[];
        neverAllow?: string[];
      };
      for (const id of legacy.alwaysAllow ?? []) table.levels[String(id)] = 'act_and_report';
      for (const id of legacy.neverAllow ?? []) table.neverAllow.push(String(id));
    } catch {
      /* no legacy permissions.json */
    }
    try {
      const raw = JSON.parse(await fs.readFile(this.trustPath, 'utf8')) as Partial<TrustTable>;
      if (raw.levels && typeof raw.levels === 'object') {
        for (const [k, v] of Object.entries(raw.levels)) {
          if (v === 'rehearse' || v === 'draft' || v === 'act_and_report' || v === 'act_quietly') {
            table.levels[k] = v;
          }
        }
      }
      if (Array.isArray(raw.neverAllow)) {
        table.neverAllow = [...new Set([...table.neverAllow, ...raw.neverAllow.map(String)])];
      }
    } catch {
      /* no trust.json yet */
    }
    return table;
  }

  private async writeTrust(table: TrustTable): Promise<void> {
    await fs.mkdir(path.dirname(this.trustPath), { recursive: true });
    await fs.writeFile(this.trustPath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
  }

  /** Resolves the effective 4-level Trust Ladder tier for any tool manifest. */
  async levelFor(manifest?: ToolManifest): Promise<TrustLevel | 'never'> {
    if (!manifest) return 'rehearse';
    const table = await this.readTrust();
    if (table.neverAllow.includes(manifest.id)) return 'never';
    const explicit = table.levels[manifest.id];
    if (explicit) return explicit;
    if (manifest.effect === 'read' || manifest.effect === 'meta') return 'act_quietly';
    return manifest.requiresApproval ? 'draft' : 'act_and_report';
  }

  async isAutoAllowed(toolId: string): Promise<boolean> {
    const table = await this.readTrust();
    if (table.neverAllow.includes(toolId)) return false;
    const lvl = table.levels[toolId];
    return lvl === 'act_and_report' || lvl === 'act_quietly';
  }

  async isNeverAllowed(toolId: string): Promise<boolean> {
    const table = await this.readTrust();
    return table.neverAllow.includes(toolId);
  }

  /** Promotes a tool's trust level (call ONLY on verified owner_direct confirmation). */
  async setLevel(toolId: string, level: TrustLevel): Promise<void> {
    const table = await this.readTrust();
    table.neverAllow = table.neverAllow.filter((id) => id !== toolId);
    table.levels[toolId] = level;
    await this.writeTrust(table);
  }

  async allowAlways(toolId: string): Promise<void> {
    await this.setLevel(toolId, 'act_and_report');
  }

  /** Drops a tool back down one notch to `draft` after a miss or owner denial. */
  async demote(toolId: string): Promise<void> {
    const table = await this.readTrust();
    const cur = table.levels[toolId];
    if (cur === 'act_quietly') table.levels[toolId] = 'act_and_report';
    else if (cur === 'act_and_report') table.levels[toolId] = 'draft';
    else return;
    await this.writeTrust(table);
  }

  async listPending(): Promise<PendingApproval[]> {
    try {
      const raw = JSON.parse(await fs.readFile(this.approvalsPath, 'utf8')) as PendingApproval[];
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  private async savePending(items: PendingApproval[]): Promise<void> {
    await fs.mkdir(path.dirname(this.approvalsPath), { recursive: true });
    await fs.writeFile(this.approvalsPath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  }

  async enqueue(toolId: string, input: Record<string, unknown>, now = new Date(), gapId?: string): Promise<PendingApproval> {
    const list = await this.listPending();
    const item: PendingApproval = {
      id: `appr_${randomUUID().slice(0, 6)}`,
      toolId,
      input,
      ...(gapId ? { gapId } : {}),
      createdAt: now.toISOString(),
    };
    const next = [...list.slice(-19), item];
    await this.savePending(next);
    return item;
  }

  async take(id?: string): Promise<PendingApproval | undefined> {
    const list = await this.listPending();
    if (!list.length) return undefined;
    const idx = id ? list.findIndex((a) => a.id === id) : list.length - 1;
    if (idx < 0) return undefined;
    const [picked] = list.splice(idx, 1);
    await this.savePending(list);
    return picked;
  }
}
