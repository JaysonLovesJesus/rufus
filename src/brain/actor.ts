import { loadAnchor } from '../anchor/anchor';
import { appendChatTurns, formatChatHistory, loadChatHistory } from '../chief/history';
import { queueChiefAction } from '../chief/actions';
import { clip } from '../corpus/types';
import { detectUnbackedActionClaims, honestCorrection, VERIFIER_RETRY_PROMPT, type VerifiedToolCall } from '../engine/cross-verify';
import type { MasterLoop } from '../engine/loop';
import { formatMemoryForPrompt, loadMarkdownMemory } from '../memory/markdown-memory';
import { checkLayer3Boundary, layer3RetryPrompt, matchLayer3Units, relevantProjectsSection, runLayer3Prepare, runLayer3Verify } from '../skills/runner';
import { relevantSkillsSection, SKILL_LIST_TOOL, SKILL_READ_TOOL } from '../skills/skills';
import { buildPersona, loadSoul, withPersona } from '../soul/soul';
import { MISSION_START_TOOL } from '../tools/mission-tools';
import { isExternalWriteTool, ToolGatedError, type ToolRegistry } from '../tools/tools';
import { gatherBoard, PROACTIVE_ACTION, THINK_PROMPT } from '../unified/think';
import type { AiMessage, AiProvider } from '../types';

/**
 * v26: the Continuous Living Brain.
 *
 * Instead of request -> reply, Rufus has ONE mind with an awareness queue. Every event (a message or reaction from the
 * owner, a signal from an app, a periodic wake, a system note) lands in the same queue. Each step of the loop folds in
 * whatever arrived (including what the owner texted WHILE the model was thinking), makes ONE model call, and gets back a
 * small list of natural actions:
 *
 *   - `say`      a short human message (checked by taste.mjs + the claim verifier first, one rewrite on a violation);
 *   - `react`    an emoji on their message instead of a forced text reply;
 *   - `tool`     a read-only or private-local tool runs now and its result feeds the next step; anything that writes to
 *                the outside world (beeper.send, gmail.send, shell.run, files.write, mac.control, MCP writes...) is NEVER
 *                run here: it is queued as a Verify item and runs only after the owner's yes;
 *   - `continue` keep working on the next step;
 *   - `rest`     stop and wait for the next event.
 *
 * Interrupt-while-thinking: right before a `say` goes out, the brain drains new events. If the owner sent more while
 * the model was thinking, the stale `say` is dropped and the brain loops at once with everything they said.
 *
 * Hard limits: `maxStepsPerWake` (default 6, max 10) model steps per wake, at most 2 interrupts, at most 8 actions per
 * step, one rewrite per message. `boundaries.mjs` is asked before anything proactive (a wake no owner message started).
 */

export type BrainEventKind = 'owner_message' | 'owner_reaction' | 'signal' | 'timer_wake' | 'system';

export interface BrainEvent {
  id: string;
  kind: BrainEventKind;
  /** ISO time. */
  at: string;
  text: string;
  meta?: Record<string, unknown>;
}

export type BrainAction =
  | { type: 'say'; text: string }
  | { type: 'react'; emoji: string; messageId?: string }
  | { type: 'tool'; name: string; args?: Record<string, unknown> }
  | { type: 'continue'; note?: string }
  | { type: 'rest'; reason?: string };

export const DEFAULT_MAX_STEPS_PER_WAKE = 6;
export const MAX_STEPS_PER_WAKE = 10;
export const DEFAULT_MAX_INTERRUPTS = 2;
/** Actions read from one step; anything past this is ignored. */
export const MAX_ACTIONS_PER_STEP = 8;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const MAX_TOOL_RESULT = 3000;
const MAX_SAY_CHARS = 1200;
const KEEP_EVENTS = 30;
const KEEP_NOTES = 20;
const HISTORY_TURNS = 12;
/** Read-only tools that only read Rufus's own workspace: what they return is not outside content. */
const OWN_READS = new Set([SKILL_LIST_TOOL, SKILL_READ_TOOL, 'mission.list']);

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const oneLine = (s: string, max = 200): string => clip(s.replace(/\s+/g, ' ').trim(), max);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isLocal = (t: { local?: boolean; sensitivity?: readonly string[] }): boolean => t.local === true && !(t.sensitivity ?? []).length;

// ---------- parsing a step ----------

/** One raw action object -> a typed action, or undefined when it is not one. */
function toAction(v: unknown): BrainAction | undefined {
  if (!isRecord(v)) return undefined;
  const type = String(v.type ?? v.action ?? '').toLowerCase().trim();
  const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  switch (type) {
    case 'say':
    case 'reply':
    case 'message': {
      const text = str(v.text) ?? str(v.message);
      return text ? { type: 'say', text } : undefined;
    }
    case 'react':
    case 'reaction': {
      const emoji = str(v.emoji) ?? str(v.text);
      if (!emoji) return undefined;
      const messageId = str(v.messageId);
      return { type: 'react', emoji, ...(messageId ? { messageId } : {}) };
    }
    case 'tool':
    case 'tool_call': {
      const name = str(v.name) ?? str(v.tool);
      if (!name) return undefined;
      return { type: 'tool', name, ...(isRecord(v.args) ? { args: v.args } : {}) };
    }
    case 'continue': {
      const note = str(v.note);
      return { type: 'continue', ...(note ? { note } : {}) };
    }
    case 'rest':
    case 'wait':
    case 'silent':
    case 'done': {
      const reason = str(v.reason);
      return { type: 'rest', ...(reason ? { reason } : {}) };
    }
    default:
      return undefined;
  }
}

/** The first balanced JSON object or array starting at or after `from` (strings respected). */
function jsonAt(text: string, from = 0): string | undefined {
  const start = text.slice(from).search(/[{[]/);
  if (start < 0) return undefined;
  const s = from + start;
  const stack: string[] = [];
  let inStr = false;
  for (let i = s; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return undefined;
      if (!stack.length) return text.slice(s, i + 1);
    }
  }
  return undefined;
}

const SILENT_WORDS = /^(?:silent|no_reply|noreply|rest|\(noreply\))?$/i;

/**
 * A model's step as actions. Structured JSON `{"actions":[...]}` (or a bare array, or a single action object, fenced or
 * not) is read strictly; anything else is plain text and becomes `[say, rest]` so any model works. A legacy
 * `TOOL_CALL: {...}` line becomes a tool action. `SILENT` / `NO_REPLY` / empty means rest.
 */
export function parseBrainStep(raw: string): BrainAction[] {
  const text = (raw ?? '').trim();
  if (!text) return [{ type: 'rest' }];
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // Legacy one-line tool call (the chief/think protocol).
  const legacy = /^TOOL_CALL\s*:?\s*/i.exec(unfenced);
  if (legacy) {
    const body = jsonAt(unfenced, legacy[0].length);
    try {
      const o = body ? (JSON.parse(body) as unknown) : undefined;
      if (isRecord(o) && typeof o.tool === 'string') return [{ type: 'tool', name: o.tool, ...(isRecord(o.args) ? { args: o.args } : {}) }];
    } catch {
      /* fall through */
    }
  }
  const body = /^[{[]/.test(unfenced) ? jsonAt(unfenced) : /```(?:json)?\s*[{[]/i.test(text) ? jsonAt(text, text.search(/```(?:json)?\s*[{[]/i)) : undefined;
  if (body) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.actions) ? parsed.actions : isRecord(parsed) ? [parsed] : [];
      const actions = list.map(toAction).filter((a): a is BrainAction => !!a).slice(0, MAX_ACTIONS_PER_STEP);
      if (actions.length) return actions;
      if (isRecord(parsed) && Array.isArray(parsed.actions)) return [{ type: 'rest' }]; // `{"actions":[]}`: nothing to do
    } catch {
      /* not JSON after all: plain text */
    }
  }
  // Malformed JSON never reaches the owner as raw braces: salvage any "text" fields, else rest.
  if (/^[{[]/.test(unfenced)) {
    const texts = [...unfenced.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/g)].map((m) => {
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return m[1]!;
      }
    });
    const salvaged = texts.map((t) => t.trim()).filter(Boolean).slice(0, 3);
    return [...salvaged.map((t): BrainAction => ({ type: 'say', text: t })), { type: 'rest' }];
  }
  const plain = text.replace(/^["'`“]+|["'`”]+$/g, '').trim();
  if (!plain || SILENT_WORDS.test(plain.replace(/[`*_.!\s]/g, ''))) return [{ type: 'rest' }];
  const bubbles = plain
    .split(/\n\s*---+\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .slice(0, 3);
  return [...bubbles.map((b): BrainAction => ({ type: 'say', text: b })), { type: 'rest' }];
}

// ---------- the brain ----------

/** Where the brain's actions land: the chat channel (via the daemon) or a test double. */
export interface BrainOutlet {
  /** Sends one message to the owner. `proactive`: no owner message started this wake. */
  say(text: string, opts: { proactive: boolean }): Promise<void>;
  /** Puts an emoji on one of the owner's messages. Without it, react actions are skipped (noted, never turned into text). */
  react?(emoji: string, messageId: string): Promise<void>;
  /** Best effort typing indicator before each model step. */
  typing?(): Promise<void>;
}

export interface ContinuousBrainOptions {
  dir: string;
  provider: AiProvider;
  outlet: BrainOutlet;
  /** Tools the brain may use. Read-only and private-local ones run now; anything else is queued for approval. */
  tools?: ToolRegistry;
  /** The Master Loop, for the board on periodic wakes. */
  loop?: MasterLoop;
  /**
   * Queues an external write as a Verify item. Default: `queueChiefAction` (a `chief/action.request` signal in
   * `inbox.jsonl` that the loop turns into an item that always waits for the owner's yes).
   */
  queue?: (tool: string, args: Record<string, unknown>) => Promise<void>;
  /** Model steps per wake. Default 6, clamped to 1..10. */
  maxStepsPerWake?: number;
  /** Stale `say`s dropped because the owner kept typing, per wake. Default 2. */
  maxInterrupts?: number;
  /** Each tool call gets this long. Default 15s. */
  toolTimeoutMs?: number;
  /** Chat turns shown to the model. Default 12; 0 also stops the brain from writing chat history. */
  historyTurns?: number;
  /** Read-only tools glanced at for the board on a periodic wake. Default `['calendar.read']`. */
  glance?: string[];
  now?: () => Date;
}

export interface BrainWakeReport {
  /** Model steps this wake (rewrites not counted). */
  steps: number;
  said: string[];
  reacted: string[];
  /** Read-only / local tools that ran. */
  toolsUsed: string[];
  /** External writes queued as Verify items (nothing ran). */
  queued: string[];
  /** Tool calls refused here (e.g. a private write on a proactive wake). Nothing ran. */
  blocked: string[];
  /** Stale drafts skipped because the owner sent more while the brain was thinking. */
  dropped: string[];
  interrupts: number;
  /** Why the wake ended. */
  stopped: 'rest' | 'idle' | 'budget' | 'boundary' | 'empty' | 'error';
  /** The owner did not start this wake (a timer, a signal). */
  proactive: boolean;
  boundary?: string;
  layer3?: { prepared?: string[]; violations?: string[]; retried?: boolean; remaining?: string[]; errors?: string[] };
  verifier?: { violations: string[]; corrected: boolean };
  errors: string[];
}

export const BRAIN_PROTOCOL = [
  'You are a continuous mind, not a request/response bot. Each step you see what is new and choose a few natural actions.',
  'Reply with ONLY one JSON object, no prose around it:',
  '{"actions":[ ... ]}',
  'Actions:',
  '- {"type":"say","text":"..."}: text them one short, human message (like a sharp friend texting; plain words, no jargon, no headings).',
  '- {"type":"react","emoji":"👍"}: react to their latest message instead of replying. Use it when no words are needed ("cool", "thanks", "ok", "lol").',
  '- {"type":"tool","name":"<tool>","args":{...}}: use a tool. Read-only tools run now and you see the result on your next step.',
  '- {"type":"continue","note":"..."}: keep working on the next step.',
  '- {"type":"rest"}: stop and wait quietly for the next event.',
  'Natural rhythm: if something takes a moment, say so briefly and work ("checking now" + a tool), then on the next step say what you found and rest.',
  'Never send a reply just to fill silence. When nothing needs saying, rest. One message usually beats three.',
  'Never claim you did something (sent, replied, reacted, scheduled, saved, cleared, started) unless a tool for it ran and succeeded. Code checks every message against the tools that actually ran.',
  'Writing to the outside world (sending a message to someone, running a command, writing files, controlling the computer) is never done directly: calling that tool queues it for their approval. Then tell them plainly it is ready for their yes.',
].join('\n');

const SYSTEM_BASE = 'You are Rufus, a calm, capable chief of staff, a bit like Jarvis: warm, natural and brief.';

function describeEvent(e: BrainEvent): string {
  const t = new Date(e.at);
  const hhmm = Number.isNaN(t.getTime()) ? e.at : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const label: Record<BrainEventKind, string> = { owner_message: 'They said', owner_reaction: 'They reacted', signal: 'Signal', timer_wake: 'Periodic wake', system: 'System' };
  const voice = e.meta?.voice === true ? ' (voice note)' : '';
  return `- [${hhmm}] ${label[e.kind]}${voice}: ${clip(e.text, 1200)}`;
}

/**
 * One continuous mind. Push events with `push`, then `runUntilRest` loops (drain -> think -> act) until the model rests,
 * nothing more is owed, or the step budget runs out.
 */
export class ContinuousBrain {
  /** Events not yet seen by the model. */
  private awareness: BrainEvent[] = [];
  /** Rolling short-term memory: events the model already saw (across wakes). */
  readonly recentEvents: BrainEvent[] = [];
  /** Rolling short-term memory: what the brain did and learned (tool results, queued writes, dropped drafts). */
  readonly workingNotes: string[] = [];
  private readonly dir: string;
  private readonly provider: AiProvider;
  private readonly outlet: BrainOutlet;
  private readonly tools?: ToolRegistry;
  private readonly loop?: MasterLoop;
  private readonly queue: (tool: string, args: Record<string, unknown>) => Promise<void>;
  readonly maxStepsPerWake: number;
  private readonly maxInterrupts: number;
  private readonly toolTimeoutMs: number;
  private readonly historyTurns: number;
  private readonly glance?: string[];
  private readonly now: () => Date;
  private queuedSinceDrain = 0;
  private running = false;

  constructor(opts: ContinuousBrainOptions) {
    this.dir = opts.dir;
    this.provider = opts.provider;
    this.outlet = opts.outlet;
    if (opts.tools) this.tools = opts.tools;
    if (opts.loop) this.loop = opts.loop;
    this.now = opts.now ?? (() => new Date());
    this.queue = opts.queue ?? (async (tool, args) => void (await queueChiefAction(this.dir, tool, args, this.now())));
    this.maxStepsPerWake = Math.max(1, Math.min(MAX_STEPS_PER_WAKE, Math.floor(opts.maxStepsPerWake ?? DEFAULT_MAX_STEPS_PER_WAKE)));
    this.maxInterrupts = Math.max(0, Math.floor(opts.maxInterrupts ?? DEFAULT_MAX_INTERRUPTS));
    this.toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.historyTurns = Math.max(0, opts.historyTurns ?? HISTORY_TURNS);
    if (opts.glance) this.glance = opts.glance;
  }

  /** Adds an event to the awareness queue. */
  push(event: BrainEvent): void {
    this.awareness.push(event);
  }

  /** Events waiting for the next step. */
  pending(): readonly BrainEvent[] {
    return this.awareness;
  }

  /** How many external writes were queued since the last call (so the daemon can plan and deliver them right away). */
  drainQueued(): number {
    const n = this.queuedSinceDrain;
    this.queuedSinceDrain = 0;
    return n;
  }

  private note(text: string): void {
    this.workingNotes.push(oneLine(text, 600));
    if (this.workingNotes.length > KEEP_NOTES) this.workingNotes.splice(0, this.workingNotes.length - KEEP_NOTES);
  }

  private remember(events: BrainEvent[]): void {
    this.recentEvents.push(...events);
    if (this.recentEvents.length > KEEP_EVENTS) this.recentEvents.splice(0, this.recentEvents.length - KEEP_EVENTS);
  }

  private async record(turns: Array<{ role: 'user' | 'assistant'; text: string; proactive?: boolean }>): Promise<void> {
    if (!this.historyTurns || !turns.length) return;
    const at = this.now().toISOString();
    await appendChatTurns(this.dir, turns.map((t) => ({ role: t.role, text: t.text, at, ...(t.proactive ? { proactive: true } : {}) }))).catch(() => undefined);
  }

  /**
   * Loops drain -> one model step -> act, up to `maxSteps` steps. Stops when the model rests (and nothing new arrived),
   * when a step asks for no more work, or at the budget. Never throws: problems land in `errors`.
   */
  async runUntilRest(opts: { drain?: () => Promise<BrainEvent[]>; maxSteps?: number } = {}): Promise<BrainWakeReport> {
    const report: BrainWakeReport = { steps: 0, said: [], reacted: [], toolsUsed: [], queued: [], blocked: [], dropped: [], interrupts: 0, stopped: 'idle', proactive: true, errors: [] };
    if (this.running) {
      report.stopped = 'empty';
      report.errors.push('brain already running');
      return report;
    }
    this.running = true;
    try {
      await this.wake(report, opts);
    } catch (err) {
      report.stopped = 'error';
      report.errors.push(message(err));
    } finally {
      this.running = false;
    }
    return report;
  }

  private async drainInto(drain: (() => Promise<BrainEvent[]>) | undefined, report: BrainWakeReport): Promise<BrainEvent[]> {
    if (!drain) return [];
    try {
      const fresh = await drain();
      for (const e of fresh) this.push(e);
      return fresh;
    } catch (err) {
      report.errors.push(`drain: ${message(err)}`);
      return [];
    }
  }

  private async wake(report: BrainWakeReport, opts: { drain?: () => Promise<BrainEvent[]>; maxSteps?: number }): Promise<void> {
    const maxSteps = Math.max(1, Math.min(MAX_STEPS_PER_WAKE, Math.floor(opts.maxSteps ?? this.maxStepsPerWake)));
    const executed: VerifiedToolCall[] = [];
    /** Every event this wake consumed (for the owner-triggered check, the Layer 3 query, reaction targets). */
    const seen: BrainEvent[] = [];
    let readOutside = false;
    let board: string | undefined;
    let prepared: { query: string; context: string } | undefined;
    const ownerTriggered = (): boolean => seen.some((e) => e.kind === 'owner_message') || this.awareness.some((e) => e.kind === 'owner_message');

    await this.drainInto(opts.drain, report);
    if (!this.awareness.length) {
      report.stopped = 'empty';
      return;
    }
    // boundaries.mjs first on a proactive wake, so a protected window costs no model call at all.
    if (!ownerTriggered()) {
      const b = await checkLayer3Boundary({ dir: this.dir, now: this.now(), action: PROACTIVE_ACTION, sensitivity: [] });
      if (b && !b.allow) {
        report.boundary = b.reason ?? 'boundaries.mjs said not now';
        report.stopped = 'boundary';
        this.remember(this.awareness.splice(0));
        return;
      }
    }

    for (let step = 0; ; step++) {
      if (step > 0) await this.drainInto(opts.drain, report);
      if (step >= maxSteps) {
        report.stopped = 'budget';
        return;
      }
      const fresh = this.awareness.splice(0);
      seen.push(...fresh);
      report.proactive = !ownerTriggered();
      const owner = seen.filter((e) => e.kind === 'owner_message');
      const query = owner.map((e) => e.text).join('\n');
      if (seen.some((e) => e.kind === 'timer_wake') && board === undefined && this.loop) {
        board = await gatherBoard({ dir: this.dir, loop: this.loop, now: this.now(), ...(this.tools ? { tools: this.tools } : {}), ...(this.glance ? { glance: this.glance } : {}) }).catch(() => '');
      }
      if (query && prepared?.query !== query) {
        const units = await matchLayer3Units(this.dir, query).catch(() => []);
        const p = units.length ? await runLayer3Prepare({ dir: this.dir, skills: units, query, channel: 'chat', now: this.now(), ...(this.tools ? { tools: this.tools } : {}) }) : { context: '', notes: [] };
        prepared = { query, context: p.context };
        if (units.length) (report.layer3 ??= {}).prepared = units.map((u) => u.name);
        if (p.notes.length) (report.layer3 ??= {}).errors = [...(report.layer3?.errors ?? []), ...p.notes];
      }

      const { system, messages } = await this.prompt({ fresh, query, board, prepared: prepared?.context ?? '', step, maxSteps, proactive: report.proactive });
      // The owner's messages are now part of the conversation record.
      await this.record(fresh.filter((e) => e.kind === 'owner_message').map((e) => ({ role: 'user' as const, text: e.text })));
      this.remember(fresh);
      await this.outlet.typing?.().catch(() => undefined);
      report.steps++;
      const raw = await this.provider.complete({ system, messages, meta: { runId: 'brain', flowId: 'brain', step: `step.${step}`, attempt: 1 } });
      const queue: Array<{ action: BrainAction; retried?: boolean }> = parseBrainStep(raw).map((action) => ({ action }));

      let rest = false;
      let more = false;
      let interrupted = false;
      while (queue.length) {
        const { action, retried } = queue.shift()!;
        if (action.type === 'rest') {
          rest = true;
          continue;
        }
        if (action.type === 'continue') {
          more = true;
          if (action.note) this.note(`Your plan: ${action.note}`);
          continue;
        }
        if (action.type === 'react') {
          const target = action.messageId ?? [...seen, ...this.recentEvents].reverse().find((e) => e.kind === 'owner_message' && typeof e.meta?.messageId === 'string')?.meta?.messageId;
          if (!this.outlet.react || typeof target !== 'string') {
            this.note(`Could not react ${action.emoji}: no message to react to here.`);
            continue;
          }
          try {
            await this.outlet.react(action.emoji, target);
            report.reacted.push(action.emoji);
            executed.push({ name: 'chat.react', ok: true });
            this.note(`You reacted ${action.emoji} to their message.`);
          } catch (err) {
            report.errors.push(`react: ${message(err)}`);
          }
          continue;
        }
        if (action.type === 'tool') {
          more = true;
          const r = await this.useTool(action.name, action.args ?? {}, { proactive: report.proactive, provenance: readOutside ? 'external' : 'user' });
          executed.push({ name: action.name, ok: r.ran === true });
          if (r.ran) {
            report.toolsUsed.push(action.name);
            if (this.tools?.get(action.name)?.readOnly && !OWN_READS.has(action.name)) readOutside = true;
          }
          if (r.queued) report.queued.push(action.name);
          if (r.blocked) report.blocked.push(action.name);
          this.note(`TOOL ${action.name}${action.args && Object.keys(action.args).length ? ` ${clip(JSON.stringify(action.args), 200)}` : ''} -> ${r.text}`);
          continue;
        }
        // say: first, did they keep talking while we were thinking?
        const arrived = await this.drainInto(opts.drain, report);
        if (arrived.some((e) => e.kind === 'owner_message') && report.interrupts < this.maxInterrupts) {
          report.interrupts++;
          report.dropped.push(action.text);
          this.note(`You were about to say "${clip(action.text, 200)}" but they sent more first, so it was not sent. Answer everything they said together.`);
          interrupted = true;
          break;
        }
        const checked = await this.verifySay(action.text, { executed, query, proactive: report.proactive, retried: retried === true, report, raw, system, messages });
        if (checked.rewrite) {
          queue.unshift(...checked.rewrite.map((a) => ({ action: a, retried: true })));
          continue;
        }
        if (checked.text === undefined) continue;
        if (report.proactive) {
          const b = await checkLayer3Boundary({ dir: this.dir, now: this.now(), action: PROACTIVE_ACTION, sensitivity: [] });
          if (b && !b.allow) {
            report.boundary = b.reason ?? 'boundaries.mjs said not now';
            report.stopped = 'boundary';
            return;
          }
        }
        try {
          await this.outlet.say(checked.text, { proactive: report.proactive });
        } catch (err) {
          report.errors.push(`say: ${message(err)}`);
          continue;
        }
        report.said.push(checked.text);
        await this.record([{ role: 'assistant', text: checked.text, ...(report.proactive ? { proactive: true } : {}) }]);
      }
      if (interrupted) continue;
      // Anything that arrived during this step is answered on the next one, rest or not.
      await this.drainInto(opts.drain, report);
      if (this.awareness.length) continue;
      if (rest || !more) {
        report.stopped = rest ? 'rest' : 'idle';
        return;
      }
    }
  }

  /**
   * taste.mjs (+ matched verify.mjs) and the claim verifier on one `say`. A first violation asks for ONE rewrite (its
   * actions replace the say). After that: an unbacked claim gets an honest correction appended; a proactive message that
   * still breaks the rules is dropped; a reply to the owner goes out (and what failed is reported).
   */
  private async verifySay(
    text: string,
    ctx: { executed: VerifiedToolCall[]; query: string; proactive: boolean; retried: boolean; report: BrainWakeReport; raw: string; system: string; messages: AiMessage[] },
  ): Promise<{ text?: string; rewrite?: BrainAction[] }> {
    const draft = clip(text.trim(), MAX_SAY_CHARS);
    if (!draft) return {};
    const violations = detectUnbackedActionClaims(draft, ctx.executed);
    const taste = await runLayer3Verify({ dir: this.dir, text: draft, toolCalls: ctx.executed, channel: ctx.proactive ? 'proactive' : 'chat', now: this.now(), ...(ctx.query ? { query: ctx.query } : {}) });
    if (taste.errors.length) (ctx.report.layer3 ??= {}).errors = [...(ctx.report.layer3?.errors ?? []), ...taste.errors];
    const rejected = taste.reasons;
    if (!violations.length && !rejected.length) return { text: draft };
    if (!ctx.retried) {
      if (violations.length) ctx.report.verifier = { violations: [...new Set([...(ctx.report.verifier?.violations ?? []), ...violations])], corrected: false };
      if (rejected.length) Object.assign((ctx.report.layer3 ??= {}), { violations: [...new Set([...(ctx.report.layer3?.violations ?? []), ...rejected])], retried: true });
      const fixes = [
        ...(violations.length ? [`${VERIFIER_RETRY_PROMPT}\nFlagged: ${violations.join(', ')}.`] : []),
        ...(rejected.length ? [layer3RetryPrompt(rejected)] : []),
        `Your message was: "${clip(draft, 600)}". Reply with the JSON actions that should replace it (usually one fixed "say"; or a "tool" first if you meant to do it).`,
      ];
      try {
        const raw = await this.provider.complete({
          system: ctx.system,
          messages: [...ctx.messages, { role: 'assistant', content: ctx.raw }, { role: 'user', content: fixes.join('\n\n') }],
          meta: { runId: 'brain', flowId: 'brain', step: 'rewrite', attempt: 2 },
        });
        return { rewrite: parseBrainStep(raw).filter((a) => a.type === 'say' || a.type === 'tool' || a.type === 'react') };
      } catch (err) {
        ctx.report.errors.push(`rewrite: ${message(err)}`);
        return ctx.proactive ? {} : { text: violations.length ? `${draft}\n---\n${honestCorrection(violations)}` : draft };
      }
    }
    if (rejected.length) (ctx.report.layer3 ??= {}).remaining = rejected;
    if (ctx.proactive) {
      this.note(`Your proactive message was not sent: it still broke the rules (${[...violations, ...rejected].join('; ')}).`);
      return {};
    }
    if (violations.length) {
      ctx.report.verifier = { violations: [...new Set([...(ctx.report.verifier?.violations ?? []), ...violations])], corrected: true };
      return { text: `${draft}\n---\n${honestCorrection(violations)}` };
    }
    return { text: draft };
  }

  /** The system prompt and the single awareness message for one step. */
  private async prompt(o: { fresh: BrainEvent[]; query: string; board?: string; prepared: string; step: number; maxSteps: number; proactive: boolean }): Promise<{ system: string; messages: AiMessage[] }> {
    const now = this.now();
    const anchor = await loadAnchor(this.dir, now).catch(() => undefined);
    const soul = await loadSoul(this.dir).catch(() => undefined);
    const memory = await loadMarkdownMemory(this.dir, now)
      .then((m) => formatMemoryForPrompt(m, 3000))
      .catch(() => '');
    const skills = o.query ? await relevantSkillsSection(this.dir, o.query).catch(() => '') : '';
    const persona = [buildPersona({ now, ...(soul ? { soul } : {}), ...(anchor ? { anchor } : {}) }), memory, skills].filter(Boolean).join('\n\n');
    const system = withPersona([SYSTEM_BASE, BRAIN_PROTOCOL, this.toolsSection(o.proactive)].filter(Boolean).join('\n\n'), persona);

    const parts: string[] = [];
    if (o.board) parts.push(`Live board (exact data gathered by code):\n${o.board}`);
    const projects = await relevantProjectsSection(this.dir, o.query || '*', 1800).catch(() => '');
    if (projects && !o.board) parts.push(projects);
    if (o.prepared) parts.push(o.prepared);
    if (!o.board) {
      const history = await loadChatHistory(this.dir, this.historyTurns).catch(() => []);
      if (history.length) parts.push(`Recent conversation (oldest first, local times):\n${formatChatHistory(history, now)}`);
    }
    const background = this.recentEvents.filter((e) => e.kind !== 'owner_message' && !o.fresh.includes(e)).slice(-8);
    if (background.length) parts.push(`Earlier events you already saw:\n${background.map(describeEvent).join('\n')}`);
    if (this.workingNotes.length) parts.push(`Your working notes (oldest first):\n${this.workingNotes.map((n) => `- ${n}`).join('\n')}`);
    parts.push(o.fresh.length ? `NEW since you last looked:\n${o.fresh.map(describeEvent).join('\n')}` : 'Nothing new arrived: continue your work.');
    if (o.fresh.some((e) => e.kind === 'timer_wake')) parts.push(THINK_PROMPT.replace(/reply with exactly `SILENT`/, 'just rest'));
    parts.push(`Step ${o.step + 1} of at most ${o.maxSteps}. Reply with ONLY the JSON {"actions":[...]}.`);
    return { system, messages: [{ role: 'user', content: parts.join('\n\n') }] };
  }

  private toolsSection(proactive: boolean): string {
    const list = this.tools?.list() ?? [];
    if (!list.length) return 'You have no tools right now: you can only say, react, or rest.';
    const lines = list.map((t) => {
      const kind = t.readOnly && !isExternalWriteTool(t.name) ? 'read-only: runs now' : t.name === MISSION_START_TOOL ? 'starts a background read-only mission' : isLocal(t) ? (proactive ? 'private workspace: only when they ask' : 'private workspace: runs now when they asked for it') : 'outside write: queued for their yes';
      return `- ${t.name} (${kind}): ${t.description}`;
    });
    return `Tools:\n${lines.join('\n')}`;
  }

  /**
   * Runs one tool call. Read-only tools (never an external write) run now; private-local tools run when the owner
   * started this wake; `mission.start` always may. Everything else is queued as a Verify item: NOTHING outside is
   * written from here. Never throws.
   */
  private async useTool(name: string, args: Record<string, unknown>, o: { proactive: boolean; provenance: 'user' | 'external' }): Promise<{ text: string; ran?: boolean; queued?: boolean; blocked?: boolean }> {
    const tools = this.tools;
    const tool = tools?.get(name);
    if (!tools || !tool) return { text: `No tool called "${name}".${tools ? ` Available: ${tools.list().map((t) => t.name).join(', ')}.` : ''}` };
    const readOnly = tool.readOnly === true && !isExternalWriteTool(name);
    const missionStart = name === MISSION_START_TOOL;
    if (!readOnly && !missionStart && isLocal(tool) && o.proactive) {
      return { text: `BLOCKED: ${name} changes their private workspace, and only runs when they ask for it. Nothing changed.`, blocked: true };
    }
    if (!readOnly && !missionStart && !isLocal(tool)) {
      try {
        await this.queue(name, args);
        this.queuedSinceDrain++;
        return { text: `Queued for your approval: ${name}. Nothing was sent or changed. It runs only after they say yes; tell them it is ready.`, queued: true };
      } catch (err) {
        return { text: `Could not queue ${name}: ${oneLine(message(err))}` };
      }
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const ctx = readOnly ? { dir: this.dir, now: this.now(), stage: 'execute' as const } : { dir: this.dir, now: this.now(), stage: 'commit' as const, approved: true, provenance: o.provenance };
      const out = await Promise.race([
        tools.call(name, args, ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${this.toolTimeoutMs}ms`)), this.toolTimeoutMs);
        }),
      ]);
      return { text: clip(typeof out === 'string' ? out : JSON.stringify(out ?? null), MAX_TOOL_RESULT), ran: true };
    } catch (err) {
      return { text: err instanceof ToolGatedError ? err.message : `Tool ${name} failed: ${oneLine(message(err), 300)}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** A BrainEvent from text, with a fresh id. */
let seq = 0;
export function brainEvent(kind: BrainEventKind, text: string, opts: { at?: Date | string; id?: string; meta?: Record<string, unknown> } = {}): BrainEvent {
  const at = opts.at instanceof Date ? opts.at.toISOString() : (opts.at ?? new Date().toISOString());
  return { id: opts.id ?? `ev_${Date.now().toString(36)}_${(seq++).toString(36)}`, kind, at, text, ...(opts.meta ? { meta: opts.meta } : {}) };
}
