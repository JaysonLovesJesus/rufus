import { AiVerificationError, buildSystemPrompt, runAiStep } from '../engine/ai';
import type { Engine } from '../engine/engine';
import type {
  AiStepOptions,
  Flow,
  FlowContext,
  HumanAnswer,
  HumanStepSpec,
  RunRecord,
  StepRecord,
  VerifyResult,
} from '../types';
import { recallMemory, type ReplayCase } from './cases';

export interface ReplayOptions {
  /** Only the most recent N cases (each one costs a real AI call). Default: all. */
  limit?: number;
}

export interface ReplayCaseResult {
  caseId: string;
  stepName: string;
  /** passed/failed: did today's step produce an output that passes `verify`? skipped: could not replay. */
  status: 'passed' | 'failed' | 'skipped';
  /** Exact `verify()` failure reason (or the provider/skip reason). */
  reason?: string;
  attempts?: number;
  /** Did the draft saved in the case pass today's `verify`? */
  before?: 'passed' | 'failed';
  /** improved: failed before, passes now. regressed: passed before, fails now. */
  change?: 'improved' | 'regressed' | 'unchanged';
  output?: unknown;
}

export interface ReplayReport {
  flowId: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  improved: number;
  regressed: number;
  unchanged: number;
  results: ReplayCaseResult[];
}

/**
 * Re-run saved cases against the flow as it is today: current ai step, current `verify` and `parse`,
 * current lessons and examples. Each case runs the flow up to the reviewed ai step and stops there,
 * using the original run's saved code results, so no `ctx.code` side effect ever runs twice.
 */
export async function replayFlow(engine: Engine, flowId: string, opts: ReplayOptions = {}): Promise<ReplayReport> {
  const flow = engine.getFlow(flowId);
  await engine.store.init();
  const all = await engine.cases.forFlow(flowId);
  const cases = opts.limit && opts.limit > 0 ? all.slice(-opts.limit) : all;

  const results: ReplayCaseResult[] = [];
  for (const c of cases) results.push(await replayCase(engine, flow, c));

  const count = (f: (r: ReplayCaseResult) => boolean) => results.filter(f).length;
  return {
    flowId,
    total: results.length,
    passed: count((r) => r.status === 'passed'),
    failed: count((r) => r.status === 'failed'),
    skipped: count((r) => r.status === 'skipped'),
    improved: count((r) => r.change === 'improved'),
    regressed: count((r) => r.change === 'regressed'),
    unchanged: count((r) => r.change === 'unchanged'),
    results,
  };
}

async function replayCase(engine: Engine, flow: Flow, c: ReplayCase): Promise<ReplayCaseResult> {
  const base = { caseId: c.id, stepName: c.stepName };
  const skip = (reason: string): ReplayCaseResult => ({ ...base, status: 'skipped', reason });

  let original: RunRecord;
  try {
    original = await engine.store.getRun(c.runId);
  } catch {
    return skip(`The original run ${c.runId} is no longer in the workspace.`);
  }

  const memory = await recallMemory(engine, {
    flowId: flow.meta.id,
    role: flow.meta.role,
    stepName: c.stepName,
    excludeCaseId: c.id,
  });
  const ctx = new ReplayContext(engine, flow, c, original, buildSystemPrompt(flow.meta.role, memory.lessons, memory.examples));

  let flowError: string | undefined;
  try {
    await flow.run(ctx);
  } catch (err) {
    if (!(err instanceof StopReplay)) flowError = err instanceof Error ? err.message : String(err);
  }

  const o = ctx.outcome;
  if (!o) return skip(flowError ?? `The flow no longer reaches step "${c.stepKey}".`);
  if (o.kind === 'error') return { ...base, status: 'failed', reason: `AI provider error: ${o.message}`, before: o.before };

  const passed = o.kind === 'passed';
  return {
    ...base,
    status: passed ? 'passed' : 'failed',
    ...(passed ? { output: o.value } : { reason: o.reason }),
    attempts: o.attempts,
    before: o.before,
    change: o.before === 'failed' && passed ? 'improved' : o.before === 'passed' && !passed ? 'regressed' : 'unchanged',
  };
}

/** Unwinds the flow once the step under test has an outcome. */
class StopReplay extends Error {}

/** The flow cannot be replayed from the saved run (e.g. a step it needs was never finished). */
class MissingStep extends Error {}

type Outcome =
  | { kind: 'passed'; value: unknown; attempts: number; before: 'passed' | 'failed' }
  | { kind: 'failed'; reason: string; attempts: number; before: 'passed' | 'failed' }
  | { kind: 'error'; message: string; before: 'passed' | 'failed' };

class ReplayContext implements FlowContext<any> {
  readonly runId: string;
  readonly input: unknown;
  outcome?: Outcome;
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly engine: Engine,
    private readonly flow: Flow,
    private readonly c: ReplayCase,
    private readonly original: RunRecord,
    private readonly system: string,
  ) {
    this.runId = `replay_${c.id}`;
    this.input = c.input;
  }

  private keyFor(kind: StepRecord['kind'], name: string): string {
    if (this.outcome) throw new StopReplay();
    const base = `${kind}:${name}`;
    const n = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  }

  private saved(key: string): unknown {
    const step = this.original.steps[key];
    if (!step?.done) throw new MissingStep(`The original run has no saved result for "${key}".`);
    return step.result;
  }

  async code<T>(name: string, _fn: () => T | Promise<T>): Promise<T> {
    return this.saved(this.keyFor('code', name)) as T; // never re-executed: it may have side effects
  }

  async human(name: string, _spec: HumanStepSpec): Promise<HumanAnswer> {
    return this.saved(this.keyFor('human', name)) as HumanAnswer;
  }

  ai(name: string, opts: AiStepOptions<string> & { parse?: undefined }): Promise<string>;
  ai<T>(name: string, opts: AiStepOptions<T> & { parse: (raw: string) => T }): Promise<T>;
  async ai(name: string, opts: AiStepOptions<any>): Promise<any> {
    const key = this.keyFor('ai', name);
    if (key !== this.c.stepKey) return this.saved(key);

    const before = (await check(opts, this.c.aiDraft)).ok ? 'passed' : 'failed';
    try {
      const { value, attempts } = await runAiStep({
        provider: this.engine.provider,
        system: this.system,
        step: name,
        opts,
        meta: { runId: this.runId, flowId: this.flow.meta.id },
      });
      this.outcome = { kind: 'passed', value, attempts, before };
    } catch (err) {
      this.outcome =
        err instanceof AiVerificationError
          ? { kind: 'failed', reason: err.reason, attempts: err.attempts, before }
          : { kind: 'error', message: err instanceof Error ? err.message : String(err), before };
    }
    throw new StopReplay();
  }
}

async function check(opts: AiStepOptions<any>, value: unknown): Promise<VerifyResult> {
  if (!opts.verify) return { ok: true };
  try {
    return await opts.verify(value);
  } catch (err) {
    return { ok: false, reason: `verify threw: ${(err as Error).message}` };
  }
}
