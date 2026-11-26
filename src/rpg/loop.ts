import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LosslessEvent, ModelProvider, Receipt, RpgAction, RpgTurnTrace, RpgWakeReport, ToolManifest } from '../types';
import type { EventStore } from '../events/store';
import type { ToolRegistry } from '../scripts/registry';
import { selectRelevantSkills } from '../skills/skills';

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
  maxTurns?: number;
  topKTools?: number;
  topKContext?: number;
  now?: () => Date;
  onReceipt?: (receipt: Receipt) => void;
  /** Optional live poller: drains newly arrived events between RPG turns so the consciousness folds them in live. */
  pollIncoming?: () => Promise<LosslessEvent[]>;
  /** Extra events that arrived in the same batch as the trigger. */
  additionalEvents?: LosslessEvent[];
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

/** Compact $0 live orientation block (schedule + todos + active projects) injected into Turn 1 of every wake. */
async function gatherLiveContext(workspaceDir: string): Promise<string> {
  const parts: string[] = [];
  // 1. Today's schedule (if anchor.json exists in workspace or ~/.rufus)
  for (const p of [path.join(workspaceDir, 'anchor.json'), path.join(os.homedir(), '.rufus', 'anchor.json')]) {
    try {
      const data = JSON.parse(await fs.readFile(p, 'utf8')) as { schedule?: { date?: string; blocks?: Array<{ title: string; start: string; end: string; status?: string }> } };
      const blocks = (data.schedule?.blocks ?? []).filter((b) => b.status !== 'skipped');
      if (blocks.length) {
        parts.push(`Schedule (${data.schedule?.date ?? 'today'}): ${blocks.map((b) => `${b.title} (${b.start}-${b.end})`).join(', ')}`);
      }
      break;
    } catch {
      /* try next */
    }
  }
  // 2. Open todos from TODOS.md
  try {
    const raw = (await fs.readFile(path.join(workspaceDir, 'TODOS.md'), 'utf8')).trim();
    if (raw) parts.push(`Todos:\n${raw.slice(0, 1200)}`);
  } catch {
    /* no TODOS.md yet */
  }
  // 3. Active projects
  try {
    const projects = (await fs.readdir(path.join(workspaceDir, 'projects'))).filter((f) => f.endsWith('.md') && !f.startsWith('.')).map((f) => f.replace(/\.md$/, '')).sort();
    if (projects.length) parts.push(`Active projects (${projects.length}): ${projects.join(', ')}`);
  } catch {
    /* no projects dir */
  }
  return parts.length ? parts.join('\n') : '(none)';
}

/**
 * Runs one complete Awake cycle:
 * Fresh context -> Opus chooses 1 tool -> Opus OFF -> Tool executes -> immutable Receipt -> repeat until `sleep` or turn cap.
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

  const liveContext = await gatherLiveContext(opts.workspaceDir);
  const arrivals: LosslessEvent[] = [...(opts.additionalEvents ?? [])];
  // Recent conversation (both user & Rufus's own sent messages) so he never repeats himself
  const recentChat = (await opts.events.recent(20))
    .filter((e) => e.source === 'message' && e.id !== opts.trigger.id)
    .slice(-6);
  const recentChatBlock = recentChat.length
    ? recentChat.map((e) => `- [${formatLocalTime(e.timestamp)}] ${e.kind === 'assistant_sent' ? 'You (Rufus)' : e.actor || 'User'}: ${e.text}`).join('\n')
    : '(none)';
  // Retrieve semantically relevant past events once for this wake
  const related = await opts.events.search(opts.trigger.text, topKContext, { excludeIds: [opts.trigger.id] });
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
    // Between turns (while model is OFF), drain any new messages that arrived while working
    if (opts.pollIncoming) {
      const fresh = await opts.pollIncoming().catch(() => []);
      for (const f of fresh) {
        await opts.events.append(f);
        arrivals.push(f);
      }
    }
    const arrivalBlock = arrivals.length
      ? `NEW messages that arrived while you were working (fold these into your current context & plan):\n${arrivals
          .map((e) => `- [${e.timestamp}] (${e.source}${e.actor ? ` / ${e.actor}` : ''}): ${e.text}`)
          .join('\n')}`
      : '';
    const query = [opts.trigger.text, ...arrivals.map((a) => a.text), ...receipts.slice(-2).map((r) => `${r.summary} ${r.error ?? ''} ${(r.nextHints ?? []).join(' ')}`)].join(' ');
    const tools = await opts.registry.selectForPrompt(query, topKTools);
    const skillsBlock = await selectRelevantSkills(opts.workspaceDir, query, { topK: 2 });

    const triggerMsgId = opts.trigger.metadata?.messageId !== undefined ? ` | messageId:${opts.trigger.metadata.messageId}` : '';
    const prompt = [
      `Current local time: ${formatLocalTime(now())}`,
      `Workspace path: ${opts.workspaceDir}`,
      `Live Context (schedule, todos, projects):\n${liveContext}`,
      ...(skillsBlock ? [`Relevant Judgment Skills:\n${skillsBlock}`] : []),
      `Trigger Event:\n[${formatLocalTime(opts.trigger.timestamp)}] (${opts.trigger.source}${opts.trigger.actor ? ` / ${opts.trigger.actor}` : ''}${triggerMsgId}${opts.trigger.deleted ? ' / DELETED' : ''}): ${opts.trigger.text}`,
      ...(arrivalBlock ? [arrivalBlock] : []),
      `Recent Conversation (including what YOU already said — do not repeat yourself):\n${recentChatBlock}`,
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
