import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BouncerDecision, BouncerExample, LosslessEvent, ModelCallStats, ModelProvider, ModelRequest, RpgWakeReport } from '../types';
import { EventStore } from '../events/store';
import { runRpgWake } from '../rpg/loop';
import type { ToolRegistry } from '../scripts/registry';
import { loadOpsFailures } from './ops-log';
import { computeOwnerOutcomes, percentile, readEventLog, readGaps, type OwnerOutcomes } from './outcomes';

/** One model call inside a wake: which brain made it, on which turn, and what it cost. */
export interface WakeModelCall extends ModelCallStats {
  /** decide, speaker, investigate, plan, create, verify... (read from the call's system prompt). */
  role: string;
  turn?: number;
  at: string;
}

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
  /** Why the wake ended (slept, turn cap, unreadable replies, crash), and the crash message. */
  endReason?: RpgWakeReport['endReason'];
  error?: string;
  sentMessages: string[];
  trace: RpgWakeReport['trace'];
  /** Every model call this wake made, with usage, cost and latency. */
  modelCalls?: WakeModelCall[];
  costUsd?: number;
}

/** Names the brain behind a call from its system prompt ("You are Decide", "You are the Speaker", a skill heading). */
export function modelCallRole(system: string): string {
  const m = /\bYou are (?:the )?([A-Z][A-Za-z]+)/.exec(system) ?? /^#\s*([A-Z][A-Za-z]+)/m.exec(system);
  return m ? m[1]!.toLowerCase() : 'other';
}

/**
 * Wraps a provider so every call reports its usage, cost and latency (failed calls too).
 * Uses `completeWithStats` when the provider has it; otherwise only the duration is known.
 */
export function meterProvider(inner: ModelProvider, onCall: (call: Omit<WakeModelCall, 'turn'>) => void): ModelProvider & { close?: () => void } {
  const report = (req: ModelRequest, stats: ModelCallStats) => {
    try {
      onCall({ ...stats, role: modelCallRole(req.system), at: new Date().toISOString() });
    } catch {
      /* metering never breaks a call */
    }
  };
  const call = async (req: ModelRequest): Promise<{ text: string; stats: ModelCallStats }> => {
    const started = Date.now();
    const model = req.model ?? inner.name;
    try {
      const out = inner.completeWithStats ? await inner.completeWithStats(req) : { text: await inner.complete(req), stats: { model, durationMs: Date.now() - started, ok: true } };
      report(req, out.stats);
      return out;
    } catch (err) {
      const carried = (err as { stats?: ModelCallStats }).stats;
      report(req, carried ?? { model, durationMs: Date.now() - started, ok: false, error: (err as Error).message?.slice(0, 300) ?? String(err) });
      throw err;
    }
  };
  return {
    name: inner.name,
    complete: async (req) => (await call(req)).text,
    completeWithStats: call,
    close: () => (inner as { close?: () => void }).close?.(),
  };
}

export interface OutcomeScorecard {
  /** Wakes the wake-level rates are computed over (the most recent 500). */
  totalWakes: number;
  /** Every wake in wakes.jsonl (owner outcomes use all of them). */
  wakesOnFile: number;
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
  /** Model spend and latency, from wakes that recorded their model calls. */
  meteredWakes: number;
  costUsd: number;
  avgCostPerWakeUsd: number;
  modelCalls: number;
  modelFailures: number;
  byRole: Array<{ role: string; calls: number; costUsd: number; p50Ms?: number; p90Ms?: number; avgInputTokens?: number; avgCacheReadTokens?: number }>;
  /** Channel failures (poll, send, edit), all-time and in the last 24h. */
  opsFailures: Array<{ kind: string; channel?: string; total: number; last24h: number; lastError: string }>;
  outcomes: OwnerOutcomes;
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

/**
 * The last `limit` wakes. `wakes.jsonl` only grows and every record holds a full trace, so only the tail is read
 * (the Desk calls this on every turn).
 */
export async function loadWakes(workspaceDir: string, limit = 100): Promise<WakeRecord[]> {
  try {
    const raw = await readTailLines(path.join(workspaceDir, 'wakes.jsonl'), limit);
    const items: WakeRecord[] = [];
    for (const line of raw) {
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

/** The last `count` non-empty lines of a file, reading backwards in growing chunks instead of the whole file. */
export async function readTailLines(file: string, count: number): Promise<string[]> {
  const handle = await fs.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    let chunk = 256 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      // The first piece may be the cut-off end of an earlier line, unless the read reached the start of the file.
      if (start > 0) lines.shift();
      const full = lines.filter((l) => l.trim());
      if (full.length >= count || start === 0) return full.slice(-count);
      chunk *= 4;
    }
  } finally {
    await handle.close();
  }
}

/** Computes the 4 real-world outcome metrics from `wakes.jsonl` + `training/bouncer.jsonl` at $0. */
export async function computeScorecard(workspaceDir: string): Promise<OutcomeScorecard> {
  const allWakes = await loadWakes(workspaceDir, 100_000);
  const wakes = allWakes.slice(-500);
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

  const metered = wakes.filter((w) => Array.isArray(w.modelCalls));
  const calls = metered.flatMap((w) => w.modelCalls!);
  const costUsd = calls.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  const roles = [...new Set(calls.map((c) => c.role))].sort();
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : undefined);
  const byRole = roles.map((role) => {
    const rc = calls.filter((c) => c.role === role);
    const ok = rc.filter((c) => c.ok).map((c) => c.durationMs);
    const p50Ms = percentile(ok, 50);
    const p90Ms = percentile(ok, 90);
    const avgInputTokens = avg(rc.flatMap((c) => (c.inputTokens !== undefined ? [c.inputTokens + (c.cacheReadTokens ?? 0) + (c.cacheWriteTokens ?? 0)] : [])));
    const avgCacheReadTokens = avg(rc.flatMap((c) => (c.cacheReadTokens !== undefined ? [c.cacheReadTokens] : [])));
    return {
      role,
      calls: rc.length,
      costUsd: Number(rc.reduce((s, c) => s + (c.costUsd ?? 0), 0).toFixed(4)),
      ...(p50Ms !== undefined ? { p50Ms } : {}),
      ...(p90Ms !== undefined ? { p90Ms } : {}),
      ...(avgInputTokens !== undefined ? { avgInputTokens } : {}),
      ...(avgCacheReadTokens !== undefined ? { avgCacheReadTokens } : {}),
    };
  });

  const dayAgo = Date.now() - 24 * 60 * 60_000;
  const ops = new Map<string, { kind: string; channel?: string; total: number; last24h: number; lastError: string }>();
  for (const f of await loadOpsFailures(workspaceDir)) {
    const key = `${f.kind}|${f.channel ?? ''}`;
    const row = ops.get(key) ?? { kind: f.kind, ...(f.channel ? { channel: f.channel } : {}), total: 0, last24h: 0, lastError: '' };
    const n = 1 + (f.repeatsSinceLast ?? 0);
    row.total += n;
    if (Date.parse(f.at) >= dayAgo) row.last24h += n;
    row.lastError = f.error;
    ops.set(key, row);
  }

  const outcomes = computeOwnerOutcomes({
    events: await readEventLog(workspaceDir),
    gaps: await readGaps(workspaceDir),
    wakes: allWakes,
  });

  return {
    totalWakes,
    wakesOnFile: allWakes.length,
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
    meteredWakes: metered.length,
    costUsd: Number(costUsd.toFixed(4)),
    avgCostPerWakeUsd: metered.length ? Number((costUsd / metered.length).toFixed(4)) : 0,
    modelCalls: calls.length,
    modelFailures: calls.filter((c) => !c.ok).length,
    byRole,
    opsFailures: [...ops.values()],
    outcomes,
  };
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return 'n/a';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatScorecard(sc: OutcomeScorecard): string[] {
  const o = sc.outcomes;
  // A rate over nothing is "n/a", not a perfect 100%.
  const pct = (rate: number, denominator: number) => (denominator ? `${Math.round(rate * 100)}%` : 'n/a');
  const feedback = sc.approvals + sc.pushbacks + sc.skips;
  const scope = sc.wakesOnFile > sc.totalWakes ? `last ${sc.totalWakes} of ${sc.wakesOnFile} wakes` : `${sc.totalWakes} wake(s)`;
  const lines = [
    `Rufus v2 Outcome Scorecard (${scope}):`,
    `  Wasted wake rate:  ${pct(sc.wastedWakeRate, sc.totalWakes)} (${sc.wastedWakes}/${sc.totalWakes})`,
    `  Avg turns / wake:  ${sc.avgTurns} (${sc.totalWakes ? fmtMs(sc.avgDurationMs) : 'n/a'} avg)`,
    `  Tool success rate: ${pct(sc.toolSuccessRate, sc.toolCalls)} (${sc.toolCalls - sc.toolFailures}/${sc.toolCalls})`,
    `  Bouncer feedback:  ${sc.approvals} approval(s), ${sc.pushbacks} pushback(s), ${sc.skips} skip(s) (${pct(sc.approvalRate, feedback)} approval)`,
    '',
    `Owner outcomes (${o.ownerMessages} owner message(s), ${o.linkedToGap} tied to a gap):`,
    `  Messages:          ${o.byClass.new_ask} new ask(s), ${o.byClass.correction} correction(s), ${o.byClass.repeat} repeat(s), ${o.byClass.thanks} thanks`,
    `  Pushback rate:     ${pct(o.pushbackRate, o.ownerMessages)} (corrections + repeats)`,
    `  Reply latency:     p50 ${fmtMs(o.replyP50Ms)}, p90 ${fmtMs(o.replyP90Ms)}`,
    `  Closed gaps:       ${o.closedGaps} (time to close p50 ${fmtMs(o.closeP50Ms)}, ${o.ownerMessagesPerClosedGap ?? 'n/a'} owner message(s) per closed gap)`,
  ];
  for (const g of o.gaps.filter((x) => x.ownerMessages > 0 || x.closeMs !== undefined).slice(-8)) {
    lines.push(`    ${g.id} [${g.status}] ${g.title.slice(0, 50)}: ${g.closeMs !== undefined ? `closed in ${fmtMs(g.closeMs)}, ` : ''}${g.ownerMessages} owner msg(s), ${g.pushbacks} pushback(s)`);
  }
  lines.push('', `Model cost and latency (${sc.meteredWakes} metered wake(s), ${sc.modelCalls} call(s), ${sc.modelFailures} failed):`);
  lines.push(sc.meteredWakes ? `  Total cost:        $${sc.costUsd.toFixed(2)} ($${sc.avgCostPerWakeUsd.toFixed(3)} per wake)` : '  Total cost:        n/a (no wake has recorded its model calls yet)');
  for (const r of sc.byRole) {
    lines.push(
      `  ${r.role.padEnd(18)} ${r.calls} call(s), $${r.costUsd.toFixed(2)}, p50 ${fmtMs(r.p50Ms)}, p90 ${fmtMs(r.p90Ms)}` +
        (r.avgInputTokens !== undefined ? `, ~${r.avgInputTokens} prompt tok (${r.avgCacheReadTokens ?? 0} cached)` : ''),
    );
  }
  lines.push('', 'Channel failures:');
  if (!sc.opsFailures.length) lines.push('  none logged');
  for (const f of sc.opsFailures) lines.push(`  ${f.kind}${f.channel ? ` (${f.channel})` : ''}: ${f.total} total, ${f.last24h} in 24h. Last: ${f.lastError.slice(0, 100)}`);
  return lines;
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
