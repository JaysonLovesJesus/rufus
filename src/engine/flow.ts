import { validateTrigger } from '../scheduler/triggers';
import type { Flow, FlowContext, FlowMeta } from '../types';

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

export function isFlow(value: unknown): value is Flow {
  const v = value as Flow | null;
  return !!v && typeof v === 'object' && typeof v.run === 'function' && typeof v.meta?.id === 'string';
}
