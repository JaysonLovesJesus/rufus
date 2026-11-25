import { AiVerificationError } from './ai';
import type {
  CodeStepOptions,
  FlowContext,
  HumanHandoff,
  HumanStepSpec,
  ReplanFeedback,
  Route,
  StageContext,
  StageName,
  StagePlan,
  StagedResult,
  StagedSpec,
  StageTrailEntry,
  Tier,
  VerifyResult,
} from '../types';

/** The Spectrum of Intelligence, cheapest first. A re-plan may move right along it, never left. */
export const ROUTES: readonly Route[] = ['code', 'fast', 'smart', 'human'];

/** Position of a route on the spectrum (0 = code ... 3 = human). */
export const routeRank = (r: Route): number => ROUTES.indexOf(r);

/** The cheapest sensible upgrade after a failed verification: code -> fast -> smart (smart stays smart; a re-plan is not yet a human). */
export const upgradeRoute = (r: Route): Route => (r === 'code' ? 'fast' : 'smart');

export const MAX_REPLANS_LIMIT = 5;
export const DEFAULT_MAX_REPLANS = 1;

/** Saves a stage's outcome under a step name. The engine uses `ctx.code`; replay runs the stage live. */
export type Persist = <T>(stepName: string, fn: () => T | Promise<T>, opts?: CodeStepOptions) => Promise<T>;

const isRoute = (v: unknown): v is Route => typeof v === 'string' && (ROUTES as readonly string[]).includes(v);

function checkPlan(name: string, plan: unknown): asserts plan is StagePlan {
  const p = plan as Partial<StagePlan> | null;
  if (!p || typeof p !== 'object') throw new Error(`Staged step "${name}": plan() must return an object with a goal and a route.`);
  if (typeof p.goal !== 'string' || !p.goal.trim()) throw new Error(`Staged step "${name}": plan() must define a concrete, non-empty goal.`);
  if (!isRoute(p.route)) throw new Error(`Staged step "${name}": plan().route must be one of ${ROUTES.join(', ')} (got ${JSON.stringify(p.route)}).`);
}

function stageContext<I>(ctx: FlowContext<I>, base: { stage: StageName; attempt: number; route?: Route; replan?: ReplanFeedback }): StageContext<I> {
  // Planning and checking are cheap by default; executing uses exactly the planned route.
  const tier: Tier | undefined = base.stage === 'execute' ? (base.route === 'fast' || base.route === 'smart' ? base.route : undefined) : 'fast';
  return {
    runId: ctx.runId,
    input: ctx.input,
    stage: base.stage,
    attempt: base.attempt,
    ...(base.route ? { route: base.route } : {}),
    ...(base.replan ? { replan: base.replan } : {}),
    // The stage itself is already counted in the spectrum, so a code helper inside it is bookkeeping.
    code: (n, fn) => ctx.code(n, fn, { bookkeeping: true }),
    ai: ((n: string, o: Parameters<FlowContext<I>['ai']>[1]) => ctx.ai(n, { ...(tier ? { tier } : {}), ...o } as never)) as FlowContext<I>['ai'],
    escalate: ((n: string, o: never) => ctx.escalate(n, o)) as FlowContext<I>['escalate'],
    human: (n, spec) => ctx.human(n, spec),
    staged: (n, spec) => ctx.staged(n, spec),
  };
}

function verdictOf(v: VerifyResult | undefined): VerifyResult {
  if (v && v.ok === true) return { ok: true };
  const reason = v && v.ok === false && typeof v.reason === 'string' && v.reason.trim() ? v.reason : 'verification failed';
  return { ok: false, reason };
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function defaultCard<P extends StagePlan>(name: string, h: HumanHandoff<P>): HumanStepSpec {
  const shown = h.lastResult === undefined ? undefined : typeof h.lastResult === 'string' ? h.lastResult : JSON.stringify(h.lastResult, null, 2);
  return {
    title: `Needs you: ${name}`,
    summary: `Goal: ${h.goal}\n${h.reason}`,
    ...(shown ? { details: clip(shown, 2000) } : {}),
    allowFreeText: true,
  };
}

/**
 * The three-stage loop behind `ctx.staged`. Pure orchestration over a flow context, so the engine and replay share it.
 *
 *   plan(input)        -> goal + route, chosen upfront (code > fast > smart > human)
 *   execute(plan)      -> the work, on that route only
 *   verify(result, plan) -> did we reach the goal?
 *
 * A failed verification feeds its reason back into `plan` (which sees `ctx.replan`) and the route can only go up. After
 * `maxReplans` re-plans, or when a plan routes to `human`, a person decides. Every stage outcome is saved, so a resumed
 * run never repeats a model call it already paid for, and the path taken is the same on every replay.
 */
export async function runStaged<I, R, P extends StagePlan>(
  ctx: FlowContext<I>,
  name: string,
  spec: StagedSpec<I, R, P>,
  persist: Persist = (stepName, fn, opts) => ctx.code(stepName, fn, opts),
): Promise<StagedResult<R, P>> {
  const maxReplans = Math.min(MAX_REPLANS_LIMIT, Math.max(0, Math.floor(spec.maxReplans ?? DEFAULT_MAX_REPLANS)));
  const trail: StageTrailEntry[] = [];
  let feedback: ReplanFeedback | undefined;
  let previous: { route: Route } | undefined;

  const toHuman = async (plan: P, reason: string, attempt: number, lastResult?: unknown): Promise<StagedResult<R, P>> => {
    const handoff: HumanHandoff<P> = { reason, goal: plan.goal, plan, ...(lastResult !== undefined ? { lastResult } : {}), trail: [...trail] };
    const card = typeof spec.human === 'function' ? spec.human(handoff) : (spec.human ?? defaultCard(name, handoff));
    const answer = await ctx.human(`${name}.human`, card);
    return { status: 'human', route: 'human', goal: plan.goal, plan, answer, reason, replans: attempt, trail, ...(lastResult !== undefined ? { lastResult } : {}) };
  };

  for (let attempt = 0; ; attempt++) {
    const suffix = attempt ? `.r${attempt}` : '';

    // ---- Stage 1: plan ----
    const raw = await persist(`${name}.plan${suffix}`, () => spec.plan(ctx.input, stageContext(ctx, { stage: 'plan', attempt, replan: feedback })));
    checkPlan(name, raw);
    // A re-plan never goes cheaper than the route that just failed.
    const route: Route = previous && routeRank(raw.route) < routeRank(previous.route) ? previous.route : raw.route;
    const plan = (route === raw.route ? raw : { ...raw, route }) as P;

    if (route === 'human') {
      const reason = plan.reason?.trim() || (attempt ? `re-plan after "${feedback?.reason}" routed to a human` : 'plan routed this to a human');
      trail.push({ attempt, route, goal: plan.goal, outcome: 'human', reason });
      return toHuman(plan, reason, attempt, feedback?.lastResult);
    }

    // ---- Stage 2: execute (the planned route only) ----
    const executed = await persist(
      `${name}.execute${suffix}`,
      async (): Promise<{ ok: true; value: R } | { ok: false; reason: string }> => {
        try {
          return { ok: true, value: await spec.execute(plan, stageContext(ctx, { stage: 'execute', attempt, route, replan: feedback })) };
        } catch (err) {
          // A model that could not pass its own step check is a failed attempt to re-plan, not a crashed run.
          if (err instanceof AiVerificationError) return { ok: false, reason: err.reason };
          throw err;
        }
      },
      { bookkeeping: route !== 'code' },
    );

    // ---- Stage 3: verify (against the Stage 1 goal) ----
    const verdict: VerifyResult = executed.ok
      ? await persist(`${name}.verify${suffix}`, async () => verdictOf(await spec.verify(executed.value, plan, stageContext(ctx, { stage: 'verify', attempt, route, replan: feedback }))))
      : { ok: false, reason: executed.reason };

    if (verdict.ok) {
      trail.push({ attempt, route, goal: plan.goal, outcome: 'passed' });
      return { status: 'passed', route, goal: plan.goal, plan, result: (executed as { value: R }).value, replans: attempt, trail };
    }

    trail.push({ attempt, route, goal: plan.goal, outcome: 'failed', reason: verdict.reason });
    const lastResult = executed.ok ? executed.value : undefined;
    if (attempt >= maxReplans) {
      return toHuman(plan, `verification still failed after ${attempt} re-plan(s): ${verdict.reason}`, attempt, lastResult);
    }
    feedback = {
      attempt: attempt + 1,
      reason: verdict.reason,
      previousRoute: route,
      previousGoal: plan.goal,
      previousPlan: plan,
      ...(lastResult !== undefined ? { lastResult } : {}),
      nextRoute: upgradeRoute(route),
      trail: [...trail],
    };
    previous = { route };
  }
}
