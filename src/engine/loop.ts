import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertActionType, promotionMessage, TrustStore, type FeedbackResult, type Verdict } from './trust';
import { AiVerificationError } from './ai';
import { emptySpectrum } from './spectrum';
import { ROUTES, routeRank, upgradeRoute, DEFAULT_MAX_REPLANS, MAX_REPLANS_LIMIT } from './stages';
import { checkBoundaries, loadAnchor, type Anchor, type Sensitivity } from '../anchor/anchor';
import { CorpusStore, queryCorpus, type CorpusHit, type CorpusItem } from '../corpus';
import { clip, stableId } from '../corpus/types';
import { FileStore } from '../store';
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
 */

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
  /** One model call (counted on the run). Throws when no provider is configured. */
  ai(prompt: string, opts?: AskOptions): Promise<string>;
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
  | 'error';

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
  /** Earned Trust at the time it paused. */
  autonomy?: 'check' | 'autonomous';
  promotionSuggested?: boolean;
  promotionHint?: string;
  decision?: HumanDecision & { stage: 'plan' | 'execute' | 'verify'; at: string };
  committed?: boolean;
  commitError?: string;
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
}

export interface DecisionResult {
  run: LoopRun;
  /** Set for decisions on a verified result. */
  trust?: FeedbackResult;
  /** The example saved to `corpus/items.jsonl`. */
  example: CorpusItem;
  promotionHint?: string;
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

export const loopRunId = (sensorId: string, signalId: string): string => `loop_${createHash('sha256').update(`${sensorId}\u0000${signalId}`).digest('hex').slice(0, 16)}`;

export class MasterLoop {
  readonly dir: string;
  readonly trust: TrustStore;
  private readonly fs: FileStore;
  private readonly sensors: Sensor[] = [];
  private readonly handlers: SignalHandler<any, any>[] = [];
  private readonly providers: NonNullable<MasterLoopOptions['providers']>;
  private readonly now: () => Date;

  constructor(opts: MasterLoopOptions) {
    this.dir = opts.dir;
    this.fs = new FileStore(opts.dir);
    this.now = opts.now ?? (() => new Date());
    this.trust = opts.trust ?? new TrustStore(opts.dir, { now: this.now });
    this.providers = opts.providers ?? {};
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

  /** One full pass. Zero new signals: `{ status: 'idle', cost: 0 }` and no model is ever called. */
  async runOnce(): Promise<LoopTickReport> {
    const now = this.now();
    const report: LoopTickReport = { status: 'idle', cost: 0, signals: 0, runs: [], unhandled: [], duplicates: 0, errors: [] };

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
      for (const raw of polled.signals ?? []) {
        const signal = normalizeSignal(raw, sensor.surface);
        if (!signal) continue;
        const runId = loopRunId(sensor.id, signal.id);
        if (await this.runExists(runId)) {
          report.duplicates++;
          continue;
        }
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
        report.runs.push({ runId: run.id, status: run.status, ...(run.actionType ? { actionType: run.actionType } : {}), ...(run.goal ? { goal: run.goal } : {}), ...(run.route ? { route: run.route } : {}) });
      }
      if (polled.nextCursor !== undefined) state.cursors[sensor.id] = polled.nextCursor;
      await this.fs.writeJson(this.stateFile, { ...state, lastTickAt: now.toISOString() });
    }
    if (report.signals) report.status = 'ran';
    return report;
  }

  private context(run: LoopRun, anchor: Anchor, corpus: CorpusItem[], base: { stage: LoopStageContext['stage']; attempt: number; route?: Route; replan?: LoopReplan; humanInput?: string }): LoopStageContext {
    const defaultTier: Tier = base.stage === 'execute' && base.route === 'smart' ? 'smart' : 'fast';
    const signalText = run.signal.text ?? '';
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
      examples: (o = {}) => {
        const pool = corpus.filter((i) => i.source === 'feedback' && (!o.actionType || i.tags?.includes(o.actionType)));
        return queryCorpus(pool, { query: o.query ?? signalText, limit: o.limit ?? 3, now: this.now() });
      },
      facts: (query, o = {}) => queryCorpus(corpus, { query, sources: o.sources, limit: o.limit ?? 5, now: this.now() }),
      ai: async (prompt, o = {}) => {
        const tier = o.tier ?? defaultTier;
        const other: Tier = tier === 'fast' ? 'smart' : 'fast';
        const provider = this.providers[tier] ?? this.providers.default ?? this.providers[other];
        if (!provider) throw new Error(`No AI provider is configured (needed for a ${tier} call in "${run.handlerId}" ${base.stage}).`);
        run.aiCalls++;
        run.spectrum[tier]++;
        return provider.complete({
          system: o.system ?? 'You are Rufus, a careful chief of staff. Answer exactly what is asked.',
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

      const bounds = checkBoundaries(anchor, plan.actionType, plan.sensitivity ?? []);
      if (bounds.blockedBy.length) {
        run.blockedBy = bounds.blockedBy.map((b) => b.rule);
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
      const trust = await this.trust.get(plan.actionType);
      run.autonomy = trust.autonomy;
      if (bounds.requiresApproval || trust.autonomy === 'check' || !run.verified) {
        if (bounds.approvalBy.length) run.approvals = bounds.approvalBy.map((b) => b.rule);
        run.promotionSuggested = trust.promotionSuggested;
        if (trust.promotionSuggested) run.promotionHint = promotionMessage(trust);
        return this.pause(run, 'awaiting_human_verify');
      }
      run.status = 'completed';
      await this.commit(run, handler, anchor, corpus, result);
      return;
    }
  }

  private async commit(run: LoopRun, handler: SignalHandler<any, any> | undefined, anchor: Anchor, corpus: CorpusItem[], output: unknown): Promise<void> {
    if (!handler?.commit) {
      run.committed = false;
      if (!handler) run.commitError = `handler "${run.handlerId}" is not registered here, so nothing was applied`;
      return;
    }
    try {
      await handler.commit(output, run.plan!, run.signal, this.context(run, anchor, corpus, { stage: 'commit', attempt: run.replans, ...(run.route ? { route: run.route } : {}) }));
      run.committed = true;
      delete run.commitError;
    } catch (err) {
      run.committed = false;
      run.commitError = (err as Error).message;
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

    if (stage === 'verify') {
      trust = await this.trust.recordFeedback(run.actionType!, decision.verdict, note);
      if (decision.verdict !== 'reject') {
        const output = decision.verdict === 'edit' && decision.editedOutput !== undefined ? decision.editedOutput : run.result;
        await this.commit(run, handler, await loadAnchor(this.dir, now), [], output);
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
