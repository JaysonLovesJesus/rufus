import { loadAnchor } from '../anchor/anchor';
import { clip } from '../corpus/types';
import type { Engine } from '../engine/engine';
import type { LoopRun, MasterLoop } from '../engine/loop';
import { formatTrust } from '../engine/trust';
import { draftOf } from './loop-text';

export interface NowOptions {
  loop: MasterLoop;
  /** Adds open flow cards to the count. */
  engine?: Engine;
  /** Short numbers by run id (from `assignNumbers`). */
  numbers?: Record<string, number>;
  now?: Date;
  /** How far back "recent autonomous actions" looks. Default 24h. */
  recentHours?: number;
}

const PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 };
const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function waitingLine(run: LoopRun, n: number | undefined): string {
  const stage = run.status === 'awaiting_human_plan' ? 'plan' : run.status === 'awaiting_human_execute' ? 'your step' : 'verify';
  const what = run.status === 'awaiting_human_execute' ? run.humanStep : draftOf(run.result) ? `${run.goal ?? ''} -> "${draftOf(run.result)}"` : run.goal;
  return `  ${n !== undefined ? `[#${n}] ` : ''}${run.urgency === 'urgent' ? '(urgent) ' : ''}${stage}: ${clip(`${run.actionType ?? run.handlerId}: ${what ?? ''}`, 140)}`;
}

/**
 * One screen: today's schedule and active goals (the Anchor), everything waiting on you, what Rufus did on its own
 * recently, and Earned Trust progress. Plain code, $0.
 */
export async function nowSummary(opts: NowOptions): Promise<string[]> {
  const now = opts.now ?? new Date();
  const anchor = await loadAnchor(opts.loop.dir, now);
  const runs = await opts.loop.listRuns();
  const lines: string[] = [`Now: ${anchor.schedule.date} ${hhmm(now)}`];

  const blocks = anchor.schedule.blocks;
  if (blocks.length) {
    lines.push('Today:');
    const cur = hhmm(now);
    for (const b of blocks) lines.push(`  ${b.start <= cur && cur < b.end ? '>' : ' '} ${b.start}-${b.end} ${b.kind} ${b.title}${b.status !== 'planned' ? ` [${b.status}]` : ''}`);
  } else lines.push('Today: nothing scheduled.');
  const goals = anchor.goals.filter((g) => g.active).sort((a, b) => (PRIORITY[a.priority] ?? 3) - (PRIORITY[b.priority] ?? 3));
  lines.push(goals.length ? `Goals: ${goals.slice(0, 5).map((g) => `[${g.priority}] ${g.title}`).join('; ')}` : 'Goals: none yet (rufus anchor goal <title>).');

  const waiting = runs.filter((r) => r.status === 'awaiting_human_plan' || r.status === 'awaiting_human_execute' || r.status === 'awaiting_human_verify');
  waiting.sort((a, b) => (a.urgency === 'urgent' ? 0 : 1) - (b.urgency === 'urgent' ? 0 : 1) || a.createdAt.localeCompare(b.createdAt));
  const cards = opts.engine ? await opts.engine.pending() : [];
  if (!waiting.length && !cards.length) lines.push('Waiting on you: nothing.');
  else {
    lines.push(`Waiting on you (${waiting.length + cards.length}):`);
    for (const r of waiting.slice(0, 10)) lines.push(waitingLine(r, opts.numbers?.[r.id]));
    if (waiting.length > 10) lines.push(`  ... and ${waiting.length - 10} more`);
    for (const c of cards.slice(0, 5)) lines.push(`  card: ${clip(c.title, 100)} (ref ${c.id})`);
  }

  const since = now.getTime() - (opts.recentHours ?? 24) * 3_600_000;
  const auto = runs.filter((r) => r.status === 'completed' && Date.parse(r.updatedAt) >= since).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (auto.length) {
    lines.push(`Done on its own (last ${opts.recentHours ?? 24}h): ${auto.length}`);
    for (const r of auto.slice(0, 5)) {
      const tools = (r.toolCalls ?? []).filter((t) => t.ok).map((t) => t.tool);
      lines.push(`  ${r.actionType ?? r.handlerId}: ${clip(r.goal ?? '', 100)}${tools.length ? ` [${tools.join(', ')}]` : ''}${r.commitError ? ` (not applied: ${clip(r.commitError, 60)})` : ''}`);
    }
  } else lines.push('Done on its own (last 24h): nothing.');

  const trust = await opts.loop.trust.all();
  lines.push('Earned Trust:');
  for (const l of formatTrust(trust)) lines.push(`  ${l}`);
  return lines;
}
