import type { LoopRun, MasterLoop } from '../engine/loop';
import { assignNumbers, loadStartState, saveStartState, type StartState } from '../unified/state';
import type { ToolDefinition } from './tools';

/**
 * v24a `pending.clear`: dismisses items waiting on you in Verify that you already handled yourself ("I already replied
 * to #1-#4 and reacted to #5"). It only touches your private local workspace (`loop-runs/` and `start-state.json`):
 * nothing is sent, nothing is approved, and Earned Trust is not changed. So it is `local`: chat runs it right away when
 * you say so, and code can then verify the items are really gone.
 *
 *   { refs: "#1-#4" }  |  { refs: ["#1", "#5"] }  |  { refs: "all" }  |  { refs: [1, 2] }    reason defaults to already_handled
 */

export const PENDING_CLEAR_TOOL = 'pending.clear';

export type PendingClearReason = 'already_handled' | 'not_needed' | 'duplicate';
const REASONS: readonly PendingClearReason[] = ['already_handled', 'not_needed', 'duplicate'];

export interface PendingClearResult {
  /** The items dismissed, by their short number. */
  cleared: Array<{ ref: string; runId: string; goal: string }>;
  /** Refs that matched nothing waiting. */
  notFound: string[];
  /** How many items still wait on you. */
  remaining: number;
  reason: PendingClearReason;
  /** Plain words: what changed. */
  done: string;
}

export interface PendingClearToolOptions {
  loop: Pick<MasterLoop, 'pending' | 'dismissRun' | 'dir'>;
  /**
   * The daemon's live start state, when a pass is running: updated in place (the daemon saves it). Otherwise
   * `start-state.json` is loaded and saved by the tool itself.
   */
  liveState?: () => StartState | undefined;
}

/** "#1-#4, #5" / ["#1", 2] / "all" -> { all } or the list of numbers and raw ids. */
export function parsePendingRefs(raw: unknown): { all: boolean; numbers: number[]; ids: string[] } {
  const parts: string[] = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => (typeof v === 'number' ? [String(v)] : typeof v === 'string' ? [v] : []));
  const out = { all: false, numbers: [] as number[], ids: [] as string[] };
  for (const part of parts) {
    // "#1 - #4" / "1 to 4" (spaces around the dash) -> "1-4" before splitting on spaces.
    const text = part.trim().replace(/#?(\d+)\s*(?:-|–|—|to|through)\s*#?(\d+)/gi, '$1-$2');
    if (!text) continue;
    if (/^(?:all|everything|\*)$/i.test(text)) {
      out.all = true;
      continue;
    }
    for (const token of text.split(/\s*(?:,|\band\b|&|\s)\s*/i).filter(Boolean)) {
      const range = /^#?(\d{1,3})\s*(?:-|–|—|to|through)\s*#?(\d{1,3})$/i.exec(token);
      if (range) {
        const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y) as [number, number];
        for (let n = a; n <= Math.min(b, a + 99); n++) out.numbers.push(n);
        continue;
      }
      const one = /^#?(\d{1,3})$/.exec(token);
      if (one) out.numbers.push(Number(one[1]));
      else if (/^(?:all|everything)$/i.test(token)) out.all = true;
      else out.ids.push(token);
    }
  }
  out.numbers = [...new Set(out.numbers)].sort((a, b) => a - b);
  out.ids = [...new Set(out.ids.filter((id) => !/^(?:-|–|—|to|through)$/i.test(id)))];
  return out;
}

const goalOf = (r: LoopRun): string => (r.goal ?? r.signal.text ?? r.actionType ?? r.handlerId).replace(/\s+/g, ' ').trim().slice(0, 100);

/** Dismisses pending Verify items by ref. Used by the `pending.clear` tool. */
export async function clearPendingItems(
  opts: PendingClearToolOptions & { dir?: string },
  args: { refs?: unknown; ref?: unknown; reason?: unknown },
): Promise<PendingClearResult> {
  const dir = opts.dir ?? opts.loop.dir;
  const refs = parsePendingRefs(args.refs ?? args.ref);
  if (!refs.all && !refs.numbers.length && !refs.ids.length) throw new Error('refs is required: "#1", ["#1","#3"], "#1-#4" or "all".');
  const reason = (REASONS.includes(args.reason as PendingClearReason) ? args.reason : 'already_handled') as PendingClearReason;

  const live = opts.liveState?.();
  const state = live ?? (await loadStartState(dir));
  const pending = await opts.loop.pending();
  assignNumbers(state, pending);
  const byNumber = new Map(Object.entries(state.numbers).map(([id, n]) => [n, id]));
  const open = new Map(pending.map((r) => [r.id, r]));

  const targets = new Map<string, string>(); // runId -> ref shown
  const notFound: string[] = [];
  if (refs.all) for (const r of pending) targets.set(r.id, `#${state.numbers[r.id]}`);
  for (const n of refs.numbers) {
    const id = byNumber.get(n);
    if (id && open.has(id)) targets.set(id, `#${n}`);
    else if (!refs.all) notFound.push(`#${n}`);
  }
  for (const id of refs.ids) {
    if (open.has(id)) targets.set(id, state.numbers[id] !== undefined ? `#${state.numbers[id]}` : id);
    else notFound.push(id);
  }
  if (!targets.size) {
    const list = [...open.values()].map((r) => `#${state.numbers[r.id]} ${goalOf(r)}`);
    throw new Error(`Nothing waiting matches ${notFound.join(', ') || 'that'}. ${list.length ? `Waiting now: ${list.join('; ')}.` : 'Nothing is waiting on them.'}`);
  }

  const cleared: PendingClearResult['cleared'] = [];
  const why = reason === 'already_handled' ? 'already handled: you said you took care of it yourself' : reason === 'duplicate' ? 'dismissed as a duplicate' : 'dismissed: not needed';
  for (const [runId, ref] of targets) {
    const after = await opts.loop.dismissRun(runId, why);
    if (after.status === 'expired') cleared.push({ ref, runId, goal: goalOf(open.get(runId)!) });
  }
  cleared.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  const remaining = await opts.loop.pending();
  assignNumbers(state, remaining);
  if (!live) await saveStartState(dir, state);
  const refsText = cleared.map((c) => c.ref).join(', ');
  return {
    cleared,
    notFound,
    remaining: remaining.length,
    reason,
    done: `Cleared ${refsText} (${reason.replace('_', ' ')}). ${remaining.length ? `${remaining.length} still waiting.` : 'Nothing else is waiting.'}${notFound.length ? ` Not found: ${notFound.join(', ')}.` : ''}`,
  };
}

/** The built-in `pending.clear` tool. */
export function pendingClearTool(opts: PendingClearToolOptions): ToolDefinition<Record<string, unknown>, PendingClearResult> {
  return {
    name: PENDING_CLEAR_TOOL,
    description:
      'Dismiss items waiting on them in Verify that they already handled themselves (private, local: nothing is sent). args: {"refs":"#1-#4"} | {"refs":["#1","#5"]} | {"refs":"all"}, "reason"?: "already_handled" (default) | "not_needed" | "duplicate"',
    readOnly: false,
    local: true,
    reversible: false,
    async execute(args) {
      return clearPendingItems(opts, args ?? {});
    },
  };
}
