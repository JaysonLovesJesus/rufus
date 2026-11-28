import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LosslessEvent, ModelProvider, NewGapSpec, Receipt, RpgAction, RpgTurnTrace, RpgWakeReport, ToolManifest, WakeEndReason } from '../types';
import { BRAIN_LATEST_DATA_CHARS, BRAIN_OLDER_DATA_CHARS, clipData, loadBrainSkill } from '../brains/states';
import { loadWakes } from '../eval/flight-recorder';
import { formatParty } from '../events/ingest';
import { formatRecall, recallForDesk } from '../events/recall';
import { isRealChange } from './outcome';
import type { EventStore } from '../events/store';
import { servesGap, type WatchItem, type WatchStore } from '../events/watches';
import { checkRepeat, gapText as describeGap, hashSimilarity, loadProjectCards, logEntry, matchProjectCard, raisingEvent, rankGapsInPlay, type Similarity } from '../gaps/context';
import { RECENTLY_CLOSED_MS, ROOT_GAP_ID, isDone, ownerSpoke, resolveGapSource, type Gap, type GapStore } from '../gaps/store';
import type { ApprovalStore } from '../scripts/approvals';
import { AWAITING_APPROVAL_NEXT, passGate } from '../scripts/gate';
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
  /** Optional one-line credit/provider status placed on The Desk ("Credits: active=... | 5h ~XX% left"). */
  getCreditsLine?: () => Promise<string | undefined>;
  now?: () => Date;
  onReceipt?: (receipt: Receipt) => void;
  /** Called once when the wake starts, and after every turn, so watchers (the dashboard) can see the wake as it happens. */
  onWakeStart?: (wakeId: string) => void;
  onTurn?: (turn: RpgTurnTrace) => void;
  /** Optional callback whenever wake context (arrivals + related events) is updated. */
  onWakeContext?: (ctx: { trigger: LosslessEvent; arrivals: readonly LosslessEvent[]; relatedEvents: readonly LosslessEvent[]; conversation: string }) => void;
  /** Optional live poller: drains newly arrived events between RPG turns so the consciousness folds them in live. */
  pollIncoming?: () => Promise<LosslessEvent[]>;
  /** Extra events that arrived in the same batch as the trigger. */
  additionalEvents?: LosslessEvent[];
  /** Ranks text by meaning (defaults to the event store's embedder). */
  similarity?: Similarity;
}

export const DECIDE_CORE_RULES = [
  'You are Decide — the single stream of consciousness in Rufus, one move at a time.',
  'Rufus exists to close the gaps between what the owner wants true and what is true, as fast as possible.',
  'Each turn: read The Desk top-down (the gap tree first, then the new reality), pick the ONE move that closes the biggest gap fastest, and name the gap it serves. While the tool runs you are OFF; next turn you get its exact Receipt.',
  'Reply with ONLY a JSON object:',
  '{"thought":"1 line","gap":"<gap id from the tree>","toolId":"<id>","input":{...}}',
  'or, when the move serves a desired state that is not on the tree yet (code saves it as a gap in the same step):',
  '{"thought":"1 line","gap":{"title":"short name","target":"what the owner wants true, in the owner\'s own words and context (what, in what form, where, by when, why)","reality":"what is true now","source":"owner (the owner asked for it) | observed (you spotted it)","due":"ISO time it must be true by, only when the owner\'s words give one"},"toolId":"<id>","input":{...}}',
  'Hard rules (enforced by code):',
  '- Every move except `sleep` names the gap it serves, or it is rejected and nothing runs.',
  '- The root gap (gap_root) is only for finding gaps: looking around, creating gaps, scheduling the next look. Talking and acting serve a specific gap.',
  "- A proposed gap is not approved yet: until the owner says yes (gaps.approve), you may look into it, ask the owner about it, draft (brain.create) and schedule the ask. Other writes on it are rejected.",
  '- Only a passing `brain.verify` closes a gap, checked against that gap\'s own Target. If the owner\'s words show a closed gap is not done, reopen it (gaps.update status=open) and keep going.',
  '- `sleep` is only accepted when every unclosed gap, root included, has a next move in motion (a watch.set tied to that gap, or a running thread). Waiting passively is not a next move.',
  '- Actions never happen in your head. Trust only Receipts.',
  '- Self-awareness: never invent or guess why you did, said, skipped, or decided something. When the owner asks about your reasoning or past actions, call `self.reasoning` first and explain ONLY from the recorded trace (or say there is no record).',
  "- Each gap's work log is what was already tried. The exact move that already failed, or a third call on the same target with nothing changed, is rejected: change approach instead.",
].join('\n');

/** Allowed on a gap that is only proposed: asking the owner about it, and drafting inside the workspace (nothing leaves it). */
const TALK_TOOLS = new Set(['send_message', 'edit_message', 'react_message', 'brain.create']);
/** Write tools the root gap may use: it only finds gaps, records what it found, and schedules the next look. */
const ROOT_WRITE_TOOLS = new Set(['gaps.create', 'gaps.update', 'watch.set']);
/** How soon Rufus comes back to a gap a wake left without a next move; doubles on each repeat, up to the cap. */
const RESUME_MS = 5 * 60_000;
const RESUME_MAX_MS = 2 * 60 * 60_000;
/** Unreadable replies in a row before a wake stops (the quick return, with backoff, picks it up again). */
const MAX_UNREADABLE_IN_A_ROW = 3;

function parseGapField(v: unknown): string | NewGapSpec | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && o.id.trim()) return o.id.trim();
    const target = typeof o.target === 'string' ? o.target.trim() : '';
    if (!target) return undefined;
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : target.slice(0, 80);
    return {
      title,
      target,
      ...(typeof o.reality === 'string' && o.reality.trim() ? { reality: o.reality.trim() } : {}),
      ...(typeof o.parentId === 'string' && o.parentId.trim() ? { parentId: o.parentId.trim() } : {}),
      ...(o.source === 'owner' || o.source === 'observed' ? { source: o.source } : {}),
      ...(typeof o.due === 'string' && o.due.trim() ? { due: o.due.trim() } : {}),
    };
  }
  return undefined;
}

/** Parses a single RPG action JSON object from model output (tolerates code fences). Unreadable output is marked `invalid`, never turned into `sleep`. */
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
      const gap = parseGapField(parsed.gap ?? parsed.gapId);
      if (toolId) return { toolId, input, ...(thought ? { thought } : {}), ...(gap ? { gap } : {}) };
    } catch {
      /* fall through */
    }
  }
  return { toolId: '', input: {}, invalid: `could not read a JSON action from: ${JSON.stringify(text.slice(0, 160))}` };
}

/** The newest receipt's data is shown whole (reads are already capped by the registry); older ones are clipped, and say so, so they don't pile up turn after turn. */
function formatReceiptsForPrompt(receipts: readonly Receipt[]): string {
  if (!receipts.length) return '(none yet — this is turn 1)';
  return receipts
    .map(
      (r, i) =>
        `Turn ${i + 1}: ${r.toolId} -> ${r.status} (${r.durationMs}ms)\n` +
        `  summary: ${r.summary}` +
        (r.changes.length ? `\n  changes: ${r.changes.join('; ')}` : '') +
        (r.data !== undefined
          ? `\n  data: ${clipData(typeof r.data === 'string' ? r.data : JSON.stringify(r.data), i === receipts.length - 1 ? BRAIN_LATEST_DATA_CHARS : BRAIN_OLDER_DATA_CHARS)}`
          : '') +
        (r.error ? `\n  error: ${r.error}` : '') +
        (r.brokenWarning ? `\n  WARNING: ${r.brokenWarning}` : '') +
        (r.nextHints?.length ? `\n  nextHints: ${r.nextHints.join(', ')}` : ''),
    )
    .join('\n\n');
}

/** Cuts a one-line summary at a word boundary, so a clipped line never ends mid-word. */
function clipLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/** Next moves that are not under a gap on the tree: drafts waiting on the owner, and watches tied to no gap. Empty when there are none. */
async function offTreeNextMoves(opts: { workspaceDir: string; watches: readonly WatchItem[]; gapIds: ReadonlySet<string> }): Promise<string> {
  const parts: string[] = [];

  const loose = opts.watches.filter((w) => !w.gapId || !opts.gapIds.has(w.gapId));
  if (loose.length) {
    parts.push(
      `Watches not tied to a gap:\n` +
        loose.map((w) => `- ${w.id} [${w.kind}]: ${w.label}${w.threadId ? ` (${w.threadId})` : w.fireAt ? ` (at ${formatLocalTime(w.fireAt)})` : ''}`).join('\n'),
    );
  }

  try {
    const pending = JSON.parse(await fs.readFile(path.join(opts.workspaceDir, 'approvals.json'), 'utf8')) as Array<{ id: string; toolId: string; input: Record<string, unknown>; gapId?: string; createdAt?: string }>;
    if (Array.isArray(pending) && pending.length) {
      parts.push(
        `Pending approvals (approvals.approve if the owner says yes, approvals.deny if no):\n` +
          pending
            .map((a) => `- ${a.id}${a.gapId ? ` [${a.gapId}]` : ''}${a.createdAt ? ` (drafted ${formatLocalTime(a.createdAt)})` : ''}: ${a.toolId}(${JSON.stringify(a.input).slice(0, 180)})`)
            .join('\n'),
      );
    }
  } catch {
    /* no pending approvals */
  }

  return parts.join('\n\n');
}

/** What you did lately across gaps, and which projects exist: history for the gaps in play, read after the new reality. */
async function recentHistory(workspaceDir: string): Promise<{ actions: string; projects: string }> {
  let actions = '';
  let projects = '';
  try {
    const recentWakes = (await loadWakes(workspaceDir)).filter((w) => w.acted).slice(-5);
    if (recentWakes.length) {
      actions = recentWakes
        .map((w) => {
          const tools = w.trace
            .filter((t) => t.toolId !== 'sleep' && t.receipt.status === 'ok')
            .map((t) => `${t.gapId ? `[${t.gapId}] ` : ''}${t.toolId}: ${clipLine(t.receipt.summary, 90)}`);
          return `- [${formatLocalTime(w.at)}] (${w.trigger.source}/${w.trigger.kind}) -> ${tools.slice(-3).join(' | ')}`;
        })
        .join('\n');
    }
  } catch {
    /* no wakes yet */
  }

  try {
    const names = (await fs.readdir(path.join(workspaceDir, 'projects'))).filter((f) => f.endsWith('.md') && !f.startsWith('.')).map((f) => f.replace(/\.md$/, '')).sort();
    if (names.length) projects = `Active projects (${names.length}): ${names.join(', ')}`;
  } catch {
    /* no projects dir */
  }

  return { actions, projects };
}

/** The gaps a move is about right now: the gap the last move served (or the one a watch fired for), then the gaps closest in meaning to what arrived. */
async function gapsInPlay(all: readonly Gap[], focusGapId: string | undefined, now: Date, query: string, similarity: Similarity): Promise<Gap[]> {
  return rankGapsInPlay({ gaps: all, ...(focusGapId ? { focusGapId } : {}), query, similarity, now, recentlyClosedMs: RECENTLY_CLOSED_MS });
}

/** The project card for each gap in play (repos, branch, autonomy envelope, decision gate), so Decide never guesses where the work lives. */
async function projectCardsBlock(workspaceDir: string, inPlay: readonly Gap[], similarity: Similarity): Promise<string> {
  const cards = await loadProjectCards(workspaceDir);
  const lines: string[] = [];
  const shown = new Set<string>();
  for (const g of inPlay) {
    const card = await matchProjectCard(cards, describeGap(g), similarity);
    if (!card) continue;
    lines.push(shown.has(card.file) ? `${g.id} -> ${card.file} (above)` : `${g.id} -> ${card.file}:\n${card.content.slice(0, 2000)}`);
    shown.add(card.file);
  }
  return lines.join('\n\n');
}

/**
 * Watches with no gap, or whose gap is closed, dropped or gone, are not anyone's next move:
 * a stray one is attached to the gap its label names (or the closest in meaning, else the root's next look), a dead one retired.
 */
async function reconcileWatches(gaps: GapStore, watches: WatchStore, similarity: Similarity): Promise<void> {
  // Derived from gap changes that already went through the ladder (a close or drop retires its watches in the same step).
  const all = await gaps.list();
  const live = all.filter((g) => !isDone(g));
  const liveIds = new Set(live.map((g) => g.id));
  const stray = (await watches.active()).filter((w) => !w.gapId && !w.gapIds?.length);
  const homes = new Map<string, string>();
  for (const w of stray) {
    const named = /gap_[a-z0-9]+/.exec(w.label)?.[0];
    if (named && liveIds.has(named)) {
      homes.set(w.id, named);
      continue;
    }
    const pool = live.filter((g) => g.id !== ROOT_GAP_ID);
    const scores = pool.length ? await similarity(w.label, pool.map(describeGap)) : [];
    let best = -1;
    scores.forEach((s, i) => {
      if (s >= STRAY_WATCH_MIN_SCORE && (best < 0 || s > scores[best]!)) best = i;
    });
    homes.set(w.id, best >= 0 ? pool[best]!.id : ROOT_GAP_ID);
  }
  await watches.reconcile((w) => {
    if (homes.has(w.id)) return { ...w, gapId: homes.get(w.id)! };
    const served = [w.gapId, ...(w.gapIds ?? [])].filter((x): x is string => !!x);
    // A gap that is closed, dropped or no longer on the board needs no next move.
    const alive = served.filter((id) => liveIds.has(id));
    if (alive.length === served.length) return w;
    if (!alive.length) return null;
    return { ...w, gapId: alive[0]!, gapIds: alive };
  });
}

/** How close (cosine) a stray watch's label must be to a gap to be attached to it rather than to the root's next look. */
const STRAY_WATCH_MIN_SCORE = 0.35;

/**
 * Runs one complete Awake cycle, top-down:
 * The Desk (gap tree -> new reality -> memories & tools for the gaps in play -> receipts) -> Decide picks 1 move + the gap it serves
 * -> code checks the gap -> Trust Gate -> tool runs -> immutable Receipt -> repeat until an accepted `sleep` or the turn cap.
 */
export async function runRpgWake(opts: RpgWakeOptions): Promise<RpgWakeReport> {
  const wakeId = `wake_${randomUUID().slice(0, 8)}`;
  const started = Date.now();
  const maxTurns = Math.max(1, Math.min(50, opts.maxTurns ?? 25));
  const topKTools = opts.topKTools ?? 6;
  const topKContext = opts.topKContext ?? 6;
  const now = opts.now ?? (() => new Date());

  const trace: RpgTurnTrace[] = [];
  opts.onWakeStart?.(wakeId);
  const receipts: Receipt[] = [];
  const sentMessages: string[] = [];
  const pendingApprovals: RpgWakeReport['pendingApprovals'] = [];
  let slept = false;
  let sleepReason: string | undefined;

  await opts.gaps?.ensureRoot();
  // One ladder for the wake's moves and for the actions its tools and the engine take.
  opts.registry.useTrust(opts.approvals);
  const similarity: Similarity =
    opts.similarity ?? (typeof opts.events.similarity === 'function' ? (q, t) => opts.events.similarity(q, t) : hashSimilarity);
  if (opts.gaps && opts.watches) await reconcileWatches(opts.gaps, opts.watches, similarity).catch(() => undefined);
  const decideSkill = await loadBrainSkill(opts.workspaceDir, 'DECIDE');
  const systemPrompt = `${DECIDE_CORE_RULES}\n\n${decideSkill}`;
  const arrivals: LosslessEvent[] = [...(opts.additionalEvents ?? [])];
  let focusGapId = typeof opts.trigger.metadata?.gapId === 'string' ? opts.trigger.metadata.gapId : undefined;

  // Isolated short-term conversation strictly between YOU and the OWNER (never evicted by third-party Beeper chats!)
  const recentOwnerChat = (await opts.events.recent(200))
    .filter((e) => e.source === 'message' && (e.kind === 'owner_direct' || e.kind === 'assistant_sent') && e.id !== opts.trigger.id && !(opts.additionalEvents ?? []).some((a) => a.id === e.id))
    .slice(-10);
  const recentChatIds = recentOwnerChat.map((e) => e.id);
  const recentChatBlock = recentOwnerChat.length
    ? recentOwnerChat
        .map((e) => {
          // The id says whose message it is, so an edit or a reaction points at the right one.
          const id = e.metadata?.messageId !== undefined ? ` [messageId:${e.metadata.messageId}]` : '';
          return `- [${formatLocalTime(e.timestamp)}] ${e.kind === 'assistant_sent' ? 'You (Rufus)' : e.actor || 'Owner'}${id}: ${e.text}`;
        })
        .join('\n')
    : '(none)';
  // The owner's latest words are new reality: moves made before them no longer count as repeats.
  const lastOwnerAt = () =>
    [opts.trigger, ...recentOwnerChat, ...arrivals]
      .filter((e) => e.kind === 'owner_direct')
      .map((e) => e.timestamp)
      .sort()
      .pop();
  const replyToText = typeof opts.trigger.metadata?.replyToText === 'string' ? opts.trigger.metadata.replyToText : '';

  let turns = 0;
  let unreadableInARow = 0;
  let endReason: WakeEndReason | undefined;
  let crash: unknown;
  try {
  for (let turn = 0; turn < maxTurns; turn++) {
    turns = turn + 1;
    // Between turns (while Decide is OFF), drain any new owner messages that arrived while working
    if (opts.pollIncoming) {
      const fresh = await opts.pollIncoming().catch(() => []);
      for (const f of fresh) {
        await opts.events.append(f);
        arrivals.push(f);
      }
    }

    // 1. The gap tree, with each gap's next move in motion
    const activeWatches = opts.watches ? await opts.watches.active() : [];
    const allGaps = opts.gaps ? await opts.gaps.list() : [];
    const gapTree = opts.gaps
      ? await opts.gaps.formatForDesk({ watches: activeWatches, now: now(), formatTime: formatLocalTime })
      : '(no gap tree configured)';
    const offTree = await offTreeNextMoves({ workspaceDir: opts.workspaceDir, watches: activeWatches, gapIds: new Set(allGaps.map((g) => g.id)) });
    const history = await recentHistory(opts.workspaceDir);

    // 2. New reality
    const arrivalBlock = arrivals.length
      ? `New messages that arrived while you were working:\n${arrivals
          .map((e) => `- [${formatLocalTime(e.timestamp)}] (${e.source}${formatParty(e)}${e.metadata?.messageId !== undefined ? ` | messageId:${e.metadata.messageId}` : ''}): ${e.text}`)
          .join('\n')}`
      : '';

    // 3. Memories and tools picked for the gaps in play
    const inPlay = await gapsInPlay(allGaps, focusGapId, now(), [opts.trigger.text, replyToText, ...arrivals.map((a) => a.text)].join(' '), similarity);
    const cardsBlock = await projectCardsBlock(opts.workspaceDir, inPlay, similarity).catch(() => '');
    const gapText = inPlay.map((g) => `${g.title}. ${g.target}. ${g.reality}`).join(' ');
    const related = await recallForDesk(opts.events, {
      triggerText: [opts.trigger.text, replyToText, ...arrivals.map((a) => a.text)].join(' '),
      gaps: inPlay,
      k: topKContext,
      excludeIds: [opts.trigger.id, ...recentChatIds, ...arrivals.map((a) => a.id)],
      now: now(),
    });
    const relatedEvents = related.map((r) => r.event);
    opts.onWakeContext?.({ trigger: opts.trigger, arrivals, relatedEvents, conversation: recentChatBlock });
    const relatedBlock = formatRecall(related, inPlay, formatLocalTime);
    const toolQuery = [gapText, opts.trigger.text, replyToText, ...arrivals.map((a) => a.text), ...receipts.slice(-2).map((r) => `${r.summary} ${r.error ?? ''} ${(r.nextHints ?? []).join(' ')}`)].join(' ');
    const tools = await opts.registry.selectForPrompt(toolQuery, topKTools);

    const triggerMsgId = opts.trigger.metadata?.messageId !== undefined ? ` | messageId:${opts.trigger.metadata.messageId}` : '';
    const replyLine = replyToText ? `\n  (in reply to: "${replyToText}")` : '';
    const creditsLine = opts.getCreditsLine ? await opts.getCreditsLine().catch(() => undefined) : undefined;
    const prompt = [
      `Workspace path: ${opts.workspaceDir}`,
      `Current local time: ${formatLocalTime(now())}`,
      ...(creditsLine ? [creditsLine] : []),
      `THE GAP TREE (start here: what the owner wants true vs. what is true, and each gap's next move):\n${gapTree}`,
      ...(offTree ? [`Next moves not on the tree:\n${offTree}`] : []),
      [
        `NEW REALITY (which gap does this change, create, or show is not done?):`,
        `Our Recent Conversation (isolated owner <-> Rufus thread):\n${recentChatBlock}`,
        `Incoming Event:\n[${formatLocalTime(opts.trigger.timestamp)}] (${opts.trigger.source}/${opts.trigger.kind}${formatParty(opts.trigger)}${triggerMsgId}${opts.trigger.deleted ? ' / DELETED' : ''}): ${opts.trigger.text}${replyLine}`,
        ...(arrivalBlock ? [arrivalBlock] : []),
      ].join('\n\n'),
      `Memories picked for the gaps in play${inPlay.length ? ` (${inPlay.map((g) => g.id).join(', ')})` : ''}:\n${relatedBlock}`,
      ...(history.actions ? [`Your recent actions (the last wakes that changed something, across all gaps):\n${history.actions}`] : []),
      ...(history.projects ? [history.projects] : []),
      ...(cardsBlock ? [`Project cards for the gaps in play (where the work lives, what you may do alone, what needs the owner):\n${cardsBlock}`] : []),
      `Tools for the gaps in play (the core tools, then the top ${topKTools} picked for these gaps; [effect · what the trust gate does · recent record]):\n${await opts.registry.formatForDesk(tools, opts.approvals)}`,
      `Receipts This Wake (exact ground truth):\n${formatReceiptsForPrompt(receipts)}`,
      `Turn ${turns} of ${maxTurns}. Reply with ONLY JSON {"thought":"...","gap":"<gap id or new desired state>","toolId":"...","input":{...}}.`,
    ].join('\n\n');

    const raw = await opts.reasoningProvider.complete({
      system: systemPrompt,
      prompt,
      ...(opts.reasoningModel ? { model: opts.reasoningModel } : {}),
    });
    const action = parseRpgAction(raw);

    // Model is now OFF. Code checks the gap, then runs the move through the Trust Ladder.
    const manifest = action.toolId ? opts.registry.get(action.toolId)?.manifest : undefined;
    const input: Record<string, unknown> = { ...action.input };
    const at = now().toISOString();
    const rejected = (summary: string, error: string): Receipt => ({
      toolId: action.toolId || '(none)',
      effect: manifest?.effect ?? 'meta',
      status: 'invalid_input',
      durationMs: 0,
      summary,
      changes: [],
      error,
      at,
    });

    let receipt: Receipt | undefined;
    let servedGapId: string | undefined;
    let gapNote = '';
    if (action.invalid) {
      receipt = rejected(`Rejected: ${action.invalid}. Reply with ONLY the JSON action.`, 'unreadable');
    } else if (opts.gaps && action.toolId !== 'sleep') {
      if (action.gap && typeof action.gap === 'object') {
        const spec = action.gap;
        // The gap points at the message that raised it, which may have arrived mid-wake rather than being the trigger.
        const raisedBy = (await raisingEvent({ spec, trigger: opts.trigger, arrivals, similarity })) ?? opts.trigger;
        const source = resolveGapSource(spec.source, ownerSpoke(opts.trigger, arrivals));
        const reality = spec.reality ?? `Not measured yet. Raised by: ${raisedBy.text.slice(0, 200)}`;
        // Saving a new gap is gaps.create, on gaps.create's rung, whether Decide calls it or names the gap inline.
        const gate = await opts.registry.gate(
          'gaps.create',
          { title: spec.title, target: spec.target, reality, source, ...(spec.parentId ? { parentId: spec.parentId } : {}), ...(spec.due ? { due: spec.due } : {}) },
          { now: now() },
        );
        if (!gate.run) {
          receipt = { ...gate.receipt, summary: `The new gap was not saved, so ${action.toolId} did not run either. ${gate.receipt.summary}` };
        } else {
          const g = await opts.gaps.create({
            title: spec.title,
            target: spec.target,
            reality,
            source,
            ...(spec.parentId ? { parentId: spec.parentId } : {}),
            evidenceIds: [raisedBy.id],
            ...(spec.due ? { due: spec.due } : {}),
            now: now(),
          });
          servedGapId = g.id;
          gapNote = `New gap ${g.id} [${g.status}]: ${g.title}. `;
        }
      } else if (typeof action.gap === 'string') {
        const g = await opts.gaps.get(action.gap);
        if (g) servedGapId = g.id;
        else receipt = rejected(`Rejected: unknown gap "${action.gap}". Name a gap id from the gap tree, or a new desired state {"title","target"}. Nothing ran.`, 'unknown_gap');
      } else {
        receipt = rejected('Rejected: every move must name the gap it serves (a gap id from the tree, or a new desired state {"title","target"}). Nothing ran.', 'no_gap');
      }
      if (!receipt && servedGapId === ROOT_GAP_ID && manifest?.effect === 'write' && !ROOT_WRITE_TOOLS.has(action.toolId)) {
        receipt = rejected(
          `Rejected: the root gap is only for finding gaps (look around, gaps.create, watch.set). Name or create the specific gap that ${action.toolId} closes. Nothing ran.`,
          'root_gap_write',
        );
      }
      if (
        !receipt &&
        servedGapId &&
        servedGapId !== ROOT_GAP_ID &&
        manifest?.effect === 'write' &&
        !ROOT_WRITE_TOOLS.has(action.toolId) &&
        !TALK_TOOLS.has(action.toolId) &&
        action.toolId !== 'gaps.approve'
      ) {
        const served = await opts.gaps.get(servedGapId);
        if (served?.status === 'proposed') {
          receipt = rejected(
            `Rejected: ${served.id} is only proposed. Until the owner says yes, you can look into it, ask the owner about it, or schedule the ask; ${action.toolId} has to wait. Nothing ran.`,
            'proposed_gap_write',
          );
        }
      }
      // A move that already failed, or a third identical call on the same target, is rejected by code (read from the work logs, so it holds across wakes).
      if (!receipt && servedGapId) {
        const since = lastOwnerAt();
        const repeat = checkRepeat({ gaps: await opts.gaps.list(), servedGapId, toolId: action.toolId, input, wakeId, ...(since ? { since } : {}) });
        if (repeat) receipt = rejected(repeat.summary, repeat.error);
      }
    }

    if (!receipt && manifest?.internal) {
      const takenBy = opts.registry.list().filter((m) => m.actions?.includes(manifest.id)).map((m) => m.id);
      receipt = rejected(
        `Rejected: ${action.toolId} is an action other tools take as a step, through the trust ladder${takenBy.length ? ` (${takenBy.join(', ')})` : ''}, not a move. Nothing ran.`,
        'internal_action',
      );
    }

    if (!receipt) {
      // The move's gap flows into the tool, so scheduling, verifying and splitting attach to the gap being served.
      const props = manifest?.inputSchema.properties ?? {};
      if (servedGapId && 'gapId' in props && !(typeof input.gapId === 'string' && input.gapId.trim())) input.gapId = servedGapId;
      // Every move, `sleep` included, goes through the same trust gate; the gate's rung comes from trust.json or the tool's default.
      const gate = manifest ? await passGate({ manifest, input, ...(opts.approvals ? { approvals: opts.approvals } : {}), now: now(), ...(servedGapId ? { gapId: servedGapId } : {}) }) : undefined;
      if (gate && !gate.run) {
        receipt = gate.receipt;
      } else {
        receipt = await opts.registry.call(action.toolId, input, {
          workspaceDir: opts.workspaceDir,
          now: now(),
          ...(gate ? { approved: true, level: gate.level } : {}),
          wakeId,
          ...(servedGapId ? { gapId: servedGapId } : {}),
        });
        if (receipt.status === 'pending_approval' && opts.approvals) {
          const saved = await opts.approvals.enqueue(action.toolId, input, now(), servedGapId);
          receipt.summary = `Draft awaiting owner approval (${saved.id}): ${receipt.summary} ${AWAITING_APPROVAL_NEXT}`;
          receipt.data = { approvalId: saved.id, toolId: action.toolId, input };
        }
      }
    }
    if (gapNote) {
      receipt.summary = `${gapNote}${receipt.summary}`;
      // Naming a new desired state changes the gap tree, whatever the tool did.
      receipt.changes = [...receipt.changes, `gap_created:${servedGapId}`];
    }
    if (servedGapId && servedGapId !== ROOT_GAP_ID) focusGapId = servedGapId;
    // Async work the move started (a T3 thread) becomes the served gap's next move: code watches it and wakes Rufus when it needs him.
    // Setting that watch is watch.set, on watch.set's rung.
    if (receipt.status === 'ok' && receipt.asyncWork && servedGapId && opts.watches) {
      const work = receipt.asyncWork;
      const watching = (await opts.watches.active()).some((w) => w.kind === 't3_thread' && w.threadId === work.threadId && w.gapId === servedGapId);
      if (watching) {
        receipt.summary += ` Code is watching thread ${work.threadId} as ${servedGapId}'s next move (wakes you when it finishes, needs input, or is blocked).`;
      } else {
        const watch = await opts.registry.runAction(
          'watch.set',
          { kind: work.kind, threadId: work.threadId, gapId: servedGapId, label: work.label ?? `${action.toolId} thread for ${servedGapId}` },
          { workspaceDir: opts.workspaceDir, now: now(), wakeId, gapId: servedGapId, stepOf: action.toolId },
        );
        receipt.summary +=
          watch.status === 'ok' && !(watch.data as { rehearsed?: boolean } | undefined)?.rehearsed
            ? ` Code is watching thread ${work.threadId} as ${servedGapId}'s next move (wakes you when it finishes, needs input, or is blocked).`
            : ` Thread ${work.threadId} is not watched: ${watch.summary}`;
      }
    }
    // Code writes the move into the work log of the gap it served, so what was tried carries across wakes (gaps.note, on its rung).
    if (servedGapId && opts.gaps && action.toolId !== 'sleep') {
      await opts.registry
        .runAction('gaps.note', { gapId: servedGapId, log: logEntry({ toolId: action.toolId, input, receipt, at, wakeId, turn: turns }) }, { workspaceDir: opts.workspaceDir, now: now(), wakeId, gapId: servedGapId })
        .catch(() => undefined);
    }

    receipts.push(receipt);
    trace.push({
      turn: turns,
      ...(action.thought ? { thought: action.thought } : {}),
      ...(servedGapId ? { gapId: servedGapId } : {}),
      toolId: action.toolId || '(none)',
      input,
      receipt,
    });
    opts.onReceipt?.(receipt);
    opts.onTurn?.(trace[trace.length - 1]!);

    if (receipt.status === 'pending_approval') {
      pendingApprovals.push({ toolId: action.toolId, input, receipt });
    }
    if (action.toolId === 'send_message' && receipt.status === 'ok') {
      const sent = (receipt.data as { text?: string } | undefined)?.text;
      if (sent) sentMessages.push(sent);
    }
    // A rehearsed move did not run: a rehearsed sleep does not end the wake.
    if (action.toolId === 'sleep' && receipt.status === 'ok' && !(receipt.data as { rehearsed?: boolean } | undefined)?.rehearsed) {
      slept = true;
      sleepReason = String(action.input.reason ?? 'done');
      break;
    }
    unreadableInARow = action.invalid ? unreadableInARow + 1 : 0;
    if (unreadableInARow >= MAX_UNREADABLE_IN_A_ROW) {
      endReason = 'unreadable';
      break;
    }
  }
  } catch (err) {
    crash = err;
    endReason = 'crashed';
  } finally {
    if (slept) endReason = 'slept';
    else if (!endReason) endReason = 'turn_cap';
    if (slept && opts.gaps) {
      // Every gap has a next move again: the backoff starts over.
      for (const g of (await opts.gaps.list().catch(() => [])).filter((x) => x.resumeAttempts)) {
        await opts.registry.runAction('gaps.note', { gapId: g.id, resumeAttempts: 0 }, { workspaceDir: opts.workspaceDir, now: now(), wakeId, gapId: g.id }).catch(() => undefined);
      }
    }
    // Nothing waits passively: if the wake ended without an accepted sleep (turn cap, garbled replies, or a crash),
    // one quick return covers every gap left without a next move, backing off per gap when the same gap keeps coming back.
    if (!slept && opts.gaps && opts.watches) {
      await scheduleResume({ gaps: opts.gaps, watches: opts.watches, registry: opts.registry, workspaceDir: opts.workspaceDir, wakeId, trigger: opts.trigger, trace, endReason, turns, error: crash, now: now() }).catch(() => undefined);
    }
  }

  // A wake "acted" only if it changed a gap, sent something or changed the world; wakes that only read are labelled SLEEP.
  const acted = receipts.some(isRealChange);
  const report: RpgWakeReport = {
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
    endReason,
    ...(crash ? { error: errorText(crash) } : {}),
  };
  // A crash still reaches the caller, carrying the partial report so the flight recorder can keep the trace and the reason.
  if (crash) {
    const err = crash instanceof Error ? crash : new Error(errorText(crash));
    (err as Error & { wakeReport?: RpgWakeReport }).wakeReport = report;
    throw err;
  }
  return report;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const END_REASON_TEXT: Record<WakeEndReason, string> = {
  slept: 'slept',
  no_progress: 'it made no progress',
  turn_cap: 'it hit the turn cap',
  unreadable: 'Decide gave unreadable replies in a row',
  crashed: 'it crashed',
};

/**
 * The safety net: ONE quick return for every gap a wake left without a next move. Its label says why the wake ended
 * and what each gap's last moves were, and each gap keeps its own attempt count, so the backoff holds however the timers fire.
 */
async function scheduleResume(opts: {
  gaps: GapStore;
  watches: WatchStore;
  registry: ToolRegistry;
  workspaceDir: string;
  wakeId: string;
  trigger: LosslessEvent;
  trace: readonly RpgTurnTrace[];
  endReason: WakeEndReason;
  turns: number;
  error?: unknown;
  now: Date;
}): Promise<void> {
  const active = await opts.watches.active();
  const stranded = (await opts.gaps.unclosed()).filter((g) => !active.some((w) => servesGap(w, g.id)));
  if (!stranded.length) return;
  // Older quick returns carried the attempt on the watch; the gap's own count is the source of truth now.
  const meta = opts.trigger.metadata ?? {};
  const fromWatch = (id: string) =>
    typeof meta.resumeAttempt === 'number' && (meta.gapId === id || (Array.isArray(meta.gapIds) && meta.gapIds.includes(id))) ? meta.resumeAttempt : 0;
  const attempts = new Map<string, number>();
  for (const g of stranded) {
    const attempt = Math.max(g.resumeAttempts ?? 0, fromWatch(g.id)) + 1;
    attempts.set(g.id, attempt);
    await opts.registry.runAction('gaps.note', { gapId: g.id, resumeAttempts: attempt }, { workspaceDir: opts.workspaceDir, now: opts.now, wakeId: opts.wakeId, gapId: g.id });
  }
  // The gap stranded least often sets the time, so a fresh gap is not held back by one that keeps failing.
  const attempt = Math.min(...attempts.values());
  const delay = Math.min(RESUME_MS * 2 ** (attempt - 1), RESUME_MAX_MS);
  const reason = `${END_REASON_TEXT[opts.endReason]} after ${opts.turns} turn(s)${opts.error ? `: ${errorText(opts.error).slice(0, 160)}` : ''}`;
  const lastMoves = stranded
    .map((g) => {
      const moves = opts.trace.filter((t) => t.gapId === g.id).slice(-2);
      const shown = moves.length
        ? moves.map((t) => `${t.toolId} -> ${t.receipt.status}: ${(t.receipt.error ?? t.receipt.summary).replace(/\s+/g, ' ').slice(0, 120)}`).join('; ')
        : (g.log ?? []).slice(-1).map((e) => `${e.toolId} -> ${e.status}: ${e.result.slice(0, 120)}`).join('') || 'no moves yet';
      return `${g.id} "${g.title.slice(0, 60)}" (attempt ${attempts.get(g.id)}): ${shown}`;
    })
    .join(' | ');
  const label = `Resume: the last wake ended before these gaps had a next move (${reason}). Last moves: ${lastMoves}`.slice(0, 1200);
  const gapId = stranded.find((g) => g.id !== ROOT_GAP_ID)?.id ?? stranded[0]!.id;
  const fireAt = new Date(opts.now.getTime() + delay).toISOString();
  // The quick return is a timer like any other: watch.set's rung decides it (a draft of it waits on the owner like any draft).
  const gate = await opts.registry.gate('watch.set', { kind: 'timer', label, gapId, fireAt }, { now: opts.now, gapId });
  if (!gate.run) return;
  await opts.watches.add({ kind: 'timer', label, gapId, gapIds: stranded.map((g) => g.id), fireAt, resumeAttempt: attempt }, opts.now);
}
