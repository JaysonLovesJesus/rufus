import {
  BLOCK_KINDS,
  loadAnchor,
  localDate,
  saveAnchor,
  upsertGoal,
  upsertScheduleBlock,
  type Anchor,
  type AnchorGoal,
  type BlockKind,
  type GoalHorizon,
  type GoalPriority,
  type ScheduleBlock,
} from '../anchor/anchor';
import type { ToolDefinition } from './tools';
import { commitPendingPlan } from '../unified/planner';

/**
 * `anchor.update`: edit your own schedule and goals in `anchor.json` from chat ("remove Study block", "move gym to 6").
 * It only touches your private local workspace (no message leaves, no money, no login), so it is `local`: the Chief of
 * Staff runs it right away when you ask for it, and the next message already sees the new schedule.
 *
 *   { op: "remove_block", titleOrId }                       case-insensitive id or title substring, today's blocks
 *   { op: "add_block", start, end, title, kind?, allowOverlap? }
 *   { op: "move_block", titleOrId, start, end, allowOverlap? }
 *   { op: "add_goal", title, priority?, horizon? }
 *   { op: "remove_goal", titleOrId }                         marks it inactive
 *   { op: "apply_plan" }                                     v17: writes the day plan Rufus proposed (after their yes)
 */

export const ANCHOR_TOOL = 'anchor.update';

export type AnchorUpdateArgs =
  | { op: 'remove_block'; titleOrId: string }
  | { op: 'add_block'; start: string; end: string; title: string; kind?: BlockKind; allowOverlap?: boolean }
  | { op: 'move_block'; titleOrId: string; start: string; end: string; allowOverlap?: boolean }
  | { op: 'add_goal'; title: string; priority?: GoalPriority; horizon?: GoalHorizon }
  | { op: 'remove_goal'; titleOrId: string }
  | { op: 'apply_plan' };

export interface AnchorUpdateResult {
  op: string;
  /** Plain words: what changed. */
  done: string;
  /** Today's schedule after the change. */
  today: string[];
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} is required.`);
  return v.trim();
};

/** One match by exact id, exact title, or a unique case-insensitive title substring. */
function findOne<T extends { id: string; title: string }>(items: T[], needle: string, what: string): T {
  const n = needle.trim().toLowerCase();
  const exact = items.filter((i) => i.id.toLowerCase() === n || i.title.toLowerCase() === n);
  if (exact.length === 1) return exact[0]!;
  const hits = items.filter((i) => i.title.toLowerCase().includes(n) || i.id.toLowerCase().includes(n));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw new Error(`No ${what} matches "${needle}". ${items.length ? `There is: ${items.map((i) => `"${i.title}"`).join(', ')}.` : `There are none.`}`);
  throw new Error(`"${needle}" matches more than one ${what}: ${hits.map((i) => `"${i.title}"`).join(', ')}. Say which.`);
}

const describe = (b: Pick<ScheduleBlock, 'start' | 'end' | 'kind' | 'title'>): string => `${b.start}-${b.end} ${b.kind} ${b.title}`;

/** Applies one update to an Anchor. Pure: returns the new Anchor and what changed. */
export function applyAnchorUpdate(anchor: Anchor, args: Record<string, unknown>, now: Date): { anchor: Anchor; done: string } {
  const today = localDate(now);
  const todays = anchor.schedule.date === today ? anchor.schedule.blocks : [];
  const allowOverlap = args.allowOverlap === true;
  switch (args.op) {
    case 'remove_block': {
      const b = findOne(todays, str(args.titleOrId, 'titleOrId'), 'block today');
      return { anchor: { ...anchor, schedule: { ...anchor.schedule, blocks: anchor.schedule.blocks.filter((x) => x.id !== b.id) } }, done: `Removed ${describe(b)}.` };
    }
    case 'add_block': {
      const kind = args.kind === undefined ? 'focus' : String(args.kind);
      if (!BLOCK_KINDS.includes(kind as BlockKind)) throw new Error(`kind must be one of ${BLOCK_KINDS.join(', ')}.`);
      const r = upsertScheduleBlock(anchor, { start: str(args.start, 'start'), end: str(args.end, 'end'), title: str(args.title, 'title'), kind: kind as BlockKind, source: 'chat' }, { date: today, allowOverlap });
      return { anchor: r.anchor, done: `Added ${describe(r.block)}.` };
    }
    case 'move_block': {
      const b = findOne(todays, str(args.titleOrId, 'titleOrId'), 'block today');
      const r = upsertScheduleBlock(anchor, { id: b.id, start: str(args.start, 'start'), end: str(args.end, 'end'), title: b.title, kind: b.kind, status: b.status }, { date: today, allowOverlap });
      return { anchor: r.anchor, done: `Moved ${b.title} from ${b.start}-${b.end} to ${r.block.start}-${r.block.end}.` };
    }
    case 'add_goal': {
      const priority = (['high', 'medium', 'low'].includes(String(args.priority)) ? args.priority : undefined) as GoalPriority | undefined;
      const horizon = (['today', 'week', 'month'].includes(String(args.horizon)) ? args.horizon : undefined) as GoalHorizon | undefined;
      const r = upsertGoal(anchor, { title: str(args.title, 'title'), ...(priority ? { priority } : {}), ...(horizon ? { horizon } : {}), active: true });
      return { anchor: r.anchor, done: `${r.created ? 'Added' : 'Updated'} goal "${r.goal.title}".` };
    }
    case 'remove_goal': {
      const g: AnchorGoal = findOne(anchor.goals.filter((x) => x.active), str(args.titleOrId, 'titleOrId'), 'active goal');
      return { anchor: { ...anchor, goals: anchor.goals.map((x) => (x.id === g.id ? { ...x, active: false } : x)) }, done: `Dropped goal "${g.title}".` };
    }
    default:
      throw new Error(`op must be one of remove_block, add_block, move_block, add_goal, remove_goal (got ${JSON.stringify(args.op)}).`);
  }
}

/** The built-in `anchor.update` tool. */
export function anchorUpdateTool(): ToolDefinition<Record<string, unknown>, AnchorUpdateResult> {
  return {
    name: ANCHOR_TOOL,
    description:
      'Edit your schedule and goals in anchor.json (private, local). args: {"op":"remove_block","titleOrId"} | {"op":"add_block","start":"HH:MM","end":"HH:MM","title","kind"?} | {"op":"move_block","titleOrId","start","end"} | {"op":"add_goal","title","priority"?} | {"op":"remove_goal","titleOrId"} | {"op":"apply_plan"} (only after they said yes to the day plan you proposed)',
    readOnly: false,
    local: true,
    async execute(args, ctx) {
      if (args?.op === 'apply_plan') {
        const done = await commitPendingPlan(ctx.dir, ctx.now);
        if (!done) throw new Error('There is no day plan waiting for a yes (it may have expired). Propose one first.');
        const after = await loadAnchor(ctx.dir, ctx.now);
        return { op: 'apply_plan', done: done.text, today: after.schedule.date === localDate(ctx.now) ? after.schedule.blocks.map(describe) : [] };
      }
      const anchor = await loadAnchor(ctx.dir, ctx.now);
      const r = applyAnchorUpdate(anchor, args ?? {}, ctx.now);
      const saved = await saveAnchor(ctx.dir, r.anchor, ctx.now);
      const today = saved.schedule.date === localDate(ctx.now) ? saved.schedule.blocks.map(describe) : [];
      return { op: String(args.op), done: r.done, today };
    },
  };
}
