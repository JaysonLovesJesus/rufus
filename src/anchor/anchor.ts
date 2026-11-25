import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStore } from '../store';

/**
 * The Anchor: what matters right now, in one small, domain-agnostic file (`<workspace>/anchor.json`).
 * Goals say where you are heading, projects say what is in flight, boundaries say what Rufus must never do silently,
 * and the schedule says how today is meant to go. The Master Loop reads it on every pass.
 */

export type GoalPriority = 'high' | 'medium' | 'low';
export type GoalHorizon = 'today' | 'week' | 'month';
export type ProjectStatus = 'active' | 'paused' | 'done';
export type BoundaryKind = 'require_approval' | 'protect_time' | 'never';
export type BlockKind = 'focus' | 'meeting' | 'break' | 'scroll' | 'personal' | 'protected';
export type BlockStatus = 'planned' | 'done' | 'skipped';

/** What an action touches. External sends, money and logins always need a human's approval, whatever the trust level. */
export type Sensitivity = 'external' | 'money' | 'login';
export const SENSITIVITIES: readonly Sensitivity[] = ['external', 'money', 'login'];

export interface AnchorGoal {
  id: string;
  title: string;
  priority: GoalPriority;
  horizon: GoalHorizon;
  active: boolean;
  notes?: string;
}

export interface AnchorProject {
  id: string;
  name: string;
  status: ProjectStatus;
  nextStep?: string;
  path?: string;
}

export interface AnchorBoundary {
  id: string;
  /** Plain words, shown to the human: "Ask me before sending anything external". */
  rule: string;
  kind: BoundaryKind;
  /** Optional: the action types (`reply.chat`) or sensitivities (`external`, `money`, `login`) this rule covers. */
  appliesTo?: string[];
}

export interface ScheduleBlock {
  id: string;
  /** `HH:MM`, 24-hour, local time. */
  start: string;
  /** `HH:MM`, after `start`. */
  end: string;
  title: string;
  kind: BlockKind;
  /** Where it came from (`calendar`, `rufus`, `manual`, ...). */
  source?: string;
  status: BlockStatus;
}

export interface DaySchedule {
  /** `YYYY-MM-DD`, local. */
  date: string;
  blocks: ScheduleBlock[];
}

export interface Anchor {
  version: 1;
  goals: AnchorGoal[];
  projects: AnchorProject[];
  boundaries: AnchorBoundary[];
  /** The current day's plan. */
  schedule: DaySchedule;
  /** Earlier days, newest first (kept so planning a new day never throws the old one away). Capped at 30. */
  pastSchedules?: DaySchedule[];
  updatedAt?: string;
}

export const ANCHOR_FILE = 'anchor.json';
export const MAX_PAST_SCHEDULES = 30;

const PRIORITIES: readonly GoalPriority[] = ['high', 'medium', 'low'];
const HORIZONS: readonly GoalHorizon[] = ['today', 'week', 'month'];
const PROJECT_STATUSES: readonly ProjectStatus[] = ['active', 'paused', 'done'];
const BOUNDARY_KINDS: readonly BoundaryKind[] = ['require_approval', 'protect_time', 'never'];
export const BLOCK_KINDS: readonly BlockKind[] = ['focus', 'meeting', 'break', 'scroll', 'personal', 'protected'];
const BLOCK_STATUSES: readonly BlockStatus[] = ['planned', 'done', 'skipped'];

export const anchorFile = (dir: string): string => path.join(dir, ANCHOR_FILE);

/** `YYYY-MM-DD` in this machine's local time. */
export function localDate(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `Ship the beta!` -> `ship-the-beta`. Falls back to `item` for text with no letters or digits. */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return s || 'item';
}

/** The safety floor every new Anchor starts with: nothing external, no money, no logins without a human's yes. */
export function defaultBoundaries(): AnchorBoundary[] {
  return [
    { id: 'external-send', rule: 'Ask me before sending anything outside (messages, emails, posts) on my behalf.', kind: 'require_approval', appliesTo: ['external'] },
    { id: 'money', rule: 'Ask me before spending money or making any payment.', kind: 'require_approval', appliesTo: ['money'] },
    { id: 'logins', rule: 'Ask me before signing in to an account or changing credentials.', kind: 'require_approval', appliesTo: ['login'] },
  ];
}

export function emptyAnchor(now: Date = new Date()): Anchor {
  return { version: 1, goals: [], projects: [], boundaries: [], schedule: { date: localDate(now), blocks: [] } };
}

// ---------- time ----------

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` -> minutes since midnight, or throws a clear error. `24:00` is allowed as an end of day. */
export function toMinutes(hhmm: string): number {
  const t = hhmm.trim();
  if (t === '24:00') return 24 * 60;
  const m = HHMM.exec(t.length === 4 ? `0${t}` : t);
  if (!m) throw new Error(`"${hhmm}" is not a time. Use HH:MM (24-hour), e.g. 09:30.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const pad = (hhmm: string): string => (hhmm.trim().length === 4 ? `0${hhmm.trim()}` : hhmm.trim());

/** `09:00-10:30` -> `{ start: '09:00', end: '10:30' }`. */
export function parseTimeRange(range: string): { start: string; end: string } {
  const m = /^\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*$/.exec(range);
  if (!m) throw new Error(`"${range}" is not a time range. Use HH:MM-HH:MM, e.g. 09:00-10:30.`);
  const start = pad(m[1]!);
  const end = pad(m[2]!);
  if (toMinutes(end) <= toMinutes(start)) throw new Error(`The block must end after it starts (${start}-${end}).`);
  return { start, end };
}

/** Half-open intervals: a block ending at 10:00 does not overlap one starting at 10:00. */
export const overlaps = (a: Pick<ScheduleBlock, 'start' | 'end'>, b: Pick<ScheduleBlock, 'start' | 'end'>): boolean =>
  toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);

// ---------- normalize ----------

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function normalizeBlock(raw: unknown): ScheduleBlock | undefined {
  const r = obj(raw);
  const start = str(r?.start);
  const end = str(r?.end);
  const title = str(r?.title);
  if (!r || !start || !end || !title) return undefined;
  try {
    if (toMinutes(end) <= toMinutes(start)) return undefined;
  } catch {
    return undefined;
  }
  return {
    id: str(r.id) ?? `${pad(start)}-${slugify(title)}`,
    start: pad(start),
    end: pad(end),
    title,
    kind: oneOf(r.kind, BLOCK_KINDS, 'focus'),
    ...(str(r.source) ? { source: str(r.source)! } : {}),
    status: oneOf(r.status, BLOCK_STATUSES, 'planned'),
  };
}

function normalizeDay(raw: unknown, fallbackDate: string): DaySchedule {
  const r = obj(raw);
  const date = str(r?.date);
  return {
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : fallbackDate,
    blocks: sortBlocks(arr(r?.blocks).map(normalizeBlock).filter((b): b is ScheduleBlock => !!b)),
  };
}

const sortBlocks = (blocks: ScheduleBlock[]): ScheduleBlock[] => [...blocks].sort((a, b) => toMinutes(a.start) - toMinutes(b.start) || a.id.localeCompare(b.id));

/** Any JSON value -> a valid Anchor. Missing or broken parts become empty, never an error, so a hand edit never locks you out. */
export function normalizeAnchor(raw: unknown, now: Date = new Date()): Anchor {
  const r = obj(raw) ?? {};
  const goals = arr(r.goals).flatMap((g): AnchorGoal[] => {
    const o = obj(g);
    const title = str(o?.title);
    if (!o || !title) return [];
    return [{ id: str(o.id) ?? slugify(title), title, priority: oneOf(o.priority, PRIORITIES, 'medium'), horizon: oneOf(o.horizon, HORIZONS, 'week'), active: o.active !== false, ...(str(o.notes) ? { notes: str(o.notes)! } : {}) }];
  });
  const projects = arr(r.projects).flatMap((p): AnchorProject[] => {
    const o = obj(p);
    const name = str(o?.name);
    if (!o || !name) return [];
    return [{ id: str(o.id) ?? slugify(name), name, status: oneOf(o.status, PROJECT_STATUSES, 'active'), ...(str(o.nextStep) ? { nextStep: str(o.nextStep)! } : {}), ...(str(o.path) ? { path: str(o.path)! } : {}) }];
  });
  const boundaries = arr(r.boundaries).flatMap((b): AnchorBoundary[] => {
    const o = obj(b);
    const rule = str(o?.rule);
    if (!o || !rule) return [];
    const appliesTo = arr(o.appliesTo).map(str).filter((x): x is string => !!x);
    return [{ id: str(o.id) ?? slugify(rule), rule, kind: oneOf(o.kind, BOUNDARY_KINDS, 'require_approval'), ...(appliesTo.length ? { appliesTo } : {}) }];
  });
  const today = localDate(now);
  const past = arr(r.pastSchedules).map((d) => normalizeDay(d, today)).slice(0, MAX_PAST_SCHEDULES);
  return {
    version: 1,
    goals,
    projects,
    boundaries,
    schedule: normalizeDay(r.schedule, today),
    ...(past.length ? { pastSchedules: past } : {}),
    ...(str(r.updatedAt) ? { updatedAt: str(r.updatedAt)! } : {}),
  };
}

// ---------- load / save ----------

/** The workspace's Anchor, or an empty one when there is no `anchor.json` yet. */
export async function loadAnchor(dir: string, now: Date = new Date()): Promise<Anchor> {
  let text: string;
  try {
    text = await fs.readFile(anchorFile(dir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyAnchor(now);
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${anchorFile(dir)} is not valid JSON. Fix it by hand or move it away and run rufus anchor init.`);
  }
  return normalizeAnchor(parsed, now);
}

export async function anchorExists(dir: string): Promise<boolean> {
  try {
    await fs.access(anchorFile(dir));
    return true;
  } catch {
    return false;
  }
}

/** Atomic write (temp file + rename). */
export async function saveAnchor(dir: string, anchor: Anchor, now: Date = new Date()): Promise<Anchor> {
  const saved: Anchor = { ...normalizeAnchor(anchor, now), updatedAt: now.toISOString() };
  await new FileStore(dir).writeJson(anchorFile(dir), saved);
  return saved;
}

/** Creates `anchor.json` with the default boundaries, or returns the one already there untouched. */
export async function initAnchor(dir: string, now: Date = new Date()): Promise<{ anchor: Anchor; created: boolean }> {
  if (await anchorExists(dir)) return { anchor: await loadAnchor(dir, now), created: false };
  const anchor = await saveAnchor(dir, { ...emptyAnchor(now), boundaries: defaultBoundaries() }, now);
  return { anchor, created: true };
}

// ---------- goals ----------

export interface GoalInput {
  id?: string;
  title: string;
  priority?: GoalPriority;
  horizon?: GoalHorizon;
  active?: boolean;
  notes?: string;
}

/** Adds a goal, or updates the one with the same id (default: a slug of the title). Pure: returns a new Anchor. */
export function upsertGoal(anchor: Anchor, input: GoalInput): { anchor: Anchor; goal: AnchorGoal; created: boolean } {
  const title = input.title?.trim();
  if (!title) throw new Error('A goal needs a title.');
  if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) throw new Error(`priority must be one of ${PRIORITIES.join(', ')}.`);
  if (input.horizon !== undefined && !HORIZONS.includes(input.horizon)) throw new Error(`horizon must be one of ${HORIZONS.join(', ')}.`);
  const id = input.id?.trim() || slugify(title);
  const before = anchor.goals.find((g) => g.id === id);
  const notes = input.notes?.trim() || before?.notes;
  const goal: AnchorGoal = {
    id,
    title,
    priority: input.priority ?? before?.priority ?? 'medium',
    horizon: input.horizon ?? before?.horizon ?? 'week',
    active: input.active ?? before?.active ?? true,
    ...(notes ? { notes } : {}),
  };
  const goals = before ? anchor.goals.map((g) => (g.id === id ? goal : g)) : [...anchor.goals, goal];
  return { anchor: { ...anchor, goals }, goal, created: !before };
}

// ---------- schedule ----------

export interface BlockInput {
  id?: string;
  start: string;
  end: string;
  title: string;
  kind?: BlockKind;
  source?: string;
  status?: BlockStatus;
}

export interface UpsertBlockOptions {
  /** `YYYY-MM-DD`. Default: the Anchor's current day. A different day archives the current one and starts fresh. */
  date?: string;
  /** Allow overlapping ordinary blocks. A `protected` block can never be overlapped. */
  allowOverlap?: boolean;
}

/** Thrown when a new block collides with blocks already planned. `conflicts` says which. */
export class ScheduleOverlapError extends Error {
  constructor(
    readonly block: ScheduleBlock,
    readonly conflicts: ScheduleBlock[],
  ) {
    super(
      `${block.start}-${block.end} "${block.title}" overlaps ${conflicts.map((c) => `${c.start}-${c.end} "${c.title}"${c.kind === 'protected' ? ' (protected)' : ''}`).join(', ')}.`,
    );
    this.name = 'ScheduleOverlapError';
  }
}

/** Blocks on `day` that overlap `start`-`end` (ignoring the block with `ignoreId`, i.e. the one being moved). */
export function findScheduleConflicts(day: DaySchedule, slot: Pick<ScheduleBlock, 'start' | 'end'>, ignoreId?: string): ScheduleBlock[] {
  return day.blocks.filter((b) => b.id !== ignoreId && b.status !== 'skipped' && overlaps(b, slot));
}

/** The day to edit: the current one, or a fresh one for another date (the current day is archived, never lost). */
function dayFor(anchor: Anchor, date: string | undefined): { anchor: Anchor; day: DaySchedule } {
  if (!date || date === anchor.schedule.date) return { anchor, day: anchor.schedule };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date. Use YYYY-MM-DD.`);
  const archived = anchor.pastSchedules?.find((d) => d.date === date);
  const others = (anchor.pastSchedules ?? []).filter((d) => d.date !== date);
  const keepCurrent = anchor.schedule.blocks.length ? [anchor.schedule] : [];
  const pastSchedules = [...keepCurrent, ...others].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_PAST_SCHEDULES);
  const day = archived ?? { date, blocks: [] };
  return { anchor: { ...anchor, schedule: day, ...(pastSchedules.length ? { pastSchedules } : {}) }, day };
}

/**
 * Adds a block to the schedule, or updates the one with the same id. Pure: returns a new Anchor.
 * Throws `ScheduleOverlapError` when it would overlap another block (unless `allowOverlap`; a `protected` block always wins).
 */
export function upsertScheduleBlock(anchor: Anchor, input: BlockInput, opts: UpsertBlockOptions = {}): { anchor: Anchor; block: ScheduleBlock; created: boolean; overlaps: ScheduleBlock[] } {
  const title = input.title?.trim();
  if (!title) throw new Error('A block needs a title.');
  if (input.kind !== undefined && !BLOCK_KINDS.includes(input.kind)) throw new Error(`kind must be one of ${BLOCK_KINDS.join(', ')}.`);
  if (input.status !== undefined && !BLOCK_STATUSES.includes(input.status)) throw new Error(`status must be one of ${BLOCK_STATUSES.join(', ')}.`);
  const start = pad(input.start);
  const end = pad(input.end);
  if (toMinutes(end) <= toMinutes(start)) throw new Error(`The block must end after it starts (${start}-${end}).`);

  const { anchor: base, day } = dayFor(anchor, opts.date);
  const id = input.id?.trim() || `${start}-${slugify(title)}`;
  const before = day.blocks.find((b) => b.id === id);
  const block: ScheduleBlock = {
    id,
    start,
    end,
    title,
    kind: input.kind ?? before?.kind ?? 'focus',
    ...((input.source ?? before?.source) ? { source: input.source ?? before?.source } : {}),
    status: input.status ?? before?.status ?? 'planned',
  };
  const conflicts = block.status === 'skipped' ? [] : findScheduleConflicts(day, block, id);
  const hard = conflicts.filter((c) => c.kind === 'protected' || block.kind === 'protected');
  if (hard.length || (conflicts.length && !opts.allowOverlap)) throw new ScheduleOverlapError(block, hard.length ? hard : conflicts);

  const blocks = sortBlocks(before ? day.blocks.map((b) => (b.id === id ? block : b)) : [...day.blocks, block]);
  return { anchor: { ...base, schedule: { date: day.date, blocks } }, block, created: !before, overlaps: conflicts };
}

// ---------- boundaries ----------

export interface BoundaryCheck {
  /** `never` rules that cover this action: it must not run. */
  blockedBy: AnchorBoundary[];
  /** `require_approval` rules that cover it, plus the built-in floor for external sends, money and logins. */
  approvalBy: AnchorBoundary[];
  /** True when a human must approve before the result is used, whatever the trust level. */
  requiresApproval: boolean;
}

/**
 * Which boundaries cover an action. A rule covers it when its `appliesTo` names the action type (or a prefix such as
 * `reply`) or one of its sensitivities. External sends, money and logins always need approval, even with no rule saying so.
 */
export function checkBoundaries(anchor: Pick<Anchor, 'boundaries'>, actionType: string, sensitivity: readonly Sensitivity[] = []): BoundaryCheck {
  const covers = (b: AnchorBoundary): boolean =>
    !!b.appliesTo?.some((t) => t === actionType || actionType.startsWith(`${t}.`) || (sensitivity as readonly string[]).includes(t));
  const blockedBy = anchor.boundaries.filter((b) => b.kind === 'never' && covers(b));
  const approvalBy = anchor.boundaries.filter((b) => b.kind === 'require_approval' && covers(b));
  const floor = sensitivity.filter((s) => SENSITIVITIES.includes(s) && !approvalBy.some((b) => b.appliesTo?.includes(s)));
  for (const s of floor) approvalBy.push({ id: `builtin-${s}`, rule: `Always ask before anything ${s === 'external' ? 'external is sent' : s === 'money' ? 'involving money' : 'involving a login'}.`, kind: 'require_approval', appliesTo: [s] });
  return { blockedBy, approvalBy, requiresApproval: approvalBy.length > 0 };
}

// ---------- summary ----------

const PRIORITY_ORDER: Record<GoalPriority, number> = { high: 0, medium: 1, low: 2 };

/** A short, readable view of the Anchor for the terminal or a chat. */
export function formatAnchorSummary(anchor: Anchor): string[] {
  const lines: string[] = [];
  const goals = anchor.goals.filter((g) => g.active).sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  lines.push(goals.length ? `Goals (${goals.length} active):` : 'Goals: none yet (rufus anchor goal <title>).');
  for (const g of goals) lines.push(`  [${g.priority}] ${g.title} (${g.horizon})${g.notes ? ` - ${g.notes}` : ''}`);
  const live = anchor.projects.filter((p) => p.status !== 'done');
  if (live.length) {
    lines.push(`Projects (${live.length}):`);
    for (const p of live) lines.push(`  ${p.name} [${p.status}]${p.nextStep ? ` next: ${p.nextStep}` : ''}`);
  }
  if (anchor.boundaries.length) {
    lines.push('Boundaries:');
    for (const b of anchor.boundaries) lines.push(`  ${b.kind === 'never' ? 'never' : b.kind === 'protect_time' ? 'protect' : 'ask'}: ${b.rule}`);
  }
  const blocks = anchor.schedule.blocks;
  lines.push(blocks.length ? `Schedule ${anchor.schedule.date}:` : `Schedule ${anchor.schedule.date}: empty (rufus anchor block 09:00-10:30 focus <title>).`);
  for (const b of blocks) lines.push(`  ${b.start}-${b.end}  ${b.kind.padEnd(9)} ${b.title}${b.status !== 'planned' ? ` [${b.status}]` : ''}`);
  return lines;
}
