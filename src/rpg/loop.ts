import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LosslessEvent, ModelProvider, Receipt, RpgAction, RpgTurnTrace, RpgWakeReport, ToolManifest } from '../types';
import { loadBrainSkill } from '../brains/states';
import { loadWakes } from '../eval/flight-recorder';
import type { EventStore } from '../events/store';
import type { WatchStore } from '../events/watches';
import type { GapStore } from '../gaps/store';
import type { ApprovalStore } from '../scripts/approvals';
import type { ToolRegistry } from '../scripts/registry';

function formatLocalTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export interface RpgWakeOptions {
  workspaceDir: string;
  trigger: LosslessEvent;
  reasoningProvider: ModelProvider;
  reasoningModel?: string;
  registry: ToolRegistry;
  events: EventStore;
  approvals?: ApprovalStore;
  gaps?: GapStore;
  watches?: WatchStore;
  maxTurns?: number;
  topKTools?: number;
  topKContext?: number;
  now?: () => Date;
  onReceipt?: (receipt: Receipt) => void;
  /** Optional callback whenever wake context (arrivals + related events) is updated. */
  onWakeContext?: (ctx: { trigger: LosslessEvent; arrivals: readonly LosslessEvent[]; relatedEvents: readonly LosslessEvent[] }) => void;
  /** Optional live poller: drains newly arrived events between RPG turns so the consciousness folds them in live. */
  pollIncoming?: () => Promise<LosslessEvent[]>;
  /** Extra events that arrived in the same batch as the trigger. */
  additionalEvents?: LosslessEvent[];
}

const DECIDE_CORE_RULES = [
  'You are Decide — the single stream of consciousness in Rufus (one turn at a time).',
  'Each turn you inspect The Desk and choose EXACTLY ONE tool to run next. While it runs, you switch OFF; you wake on the next turn with its exact immutable Receipt.',
  'Reply with ONLY a JSON object:',
  '{"thought":"brief 1-line reasoning","toolId":"<id>","input":{...}}',
  'Hard Rules:',
  '- Actions NEVER happen in your head. Pick the actual tool (`brain.investigate`, `brain.plan`, `brain.create`, `brain.verify`, `send_message`, `gaps.*`, `watch.set`, `Act` tools, or `sleep`).',
  '- Trust ONLY Receipts. Never guess facts or close a Gap without `brain.verify` passing.',
  '- Call `sleep` once all open Gaps are closed or genuinely waiting.',
].join('\n');

/** Parses a single RPG action JSON object cleanly from model output (tolerates code fences). */
export function parseRpgAction(raw: string): RpgAction {
  const text = (raw ?? '').trim();
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>;
      const toolId = typeof parsed.toolId === 'string' ? parsed.toolId.trim() : typeof parsed.tool === 'string' ? parsed.tool.trim() : '';
      const input = parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input) ? (parsed.input as Record<string, unknown>) : {};
      const thought = typeof parsed.thought === 'string' ? parsed.thought.trim() : undefined;
      if (toolId) return { toolId, input, ...(thought ? { thought } : {}) };
    } catch {
      /* fall through */
    }
  }
  return { toolId: 'sleep', input: { reason: 'unparseable model output' } };
}

function formatToolsForPrompt(tools: readonly ToolManifest[]): string {
  return tools
    .map(
      (t) =>
        `- ${t.id} [${t.effect}${t.requiresApproval ? ', requiresApproval' : ''}]: ${t.description}\n` +
        `  whenToUse: ${t.whenToUse.join('; ')}\n` +
        `  inputSchema: ${JSON.stringify(t.inputSchema)}`,
    )
    .join('\n');
}

function formatReceiptsForPrompt(receipts: readonly Receipt[]): string {
  if (!receipts.length) return '(none yet — this is turn 1)';
  return receipts
    .map(
      (r, i) =>
        `Turn ${i + 1}: ${r.toolId} -> ${r.status} (${r.durationMs}ms)\n` +
        `  summary: ${r.summary}` +
        (r.changes.length ? `\n  changes: ${r.changes.join('; ')}` : '') +
        (r.data !== undefined ? `\n  data: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}` : '') +
        (r.error ? `\n  error: ${r.error}` : '') +
        (r.brokenWarning ? `\n  WARNING: ${r.brokenWarning}` : '') +
        (r.nextHints?.length ? `\n  nextHints: ${r.nextHints.join(', ')}` : ''),
    )
    .join('\n\n');
}

/** Builds the deterministic Short-Term Memory ("The Desk"): Gap Board, active watches, pending approvals, recent Rufus actions, and projects. */
async function gatherDeskState(opts: { workspaceDir: string; gaps?: GapStore; watches?: WatchStore }): Promise<string> {
  const parts: string[] = [];

  // 1. The Gap Board (top-down direction)
  if (opts.gaps) {
    parts.push(`Gap Board:\n${await opts.gaps.formatForDesk()}`);
  }

  // 2. Active Watches / Timers
  if (opts.watches) {
    const activeW = await opts.watches.active();
    if (activeW.length) {
      parts.push(
        `Active Watches:\n` +
          activeW.map((w) => `- ${w.id} [${w.kind}${w.gapId ? ` / ${w.gapId}` : ''}]: ${w.label}${w.threadId ? ` (${w.threadId})` : w.fireAt ? ` (at ${formatLocalTime(w.fireAt)})` : ''}`).join('\n'),
      );
    }
  }

  // 3. Pending Approvals awaiting direct owner confirmation
  try {
    const pending = JSON.parse(await fs.readFile(path.join(opts.workspaceDir, 'approvals.json'), 'utf8')) as Array<{ id: string; toolId: string; input: Record<string, unknown> }>;
    if (Array.isArray(pending) && pending.length) {
      parts.push(
        `Pending Approvals (call approvals.approve if user says yes, or approvals.deny if user says no):\n` +
          pending.map((a) => `- ${a.id}: ${a.toolId}(${JSON.stringify(a.input).slice(0, 180)})`).join('\n'),
      );
    }
  } catch {
    /* no pending approvals */
  }

  // 4. Rufus's Own Recent Actions (from wakes.jsonl — zero AI summarizing)
  try {
    const recentWakes = (await loadWakes(opts.workspaceDir)).filter((w) => w.acted).slice(-5);
    if (recentWakes.length) {
      parts.push(
        `Your Recent Actions:\n` +
          recentWakes
            .map((w) => {
              const tools = w.trace.filter((t) => t.toolId !== 'sleep' && t.receipt.status === 'ok').map((t) => `${t.toolId}: ${t.receipt.summary.slice(0, 90)}`);
              return `- [${formatLocalTime(w.at)}] (${w.trigger.source}/${w.trigger.kind}) -> ${tools.slice(-3).join(' | ')}`;
            })
            .join('\n'),
      );
    }
  } catch {
    /* no wakes yet */
  }

  // 5. Active projects (compact list)
  try {
    const projects = (await fs.readdir(path.join(opts.workspaceDir, 'projects'))).filter((f) => f.endsWith('.md') && !f.startsWith('.')).map((f) => f.replace(/\.md$/, '')).sort();
    if (projects.length) parts.push(`Active projects (${projects.length}): ${projects.join(', ')}`);
  } catch {
    /* no projects dir */
  }

  return parts.length ? parts.join('\n\n') : '(none)';
}

/**
 * Runs one complete Awake cycle:
 * The Desk (short-term code + long-term recall) -> Decide picks 1 tool -> Decide OFF -> Tool runs (Trust Gate) -> immutable Receipt -> repeat until `sleep` or turn cap.
 */
export async function runRpgWake(opts: RpgWakeOptions): Promise<RpgWakeReport> {
  const wakeId = `wake_${randomUUID().slice(0, 8)}`;
  const started = Date.now();
  const maxTurns = Math.max(1, Math.min(50, opts.maxTurns ?? 25));
  const topKTools = opts.topKTools ?? 6;
  const topKContext = opts.topKContext ?? 6;
  const now = opts.now ?? (() => new Date());

  const trace: RpgTurnTrace[] = [];
  const receipts: Receipt[] = [];
  const sentMessages: string[] = [];
  const pendingApprovals: RpgWakeReport['pendingApprovals'] = [];
  let slept = false;
  let sleepReason: string | undefined;

  const decideSkill = await loadBrainSkill(opts.workspaceDir, 'DECIDE');
  const systemPrompt = `${DECIDE_CORE_RULES}\n\n${decideSkill}`;
  const arrivals: LosslessEvent[] = [...(opts.additionalEvents ?? [])];

  // Isolated short-term conversation strictly between YOU and the OWNER (never evicted by third-party Beeper chats!)
  const recentOwnerChat = (await opts.events.recent(200))
    .filter((e) => e.source === 'message' && (e.kind === 'owner_direct' || e.kind === 'assistant_sent') && e.id !== opts.trigger.id)
    .slice(-10);
  const recentChatIds = recentOwnerChat.map((e) => e.id);
  const recentChatBlock = recentOwnerChat.length
    ? recentOwnerChat.map((e) => `- [${formatLocalTime(e.timestamp)}] ${e.kind === 'assistant_sent' ? 'You (Rufus)' : e.actor || 'Owner'}: ${e.text}`).join('\n')
    : '(none)';

  // Long-term semantic recall (excluding trigger & already-shown recent owner chat)
  const related = await opts.events.search(opts.trigger.text, topKContext, { excludeIds: [opts.trigger.id, ...recentChatIds] });
  const relatedEvents = related.map((r) => r.event);
  opts.onWakeContext?.({ trigger: opts.trigger, arrivals, relatedEvents });
  const relatedBlock = related.length
    ? related
        .map(
          (r) =>
            `- [${formatLocalTime(r.event.timestamp)}] (${r.event.source}${r.event.actor ? ` / ${r.event.actor}` : ''}${r.event.deleted ? ' / DELETED' : ''}): ${r.event.text}` +
            (r.event.reactions?.length ? ` [reactions: ${r.event.reactions.map((x) => x.emoji).join(' ')}]` : ''),
        )
        .join('\n')
    : '(none)';

  let turns = 0;
  for (let turn = 0; turn < maxTurns; turn++) {
    turns = turn + 1;
    // Between turns (while Decide is OFF), drain any new owner messages that arrived while working
    if (opts.pollIncoming) {
      const fresh = await opts.pollIncoming().catch(() => []);
      for (const f of fresh) {
        await opts.events.append(f);
        arrivals.push(f);
      }
      if (fresh.length) opts.onWakeContext?.({ trigger: opts.trigger, arrivals, relatedEvents });
    }
    const deskState = await gatherDeskState({ workspaceDir: opts.workspaceDir, ...(opts.gaps ? { gaps: opts.gaps } : {}), ...(opts.watches ? { watches: opts.watches } : {}) });
    const arrivalBlock = arrivals.length
      ? `NEW messages arrived while you were working:\n${arrivals
          .map((e) => `- [${formatLocalTime(e.timestamp)}] (${e.source}${e.actor ? ` / ${e.actor}` : ''}): ${e.text}`)
          .join('\n')}`
      : '';
    const replyToText = typeof opts.trigger.metadata?.replyToText === 'string' ? opts.trigger.metadata.replyToText : '';
    const query = [opts.trigger.text, replyToText, ...arrivals.map((a) => a.text), ...receipts.slice(-2).map((r) => `${r.summary} ${r.error ?? ''} ${(r.nextHints ?? []).join(' ')}`)].join(' ');
    const tools = await opts.registry.selectForPrompt(query, topKTools);

    const triggerMsgId = opts.trigger.metadata?.messageId !== undefined ? ` | messageId:${opts.trigger.metadata.messageId}` : '';
    const replyLine = replyToText ? `\n  (in reply to: "${replyToText}")` : '';
    const prompt = [
      `Current local time: ${formatLocalTime(now())}`,
      `Workspace path: ${opts.workspaceDir}`,
      `THE DESK (Short-Term Memory — Deterministic Code):\n${deskState}`,
      `Our Recent Conversation (isolated owner <-> Rufus thread):\n${recentChatBlock}`,
      `Incoming Event:\n[${formatLocalTime(opts.trigger.timestamp)}] (${opts.trigger.source}/${opts.trigger.kind}${opts.trigger.actor ? ` / ${opts.trigger.actor}` : ''}${triggerMsgId}${opts.trigger.deleted ? ' / DELETED' : ''}): ${opts.trigger.text}${replyLine}`,
      ...(arrivalBlock ? [arrivalBlock] : []),
      `Long-Term Recall (semantic search over Event Log):\n${relatedBlock}`,
      `Receipts This Wake (exact ground truth):\n${formatReceiptsForPrompt(receipts)}`,
      `Available Tools (top ${topKTools} + core brain/gap/trust tools):\n${formatToolsForPrompt(tools)}`,
      `Turn ${turns} of ${maxTurns}. Reply with ONLY JSON {"thought":"...","toolId":"...","input":{...}}.`,
    ].join('\n\n');

    const raw = await opts.reasoningProvider.complete({
      system: systemPrompt,
      prompt,
      ...(opts.reasoningModel ? { model: opts.reasoningModel } : {}),
    });
    const action = parseRpgAction(raw);

    // Model is now OFF. Engine executes through the 4-Level Trust Ladder.
    const manifest = opts.registry.get(action.toolId)?.manifest;
    const trustLevel = opts.approvals && manifest ? await opts.approvals.levelFor(manifest) : manifest?.requiresApproval ? 'draft' : 'act_quietly';

    let receipt: Receipt;
    if (trustLevel === 'never') {
      receipt = {
        toolId: action.toolId,
        effect: manifest?.effect ?? 'write',
        status: 'failed',
        durationMs: 0,
        summary: `Blocked by Trust Table (neverAllow): ${action.toolId}.`,
        changes: [],
        error: 'neverAllow',
        at: now().toISOString(),
      };
    } else if (trustLevel === 'rehearse') {
      receipt = {
        toolId: action.toolId,
        effect: manifest?.effect ?? 'write',
        status: 'ok',
        durationMs: 0,
        summary: `[REHEARSE ONLY — not executed] Would have run ${action.toolId}(${JSON.stringify(action.input).slice(0, 200)}).`,
        changes: [],
        data: { rehearsed: true, toolId: action.toolId, input: action.input },
        at: now().toISOString(),
      };
    } else {
      const approved = trustLevel === 'act_and_report' || trustLevel === 'act_quietly';
      receipt = await opts.registry.call(action.toolId, action.input, {
        workspaceDir: opts.workspaceDir,
        now: now(),
        ...(approved ? { approved: true } : {}),
      });
      if (receipt.status === 'pending_approval' && opts.approvals) {
        const saved = await opts.approvals.enqueue(action.toolId, action.input, now());
        receipt.summary = `Draft awaiting owner approval (${saved.id}): ${action.toolId}. Ask the user for confirmation.`;
        receipt.data = { approvalId: saved.id, toolId: action.toolId, input: action.input };
      } else if (trustLevel === 'act_and_report' && receipt.status === 'ok' && manifest?.effect === 'write' && action.toolId !== 'send_message') {
        receipt.nextHints = [...(receipt.nextHints ?? []), 'report_to_owner'];
      }
    }
    receipts.push(receipt);
    trace.push({ turn: turns, ...(action.thought ? { thought: action.thought } : {}), toolId: action.toolId, input: action.input, receipt });
    opts.onReceipt?.(receipt);

    if (receipt.status === 'pending_approval') {
      pendingApprovals.push({ toolId: action.toolId, input: action.input, receipt });
    }
    if (action.toolId === 'send_message' && receipt.status === 'ok') {
      const sent = (receipt.data as { text?: string } | undefined)?.text;
      if (sent) sentMessages.push(sent);
    }
    if (action.toolId === 'sleep') {
      slept = true;
      sleepReason = String(action.input.reason ?? 'done');
      break;
    }
  }

  const acted = receipts.some((r) => r.toolId !== 'sleep' && r.status === 'ok');
  return {
    wakeId,
    triggerEventId: opts.trigger.id,
    turns,
    durationMs: Date.now() - started,
    trace,
    receipts,
    sentMessages,
    pendingApprovals,
    slept,
    ...(sleepReason ? { sleepReason } : {}),
    acted,
  };
}
