import type { ApprovalStore } from '../scripts/approvals';
import type { ToolRegistry } from '../scripts/registry';
import type { GapStore } from '../gaps/store';
import { ROOT_GAP_ID } from '../gaps/store';
import type { CreditTracker } from '../providers/credits';

export interface ZeroAiDeps {
  workspaceDir: string;
  registry: ToolRegistry;
  gaps: GapStore;
  approvals: ApprovalStore;
  credits?: CreditTracker;
  primaryProvider?: string;
  now?: () => Date;
}

export interface ZeroAiReply {
  intent: 'approve' | 'deny' | 'calendar' | 'gaps' | 'status' | 'offline_notice';
  text: string;
  acted: boolean;
}

const APPROVE_RE = /^\s*(?:(?:yes|yep|yeah|sure|ok(?:ay)?)[,\s]+)?(?:yes|yep|yeah|approve(?: it)?|go ahead|do it|send it|looks good|sounds good)\s*[.!]?\s*$/i;
const DENY_RE = /^\s*(?:(?:no|nope)[,\s]+)?(?:no|nope|cancel(?: it)?|deny(?: it)?|skip(?: it)?|don't|do not|stop)\s*[.!]?\s*$/i;
const CALENDAR_RE = /\b(?:calendar|schedule|meetings?|events?|agenda|what(?:'s| is) on (?:today|tomorrow|my day))\b/i;
const GAPS_RE = /\b(?:gaps?|what are you working on|open items?|priorities|todo|to-do)\b/i;
const STATUS_RE = /\b(?:status|you there|are you up|alive|health|credits?|limit|reset|online)\b/i;

/**
 * Natural-language Zero-AI fallback ($0, pure code, no slash commands).
 * Runs ONLY when every configured LLM provider is unavailable or rate-limited,
 * so Rufus can still answer common questions, execute safe approvals, and tell the owner when full AI resets.
 */
export async function handleZeroAiMessage(text: string, deps: ZeroAiDeps): Promise<ZeroAiReply> {
  const now = deps.now?.() ?? new Date();
  const limit = deps.credits && deps.primaryProvider ? await deps.credits.activeLimit(deps.primaryProvider, now) : undefined;
  const resetNote = limit
    ? ` My main AI hit its ${limit.window} limit and resets around ${limit.resetLabel ?? new Date(limit.resetsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`
    : ' My AI models are temporarily unavailable right now.';

  const pending = await deps.approvals.listPending();

  // 1. Plain-English approval / denial when there is a pending Trust-Ladder draft
  if (pending.length && APPROVE_RE.test(text)) {
    const item = pending[pending.length - 1]!;
    const taken = await deps.approvals.take(item.id);
    if (taken) {
      const rec = await deps.registry.call(taken.toolId, taken.input, {
        workspaceDir: deps.workspaceDir,
        now,
        approved: true,
        ownerApproved: true,
        ...(taken.gapId ? { gapId: taken.gapId } : {}),
      });
      return {
        intent: 'approve',
        acted: rec.status === 'ok',
        text: rec.status === 'ok'
          ? `Done — I ran ${taken.toolId}: ${rec.summary}.${resetNote}`
          : `I tried to run ${taken.toolId}, but it failed: ${rec.summary}.${resetNote}`,
      };
    }
  }

  if (pending.length && DENY_RE.test(text)) {
    const item = pending[pending.length - 1]!;
    await deps.approvals.take(item.id);
    return {
      intent: 'deny',
      acted: true,
      text: `Got it — cancelled the pending ${item.toolId} draft.${resetNote}`,
    };
  }

  // 2. Plain-English calendar / schedule question
  if (CALENDAR_RE.test(text) && deps.registry.get('calendar.today')) {
    const rec = await deps.registry.call('calendar.today', { days: 2 }, { workspaceDir: deps.workspaceDir, now });
    if (rec.status === 'ok') {
      const body = typeof rec.data === 'string' ? rec.data.slice(0, 1200) : rec.summary;
      return {
        intent: 'calendar',
        acted: false,
        text: `Here's what's on your calendar (pulled directly without AI): ${body}${resetNote}`,
      };
    }
  }

  // 3. Plain-English gaps / what are you working on
  if (GAPS_RE.test(text)) {
    const open = (await deps.gaps.unclosed()).filter((g) => g.id !== ROOT_GAP_ID && !g.standing);
    const list = open.length
      ? open.slice(0, 6).map((g) => `• ${g.title} [${g.status}]`).join('\n')
      : 'No active non-standing gaps right now.';
    return {
      intent: 'gaps',
      acted: false,
      text: `Here's what's currently on your board:\n${list}${resetNote}`,
    };
  }

  // 4. Plain-English status / health check
  if (STATUS_RE.test(text)) {
    const openCount = (await deps.gaps.unclosed()).filter((g) => g.id !== ROOT_GAP_ID && !g.standing).length;
    const pendingNote = pending.length ? ` You have ${pending.length} draft(s) waiting for your yes/no.` : '';
    return {
      intent: 'status',
      acted: false,
      text: `I'm awake in low-power code mode — senses and memory are still running, with ${openCount} active gap(s) on the board.${pendingNote}${resetNote}`,
    };
  }

  // 5. Default natural heads-up for anything that needs full AI
  const pendingHint = pending.length ? ` You can also reply "yes" or "no" to handle the pending ${pending[pending.length - 1]!.toolId} draft.` : '';
  return {
    intent: 'offline_notice',
    acted: false,
    text: `I got your message and saved it.${resetNote} I'll pick this right up as soon as a model is back — in the meantime you can ask me about your calendar, your gaps, or status.${pendingHint}`,
  };
}
