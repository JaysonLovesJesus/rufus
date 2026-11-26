import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LoopRun } from '../engine/loop';
import { FileStore } from '../store';
import type { SelfReviewState } from './review';
import type { ThinkState } from './think';

/** What `rufus start` remembers between passes (`<workspace>/start-state.json`). */
export interface StartState {
  version: 1;
  /** Short numbers (#1, #2, ...) for loop runs waiting on you, by run id. Freed once a run is decided. */
  numbers: Record<string, number>;
  /** Run ids already texted to you. */
  delivered: string[];
  /** The run texted most recently on its own, so a plain typed reply can edit it. */
  lastItem?: string;
  /** When the last check-in went out. */
  lastCheckinAt?: string;
  /** Only messages after this are read. Set on the first pass, so old chat is never replayed as answers. */
  since?: string;
  /** Incoming message ids already handled. */
  handled: string[];
  /** Hashes of what Rufus sent, so an echoed message never answers itself. */
  sent: string[];
  /** Schedule blocks already given a heads-up (`<date>:<blockId>@<start>`). */
  nudged?: string[];
  /** The local date (`YYYY-MM-DD`) of the last good-morning brief. */
  lastMorningBrief?: string;
  /** v15: when each delivered run last reached the human. A Verify item expires `pendingTtlMs` after this. */
  deliveredAt?: Record<string, string>;
  /** v15: the proactive think-beat. */
  think?: ThinkState;
  /** v15: when the human last said or reacted anything. */
  lastHumanAt?: string;
  /** v17: when the calendar was last mirrored into the Anchor. */
  lastCalendarSyncAt?: string;
  /** v17: calendar conflicts already mentioned (so each is said once). */
  calendarConflicts?: string[];
  /** v17: the local date the day planner last proposed a plan on its own. */
  lastPlanOffer?: string;
  /** v17: scroll/break blocks that already got their digest (`<date>:<blockId>`). */
  digested?: string[];
  /** v18: the daily self-review. */
  selfReview?: SelfReviewState;
  /** v24b: the evening memory curation ("dreaming"): the local date it last ran. */
  memoryDream?: { lastDate?: string };
  /** v21: the last action Rufus took on its own at `auto_notify`, so a bare "undo" / "demote" knows what it means. */
  lastAutoNotified?: { runId: string; actionType: string; at: string };
  /** v26: when Rufus last sent his startup "I'm up" check-in (prevents crash-loop spam). */
  lastStartupAt?: string;
}

export const START_STATE_FILE = 'start-state.json';
/** `rufus now` (or anything else) drops this file to ask the daemon for a check-in on its next pass. */
export const CHECKIN_REQUEST_FILE = 'checkin.request';

export const freshStartState = (): StartState => ({ version: 1, numbers: {}, delivered: [], handled: [], sent: [] });

export async function loadStartState(dir: string): Promise<StartState> {
  const raw = await new FileStore(dir).readJson<Partial<StartState>>(path.join(dir, START_STATE_FILE), {});
  const fresh = freshStartState();
  return {
    ...fresh,
    ...raw,
    numbers: { ...(raw.numbers ?? {}) },
    delivered: [...(raw.delivered ?? [])],
    handled: [...(raw.handled ?? [])],
    sent: [...(raw.sent ?? [])],
    version: 1,
  };
}

export async function saveStartState(dir: string, state: StartState): Promise<void> {
  await new FileStore(dir).writeJson(path.join(dir, START_STATE_FILE), state);
}

/**
 * Gives every pending run a short number, keeping the ones already given and reusing the smallest free number.
 * Deterministic for the same pending list, so the CLI and the daemon agree. Runs no longer pending lose theirs.
 */
export function assignNumbers(state: StartState, pending: readonly (Pick<LoopRun, 'id'> & Partial<Pick<LoopRun, 'createdAt' | 'signal'>>)[]): Record<string, number> {
  const open = new Set(pending.map((r) => r.id));
  // Oldest message first (runs made in one pass share a createdAt), then creation, then id: the same everywhere.
  const when = (r: (typeof pending)[number]): string => r.signal?.timestamp ?? r.createdAt ?? '';
  pending = [...pending].sort((a, b) => when(a).localeCompare(when(b)) || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
  const numbers: Record<string, number> = {};
  for (const [id, n] of Object.entries(state.numbers)) if (open.has(id)) numbers[id] = n;
  const used = new Set(Object.values(numbers));
  let next = 1;
  for (const r of pending) {
    if (numbers[r.id] !== undefined) continue;
    while (used.has(next)) next++;
    numbers[r.id] = next;
    used.add(next);
  }
  state.numbers = numbers;
  state.delivered = state.delivered.filter((id) => open.has(id));
  if (state.deliveredAt) for (const id of Object.keys(state.deliveredAt)) if (!open.has(id)) delete state.deliveredAt[id];
  if (state.lastItem && !open.has(state.lastItem)) delete state.lastItem;
  return numbers;
}

export async function requestCheckin(dir: string, now: Date = new Date()): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, CHECKIN_REQUEST_FILE), now.toISOString(), 'utf8');
}

/** True (and the request is cleared) when a check-in was asked for. */
export async function takeCheckinRequest(dir: string): Promise<boolean> {
  try {
    await fs.unlink(path.join(dir, CHECKIN_REQUEST_FILE));
    return true;
  } catch {
    return false;
  }
}
