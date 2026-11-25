import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BLOCK_KINDS,
  findScheduleConflicts,
  loadAnchor,
  localDate,
  parseTimeRange,
  saveAnchor,
  upsertScheduleBlock,
  type BlockKind,
  type ScheduleBlock,
} from '../anchor/anchor';
import { stableId } from '../corpus/types';
import { normalizeSignal, type LoopPlan, type LoopSignal, type Sensor, type SignalHandler } from './loop';

export const INBOX_FILE = 'inbox.jsonl';

/**
 * The built-in sensor: `<workspace>/inbox.jsonl`, one signal per line. Anything can feed the loop by appending a line
 * (a script, a cron job, a webhook, `rufus signal`). The cursor is the number of lines already read.
 */
export function inboxSensor(dir: string, file = path.join(dir, INBOX_FILE)): Sensor {
  return {
    id: 'inbox',
    surface: 'inbox',
    async poll(cursor) {
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { signals: [] };
        throw err;
      }
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop(); // the trailing newline is not a line
      const from = Math.max(0, Number(cursor) || 0);
      const signals: LoopSignal[] = [];
      lines.slice(from).forEach((line, i) => {
        if (!line.trim()) return;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          return; // a broken line is skipped, never fatal
        }
        const withId = typeof raw === 'object' && raw !== null && !('id' in raw) ? { ...raw, id: stableId('sig', String(from + i), line) } : raw;
        const s = normalizeSignal(withId, 'inbox');
        if (s) signals.push(s);
      });
      return { signals, nextCursor: String(lines.length) };
    },
  };
}

/** Appends one signal to the inbox (creating it), and returns the signal as saved. */
export async function appendSignal(dir: string, signal: Omit<LoopSignal, 'id'> & { id?: string }, now: Date = new Date()): Promise<LoopSignal> {
  const full = normalizeSignal({ timestamp: now.toISOString(), ...signal, id: signal.id ?? stableId('sig', now.toISOString(), JSON.stringify(signal), String(Math.random())) }, 'inbox')!;
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, INBOX_FILE), JSON.stringify(full) + '\n', 'utf8');
  return full;
}

interface SchedulePlan extends LoopPlan {
  block: { start: string; end: string; title: string; kind: BlockKind; date: string };
}

interface ScheduleResult {
  date: string;
  block: Pick<ScheduleBlock, 'start' | 'end' | 'title' | 'kind'>;
  conflicts: Array<Pick<ScheduleBlock, 'id' | 'start' | 'end' | 'title' | 'kind'>>;
}

/**
 * The built-in handler for `schedule.request` signals (`data: { start, end, title, kind?, date? }` or
 * `data: { range: "09:00-10:30", ... }`): all code, $0. It proposes the block, the cross-check refuses overlaps, and
 * once trusted or approved the block is written to the Anchor.
 */
export const scheduleBlockHandler: SignalHandler<ScheduleResult, SchedulePlan> = {
  id: 'schedule.block',
  match: { kind: 'schedule.request' },
  maxReplans: 0, // code cannot fix an overlap by trying again: a human picks
  plan(signal, ctx) {
    const d = signal.data ?? {};
    const range = typeof d.range === 'string' ? parseTimeRange(d.range) : parseTimeRange(`${String(d.start ?? '')}-${String(d.end ?? '')}`);
    const title = (typeof d.title === 'string' && d.title.trim()) || signal.text?.trim();
    if (!title) throw new Error('A schedule.request needs a title (data.title or text).');
    const kind = (BLOCK_KINDS as readonly string[]).includes(String(d.kind)) ? (d.kind as BlockKind) : 'focus';
    const date = typeof d.date === 'string' && d.date ? d.date : localDate(ctx.now);
    return {
      goal: `Put "${title}" (${kind}) on ${date} at ${range.start}-${range.end} without overlapping anything.`,
      actionType: 'schedule.block',
      route: 'code',
      criteria: ['no overlap with planned blocks', 'never touches a protected block'],
      block: { ...range, title, kind, date },
    };
  },
  execute(plan, _signal, ctx) {
    const day = plan.block.date === ctx.anchor.schedule.date ? ctx.anchor.schedule : (ctx.anchor.pastSchedules?.find((s) => s.date === plan.block.date) ?? { date: plan.block.date, blocks: [] });
    const conflicts = findScheduleConflicts(day, plan.block).map(({ id, start, end, title, kind }) => ({ id, start, end, title, kind }));
    const { date, ...block } = plan.block;
    return { date, block, conflicts };
  },
  crossCheck(result) {
    if (!result.conflicts.length) return { ok: true };
    return { ok: false, reason: `overlaps ${result.conflicts.map((c) => `${c.start}-${c.end} "${c.title}"`).join(', ')}` };
  },
  async commit(output, plan, _signal, ctx) {
    // The human may have edited the block (e.g. moved it); take their version.
    const o = (typeof output === 'object' && output !== null ? output : {}) as Partial<ScheduleResult> & { start?: string; end?: string };
    const block = { ...plan.block, ...(o.block ?? {}), ...(o.start && o.end ? { start: o.start, end: o.end } : {}) };
    const fresh = await loadAnchor(ctx.dir, ctx.now); // re-read: the Anchor may have changed while this waited for a human
    const { anchor } = upsertScheduleBlock(fresh, { ...block, source: 'rufus' }, { date: o.date ?? plan.block.date });
    await saveAnchor(ctx.dir, anchor, ctx.now);
  },
};
