import { loadAnchor, localDate, protectedNow, type Anchor } from '../anchor/anchor';
import { formatMemoryForPrompt, loadMarkdownMemory } from '../memory/markdown-memory';
import { parseChatShape, parseToolCall, concise } from '../chief/chief';
import { formatChatHistory, loadChatHistory } from '../chief/history';
import { loadHumanNotes } from '../chief/learning';
import { clip } from '../corpus/types';
import type { MasterLoop } from '../engine/loop';
import { buildPersona, loadSoul, timeFacts, withPersona } from '../soul/soul';
import { isExternalWriteTool, type ToolRegistry } from '../tools/tools';
import { checkLayer3Boundary, layer3RetryPrompt, runLayer3Verify } from '../skills/runner';
import type { AiMessage, AiProvider } from '../types';
import { DEFAULT_QUIET_HOURS, inQuietHours } from './heartbeat';

/**
 * The proactive Jarvis think-beat (v15). Every `everyMs` (default 45 minutes) Rufus wakes up on its own, code gathers a
 * compact live board (local date and time, today's Anchor blocks, goals and projects, the last few chat lines, recent loop
 * runs, and a quick glance at fast read-only tools such as the calendar), and ONE model call decides whether there is a
 * single genuinely useful, natural thing to say. Most beats it says `SILENT` and nothing is sent.
 *
 *   - Never during quiet hours or an Anchor `protect_time` window (a Sabbath, a protected block).
 *   - When two proactive messages in a row got no reply or reaction at all, it backs off: the interval doubles with each
 *     further unanswered one (up to 16x), and snaps back the moment the human talks again.
 */

export const DEFAULT_THINK_EVERY = '45m';
export const SILENT = 'SILENT';
/** Unanswered proactive messages in a row before backing off. */
export const DEFAULT_BACKOFF_AFTER = 2;
export const MAX_BACKOFF_FACTOR = 16;
const DEFAULT_TOOL_TIMEOUT_MS = 3000;
/** v25a: read-only tool calls the model may make during one beat before it decides. */
export const DEFAULT_THINK_TOOL_STEPS = 3;
/** v25a: each tool call the model makes during a beat (a web search takes longer than a glance). */
const DEFAULT_THINK_TOOL_CALL_MS = 15_000;
/** v25a: what boundaries.mjs is asked about before a beat speaks. */
export const PROACTIVE_ACTION = 'proactive.message';
const CHAT_LINES = 8;
const RECENT_RUNS = 8;

export const THINK_PROMPT = [
  'You are waking up on your own periodic beat. Look at what\'s actually going on right now.',
  'Is there ONE genuinely useful, natural thing to mention or offer (e.g., an open afternoon with no plan yet, an important goal coming up, a follow-up on something the human mentioned earlier)?',
  `If nothing genuinely matters right now, reply with exactly \`${SILENT}\`. Never invent busywork.`,
  'Write like a real person texting — casual, natural emphasis, zero form templates.',
  'Keep it to one short message (two short bubbles at most, split by a line with only ---). Never repeat something you already said in the recent conversation. Say times the casual 12-hour way (2pm).',
].join('\n');

export interface ThinkOptions {
  /** Milliseconds between beats. `0` (or less) turns the think-beat off. */
  everyMs: number;
  /** `HH:MM-HH:MM` (may wrap midnight) when it never speaks. Default: the heartbeat's, else `22:00-07:00`. `false`: none. */
  quietHours?: string | false;
  /** Fast read-only tools to glance at, when registered. Default `['calendar.read']`. */
  tools?: string[];
  /** Each glance gets this long. Default 3s. */
  toolTimeoutMs?: number;
  /** Named provider for the beat. Default: the `fast` tier, else the default provider. */
  provider?: string;
  /** Unanswered proactive messages in a row before backing off. Default 2. */
  backoffAfter?: number;
  /** v25a: read-only tool calls the model may make during a beat. Default 3; 0 turns action-first off. */
  maxToolSteps?: number;
}

/** What `rufus start` remembers about the think-beat (inside `start-state.json`). */
export interface ThinkState {
  /** When the last beat ran (silent or not). */
  lastAt?: string;
  /** When the last proactive message went out. */
  lastSentAt?: string;
  /** Proactive messages sent since the human last said or reacted anything. */
  unanswered: number;
}

export const freshThinkState = (): ThinkState => ({ unanswered: 0 });

/** The current interval: the base, doubled for each unanswered message past `backoffAfter - 1`, capped at 16x. */
export function thinkInterval(everyMs: number, unanswered: number, backoffAfter = DEFAULT_BACKOFF_AFTER): number {
  if (unanswered < backoffAfter) return everyMs;
  return everyMs * Math.min(MAX_BACKOFF_FACTOR, 2 ** (unanswered - backoffAfter + 1));
}

/** Why a beat should not run now (`quiet`, `protected: <rule>`, `not due`), or undefined when it should. */
export function thinkSkipReason(opts: { now: Date; anchor: Anchor; state: ThinkState; everyMs: number; quietHours?: string | false; backoffAfter?: number }): string | undefined {
  if (!(opts.everyMs > 0)) return 'off';
  if (inQuietHours(opts.now, opts.quietHours === undefined ? DEFAULT_QUIET_HOURS : opts.quietHours)) return 'quiet hours';
  const guard = protectedNow(opts.anchor, opts.now);
  if (guard) return `protected: ${guard.rule}`;
  if (!opts.state.lastAt) return 'not due';
  const wait = thinkInterval(opts.everyMs, opts.state.unanswered, opts.backoffAfter);
  if (opts.now.getTime() - Date.parse(opts.state.lastAt) < wait) return 'not due';
  return undefined;
}

/** The model's answer as 1-2 bubbles, or `undefined` for silence (`SILENT`, empty, `NO_REPLY`, a stray tool call). */
export function parseThought(raw: string): string[] | undefined {
  const t = raw.trim().replace(/^["'`“]+|["'`”]+$/g, '').trim();
  if (!t) return undefined;
  const bare = t.replace(/[`*_.!\s]/g, '').toUpperCase();
  if (bare === SILENT || bare.startsWith(SILENT) || bare === 'NOREPLY' || /TOOL_CALL/.test(t)) return undefined;
  const shape = parseChatShape(t);
  if (!('bubbles' in shape)) return undefined;
  const bubbles = shape.bubbles
    .slice(0, 2)
    .map((b) => concise(b, ''))
    .filter((b) => b.trim());
  return bubbles.length ? bubbles : undefined;
}

/** A fast read-only tool's answer, or undefined if it is missing, slow or failing. Never throws. */
async function glance(tools: ToolRegistry, name: string, dir: string, now: Date, timeoutMs: number): Promise<string | undefined> {
  const tool = tools.get(name);
  if (!tool || !tool.readOnly) return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const out = await Promise.race([
      tools.call(name, {}, { dir, now, stage: 'execute' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    const text = typeof out === 'string' ? out : JSON.stringify(out ?? null);
    return clip(text, 800);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The live board, gathered by code. Small on purpose: a few hundred tokens. */
export async function gatherBoard(opts: { dir: string; loop: MasterLoop; now: Date; anchor?: Anchor; tools?: ToolRegistry; glance?: string[]; toolTimeoutMs?: number }): Promise<string> {
  const { dir, loop, now } = opts;
  const anchor = opts.anchor ?? (await loadAnchor(dir, now));
  const t = timeFacts(now, anchor);
  const lines: string[] = [`Now: ${t.weekday} ${t.date}, ${t.time} local time${t.timeZone ? ` (${t.timeZone})` : ''}.`];
  const today = anchor.schedule.date === localDate(now) ? anchor.schedule.blocks.filter((b) => b.status !== 'skipped') : [];
  lines.push(today.length ? `Today's plan: ${today.map((b) => `${b.start}-${b.end} ${b.kind} ${b.title}${b.status === 'done' ? ' (done)' : ''}`).join('; ')}` : "Today's plan: nothing scheduled.");
  const goals = anchor.goals.filter((g) => g.active).slice(0, 6);
  if (goals.length) lines.push(`Goals: ${goals.map((g) => `[${g.priority}/${g.horizon}] ${g.title}`).join('; ')}`);
  const projects = anchor.projects.filter((p) => p.status === 'active').slice(0, 5);
  if (projects.length) lines.push(`Projects: ${projects.map((p) => `${p.name}${p.nextStep ? ` (next: ${p.nextStep})` : ''}`).join('; ')}`);
  const history = await loadChatHistory(dir, CHAT_LINES).catch(() => []);
  lines.push(history.length ? `Recent conversation (oldest first):\n${formatChatHistory(history, now)}` : 'Recent conversation: none yet.');
  const runs = (await loop.listRuns().catch(() => []))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_RUNS);
  if (runs.length) lines.push(`Recent loop runs (newest first): ${runs.map((r) => `${r.actionType ?? r.handlerId} ${r.status}${r.goal ? ` (${clip(r.goal, 80)})` : ''}`).join('; ')}`);
  const waiting = runs.filter((r) => r.status.startsWith('awaiting_')).length;
  if (waiting) lines.push(`Items waiting on the human: ${waiting} (they already know; don't nag about them).`);
  const notes = await loadHumanNotes(dir, 6);
  if (notes.length) lines.push(`What they told you to keep in mind:\n${notes.map((n) => `- ${clip(String((n.metadata as { note?: unknown })?.note ?? n.summary), 200)}`).join('\n')}`);
  if (opts.tools) {
    for (const name of opts.glance ?? ['calendar.read']) {
      const seen = await glance(opts.tools, name, dir, now, opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
      if (seen) lines.push(`${name}: ${seen}`);
    }
  }
  return lines.join('\n');
}

/** v25a: the tools a beat may call itself: read-only ones only, never a write or anything that reaches out. */
export function thinkTools(tools: ToolRegistry | undefined): string[] {
  return (tools?.list() ?? []).filter((t) => t.readOnly === true && !isExternalWriteTool(t.name)).map((t) => t.name);
}

/** v25a: the action-first part of the beat prompt, listing the read-only tools it may use. */
export function thinkToolsPrompt(tools: ToolRegistry, names: readonly string[], maxSteps: number): string {
  return [
    'ACTION FIRST: you may look things up before you decide. To call a read-only tool, reply with ONLY this one line:',
    'TOOL_CALL: {"tool":"<name>","args":{...}}',
    `You then get the result and can call another (at most ${maxSteps} calls), or write your message, or ${SILENT}.`,
    'If something is still owed to them (a lookup, a comparison, a quick bit of research) and a tool below can finish it, FINISH IT NOW and send the finished answer.',
    'Never offer to look something up, and never ask "want me to run it?" or "should I check?": do the read-only work and say what you found.',
    'You can only read during a beat. Never try to send, write, schedule or reply to anyone: those tools are blocked here.',
    'Read-only tools:',
    ...names.map((n) => `- ${n}: ${tools.get(n)?.description ?? ''}`),
  ].join('\n');
}

/** What one beat did, for the daemon's report. */
export interface ThinkResult {
  /** The 1-2 bubbles to send. Unset: stay silent. */
  bubbles?: string[];
  board: string;
  /** v25a: read-only tools the beat ran. */
  toolsUsed?: string[];
  /** v25a: tools the model tried that a beat may never run (writes, sends): hard-blocked, nothing ran. */
  blocked?: string[];
  /** v25a: boundaries.mjs said not now: the beat stayed silent without calling the model. */
  boundary?: string;
  /** v25a: what taste.mjs rejected (`violations`), whether one rewrite ran, what it still got wrong (then silent). */
  layer3?: { violations?: string[]; retried?: boolean; remaining?: string[]; errors?: string[] };
}

/**
 * One beat: SOUL.md + the board + the think prompt. v25a: the model may first run up to 3 read-only tools (never a write)
 * so it sends the finished answer instead of offering to look; `<workspace>/boundaries.mjs` can veto speaking at all, and
 * `<workspace>/taste.mjs` checks the message (one rewrite, then silence). Returns the bubbles to send, or none (silent).
 */
export async function think(opts: { provider: AiProvider; dir: string; loop: MasterLoop; now: Date; tools?: ToolRegistry; glance?: string[]; toolTimeoutMs?: number; maxToolSteps?: number }): Promise<ThinkResult> {
  // v25a: boundaries.mjs first, so a protected window costs no model call at all.
  const boundary = await checkLayer3Boundary({ dir: opts.dir, now: opts.now, action: PROACTIVE_ACTION, sensitivity: [] });
  if (boundary && !boundary.allow) return { board: '', boundary: boundary.reason ?? 'boundaries.mjs said not now' };
  const anchor = await loadAnchor(opts.dir, opts.now);
  const board = await gatherBoard({ ...opts, anchor });
  const soul = await loadSoul(opts.dir).catch(() => undefined);
  // v24b: USER.md, MEMORY.md and the recent daily notes, when the workspace has them.
  const memory = await loadMarkdownMemory(opts.dir, opts.now)
    .then((m) => formatMemoryForPrompt(m, 3000))
    .catch(() => '');
  const persona = [buildPersona({ ...(soul ? { soul } : {}) }), memory].filter(Boolean).join('\n\n');
  const system = withPersona('You are Rufus, a calm, capable chief of staff, a bit like Jarvis: warm, natural and brief. You only speak up when it genuinely helps.', persona);
  const maxSteps = Math.max(0, Math.min(5, Math.floor(opts.maxToolSteps ?? DEFAULT_THINK_TOOL_STEPS)));
  const readable = maxSteps > 0 ? thinkTools(opts.tools) : [];
  const actionFirst = readable.length ? `\n\n${thinkToolsPrompt(opts.tools!, readable, maxSteps)}` : '';
  const messages: AiMessage[] = [{ role: 'user', content: `Live board (exact data gathered by code):\n${board}\n\n${THINK_PROMPT}${actionFirst}` }];
  const toolsUsed: string[] = [];
  const blocked: string[] = [];
  const executed: Array<{ name: string; ok: boolean }> = [];
  const layer3: NonNullable<ThinkResult['layer3']> = {};
  const done = (bubbles?: string[]): ThinkResult => ({
    ...(bubbles ? { bubbles } : {}),
    board,
    ...(toolsUsed.length ? { toolsUsed } : {}),
    ...(blocked.length ? { blocked } : {}),
    ...(Object.keys(layer3).length ? { layer3 } : {}),
  });
  let steps = 0;
  for (let turn = 0; turn < maxSteps + 3; turn++) {
    const raw = await opts.provider.complete({ system, messages, meta: { runId: 'think', flowId: 'think', step: turn ? `beat.${turn}` : 'beat', attempt: 1 } });
    const call = readable.length ? parseToolCall(raw) : undefined;
    if (call) {
      if (steps++ >= maxSteps) return done(); // out of lookups: say nothing rather than a half answer
      const result = await thinkToolCall(opts.tools!, call.tool, call.args, opts.dir, opts.now, opts.toolTimeoutMs);
      executed.push({ name: call.tool, ok: result.ran });
      if (result.ran) toolsUsed.push(call.tool);
      if (result.blocked) blocked.push(call.tool);
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `TOOL_RESULT ${call.tool}:\n${result.text}\n\nCall another read-only tool, or write your one message with the finished answer, or ${SILENT}.` });
      continue;
    }
    const bubbles = parseThought(raw);
    if (!bubbles) return done();
    // v25a: taste.mjs (and nothing else: a beat has no matched skill) checks every proactive message.
    const taste = await runLayer3Verify({ dir: opts.dir, text: bubbles.join('\n'), toolCalls: executed, channel: 'proactive', now: opts.now });
    if (taste.errors.length) layer3.errors = [...(layer3.errors ?? []), ...taste.errors];
    if (!taste.reasons.length) return done(bubbles);
    if (layer3.retried) {
      layer3.remaining = taste.reasons;
      return done(); // a proactive message that still breaks the rules is not worth sending
    }
    Object.assign(layer3, { violations: taste.reasons, retried: true });
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: layer3RetryPrompt(taste.reasons) });
  }
  return done();
}

/** One tool call from a beat. Only read-only tools run; anything else is hard-blocked here. Never throws. */
async function thinkToolCall(tools: ToolRegistry, name: string, args: Record<string, unknown>, dir: string, now: Date, timeoutMs = DEFAULT_THINK_TOOL_CALL_MS): Promise<{ text: string; ran: boolean; blocked?: boolean }> {
  const tool = tools.get(name);
  if (!tool) return { text: `No tool called "${name}". Read-only tools: ${thinkTools(tools).join(', ')}.`, ran: false };
  if (tool.readOnly !== true || isExternalWriteTool(name)) {
    return { text: `BLOCKED: ${name} is not read-only, and a think-beat may only read. Nothing was sent or changed. Do not claim it was.`, ran: false, blocked: true };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const out = await Promise.race([
      tools.call(name, args, { dir, now, stage: 'execute' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { text: clip(typeof out === 'string' ? out : JSON.stringify(out ?? null), 3000), ran: true };
  } catch (err) {
    return { text: `Tool ${name} failed: ${clip(err instanceof Error ? err.message : String(err), 300)}`, ran: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
