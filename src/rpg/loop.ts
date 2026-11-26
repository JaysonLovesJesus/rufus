import type { LosslessEvent, ModelProvider, Receipt, RpgAction, RpgWakeReport, ToolManifest } from '../types';
import type { EventStore } from '../events/store';
import type { ToolRegistry } from '../scripts/registry';

export interface RpgWakeOptions {
  workspaceDir: string;
  trigger: LosslessEvent;
  reasoningProvider: ModelProvider;
  reasoningModel?: string;
  registry: ToolRegistry;
  events: EventStore;
  maxTurns?: number;
  topKTools?: number;
  topKContext?: number;
  now?: () => Date;
  onReceipt?: (receipt: Receipt) => void;
}

const RPG_SYSTEM = [
  'You are the single stream of consciousness in a turn-based system (like a text-based RPG).',
  'Each turn you wake with fresh context: the trigger event, relevant past events, immutable Receipts from earlier turns in this wake, and available Packaged Scripts.',
  'Choose EXACTLY ONE tool to run next. While it runs, you switch OFF; you will wake on the next turn with its exact Receipt.',
  'Reply with ONLY a JSON object:',
  '{"thought":"brief 1-line reasoning","toolId":"<id>","input":{...}}',
  'Rules:',
  '- Actions NEVER happen in memory. To change anything or message the user, pick the actual tool.',
  '- Trust ONLY Receipts. If a Receipt says status: "failed" or "pending_approval", handle it honestly.',
  '- Call "sleep" as soon as you are done or if nothing needs action.',
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

/**
 * Runs one complete Awake cycle:
 * Fresh context -> Opus chooses 1 tool -> Opus OFF -> Tool executes -> immutable Receipt -> repeat until `sleep` or turn cap.
 */
export async function runRpgWake(opts: RpgWakeOptions): Promise<RpgWakeReport> {
  const maxTurns = Math.max(1, Math.min(12, opts.maxTurns ?? 8));
  const topKTools = opts.topKTools ?? 6;
  const topKContext = opts.topKContext ?? 6;
  const now = opts.now ?? (() => new Date());

  const receipts: Receipt[] = [];
  const sentMessages: string[] = [];
  const pendingApprovals: RpgWakeReport['pendingApprovals'] = [];
  let slept = false;
  let sleepReason: string | undefined;

  // Retrieve semantically relevant past events once for this wake
  const related = await opts.events.search(opts.trigger.text, topKContext, { excludeIds: [opts.trigger.id] });
  const relatedBlock = related.length
    ? related
        .map(
          (r) =>
            `- [${r.event.timestamp}] (${r.event.source}${r.event.actor ? ` / ${r.event.actor}` : ''}${r.event.deleted ? ' / DELETED' : ''}): ${r.event.text}` +
            (r.event.reactions?.length ? ` [reactions: ${r.event.reactions.map((x) => x.emoji).join(' ')}]` : ''),
        )
        .join('\n')
    : '(none)';

  let turns = 0;
  for (let turn = 0; turn < maxTurns; turn++) {
    turns = turn + 1;
    const query = [opts.trigger.text, ...receipts.slice(-2).map((r) => `${r.summary} ${(r.nextHints ?? []).join(' ')}`)].join(' ');
    const tools = await opts.registry.selectForPrompt(query, topKTools);

    const prompt = [
      `Current time: ${now().toISOString()}`,
      `Trigger Event:\n[${opts.trigger.timestamp}] (${opts.trigger.source}${opts.trigger.actor ? ` / ${opts.trigger.actor}` : ''}${opts.trigger.deleted ? ' / DELETED' : ''}): ${opts.trigger.text}`,
      `Relevant Past Events (embedded retrieval):\n${relatedBlock}`,
      `Receipts So Far (exact ground truth):\n${formatReceiptsForPrompt(receipts)}`,
      `Available Packaged Scripts (top ${topKTools} embedded + core):\n${formatToolsForPrompt(tools)}`,
      `Turn ${turns} of ${maxTurns}. Reply with ONLY JSON {"thought":"...","toolId":"...","input":{...}}.`,
    ].join('\n\n');

    const raw = await opts.reasoningProvider.complete({
      system: RPG_SYSTEM,
      prompt,
      ...(opts.reasoningModel ? { model: opts.reasoningModel } : {}),
    });
    const action = parseRpgAction(raw);

    // Model is now OFF. Engine executes the single chosen tool deterministically.
    const receipt = await opts.registry.call(action.toolId, action.input, {
      workspaceDir: opts.workspaceDir,
      now: now(),
    });
    receipts.push(receipt);
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
    triggerEventId: opts.trigger.id,
    turns,
    receipts,
    sentMessages,
    pendingApprovals,
    slept,
    ...(sleepReason ? { sleepReason } : {}),
    acted,
  };
}
