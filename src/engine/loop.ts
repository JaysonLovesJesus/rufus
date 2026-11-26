import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { actsOnItsOwn, assertActionType, promotionMessage, TrustStore, type FeedbackResult, type TrustMode, type Verdict } from './trust';
import { appendAudit, describeDone, formatAutoNotice, previewArgs, type AuditApproval, type AuditEntry } from '../unified/audit';
import { AiVerificationError } from './ai';
import { emptySpectrum } from './spectrum';
import { ROUTES, routeRank, upgradeRoute, DEFAULT_MAX_REPLANS, MAX_REPLANS_LIMIT } from './stages';
import { checkBoundaries, loadAnchor, type Anchor, type Sensitivity } from '../anchor/anchor';
import { CorpusStore, queryCorpus, type CorpusHit, type CorpusItem } from '../corpus';
import { clip, stableId } from '../corpus/types';
import { FileStore } from '../store';
import { buildPersona, loadSoul, relevantHits, withPersona } from '../soul/soul';
import { ToolRegistry } from '../tools/tools';
import { checkLayer3Boundary } from '../skills/runner';
import type { AiProvider, Route, Spectrum, StagePlan, Tier, VerifyResult } from '../types';

/**
 * The One Master Loop: Sense -> Plan -> Execute -> Verify -> Record.
 *
 *   Sense   (code)          sensors report new signals since their saved cursor; the Anchor is loaded. No signals: idle, $0.
 *   Plan    (code + AI?)    a handler turns a signal into a concrete goal + action type, and picks a route up front
 *                           (code > fast > smart > human). Genuinely unclear? It pauses with a draft plan for the human.
 *   Execute (code + AI?)    the work, on the planned route only. A physical, real-life step becomes a clear human step.
 *   Verify                  1) a cross-check (code checks AI, AI may check code); a failure re-plans, bounded.
 *                           2) Earned Trust + the Anchor's boundaries: `check` (or anything external, money, logins)
 *                              waits for a human; `autonomous` completes.
 *   Record  (code)          every run is saved; a human verdict updates trust AND becomes a corpus example right away.
 *
 * v12: every model call carries `SOUL.md` + the Anchor + the closest examples and facts; handlers get real tool hands
 * (`ctx.tools`), gated so side effects only happen in `commit` and sensitive ones only after a human's yes; and each run
 * carries an `urgency` so the daemon can deliver urgent items now and batch the rest.
 */

/** `urgent` reaches you right away; `normal` waits for the next check-in. */
export type Urgency = 'urgent' | 'normal';

// ---------- signals and sensors ----------

export interface LoopSignal {
  /** Unique within its sensor. The same id is never handled twice. */
  id: string;
  /** Where it came from: `chat`, `email`, `calendar`, `anchor`, ... */
  surface: string;
  /** What happened: `message.received`, `schedule.request`, ... */
  kind: string;
  text?: string;
  actor?: string;
  /** ISO time it happened. */
  timestamp?: string;
  /** A sensor's hint. The plan may override it. Default `normal`. */
  urgency?: Urgency;
  data?: Record<string, unknown>;
}

export interface SensorContext {
  /** The workspace directory. */
  dir: string;
  anchor: Anchor;
  now: Date;
}

export interface SensorPoll {
  signals: LoopSignal[];
  /** Saved and handed back on the next poll. Omit to keep the old cursor. */
  nextCursor?: string;
}

/** Code only: report what is new since `cursor`. Must be cheap; it runs every pass. */
export interface Sensor {
  id: string;
  surface: string;
  poll(cursor: string | undefined, ctx: SensorContext): Promise<SensorPoll> | SensorPoll;
}

// ---------- plans and handlers ----------

export interface LoopPlan extends StagePlan {
  /** What kind of action this is, for Earned Trust: `reply.chat`, `schedule.block`, `email.triage`, ... */
  actionType: string;
  /** The plan is genuinely unclear: pause with this draft and ask the human (`question`) before doing anything. */
  needsHumanPlan?: boolean;
  question?: string;
  /** The work is a physical, real-life step only a person can do ("record the video"). */
  needsHumanExecute?: boolean;
  /** The step, in plain words, shown to the human. */
  humanStep?: string;
  /** What the action touches. `external`, `money` and `login` always need the human's yes. */
  sensitivity?: Sensitivity[];
  /** Tools the commit will use (`beeper.send`). Their sensitivities count as the plan's, for the boundary check. */
  uses?: string[];
  /** `urgent` interrupts you now; `normal` (default) waits for the next check-in. Beats the signal's hint. */
  urgency?: Urgency;
  /**
   * A no-op that touches nothing (e.g. "ignore this acknowledgement"): once it passes its checks it completes on its own,
   * whatever its Earned Trust, and never waits on the human. Ignored when the plan has a sensitivity, uses a tool, or an
   * Anchor boundary asks for approval.
   */
  autoComplete?: boolean;
}

export interface LoopReplan {
  /** 1 for the first re-plan. */
  attempt: number;
  reason: string;
  previousRoute: Route;
  previousPlan: LoopPlan;
  lastResult?: unknown;
  /** The cheapest sensible upgrade. A re-plan never goes cheaper than the route that failed. */
  nextRoute: Route;
}

export interface AskOptions {
  /** Default: `fast` while planning and verifying; the planned route while executing. */
  tier?: Tier;
  system?: string;
  json?: boolean;
  /** `false` leaves SOUL.md, the Anchor, examples and facts out of this call's system prompt. Default: included. */
  persona?: boolean;
}

/** One tool call made by a run, kept on the run for `rufus now` and audits. */
export interface LoopToolCall {
  tool: string;
  stage: LoopStageContext['stage'];
  ok: boolean;
  error?: string;
  at: string;
}

/** The tools a stage can use. Read-only tools run anywhere; side effects only in `commit`; sensitive ones need a yes. */
export interface LoopTools {
  has(name: string): boolean;
  list(): Array<{ name: string; description: string; readOnly: boolean; sensitivity: Sensitivity[] }>;
  call<R = unknown>(name: string, args?: Record<string, unknown>): Promise<R>;
}

export interface LoopStageContext {
  /** The workspace directory. */
  dir: string;
  runId: string;
  signal: LoopSignal;
  anchor: Anchor;
  stage: 'plan' | 'execute' | 'verify' | 'commit';
  /** 0 for the first pass, 1 for the first re-plan, ... */
  attempt: number;
  route?: Route;
  /** Set when re-planning after a failed cross-check. */
  replan?: LoopReplan;
  /** What the human wrote when they edited a paused plan. */
  humanInput?: string;
  now: Date;
  /** Past human verdicts from the corpus (closest first), optionally for one action type. Free: no AI. */
  examples(opts?: { actionType?: string; query?: string; limit?: number }): CorpusHit[];
  /** Facts from the whole life corpus. Free: no AI. */
  facts(query: string, opts?: { sources?: string[]; limit?: number }): CorpusHit[];
  /** One model call (counted on the run). Throws when no provider is configured. Carries SOUL.md + the Anchor by default. */
  ai(prompt: string, opts?: AskOptions): Promise<string>;
  /** True when a model is configured, so a handler can fall back to code (or a human) without one. */
  hasAi: boolean;
  /** `<workspace>/SOUL.md`, when present. */
  soul?: string;
  /** The persona block every `ai()` call gets: SOUL.md, the Anchor, the closest examples and facts. */
  persona(): string;
  /** Real tool hands (`beeper.send`, `calendar.read`, ...). */
  tools: LoopTools;
  /** True in `commit` after a human said yes to this run. */
  approved: boolean;
}

export interface SignalMatch {
  surface?: string | string[];
  kind?: string | string[];
}

/** Turns one kind of signal into an action, the v10 way: plan -> execute -> verify, with bounded re-plans. */
export interface SignalHandler<R = unknown, P extends LoopPlan = LoopPlan> {
  id: string;
  match: SignalMatch | ((signal: LoopSignal) => boolean);
  plan(signal: LoopSignal, ctx: LoopStageContext): P | Promise<P>;
  /** Prepares the result (a draft, a proposed block, ...). Side effects belong in `commit`, after approval. */
  execute(plan: P, signal: LoopSignal, ctx: LoopStageContext): R | Promise<R>;
  /** Verify, step 1: does the result reach the plan's goal? A failure re-plans (up to `maxReplans`). */
  crossCheck?(result: R, plan: P, signal: LoopSignal, ctx: LoopStageContext): VerifyResult | Promise<VerifyResult>;
  /** Applies the result once it is trusted or approved (with the human's edit, if any). */
  commit?(output: R, plan: P, signal: LoopSignal, ctx: LoopStageContext): void | Promise<void>;
  /** Default 1, at most 5. */
  maxReplans?: number;
}

export const matchesSignal = (h: Pick<SignalHandler, 'match'>, s: LoopSignal): boolean => {
  if (typeof h.match === 'function') return h.match(s);
  const ok = (want: string | string[] | undefined, got: string): boolean => want === undefined || (Array.isArray(want) ? want.includes(got) : want === got || want === '*');
  return ok(h.match.surface, s.surface) && ok(h.match.kind, s.kind);
};

// ---------- runs ----------

export type LoopRunStatus =
  | 'completed'
  | 'awaiting_human_plan'
  | 'awaiting_human_execute'
  | 'awaiting_human_verify'
  | 'accepted'
  | 'edited'
  | 'rejected'
  | 'blocked'
  | 'error'
  /** v15: waited on a human longer than its time-to-live; it can no longer be approved or sent. */
  | 'expired';

/** v16: a sensor saw YOU send a message in a chat (the same `data.chatId`): what waited on that chat is answered. */
export const SELF_REPLY_KIND = 'message.sent';
/** At most this many messages are folded into one conversation signal. */
const MAX_FOLDED = 8;

/** The conversation a signal belongs to (`<surface>:<chatId|threadId>`), or undefined for one-off signals. */
export function threadOf(s: Pick<LoopSignal, 'surface' | 'data'>): string | undefined {
  const d = s.data ?? {};
  const id = typeof d.chatId === 'string' && d.chatId ? d.chatId : typeof d.threadId === 'string' && d.threadId ? d.threadId : undefined;
  return id ? `${s.surface}:${id}` : undefined;
}

interface FoldedMessage {
  text: string;
  actor?: string;
  at?: string;
}

/** The messages a signal carries: its folded burst, or itself. */
function messagesOf(s: LoopSignal): FoldedMessage[] {
  const folded = s.data?.messages;
  if (Array.isArray(folded) && folded.length) return folded.filter((m): m is FoldedMessage => !!m && typeof (m as FoldedMessage).text === 'string');
  return s.text ? [{ text: s.text, ...(s.actor ? { actor: s.actor } : {}), ...(s.timestamp ? { at: s.timestamp } : {}) }] : [];
}

export const AWAITING: readonly LoopRunStatus[] = ['awaiting_human_plan', 'awaiting_human_execute', 'awaiting_human_verify'];

export interface LoopTrailEntry {
  attempt: number;
  route: Route;
  goal: string;
  outcome: 'passed' | 'failed' | 'unchecked' | 'human';
  reason?: string;
}

export interface HumanDecision {
  verdict: Verdict;
  /** The human's own version of the output (for `edit`). */
  editedOutput?: unknown;
  note?: string;
}

export interface LoopRun {
  id: string;
  sensorId: string;
  handlerId: string;
  signal: LoopSignal;
  status: LoopRunStatus;
  actionType?: string;
  goal?: string;
  route?: Route;
  /** `urgent` reaches you now; `normal` waits for a check-in. */
  urgency?: Urgency;
  plan?: LoopPlan;
  /** For `awaiting_human_plan`: the draft, and what the human is asked. */
  draftPlan?: LoopPlan;
  question?: string;
  /** For `awaiting_human_execute`. */
  humanStep?: string;
  result?: unknown;
  /** True when the cross-check passed (or there was none and execution succeeded). */
  verified?: boolean;
  crossCheck?: 'passed' | 'failed' | 'skipped';
  verifyFailure?: string;
  replans: number;
  trail: LoopTrailEntry[];
  /** Anchor rules that made this wait for approval. */
  approvals?: string[];
  /** Anchor `never` rules that stopped it. */
  blockedBy?: string[];
  /** Earned Trust at the time it paused (or ran on its own). v21: any rung of the ladder. */
  autonomy?: TrustMode;
  /** v21: it ran on its own at `auto_notify`; the daemon tells you right away (`autoNotice`). */
  autoNotified?: boolean;
  /** v21: what to tell you about an `auto_notify` run ("Just reacted 😂 to Mom — reply 'undo' or 'demote' ..."). */
  autoNotice?: string;
  /** v21: who let the commit run: you, or an earned rung. */
  approval?: AuditApproval;
  promotionSuggested?: boolean;
  promotionHint?: string;
  decision?: HumanDecision & { stage: 'plan' | 'execute' | 'verify'; at: string };
  committed?: boolean;
  commitError?: string;
  /**
   * v15: human edits of an external/money/login draft. Each one replaced the draft but sent NOTHING: the run stays at
   * Verify until an explicit accept ("send", "1").
   */
  edits?: Array<{ text: string; at: string }>;
  /** v15: when (and why) it expired unanswered. */
  expiredAt?: string;
  expiredReason?: string;
  /**
   * v24a: dismissed without a decision because the human already handled it themselves (replied or reacted in the
   * chat, or said so in chat via `pending.clear`). Nothing was sent and Earned Trust was not touched. Status: `expired`.
   */
  dismissed?: boolean;
  /** Tools this run called, in order. */
  toolCalls?: LoopToolCall[];
  /** Model calls made by this run. */
  aiCalls: number;
  spectrum: Spectrum;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoopRunSummary {
  runId: string;
  status: LoopRunStatus;
  actionType?: string;
  goal?: string;
  route?: Route;
  /** v21: it ran on its own at `auto_notify`: tell the human now. */
  autoNotified?: boolean;
}

export interface LoopTickReport {
  status: 'idle' | 'ran';
  /** Model calls made in this pass. Idle passes always cost 0. */
  cost: number;
  /** New signals sensed (duplicates excluded). */
  signals: number;
  runs: LoopRunSummary[];
  /** Signals no handler matched. */
  unhandled: LoopSignal[];
  /** Signals already handled earlier (skipped). */
  duplicates: number;
  errors: Array<{ sensorId: string; error: string }>;
  /** v16: waiting items closed because you replied in that chat yourself. */
  resolved?: string[];
  /** v16: waiting items folded into a newer message from the same chat. */
  folded?: string[];
}

export interface DecisionResult {
  run: LoopRun;
  /** Set for decisions on a verified result. */
  trust?: FeedbackResult;
  /** The example saved to `corpus/items.jsonl`. */
  example: CorpusItem;
  promotionHint?: string;
  /**
   * v15: an edit of a sensitive (external, money, login) draft was saved as the new draft and NOTHING was sent or applied.
   * The run still waits at Verify for an explicit accept.
   */
  held?: boolean;
}

export interface LoopState {
  version: 1;
  cursors: Record<string, string>;
  lastTickAt?: string;
}

export interface MasterLoopOptions {
  /** The workspace directory. */
  dir: string;
  sensors?: Sensor[];
  handlers?: SignalHandler<any, any>[];
  /** Optional AI. `default` serves a tier that is not configured. */
  providers?: { fast?: AiProvider; smart?: AiProvider; default?: AiProvider };
  trust?: TrustStore;
  /** Real tool hands for handlers (`ctx.tools`). Default: none. */
  tools?: ToolRegistry;
  /** SOUL.md text to use instead of reading `<dir>/SOUL.md`; `false` turns it off. Default: read the file each pass. */
  soul?: string | false;
  now?: () => Date;
}

export const LOOP_STATE_FILE = 'loop-state.json';
export const LOOP_RUNS_DIR = 'loop-runs';

const isRoute = (v: unknown): v is Route => typeof v === 'string' && (ROUTES as readonly string[]).includes(v);

function checkLoopPlan(handlerId: string, plan: unknown): asserts plan is LoopPlan {
  const p = plan as Partial<LoopPlan> | null;
  if (!p || typeof p !== 'object') throw new Error(`Handler "${handlerId}": plan() must return an object with a goal, an actionType and a route.`);
  if (typeof p.goal !== 'string' || !p.goal.trim()) throw new Error(`Handler "${handlerId}": plan() must define a concrete, non-empty goal.`);
  if (!isRoute(p.route)) throw new Error(`Handler "${handlerId}": plan().route must be one of ${ROUTES.join(', ')} (got ${JSON.stringify(p.route)}).`);
  assertActionType(p.actionType as string);
}

function verdictOf(v: VerifyResult | undefined): VerifyResult {
  if (v && v.ok === true) return { ok: true };
  const reason = v && v.ok === false && typeof v.reason === 'string' && v.reason.trim() ? v.reason : 'cross-check failed';
  return { ok: false, reason };
}

const show = (v: unknown): string => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** What a sensitive edit can never do on its own: reach outside, spend money, or sign in. */
export const HOLD_ON_EDIT: readonly Sensitivity[] = ['external', 'money', 'login'];

/** Default time a Verify item may wait after it reached the human: 60 minutes. Older ones expire, never send. */
export const DEFAULT_PENDING_TTL_MS = 60 * 60_000;

const DRAFT_KEYS = ['reply', 'draft', 'text', 'message'] as const;
const ARG_TEXT_KEYS = ['text', 'message', 'body'] as const;

/**
 * A result with the human's edited text as its draft, keeping everything else (recipient, chat id, tool, args), so the
 * re-shown item still says who it goes to and an accept later sends exactly the edited text.
 */
export function withEditedDraft(result: unknown, edited: unknown): unknown {
  if (typeof edited !== 'string') return edited ?? result;
  if (typeof result === 'string' || result === undefined || result === null || typeof result !== 'object' || Array.isArray(result)) return edited;
  const out: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  let hit = false;
  for (const k of DRAFT_KEYS) {
    if (typeof out[k] === 'string') {
      out[k] = edited;
      hit = true;
    }
  }
  const args = out.args;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const a: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    const keys = ARG_TEXT_KEYS.filter((k) => typeof a[k] === 'string');
    for (const k of keys.length ? keys : (['text'] as const)) a[k] = edited;
    out.args = a;
    if ('summary' in out && typeof out.tool === 'string') {
      const to = ['to', 'chatTitle', 'chatId', 'recipient'].map((k) => a[k]).find((v): v is string => typeof v === 'string' && !!v.trim());
      out.summary = `${out.tool}${to ? ` to ${to}` : ''}: "${clip(edited, 160)}"`;
    }
    hit = true;
  }
  if (!hit) out.reply = edited;
  return out;
}

export const loopRunId = (sensorId: string, signalId: string): string => `loop_${createHash('sha256').update(`${sensorId}\u0000${signalId}`).digest('hex').slice(0, 16)}`;

export class MasterLoop {
  readonly dir: string;
  readonly trust: TrustStore;
  private readonly fs: FileStore;
  private readonly sensors: Sensor[] = [];
  private readonly handlers: SignalHandler<any, any>[] = [];
  private readonly providers: NonNullable<MasterLoopOptions['providers']>;
  private readonly now: () => Date;
  readonly tools: ToolRegistry;
  private readonly soulOption?: string | false;
  private soul?: string;

  constructor(opts: MasterLoopOptions) {
    this.dir = opts.dir;
    this.fs = new FileStore(opts.dir);
    this.now = opts.now ?? (() => new Date());
    this.trust = opts.trust ?? new TrustStore(opts.dir, { now: this.now });
    this.providers = opts.providers ?? {};
    this.tools = opts.tools ?? new ToolRegistry();
    this.soulOption = opts.soul;
    for (const s of opts.sensors ?? []) this.addSensor(s);
    for (const h of opts.handlers ?? []) this.addHandler(h);
  }

  get stateFile(): string {
    return path.join(this.dir, LOOP_STATE_FILE);
  }
  get runsDir(): string {
    return path.join(this.dir, LOOP_RUNS_DIR);
  }

  addSensor(sensor: Sensor): this {
    if (!sensor?.id || typeof sensor.poll !== 'function') throw new Error('A sensor needs an id and a poll() function.');
    if (this.sensors.some((s) => s.id === sensor.id)) throw new Error(`Sensor "${sensor.id}" is registered twice.`);
    this.sensors.push(sensor);
    return this;
  }

  /** Handlers are tried in the order they were added; the first match wins. */
  addHandler(handler: SignalHandler<any, any>): this {
    if (!handler?.id || typeof handler.plan !== 'function' || typeof handler.execute !== 'function') throw new Error('A handler needs an id, plan() and execute().');
    if (this.handlers.some((h) => h.id === handler.id)) throw new Error(`Handler "${handler.id}" is registered twice.`);
    this.handlers.push(handler);
    return this;
  }

  listSensors(): readonly Sensor[] {
    return this.sensors;
  }
  listHandlers(): readonly SignalHandler<any, any>[] {
    return this.handlers;
  }

  async loadState(): Promise<LoopState> {
    const raw = await this.fs.readJson<Partial<LoopState>>(this.stateFile, { version: 1, cursors: {} });
    return { version: 1, cursors: { ...(raw.cursors ?? {}) }, ...(raw.lastTickAt ? { lastTickAt: raw.lastTickAt } : {}) };
  }

  async getRun(runId: string): Promise<LoopRun> {
    const run = await this.fs.readJson<LoopRun | null>(path.join(this.runsDir, `${runId}.json`), null);
    if (!run) throw new Error(`No loop run "${runId}". See rufus loop status.`);
    return run;
  }

  async listRuns(): Promise<LoopRun[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.runsDir);
    } catch {
      return [];
    }
    const runs = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => this.fs.readJson<LoopRun | null>(path.join(this.runsDir, f), null)));
    return runs.filter((r): r is LoopRun => !!r).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** Everything this run's plan touches: the plan's own sensitivities plus those of the tools it uses. */
  sensitivityOf(run: Pick<LoopRun, 'plan'>): Sensitivity[] {
    const plan = run.plan;
    if (!plan) return [];
    return [...new Set([...(plan.sensitivity ?? []), ...this.tools.sensitivityOf(plan.uses ?? [])])];
  }

  /**
   * v15: expires Verify items that have waited longer than `ttlMs` since `startedAt(run)` (default: the run's last
   * update). An expired item is never committed and never sent; it simply stops waiting. Returns the runs it expired.
   */
  async expireStale(opts: { ttlMs?: number; startedAt?: (run: LoopRun) => string | undefined; reason?: string } = {}): Promise<LoopRun[]> {
    const ttl = opts.ttlMs ?? DEFAULT_PENDING_TTL_MS;
    if (!(ttl > 0)) return [];
    const now = this.now();
    const out: LoopRun[] = [];
    for (const run of await this.listRuns()) {
      if (run.status !== 'awaiting_human_verify') continue;
      const from = opts.startedAt ? opts.startedAt(run) : (run.updatedAt ?? run.createdAt);
      const ms = from ? Date.parse(from) : NaN;
      if (!Number.isFinite(ms) || now.getTime() - ms <= ttl) continue;
      out.push(await this.expireRun(run.id, opts.reason ?? `no decision within ${Math.round(ttl / 60_000)} min`));
    }
    return out;
  }

  /** Marks one waiting run `expired`: nothing is committed, nothing is sent, and no later reply can revive it. */
  async expireRun(runId: string, reason = 'expired'): Promise<LoopRun> {
    const run = await this.getRun(runId);
    if (!AWAITING.includes(run.status)) return run;
    run.status = 'expired';
    run.expiredAt = this.now().toISOString();
    run.expiredReason = reason;
    await this.save(run);
    return run;
  }

  /**
   * v24a: dismisses one waiting run because the human already handled it (e.g. "I already replied to #1-#4"). Like an
   * expiry: nothing is committed or sent, no trust feedback is recorded, and no later reply can revive it.
   */
  async dismissRun(runId: string, reason = 'already handled'): Promise<LoopRun> {
    const run = await this.getRun(runId);
    if (!AWAITING.includes(run.status)) return run;
    run.status = 'expired';
    run.dismissed = true;
    run.expiredAt = this.now().toISOString();
    run.expiredReason = reason;
    await this.save(run);
    return run;
  }

  /** Runs waiting on a human, oldest first. */
  async pending(): Promise<LoopRun[]> {
    return (await this.listRuns()).filter((r) => AWAITING.includes(r.status));
  }

  private async runExists(runId: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.runsDir, `${runId}.json`));
      return true;
    } catch {
      return false;
    }
  }

  private async save(run: LoopRun): Promise<void> {
    run.updatedAt = this.now().toISOString();
    await this.fs.writeJson(path.join(this.runsDir, `${run.id}.json`), run);
  }

  /** Re-reads SOUL.md (unless given or turned off), so an edit takes effect on the next pass. */
  private async refreshSoul(): Promise<void> {
    this.soul = this.soulOption === false ? undefined : typeof this.soulOption === 'string' ? this.soulOption.trim() || undefined : await loadSoul(this.dir);
  }

  /** One full pass. Zero new signals: `{ status: 'idle', cost: 0 }` and no model is ever called. */
  async runOnce(): Promise<LoopTickReport> {
    const now = this.now();
    const report: LoopTickReport = { status: 'idle', cost: 0, signals: 0, runs: [], unhandled: [], duplicates: 0, errors: [] };
    await this.refreshSoul();

    // ---- Sense (code only) ----
    const anchor = await loadAnchor(this.dir, now);
    const state = await this.loadState();
    let corpus: CorpusItem[] | undefined;
    const loadCorpus = async (): Promise<CorpusItem[]> => (corpus ??= await new CorpusStore(this.fs.corpusFile).load());

    for (const sensor of this.sensors) {
      let polled: SensorPoll;
      try {
        polled = await sensor.poll(state.cursors[sensor.id], { dir: this.dir, anchor, now });
      } catch (err) {
        report.errors.push({ sensorId: sensor.id, error: (err as Error).message });
        continue; // cursor unchanged: the same signals come back next pass
      }
      // v16, one conversation = one item: fresh signals are de-duplicated, your own replies close what they answer, and
      // several new messages from the same chat (this pass, or still waiting from earlier) fold into ONE signal.
      const fresh: LoopSignal[] = [];
      for (const raw of polled.signals ?? []) {
        const signal = normalizeSignal(raw, sensor.surface);
        if (!signal) continue;
        if (await this.runExists(loopRunId(sensor.id, signal.id))) {
          report.duplicates++;
          continue;
        }
        fresh.push(signal);
      }
      for (const signal of await this.foldThreads(fresh, report)) {
        const runId = loopRunId(sensor.id, signal.id);
        report.signals++;
        const handler = this.handlers.find((h) => matchesSignal(h, signal));
        if (!handler) {
          report.unhandled.push(signal);
          continue;
        }
        const run: LoopRun = {
          id: runId,
          sensorId: sensor.id,
          handlerId: handler.id,
          signal,
          status: 'error',
          replans: 0,
          trail: [],
          aiCalls: 0,
          spectrum: emptySpectrum(),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        await this.process(run, handler, anchor, await loadCorpus(), {});
        report.cost += run.aiCalls;
        report.runs.push({ runId: run.id, status: run.status, ...(run.actionType ? { actionType: run.actionType } : {}), ...(run.goal ? { goal: run.goal } : {}), ...(run.route ? { route: run.route } : {}), ...(run.autoNotified ? { autoNotified: true } : {}) });
      }
      if (polled.nextCursor !== undefined) state.cursors[sensor.id] = polled.nextCursor;
      await this.fs.writeJson(this.stateFile, { ...state, lastTickAt: now.toISOString() });
    }
    if (report.signals) report.status = 'ran';
    return report;
  }

  /**
   * v16: you replied in a chat yourself (`message.sent`): anything still waiting on that chat expires, so Rufus never
   * nags about a conversation you already handled. Several new messages from one chat become one signal whose text is
   * the whole burst (oldest first), and an item still waiting on that chat is folded in and expired: one conversation,
   * one item, one draft that answers all of it.
   */
  private async foldThreads(signals: LoopSignal[], report: LoopTickReport): Promise<LoopSignal[]> {
    if (!signals.some((s) => threadOf(s))) return signals;
    const waiting = await this.pending();
    const out: LoopSignal[] = [];
    const groups = new Map<string, LoopSignal[]>();
    for (const s of signals) {
      const thread = threadOf(s);
      if (!thread) {
        out.push(s);
        continue;
      }
      if (s.kind === SELF_REPLY_KIND) {
        groups.delete(thread); // what came before your own reply is answered
        for (const r of waiting.filter((w) => threadOf(w.signal) === thread && AWAITING.includes(w.status))) {
          await this.expireRun(r.id, 'you replied in that chat yourself');
          r.status = 'expired';
          (report.resolved ??= []).push(r.id);
        }
        continue;
      }
      groups.set(thread, [...(groups.get(thread) ?? []), s]);
    }
    for (const [thread, burst] of groups) {
      const earlier = waiting.filter((w) => threadOf(w.signal) === thread && AWAITING.includes(w.status));
      const lines = [...earlier.flatMap((r) => messagesOf(r.signal)), ...burst.flatMap(messagesOf)].slice(-MAX_FOLDED);
      for (const r of earlier) {
        await this.expireRun(r.id, 'folded into a newer message from the same chat');
        (report.folded ??= []).push(r.id);
      }
      const last = burst[burst.length - 1]!;
      if (lines.length <= 1) {
        out.push(last);
        continue;
      }
      out.push({
        ...last,
        text: lines.map((m) => m.text).join('\n'),
        data: { ...(last.data ?? {}), messages: lines },
        ...(burst.some((b) => b.urgency === 'urgent') ? { urgency: 'urgent' as const } : {}),
      });
    }
    return out.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  }

  private context(
    run: LoopRun,
    anchor: Anchor,
    corpus: CorpusItem[],
    base: {
      stage: LoopStageContext['stage'];
      attempt: number;
      route?: Route;
      replan?: LoopReplan;
      humanInput?: string;
      approved?: boolean;
      /** v21: tools an earned rung (auto_notify / autonomous incl. external) may run in this commit without a per-run yes. */
      approvedTools?: readonly string[];
      /** v21: sees every tool call (for the audit ledger). */
      onToolCall?: (c: { tool: string; args: Record<string, unknown>; ok: boolean; error?: string }) => void;
    },
  ): LoopStageContext {
    const defaultTier: Tier = base.stage === 'execute' && base.route === 'smart' ? 'smart' : 'fast';
    const signalText = run.signal.text ?? '';
    const examples: LoopStageContext['examples'] = (o = {}) => {
      const pool = corpus.filter((i) => i.source === 'feedback' && (!o.actionType || i.tags?.includes(o.actionType)));
      return queryCorpus(pool, { query: o.query ?? signalText, limit: o.limit ?? 3, now: this.now() });
    };
    const facts: LoopStageContext['facts'] = (query, o = {}) => queryCorpus(corpus, { query, sources: o.sources, limit: o.limit ?? 5, now: this.now() });
    let persona: string | undefined;
    const personaOf = (): string =>
      (persona ??= buildPersona({
        now: this.now(),
        ...(this.soul ? { soul: this.soul } : {}),
        anchor,
        examples: corpus.length ? examples({ ...(run.actionType ? { actionType: run.actionType } : {}), limit: 3 }) : [],
        facts: corpus.length && signalText.trim() ? relevantHits(queryCorpus(corpus.filter((i) => i.source !== 'feedback'), { query: signalText, limit: 3, now: this.now() }), signalText) : [],
      }));
    const approved = base.stage === 'commit' && base.approved === true;
    const registry = this.tools;
    const tools: LoopTools = {
      has: (name) => registry.has(name),
      list: () => registry.list().map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly === true, sensitivity: [...(t.sensitivity ?? [])] })),
      call: async <R = unknown>(name: string, args: Record<string, unknown> = {}): Promise<R> => {
        const entry: LoopToolCall = { tool: name, stage: base.stage, ok: false, at: this.now().toISOString() };
        (run.toolCalls ??= []).push(entry);
        const earned = base.stage === 'commit' && (base.approvedTools ?? []).includes(name);
        try {
          const out = await registry.call<R>(name, args, { dir: this.dir, now: this.now(), runId: run.id, stage: base.stage, approved: approved || earned });
          entry.ok = true;
          base.onToolCall?.({ tool: name, args, ok: true });
          return out;
        } catch (err) {
          entry.error = (err as Error).message;
          base.onToolCall?.({ tool: name, args, ok: false, error: entry.error });
          throw err;
        }
      },
    };
    const hasAi = !!(this.providers.fast ?? this.providers.smart ?? this.providers.default);
    return {
      dir: this.dir,
      runId: run.id,
      signal: run.signal,
      anchor,
      stage: base.stage,
      attempt: base.attempt,
      ...(base.route ? { route: base.route } : {}),
      ...(base.replan ? { replan: base.replan } : {}),
      ...(base.humanInput ? { humanInput: base.humanInput } : {}),
      now: this.now(),
      examples,
      facts,
      hasAi,
      ...(this.soul ? { soul: this.soul } : {}),
      persona: personaOf,
      tools,
      approved,
      ai: async (prompt, o = {}) => {
        const tier = o.tier ?? defaultTier;
        const other: Tier = tier === 'fast' ? 'smart' : 'fast';
        const provider = this.providers[tier] ?? this.providers.default ?? this.providers[other];
        if (!provider) throw new Error(`No AI provider is configured (needed for a ${tier} call in "${run.handlerId}" ${base.stage}).`);
        run.aiCalls++;
        run.spectrum[tier]++;
        const system = o.system ?? 'You are Rufus, a careful chief of staff. Answer exactly what is asked.';
        return provider.complete({
          system: o.persona === false ? system : withPersona(system, personaOf()),
          messages: [{ role: 'user', content: prompt }],
          ...(o.json ? { json: true } : {}),
          meta: { runId: run.id, flowId: `loop:${run.handlerId}`, step: base.stage, attempt: base.attempt },
        });
      },
    };
  }

  private pause(run: LoopRun, status: LoopRunStatus): void {
    run.status = status;
    run.spectrum.human++;
  }

  /** Plan -> Execute -> Verify for one run, from the top or from a human-approved plan. Always saves the run. */
  private async process(run: LoopRun, handler: SignalHandler<any, any>, anchor: Anchor, corpus: CorpusItem[], start: { plan?: LoopPlan; humanInput?: string }): Promise<void> {
    try {
      await this.stages(run, handler, anchor, corpus, start);
    } catch (err) {
      run.status = 'error';
      run.error = (err as Error).message;
    }
    await this.save(run);
  }

  private async stages(run: LoopRun, handler: SignalHandler<any, any>, anchor: Anchor, corpus: CorpusItem[], start: { plan?: LoopPlan; humanInput?: string }): Promise<void> {
    const maxReplans = Math.min(MAX_REPLANS_LIMIT, Math.max(0, Math.floor(handler.maxReplans ?? DEFAULT_MAX_REPLANS)));
    let preset = start.plan;
    let feedback: LoopReplan | undefined;
    let previous: Route | undefined;
    delete run.draftPlan;
    delete run.question;

    for (let attempt = 0; ; attempt++) {
      // ---- Plan ----
      let plan: LoopPlan;
      if (preset) {
        plan = { ...preset, needsHumanPlan: false };
        preset = undefined;
      } else {
        const raw = await handler.plan(run.signal, this.context(run, anchor, corpus, { stage: 'plan', attempt, replan: feedback, humanInput: start.humanInput }));
        checkLoopPlan(handler.id, raw);
        const route: Route = previous && routeRank(raw.route) < routeRank(previous) ? previous : raw.route;
        plan = route === raw.route ? raw : { ...raw, route };
        run.spectrum.code++;
        if (plan.needsHumanPlan) {
          run.actionType = plan.actionType;
          run.goal = plan.goal;
          run.urgency = plan.urgency ?? run.signal.urgency ?? 'normal';
          run.draftPlan = plan;
          run.question = plan.question?.trim() || `This is unclear. Is this the right plan? Goal: ${plan.goal}`;
          run.trail.push({ attempt, route: plan.route, goal: plan.goal, outcome: 'human', reason: 'plan needs a human' });
          return this.pause(run, 'awaiting_human_plan');
        }
      }
      run.actionType = plan.actionType;
      run.goal = plan.goal;
      run.route = plan.route;
      run.plan = plan;
      run.replans = attempt;
      run.urgency = plan.urgency ?? run.signal.urgency ?? 'normal';

      const sensitivity = [...new Set([...(plan.sensitivity ?? []), ...this.tools.sensitivityOf(plan.uses ?? [])])];
      const bounds = checkBoundaries(anchor, plan.actionType, sensitivity);
      if (bounds.blockedBy.length) {
        run.blockedBy = bounds.blockedBy.map((b) => b.rule);
        run.status = 'blocked';
        return;
      }
      // v21: an action type the human put on `blocked` never runs, not even its execute step.
      const mode = await this.trust.mode(plan.actionType);
      if (mode === 'blocked') {
        run.autonomy = 'blocked';
        run.blockedBy = [`Earned Trust: ${plan.actionType} is blocked (rufus trust demote ${plan.actionType} puts it back to check).`];
        run.status = 'blocked';
        return;
      }

      // ---- Execute ----
      if (plan.route === 'human' || plan.needsHumanExecute) {
        run.humanStep = plan.humanStep?.trim() || plan.goal;
        run.trail.push({ attempt, route: plan.route, goal: plan.goal, outcome: 'human', reason: 'a person has to do this step' });
        return this.pause(run, 'awaiting_human_execute');
      }
      let result: unknown;
      let failure: string | undefined;
      try {
        result = await handler.execute(plan, run.signal, this.context(run, anchor, corpus, { stage: 'execute', attempt, route: plan.route, replan: feedback }));
        if (plan.route === 'code') run.spectrum.code++;
      } catch (err) {
        if (!(err instanceof AiVerificationError)) throw err;
        failure = err.reason; // a model that failed its own check is a failed attempt to re-plan, not a crash
      }

      // ---- Verify, step 1: cross-check ----
      const checked: VerifyResult | undefined =
        failure !== undefined
          ? { ok: false, reason: failure }
          : handler.crossCheck
            ? verdictOf(await handler.crossCheck(result, plan, run.signal, this.context(run, anchor, corpus, { stage: 'verify', attempt, route: plan.route, replan: feedback })))
            : undefined;
      if (checked && !checked.ok) {
        run.trail.push({ attempt, route: plan.route, goal: plan.goal, outcome: 'failed', reason: checked.reason });
        if (attempt < maxReplans) {
          feedback = { attempt: attempt + 1, reason: checked.reason, previousRoute: plan.route, previousPlan: plan, ...(result !== undefined ? { lastResult: result } : {}), nextRoute: upgradeRoute(plan.route) };
          previous = plan.route;
          continue;
        }
        run.crossCheck = 'failed';
        run.verified = false;
        run.verifyFailure = `still failing after ${attempt} re-plan(s): ${checked.reason}`;
      } else {
        run.trail.push({ attempt, route: plan.route, goal: plan.goal, outcome: checked ? 'passed' : 'unchecked' });
        run.crossCheck = checked ? 'passed' : 'skipped';
        run.verified = true;
        delete run.verifyFailure;
      }
      if (result !== undefined) run.result = result;

      // ---- Verify, step 2: Earned Trust + boundaries ----
      if (plan.autoComplete && run.verified && !bounds.requiresApproval && !sensitivity.length && !(plan.uses ?? []).length) {
        run.status = 'completed';
        await this.commit(run, handler, anchor, corpus, result, false, { approval: 'autonomous', auditFallback: false });
        return;
      }
      // v21 ladder. The kill switch (`mode` is `check` while paused) wins over everything. Money, logins and your own
      // require-approval rules always ask. The built-in "external asks" floor is lifted only by an explicit v21
      // promotion: `auto_notify`, or `autonomous` that covers external (a pre-v21 `autonomous` still asks for sends).
      const trust = await this.trust.get(plan.actionType);
      const current = await this.trust.mode(plan.actionType);
      run.autonomy = current;
      const earnedExternal = current === 'auto_notify' || (current === 'autonomous' && trust.coversExternal === true);
      const stillAsks = bounds.approvalBy.filter((b) => !(earnedExternal && b.id === 'builtin-external'));
      if (!actsOnItsOwn(current) || stillAsks.length || !run.verified) {
        if (bounds.approvalBy.length) run.approvals = bounds.approvalBy.map((b) => b.rule);
        run.promotionSuggested = trust.promotionSuggested;
        if (trust.promotionSuggested) run.promotionHint = promotionMessage(trust);
        return this.pause(run, 'awaiting_human_verify');
      }
      // v25a: <workspace>/boundaries.mjs has the last word on acting alone right now (e.g. a protected window).
      const layer3 = await checkLayer3Boundary({ dir: this.dir, now: this.now(), action: plan.actionType, sensitivity, trust: current });
      if (layer3 && !layer3.allow) {
        run.approvals = [...(run.approvals ?? []), `boundaries.mjs: ${layer3.reason ?? 'not now'}`];
        return this.pause(run, 'awaiting_human_verify');
      }
      run.status = 'completed';
      if (current === 'auto_notify') run.autoNotified = true;
      await this.commit(run, handler, anchor, corpus, result, false, { approval: current as AuditApproval, approvedTools: earnedExternal ? (plan.uses ?? []) : [] });
      if (current === 'auto_notify' && run.committed) await this.trust.recordAutoRun(plan.actionType).catch(() => undefined);
      return;
    }
  }

  /**
   * Applies the output. v21: every write the commit did goes into the audit ledger (`audit.jsonl`): one entry per
   * write tool call, or (with `auditFallback`, the default) one entry for the commit itself when it used no write tool.
   */
  private async commit(
    run: LoopRun,
    handler: SignalHandler<any, any> | undefined,
    anchor: Anchor,
    corpus: CorpusItem[],
    output: unknown,
    approved = false,
    opts: { approval?: AuditApproval; approvedTools?: readonly string[]; auditFallback?: boolean } = {},
  ): Promise<void> {
    if (!handler?.commit) {
      run.committed = false;
      if (!handler) run.commitError = `handler "${run.handlerId}" is not registered here, so nothing was applied`;
      return;
    }
    const approval: AuditApproval = approved ? 'human' : (opts.approval ?? 'autonomous');
    run.approval = approval;
    const calls: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; error?: string }> = [];
    try {
      await handler.commit(
        output,
        run.plan!,
        run.signal,
        this.context(run, anchor, corpus, {
          stage: 'commit',
          attempt: run.replans,
          ...(run.route ? { route: run.route } : {}),
          approved,
          ...(opts.approvedTools?.length ? { approvedTools: opts.approvedTools } : {}),
          onToolCall: (c) => calls.push(c),
        }),
      );
      run.committed = true;
      delete run.commitError;
    } catch (err) {
      run.committed = false;
      run.commitError = (err as Error).message;
    }
    await this.audit(run, calls, approval, opts.auditFallback !== false).catch(() => undefined); // the ledger never breaks a run
  }

  private async audit(run: LoopRun, calls: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; error?: string }>, approval: AuditApproval, fallback: boolean): Promise<void> {
    const action = run.actionType ?? run.handlerId;
    const trustMode: TrustMode = run.autonomy ?? 'check';
    const goal = run.goal ?? action;
    const writes = calls.filter((c) => this.tools.get(c.tool)?.readOnly !== true);
    const entries: AuditEntry[] = [];
    for (const c of writes) {
      const preview = previewArgs(c.args);
      const reversible = this.tools.get(c.tool)?.reversible;
      entries.push(
        await appendAudit(
          this.dir,
          {
            action,
            tool: c.tool,
            summary: describeDone(c.tool, c.args, `ran ${c.tool} (${goal})`),
            ...(preview ? { argsPreview: preview } : {}),
            trustMode,
            approval,
            ok: c.ok,
            ...(c.error ? { error: c.error } : {}),
            ...(reversible !== undefined ? { reversible } : {}),
            runId: run.id,
          },
          this.now(),
        ),
      );
    }
    if (!writes.length && fallback) {
      entries.push(
        await appendAudit(
          this.dir,
          { action, summary: `did: ${goal}`, trustMode, approval, ok: run.committed === true, ...(run.commitError ? { error: run.commitError } : {}), runId: run.id },
          this.now(),
        ),
      );
    }
    if (approval === 'auto_notify' && entries.length) {
      const failed = entries.find((e) => !e.ok);
      run.autoNotice = formatAutoNotice(failed ?? (entries.length === 1 ? entries[0]! : { ...entries[0]!, summary: entries.map((e) => e.summary).join(', ') }));
    }
  }

  /**
   * Record: the human's verdict on a paused run.
   *  - on a verified result: updates Earned Trust, applies the output (the edit, if any) when accepted or edited;
   *  - on a paused plan: accept runs the draft as is, edit re-plans with the human's words, reject drops it;
   *  - on a human step: records whether it was done.
   * Every verdict is also saved as a corpus example (`corpus/items.jsonl`, source `feedback`), so the next plan learns from it.
   */
  async resolveHumanDecision(runId: string, decision: HumanDecision): Promise<DecisionResult> {
    if (!['accept', 'edit', 'reject'].includes(decision?.verdict)) throw new Error(`verdict must be accept, edit or reject (got ${JSON.stringify(decision?.verdict)}).`);
    const run = await this.getRun(runId);
    if (!AWAITING.includes(run.status)) throw new Error(`Run ${runId} is not waiting for a decision (it is ${run.status}).`);
    await this.refreshSoul();
    const stage = run.status === 'awaiting_human_plan' ? 'plan' : run.status === 'awaiting_human_execute' ? 'execute' : 'verify';
    const now = this.now();
    const note = decision.note?.trim() || undefined;
    run.decision = { verdict: decision.verdict, ...(decision.editedOutput !== undefined ? { editedOutput: decision.editedOutput } : {}), ...(note ? { note } : {}), stage, at: now.toISOString() };
    const handler = this.handlers.find((h) => h.id === run.handlerId);
    const finalStatus: LoopRunStatus = decision.verdict === 'accept' ? 'accepted' : decision.verdict === 'edit' ? 'edited' : 'rejected';
    let trust: FeedbackResult | undefined;
    const example = exampleFromDecision(run, stage, now);

    if (stage === 'plan' && decision.verdict !== 'reject') {
      if (!handler) throw new Error(`Handler "${run.handlerId}" is not registered here, so the plan cannot continue. Decide where that handler is loaded.`);
      const anchor = await loadAnchor(this.dir, now);
      const store = new CorpusStore(this.fs.corpusFile);
      await store.add([example]); // the plan decision teaches the re-plan, right now
      const corpus = await store.load();
      const humanInput = decision.verdict === 'edit' ? show(decision.editedOutput) || note : undefined;
      await this.process(run, handler, anchor, corpus, decision.verdict === 'accept' ? { plan: run.draftPlan } : { ...(humanInput ? { humanInput } : {}) });
      return { run, example };
    }

    // v15: an edit of anything external / money / login NEVER commits on the same turn. It becomes the new draft, is
    // recorded as an example, and the run keeps waiting for an explicit accept ("send", "1", "#n send").
    if (stage === 'verify' && decision.verdict === 'edit' && this.sensitivityOf(run).some((x) => HOLD_ON_EDIT.includes(x))) {
      const edited = decision.editedOutput !== undefined ? decision.editedOutput : run.result;
      run.result = withEditedDraft(run.result, edited);
      (run.edits ??= []).push({ text: show(edited), at: now.toISOString() });
      run.status = 'awaiting_human_verify';
      delete run.decision; // not decided yet: the send still needs its own yes
      await new CorpusStore(this.fs.corpusFile).add([example]);
      await this.save(run);
      return { run, example, held: true };
    }

    if (stage === 'verify') {
      // An accept after a held edit is the human's edited version going out: Earned Trust records it as an edit.
      const trustVerdict: Verdict = decision.verdict === 'accept' && run.edits?.length ? 'edit' : decision.verdict;
      trust = await this.trust.recordFeedback(run.actionType!, trustVerdict, note);
      if (decision.verdict !== 'reject') {
        const output = decision.verdict === 'edit' && decision.editedOutput !== undefined ? decision.editedOutput : run.result;
        await this.commit(run, handler, await loadAnchor(this.dir, now), [], output, true);
      }
    }
    run.status = finalStatus;
    await new CorpusStore(this.fs.corpusFile).add([example]);
    await this.save(run);
    const promotionHint = trust?.record.promotionSuggested ? promotionMessage(trust.record) : undefined;
    return { run, example, ...(trust ? { trust } : {}), ...(promotionHint ? { promotionHint } : {}) };
  }
}

/** A raw signal -> a clean one, or undefined when it has no id. */
export function normalizeSignal(raw: unknown, defaultSurface: string): LoopSignal | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const id = typeof r.id === 'number' ? String(r.id) : text(r.id);
  if (!id) return undefined;
  const data = typeof r.data === 'object' && r.data !== null && !Array.isArray(r.data) ? (r.data as Record<string, unknown>) : undefined;
  return {
    id,
    surface: text(r.surface) ?? defaultSurface,
    kind: text(r.kind) ?? 'signal',
    ...(text(r.text) ? { text: text(r.text)! } : {}),
    ...(text(r.actor) ? { actor: text(r.actor)! } : {}),
    ...(text(r.timestamp) ? { timestamp: text(r.timestamp)! } : {}),
    ...(r.urgency === 'urgent' || r.urgency === 'normal' ? { urgency: r.urgency } : {}),
    ...(data ? { data } : {}),
  };
}

/** One human verdict as a corpus item: what came in, what Rufus proposed, and what the human decided. */
export function exampleFromDecision(run: LoopRun, stage: 'plan' | 'execute' | 'verify', now: Date): CorpusItem {
  const d = run.decision!;
  const actionType = run.actionType ?? 'unknown';
  const proposed = stage === 'plan' ? run.draftPlan?.goal : stage === 'execute' ? run.humanStep : show(run.result);
  const final = d.verdict === 'reject' ? undefined : d.editedOutput !== undefined ? show(d.editedOutput) : proposed;
  const incoming = run.signal.text ?? `${run.signal.surface}/${run.signal.kind}`;
  const summary = [
    `In: ${incoming}`,
    proposed ? `Proposed: ${proposed}` : undefined,
    `Human: ${d.verdict}${d.verdict === 'edit' && final ? ` -> ${final}` : ''}`,
    d.note ? `Note: ${d.note}` : undefined,
  ]
    .filter(Boolean)
    .join(' | ');
  return {
    id: stableId('feedback', run.id, stage, d.verdict, d.at),
    source: 'feedback',
    kind: `${stage}.${d.verdict}`,
    title: clip(`${actionType}: ${run.goal ?? incoming}`, 200),
    summary: clip(summary, 500),
    ...(run.signal.actor ? { actor: run.signal.actor } : {}),
    timestamp: now.toISOString(),
    tags: [actionType, d.verdict, run.signal.surface, 'loop'],
    metadata: {
      runId: run.id,
      actionType,
      stage,
      verdict: d.verdict,
      ...(run.goal ? { goal: run.goal } : {}),
      ...(run.route ? { route: run.route } : {}),
      signal: { surface: run.signal.surface, kind: run.signal.kind, ...(run.signal.text ? { text: run.signal.text } : {}), ...(run.signal.actor ? { actor: run.signal.actor } : {}) },
      ...(proposed !== undefined ? { proposed } : {}),
      ...(final !== undefined ? { final } : {}),
      ...(d.note ? { note: d.note } : {}),
    },
  };
}

/** A short, readable report of one pass. */
export function formatLoopReport(r: LoopTickReport): string[] {
  const lines: string[] = [];
  for (const e of r.errors) lines.push(`sensor ${e.sensorId} failed (will retry next pass): ${e.error}`);
  if (r.status === 'idle') {
    lines.push(`Idle: no new signals${r.duplicates ? ` (${r.duplicates} already handled)` : ''}. Cost: 0 model calls.`);
    return lines;
  }
  lines.push(`Sensed ${r.signals} new signal(s); ${r.runs.length} handled, ${r.unhandled.length} with no handler. Cost: ${r.cost} model call(s).`);
  for (const run of r.runs) {
    const what = run.actionType ? `${run.actionType}${run.goal ? `: ${run.goal}` : ''}` : run.goal ?? '';
    lines.push(`  ${run.runId}  ${run.status}${run.route ? ` via ${run.route}` : ''}  ${what}`.trimEnd());
  }
  for (const s of r.unhandled.slice(0, 5)) lines.push(`  no handler for ${s.surface}/${s.kind} (${s.id})`);
  if (r.runs.some((x) => AWAITING.includes(x.status))) lines.push('Decide with: rufus decide <runId> accept|edit|reject [note]');
  return lines;
}

/** One paused run as a few lines for the terminal or a chat. */
export function formatLoopRun(run: LoopRun): string[] {
  const head = `${run.id}  ${run.status}  ${run.actionType ?? run.handlerId}${run.goal ? `: ${run.goal}` : ''}`;
  const lines = [head];
  if (run.signal.text) lines.push(`  signal: ${clip(run.signal.text, 160)}`);
  if (run.status === 'awaiting_human_plan') lines.push(`  question: ${run.question}`);
  if (run.status === 'awaiting_human_execute') lines.push(`  your step: ${run.humanStep}`);
  if (run.result !== undefined && run.status === 'awaiting_human_verify') lines.push(`  result: ${clip(show(run.result), 300)}`);
  if (run.verifyFailure) lines.push(`  cross-check: ${run.verifyFailure}`);
  for (const a of run.approvals ?? []) lines.push(`  needs approval: ${a}`);
  for (const b of run.blockedBy ?? []) lines.push(`  blocked by: ${b}`);
  if (run.error) lines.push(`  error: ${run.error}`);
  if (run.promotionHint) lines.push(`  ${run.promotionHint}`);
  return lines;
}
