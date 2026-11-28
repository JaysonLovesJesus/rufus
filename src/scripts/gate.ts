import type { Receipt, ToolManifest, TrustLevel } from '../types';
import { capLevel, ceilingFor, defaultLevel, stricterOf, type ApprovalStore } from './approvals';
import { isReadOnlyShellCommand } from './shell-safety';
import { validateInput } from './standard';

export type GateLevel = TrustLevel | 'never';

/** What the ladder decided for one tool call or action: run it now, or the receipt of what happened instead. */
export type GateDecision = { run: true; level: 'act_and_report' | 'act_quietly' } | { run: false; level: GateLevel; receipt: Receipt };

/** What a draft waiting on the owner needs next, the same however the draft was queued. */
export const AWAITING_APPROVAL_NEXT =
  'Ask the owner (approvals.approve on his yes, approvals.deny on his no), and schedule a chase for this gap in case there is no answer. ' +
  'In the ask, say in plain words exactly what will change, and that replying "yes" in chat approves it: there is no button, and no ids or tool names.';

/** The hint an act_and_report receipt carries so Decide tells the owner what changed. */
export const REPORT_HINT = 'report_to_owner';

/**
 * The rung a tool or action is on: trust.json through the store, or the manifest's own default rung when there is no
 * store. With the call's input, its scope (who and what it touches) and its reversibility count too.
 */
export async function resolveLevel(manifest: ToolManifest, approvals?: ApprovalStore, input?: Record<string, unknown>): Promise<GateLevel> {
  return approvals ? approvals.levelFor(manifest, input) : stricterOf(capLevel(defaultLevel(manifest), manifest), ceilingFor(manifest, input));
}

/**
 * The trust gate, the one place every tool call and every action (a step of a tool's work, or of the engine) is decided:
 * blocked never runs, rehearse records what would have run, draft queues it for the owner's yes, and the two act rungs run.
 */
export async function passGate(opts: {
  manifest: ToolManifest;
  input: Record<string, unknown>;
  approvals?: ApprovalStore;
  now: Date;
  gapId?: string;
  /** Set when this is a step of another tool's work, so the receipt says whose. */
  stepOf?: string;
}): Promise<GateDecision> {
  const { manifest, input } = opts;
  const rawRung = await resolveLevel(manifest, opts.approvals, input);
  // Provably read-only shell inspections (ffprobe, ls, git status, etc.) run quietly without nagging for approval,
  // while writes, redirects, subshells, or blocked/rehearse settings keep their strict rung.
  const rung: GateLevel =
    manifest.id === 'shell.run' &&
    rawRung === 'draft' &&
    typeof input.command === 'string' &&
    isReadOnlyShellCommand(input.command)
      ? 'act_quietly'
      : rawRung;
  // Spend counts in the gate as a runaway guard: a tool that looks stuck in a loop asks before its next call.
  const runaway = (rung === 'act_and_report' || rung === 'act_quietly') && opts.approvals ? await opts.approvals.spend.runaway(manifest.id, opts.now) : undefined;
  const level: GateLevel = runaway ? 'draft' : rung;
  const at = opts.now.toISOString();
  const what = opts.stepOf ? `${manifest.id} (a step of ${opts.stepOf})` : manifest.id;
  const base = { toolId: manifest.id, effect: manifest.effect, durationMs: 0, changes: [] as string[], at };
  if (level === 'never') {
    return {
      run: false,
      level,
      receipt: {
        ...base,
        status: 'failed',
        summary: `Blocked: ${what} is at "blocked" on the trust ladder, so it never runs. Nothing ran. Close this gap another way (a different tool, or a draft the owner can act on), or ask the owner whether to unblock it.`,
        error: 'neverAllow',
      },
    };
  }
  if (level === 'rehearse') {
    return {
      run: false,
      level,
      receipt: {
        ...base,
        status: 'ok',
        summary: `Rehearsed only: ${what} is at "rehearse" on the trust ladder, so it did not run and nothing changed. Would have run ${manifest.id}(${JSON.stringify(input).slice(0, 200)}). Don't report it as done: close the gap another way, or ask the owner to raise its trust.`,
        data: { rehearsed: true, toolId: manifest.id, input },
      },
    };
  }
  if (level === 'draft') {
    const errors = validateInput(input, manifest.inputSchema);
    if (errors.length) {
      return {
        run: false,
        level,
        receipt: { ...base, status: 'invalid_input', summary: `Invalid input for ${manifest.id}: ${errors.join('; ')}. Nothing ran. Fix the input to match its inputSchema on the Desk.`, error: errors.join('; ') },
      };
    }
    if (!opts.approvals) {
      return {
        run: false,
        level,
        receipt: { ...base, status: 'pending_approval', summary: `${what} is at "draft" on the trust ladder and there is no approval queue to put it in. Nothing ran.` },
      };
    }
    const saved = await opts.approvals.enqueue(manifest.id, input, opts.now, opts.gapId);
    return {
      run: false,
      level,
      receipt: {
        ...base,
        status: 'pending_approval',
        summary: runaway
          ? `Held by the runaway guard (${saved.id}): ${what} normally runs on its own, but it made ${runaway.reason} ($${runaway.todayUsd.toFixed(2)} today), which looks like a loop. Nothing ran yet. ${AWAITING_APPROVAL_NEXT} Say how often it ran and what it spent.`
          : `Draft awaiting owner approval (${saved.id}): ${what}. Nothing ran yet. ${AWAITING_APPROVAL_NEXT}`,
        data: { approvalId: saved.id, toolId: manifest.id, input, ...(runaway ? { runaway } : {}) },
      },
    };
  }
  return { run: true, level };
}

/** After a call ran at act_and_report: anything it changed is reported to the owner through the receipt's report hint. */
export function markForReport(level: GateLevel, receipt: Receipt): Receipt {
  if (level !== 'act_and_report' || receipt.status !== 'ok' || !receipt.changes.length) return receipt;
  if (receipt.nextHints?.includes(REPORT_HINT)) return receipt;
  return { ...receipt, nextHints: [...(receipt.nextHints ?? []), REPORT_HINT] };
}
