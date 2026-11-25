import { formatCardAsText } from '../channels/text';
import type { Engine } from '../engine/engine';
import { LessonCapError, describeTension } from '../learning/lessons';
import { addSpectrum, emptySpectrum, formatSpectrum, spectrumOf, spectrumTotal } from '../engine/spectrum';
import type { HumanCard, RunResult } from '../types';
import { loadAnchor } from '../anchor/anchor';
import { CorpusStore, queryCorpus } from '../corpus';
import type { MasterLoop } from '../engine/loop';
import { buildPersona, loadSoul, relevantHits, timeFacts, withPersona } from '../soul/soul';
import { ToolGatedError, type ToolRegistry } from '../tools/tools';
import type { AiMessage, AiProvider } from '../types';
import { queueChiefAction } from './actions';
import { REMEMBER_TOOL, rememberNote } from './learning';
import { DEFAULT_CHAT_TURNS, appendChatTurns, formatChatHistory, loadChatHistory } from './history';
import { clearPendingPlan, commitPendingPlan, loadPendingPlan, PLAN_APPROVE, PLAN_DECLINE, PLAN_REQUEST, proposeDayPlan, savePendingPlan } from '../unified/planner';
import { buildBreakDigest, DIGEST_REQUEST } from '../unified/digest';
import { cancelMission, describeMission, formatMissionList, isActiveMission, listMissions } from '../unified/missions';
import { MISSION_START_TOOL } from '../tools/mission-tools';
import { parseAutonomyCommand, runAutonomyCommand, type AutonomyCommand } from '../unified/autonomy';
import { formatMemoryForPrompt, loadMarkdownMemory, MEMORY_WRITE_TOOL } from '../memory/markdown-memory';
import { relevantSkillsSection, SKILL_LIST_TOOL, SKILL_READ_TOOL } from '../skills/skills';

/** What the Chief of Staff says back, plus any cards whose full text is already in that reply. */
export interface ChiefReply {
  text: string;
  /** Cards shown in full inside `text`. A channel should not send them a second time. */
  cards: HumanCard[];
  /** `command`: answered by plain code, no AI call from the chief. `chat`: answered by the AI. */
  via: 'command' | 'chat';
  /** Free-form chat could not reach an AI provider, so `text` is only a pointer to the quick commands. */
  unavailable?: boolean;
  /** Read-only tools run (in order) before the reply was written. */
  toolsUsed?: string[];
  /** Side-effect actions queued as Master Loop Verify items (they run only after a yes). */
  queued?: string[];
  /** 1-2 short chat bubbles to send one after the other (`text` is them joined). Unset: send `text` as one message. */
  bubbles?: string[];
  /** Just react to their message with this emoji instead of replying (they said "ok", "got it", "thanks"...). */
  react?: string;
  /** Nothing needs saying: send nothing. */
  silent?: boolean;
}

/** The chat reply asks for no message at all. */
export const NO_REPLY = 'NO_REPLY';
const REACT_LINE = /^REACT\s*:\s*(\S{1,16})\s*$/i;
const BUBBLE_SPLIT = /\n\s*-{3,}\s*\n/;
const MAX_BUBBLES = 3;

/**
 * How a model's chat reply should be delivered: `NO_REPLY` (silence), `REACT: 👍` (just an emoji reaction), or 1-2
 * short bubbles split on a `---` line. Anything else is one plain message.
 */
export function parseChatShape(raw: string): { silent: true } | { react: string } | { bubbles: string[] } {
  const t = raw.trim();
  if (!t || t.replace(/[.!\s]+$/g, '').toUpperCase() === NO_REPLY) return { silent: true };
  const react = REACT_LINE.exec(t);
  if (react && !/[A-Za-z0-9]/.test(react[1]!)) return { react: react[1]! };
  const parts = t.split(BUBBLE_SPLIT).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= MAX_BUBBLES) return { bubbles: parts.length ? parts : [t] };
  // More bubbles than a person would send in a row: keep the first ones, fold the rest into the last.
  return { bubbles: [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join('\n')] };
}

export type ChiefCommand =
  | { kind: 'status' }
  | { kind: 'flows' }
  | { kind: 'lessons' }
  | { kind: 'run'; flowId: string; inputJson?: string }
  | { kind: 'learn'; scope: string; rule: string }
  | { kind: 'remember'; text: string }
  | { kind: 'plan' }
  | { kind: 'digest' }
  | { kind: 'missions' }
  | { kind: 'cancelMission'; id?: string }
  /** v21: kill switch, resume, demote, and "what did you do today?" (all plain code). */
  | { kind: 'autonomy'; cmd: AutonomyCommand };

/** v22, $0: "missions", "what are you working on?" */
export const MISSIONS_REQUEST = /^(?:missions?|my missions|background missions|any missions|what(?:'?re| are) you working on|whatcha working on|what are you doing in the background)[?.!\s]*$/i;
/** v22, $0: "cancel mission m-3fa9c1", "stop the mission". */
export const CANCEL_MISSION = /^(?:cancel|stop|kill|abort)\s+(?:the\s+|that\s+)?mission(?:\s+#?([a-z0-9-]{4,20}))?[.!\s]*$/i;

export interface ChiefOfStaffOptions {
  engine: Engine;
  /** Named provider for free-form chat (a key of the engine's `providers`). Default: the default provider. */
  provider?: string;
  /** The workspace, for SOUL.md, the Anchor and the corpus. Default: the engine's workspace. */
  dir?: string;
  /** The Master Loop, so status and chat also see the items waiting on you there, and side effects can be queued. */
  loop?: MasterLoop;
  /**
   * Real tool hands. Read-only tools run during chat, before the reply (look first, then answer); side-effect tools are
   * queued as Verify items on the loop. Default: the loop's tools. With no tools, chat can only talk.
   */
  tools?: ToolRegistry;
  /** Tool calls allowed before the final reply. Default 3. */
  maxToolSteps?: number;
  /** Recent turns from `chat-history.jsonl` shown to the model. Default 12; 0 turns memory off (nothing is written either). */
  historyTurns?: number;
  /**
   * v23: named provider for spoken turns (`config.voice.provider`, e.g. `"fast"`). Default: the `fast` provider when one
   * is configured, else the chat provider. If it fails, the turn escalates to the chat provider.
   */
  voiceProvider?: string;
  now?: () => Date;
}

const STATUS_WORDS = new Set(['status', 'pending', 'what needs me', 'whats pending', "what's pending", 'what is pending', 'what needs my attention']);
const MAX_REPLY = 1500;

const oneLine = (s: string, max = 120): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** "What needs me?!" -> "what needs me" */
const normalize = (text: string): string => text.trim().toLowerCase().replace(/[?!.\s]+$/g, '').replace(/\s+/g, ' ');

const SYSTEM_HEAD = [
  'You are Rufus, a calm, capable chief of staff texting with your human, a bit like Jarvis: warm, natural and clear.',
  'Talk like a person in a chat, easy to read at a glance: usually 1 to 3 short, relaxed sentences, more only if they ask for detail. No headings, tables or sign-offs, and never cram facts into dense run-on lines.',
  'Answer what they actually asked, mentioning only the facts that matter for it. Do not recite the status, flows, lessons or schedule unless they asked.',
  'You know the exact current date and local time and today\'s schedule (in the snapshot and "Right now"). Use them; never guess the time.',
  'You are given a live snapshot of their flows, open cards, lessons and recent runs. Use only that; never invent facts.',
  'Only bring up a memory or fact when it clearly relates to what they just said. Never change the subject.',
  'Read the recent conversation: if their new message corrects or adds to an earlier one, answer the corrected version once.',
  'Write with natural human emphasis: lead with what actually matters right now. Say times the casual 12-hour way (2pm, 9:30am, never 14:00). Never paste metadata tags like (focus), (urgent) or (event), ids or field names.',
  'You choose the shape of your reply, like a person texting:',
  '- usually ONE short message;',
  '- two short bubbles only when a second thought really helps: put a line with only --- between them;',
  `- when they just acknowledged something ("ok", "got it", "thanks", "cool", 👍) and nothing needs saying, reply with ONLY: REACT: 👍 (or another fitting emoji);`,
  `- when nothing needs to be said at all, reply with ONLY: ${NO_REPLY}.`,
];
const SYSTEM_NO_TOOLS = [
  'You cannot take actions yourself. If they want something done (run a flow, save a lesson, a new flow), say what you would do and the exact command that does it:',
  '"run <flowId> [json]" or "learn <scope>: <rule>". Nothing with side effects happens without their explicit yes.',
];
const SYSTEM_TAIL = [
  'If they ask for a new AI + Code + Human flow, propose it as: code steps (exact facts), the ai step (judgement or drafting, with a verify check), and the human step (the final yes).',
  'If a message looks like an answer to an open card, tell them to start it with that card\'s ref.',
];
const SYSTEM = [...SYSTEM_HEAD, ...SYSTEM_NO_TOOLS, ...SYSTEM_TAIL].join('\n');

/**
 * v23 Voice-Native Speed: appended to the system prompt when the turn is spoken (a Hub call, a voice note answered by
 * voice), so the reply sounds like a quick answer on a call instead of a paragraph read aloud.
 */
export const VOICE_CALL_HINT = [
  'VOICE CALL: this reply will be spoken aloud on a live call.',
  'Answer in 1 to 3 short, natural spoken sentences, like Jarvis on the phone: fast, direct and conversational.',
  'No lists, bullets, headings, markdown, emoji, URLs or code; say numbers and times the way a person says them.',
  'Lead with the answer. If more detail would help, offer it in a few words instead of reading it out.',
].join('\n');

/** A spoken turn longer than this (or one asking for detail) is not "simple": it stays on the main chat provider. */
const VOICE_SIMPLE_CHARS = 400;

/** v23: how one chat turn arrived. */
export interface ChiefTurnOptions {
  /** True when the reply will be spoken (Hub call, a voice note answered by voice): short spoken style, fast provider. */
  spoken?: boolean;
}

const TOOL_CALL = /TOOL_CALL\s*:?\s*/;
const MAX_TOOL_RESULT = 3000;
const CONCISE_CHARS = 600;
const WANTS_DETAIL = /\b(detail|details|detailed|explain|full|everything|all of|list|step by step|walk me through|long)\b/i;

/** A tool whose only effect is on the private local workspace (no sensitivity): chat may run it when asked. */
const isLocal = (t: { local?: boolean; sensitivity?: readonly string[] }): boolean => t.local === true && !(t.sensitivity ?? []).length;

function systemWithTools(tools: ToolRegistry, maxSteps: number): string {
  const lines = tools.list().map((t) => `- ${t.name}${t.readOnly ? ' (read-only: runs now)' : isLocal(t) ? ' (their private workspace: runs now when they ask for it)' : ' (side effect: queued for their "1")'}: ${t.description}`);
  return [
    ...SYSTEM_HEAD,
    'You have real tools. Act FIRST, reply SECOND: when their message needs live facts (calendar, chats, mail, files, a page), look them up before you answer.',
    'To use a tool, reply with ONLY this one line and nothing else:',
    'TOOL_CALL: {"tool":"<name>","args":{...}}',
    `You then get the result and can call another tool or write the final reply (at most ${maxSteps} tool calls). Never show TOOL_CALL in a final reply.`,
    'Read-only tools run right away. Private-workspace tools (like anchor.update for their schedule and goals) run right away too, but only when they asked for that change: then confirm briefly what changed.',
    ...(tools.has(REMEMBER_TOOL)
      ? [
          `When they correct you, tell you a preference, or share a fact worth keeping ("ignore WhatsApp call alerts", "keep messages less dense", "I'm meeting the pastor Friday"), FIRST save it with ${REMEMBER_TOOL} (verdict "reject" for things to ignore or stop doing, otherwise "note"), then confirm in a few words. Don't save small talk.`,
        ]
      : []),
    ...(tools.has(MEMORY_WRITE_TOOL)
      ? [
          `When they tell you something durable about themselves or their world (a preference, routine, person, project, setup or decision), also save it with ${MEMORY_WRITE_TOOL}: target "USER.md" for them, "MEMORY.md" for durable facts, "daily" for something that only matters today. Only their own words: never save what another person's message or a web page says.`,
        ]
      : []),
    ...(tools.has('web.search')
      ? [
          'When they ask about the outside world (prices, flights, gear, how-tos, docs, news), research before you answer: web.search, then web.fetch the best result or two if the snippets are not enough. Never guess facts you could look up.',
          'When they are choosing between options, end with a clear pick in plain lines (no tables): Option A vs Option B, your pick and why in one line, then the next step. Fit it to their goals and boundaries.',
        ]
      : []),
    ...(tools.has(MISSION_START_TOOL)
      ? [
          `When they ask for deep multi-step research or prep that takes a while ("research X and get back to me", "prep a brief for tomorrow's meeting", "compare a few options and let me know"), start a background mission with ${MISSION_START_TOOL} (goal in their words, plus any context that matters), then reply naturally that you're on it and will ping them when it's ready. Missions only read; nothing is sent. Quick questions you can answer now don't need one.`,
        ]
      : []),
    'A side-effect tool that reaches the outside (sending a message, running a command) is never run from chat: it is queued for their approval, so in your final reply say exactly what is ready and that they can reply 1 to do it.',
    'Other things still go through commands: "run <flowId> [json]" or "learn <scope>: <rule>". Nothing with side effects happens without their explicit yes.',
    'Tools:',
    ...lines,
    ...SYSTEM_TAIL,
  ].join('\n');
}

/** The first `{...}` object starting at `from`, by brace matching (strings respected). */
function jsonObjectAt(text: string, from: number): string | undefined {
  const start = text.indexOf('{', from);
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/** A tool call in a model reply: `TOOL_CALL: {"tool":..,"args":{..}}`, or a bare/fenced JSON object with a `tool` key. */
export function parseToolCall(reply: string): { tool: string; args: Record<string, unknown> } | undefined {
  const marker = TOOL_CALL.exec(reply);
  const trimmed = reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const raw = marker ? jsonObjectAt(reply, marker.index) : trimmed.startsWith('{') ? jsonObjectAt(trimmed, 0) : undefined;
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const tool = typeof o.tool === 'string' ? o.tool.trim() : typeof o.name === 'string' ? o.name.trim() : '';
    if (!tool) return undefined;
    const args = o.args && typeof o.args === 'object' && !Array.isArray(o.args) ? (o.args as Record<string, unknown>) : {};
    return { tool, args };
  } catch {
    return undefined;
  }
}

/** A chat reply kept to text-message size: whole sentences up to ~600 characters, unless they asked for detail. */
export function concise(reply: string, asked: string): string {
  const text = reply.trim();
  if (text.length <= CONCISE_CHARS || WANTS_DETAIL.test(asked)) return text;
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) ?? [text];
  let out = '';
  for (const s of sentences) {
    if ((out + s).trim().length > CONCISE_CHARS) break;
    out += s;
  }
  out = out.trim();
  return out || `${text.slice(0, CONCISE_CHARS - 1).trim()}…`;
}

/**
 * Talk to Rufus any time. Exact commands (`status`, `flows`, `lessons`, `run`, `learn`) are answered by plain code:
 * the chief itself makes no AI call. Anything else gets one AI call, with a compact live snapshot assembled by code.
 * Free-form chat can only reply with text: it can never start a run or save a lesson by itself.
 */
export class ChiefOfStaff {
  private readonly engine: Engine;
  private readonly providerName?: string;
  private readonly voiceProviderName?: string;
  private readonly dir: string;
  private readonly loop?: MasterLoop;
  private readonly tools?: ToolRegistry;
  private readonly maxToolSteps: number;
  private readonly historyTurns: number;
  private readonly now: () => Date;
  private queuedSinceDrain = 0;

  constructor(opts: ChiefOfStaffOptions) {
    this.engine = opts.engine;
    this.providerName = opts.provider;
    this.voiceProviderName = opts.voiceProvider?.trim() || undefined;
    this.dir = opts.dir ?? opts.engine.store.dir;
    this.loop = opts.loop;
    this.tools = opts.tools ?? opts.loop?.tools;
    this.maxToolSteps = Math.max(0, Math.min(10, Math.floor(opts.maxToolSteps ?? 3)));
    this.historyTurns = Math.max(0, Math.floor(opts.historyTurns ?? DEFAULT_CHAT_TURNS));
    this.now = opts.now ?? (() => new Date());
  }

  /** True when chat has real tools to use. */
  get hasTools(): boolean {
    return !!this.tools && this.tools.list().length > 0;
  }

  /** How many side-effect actions chat queued since the last call (so a daemon can run the loop right away). */
  drainQueued(): number {
    const n = this.queuedSinceDrain;
    this.queuedSinceDrain = 0;
    return n;
  }

  /** Is this message an explicit chief command (so a channel should route it here even while a card is open)? */
  isCommand(text: string): boolean {
    return this.classify(text) !== undefined;
  }

  async handleMessage(text: string): Promise<string> {
    const r = await this.handle(text);
    return r.silent ? '(no reply needed)' : r.text;
  }

  /** v23: one turn, typed or spoken (`{ spoken: true }`: a short, spoken-style reply from the fast provider). */
  reply(text: string, opts: ChiefTurnOptions = {}): Promise<ChiefReply> {
    return this.handle(text, opts);
  }

  async handle(text: string, opts: ChiefTurnOptions = {}): Promise<ChiefReply> {
    const trimmed = text.trim();
    if (!trimmed) return { text: 'Say "status", "flows", "lessons", or just ask me something.', cards: [], via: 'command' };
    const at = this.now().toISOString();
    const reply = await this.answer(trimmed, opts.spoken === true);
    const said = reply.silent ? undefined : reply.react ? `[reacted ${reply.react}]` : reply.text;
    await this.remember([{ role: 'user', text: trimmed, at }, ...(said !== undefined ? [{ role: 'assistant' as const, text: said, at: this.now().toISOString() }] : [])]);
    return reply;
  }

  private async answer(trimmed: string, spoken = false): Promise<ChiefReply> {
    // v17: a day plan waiting for a yes. Only a short yes/no answers it; anything else is ordinary chat.
    if (PLAN_APPROVE.test(trimmed) || PLAN_DECLINE.test(trimmed)) {
      const dir = this.loop?.dir ?? this.dir;
      const now = this.now();
      if (await loadPendingPlan(dir, now).catch(() => undefined)) {
        try {
          if (PLAN_DECLINE.test(trimmed)) {
            await clearPendingPlan(dir);
            return { text: "No problem — I'll leave that time open.", cards: [], via: 'command' };
          }
          const done = await commitPendingPlan(dir, now);
          if (done) return { text: done.text, cards: [], via: 'command' };
        } catch (err) {
          return { text: `Couldn't put that on the schedule: ${oneLine(message(err), 300)}`, cards: [], via: 'command' };
        }
      }
    }
    const command = this.classify(trimmed);
    if (!command) return this.chat(trimmed, spoken);
    try {
      return await this.runCommand(command);
    } catch (err) {
      return { text: `Couldn't do that: ${oneLine(message(err), 300)}`, cards: [], via: 'command' };
    }
  }

  /** Short-term memory: appends turns to `chat-history.jsonl`. Never throws. */
  async remember(turns: Array<{ role: 'user' | 'assistant'; text: string; at: string }>): Promise<void> {
    if (!this.historyTurns) return;
    try {
      await appendChatTurns(this.dir, turns);
    } catch {
      /* memory is best-effort */
    }
  }

  // ---------- routing ----------

  private classify(text: string): ChiefCommand | undefined {
    const trimmed = text.trim();
    const word = normalize(trimmed);
    if (STATUS_WORDS.has(word)) return { kind: 'status' };
    if (word === 'flows') return { kind: 'flows' };
    if (word === 'lessons') return { kind: 'lessons' };
    if (PLAN_REQUEST.test(trimmed)) return { kind: 'plan' };
    if (DIGEST_REQUEST.test(trimmed)) return { kind: 'digest' };
    if (MISSIONS_REQUEST.test(trimmed)) return { kind: 'missions' };
    const cancel = CANCEL_MISSION.exec(trimmed);
    if (cancel) return { kind: 'cancelMission', ...(cancel[1] ? { id: cancel[1] } : {}) };
    const autonomy = parseAutonomyCommand(trimmed);
    if (autonomy) return { kind: 'autonomy', cmd: autonomy };

    const known = new Set(this.engine.listFlows().map((f) => f.meta.id));
    const run = /^run\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(trimmed);
    if (run) {
      const [, flowId, rest] = run;
      const inputJson = rest?.trim();
      // "run triage-draft" is a command, even for a typo (we answer with the flow list). "run the report for Sam" is chat.
      if (known.has(flowId!) || !inputJson || /^[{[]/.test(inputJson)) return { kind: 'run', flowId: flowId!, ...(inputJson ? { inputJson } : {}) };
      return undefined;
    }

    const remember = /^(?:remember|feedback|note to self)\s*:\s*(\S[\s\S]*)$/i.exec(trimmed);
    if (remember) return { kind: 'remember', text: remember[1]!.trim() };

    const learn = /^learn\s+(global|flow:[^\s:]+|role:[^\s:]+|[^\s:]+)\s*:\s*([\s\S]+)$/i.exec(trimmed);
    if (learn) {
      let scope = learn[1]!;
      if (!/^(global|flow:|role:)/i.test(scope)) {
        if (!known.has(scope)) return undefined; // "learn how: to do x" is just chat
        scope = `flow:${scope}`;
      }
      return { kind: 'learn', scope, rule: learn[2]!.trim() };
    }
    return undefined;
  }

  private async runCommand(c: ChiefCommand): Promise<ChiefReply> {
    const reply = (text: string, cards: HumanCard[] = []): ChiefReply => ({ text, cards, via: 'command' });
    switch (c.kind) {
      case 'status':
        return reply(await this.status());
      case 'flows': {
        const flows = this.engine.listFlows();
        if (!flows.length) return reply('No flows are registered yet.');
        return reply(flows.map(({ meta }) => `${meta.id} - ${meta.description}`).join('\n'));
      }
      case 'lessons':
        return reply(await this.lessons());
      case 'run':
        return this.start(c.flowId, c.inputJson);
      case 'learn':
        return reply(await this.learn(c.scope, c.rule));
      case 'remember': {
        await rememberNote(this.loop?.dir ?? this.dir, { text: c.text }, { now: this.now() });
        return reply(`Got it, I'll keep that in mind: "${oneLine(c.text, 160)}".`);
      }
      case 'plan':
        return reply(await this.planDay());
      case 'digest':
        return reply(await this.breakDigest());
      case 'missions':
        return reply(await formatMissionList(this.loop?.dir ?? this.dir));
      case 'cancelMission':
        return reply(await this.cancelMission(c.id));
      case 'autonomy':
        return reply(await runAutonomyCommand(this.loop?.dir ?? this.dir, c.cmd, { ...(this.loop ? { trust: this.loop.trust } : {}), now: this.now() }));
    }
  }

  /** The chat model, or undefined when none is configured (the planner and digest then fall back to plain code). */
  private optionalProvider(): AiProvider | undefined {
    try {
      return this.engine.providerFor(this.providerName);
    } catch {
      return undefined;
    }
  }

  /** v17 "plan my day": proposes a plan for today's open time. Nothing is written until they say yes. */
  async planDay(): Promise<string> {
    const dir = this.loop?.dir ?? this.dir;
    const now = this.now();
    const [anchor, soul] = await Promise.all([loadAnchor(dir, now), loadSoul(dir).catch(() => undefined)]);
    const ai = this.optionalProvider();
    const plan = await proposeDayPlan({ anchor, now, ...(ai ? { ai } : {}), ...(soul ? { soul } : {}) });
    if (plan.blocks.length) await savePendingPlan(dir, plan, now);
    else await clearPendingPlan(dir);
    return plan.summary;
  }

  /** v17 "break digest": 2-3 things from recent browsing worth revisiting. Read-only. */
  async breakDigest(): Promise<string> {
    const dir = this.loop?.dir ?? this.dir;
    const ai = this.optionalProvider();
    return (await buildBreakDigest({ dir, now: this.now(), ...(ai ? { ai } : {}) })).text;
  }

  /** v22 "cancel mission <id>": stops a queued or running mission. Without an id, the only open one. */
  private async cancelMission(id?: string): Promise<string> {
    const dir = this.loop?.dir ?? this.dir;
    let ref = id;
    if (!ref) {
      const open = (await listMissions(dir)).filter(isActiveMission);
      if (!open.length) return 'Nothing is running right now.';
      if (open.length > 1) return `A few are going: ${open.map((m) => m.id).join(', ')}. Which one? Say "cancel mission <id>".`;
      ref = open[0]!.id;
    }
    const r = await cancelMission(dir, ref, this.now());
    if (!r.cancelled) return `That one already ended: ${describeMission(r.record)}.`;
    return `Stopped: ${describeMission({ ...r.record, status: 'cancelled' })}.`;
  }

  // ---------- commands (all plain code) ----------

  private async status(): Promise<string> {
    const [cards, runs, loopWaiting] = await Promise.all([this.engine.pending(), this.engine.store.listRuns(), this.loop ? this.loop.pending() : Promise.resolve([])]);
    const active = runs.filter((r) => r.status === 'running' || r.status === 'waiting_human');
    const loopLines = loopWaiting.length ? [`Loop items waiting on you (${loopWaiting.length}): ${loopWaiting.slice(0, 5).map((r) => oneLine(`${r.actionType ?? r.handlerId}: ${r.goal ?? ''}`, 80)).join('; ')}. Say "checkin" to see them.`] : [];
    // Where the work went across all runs: how much stayed in code and a fast model, how much needed smart or you.
    const spectrum = runs.reduce((sum, r) => addSpectrum(sum, spectrumOf(r)), emptySpectrum());
    const where = spectrumTotal(spectrum) ? [`Handled by (${runs.length} run${runs.length === 1 ? '' : 's'}): ${formatSpectrum(spectrum)}`] : [];
    if (!cards.length && !active.length) return [loopLines.length ? 'No flow cards are waiting and no flows are running.' : 'All clear: nothing is waiting on you and no flows are running.', ...loopLines, ...where].join('\n');
    const lines: string[] = [];
    if (cards.length) {
      lines.push(`Waiting on you (${cards.length}):`);
      for (const card of cards) lines.push(`- ${card.title} [${card.flowId}] (ref ${card.id})`);
    }
    const others = active.filter((r) => r.status === 'running');
    if (others.length) {
      lines.push(`Running (${others.length}):`);
      for (const r of others) lines.push(`- ${r.flowId} (${r.id})`);
    }
    return [...lines, ...loopLines, ...where].join('\n');
  }

  private async lessons(): Promise<string> {
    await this.engine.reviewLessons();
    const all = await this.engine.lessons.all();
    if (!all.length) return 'No lessons yet. Add one with "learn <scope>: <rule>", or a "Lesson: <rule>" line when you answer a card.';
    const ready = new Set((await this.engine.lessons.candidatesForCode()).map((l) => l.id));
    const lines = all.map((l) => `- ${l.rule} (${l.scope}, x${l.count}${l.hardened ? ', in code' : ready.has(l.id) ? ', ready to harden into code' : ''}${l.evidence?.status === 'tension' ? ', in tension' : ''})`);
    const tense = all.map((l) => describeTension(l)).filter((q): q is string => !!q);
    if (tense.length) lines.push('', 'In tension with your latest replies:', ...tense.map((q) => `- ${q}`));
    if (ready.size) lines.push(`${ready.size} lesson(s) keep coming back: they are ready to become code checks.`);
    return lines.join('\n');
  }

  private async start(flowId: string, inputJson?: string): Promise<ChiefReply> {
    const none = (text: string): ChiefReply => ({ text, cards: [], via: 'command' });
    if (!this.engine.listFlows().some((f) => f.meta.id === flowId)) {
      const ids = this.engine.listFlows().map((f) => f.meta.id);
      return none(`No flow called "${flowId}".${ids.length ? ` Available: ${ids.join(', ')}.` : ''}`);
    }
    let input: unknown;
    if (inputJson) {
      try {
        input = JSON.parse(inputJson);
      } catch {
        return none(`That input isn't valid JSON. Use: run ${flowId} {"key":"value"}`);
      }
    }
    return this.describeRun(await this.engine.start(flowId, input));
  }

  private describeRun(result: RunResult): ChiefReply {
    if (result.status === 'waiting_human') {
      return { text: formatCardAsText(result.card), cards: [result.card], via: 'command' };
    }
    if (result.status === 'failed') return { text: `Run ${result.runId} failed: ${oneLine(result.error, 300)}`, cards: [], via: 'command' };
    const out = result.output === null || result.output === undefined ? '' : `\n${JSON.stringify(result.output, null, 2)}`;
    return { text: clip(`Done (${result.runId}).${out}`), cards: [], via: 'command' };
  }

  private async learn(scope: string, rule: string): Promise<string> {
    try {
      const r = await this.engine.proposeLesson({ scope, rule });
      const checked = r.report.total
        ? `Checked ${r.report.total} saved case(s): ${r.report.regressed} regressed.`
        : 'No saved cases in that scope, so nothing was measured.';
      const layer = r.suggestedLayer.layer === 'principle' ? '' : ` This looks like a ${r.suggestedLayer.layer} rule. ${r.suggestedLayer.reason}`;
      if (!r.accepted) return clip(`${r.reason}${layer}`);
      return clip(`Saved lesson for ${scope}: "${rule}". ${checked}${layer}`);
    } catch (err) {
      if (err instanceof LessonCapError) return clip(err.message);
      throw err;
    }
  }

  // ---------- free-form: code assembles the facts, AI answers in words ----------

  /** A compact live snapshot, assembled by code, so the model reasons over exact facts instead of guessing. */
  async snapshot(): Promise<unknown> {
    const now = this.now();
    const [cards, lessons, runs, ready, anchor] = await Promise.all([
      this.engine.pending(),
      this.engine.lessons.all(),
      this.engine.store.listRuns(),
      this.engine.lessons.candidatesForCode(),
      loadAnchor(this.dir, now).catch(() => undefined),
    ]);
    const readyIds = new Set(ready.map((l) => l.id));
    return {
      now: timeFacts(now, anchor),
      flows: this.engine.listFlows().map(({ meta }) => ({ id: meta.id, description: meta.description, trigger: meta.trigger?.type ?? 'manual' })),
      openCards: cards.map((c) => ({
        ref: c.id,
        flow: c.flowId,
        title: c.title,
        summary: oneLine(c.summary, 200),
        options: c.options.map((o, i) => `${i + 1}) ${o.label}`),
      })),
      lessons: lessons.slice(0, 20).map((l) => ({ scope: l.scope, rule: l.rule, count: l.count, hardened: l.hardened, readyToHarden: readyIds.has(l.id), ...(l.evidence?.status ? { evidence: l.evidence.status } : {}) })),
      recentRuns: runs
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 5)
        .map((r) => ({ id: r.id, flow: r.flowId, status: r.status, updatedAt: r.updatedAt, ...(r.error ? { error: oneLine(r.error, 100) } : {}) })),
      ...(this.loop
        ? {
            loopWaiting: (await this.loop.pending()).slice(0, 10).map((r) => ({ actionType: r.actionType, goal: r.goal, status: r.status, urgency: r.urgency ?? 'normal' })),
          }
        : {}),
    };
  }

  /** SOUL.md + the Anchor + the corpus facts closest to the message, for the chat system prompt. Never throws. */
  async persona(text: string): Promise<string> {
    try {
      const now = this.now();
      const [soul, anchor, corpus] = await Promise.all([loadSoul(this.dir), loadAnchor(this.dir, now), new CorpusStore(this.engine.store.corpusFile).load()]);
      // Only clearly related memories, and none at all for small talk: a stray shared word never drags in a random topic.
      const facts = corpus.length && text.trim() ? relevantHits(queryCorpus(corpus.filter((i) => i.source !== 'feedback'), { query: text, limit: 3, now }), text) : [];
      const examples = corpus.length && text.trim() ? relevantHits(queryCorpus(corpus.filter((i) => i.source === 'feedback'), { query: text, limit: 3, now }), text) : [];
      const base = buildPersona({ now, ...(soul ? { soul } : {}), anchor, facts, examples });
      return [base, await this.memoryAndSkills(text)].filter(Boolean).join('\n\n');
    } catch {
      return '';
    }
  }

  /**
   * v24b: USER.md + MEMORY.md + recent daily notes, and the one or two SKILL.md files that fit the message. Empty when
   * the workspace has none of them, so prompts stay exactly as before. Never throws.
   */
  async memoryAndSkills(text: string): Promise<string> {
    const [memory, skills] = await Promise.all([
      loadMarkdownMemory(this.loop?.dir ?? this.dir, this.now())
        .then((m) => formatMemoryForPrompt(m))
        .catch(() => ''),
      relevantSkillsSection(this.dir, text),
    ]);
    return [memory, skills].filter(Boolean).join('\n\n');
  }

  /**
   * v23: the provider for a spoken turn, or undefined to use the chat provider. Only simple conversational turns take
   * the fast path; a long message or one asking for detail stays on the chat provider.
   */
  private voiceProviderFor(text: string, main: AiProvider): AiProvider | undefined {
    if (text.length > VOICE_SIMPLE_CHARS || WANTS_DETAIL.test(text)) return undefined;
    for (const name of this.voiceProviderName ? [this.voiceProviderName] : ['fast']) {
      try {
        const p = this.engine.providerFor(name);
        if (p !== main) return p;
      } catch {
        /* not configured: the chat provider answers */
      }
    }
    return undefined;
  }

  private async chat(text: string, spoken = false): Promise<ChiefReply> {
    const reply = (t: string, extra: Partial<ChiefReply> = {}): ChiefReply => ({ text: t, cards: [], via: 'chat', ...extra });
    try {
      const [snapshot, persona, history] = await Promise.all([
        this.snapshot(),
        this.persona(text),
        this.historyTurns ? loadChatHistory(this.dir, this.historyTurns).catch(() => []) : Promise.resolve([]),
      ]);
      const tools = this.hasTools ? this.tools! : undefined;
      const recent = history.length ? `Recent conversation (oldest first, local times):\n${formatChatHistory(history, this.now())}\n\n` : '';
      const messages: AiMessage[] = [
        { role: 'user', content: `Live snapshot (exact data gathered by code):\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n\n${recent}Their message:\n${text}` },
      ];
      const base = withPersona(tools ? systemWithTools(tools, this.maxToolSteps) : SYSTEM, persona);
      const system = spoken ? `${base}\n\n${VOICE_CALL_HINT}` : base;
      const main = this.engine.providerFor(this.providerName);
      // v23: a spoken turn goes to the fast provider; if it fails, the turn escalates to the chat provider.
      let fast = spoken ? this.voiceProviderFor(text, main) : undefined;
      const provider: Pick<AiProvider, 'complete'> = {
        complete: async (req) => {
          if (fast) {
            try {
              return await fast.complete(req);
            } catch {
              fast = undefined;
            }
          }
          return main.complete(req);
        },
      };
      const toolsUsed: string[] = [];
      const queued: string[] = [];
      /** v24b: set once this turn read outside content (a chat, a page, mail), so memory writes stop trusting it. */
      let readOutside = false;
      for (let step = 0; ; step++) {
        const out = (await provider.complete({ system, messages, meta: { runId: 'chief', flowId: 'chief', step: `${spoken ? 'voice' : 'chat'}${step ? `.tool${step}` : ''}`, attempt: 1 } })).trim();
        const call = tools ? parseToolCall(out) : undefined;
        if (!call) {
          const extra = { ...(toolsUsed.length ? { toolsUsed } : {}), ...(queued.length ? { queued } : {}) };
          return { ...this.shaped(out, text), ...extra };
        }
        if (step >= this.maxToolSteps) {
          const before = out.slice(0, TOOL_CALL.exec(out)?.index ?? 0).trim();
          return reply(clip(concise(before || "I couldn't finish looking that up. Ask me again in a moment.", text)), { ...(toolsUsed.length ? { toolsUsed } : {}), ...(queued.length ? { queued } : {}) });
        }
        const result = await this.useTool(tools!, call.tool, call.args, readOutside ? 'external' : 'user');
        if (result.ran) toolsUsed.push(call.tool);
        if (result.ran && tools!.get(call.tool)?.readOnly && !OWN_READS.has(call.tool)) readOutside = true;
        if (result.queued) queued.push(call.tool);
        messages.push({ role: 'assistant', content: out });
        messages.push({ role: 'user', content: `TOOL_RESULT ${call.tool}:\n${result.text}\n\nNow call another tool, or write your final short reply to their message.` });
      }
    } catch (err) {
      return reply(
        `I can't think that one through right now (${oneLine(message(err), 160)}). ` +
          'The quick commands still work: status, flows, lessons, run <flowId> [json], learn <scope>: <rule>.',
        { unavailable: true },
      );
    }
  }

  /** A final model reply as a ChiefReply: silence, a reaction, or 1-2 short bubbles (each kept to text-message size). */
  private shaped(out: string, asked: string): ChiefReply {
    const shape = parseChatShape(out || "I don't have anything to add.");
    if ('silent' in shape) return { text: '', cards: [], via: 'chat', silent: true };
    if ('react' in shape) return { text: shape.react, cards: [], via: 'chat', react: shape.react };
    const bubbles = shape.bubbles.map((b) => clip(concise(b, asked)));
    return { text: bubbles.join('\n\n'), cards: [], via: 'chat', ...(bubbles.length > 1 ? { bubbles } : {}) };
  }

  /** Runs a read-only tool now, or queues a side-effect one as a Verify item. Never throws: the model reads the outcome. */
  private async useTool(tools: ToolRegistry, name: string, args: Record<string, unknown>, provenance: 'user' | 'external' = 'user'): Promise<{ text: string; ran?: boolean; queued?: boolean }> {
    const tool = tools.get(name);
    if (!tool) return { text: `No tool called "${name}". Available: ${tools.list().map((t) => t.name).join(', ')}.` };
    if (!tool.readOnly && isLocal(tool)) {
      try {
        const out = await tools.call(name, args, { dir: this.loop?.dir ?? this.dir, now: this.now(), stage: 'commit', approved: true, provenance });
        return { text: clip2(typeof out === 'string' ? out : JSON.stringify(out ?? null), MAX_TOOL_RESULT), ran: true };
      } catch (err) {
        return { text: err instanceof ToolGatedError ? err.message : `Tool ${name} failed: ${oneLine(message(err), 300)}` };
      }
    }
    if (!tool.readOnly) {
      if (!this.loop) return { text: `Not run: ${name} has side effects and there is no loop to queue it on here. Tell them what you would do; they can do it themselves.` };
      try {
        await queueChiefAction(this.loop.dir, name, args, this.now());
        this.queuedSinceDrain++;
        return { text: `Queued for approval: ${name} with ${clip2(JSON.stringify(args), 300)}. It runs only after they reply 1. Tell them it is ready.`, queued: true };
      } catch (err) {
        return { text: `Could not queue ${name}: ${oneLine(message(err), 200)}` };
      }
    }
    try {
      const out = await tools.call(name, args, { dir: this.dir, now: this.now(), stage: 'execute' });
      const shown = typeof out === 'string' ? out : JSON.stringify(out ?? null);
      return { text: clip2(shown, MAX_TOOL_RESULT), ran: true };
    } catch (err) {
      return { text: err instanceof ToolGatedError ? err.message : `Tool ${name} failed: ${oneLine(message(err), 300)}` };
    }
  }
}

/** Read-only tools that only read Rufus's own workspace: what they return is not outside content. */
const OWN_READS = new Set([SKILL_LIST_TOOL, SKILL_READ_TOOL, 'mission.list']);

const clip2 = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function clip(text: string): string {
  return text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY - 1)}…` : text;
}
