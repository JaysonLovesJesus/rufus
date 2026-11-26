import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BouncerDecision, BouncerExample, LosslessEvent, ModelProvider, RpgWakeReport } from '../types';
import { EventStore } from '../events/store';
import { runRpgWake } from '../rpg/loop';
import type { ToolRegistry } from '../scripts/registry';

export interface WakeRecord {
  wakeId: string;
  at: string;
  trigger: Pick<LosslessEvent, 'id' | 'source' | 'kind' | 'actor' | 'text'>;
  decision: BouncerDecision;
  turns: number;
  durationMs: number;
  acted: boolean;
  slept: boolean;
  sleepReason?: string;
  sentMessages: string[];
  trace: RpgWakeReport['trace'];
}

export interface OutcomeScorecard {
  totalWakes: number;
  actedWakes: number;
  wastedWakes: number;
  wastedWakeRate: number;
  avgTurns: number;
  avgDurationMs: number;
  toolCalls: number;
  toolFailures: number;
  toolSuccessRate: number;
  pushbacks: number;
  skips: number;
  approvals: number;
  approvalRate: number;
}

export interface JudgmentEvalCase {
  id: string;
  trigger: LosslessEvent;
  expectedFirstTool: string;
  forbiddenTools?: string[];
  notes?: string;
}

export interface JudgmentEvalReport {
  total: number;
  passed: number;
  ok: boolean;
  results: Array<{
    id: string;
    passed: boolean;
    actualFirstTool: string;
    expectedFirstTool: string;
    reason?: string;
  }>;
}

/** Appends one complete RPG wake transcript to `<workspace>/wakes.jsonl`. */
export async function recordWake(workspaceDir: string, rec: WakeRecord): Promise<void> {
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.appendFile(path.join(workspaceDir, 'wakes.jsonl'), `${JSON.stringify(rec)}\n`, 'utf8');
}

export async function loadWakes(workspaceDir: string, limit = 100): Promise<WakeRecord[]> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, 'wakes.jsonl'), 'utf8');
    const items: WakeRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        items.push(JSON.parse(line) as WakeRecord);
      } catch {
        /* skip */
      }
    }
    return items.slice(-limit);
  } catch {
    return [];
  }
}

/** Computes the 4 real-world outcome metrics from `wakes.jsonl` + `training/bouncer.jsonl` at $0. */
export async function computeScorecard(workspaceDir: string): Promise<OutcomeScorecard> {
  const wakes = await loadWakes(workspaceDir, 500);
  const totalWakes = wakes.length;
  const actedWakes = wakes.filter((w) => w.acted).length;
  const wastedWakes = wakes.filter((w) => !w.acted && w.trigger.source !== 'system').length;
  const avgTurns = totalWakes ? Number((wakes.reduce((s, w) => s + w.turns, 0) / totalWakes).toFixed(2)) : 0;
  const avgDurationMs = totalWakes ? Math.round(wakes.reduce((s, w) => s + w.durationMs, 0) / totalWakes) : 0;

  let toolCalls = 0;
  let toolFailures = 0;
  for (const w of wakes) {
    for (const t of w.trace) {
      if (t.toolId === 'sleep') continue;
      toolCalls++;
      if (t.receipt.status === 'failed' || t.receipt.status === 'timed_out' || t.receipt.status === 'invalid_input') {
        toolFailures++;
      }
    }
  }

  let pushbacks = 0;
  let skips = 0;
  let approvals = 0;
  try {
    const raw = await fs.readFile(path.join(workspaceDir, 'training', 'bouncer.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ex = JSON.parse(line) as BouncerExample;
        if (ex.source === 'pushback') pushbacks++;
        else if (ex.source === 'skip') skips++;
        else if (ex.source === 'approval') approvals++;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* none yet */
  }

  const feedbackTotal = pushbacks + skips + approvals;
  return {
    totalWakes,
    actedWakes,
    wastedWakes,
    wastedWakeRate: totalWakes ? Number((wastedWakes / totalWakes).toFixed(3)) : 0,
    avgTurns,
    avgDurationMs,
    toolCalls,
    toolFailures,
    toolSuccessRate: toolCalls ? Number(((toolCalls - toolFailures) / toolCalls).toFixed(3)) : 1,
    pushbacks,
    skips,
    approvals,
    approvalRate: feedbackTotal ? Number((approvals / feedbackTotal).toFixed(3)) : 1,
  };
}

export function formatScorecard(sc: OutcomeScorecard): string[] {
  return [
    `Rufus v2 Outcome Scorecard (${sc.totalWakes} wake(s)):`,
    `  Wasted wake rate:  ${Math.round(sc.wastedWakeRate * 100)}% (${sc.wastedWakes}/${sc.totalWakes})`,
    `  Avg turns / wake:  ${sc.avgTurns} (${sc.avgDurationMs}ms avg)`,
    `  Tool success rate: ${Math.round(sc.toolSuccessRate * 100)}% (${sc.toolCalls - sc.toolFailures}/${sc.toolCalls})`,
    `  Human feedback:    ${sc.approvals} approval(s), ${sc.pushbacks} pushback(s), ${sc.skips} skip(s) (${Math.round(sc.approvalRate * 100)}% approval)`,
  ];
}

/** Replays golden judgment cases (`evals/judgment.json`) to grade Turn 1 tool selection objectively. */
export async function runJudgmentEval(opts: {
  workspaceDir: string;
  cases?: readonly JudgmentEvalCase[];
  provider: ModelProvider;
  model?: string;
  registry: ToolRegistry;
  now?: () => Date;
}): Promise<JudgmentEvalReport> {
  let cases: readonly JudgmentEvalCase[] = opts.cases ?? [];
  if (!opts.cases) {
    try {
      const raw = await fs.readFile(path.join(opts.workspaceDir, 'evals', 'judgment.json'), 'utf8');
      cases = JSON.parse(raw) as JudgmentEvalCase[];
    } catch {
      cases = [];
    }
  }

  const events = new EventStore({ workspaceDir: opts.workspaceDir });
  const results: JudgmentEvalReport['results'] = [];

  for (const c of cases) {
    const wake = await runRpgWake({
      workspaceDir: opts.workspaceDir,
      trigger: c.trigger,
      reasoningProvider: opts.provider,
      ...(opts.model ? { reasoningModel: opts.model } : {}),
      registry: opts.registry,
      events,
      maxTurns: 1,
      ...(opts.now ? { now: opts.now } : {}),
    });
    const actualFirstTool = wake.trace[0]?.toolId ?? 'none';
    const forbidden = c.forbiddenTools?.includes(actualFirstTool) ?? false;
    const passed = actualFirstTool === c.expectedFirstTool && !forbidden;
    results.push({
      id: c.id,
      passed,
      actualFirstTool,
      expectedFirstTool: c.expectedFirstTool,
      ...(passed ? {} : { reason: `picked "${actualFirstTool}", expected "${c.expectedFirstTool}"` }),
    });
  }

  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, ok: passed === results.length, results };
}
