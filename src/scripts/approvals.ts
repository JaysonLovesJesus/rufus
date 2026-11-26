import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface PendingApproval {
  id: string;
  toolId: string;
  input: Record<string, unknown>;
  createdAt: string;
}

export interface PermissionPolicy {
  alwaysAllow: string[];
  neverAllow: string[];
}

/**
 * Channel-agnostic approval queue (`approvals.json`) + graduated trust policy (`permissions.json`).
 * Works identically over voice, Beeper, Telegram, or CLI — zero UI buttons required.
 */
export class ApprovalStore {
  readonly approvalsPath: string;
  readonly permissionsPath: string;

  constructor(workspaceDir: string) {
    this.approvalsPath = path.join(workspaceDir, 'approvals.json');
    this.permissionsPath = path.join(workspaceDir, 'permissions.json');
  }

  async readPolicy(): Promise<PermissionPolicy> {
    try {
      const raw = JSON.parse(await fs.readFile(this.permissionsPath, 'utf8')) as Partial<PermissionPolicy>;
      return {
        alwaysAllow: Array.isArray(raw.alwaysAllow) ? raw.alwaysAllow.map(String) : [],
        neverAllow: Array.isArray(raw.neverAllow) ? raw.neverAllow.map(String) : [],
      };
    } catch {
      return { alwaysAllow: [], neverAllow: [] };
    }
  }

  async writePolicy(policy: PermissionPolicy): Promise<void> {
    await fs.mkdir(path.dirname(this.permissionsPath), { recursive: true });
    await fs.writeFile(this.permissionsPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  }

  async isAutoAllowed(toolId: string): Promise<boolean> {
    const p = await this.readPolicy();
    return p.alwaysAllow.includes(toolId) && !p.neverAllow.includes(toolId);
  }

  async isNeverAllowed(toolId: string): Promise<boolean> {
    const p = await this.readPolicy();
    return p.neverAllow.includes(toolId);
  }

  async allowAlways(toolId: string): Promise<void> {
    const p = await this.readPolicy();
    p.neverAllow = p.neverAllow.filter((id) => id !== toolId);
    if (!p.alwaysAllow.includes(toolId)) p.alwaysAllow.push(toolId);
    await this.writePolicy(p);
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

  async enqueue(toolId: string, input: Record<string, unknown>, now = new Date()): Promise<PendingApproval> {
    const list = await this.listPending();
    const item: PendingApproval = {
      id: `appr_${randomUUID().slice(0, 6)}`,
      toolId,
      input,
      createdAt: now.toISOString(),
    };
    // Keep most recent 20 pending approvals
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
