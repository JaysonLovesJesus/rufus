import { loadAnchor, localDate, protectedNow, type Anchor } from '../anchor/anchor';
import { parseChatShape, concise } from '../chief/chief';
import { formatChatHistory, loadChatHistory } from '../chief/history';
import { loadHumanNotes } from '../chief/learning';
import { clip } from '../corpus/types';
import type { MasterLoop } from '../engine/loop';
import { buildPersona, loadSoul, timeFacts, withPersona } from '../soul/soul';
import type { ToolRegistry } from '../tools/tools';
import type { AiProvider } from '../types';
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

/** One beat's model call: SOUL.md + the board + the think prompt. Returns the bubbles to send, or undefined (silent). */
export async function think(opts: { provider: AiProvider; dir: string; loop: MasterLoop; now: Date; tools?: ToolRegistry; glance?: string[]; toolTimeoutMs?: number }): Promise<{ bubbles?: string[]; board: string }> {
  const anchor = await loadAnchor(opts.dir, opts.now);
  const board = await gatherBoard({ ...opts, anchor });
  const soul = await loadSoul(opts.dir).catch(() => undefined);
  const system = withPersona('You are Rufus, a calm, capable chief of staff, a bit like Jarvis: warm, natural and brief. You only speak up when it genuinely helps.', buildPersona({ ...(soul ? { soul } : {}) }));
  const raw = await opts.provider.complete({
    system,
    messages: [{ role: 'user', content: `Live board (exact data gathered by code):\n${board}\n\n${THINK_PROMPT}` }],
    meta: { runId: 'think', flowId: 'think', step: 'beat', attempt: 1 },
  });
  const bubbles = parseThought(raw);
  return { ...(bubbles ? { bubbles } : {}), board };
}
