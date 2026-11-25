import { validateTrigger } from '../scheduler/triggers';
import type { Flow, FlowContext, FlowMeta, StagePlan, StagedResult, StagedSpec } from '../types';

/**
 * Define a flow. The function re-runs from the top on every resume; `ctx.code`, `ctx.ai` and
 * `ctx.human` replay their saved results, so keep everything outside those steps deterministic.
 */
export function defineFlow<I = unknown, O = unknown>(
  meta: FlowMeta,
  run: (ctx: FlowContext<I>) => Promise<O>,
): Flow<I, O> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(meta.id)) {
    throw new Error(`Invalid flow id "${meta.id}": use letters, numbers, ".", "_" or "-".`);
  }
  if (meta.trigger) validateTrigger(meta.trigger);
  return Object.freeze({ meta: Object.freeze({ ...meta }), run });
}

/**
 * Define a flow that is one three-stage unit: `plan` (gather context, set the goal, pick the route upfront) -> `execute`
 * (on that route only) -> `verify` (against the goal), with re-plan escalation when verification fails. Its output is
 * the `StagedResult`. For a stage inside a bigger flow, call `ctx.staged(name, spec)` instead.
 */
export function defineStagedFlow<I = unknown, R = unknown, P extends StagePlan = StagePlan>(meta: FlowMeta, spec: StagedSpec<I, R, P>): Flow<I, StagedResult<R, P>> {
  return defineFlow<I, StagedResult<R, P>>(meta, (ctx) => ctx.staged(meta.id, spec));
}

export function isFlow(value: unknown): value is Flow {
  const v = value as Flow | null;
  return !!v && typeof v === 'object' && typeof v.run === 'function' && typeof v.meta?.id === 'string';
}
