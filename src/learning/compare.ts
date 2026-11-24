import type { Engine } from '../engine/engine';
import { goldenSample, replayCase, type ReplayCaseResult } from './replay';

export interface CompareOptions {
  /** Only the most recent N saved cases (each costs at least two real AI calls). Default: all. */
  limit?: number;
  /** Golden sample: edited cases first, then most recent. Applied after `limit`. */
  sample?: number;
}

/** How one condition (plain or assisted) did across the compared cases. */
export interface CompareArm {
  passed: number;
  failed: number;
  /** passed / total, 0 to 1 (0 when nothing was compared). */
  passRate: number;
  /** Mean model calls per case that reached the model. `plain` is always 1. */
  avgAttempts: number;
}

export interface CompareCaseResult {
  caseId: string;
  stepName: string;
  plain: Pick<ReplayCaseResult, 'status' | 'reason' | 'attempts'>;
  assisted: Pick<ReplayCaseResult, 'status' | 'reason' | 'attempts'>;
}

export interface CompareReport {
  flowId: string;
  /** Cases that ran under both conditions. Cases that could not be replayed are in `skipped` instead. */
  total: number;
  skipped: number;
  /** Cases where the AI provider itself failed (offline, no key...). Left out of the rates: that's not a verdict. */
  errored: number;
  /** The first provider error, if any, so it can be shown. */
  providerError?: string;
  plain: CompareArm;
  assisted: CompareArm;
  /** `assisted.passed - plain.passed`: how many more cases code-assisted AI got right. Negative = it did worse. */
  delta: number;
  /** `assisted.passRate - plain.passRate`, 0 to 1 scale. */
  deltaRate: number;
  results: CompareCaseResult[];
}

/**
 * Plain AI vs. code-assisted AI on your own saved cases, graded by the same `verify`.
 *  - `plain`: the step's raw prompt + the case's raw input. No `context`, lessons or examples; one shot.
 *  - `assisted`: the step exactly as the flow runs it today: code-assembled `context`, scoped lessons,
 *    recent human-reviewed examples and the `verify` retry loop.
 * Like `replayFlow`, it never re-runs `ctx.code` steps (it reuses the original run's saved results).
 * Only what `verify` can check is measured.
 */
export async function compareFlow(engine: Engine, flowId: string, opts: CompareOptions = {}): Promise<CompareReport> {
  const flow = engine.getFlow(flowId);
  await engine.store.init();
  const all = await engine.cases.forFlow(flowId);
  let cases = opts.limit && opts.limit > 0 ? all.slice(-opts.limit) : all;
  if (opts.sample !== undefined) cases = goldenSample(cases, opts.sample);

  const results: CompareCaseResult[] = [];
  let skipped = 0;
  let errored = 0;
  let providerError: string | undefined;
  const plainAttempts: number[] = [];
  const assistedAttempts: number[] = [];
  for (const c of cases) {
    const plain = await replayCase(engine, flow, c, [], 'plain');
    const assisted = await replayCase(engine, flow, c, [], 'assisted');
    const broken = [plain, assisted].find((r) => r.providerError);
    if (broken) {
      errored++;
      providerError ??= broken.reason;
      continue;
    }
    if (plain.status === 'skipped' || assisted.status === 'skipped') {
      skipped++;
      continue;
    }
    if (plain.attempts !== undefined) plainAttempts.push(plain.attempts);
    if (assisted.attempts !== undefined) assistedAttempts.push(assisted.attempts);
    const slim = ({ status, reason, attempts }: ReplayCaseResult) => ({ status, ...(reason ? { reason } : {}), ...(attempts !== undefined ? { attempts } : {}) });
    results.push({ caseId: c.id, stepName: c.stepName, plain: slim(plain), assisted: slim(assisted) });
  }

  const total = results.length;
  const arm = (key: 'plain' | 'assisted', attempts: number[]): CompareArm => {
    const passed = results.filter((r) => r[key].status === 'passed').length;
    return {
      passed,
      failed: total - passed,
      passRate: total ? passed / total : 0,
      avgAttempts: attempts.length ? attempts.reduce((a, b) => a + b, 0) / attempts.length : 0,
    };
  };
  const plain = arm('plain', plainAttempts);
  const assisted = arm('assisted', assistedAttempts);
  return { flowId, total, skipped, errored, ...(providerError ? { providerError } : {}), plain, assisted, delta: assisted.passed - plain.passed, deltaRate: assisted.passRate - plain.passRate, results };
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Plain-text summary for the CLI and chat. */
export function formatCompare(r: CompareReport): string[] {
  if (r.errored) {
    const note = `${r.errored} case(s) could not be compared because the AI provider failed: ${r.providerError}`;
    if (!r.total) return [note];
  }
  if (!r.total) return [r.skipped ? `None of the ${r.skipped} saved case(s) for "${r.flowId}" could be replayed.` : `No saved cases for "${r.flowId}" yet. They are saved when a human answers a card.`];
  const line = (label: string, a: CompareArm) => `  ${label.padEnd(14)} ${a.passed}/${r.total} passed (${pct(a.passRate)}), avg attempts ${a.avgAttempts.toFixed(1)}`;
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const lines = [
    `Compared ${r.total} case(s) for "${r.flowId}"${r.skipped ? ` (${r.skipped} skipped)` : ''}, graded by the same verify:`,
    line('plain AI', r.plain),
    line('code-assisted', r.assisted),
    `Code lift: ${sign(r.delta)} case(s) (${sign(Math.round(r.deltaRate * 100))} points).`,
  ];
  if (r.errored) lines.push(`${r.errored} more case(s) left out: the AI provider failed (${r.providerError}).`);
  for (const c of r.results) {
    if (c.plain.status === c.assisted.status) continue;
    lines.push(`  ${c.caseId} (${c.stepName}): plain ${c.plain.status.toUpperCase()}${c.plain.reason ? ` (${c.plain.reason})` : ''}, assisted ${c.assisted.status.toUpperCase()}${c.assisted.reason ? ` (${c.assisted.reason})` : ''}`);
  }
  return lines;
}
