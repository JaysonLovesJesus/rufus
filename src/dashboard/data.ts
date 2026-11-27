import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readSensesFile, type SenseHealthEntry } from '../events/health';
import type { WatchItem } from '../events/watches';
import { RECENTLY_CLOSED_MS, ROOT_GAP_ID, isDone, type Gap } from '../gaps/store';
import { CreditTracker } from '../providers/credits';
import { findLocalLlmModel } from '../providers/local';
import { isRealChange } from '../rpg/outcome';
import { ApprovalStore, type PendingApproval } from '../scripts/approvals';
import type { LosslessEvent, Receipt, ToolManifest } from '../types';

/**
 * Read-only views of a Rufus workspace for the dashboard.
 * Nothing in this file writes to the workspace. The growing logs (`events.jsonl`, `wakes.jsonl`, `decisions.jsonl`)
 * are read once from their tail and then only the bytes appended since, so a request never re-parses a whole file.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTLINE_PATH = path.resolve(HERE, '..', '..', 'docs', 'OUTLINE.md');
/** Strips local home directory usernames from user-facing dashboard strings. */
function redactPaths(s: string): string {
  return s.replace(/\/(?:Users|home)\/[^/\s]+\//g, '~/');
}

/** The daemon's default turn cap per wake (RufusCore.maxTurnsPerWake). */
export const TURN_CAP = 25;
const DAY_MS = 24 * 60 * 60_000;

/** Incrementally-read tail of an append-only JSONL file (mtime/size cache; re-reads only appended bytes). */
export class JsonlTail<T> {
  private records: T[] = [];
  private offset = 0;
  private size = -1;
  private mtimeMs = -1;
  private ino = -1;
  private partial: Buffer = Buffer.alloc(0);
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly opts: { maxRecords: number; initialBytes: number },
  ) {}

  /** Records in file order (oldest first), at most `maxRecords`. */
  read(): Promise<T[]> {
    const run = this.queue.then(() => this.refresh());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private reset(): void {
    this.records = [];
    this.offset = 0;
    this.size = -1;
    this.mtimeMs = -1;
    this.ino = -1;
    this.partial = Buffer.alloc(0);
  }

  private parseLine(line: string): T | undefined {
    const t = line.trim();
    if (!t) return undefined;
    try {
      return JSON.parse(t) as T;
    } catch {
      return undefined;
    }
  }

  private withTentativeLast(): T[] {
    // A final line still being written (or a file without a trailing newline) is shown but not stored.
    if (!this.partial.length) return this.records;
    const last = this.parseLine(this.partial.toString('utf8'));
    return last === undefined ? this.records : [...this.records, last];
  }

  private async refresh(): Promise<T[]> {
    let st;
    try {
      st = await fs.stat(this.file);
    } catch {
      this.reset();
      return [];
    }
    if (st.size === this.size && st.mtimeMs === this.mtimeMs && st.ino === this.ino) return this.withTentativeLast();
    if (st.ino !== this.ino || st.size < this.offset) this.reset();

    let start = this.offset;
    let skipFirst = false;
    if (this.offset === 0 && st.size > this.opts.initialBytes) {
      start = st.size - this.opts.initialBytes;
      skipFirst = true;
    }
    const len = st.size - start;
    if (len > 0) {
      const fh = await fs.open(this.file, 'r');
      const chunk = Buffer.alloc(len);
      try {
        await fh.read(chunk, 0, len, start);
      } finally {
        await fh.close();
      }
      const buf = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
      const lastNl = buf.lastIndexOf(0x0a);
      const complete = lastNl >= 0 ? buf.subarray(0, lastNl) : Buffer.alloc(0);
      this.partial = Buffer.from(lastNl >= 0 ? buf.subarray(lastNl + 1) : buf);
      const lines = complete.length ? complete.toString('utf8').split('\n') : [];
      if (skipFirst) lines.shift();
      for (const line of lines) {
        const rec = this.parseLine(line);
        if (rec !== undefined) this.records.push(rec);
      }
      if (this.records.length > this.opts.maxRecords) this.records.splice(0, this.records.length - this.opts.maxRecords);
    }
    this.offset = st.size;
    this.size = st.size;
    this.mtimeMs = st.mtimeMs;
    this.ino = st.ino;
    return this.withTentativeLast();
  }
}

/** Counts lines in a growing file without re-reading what it already counted. */
class LineCounter {
  private counted = 0;
  private lines = 0;
  private ino = -1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  count(): Promise<{ lines: number; bytes: number }> {
    const run = this.queue.then(() => this.refresh());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async refresh(): Promise<{ lines: number; bytes: number }> {
    let st;
    try {
      st = await fs.stat(this.file);
    } catch {
      this.counted = 0;
      this.lines = 0;
      return { lines: 0, bytes: 0 };
    }
    if (st.ino !== this.ino || st.size < this.counted) {
      this.counted = 0;
      this.lines = 0;
      this.ino = st.ino;
    }
    if (st.size > this.counted) {
      await new Promise<void>((resolve, reject) => {
        const s = createReadStream(this.file, { start: this.counted, end: st.size - 1 });
        s.on('data', (c) => {
          const b = c as Buffer;
          for (let i = 0; i < b.length; i++) if (b[i] === 0x0a) this.lines++;
        });
        s.on('end', () => resolve());
        s.on('error', reject);
      });
      this.counted = st.size;
    }
    return { lines: this.lines, bytes: st.size };
  }
}

export interface DecisionRecord {
  at: string;
  eventId: string;
  source: string;
  kind: string;
  text: string;
  label: 'WAKE' | 'SLEEP';
  confidence: number;
  backend: string;
  reason?: string;
  durationMs: number;
}

export interface TraceTurn {
  turn: number;
  thought?: string;
  gapId?: string;
  toolId: string;
  input: Record<string, unknown>;
  receipt: {
    toolId: string;
    effect?: string;
    status: string;
    durationMs: number;
    summary: string;
    changes?: string[];
    data?: unknown;
    error?: string;
    nextHints?: string[];
    at: string;
  };
}

export interface WakeRecordLike {
  wakeId: string;
  at: string;
  trigger: { id: string; source: string; kind: string; actor?: string; text: string };
  decision?: { label: string; confidence?: number; backend?: string; reason?: string; durationMs?: number };
  turns: number;
  durationMs: number;
  acted: boolean;
  slept: boolean;
  sleepReason?: string;
  /** Why the wake ended (newer records): slept, turn_cap, unreadable or crashed. */
  endReason?: 'slept' | 'turn_cap' | 'unreadable' | 'crashed';
  /** The crash message, when it crashed. */
  error?: string;
  sentMessages: string[];
  trace: TraceTurn[];
  /** Every model call the wake made (newer records). */
  modelCalls?: Array<{ ok?: boolean; costUsd?: number }>;
  costUsd?: number;
}

interface LiveFile {
  status: 'awake' | 'asleep';
  wakeId?: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  trigger?: { id: string; source: string; kind: string; text: string; actor?: string };
  decision?: WakeRecordLike['decision'];
  turns?: TraceTurn[];
}

export type Ending = 'sleep' | 'cap' | 'safety' | 'crashed' | 'unreadable' | 'live';

/** Which plate sense each connector in `senses.json` feeds. */
const CONNECTOR_SENSE: Record<string, string> = { telegram: 'message', beeper: 'message', gmail: 'email', calendar: 'calendar', 'browser-history': 'browser', watches: 'watch' };
const HEALTH_RANK: Record<string, number> = { ok: 0, quiet: 1, broken: 2 };

/** A wake's model spend, from its own total or the sum of its metered calls. */
function costOf(w: Pick<WakeRecordLike, 'costUsd' | 'modelCalls'>): number | undefined {
  if (typeof w.costUsd === 'number' && Number.isFinite(w.costUsd)) return w.costUsd;
  if (!Array.isArray(w.modelCalls)) return undefined;
  return w.modelCalls.reduce((n, c) => n + (typeof c?.costUsd === 'number' ? c.costUsd : 0), 0);
}

/** Which sense an event came in through (Rufus's own messages and actions are memory, not a sense). */
export function senseOf(e: { source: string; kind: string }): string {
  if (e.source === 'self' || (e.source === 'message' && e.kind === 'assistant_sent')) return 'self';
  const known = ['message', 'email', 'calendar', 'screen', 'browser', 'file', 'system', 'watch'];
  return known.includes(e.source) ? e.source : 'other';
}

export const SENSES: Array<{ id: string; label: string }> = [
  { id: 'message', label: 'Messages' },
  { id: 'email', label: 'Email' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'screen', label: 'Active app' },
  { id: 'browser', label: 'Browser' },
  { id: 'file', label: 'Downloads' },
  { id: 'system', label: 'System' },
  { id: 'other', label: 'Other' },
  { id: 'watch', label: 'Wake-ups' },
];

const trim = (s: unknown, n: number): string => {
  const t = typeof s === 'string' ? s : s === undefined || s === null ? '' : JSON.stringify(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Long strings and arrays cut down, structure kept (so the page can still read it as an object). */
function trimDeep(v: unknown, n = 280, depth = 0): unknown {
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n - 1)}…` : v;
  if (Array.isArray(v)) return depth > 3 ? `[${v.length} items]` : [...v.slice(0, 8).map((x) => trimDeep(x, n, depth + 1)), ...(v.length > 8 ? [`…${v.length - 8} more`] : [])];
  if (v && typeof v === 'object') {
    if (depth > 3) return '{…}';
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 16).map(([k, x]) => [k, trimDeep(x, n, depth + 1)]));
  }
  return v;
}

function rootGap(): Gap {
  const ts = new Date(0).toISOString();
  return {
    id: ROOT_GAP_ID,
    title: 'Find the gaps that matter to the owner',
    source: 'owner',
    status: 'open',
    target: 'Every gap between what the owner wants true and what is true right now is on this board, and each one is moving.',
    reality: 'Not measured yet.',
    evidenceIds: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The outline's 10 numbered parts, read from docs/OUTLINE.md (with a built-in copy if the file is missing). */
let outlineCache: Array<{ n: number; name: string; text: string }> | undefined;
export async function loadOutline(): Promise<Array<{ n: number; name: string; text: string }>> {
  if (outlineCache) return outlineCache;
  const parts: Array<{ n: number; name: string; text: string }> = [];
  try {
    const md = await fs.readFile(OUTLINE_PATH, 'utf8');
    for (const line of md.split('\n')) {
      const m = /^(\d+)\.\s+\*\*(.+?)\.?\*\*\s*(.*)$/.exec(line.trim());
      if (m) parts.push({ n: Number(m[1]), name: m[2]!.replace(/\.$/, ''), text: m[3]!.replace(/`/g, '') });
    }
  } catch {
    /* fall back below */
  }
  if (parts.length < 10) {
    const names = ['Senses', 'Memory', 'Bouncer', 'Gaps', 'The Desk', 'Decide', 'Trust gate', 'Repeat', 'Tools', 'Sleep'];
    outlineCache = names.map((name, i) => ({ n: i + 1, name, text: '' }));
  } else {
    outlineCache = parts.slice(0, 10);
  }
  return outlineCache;
}

/** Built-in tool manifests, captured by running the registration against a recorder (no side effects). */
let builtinCache: Promise<ToolManifest[]> | undefined;
function builtinManifests(): Promise<ToolManifest[]> {
  builtinCache ??= (async () => {
    const out: ToolManifest[] = [];
    try {
      const { registerBuiltins } = await import('../scripts/builtins');
      const recorder = { registerInline: async (m: ToolManifest) => void out.push(m) };
      await registerBuiltins({
        registry: recorder as never,
        speakerProvider: { name: 'none', complete: async () => '' },
        sink: { send: async () => undefined },
        getWakeReceipts: () => [],
        onSent: () => undefined,
        onSleep: () => undefined,
      });
    } catch {
      /* the dashboard still works without built-in details */
    }
    return out;
  })();
  return builtinCache;
}

export type TrustWord = 'never' | 'rehearse' | 'draft' | 'act_and_report' | 'act_quietly';

export interface DashboardDataOptions {
  workspaceDir: string;
  /** The daemon's HTTP port (for its /health). Defaults to RUFUS_HTTP_PORT or 8787. */
  daemonPort?: number;
  /** Override the health check (tests). */
  healthCheck?: () => Promise<boolean>;
}

/** The loop's own "did this change something" rule, applied to a receipt as read back from disk. */
function changed(r: { toolId: string; effect?: string; status: string; changes?: string[] } | undefined): boolean {
  return !!r && isRealChange({ toolId: r.toolId, effect: (r.effect ?? 'read') as Receipt['effect'], status: r.status as Receipt['status'], changes: r.changes });
}

export class DashboardData {
  readonly dir: string;
  readonly events: JsonlTail<LosslessEvent>;
  readonly wakes: JsonlTail<WakeRecordLike>;
  readonly decisions: JsonlTail<DecisionRecord>;
  private readonly vectors: LineCounter;
  private readonly examples: LineCounter;
  private readonly approvals: ApprovalStore;
  private readonly daemonPort: number;
  private readonly healthCheck: () => Promise<boolean>;
  private health: { up: boolean; at: number } | undefined;
  private toolsCache: { key: string; value: Awaited<ReturnType<DashboardData['loadTools']>> } | undefined;

  constructor(opts: DashboardDataOptions) {
    this.dir = opts.workspaceDir;
    this.events = new JsonlTail(path.join(this.dir, 'events.jsonl'), { maxRecords: 30_000, initialBytes: 24 * 1024 * 1024 });
    this.wakes = new JsonlTail(path.join(this.dir, 'wakes.jsonl'), { maxRecords: 4_000, initialBytes: 32 * 1024 * 1024 });
    this.decisions = new JsonlTail(path.join(this.dir, 'decisions.jsonl'), { maxRecords: 30_000, initialBytes: 16 * 1024 * 1024 });
    this.vectors = new LineCounter(path.join(this.dir, 'events.vectors.jsonl'));
    this.examples = new LineCounter(path.join(this.dir, 'training', 'bouncer.jsonl'));
    this.approvals = new ApprovalStore(this.dir);
    this.daemonPort = opts.daemonPort ?? Number(process.env.RUFUS_HTTP_PORT || 8787);
    this.healthCheck =
      opts.healthCheck ??
      (async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${this.daemonPort}/health`, { signal: AbortSignal.timeout(900) });
          return res.ok;
        } catch {
          return false;
        }
      });
  }

  private async daemonUp(): Promise<boolean> {
    if (this.health && Date.now() - this.health.at < 4_000) return this.health.up;
    const up = await this.healthCheck();
    this.health = { up, at: Date.now() };
    return up;
  }

  async gaps(): Promise<Gap[]> {
    const raw = await readJson<unknown>(path.join(this.dir, 'gaps.json'), []);
    const list = (Array.isArray(raw) ? raw : []).filter((g): g is Gap => !!g && typeof g === 'object' && typeof (g as Gap).id === 'string');
    if (!list.some((g) => g.id === ROOT_GAP_ID)) list.unshift(rootGap());
    return list;
  }

  async watches(): Promise<WatchItem[]> {
    const raw = await readJson<unknown>(path.join(this.dir, 'watches.json'), []);
    return (Array.isArray(raw) ? raw : []).filter((w): w is WatchItem => !!w && typeof w === 'object' && typeof (w as WatchItem).id === 'string' && !(w as WatchItem).fired);
  }

  async pendingApprovals(): Promise<PendingApproval[]> {
    return this.approvals.listPending();
  }

  async live(): Promise<LiveFile | undefined> {
    const raw = await readJson<LiveFile | undefined>(path.join(this.dir, 'live.json'), undefined);
    if (!raw || (raw.status !== 'awake' && raw.status !== 'asleep')) return undefined;
    return raw;
  }

  /** All tools (built-in + built by Rufus) with their current rung on the trust ladder. */
  private async loadTools() {
    const builtins = await builtinManifests();
    const custom: Array<ToolManifest & { broken?: boolean }> = [];
    const toolsDir = path.join(this.dir, 'tools');
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(toolsDir)).filter((e) => !e.startsWith('.') && !e.startsWith('_')).sort();
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const m = await readJson<ToolManifest | undefined>(path.join(toolsDir, entry, 'tool.json'), undefined);
      if (!m || typeof m.id !== 'string') continue;
      const stats = await readJson<{ consecutiveFailures?: number } | undefined>(path.join(toolsDir, entry, 'stats.json'), undefined);
      custom.push({ ...m, ...((stats?.consecutiveFailures ?? 0) >= 3 ? { broken: true } : {}) });
    }
    const all = [...builtins.map((m) => ({ ...m, builtin: true })), ...custom.map((m) => ({ ...m, builtin: false }))];
    const levels: Record<string, TrustWord> = {};
    for (const m of all) levels[m.id] = await this.approvals.levelFor(m);
    const ladder: Record<TrustWord, number> = { never: 0, rehearse: 0, draft: 0, act_and_report: 0, act_quietly: 0 };
    for (const lvl of Object.values(levels)) ladder[lvl]++;
    return {
      total: all.length,
      builtin: builtins.length,
      custom: custom.length,
      broken: custom.filter((m) => m.broken).map((m) => m.id),
      levels,
      ladder,
      list: all.map((m) => ({ id: m.id, effect: m.effect, builtin: m.builtin, description: trim(m.description, 160), level: levels[m.id]! })),
    };
  }

  async tools() {
    const stamp = async (p: string) => {
      try {
        const s = await fs.stat(p);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return '-';
      }
    };
    const key = [await stamp(path.join(this.dir, 'tools')), await stamp(path.join(this.dir, 'trust.json')), await stamp(path.join(this.dir, 'permissions.json'))].join('|');
    if (this.toolsCache?.key === key) return this.toolsCache.value;
    const value = await this.loadTools();
    this.toolsCache = { key, value };
    return value;
  }

  private async skills(): Promise<string[]> {
    try {
      return (await fs.readdir(path.join(this.dir, 'skills'))).filter((f) => f.endsWith('.md') && !f.startsWith('.')).map((f) => f.replace(/\.md$/, '')).sort();
    } catch {
      return [];
    }
  }

  static ending(w: Pick<WakeRecordLike, 'slept' | 'turns' | 'endReason'>): Ending {
    if (w.slept || w.endReason === 'slept') return 'sleep';
    if (w.endReason === 'crashed') return 'crashed';
    if (w.endReason === 'unreadable') return 'unreadable';
    if (w.endReason === 'turn_cap') return 'cap';
    // Older records have no endReason: infer it from the turn count.
    return w.turns >= TURN_CAP ? 'cap' : 'safety';
  }

  static startOf(w: Pick<WakeRecordLike, 'at' | 'durationMs'>): string {
    const end = Date.parse(w.at);
    return Number.isFinite(end) ? new Date(end - (w.durationMs || 0)).toISOString() : w.at;
  }

  private static wakeSummary(w: WakeRecordLike) {
    const trace = Array.isArray(w.trace) ? w.trace : [];
    return {
      wakeId: w.wakeId,
      at: w.at,
      startedAt: DashboardData.startOf(w),
      durationMs: w.durationMs,
      trigger: { source: w.trigger?.source, kind: w.trigger?.kind, actor: w.trigger?.actor, sense: senseOf(w.trigger ?? { source: '', kind: '' }), text: trim(w.trigger?.text, 220) },
      turns: w.turns,
      acted: w.acted,
      slept: w.slept,
      ending: DashboardData.ending(w),
      sleepReason: trim(w.sleepReason, 240),
      sent: (w.sentMessages ?? []).length,
      firstSent: trim((w.sentMessages ?? [])[0], 160),
      costUsd: costOf(w),
      moves: trace.map((t) => ({ toolId: t.toolId, status: t.receipt?.status ?? 'ok', gapId: t.gapId })),
    };
  }

  /** Everything the page needs for its first paint. */
  async snapshot(now = new Date()) {
    const nowMs = now.getTime();
    const since = nowMs - DAY_MS;
    const [events, wakes, decisions, gaps, watches, approvals, live, tools, skills, vectors, examples, daemonUp, outline, senseFile] = await Promise.all([
      this.events.read(),
      this.wakes.read(),
      this.decisions.read(),
      this.gaps(),
      this.watches(),
      this.pendingApprovals(),
      this.live(),
      this.tools(),
      this.skills(),
      this.vectors.count(),
      this.examples.count(),
      this.daemonUp(),
      loadOutline(),
      readSensesFile(this.dir),
    ]);

    // 1. Senses: events per sense in the last 24h, the last event time, and each connector's health (senses.json).
    const senses = SENSES.map((s) => ({ ...s, count24h: 0, lastAt: undefined as string | undefined, health: undefined as SenseHealthEntry['status'] | undefined, problem: undefined as string | undefined }));
    const health = Object.values(senseFile?.senses ?? {})
      .filter((e): e is SenseHealthEntry => !!e && typeof e === 'object' && typeof e.id === 'string')
      .map((e) => ({
        id: e.id,
        sense: CONNECTOR_SENSE[e.id] ?? 'other',
        status: e.status,
        problem: e.problem ? trim(e.problem, 200) : undefined,
        lastPollAt: e.lastPollAt,
        lastSuccessAt: e.lastSuccessAt,
        lastEventAt: e.lastEventAt,
        events24h: e.events24h,
        failures24h: e.failures24h,
      }));
    for (const h of health) {
      const row = senses.find((s) => s.id === h.sense);
      if (row && (HEALTH_RANK[h.status] ?? 0) >= (HEALTH_RANK[row.health ?? 'ok'] ?? 0)) {
        row.health = h.status;
        if (h.status === 'broken') row.problem = `${h.id}: ${h.problem ?? 'broken'}`;
      }
    }
    let self24h = 0;
    for (const e of events) {
      const sense = senseOf(e);
      const t = Date.parse(e.timestamp);
      if (sense === 'self') {
        if (t >= since) self24h++;
        continue;
      }
      const row = senses.find((s) => s.id === sense)!;
      if (t >= since) row.count24h++;
      if (!row.lastAt || e.timestamp > row.lastAt) row.lastAt = e.timestamp;
    }

    // 3. Bouncer: WAKE / SLEEP in the last 24h (from decisions.jsonl; falls back to wakes when it isn't logged yet).
    const recentDecisions = decisions.filter((d) => Date.parse(d.at) >= since);
    const backends: Record<string, number> = {};
    for (const d of recentDecisions) backends[d.backend] = (backends[d.backend] ?? 0) + 1;
    const wakes24 = wakes.filter((w) => Date.parse(w.at) >= since);
    const lastDecision = decisions[decisions.length - 1];
    const model = (await exists(path.join(this.dir, 'training', 'setfit-model'))) ? 'setfit' : 'prototype';

    // 4. Gaps, with each gap's next moves.
    const visibleGaps = gaps.filter((g) => !isDone(g) || nowMs - Date.parse(g.updatedAt) <= RECENTLY_CLOSED_MS);
    const gapIds = new Set(gaps.map((g) => g.id));
    const gapCounts = { open: 0, proposed: 0, waiting: 0, closed: 0, dropped: 0 } as Record<string, number>;
    for (const g of visibleGaps) gapCounts[g.status] = (gapCounts[g.status] ?? 0) + 1;

    const timers = watches.filter((w) => w.kind === 'timer' && w.fireAt).sort((a, b) => Date.parse(a.fireAt!) - Date.parse(b.fireAt!) || Number(!!b.gapId) - Number(!!a.gapId));
    const threads = watches.filter((w) => w.kind === 't3_thread');
    const next = timers[0];

    const lastWake = wakes[wakes.length - 1];
    const activeLive = live?.status === 'awake' ? live : undefined;

    // Credits & 3-tier provider status (read-only) + wake efficiency telemetry.
    const creditTracker = new CreditTracker(this.dir);
    const creditState = await creditTracker.load();
    const claudeLimit = await creditTracker.activeLimit('claude-cli:opus', now);
    const recentTurns = wakes.slice(-100).map((w) => w.turns || 0).filter((n) => n > 0).sort((a, b) => a - b);
    const medianTurns = recentTurns.length ? recentTurns[Math.floor(recentTurns.length * 0.5)]! : 0;
    const decWake = recentDecisions.filter((d) => d.label === 'WAKE').length;
    const decSleep = recentDecisions.filter((d) => d.label === 'SLEEP').length;
    const bouncerSleepPct = decWake + decSleep > 0 ? Math.round((100 * decSleep) / (decWake + decSleep)) : undefined;
    const setfitTimes = recentDecisions
      .filter((d) => d.backend === 'setfit' && typeof d.durationMs === 'number' && Number.isFinite(d.durationMs))
      .map((d) => d.durationMs!)
      .sort((a, b) => a - b);
    const setfitMs = setfitTimes.length ? Math.round(setfitTimes[Math.floor(setfitTimes.length * 0.5)]!) : undefined;
    const crashed24h = wakes24.filter((w) => DashboardData.ending(w) === 'crashed').length;
    const cleanSleepPct = wakes24.length ? Math.round((100 * wakes24.filter((w) => DashboardData.ending(w) === 'sleep').length) / wakes24.length) : undefined;
    const standingGaps = gaps.filter((g) => g.standing && !isDone(g)).length;
    const localModel = findLocalLlmModel(this.dir);
    const cap5h = creditState.calibrated5hUsd ?? 15;
    const cap7d = creditState.calibrated7dUsd ?? 100;
    const used5h = creditState.usage
      .filter((u) => nowMs - Date.parse(u.at) <= 5 * 3600_000)
      .reduce((s, u) => s + (u.costUsd || 0), 0);
    const used7d = creditState.usage
      .filter((u) => nowMs - Date.parse(u.at) <= 7 * DAY_MS)
      .reduce((s, u) => s + (u.costUsd || 0), 0);
    const left5hPct = claudeLimit ? 0 : Math.max(0, Math.min(100, Math.round((1 - used5h / cap5h) * 100)));
    const left7dPct = Math.max(0, Math.min(100, Math.round((1 - used7d / cap7d) * 100)));

    return {
      now: now.toISOString(),
      workspace: path.basename(this.dir),
      daemon: { up: daemonUp, port: this.daemonPort },
      credits: {
        primary: 'claude-cli:opus',
        pausedUntil: claudeLimit?.resetsAt,
        resetLabel: claudeLimit?.resetLabel,
        limitWindow: claudeLimit?.window,
        left5hPct,
        left7dPct,
        localModel: localModel ? path.basename(localModel) : undefined,
      },
      telemetry: {
        medianTurns,
        bouncerSleepPct,
        setfitMs,
        crashed24h,
        cleanSleepPct,
        standingGaps,
      },
      outline,
      live: activeLive
        ? {
            status: 'awake' as const,
            wakeId: activeLive.wakeId,
            startedAt: activeLive.startedAt,
            updatedAt: activeLive.updatedAt,
            trigger: activeLive.trigger ? { ...activeLive.trigger, sense: senseOf(activeLive.trigger), text: trim(activeLive.trigger.text, 300) } : undefined,
            decision: activeLive.decision,
            turns: (activeLive.turns ?? []).map((t) => ({
              turn: t.turn,
              thought: trim(t.thought, 400),
              gapId: t.gapId,
              toolId: t.toolId,
              status: t.receipt?.status,
              summary: trim(t.receipt?.summary, 240),
            })),
          }
        : {
            status: 'asleep' as const,
            since: live?.endedAt ?? lastWake?.at,
            lastWakeId: live?.wakeId ?? lastWake?.wakeId,
          },
      anatomy: {
        senses,
        senseHealth: health,
        memory: { events: events.length, indexed: vectors.lines, bytes: vectors.bytes, self24h, lastAt: events[events.length - 1]?.timestamp },
        bouncer: {
          logged: decisions.length > 0,
          wake24h: recentDecisions.length ? recentDecisions.filter((d) => d.label === 'WAKE').length : wakes24.length,
          sleep24h: recentDecisions.length ? recentDecisions.filter((d) => d.label === 'SLEEP').length : undefined,
          backends,
          model,
          examples: examples.lines,
          lastMs: lastDecision?.durationMs,
        },
        gaps: gapCounts,
        desk: {
          wakes24h: wakes24.length,
          acted24h: wakes24.filter((w) => w.acted).length,
          // Model spend over the wakes that recorded it (older records have none).
          cost24h: wakes24.reduce((n, w) => n + (costOf(w) ?? 0), 0),
          metered24h: wakes24.filter((w) => costOf(w) !== undefined).length,
          modelCalls24h: wakes24.reduce((n, w) => n + (Array.isArray(w.modelCalls) ? w.modelCalls.length : 0), 0),
        },
        decide: { moves24h: wakes24.reduce((n, w) => n + (w.turns || 0), 0) },
        trust: tools.ladder,
        repeat: { cap: TURN_CAP, longest24h: wakes24.reduce((n, w) => Math.max(n, w.turns || 0), 0) },
        tools: { total: tools.total, builtin: tools.builtin, custom: tools.custom, broken: tools.broken, skills: skills.length, skillNames: skills },
        sleep: {
          next: next ? { at: next.fireAt, label: redactPaths(trim(next.label, 200)), gapId: next.gapId } : undefined,
          timers: timers.length,
          threads: threads.length,
          ended24h: Object.fromEntries((['sleep', 'cap', 'safety', 'crashed', 'unreadable'] as const).map((k) => [k, wakes24.filter((w) => DashboardData.ending(w) === k).length])),
        },
      },
      gaps: visibleGaps.map((g) => ({
        id: g.id,
        parentId: g.parentId,
        title: g.title,
        source: g.source,
        status: g.status,
        standing: g.standing === true,
        target: redactPaths(trim(g.target, 900)),
        reality: redactPaths(trim(g.reality, 900)),
        waitingOn: g.waitingOn,
        due: g.due,
        // What was already tried for this gap (code's work log), newest last.
        log: (Array.isArray(g.log) ? g.log : []).slice(-3).map((e) => ({ at: e.at, toolId: e.toolId, status: e.status, result: redactPaths(trim(e.result, 160)), wakeId: e.wakeId })),
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        next: watches
          .filter((w) => w.gapId === g.id || !!w.gapIds?.includes(g.id))
          .map((w) => ({ id: w.id, kind: w.kind, label: redactPaths(trim(w.label, 400)), fireAt: w.fireAt, threadId: w.threadId }))
          .sort((a, b) => (a.fireAt ? Date.parse(a.fireAt) : Infinity) - (b.fireAt ? Date.parse(b.fireAt) : Infinity)),
      })),
      gapTitles: Object.fromEntries(gaps.map((g) => [g.id, g.title])),
      looseWatches: watches
        .filter((w) => !w.gapId || !gapIds.has(w.gapId))
        .map((w) => ({ id: w.id, kind: w.kind, label: redactPaths(trim(w.label, 400)), fireAt: w.fireAt, threadId: w.threadId })),
      approvals: approvals.map((a) => ({ id: a.id, toolId: a.toolId, input: trimDeep(a.input ?? {}), gapId: a.gapId, createdAt: a.createdAt })),
      recentEvents: events.slice(-60).map((e) => ({ id: e.id, source: e.source, kind: e.kind, sense: senseOf(e), at: e.timestamp, actor: e.actor, text: redactPaths(trim(e.text, 160)) })),
      recentDecisions: decisions.slice(-60).map((d) => ({ eventId: d.eventId, at: d.at, label: d.label, backend: d.backend, reason: d.reason, durationMs: d.durationMs })),
      wakes: wakes.slice(-150).reverse().map((w) => DashboardData.wakeSummary(w)),
      recentMoves: wakes
        .slice(-40)
        .flatMap((w) => (w.trace ?? []).filter((t) => t.thought && t.toolId !== 'sleep').map((t) => ({ wakeId: w.wakeId, at: t.receipt?.at || w.at, thought: trim(t.thought, 300), toolId: t.toolId, gapId: t.gapId, status: t.receipt?.status })))
        .slice(-14)
        .reverse(),
      trustLevels: tools.levels,
      tools: tools.list,
    };
  }

  /** Events, bouncer calls, wakes and sent messages in the last `hours`, text trimmed. */
  async timeline(hours = 24, now = new Date()) {
    const h = Math.max(1, Math.min(24 * 14, Number.isFinite(hours) ? hours : 24));
    const to = now.getTime();
    const from = to - h * 60 * 60_000;
    const [events, decisions, wakes] = await Promise.all([this.events.read(), this.decisions.read(), this.wakes.read()]);
    const inWindow = (iso: string) => {
      const t = Date.parse(iso);
      return t >= from && t <= to + 60_000;
    };
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      hours: h,
      events: events
        .filter((e) => inWindow(e.timestamp))
        .map((e) => ({ id: e.id, source: e.source, kind: e.kind, sense: senseOf(e), at: e.timestamp, actor: e.actor, text: trim(e.text, 120) })),
      decisions: decisions.filter((d) => inWindow(d.at)).map((d) => ({ eventId: d.eventId, at: d.at, label: d.label, backend: d.backend, source: d.source })),
      decisionsLogged: decisions.length > 0,
      wakes: wakes
        .filter((w) => inWindow(w.at))
        .map((w) => ({
          wakeId: w.wakeId,
          start: DashboardData.startOf(w),
          end: w.at,
          turns: w.turns,
          acted: w.acted,
          ending: DashboardData.ending(w),
          sense: senseOf(w.trigger ?? { source: '', kind: '' }),
          triggerKind: w.trigger?.kind,
          text: trim(w.trigger?.text, 120),
          sent: (w.sentMessages ?? []).length,
        })),
      sent: events
        .filter((e) => e.source === 'message' && e.kind === 'assistant_sent' && inWindow(e.timestamp))
        .map((e) => ({ id: e.id, at: e.timestamp, text: trim(e.text, 160) })),
    };
  }

  /** One full wake: the live one in progress, or a finished one from wakes.jsonl. */
  async wake(id: string) {
    const live = await this.live();
    const [gaps, tools] = await Promise.all([this.gaps(), this.tools()]);
    const gapTitles = Object.fromEntries(gaps.map((g) => [g.id, g.title]));
    if (live?.status === 'awake' && live.wakeId === id) {
      const trace = live.turns ?? [];
      return {
        live: true,
        wakeId: id,
        startedAt: live.startedAt,
        at: live.updatedAt ?? live.startedAt,
        trigger: live.trigger ? { ...live.trigger, sense: senseOf(live.trigger) } : undefined,
        decision: live.decision,
        turns: trace.length,
        durationMs: live.startedAt ? Date.now() - Date.parse(live.startedAt) : 0,
        slept: false,
        // Same rule the loop uses when it records the wake: wrote, sent, drafted or created a gap.
        acted: trace.some((t) => changed(t.receipt)),
        ending: 'live' as Ending,
        sentMessages: trace.filter((t) => t.toolId === 'send_message' && t.receipt?.status === 'ok').map((t) => String((t.receipt.data as { text?: string } | undefined)?.text ?? '')).filter(Boolean),
        trace: trace.map(DashboardData.cleanTurn),
        gapTitles,
        trustLevels: tools.levels,
      };
    }
    let w = (await this.wakes.read()).find((x) => x.wakeId === id);
    if (!w) w = await this.scanForWake(id);
    if (!w) return undefined;
    return {
      live: false,
      wakeId: w.wakeId,
      startedAt: DashboardData.startOf(w),
      at: w.at,
      trigger: w.trigger ? { ...w.trigger, sense: senseOf(w.trigger) } : undefined,
      decision: w.decision,
      turns: w.turns,
      durationMs: w.durationMs,
      slept: w.slept,
      acted: w.acted,
      sleepReason: w.sleepReason,
      error: w.error ? trim(w.error.replace(/\/(?:Users|home)\/[^/\s]+\//g, '~/'), 400) : undefined,
      ending: DashboardData.ending(w),
      costUsd: costOf(w),
      modelCalls: Array.isArray(w.modelCalls) ? w.modelCalls.length : undefined,
      modelFailures: Array.isArray(w.modelCalls) ? w.modelCalls.filter((c) => c?.ok === false).length : undefined,
      sentMessages: w.sentMessages ?? [],
      trace: (w.trace ?? []).map(DashboardData.cleanTurn),
      gapTitles,
      trustLevels: tools.levels,
    };
  }

  private static cleanTurn(t: TraceTurn) {
    const r = t.receipt ?? ({ status: 'ok', summary: '', durationMs: 0, toolId: t.toolId, at: '' } as TraceTurn['receipt']);
    const data = r.data as { text?: unknown; rehearsed?: unknown; approvalId?: unknown } | undefined;
    return {
      turn: t.turn,
      thought: t.thought,
      gapId: t.gapId,
      toolId: t.toolId,
      input: trimDeep(t.input ?? {}),
      receipt: {
        status: r.status,
        effect: r.effect,
        durationMs: r.durationMs,
        summary: redactPaths(trim(r.summary, 1200)),
        error: r.error ? redactPaths(r.error) : undefined,
        nextHints: r.nextHints,
        at: r.at,
        sentText: t.toolId === 'send_message' && typeof data?.text === 'string' ? data.text : undefined,
        rehearsed: data?.rehearsed === true,
        approvalId: typeof data?.approvalId === 'string' ? data.approvalId : undefined,
        realChange: changed(t.receipt),
      },
    };
  }

  /** A wake older than the cached tail: one streaming pass over the file (rare). */
  private async scanForWake(id: string): Promise<WakeRecordLike | undefined> {
    const file = path.join(this.dir, 'wakes.jsonl');
    if (!(await exists(file))) return undefined;
    const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    const needle = `"wakeId":"${id}"`;
    try {
      for await (const line of rl) {
        if (!line.includes(needle)) continue;
        try {
          return JSON.parse(line) as WakeRecordLike;
        } catch {
          return undefined;
        }
      }
    } finally {
      rl.close();
    }
    return undefined;
  }
}
