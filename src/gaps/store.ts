import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { realNextMove, servesGap, type WatchItem } from '../events/watches';
import type { LosslessEvent, ReceiptStatus } from '../types';

export type GapSource = 'owner' | 'observed';
export type GapStatus = 'proposed' | 'open' | 'waiting' | 'closed' | 'dropped';

/** One move that served a gap, written by code after the move (never by the model). */
export interface GapLogEntry {
  at: string;
  wakeId?: string;
  turn?: number;
  toolId: string;
  /** The input that says what the move was about (e.g. `action=start project=/x`). */
  key: string;
  /** The target the move acted on (messageId, threadId, path, ...), when it has one. */
  target?: string;
  /** Fingerprints of the whole input and of the result, so repeats are caught across wakes. */
  inputHash: string;
  resultHash: string;
  /** The input's substance (target fields left out), to tell a real change of input from a reworded one. */
  inputText: string;
  status: ReceiptStatus;
  /** The receipt's summary, or the error. */
  result: string;
  /** What the move said it expected, and whether the receipt showed it. */
  expect?: string;
  met?: boolean;
}

/** One criterion a verification checked, with the receipt it cites. */
export interface GapVerifyCriterion {
  element: string;
  criterion: string;
  observed: string;
  met: boolean;
  receipt?: { step: number; toolId: string; status: string; summary: string };
}

export interface GapVerifyRecord {
  /** The check's id (also in the gap's evidence), so closing can point at the exact passing check. */
  id?: string;
  at: string;
  passed: boolean;
  /** Delivered, but the outcome hinges on the owner's reaction and he has not reacted: the gap waits on him. */
  awaitingOwner?: boolean;
  criteria: GapVerifyCriterion[];
  remaining?: string;
}

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
  /** When the owner wants it true by (ISO), from the owner's own words. */
  due?: string;
  /** The last moves that served this gap (newest last), kept by code. */
  log?: GapLogEntry[];
  /** Facts the brains found for this gap, and what they made for it (newest last). */
  findings?: string[];
  /** The latest verification and the receipt each criterion cited. */
  lastVerify?: GapVerifyRecord;
  /** Quick returns in a row for this gap (a wake ended without its next move); drives backoff. */
  resumeAttempts?: number;
  /** A standing gap: one of the owner's lasting preferences or boundaries. It never closes (only the owner can drop it). */
  standing?: boolean;
  /** When a standing gap applies, in the owner's local time ("21:15-06:00" daily, "Fri 17:00-Sat 18:30" weekly). */
  window?: string;
  /** Senses whose latest events are this gap's reality ("screen", "message/assistant_sent"): the Desk shows them under it. */
  sensedBy?: string[];
  /** Root only: the owner's life areas, which the root checks its coverage against. */
  areas?: string[];
  /** Root only: when code last saw a move look at each area, and what it found. */
  coverage?: Record<string, { at: string; note: string }>;
  /** Moves in a row on this gap whose receipt missed what the move expected. */
  misses?: number;
  createdAt: string;
  updatedAt: string;
}

/** How many moves a gap's work log keeps. */
export const GAP_LOG_KEEP = 10;
const FINDINGS_KEEP = 12;

/** "due in 26h" / "overdue by 3h" — makes the owner's by-when visible on the Desk. */
export function dueIn(due: string, nowMs: number): string {
  const ms = Date.parse(due) - nowMs;
  if (Number.isNaN(ms)) return `due ${due}`;
  const span = (x: number) => {
    const mins = Math.round(Math.abs(x) / 60_000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.round(mins / 60);
    return hours < 72 ? `${hours}h` : `${Math.round(hours / 24)}d`;
  };
  return ms >= 0 ? `due in ${span(ms)}` : `OVERDUE by ${span(ms)}`;
}

/** A due time must be a real time; anything else is ignored rather than stored. */
export function parseDue(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const at = Date.parse(v.trim());
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

/** The root of the gap tree: finding the gaps that matter. Always present, never closes. */
export const ROOT_GAP_ID = 'gap_root';

function rootGap(ts: string): Gap {
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

/** "5m ago" / "3h ago" / "2d ago". */
function ago(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** "in 8h 47m" — makes a far-off next move (a gap sitting idle) visible on the Desk. */
function idleFor(ms: number): string {
  if (ms <= 0) return 'due now';
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h ${mins % 60}m, idle until then`;
}

/** How long a closed or dropped gap stays on the Desk, so the owner's reaction can reopen it. */
export const RECENTLY_CLOSED_MS = 24 * 60 * 60_000;

/** Closed (verified) or dropped (by the owner): no longer needs work or a next move. */
export function isDone(g: Pick<Gap, 'status'>): boolean {
  return g.status === 'closed' || g.status === 'dropped';
}

/**
 * Does this gap need a next move in motion before Rufus sleeps? Every unclosed gap does, root included, except a
 * standing gap with no window: it is a lasting preference that every deliverable is checked against, not work waiting.
 * A standing gap with a window needs one (the next time its window comes round is when the world changes).
 */
export function needsNextMove(g: Pick<Gap, 'status' | 'standing' | 'window'>): boolean {
  if (isDone(g)) return false;
  return !(g.standing && !g.window);
}

/** The owner's life area a loosely named area belongs to: the same words, or one inside the other, or a shared word. */
export function matchArea(areas: readonly string[], named: string): string | undefined {
  const n = named.trim().toLowerCase();
  if (!n) return undefined;
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  return (
    areas.find((a) => a.toLowerCase() === n) ??
    areas.find((a) => a.toLowerCase().includes(n) || n.includes(a.toLowerCase())) ??
    areas.find((a) => [...words(a)].some((w) => words(n).has(w)))
  );
}

/** A gap that only finds gaps: the root, or a standing gap. Gaps Rufus spots under it wait for the owner's yes. */
export function findsGaps(g: Pick<Gap, 'id' | 'standing'> | undefined): boolean {
  return !!g && (g.id === ROOT_GAP_ID || !!g.standing);
}

/** Only the owner's own words (the waking message, or one that arrived mid-wake) can make an `owner` gap. */
export function ownerSpoke(trigger: LosslessEvent | undefined, arrivals: readonly LosslessEvent[] = []): boolean {
  return trigger?.kind === 'owner_direct' || arrivals.some((a) => a.kind === 'owner_direct');
}

/** An explicit `observed` always wins; otherwise a gap raised while the owner is speaking is the owner's. */
export function resolveGapSource(requested: unknown, spoke: boolean): GapSource {
  if (requested === 'observed') return 'observed';
  return spoke ? 'owner' : 'observed';
}

/**
 * The gap tree (`gaps.json`).
 * - The root gap is always there (added on read if missing) and can never close.
 * - Top-level gaps hang off the root. Owner gaps start `open`; gaps Rufus spots start `proposed` until the owner says yes.
 * - Only a passing `brain.verify` closes a gap; `update(status: 'open')` reopens it.
 */
export class GapStore {
  readonly filePath: string;
  /** One writer at a time per file: background brains note on gaps while the wake moves. */
  private static readonly locks = new Map<string, Promise<unknown>>();

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, 'gaps.json');
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const prev = GapStore.locks.get(this.filePath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    GapStore.locks.set(this.filePath, next.catch(() => undefined));
    return next;
  }

  async list(): Promise<Gap[]> {
    let stored: Gap[] = [];
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Gap[];
      stored = Array.isArray(raw) ? raw : [];
    } catch {
      stored = [];
    }
    if (!stored.some((g) => g.id === ROOT_GAP_ID)) stored.unshift(rootGap(new Date().toISOString()));
    return stored;
  }

  private async save(gaps: Gap[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(gaps, null, 2)}\n`, 'utf8');
  }

  /** Writes the root gap to disk if it isn't there yet. */
  async ensureRoot(): Promise<Gap> {
    return this.locked(async () => {
      const gaps = await this.list();
      await this.save(gaps);
      return gaps.find((g) => g.id === ROOT_GAP_ID)!;
    });
  }

  async get(id: string): Promise<Gap | undefined> {
    return (await this.list()).find((g) => g.id === id);
  }

  /** Gaps that still need work (everything not closed or dropped, root and standing gaps included). */
  async unclosed(): Promise<Gap[]> {
    return (await this.list()).filter((g) => !isDone(g));
  }

  /** True when a parent id names a gap on the board (unknown parents are refused, never silently moved to the root). */
  async exists(id: string): Promise<boolean> {
    return (await this.list()).some((g) => g.id === id);
  }

  async create(opts: {
    title: string;
    target: string;
    reality: string;
    source: GapSource;
    parentId?: string;
    evidenceIds?: string[];
    due?: string;
    standing?: boolean;
    window?: string;
    sensedBy?: string[];
    now?: Date;
  }): Promise<Gap> {
    return this.locked(async () => {
      const gaps = await this.list();
      const ts = (opts.now ?? new Date()).toISOString();
      const parentId = opts.parentId && gaps.some((g) => g.id === opts.parentId) ? opts.parentId : ROOT_GAP_ID;
      // The same desired state named twice is one gap, not two.
      const same = gaps.find((g) => !isDone(g) && g.parentId === parentId && g.title.trim().toLowerCase() === opts.title.trim().toLowerCase());
      if (same) {
        // The owner stating a gap Rufus had only proposed is the owner's yes.
        const due = parseDue(opts.due);
        if ((same.status === 'proposed' && opts.source === 'owner') || (due && !same.due)) {
          if (same.status === 'proposed' && opts.source === 'owner') {
            same.status = 'open';
            same.source = 'owner';
          }
          if (due && !same.due) same.due = due;
          same.updatedAt = ts;
          await this.save(gaps);
        }
        return same;
      }
      // A sub-gap of a gap the owner approved serves that gap, so it opens without asking. A new gap Rufus spots
      // under the root or a standing gap is a new desired state: it waits for the owner's yes.
      const parent = gaps.find((g) => g.id === parentId);
      const underApprovedGap = !findsGaps(parent) && (parent?.status === 'open' || parent?.status === 'waiting');
      const status: GapStatus = opts.source === 'owner' || underApprovedGap ? 'open' : 'proposed';
      const sensedBy = (opts.sensedBy ?? []).map((s) => s.trim()).filter(Boolean);
      const gap: Gap = {
        id: `gap_${randomUUID().slice(0, 6)}`,
        parentId,
        title: opts.title.trim(),
        source: opts.source,
        status,
        target: opts.target.trim(),
        reality: (opts.reality || 'Not measured yet.').trim(),
        evidenceIds: [...(opts.evidenceIds ?? [])],
        ...(parseDue(opts.due) ? { due: parseDue(opts.due)! } : {}),
        ...(opts.standing ? { standing: true } : {}),
        ...(opts.standing && opts.window?.trim() ? { window: opts.window.trim() } : {}),
        ...(sensedBy.length ? { sensedBy } : {}),
        createdAt: ts,
        updatedAt: ts,
      };
      gaps.push(gap);
      await this.save(gaps);
      return gap;
    });
  }

  async approve(id: string, now = new Date()): Promise<Gap | undefined> {
    return this.locked(async () => {
      const gaps = await this.list();
      const g = gaps.find((x) => x.id === id);
      if (!g) return undefined;
      if (g.id !== ROOT_GAP_ID) g.status = 'open';
      g.updatedAt = now.toISOString();
      await this.save(gaps);
      return g;
    });
  }

  async update(
    id: string,
    patch: {
      reality?: string;
      target?: string;
      status?: Exclude<GapStatus, 'closed'>;
      waitingOn?: string | null;
      addEvidence?: string[];
      due?: string | null;
      /** Root only: the owner's life areas. */
      areas?: string[];
      window?: string | null;
      sensedBy?: string[];
    },
    now = new Date(),
  ): Promise<Gap | undefined> {
    return this.locked(async () => {
      const gaps = await this.list();
      const g = gaps.find((x) => x.id === id);
      if (!g) return undefined;
      const isRoot = g.id === ROOT_GAP_ID;
      if (patch.reality !== undefined) g.reality = patch.reality.trim();
      // The root's target and status are fixed; its reality and the owner's life areas are recorded.
      if (patch.target !== undefined && !isRoot) g.target = patch.target.trim();
      if (patch.status !== undefined && !isRoot) g.status = patch.status;
      if (isRoot && patch.areas) g.areas = [...new Set(patch.areas.map((a) => a.trim()).filter(Boolean))];
      if (!isRoot) {
        if (patch.waitingOn === null) delete g.waitingOn;
        else if (patch.waitingOn !== undefined) g.waitingOn = patch.waitingOn.trim();
        if (patch.due === null) delete g.due;
        else if (parseDue(patch.due)) g.due = parseDue(patch.due)!;
        if (g.standing && patch.window === null) delete g.window;
        else if (g.standing && patch.window?.trim()) g.window = patch.window.trim();
        if (patch.sensedBy) g.sensedBy = patch.sensedBy.map((s) => s.trim()).filter(Boolean);
      }
      if (patch.addEvidence?.length) {
        g.evidenceIds = [...new Set([...g.evidenceIds, ...patch.addEvidence])];
      }
      g.updatedAt = now.toISOString();
      await this.save(gaps);
      return g;
    });
  }

  /** Closes a gap after a passing `brain.verify`. The root and standing gaps never close (their reality is updated instead). */
  async closeVerified(id: string, verifiedReality: string, evidenceId?: string, now = new Date()): Promise<Gap | undefined> {
    return this.locked(async () => {
      const gaps = await this.list();
      const g = gaps.find((x) => x.id === id);
      if (!g) return undefined;
      if (g.id !== ROOT_GAP_ID && !g.standing) {
        g.status = 'closed';
        delete g.waitingOn;
        // Sub-gaps created to serve a gap that is now verified closed are satisfied with it, so they never strand sleep.
        const closedIds = new Set<string>([g.id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const child of gaps) {
            if (child.id === ROOT_GAP_ID || child.standing || isDone(child)) continue;
            if (child.parentId && closedIds.has(child.parentId)) {
              child.status = 'closed';
              delete child.waitingOn;
              child.reality = `Closed with parent ${g.id}: ${verifiedReality.trim()}`;
              if (evidenceId) child.evidenceIds = [...new Set([...child.evidenceIds, evidenceId])];
              child.updatedAt = now.toISOString();
              closedIds.add(child.id);
              grew = true;
            }
          }
        }
      }
      g.reality = verifiedReality.trim();
      if (evidenceId) g.evidenceIds = [...new Set([...g.evidenceIds, evidenceId])];
      g.updatedAt = now.toISOString();
      await this.save(gaps);
      return g;
    });
  }

  /** Appends one move to the gap's work log, keeping the last GAP_LOG_KEEP. Does not touch updatedAt (a move is not new reality). */
  async appendLog(id: string, entry: GapLogEntry): Promise<void> {
    return this.locked(async () => {
      const gaps = await this.list();
      const g = gaps.find((x) => x.id === id);
      if (!g) return;
      g.log = [...(g.log ?? []), entry].slice(-GAP_LOG_KEEP);
      await this.save(gaps);
    });
  }

  /** What the brains found or made for a gap, its latest verification, its quick-return and missed-expectation counts, and the root's coverage. */
  async annotate(
    id: string,
    patch: { addFindings?: string[]; lastVerify?: GapVerifyRecord; addEvidence?: string[]; resumeAttempts?: number | null; misses?: number | null; coverage?: { area: string; note: string; at: string } },
  ): Promise<Gap | undefined> {
    return this.locked(async () => {
      const gaps = await this.list();
      const g = gaps.find((x) => x.id === id);
      if (!g) return undefined;
      const fresh = (patch.addFindings ?? []).map((f) => f.trim()).filter(Boolean);
      if (fresh.length) g.findings = [...(g.findings ?? []).filter((f) => !fresh.includes(f)), ...fresh].slice(-FINDINGS_KEEP);
      if (patch.lastVerify) g.lastVerify = patch.lastVerify;
      if (patch.addEvidence?.length) g.evidenceIds = [...new Set([...g.evidenceIds, ...patch.addEvidence])];
      if (patch.resumeAttempts === null) delete g.resumeAttempts;
      else if (patch.resumeAttempts !== undefined) g.resumeAttempts = patch.resumeAttempts;
      if (patch.misses === null) delete g.misses;
      else if (patch.misses !== undefined) g.misses = patch.misses;
      if (patch.coverage && g.id === ROOT_GAP_ID) {
        // An area named loosely ("health") counts for the owner's area it belongs to ("health and rest").
        const area = matchArea(g.areas ?? [], patch.coverage.area) ?? patch.coverage.area.trim();
        g.coverage = { ...(g.coverage ?? {}), [area]: { at: patch.coverage.at, note: patch.coverage.note.replace(/\s+/g, ' ').slice(0, 200) } };
      }
      await this.save(gaps);
      return g;
    });
  }

  /**
   * Renders the gap tree for the top of The Desk: root first, every gap with its target, reality and
   * next move in motion (its own watches), plus recently closed gaps so the owner's reaction can reopen them.
   */
  async formatForDesk(
    opts: {
      watches?: readonly WatchItem[];
      now?: Date;
      formatTime?: (iso: string) => string;
      /** What the senses show for a gap with sensedBy (its reality, straight from the senses). */
      sensed?: (g: Gap) => string | undefined;
      /** Whether a standing gap's window applies now, and when it next does. */
      windowState?: (g: Gap) => string | undefined;
    } = {},
  ): Promise<string> {
    const gaps = await this.list();
    const now = (opts.now ?? new Date()).getTime();
    const fmt = opts.formatTime ?? ((iso: string) => iso);
    const watches = opts.watches ?? [];
    const visible = (g: Gap) => !isDone(g) || now - Date.parse(g.updatedAt) <= RECENTLY_CLOSED_MS;
    const shown = new Set<string>();
    const lines: string[] = [];

    const render = (g: Gap, depth: number) => {
      shown.add(g.id);
      const pad = '  '.repeat(depth);
      const age = isDone(g) ? ` ${Math.max(1, Math.round((now - Date.parse(g.updatedAt)) / 60_000))}m ago` : '';
      const due = g.due && !isDone(g) ? ` | ${dueIn(g.due, now)} (${fmt(g.due)})` : '';
      const kind = g.standing ? ' | STANDING, never closes' : '';
      lines.push(`${pad}- [${g.id} | ${g.status}${age} | ${g.source}${kind}${due}] ${g.title}${g.waitingOn ? ` | waitingOn: ${g.waitingOn}` : ''}`);
      lines.push(`${pad}  Target:  ${g.target}`);
      if (g.window) lines.push(`${pad}  Applies: ${g.window} (owner's local time)${opts.windowState?.(g) ? `; ${opts.windowState(g)}` : ''}`);
      lines.push(`${pad}  Reality: ${g.reality}`);
      const sensed = g.sensedBy?.length && !isDone(g) ? opts.sensed?.(g) : undefined;
      if (sensed) lines.push(`${pad}  Senses now (${g.sensedBy!.join(', ')}): ${sensed}`);
      if (g.id === ROOT_GAP_ID && g.areas?.length) {
        // The root checks its coverage of the owner's life areas: the stalest area gets the next look.
        const cov = g.areas
          .map((a) => ({ a, c: g.coverage?.[a] }))
          .sort((x, y) => (x.c ? Date.parse(x.c.at) : 0) - (y.c ? Date.parse(y.c.at) : 0))
          .map(({ a, c }) => (c ? `${a}: ${ago(now - Date.parse(c.at))} (${c.note.slice(0, 90)})` : `${a}: never looked`));
        lines.push(`${pad}  Coverage of the owner's life areas (stalest first; name the "area" on a root move to record a look): ${cov.join('; ')}`);
      }
      if (g.misses && !isDone(g)) lines.push(`${pad}  Missed expectations: the last ${g.misses} move(s) here did not get what they expected${g.misses >= 2 ? ': change approach (investigate, plan, or ask) instead of another try of the same kind' : ''}.`);
      if (g.findings?.length && !isDone(g)) lines.push(`${pad}  Found so far: ${g.findings.slice(-5).map((f) => f.slice(0, 220)).join(' | ')}`);
      if (g.lastVerify) {
        const v = g.lastVerify;
        const unmet = v.criteria.filter((c) => !c.met).map((c) => c.criterion.slice(0, 100));
        lines.push(`${pad}  Last verify (${fmt(v.at)}): ${v.passed ? 'PASS' : v.awaitingOwner ? 'AWAITING OWNER' : 'FAIL'}${unmet.length ? `; not met: ${unmet.join('; ')}` : v.remaining && !v.passed ? `; ${v.remaining.slice(0, 160)}` : ''}`);
      }
      if (!isDone(g)) {
        const moves = watches.filter((w) => servesGap(w, g.id));
        const move = (w: WatchItem) => {
          const when = w.kind === 't3_thread' ? `when thread ${w.threadId} finishes` : w.kind === 'brain_job' ? `when background job ${w.threadId} finishes` : `at ${w.fireAt ? `${fmt(w.fireAt)} (${idleFor(Date.parse(w.fireAt) - now)})` : '?'}`;
          const real = realNextMove(w);
          const waits = w.waitsOn ? ` [waits on ${w.waitsOn}${w.waitsFor ? `: ${w.waitsFor}` : ''}${w.expect ? `; expects: ${w.expect}` : ''}]` : '';
          return `${w.id} ${when}${waits} — ${w.label}${real.ok ? '' : ` (NOT a real next move: ${real.why})`}`;
        };
        // Labels often contain ";" themselves, so several moves go one per line rather than joined.
        if (moves.length > 1) lines.push(`${pad}  Next moves (${moves.length}):`, ...moves.map((w) => `${pad}    - ${move(w)}`));
        else if (moves.length) lines.push(`${pad}  Next move: ${move(moves[0]!)}`);
        else if (!needsNextMove(g)) lines.push(`${pad}  Next move: none needed (a standing preference: every deliverable and message is checked against it)`);
        else lines.push(`${pad}  Next move: NONE — make a move now, or schedule one (watch.set) before you sleep`);
      }
      // The work log is code's record of what was already tried, so a repeat or a dead end is visible without remembering it.
      const log = (g.log ?? []).slice(isDone(g) ? -3 : -GAP_LOG_KEEP);
      if (log.length) {
        lines.push(`${pad}  Work log (last ${log.length}, oldest first):`);
        for (const e of log) lines.push(`${pad}    - ${fmt(e.at)} ${e.toolId}${e.key ? ` ${e.key}` : ''} -> ${e.status}: ${e.result.slice(0, 200)}${e.expect ? ` | expected: ${e.expect.slice(0, 120)}${e.met === false ? ' (MISSED)' : ''}` : ''}`);
      }
      for (const child of standingFirst(byDue(gaps.filter((c) => c.parentId === g.id && !shown.has(c.id) && visible(c))))) render(child, depth + 1);
    };

    // Unclosed gaps with the nearest due time first, then undated ones, then recently closed ones; otherwise in saved order.
    const byDue = (list: Gap[]) =>
      list
        .map((g, i) => ({ g, i }))
        .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
        .map((x) => x.g);
    const rank = (g: Gap) => (isDone(g) ? Number.MAX_SAFE_INTEGER : g.due ? Date.parse(g.due) : Number.MAX_SAFE_INTEGER - 1);

    const root = gaps.find((g) => g.id === ROOT_GAP_ID)!;
    // The owner's standing gaps sit at the top, right under the root: every move is read against them.
    const standingFirst = (list: Gap[]) => [...list.filter((g) => g.standing), ...list.filter((g) => !g.standing)];
    render(root, 0);
    // Top-level gaps saved before the root existed, and gaps whose parent is no longer shown, hang off the root.
    const parentShown = (g: Gap) => !!g.parentId && gaps.some((p) => p.id === g.parentId && visible(p));
    for (const g of byDue(gaps.filter((x) => !shown.has(x.id) && visible(x) && !parentShown(x)))) if (!shown.has(g.id)) render(g, 1);
    for (const g of gaps) if (!shown.has(g.id) && visible(g)) render(g, 1);
    return lines.join('\n');
  }
}
