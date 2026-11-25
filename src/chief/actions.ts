import { clip } from '../corpus/types';
import { appendSignal } from '../engine/loop-builtins';
import type { LoopPlan, LoopSignal, SignalHandler } from '../engine/loop';

/**
 * Side effects asked for in chat ("text Sam that I'm running late") never run straight from the chat reply. The Chief of
 * Staff queues them as a `chief/action.request` signal in `inbox.jsonl`; this handler turns that into a Master Loop item
 * that always pauses at Verify (it is marked `external`), so it runs only after your "1".
 */

export const CHIEF_ACTION_SURFACE = 'chief';
export const CHIEF_ACTION_KIND = 'action.request';

export interface ChiefAction {
  tool: string;
  args: Record<string, unknown>;
  /** What will happen, in plain words. */
  summary: string;
  /** The message text, for send-like tools (shown as the draft, and replaced by your edit). */
  text?: string;
}

const textOf = (args: Record<string, unknown>): string | undefined => {
  for (const k of ['text', 'message', 'body']) if (typeof args[k] === 'string' && (args[k] as string).trim()) return args[k] as string;
  return undefined;
};

/** "beeper.send to Sam: running late" */
export function describeAction(tool: string, args: Record<string, unknown>): string {
  const to = ['to', 'chatTitle', 'chatId', 'recipient', 'command'].map((k) => args[k]).find((v): v is string => typeof v === 'string' && !!v.trim());
  const text = textOf(args);
  return `${tool}${to ? ` to ${to}` : ''}${text ? `: "${clip(text, 160)}"` : ''}`;
}

/** Queues a side-effect tool call from chat as a Verify item. */
export async function queueChiefAction(dir: string, tool: string, args: Record<string, unknown>, now: Date = new Date()): Promise<LoopSignal> {
  return appendSignal(dir, { surface: CHIEF_ACTION_SURFACE, kind: CHIEF_ACTION_KIND, text: describeAction(tool, args), actor: 'you (chat)', urgency: 'urgent', data: { tool, args } }, now);
}

interface ChiefActionPlan extends LoopPlan {
  tool: string;
  args: Record<string, unknown>;
}

/** The Master Loop handler for actions you asked for in chat. All code, $0; commits only after your yes. */
export const chiefActionHandler: SignalHandler<ChiefAction, ChiefActionPlan> = {
  id: 'chief.action',
  match: (s) => s.surface === CHIEF_ACTION_SURFACE && s.kind === CHIEF_ACTION_KIND,
  maxReplans: 0,
  plan(signal) {
    const tool = typeof signal.data?.tool === 'string' ? signal.data.tool : '';
    const args = signal.data?.args && typeof signal.data.args === 'object' && !Array.isArray(signal.data.args) ? (signal.data.args as Record<string, unknown>) : {};
    if (!tool) throw new Error('chief action has no tool');
    return {
      goal: `Do what you asked: ${describeAction(tool, args)}`,
      actionType: `chief.${tool}`,
      route: 'code',
      sensitivity: ['external'], // asked for in chat or not, it always waits for your "1"
      uses: [tool],
      urgency: 'urgent',
      tool,
      args,
    };
  },
  execute(plan) {
    const text = textOf(plan.args);
    return { tool: plan.tool, args: plan.args, summary: describeAction(plan.tool, plan.args), ...(text ? { text } : {}) };
  },
  crossCheck(result, _plan, _signal, ctx) {
    return ctx.tools.has(result.tool) ? { ok: true } : { ok: false, reason: `no "${result.tool}" tool is configured` };
  },
  async commit(output, plan, _signal, ctx) {
    // An edit typed in chat is the new message text.
    const raw: unknown = output;
    const args = typeof raw === 'string' ? { ...plan.args, text: raw } : { ...plan.args, ...((raw as Partial<ChiefAction> | undefined)?.args ?? {}) };
    await ctx.tools.call(plan.tool, args);
  },
};
