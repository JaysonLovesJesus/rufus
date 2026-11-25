import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  findScheduleConflicts,
  loadAnchor,
  localDate,
  parseProtectWindows,
  saveAnchor,
  ScheduleOverlapError,
  toMinutes,
  upsertScheduleBlock,
  type Anchor,
  type BlockKind,
  type DaySchedule,
  type ScheduleBlock,
} from '../anchor/anchor';
import { FileStore } from '../store';
import type { AiProvider } from '../types';
import { clock12, speakableTitle } from './heartbeat';

/**
 * v17, the Proactive Day Planner. Looks at today's real schedule (calendar events included), the open gaps left in it,
 * active goals and projects, and the hard boundaries (Sabbath, lights-out, protected blocks), then proposes a realistic
 * plan for the open time: focus blocks, short breaks and an optional curated scroll slot. Never an overlap.
 *
 * It only PROPOSES. Nothing is written to `anchor.json` until the human says yes: the proposal waits in
 * `<workspace>/day-plan.json`, and `commitPendingPlan` (a "yes" in chat, or `anchor.update {op:"apply_plan"}`) writes it.
 */

export const DAY_PLAN_FILE = 'day-plan.json';
export const PLAN_SOURCE = 'rufus';
/** A proposal older than this is stale: a "yes" no longer applies it. */
export const PLAN_TTL_MS = 3 * 3_600_000;

export type PlanKind = Extract<BlockKind, 'focus' | 'break' | 'scroll'>;
const PLAN_KINDS: readonly PlanKind[] = ['focus', 'break', 'scroll'];

export interface PlannedBlock {
  start: string;
  end: string;
  title: string;
  kind: PlanKind;
}

export interface Gap {
  start: string;
  end: string;
  minutes: number;
}

export interface DayPlan {
  date: string;
  /** The open time the plan fills. */
  gaps: Gap[];
  /** The proposed blocks: never overlapping each other, the day's blocks, or protected time. */
  blocks: PlannedBlock[];
  /** A short, human message proposing it (ends with a question). */
  summary: string;
  /** Who laid the blocks out. */
  via: 'ai' | 'code';
}

export interface PlannerOptions {
  /** Planning never starts before this (`HH:MM`). Default `08:00`. */
  dayStart?: string;
  /** Lights-out for planning purposes (`HH:MM`). Default `21:00`. A protect_time boundary may end the day earlier. */
  dayEnd?: string;
  /** Shortest gap worth planning, in minutes. Default 30. */
  minGapMinutes?: number;
  /** Longest single focus block, in minutes. Default 90. */
  maxFocusMinutes?: number;
  /** Break length, in minutes. Default 15. */
  breakMinutes?: number;
  /** Offer one curated scroll slot (the break digest) in place of a break. Default true. */
  scroll?: boolean;
}

const p2 = (n: number): string => String(n).padStart(2, '0');
const fromMinutes = (m: number): string => (m >= 1440 ? '24:00' : `${p2(Math.floor(m / 60))}:${p2(m % 60)}`);
const nowMinutes = (d: Date): number => d.getHours() * 60 + d.getMinutes();
const WEEK_MIN = 7 * 1440;

/** Today's protect_time boundary windows (Sabbath, lights-out, ...) as `[start, end)` minutes of the day. */
export function protectedRangesToday(anchor: Pick<Anchor, 'boundaries'>, now: Date): Array<[number, number]> {
  const lo = now.getDay() * 1440;
  const hi = lo + 1440;
  const out: Array<[number, number]> = [];
  for (const b of anchor.boundaries) {
    if (b.kind !== 'protect_time') continue;
    for (const [a, z] of parseProtectWindows(b.when ?? b.rule)) {
      for (const shift of [0, -WEEK_MIN, WEEK_MIN]) {
        const s = Math.max(a + shift, lo);
        const e = Math.min(z + shift, hi);
        if (s < e) out.push([s - lo, e - lo]);
      }
    }
  }
  return out;
}

/** Today's blocks (none when the Anchor's schedule is for another day). */
const todaysBlocks = (anchor: Anchor, now: Date): ScheduleBlock[] => (anchor.schedule.date === localDate(now) ? anchor.schedule.blocks.filter((b) => b.status !== 'skipped') : []);

/**
 * The open gaps left today: from now (rounded up to the next quarter hour) to the end of the day, minus every block
 * already on the schedule and every protected window. Gaps shorter than `minGapMinutes` are left out.
 */
export function openGaps(anchor: Anchor, now: Date, opts: PlannerOptions = {}): Gap[] {
  const from = Math.max(Math.ceil(nowMinutes(now) / 15) * 15, toMinutes(opts.dayStart ?? '08:00'));
  const to = toMinutes(opts.dayEnd ?? '21:00');
  const min = Math.max(5, opts.minGapMinutes ?? 30);
  const busy: Array<[number, number]> = [...todaysBlocks(anchor, now).map((b): [number, number] => [toMinutes(b.start), toMinutes(b.end)]), ...protectedRangesToday(anchor, now)].sort((a, b) => a[0] - b[0]);
  const gaps: Gap[] = [];
  let cursor = from;
  for (const [s, e] of busy) {
    if (s > cursor && Math.min(s, to) - cursor >= min) gaps.push({ start: fromMinutes(cursor), end: fromMinutes(Math.min(s, to)), minutes: Math.min(s, to) - cursor });
    cursor = Math.max(cursor, e);
    if (cursor >= to) break;
  }
  if (to - cursor >= min) gaps.push({ start: fromMinutes(cursor), end: fromMinutes(to), minutes: to - cursor });
  return gaps;
}

const PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 };
const HORIZON: Record<string, number> = { today: 0, week: 1, month: 2 };

/** What focus time should go to, most important first: active goals (priority, then horizon), then active projects. */
export function focusCandidates(anchor: Anchor): string[] {
  const goals = anchor.goals
    .filter((g) => g.active)
    .sort((a, b) => (PRIORITY[a.priority] ?? 3) - (PRIORITY[b.priority] ?? 3) || (HORIZON[a.horizon] ?? 3) - (HORIZON[b.horizon] ?? 3))
    .map((g) => g.title);
  const projects = anchor.projects.filter((p) => p.status === 'active').map((p) => (p.nextStep ? `${p.name}: ${p.nextStep}` : p.name));
  const seen = new Set<string>();
  return [...goals, ...projects].filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The plain-code plan: fill each gap with focus blocks separated by short breaks (one of them a curated scroll slot). */
export function codePlan(gaps: Gap[], candidates: string[], opts: PlannerOptions = {}): PlannedBlock[] {
  const maxFocus = Math.max(30, opts.maxFocusMinutes ?? 90);
  const brk = Math.max(5, opts.breakMinutes ?? 15);
  const minFocus = 30;
  const topics = candidates.length ? candidates : ['Deep work'];
  const out: PlannedBlock[] = [];
  let k = 0;
  let breaks = 0;
  let scrolled = opts.scroll === false;
  for (const gap of gaps) {
    let cursor = toMinutes(gap.start);
    const end = toMinutes(gap.end);
    const total = end - cursor;
    if (total < minFocus) continue;
    // As few focus blocks as fit under the cap, split evenly, with a short break between each.
    let n = Math.max(1, Math.ceil((total + brk) / (maxFocus + brk)));
    while (n > 1 && (total - (n - 1) * brk) / n < minFocus) n--;
    const len = Math.floor((total - (n - 1) * brk) / n / 5) * 5;
    for (let i = 0; i < n; i++) {
      const stop = i === n - 1 ? end : cursor + len;
      out.push({ start: fromMinutes(cursor), end: fromMinutes(stop), title: topics[k++ % topics.length]!, kind: 'focus' });
      cursor = stop;
      if (i === n - 1) break;
      const scroll = !scrolled && breaks >= 1;
      out.push({ start: fromMinutes(cursor), end: fromMinutes(cursor + brk), title: scroll ? 'Curated scroll' : 'Break', kind: scroll ? 'scroll' : 'break' });
      if (scroll) scrolled = true;
      breaks++;
      cursor += brk;
    }
  }
  return out;
}

/** Keeps only blocks that are well-formed, inside an open gap, and overlap nothing (the day's blocks or each other). */
export function validatePlan(day: DaySchedule, gaps: Gap[], blocks: unknown[]): { valid: PlannedBlock[]; rejected: number } {
  const valid: PlannedBlock[] = [];
  let rejected = 0;
  for (const raw of blocks) {
    const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const kind = (PLAN_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as PlanKind) : undefined;
    let s: number;
    let e: number;
    try {
      s = toMinutes(String(r.start));
      e = toMinutes(String(r.end));
    } catch {
      rejected++;
      continue;
    }
    const block = { start: fromMinutes(s), end: fromMinutes(e), title, kind };
    const inGap = gaps.some((g) => toMinutes(g.start) <= s && e <= toMinutes(g.end));
    const clash = findScheduleConflicts({ date: day.date, blocks: [...day.blocks, ...valid.map((v, i) => ({ ...v, id: `plan-${i}`, status: 'planned' as const }))] }, block).length > 0;
    if (!title || !kind || e <= s || !inGap || clash) {
      rejected++;
      continue;
    }
    valid.push({ ...block, title: title.slice(0, 120), kind });
  }
  return { valid, rejected };
}

/** `14:00`-`15:30` -> `2–3:30pm`; `11:00`-`13:00` -> `11am–1pm`. */
export function range12(start: string, end: string): string {
  const a = clock12(start);
  const b = clock12(end === '24:00' ? '00:00' : end);
  const sameHalf = a.slice(-2) === b.slice(-2);
  return sameHalf ? `${a.slice(0, -2)}–${b}` : `${a}–${b}`;
}

const listJoin = (parts: string[]): string => (parts.length <= 1 ? (parts[0] ?? '') : parts.length === 2 ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`);

/** "You've got open time from 2 to 5pm — want me to block 2–3:30pm for X, a 15m break, and 3:45–5pm for Y?" */
export function formatPlanSummary(gaps: Gap[], blocks: PlannedBlock[]): string {
  if (!blocks.length) return gaps.length ? "There's a bit of open time left today, but not enough to plan around. I'd leave it loose." : "Your day's already full — nothing open left to plan.";
  const open = listJoin(gaps.map((g) => `from ${clock12(g.start).replace(/(am|pm)$/, (m) => (clock12(g.end).endsWith(m) ? '' : m))} to ${clock12(g.end === '24:00' ? '00:00' : g.end)}`));
  const parts = blocks.map((b) => {
    const mins = toMinutes(b.end) - toMinutes(b.start);
    if (b.kind === 'break') return `a ${mins}m break`;
    if (b.kind === 'scroll') return `a ${mins}m curated scroll`;
    return `${range12(b.start, b.end)} for ${speakableTitle(b.title, 40)}`;
  });
  return `You've got open time ${open} — want me to block ${listJoin(parts)}?`;
}

function planPrompt(anchor: Anchor, now: Date, gaps: Gap[], candidates: string[], soul?: string): string {
  const today = todaysBlocks(anchor, now);
  return [
    `It is ${clock12(`${p2(now.getHours())}:${p2(now.getMinutes())}`)} on ${localDate(now)}. Plan the rest of the human's day.`,
    `Already on the schedule (do not touch, do not overlap): ${today.length ? today.map((b) => `${b.start}-${b.end} ${b.title}`).join('; ') : 'nothing'}.`,
    `Open gaps you may fill (HH:MM, 24h): ${gaps.map((g) => `${g.start}-${g.end}`).join('; ')}.`,
    `What matters most, in order: ${candidates.length ? candidates.join('; ') : 'nothing named yet (use "Deep work")'}.`,
    ...(soul ? [`About them (SOUL.md, abridged): ${soul.slice(0, 600)}`] : []),
    'Rules: blocks only inside the open gaps; zero overlaps; focus blocks of 30-90 minutes; a 10-15 minute break between focus blocks; at most one 15 minute "scroll" slot (a curated break digest); leave some slack, be realistic.',
    'Then write ONE short, casual text proposing it, like a friend who keeps their calendar: 12-hour times (2pm, 3:30pm), ending with a question. No tags, no lists.',
    'Reply with JSON only: {"blocks":[{"start":"HH:MM","end":"HH:MM","title":"...","kind":"focus|break|scroll"}],"summary":"..."}',
  ].join('\n');
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const t = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const a = t.indexOf('{');
  const z = t.lastIndexOf('}');
  if (a < 0 || z <= a) return undefined;
  try {
    const v: unknown = JSON.parse(t.slice(a, z + 1));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A model-written summary, if it reads like a short text: one line, a question, no 24-hour clock, no tags. */
function acceptSummary(v: unknown): string | undefined {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > 320 || t.includes('\n') || !t.includes('?')) return undefined;
  if (/\b([01]\d|2[0-3]):[0-5]\d\b(?!\s*[ap]m)/i.test(t) || /\((focus|break|scroll|meeting)\)/i.test(t)) return undefined;
  return t;
}

/**
 * Proposes a plan for today's open time. Pure apart from the optional model call: it never writes anything.
 * With `ai`, one call lays out the blocks; every block is checked in code (inside a gap, zero overlaps) and the plain
 * code plan is used whenever the model fails or proposes anything that doesn't fit.
 */
export async function proposeDayPlan(input: { anchor: Anchor; now: Date; ai?: AiProvider; soul?: string; options?: PlannerOptions }): Promise<DayPlan> {
  const { anchor, now } = input;
  const opts = input.options ?? {};
  const date = localDate(now);
  const gaps = openGaps(anchor, now, opts);
  const candidates = focusCandidates(anchor);
  const day: DaySchedule = { date, blocks: todaysBlocks(anchor, now) };
  if (gaps.length && input.ai) {
    try {
      const raw = await input.ai.complete({
        system: 'You are Rufus, a calm, realistic chief of staff who plans days people can actually keep.',
        messages: [{ role: 'user', content: planPrompt(anchor, now, gaps, candidates, input.soul) }],
        json: true,
        meta: { runId: 'planner', flowId: 'planner', step: 'plan', attempt: 1 },
      });
      const parsed = parseJsonObject(raw);
      const proposed = Array.isArray(parsed?.blocks) ? (parsed!.blocks as unknown[]) : [];
      const { valid, rejected } = validatePlan(day, gaps, proposed);
      const scrolls = valid.filter((b) => b.kind === 'scroll').length;
      if (valid.length && !rejected && scrolls <= 1 && valid.some((b) => b.kind === 'focus')) {
        const blocks = valid.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
        return { date, gaps, blocks, summary: acceptSummary(parsed?.summary) ?? formatPlanSummary(gaps, blocks), via: 'ai' };
      }
    } catch {
      /* fall back to the code plan */
    }
  }
  const blocks = validatePlan(day, gaps, codePlan(gaps, candidates, opts)).valid;
  return { date, gaps, blocks, summary: formatPlanSummary(gaps, blocks), via: 'code' };
}

// ---------- the pending proposal: written only on a yes ----------

export interface PendingPlan {
  date: string;
  proposedAt: string;
  blocks: PlannedBlock[];
  summary: string;
}

export const dayPlanFile = (dir: string): string => path.join(dir, DAY_PLAN_FILE);

export async function savePendingPlan(dir: string, plan: DayPlan, now: Date): Promise<PendingPlan> {
  const pending: PendingPlan = { date: plan.date, proposedAt: now.toISOString(), blocks: plan.blocks, summary: plan.summary };
  await new FileStore(dir).writeJson(dayPlanFile(dir), pending);
  return pending;
}

/** The proposal still waiting for a yes: same day, fresh, with blocks. Otherwise undefined. */
export async function loadPendingPlan(dir: string, now: Date, ttlMs = PLAN_TTL_MS): Promise<PendingPlan | undefined> {
  const p = await new FileStore(dir).readJson<Partial<PendingPlan> | null>(dayPlanFile(dir), null).catch(() => null);
  if (!p || p.date !== localDate(now) || !Array.isArray(p.blocks) || !p.blocks.length || typeof p.proposedAt !== 'string') return undefined;
  const age = now.getTime() - Date.parse(p.proposedAt);
  if (!(age >= 0 && age <= ttlMs)) return undefined;
  return p as PendingPlan;
}

export async function clearPendingPlan(dir: string): Promise<void> {
  await fs.rm(dayPlanFile(dir), { force: true });
}

/** Writes approved blocks to today's schedule (`source: "rufus"`). Pure. A block that now overlaps something is skipped. */
export function applyDayPlan(anchor: Anchor, blocks: PlannedBlock[], now: Date): { anchor: Anchor; added: ScheduleBlock[]; skipped: PlannedBlock[] } {
  let next = anchor;
  const added: ScheduleBlock[] = [];
  const skipped: PlannedBlock[] = [];
  for (const b of blocks) {
    try {
      const r = upsertScheduleBlock(next, { start: b.start, end: b.end, title: b.title, kind: b.kind, source: PLAN_SOURCE }, { date: localDate(now) });
      next = r.anchor;
      added.push(r.block);
    } catch (err) {
      if (err instanceof ScheduleOverlapError) skipped.push(b);
      else throw err;
    }
  }
  return { anchor: next, added, skipped };
}

/** The human said yes: writes the pending plan to `anchor.json` and clears it. Returns a short confirmation. */
export async function commitPendingPlan(dir: string, now: Date): Promise<{ text: string; added: ScheduleBlock[]; skipped: PlannedBlock[] } | undefined> {
  const pending = await loadPendingPlan(dir, now);
  if (!pending) return undefined;
  const anchor = await loadAnchor(dir, now);
  const r = applyDayPlan(anchor, pending.blocks, now);
  if (r.added.length) await saveAnchor(dir, r.anchor, now);
  await clearPendingPlan(dir);
  const focus = r.added.filter((b) => b.kind === 'focus');
  const text = !r.added.length
    ? "That time's filled up since I asked, so I left the schedule as it is."
    : `Done — it's on the schedule${focus.length ? `: ${listJoin(focus.map((b) => `${range12(b.start, b.end)} ${speakableTitle(b.title, 40)}`))}` : ''}.${r.skipped.length ? ` Skipped ${r.skipped.length} that no longer fit.` : ''}`;
  return { text, added: r.added, skipped: r.skipped };
}

/** "yes", "sure", "do it", "plan yes", "sounds good" ... */
export const PLAN_APPROVE = /^(?:plan\s+)?(?:yes|y|yep|yeah|yup|sure|ok|okay|do it|sounds good|go ahead|block it|lock it in|perfect|yes please|please do)[.!\s]*$/i;
/** "no", "nah", "not now", "plan no" ... */
export const PLAN_DECLINE = /^(?:plan\s+)?(?:no|n|nah|nope|not now|no thanks|skip it|leave it|pass)[.!\s]*$/i;
/** "plan my day", "schedule the rest of today", "can you plan my afternoon?" */
export const PLAN_REQUEST = /^(?:hey\s+)?(?:can you\s+|could you\s+|please\s+|pls\s+)?(?:plan|schedule|map out|block out)\s+(?:out\s+)?(?:my day|my today|today|the day|the rest of (?:my |the )?day|the rest of today|the rest of my day|my afternoon|the afternoon|my evening|the evening)\b[\s\S]{0,20}$/i;
