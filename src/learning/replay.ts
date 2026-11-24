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
import { byPriority, lessonApplies, normalizeRule, type Lesson } from './lessons';

export interface ReplayOptions {
  /** Only the most recent N cases (each one costs a real AI call). Default: all. */
  limit?: number;
  /**
   * Golden sample: replay only this many cases per flow, edited cases first (the human's own words are the
   * strongest signal), then the most recent. Keeps broad checks fast.
   */
  sample?: number;
  /** Lessons to treat as active for this replay only. They are never written to `lessons.json`. */
  withLessons?: Lesson[];
}

export interface ReplayCaseResult {
  caseId: string;
  stepName: string;
  /** passed/failed: did today's step produce an output that passes `verify`? skipped: could not replay. */
  status: 'passed' | 'failed' | 'skipped';
  /** Exact `verify()` failure reason (or the provider/skip reason). */
  reason?: string;
  attempts?: number;
  /** The provider threw (offline, no key, rate limit): not a verdict on the output. `reason` has the error. */
  providerError?: boolean;
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
  let cases = opts.limit && opts.limit > 0 ? all.slice(-opts.limit) : all;
  if (opts.sample !== undefined) cases = goldenSample(cases, opts.sample);

  const results: ReplayCaseResult[] = [];
  for (const c of cases) results.push(await replayCase(engine, flow, c, opts.withLessons ?? []));

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

/** Edited cases first, then most recent first; at most `n`. */
export function goldenSample(cases: ReplayCase[], n: number): ReplayCase[] {
  return cases
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Number(b.c.edited) - Number(a.c.edited) || b.i - a.i)
    .slice(0, Math.max(0, n))
    .map(({ c }) => c);
}

/**
 * `assisted` (default): the flow's real ai step, with scoped lessons, recent examples, `context` and retries.
 * `plain`: the same step with only its raw prompt + the case's raw input, no `context`, lessons or examples, and a
 * single shot (`maxRetries: 0`). The `verify`/`parse` are identical, which is what makes `rufus compare` fair.
 */
export type ReplayMode = 'assisted' | 'plain';

export async function replayCase(engine: Engine, flow: Flow, c: ReplayCase, extra: Lesson[], mode: ReplayMode = 'assisted'): Promise<ReplayCaseResult> {
  const base = { caseId: c.id, stepName: c.stepName };
  const skip = (reason: string): ReplayCaseResult => ({ ...base, status: 'skipped', reason });

  let original: RunRecord;
  try {
    original = await engine.store.getRun(c.runId);
  } catch {
    return skip(`The original run ${c.runId} is no longer in the workspace.`);
  }

  // Candidate lessons are layered over the saved ones in memory only; nothing is written.
  const deps = {
    cases: engine.cases,
    lessons: {
      async forScope(q: { flowId?: string; role?: string }): Promise<Lesson[]> {
        const saved = await engine.lessons.forScope(q);
        const seen = new Set(saved.map((l) => `${l.scope}\n${normalizeRule(l.rule)}`));
        const added = extra.filter((l) => lessonApplies(l.scope, q) && !seen.has(`${l.scope}\n${normalizeRule(l.rule)}`));
        return [...saved, ...added].sort(byPriority);
      },
    },
  };
  const memory =
    mode === 'plain'
      ? { lessons: [], examples: [] }
      : await recallMemory(deps, { flowId: flow.meta.id, role: flow.meta.role, stepName: c.stepName, excludeCaseId: c.id });
  const system = buildSystemPrompt(mode === 'plain' ? undefined : flow.meta.role, memory.lessons, memory.examples);
  const ctx = new ReplayContext(engine, flow, c, original, system, mode);

  let flowError: string | undefined;
  try {
    await flow.run(ctx);
  } catch (err) {
    if (!(err instanceof StopReplay)) flowError = err instanceof Error ? err.message : String(err);
  }

  const o = ctx.outcome;
  if (!o) return skip(flowError ?? `The flow no longer reaches step "${c.stepKey}".`);
  if (o.kind === 'error') return { ...base, status: 'failed', reason: `AI provider error: ${o.message}`, providerError: true, before: o.before };

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

export type ParsedScope = { kind: 'global' } | { kind: 'flow'; id: string } | { kind: 'role'; name: string };

export function parseScope(scope: string): ParsedScope {
  if (scope === 'global') return { kind: 'global' };
  const m = /^(flow|role):(.+)$/.exec(scope.trim());
  if (m) return m[1] === 'flow' ? { kind: 'flow', id: m[2]! } : { kind: 'role', name: m[2]! };
  throw new Error(`Unknown scope "${scope}". Use "global", "flow:<id>" or "role:<name>".`);
}

export interface ScopedReplayOptions extends ReplayOptions {
  /**
   * Cases per flow for a golden sample. `global` defaults to 2 so a broad check never replays hundreds of
   * cases; for `flow:` and `role:` scopes it applies only when given.
   */
  samplePerFlow?: number;
}

export interface ScopedReplayReport {
  scope: string;
  /** One report per flow that was replayed. `role:` and `global` leave out flows with no saved cases. */
  flows: ReplayReport[];
  total: number;
  passed: number;
  failed: number;
  improved: number;
  regressed: number;
  skipped: number;
  unchanged: number;
}

export const DEFAULT_GLOBAL_SAMPLE = 2;

/**
 * Replay only what a scope touches:
 * `flow:<id>` -> that flow. `role:<name>` -> flows whose `meta.role` is that role.
 * `global` -> a golden sample (default 2 cases) from every flow that has saved cases.
 */
export async function replayScope(engine: Engine, scope: string, opts: ScopedReplayOptions = {}): Promise<ScopedReplayReport> {
  const parsed = parseScope(scope);
  const { samplePerFlow, ...rest } = opts;
  const sample = samplePerFlow ?? (parsed.kind === 'global' ? DEFAULT_GLOBAL_SAMPLE : undefined);
  if (sample !== undefined && !(sample > 0)) throw new Error('samplePerFlow must be a positive number.');
  const replayOpts: ReplayOptions = { ...rest, ...(sample !== undefined ? { sample } : {}) };

  const flows: ReplayReport[] = [];
  if (parsed.kind === 'flow') {
    flows.push(await replayFlow(engine, parsed.id, replayOpts));
  } else {
    const chosen = engine.listFlows().filter((f) => parsed.kind === 'global' || f.meta.role === parsed.name);
    for (const f of chosen) {
      const report = await replayFlow(engine, f.meta.id, replayOpts);
      if (report.total) flows.push(report);
    }
  }
  const sum = (k: 'total' | 'passed' | 'failed' | 'improved' | 'regressed' | 'skipped' | 'unchanged') =>
    flows.reduce((n, r) => n + r[k], 0);
  return {
    scope,
    flows,
    total: sum('total'),
    passed: sum('passed'),
    failed: sum('failed'),
    improved: sum('improved'),
    regressed: sum('regressed'),
    skipped: sum('skipped'),
    unchanged: sum('unchanged'),
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
    private readonly mode: ReplayMode = 'assisted',
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
        provider: this.engine.providerFor(opts.provider ?? this.flow.meta.provider),
        system: this.system,
        step: name,
        opts: this.mode === 'plain' ? plainOpts(opts, this.input) : opts,
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

/** The bare question: raw prompt + raw input. Nothing code assembled, no retries; same verify and parse. */
function plainOpts<T>(opts: AiStepOptions<T>, input: unknown): AiStepOptions<T> {
  const raw = input === undefined || input === null ? '' : `\n\nInput:\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``;
  return { ...opts, prompt: `${opts.prompt}${raw}`, context: undefined, maxRetries: 0, includeExamples: false };
}

async function check(opts: AiStepOptions<any>, value: unknown): Promise<VerifyResult> {
  if (!opts.verify) return { ok: true };
  try {
    return await opts.verify(value);
  } catch (err) {
    return { ok: false, reason: `verify threw: ${(err as Error).message}` };
  }
}
