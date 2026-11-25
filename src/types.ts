/** Shared types for flows, runs, human cards and AI providers. */

import type { QuietHours, Trigger } from './scheduler/triggers';

// ---------- Human ----------

export interface HumanOption {
  id: string;
  label: string;
  description?: string;
}

export interface HumanStepSpec {
  title: string;
  summary: string;
  details?: string;
  /** Strings, or objects. Ids default to a slug of the label. */
  options?: Array<string | { id?: string; label: string; description?: string }>;
  /** Default true. If false, `options` is required and only a choice is accepted. */
  allowFreeText?: boolean;
}

/** Structured, channel-agnostic "your turn" card. Text/HUD/etc. are renderings of this. */
export interface HumanCard {
  id: string;
  runId: string;
  flowId: string;
  step: string;
  title: string;
  summary: string;
  details?: string;
  options: HumanOption[];
  allowFreeText: boolean;
  createdAt: string;
}

export interface HumanLessonInput {
  rule: string;
  /** Defaults to `flow:<flowId>`. See `scopes` in src/learning. */
  scope?: string;
}

/** What a human sends back. `choice` is an option id, label, or 1-based number. */
export interface HumanReply {
  choice?: string;
  text?: string;
  lesson?: string | HumanLessonInput;
}

/** What `ctx.human()` returns to the flow once answered. */
export interface HumanAnswer {
  /** Option id, if a choice was made. */
  choice?: string;
  choiceLabel?: string;
  text?: string;
  answeredAt: string;
}

// ---------- AI ----------

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  system: string;
  messages: AiMessage[];
  model?: string;
  /** Ask the provider for a JSON object reply when it supports a native JSON mode (Gemini does). Others ignore it. */
  json?: boolean;
  meta: { runId: string; flowId: string; step: string; attempt: number };
}

/** Pluggable model adapter. Return the model's text. */
export interface AiProvider {
  complete(req: AiRequest): Promise<string>;
}

/** The two model tiers. Name them under `config.providers` (`fast`, `smart`); an unconfigured tier falls back to the default provider. */
export type Tier = 'fast' | 'smart';

/**
 * The Spectrum of Intelligence, cheapest and most exact first: `code`, then a `fast` model, then a `smart` model, then a
 * `human`. Work should stay as far left as it can.
 */
export type Rung = 'code' | Tier | 'human';

/** How many steps of a run each rung handled. Stored on the run as `run.spectrum`. */
export interface Spectrum {
  code: number;
  fast: number;
  smart: number;
  human: number;
  /** Steps where `fast` could not pass `verify`, so they moved up a rung. Only present when it happened. */
  escalated?: number;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface AiStepOptions<T = string> {
  prompt: string;
  /** Exact, structured data gathered by code before the AI thinks. */
  context?: unknown;
  /** Deterministic check. On failure the exact `reason` is fed back and the AI retries. */
  verify?: (output: T) => VerifyResult | Promise<VerifyResult>;
  /** Default 2 (so up to 3 attempts). */
  maxRetries?: number;
  model?: string;
  /** Ask the provider for a JSON reply when it has a native JSON mode (e.g. Gemini). Set it when `parse` expects JSON. */
  json?: boolean;
  /** Name of a provider in `config.providers` (or `"default"`). Beats the flow's `meta.provider`. */
  provider?: string;
  /**
   * Which rung of the spectrum this step needs: `fast` for wording and light classification, `smart` for judgment.
   * Resolves to `config.providers.fast` / `.smart`; if that tier is not configured, the flow's (or the default) provider is used.
   * `provider` (by name) beats `tier`. A step with neither counts as `smart` in `run.spectrum`.
   */
  tier?: Tier;
  /** Turn raw model text into `T`. A throw counts as a failed verification. */
  parse?: (raw: string) => T;
  /**
   * How many recent human-reviewed examples of this step to show the model. Default 3.
   * `false` (or 0) turns them off.
   */
  includeExamples?: number | false;
}

/** Per-rung tweaks for `ctx.escalate`. */
export interface RungOptions {
  model?: string;
  /** Ask the provider for a JSON reply when it has a native JSON mode (e.g. Gemini). Set it when `parse` expects JSON. */
  json?: boolean;
  /** Name of a provider in `config.providers`. Beats the rung's tier. */
  provider?: string;
  /** Retries on this rung before moving up. Default 1 for `fast`, 2 for `smart`. */
  maxRetries?: number;
}

/** What a human sees when both models failed `verify`. A function gets the last failure so the card can show it. */
export type EscalateHumanSpec = HumanStepSpec | ((failure: { reason: string; lastOutput: string }) => HumanStepSpec);

export interface EscalateOptions<T = string> extends Omit<AiStepOptions<T>, 'tier' | 'provider' | 'model' | 'maxRetries'> {
  /** The cheap first try. */
  fast?: RungOptions;
  /** Used only if `fast` cannot pass `verify`. */
  smart?: RungOptions;
  /** Last rung: if `smart` also fails `verify`, ask a human. Without it, the step fails like a normal ai step. */
  human?: EscalateHumanSpec;
}

/** Which rung handled an escalated step, and what it produced. */
export type EscalateResult<T> =
  | { rung: Tier; value: T; attempts: number }
  | { rung: 'human'; answer: HumanAnswer; reason: string };

// ---------- Flows ----------

export interface FlowMeta {
  id: string;
  name: string;
  description: string;
  /** Lessons scoped to this role are injected into every `ai` step. */
  role?: string;
  /** Named provider (a key of `config.providers`) for this flow's ai steps. A step's own `provider` beats it. */
  provider?: string;
  /** How this flow starts. See `at()`, `every()` and `onEvent()` in src/scheduler. Default: manual. */
  trigger?: Trigger;
}

/** Options for `ctx.code`. */
export interface CodeStepOptions {
  /** Bookkeeping only: the step is saved and replayed like any other, but not counted in `run.spectrum` (used inside staged flows, whose stages are counted once). */
  bookkeeping?: boolean;
}

// ---------- Three-stage flows: plan -> execute -> verify ----------

/** Where a staged flow does the work, cheapest first: `code`, a `fast` model, a `smart` model, then a `human`. Same order as the Spectrum. */
export type Route = Rung;

export type StageName = 'plan' | 'execute' | 'verify';

/**
 * What `plan` returns: a concrete goal, and which rung should do the work. It is saved with the run, so keep it JSON.
 * Add your own fields (a prompt, gathered context, retrieved examples, ...); `execute` and `verify` get the whole plan back.
 */
export interface StagePlan {
  /** One explicit, concrete sentence: what "done" means. `verify` checks the result against it. */
  goal: string;
  /** Chosen upfront, in code. Prefer `code`, then `fast`, then `smart`; `human` skips straight to a person. */
  route: Route;
  /** Optional objective acceptance criteria (also for a model-based `verify` to read). */
  criteria?: string[];
  /** Why this route (shows on the human card and in the trail). */
  reason?: string;
  [extra: string]: unknown;
}

/** One pass of the plan -> execute -> verify loop, as recorded in `StagedResult.trail`. */
export interface StageTrailEntry {
  /** 0 for the first pass, 1 for the first re-plan, ... */
  attempt: number;
  route: Route;
  goal: string;
  outcome: 'passed' | 'failed' | 'human';
  /** Why it failed verification, or why it went to a human. */
  reason?: string;
}

/** Fed back into `plan` after `verify` fails, so the re-plan can fix the cause instead of retrying blindly. */
export interface ReplanFeedback {
  /** 1 for the first re-plan. */
  attempt: number;
  /** The exact reason `verify` (or the model's own check) gave. */
  reason: string;
  previousRoute: Route;
  previousGoal: string;
  previousPlan: StagePlan;
  /** What `execute` produced (absent when `execute` itself failed its model check). */
  lastResult?: unknown;
  /** One rung above `previousRoute` (`smart` stays `smart`): the cheapest sensible upgrade. A re-plan never goes below `previousRoute`. */
  nextRoute: Route;
  trail: StageTrailEntry[];
}

/**
 * The context every stage function gets: the normal flow steps (`code`, `ai`, `human`, ...), plus where we are.
 * Inside a stage, `ai` defaults `tier` to the plan's route (execute) or `fast` (plan, verify): pass `tier` to override.
 * Stage functions re-run on resume like any flow body, so keep what is outside `ctx.*` steps deterministic.
 */
export interface StageContext<I = unknown> extends FlowContext<I> {
  readonly stage: StageName;
  /** 0 on the first pass. */
  readonly attempt: number;
  /** The route of the plan being executed or verified. Undefined while planning. */
  readonly route?: Route;
  /** Set when this pass is a re-plan after a failed verification. */
  readonly replan?: ReplanFeedback;
}

export interface HumanHandoff<P extends StagePlan = StagePlan> {
  /** Why a person is needed: the plan said so, or verification kept failing. */
  reason: string;
  goal: string;
  plan: P;
  lastResult?: unknown;
  trail: StageTrailEntry[];
}

export interface StagedSpec<I = unknown, R = unknown, P extends StagePlan = StagePlan> {
  /** Stage 1. Gather context (code, hybrid retrieval of real examples, ...), define the goal, and pick the route upfront. */
  plan(input: I, ctx: StageContext<I>): P | Promise<P>;
  /** Stage 2. Do the work on `plan.route` only: no cheap-then-medium-then-expensive cascade. Return JSON. */
  execute(plan: P, ctx: StageContext<I>): R | Promise<R>;
  /** Stage 3. Cross-check the result against the Stage 1 goal. Code is the first choice; `ctx.ai` may review complex output. */
  verify(result: R, plan: P, ctx: StageContext<I>): VerifyResult | Promise<VerifyResult>;
  /** Re-plans allowed after a failed verification before a human is asked (0-5). Default 1. */
  maxReplans?: number;
  /** The card a person sees when the plan routes to `human` or verification keeps failing. A default card is used without it. */
  human?: HumanStepSpec | ((handoff: HumanHandoff<P>) => HumanStepSpec);
}

export type StagedResult<R = unknown, P extends StagePlan = StagePlan> =
  | { status: 'passed'; route: Route; goal: string; plan: P; result: R; replans: number; trail: StageTrailEntry[] }
  | { status: 'human'; route: 'human'; goal: string; plan: P; answer: HumanAnswer; reason: string; replans: number; trail: StageTrailEntry[]; lastResult?: unknown };

export interface FlowContext<I = unknown> {
  readonly runId: string;
  readonly input: I;
  /** Deterministic step. Runs once; the JSON result is replayed on resume. */
  code<T>(name: string, fn: () => T | Promise<T>, opts?: CodeStepOptions): Promise<T>;
  /** Code-assisted AI step. */
  ai(name: string, opts: AiStepOptions<string> & { parse?: undefined }): Promise<string>;
  ai<T>(name: string, opts: AiStepOptions<T> & { parse: (raw: string) => T }): Promise<T>;
  /**
   * Climb the spectrum: try a `fast` model, check it with the deterministic `verify`, and only if it cannot pass move to
   * a `smart` model, then (if `human` is given) to a person. Records the rung that handled it in `run.spectrum`.
   */
  escalate(name: string, opts: EscalateOptions<string> & { parse?: undefined }): Promise<EscalateResult<string>>;
  escalate<T>(name: string, opts: EscalateOptions<T> & { parse: (raw: string) => T }): Promise<EscalateResult<T>>;
  /** Pause for a human. Resolves with their answer after `engine.answer()`. */
  human(name: string, spec: HumanStepSpec): Promise<HumanAnswer>;
  /**
   * Run a three-stage unit: `plan` (context, goal, route chosen upfront) -> `execute` (on that route only) -> `verify`
   * (against the goal). If `verify` fails, the reason goes back into `plan` for a better plan and a higher route, up to
   * `maxReplans` times; after that, or when a plan routes to `human`, a person decides.
   */
  staged<R, P extends StagePlan = StagePlan>(name: string, spec: StagedSpec<I, R, P>): Promise<StagedResult<R, P>>;
}

export interface Flow<I = any, O = any> {
  readonly meta: FlowMeta;
  readonly run: (ctx: FlowContext<I>) => Promise<O>;
}

// ---------- Runs ----------

export interface StepRecord {
  kind: 'code' | 'ai' | 'human';
  name: string;
  done: boolean;
  /** code only: saved and replayed, but not counted in the spectrum (see `CodeStepOptions`). */
  bookkeeping?: boolean;
  /** JSON result, present once `done`. */
  result?: unknown;
  /** ai only: how many attempts it took. */
  attempts?: number;
  /** ai only: the rung that handled it (`fast` or `smart`). Absent on older runs, which count as `smart`. */
  rung?: Tier;
  /** ai only: `fast` could not pass `verify`, so the step moved up (to `smart`, or to a human). */
  escalated?: boolean;
  /** ai only: every model rung failed `verify` and a human step (same name) took over. */
  handoff?: { reason: string; lastOutput: string };
  /** human only: the card shown to the human. */
  card?: HumanCard;
}

export type RunStatus = 'running' | 'waiting_human' | 'completed' | 'failed';

export interface RunRecord {
  id: string;
  flowId: string;
  status: RunStatus;
  input: unknown;
  steps: Record<string, StepRecord>;
  pendingCardId?: string;
  /** Which rung of the spectrum handled each step so far. */
  spectrum?: Spectrum;
  output?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type RunResult =
  | { status: 'completed'; runId: string; output: unknown }
  | { status: 'waiting_human'; runId: string; card: HumanCard }
  | { status: 'failed'; runId: string; error: string };

// ---------- Config ----------

export type ProviderConfig =
  | { type: 'openai-compatible'; baseUrl: string; model: string; apiKeyEnv?: string }
  | { type: 'command'; command: string; args?: string[] }
  | {
      type: 'gemini';
      /** Default `gemini-2.5-flash`. */
      model?: string;
      /** The key itself. Prefer `apiKeyEnv`. Sent in the `x-goog-api-key` header, never in a URL. */
      apiKey?: string;
      /** Default `GEMINI_API_KEY`. */
      apiKeyEnv?: string;
      /** Default `https://generativelanguage.googleapis.com/v1beta`. */
      baseUrl?: string;
      temperature?: number;
      maxOutputTokens?: number;
      timeoutMs?: number;
    };

/**
 * Where vectors for retrieval come from (`rufus embed`, and automatically on `rufus collect`). Default `local`: offline, $0.
 * `ollama` is local neural ($0); `gemini` and `http` send the embedded text to that service, so choose them on purpose.
 */
export interface EmbeddingConfig {
  type?: 'local' | 'ollama' | 'gemini' | 'http';
  /** Model name (ollama: `nomic-embed-text`; gemini: `gemini-embedding-001`; http: required). */
  model?: string;
  /** Ollama default `http://127.0.0.1:11434`; Gemini default the Generative Language API; http: required (e.g. `https://api.example.com/v1`). */
  baseUrl?: string;
  /** Vector length: local default 256, gemini default 768. */
  dimensions?: number;
  /** The key itself. Prefer `apiKeyEnv`. Sent in a header, never in a URL. */
  apiKey?: string;
  /** Environment variable holding the key (gemini default `GEMINI_API_KEY`, http default `RUFUS_API_KEY`). */
  apiKeyEnv?: string;
  /** Abort a request after this many milliseconds (default 60000). */
  timeoutMs?: number;
}

/** Telegram Bot API settings. Env vars (RUFUS_TELEGRAM_*) override these; prefer env for the token. */
export interface TelegramConfig {
  /** Bot token from @BotFather. */
  token?: string;
  /** The only chat Rufus reads from and writes to. A number or string (negative for groups). */
  chatId?: string | number;
  /** Bot API base URL, for a self-hosted Bot API server. Default https://api.telegram.org */
  apiUrl?: string;
  /** Turns voice notes and audio into text with a local command. Unset: voice notes are skipped. */
  transcribe?: TranscribeCommand;
}

/**
 * A local speech-to-text command. `"{file}"` in `args` is replaced with the downloaded
 * audio path; without it, the path is appended as the last arg. Trimmed stdout is the transcript.
 */
export interface TranscribeCommand {
  command: string;
  args?: string[];
  /** Default 120000 (2 minutes). */
  timeoutMs?: number;
}

/** Beeper Desktop API settings. Env vars (RUFUS_BEEPER_*) override these; prefer env for the token. */
export interface BeeperConfig {
  url?: string;
  token?: string;
  chatId?: string;
  /** The chat is a note-to-self, so your own messages count as replies. */
  selfChat?: boolean;
  /** Beeper Desktop's local API for tools and sensors. Default http://127.0.0.1:23373 (falls back to `url`). */
  apiUrl?: string;
}

/** A local CLI wrapped as a tool (`config.tools.commands["calendar.read"]`). */
export interface CommandToolConfig {
  /** The program to run (no shell). */
  command: string;
  /** Arguments; `{{key}}` is replaced with the tool call's `args.key`. The args also arrive on stdin as JSON. */
  args?: string[];
  description?: string;
  /** True when it only reads (may run while planning/executing). Default from the name: `*.read` is read-only. */
  readOnly?: boolean;
  /** `external`, `money`, `login`: always needs a human's yes unless trusted. */
  sensitivity?: Array<'external' | 'money' | 'login'>;
  /** Default 30000. */
  timeoutMs?: number;
  cwd?: string;
}

/** Real tool hands. */
export interface ToolsConfig {
  /** Local CLI tools by name: `calendar.read`, `calendar.write`, `gmail.read`, `gmail.draft`, `shell.run`, or your own. */
  commands?: Record<string, CommandToolConfig>;
  /** Tools whose sensitive action may run without a per-run yes. Empty by default: think before adding one. */
  trusted?: string[];
  /** `false` turns off the built-in `beeper.read` / `beeper.send` even when Beeper is configured. */
  beeper?: boolean;
}

/** The Beeper sensor: new incoming messages from people, across your chats. */
export interface BeeperSensorConfig {
  /** Chats never sensed (your Rufus chat is always skipped). */
  ignoreChatIds?: string[];
  /** Also sense group chats. Default true. */
  groups?: boolean;
  /** Skip muted chats. Default true. */
  skipMuted?: boolean;
  /** Messages read per chat per pass. Default 20. */
  limitPerChat?: number;
  /** Chats whose title matches this (case-insensitive regex) are bots and skipped. Default `\bbot\b|bot$`. */
  botPattern?: string;
  /** Chats with exactly this title (case-insensitive) are never sensed: Rufus's own chat. Default `["rufus"]`. */
  ignoreChatTitles?: string[];
}

/** A read-only command whose JSON output becomes signals (`config.sensors.commands[]`). */
export interface CommandSensorConfig {
  id: string;
  /** `calendar`, `email`, ... Default `id`. */
  surface?: string;
  /** Default `<surface>.item`. */
  kind?: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  cwd?: string;
  /** Where the list is in the JSON (`items`, `data.events`). Default: the top-level array or `items`/`events`/`messages`/`threads`/`data`. */
  itemsPath?: string;
  idField?: string;
  textField?: string;
  actorField?: string;
  timestampField?: string;
  /** On the first pass, remember what is already there without emitting it. Default true (no flood on Day 1). */
  baseline?: boolean;
  urgency?: 'urgent' | 'normal';
}

export interface SensorsConfig {
  /** `true` (defaults) or settings. Needs Beeper configured (`beeper` or `RUFUS_BEEPER_TOKEN`). */
  beeper?: boolean | BeeperSensorConfig;
  commands?: CommandSensorConfig[];
}

/** `rufus start`: the unified daemon. */
export interface StartConfig {
  /** How often to sense and read replies. Default `30s`. */
  interval?: string;
  /** How often normal (non-urgent) items are delivered as one check-in. Default `2h`. */
  checkinEvery?: string;
  /** Which chat to talk through, when both are configured. */
  channel?: 'telegram' | 'beeper';
  /**
   * A tiny local `POST /signal` webhook (Bearer token) so phone automations (MacroDroid, Tasker) can push
   * `phone.unlocked`, `app.opened`, `location.changed` into the loop. Off unless set. The token may also come from
   * `RUFUS_WEBHOOK_TOKEN`. Default host `127.0.0.1`, port 8787.
   */
  webhook?: { port?: number; host?: string; token?: string };
  /** Proactive heads-ups before Anchor blocks and the good-morning brief. Default on; `false` turns it off. */
  heartbeat?: false | { leadMinutes?: number; quietHours?: string | false; morningBrief?: boolean; morningUntil?: string };
}

/** Guardrails against piling up prompt rules. */
export interface LearningConfig {
  /** Most active (non-hardened) lessons per scope. Default 7. */
  maxLessonsPerScope?: number;
}

/** `rufus mine` settings. */
export interface MineConfig {
  /** Calendar-based recency, only when set: days for a reply's weight to halve (0 turns weighting off). By default weighting follows observations instead (see `halfLifeObservations`). */
  halfLifeDays?: number;
  /** Rank-based recency (the default, 100): the Nth newest reply weighs half the newest, however long those N took. Wins over `halfLifeDays`. */
  halfLifeObservations?: number;
  /** Named provider for `rufus mine --ai`. Default: `smart` if configured, else the default provider. */
  provider?: string;
  /** Your own intent buckets (first match wins). Replaces the built-in ones. `pattern` is a case-insensitive regex. */
  buckets?: Array<{ id: string; label?: string; pattern: string }>;
  /** Fewest pairs before rules are proposed (default 10). */
  minPairs?: number;
  /** @deprecated Use `invariantMinShare`. */
  minShare?: number;
  /** Share of replies a behavior must hold for to be a hard invariant (default 0.98). Below that it has real exceptions and is reported as conditional logic instead of a wall. */
  invariantMinShare?: number;
  /** Fewest exception cases before contrast (the `if / else` search) runs (default 5). */
  minExceptions?: number;
  /** A trigger's exception rate must be at least this many times the rest (default 2). */
  minLift?: number;
  /** Fewest replies a situation (channel, closeness, DM/group, ...) needs before it can become a generalized rule (default 30). */
  minSlicePairs?: number;
  /** ... and fewest different contacts in it (default 5). */
  minDistinctContacts?: number;
  /** ... and the largest share (0-1) any single contact may have of it (default 0.4). */
  maxTopContactShare?: number;
}

export interface RufusConfig {
  version: 1;
  /** The default provider, used when a flow or step does not name one. */
  provider?: ProviderConfig;
  /** Extra named providers, e.g. `fast` (cheap model for phrasing) and `smart` (judgment). Pick one with `meta.provider` or `ctx.ai(..., { provider })`. */
  providers?: Record<string, ProviderConfig>;
  /** Chief of Staff chat settings. */
  chief?: { /** Named provider (a key of `providers`) for free-form chat. */ provider?: string };
  telegram?: TelegramConfig;
  beeper?: BeeperConfig;
  /** The scheduler stays silent in this window unless a trigger is `urgent`. */
  quietHours?: QuietHours;
  learning?: LearningConfig;
  mine?: MineConfig;
  embeddings?: EmbeddingConfig;
  /** Real tool hands (v12). */
  tools?: ToolsConfig;
  /** Live app sensors for `rufus start` (v12). */
  sensors?: SensorsConfig;
  /** The unified daemon (v12). */
  start?: StartConfig;
}
