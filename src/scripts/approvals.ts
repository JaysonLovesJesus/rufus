import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolManifest, TrustLevel } from '../types';
import { ReportQueue, SpendLedger, TrackRecord } from './ledger';

export type { TrustLevel } from '../types';

const RUNGS: readonly TrustLevel[] = ['rehearse', 'draft', 'act_and_report', 'act_quietly'];
const rank = (l: TrustLevel): number => RUNGS.indexOf(l);

/** The lower of two rungs. */
export function stricterOf(a: TrustLevel, b: TrustLevel): TrustLevel {
  return rank(a) <= rank(b) ? a : b;
}

/** What a tool's effect alone earns: reads and meta run quietly, writes run and report, writes that need approval ask. */
export function effectDefault(m: Pick<ToolManifest, 'effect' | 'requiresApproval'>): TrustLevel {
  if (m.effect === 'read' || m.effect === 'meta') return 'act_quietly';
  return m.requiresApproval ? 'draft' : 'act_and_report';
}

/** The rung a tool starts at when trust.json says nothing: its declared default, else its effect's. */
export function defaultLevel(m: Pick<ToolManifest, 'effect' | 'requiresApproval' | 'defaultTrust'>): TrustLevel {
  return m.defaultTrust ?? effectDefault(m);
}

/** A rung held under the tool's ceiling, if it has one. */
export function capLevel(level: TrustLevel, m: Pick<ToolManifest, 'maxTrust'>): TrustLevel {
  return m.maxTrust ? stricterOf(level, m.maxTrust) : level;
}

/** Where an irreversible call stops: it may run, but the owner always hears about it. */
export const IRREVERSIBLE_CEILING: TrustLevel = 'act_and_report';

/**
 * Can this call be undone? A manifest says so for itself (reads and meta change nothing outside Rufus; a write that
 * doesn't say is taken to be irreversible), and input values it names as irreversible (a delete) override that.
 */
export function isReversible(m: Pick<ToolManifest, 'effect' | 'reversible' | 'irreversibleWhen'>, input: Record<string, unknown> = {}): boolean {
  for (const [field, values] of Object.entries(m.irreversibleWhen ?? {})) {
    const v = input[field];
    if ((Array.isArray(v) ? v : [v]).some((x) => values.includes(x as string | number | boolean))) return false;
  }
  return m.reversible ?? m.effect !== 'write';
}

/** The rung a call can reach at most: the tool's own ceiling, and act_and_report for anything that can't be undone. */
export function ceilingFor(m: ToolManifest, input: Record<string, unknown> = {}): TrustLevel {
  const own = m.maxTrust ?? 'act_quietly';
  return isReversible(m, input) ? own : stricterOf(own, IRREVERSIBLE_CEILING);
}

/** The usual input fields that say who or what a call touches, used to scope trust when a manifest names none. */
export const DEFAULT_SCOPE_FIELDS = ['action', 'to', 'recipient', 'recipients', 'chatId', 'email', 'phone', 'account', 'calendar', 'project'];
/** The scope value for the owner himself, whatever id a channel gives him. */
export const OWNER_SCOPE = 'owner';
const OWNER_WORDS = new Set(['owner', 'me', 'self']);

/** The input fields that scope a tool's trust. */
export function scopeFields(m: Pick<ToolManifest, 'scopeBy' | 'inputSchema'>): string[] {
  if (m.scopeBy) return m.scopeBy;
  const props = m.inputSchema.properties ?? {};
  return DEFAULT_SCOPE_FIELDS.filter((f) => f in props);
}

/**
 * The trust key for one call: the tool id, plus who and what it touches (`beeper.send@chatId=owner`). Each scope has
 * its own rung; a scope trust.json says nothing about falls back to the tool's rung. Any id of the owner reads "owner".
 */
export function scopeKey(m: Pick<ToolManifest, 'id' | 'scopeBy' | 'inputSchema'>, input: Record<string, unknown> = {}, ownerIds: ReadonlySet<string> = new Set()): string {
  const parts: string[] = [];
  for (const f of scopeFields(m)) {
    const raw = input[f];
    if (raw === undefined || raw === null || raw === '') continue;
    const one = (x: unknown) => {
      const s = String(x).trim();
      return ownerIds.has(s) || ownerIds.has(s.toLowerCase()) || OWNER_WORDS.has(s.toLowerCase()) ? OWNER_SCOPE : s.slice(0, 80);
    };
    const value = Array.isArray(raw) ? [...new Set(raw.map(one))].sort().join('+') : one(raw);
    parts.push(`${f}=${value}`);
  }
  return parts.length ? `${m.id}@${parts.join(',')}` : m.id;
}

/** The tool id a trust key belongs to. */
export function toolOfKey(key: string): string {
  const at = key.indexOf('@');
  return at < 0 ? key : key.slice(0, at);
}

/** One rung up, or undefined at the top. */
export function rungAbove(level: TrustLevel): TrustLevel | undefined {
  const i = rank(level);
  return i >= 0 && i < RUNGS.length - 1 ? RUNGS[i + 1] : undefined;
}

/** One rung down after a miss or a denial: never below draft (a denial means "ask me", not "stop trying"). */
export function rungBelow(level: TrustLevel): TrustLevel | undefined {
  if (level === 'act_quietly') return 'act_and_report';
  if (level === 'act_and_report') return 'draft';
  return undefined;
}

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

  /** What each tool spends (the runaway guard), each scope's track record, and reports still owed to the owner. */
  readonly spend: SpendLedger;
  readonly record: TrackRecord;
  readonly reports: ReportQueue;
  /** The owner's own ids on his channels (`{ "ids": [...] }`), so a call to him is scoped "owner" whatever id it uses. */
  readonly ownerPath: string;

  constructor(workspaceDir: string) {
    this.approvalsPath = path.join(workspaceDir, 'approvals.json');
    this.trustPath = path.join(workspaceDir, 'trust.json');
    this.legacyPermissionsPath = path.join(workspaceDir, 'permissions.json');
    this.ownerPath = path.join(workspaceDir, 'owner.json');
    this.spend = new SpendLedger(workspaceDir);
    this.record = new TrackRecord(workspaceDir);
    this.reports = new ReportQueue(workspaceDir);
  }

  async ownerIds(): Promise<Set<string>> {
    try {
      const raw = JSON.parse(await fs.readFile(this.ownerPath, 'utf8')) as { ids?: unknown[] };
      return new Set((raw.ids ?? []).map((x) => String(x).trim()).filter(Boolean).flatMap((x) => [x, x.toLowerCase()]));
    } catch {
      return new Set();
    }
  }

  /** The trust key (tool@scope) one call is judged under. */
  async keyFor(manifest: ToolManifest, input?: Record<string, unknown>): Promise<string> {
    return input ? scopeKey(manifest, input, await this.ownerIds()) : manifest.id;
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

  /**
   * Resolves the effective rung for any tool or action: blocked if its scope or tool is on neverAllow, else trust.json's
   * level for that scope, else for the tool, else the manifest's default rung; never above the call's ceiling (the
   * tool's own, and act_and_report for anything that can't be undone).
   */
  async levelFor(manifest?: ToolManifest, input?: Record<string, unknown>): Promise<TrustLevel | 'never'> {
    if (!manifest) return 'rehearse';
    const table = await this.readTrust();
    const key = await this.keyFor(manifest, input);
    if (table.neverAllow.includes(manifest.id) || table.neverAllow.includes(key)) return 'never';
    const level = table.levels[key] ?? table.levels[manifest.id] ?? defaultLevel(manifest);
    return stricterOf(capLevel(level, manifest), ceilingFor(manifest, input));
  }

  /**
   * After a miss or the owner's no: the call's scope drops one rung below where it ran (never below draft). Only that
   * scope moves, so a bad send to one person doesn't cost the sends to the owner. Returns the new rung, if it moved.
   */
  async demoteCall(manifest: ToolManifest, input: Record<string, unknown>): Promise<TrustLevel | undefined> {
    const now = await this.levelFor(manifest, input);
    if (now === 'never') return undefined;
    const lower = rungBelow(now);
    if (!lower) return undefined;
    await this.setRung(await this.keyFor(manifest, input), lower);
    return lower;
  }

  /** The rung a promotion would give this call's scope, if it can go higher at all. */
  async promotionFor(manifest: ToolManifest, input: Record<string, unknown>): Promise<{ key: string; from: TrustLevel; to: TrustLevel } | undefined> {
    const from = await this.levelFor(manifest, input);
    if (from === 'never') return undefined;
    const up = rungAbove(from);
    if (!up || stricterOf(up, ceilingFor(manifest, input)) !== up) return undefined;
    return { key: await this.keyFor(manifest, input), from, to: up };
  }

  /** Writes one rung for one key, leaving neverAllow alone (a demotion never unblocks anything). */
  private async setRung(key: string, level: TrustLevel): Promise<void> {
    const table = await this.readTrust();
    table.levels[key] = level;
    await this.writeTrust(table);
  }

  /** Every explicit rung trust.json holds for a tool and its scopes (a version's rungs, for rollback). */
  async rungsOf(toolId: string): Promise<Record<string, TrustLevel>> {
    const table = await this.readTrust();
    return Object.fromEntries(Object.entries(table.levels).filter(([k]) => toolOfKey(k) === toolId));
  }

  /** Puts back a tool's rungs as a kept version had them (a blocked tool stays blocked; scopes it didn't have go). */
  async restoreRungs(toolId: string, rungs: Record<string, TrustLevel>): Promise<void> {
    const table = await this.readTrust();
    for (const k of Object.keys(table.levels)) if (toolOfKey(k) === toolId) delete table.levels[k];
    for (const [k, v] of Object.entries(rungs)) if (toolOfKey(k) === toolId) table.levels[k] = v;
    await this.writeTrust(table);
  }

  /**
   * Puts a tool that was just built or changed on its starting rung, whatever it had before (a blocked tool stays blocked).
   * Code calls this on install, never to raise trust for a tool the owner already knows.
   */
  async setStartLevel(toolId: string, level: TrustLevel): Promise<void> {
    const table = await this.readTrust();
    if (table.neverAllow.includes(toolId)) return;
    // New code has earned nothing yet in any scope.
    for (const k of Object.keys(table.levels)) if (toolOfKey(k) === toolId) delete table.levels[k];
    table.levels[toolId] = level;
    await this.writeTrust(table);
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
