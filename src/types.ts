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
  meta: { runId: string; flowId: string; step: string; attempt: number };
}

/** Pluggable model adapter. Return the model's text. */
export interface AiProvider {
  complete(req: AiRequest): Promise<string>;
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
  /** Name of a provider in `config.providers` (or `"default"`). Beats the flow's `meta.provider`. */
  provider?: string;
  /** Turn raw model text into `T`. A throw counts as a failed verification. */
  parse?: (raw: string) => T;
  /**
   * How many recent human-reviewed examples of this step to show the model. Default 3.
   * `false` (or 0) turns them off.
   */
  includeExamples?: number | false;
}

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

export interface FlowContext<I = unknown> {
  readonly runId: string;
  readonly input: I;
  /** Deterministic step. Runs once; the JSON result is replayed on resume. */
  code<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  /** Code-assisted AI step. */
  ai(name: string, opts: AiStepOptions<string> & { parse?: undefined }): Promise<string>;
  ai<T>(name: string, opts: AiStepOptions<T> & { parse: (raw: string) => T }): Promise<T>;
  /** Pause for a human. Resolves with their answer after `engine.answer()`. */
  human(name: string, spec: HumanStepSpec): Promise<HumanAnswer>;
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
  /** JSON result, present once `done`. */
  result?: unknown;
  /** ai only: how many attempts it took. */
  attempts?: number;
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
  | { type: 'command'; command: string; args?: string[] };

/** Telegram Bot API settings. Env vars (RUFUS_TELEGRAM_*) override these; prefer env for the token. */
export interface TelegramConfig {
  /** Bot token from @BotFather. */
  token?: string;
  /** The only chat Rufus reads from and writes to. A number or string (negative for groups). */
  chatId?: string | number;
  /** Bot API base URL, for a self-hosted Bot API server. Default https://api.telegram.org */
  apiUrl?: string;
}

/** Beeper Desktop API settings. Env vars (RUFUS_BEEPER_*) override these; prefer env for the token. */
export interface BeeperConfig {
  url?: string;
  token?: string;
  chatId?: string;
  /** The chat is a note-to-self, so your own messages count as replies. */
  selfChat?: boolean;
}

/** Guardrails against piling up prompt rules. */
export interface LearningConfig {
  /** Most active (non-hardened) lessons per scope. Default 7. */
  maxLessonsPerScope?: number;
}

/** `rufus mine` settings. */
export interface MineConfig {
  /** Named provider for `rufus mine --ai`. Default: `smart` if configured, else the default provider. */
  provider?: string;
  /** Your own intent buckets (first match wins). Replaces the built-in ones. `pattern` is a case-insensitive regex. */
  buckets?: Array<{ id: string; label?: string; pattern: string }>;
  /** Fewest pairs before rules are proposed (default 10). */
  minPairs?: number;
  /** Share of replies a rule must hold for, 0-1 (default 0.9). */
  minShare?: number;
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
}
