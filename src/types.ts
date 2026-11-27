/** Core types for Rufus v2 Core. */

export type ToolEffect = 'read' | 'write' | 'meta';

export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
}

export interface ToolManifest {
  id: string;
  version: number;
  description: string;
  whenToUse: string[];
  notWhen?: string[];
  effect: ToolEffect;
  requiresApproval: boolean;
  timeoutMs?: number;
  inputSchema: JsonSchema;
  exampleInput?: Record<string, unknown>;
}

export interface ScriptOutput {
  ok: boolean;
  summary: string;
  changes?: string[];
  data?: unknown;
  nextHints?: string[];
  error?: string;
  /** Async work this call started (e.g. a T3 thread); code ties it to the served gap as that gap's next move. */
  asyncWork?: AsyncWork;
}

export interface AsyncWork {
  kind: 't3_thread';
  threadId: string;
  label?: string;
}

export type ReceiptStatus = 'ok' | 'failed' | 'pending_approval' | 'invalid_input' | 'timed_out';

export interface Receipt {
  toolId: string;
  effect: ToolEffect;
  status: ReceiptStatus;
  durationMs: number;
  summary: string;
  changes: string[];
  data?: unknown;
  truncated?: boolean;
  error?: string;
  nextHints?: string[];
  brokenWarning?: string;
  asyncWork?: AsyncWork;
  at: string;
}

export interface ToolStats {
  runs: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  avgMs: number;
  lastUsedAt?: string;
  lastError?: string;
  /** The last few outcomes, oldest first (1 = ok, 0 = failed), for a recent success rate. */
  recent?: number[];
}

/** What fixed a failing call: the input that worked after the same tool and action failed. */
export interface ToolLesson {
  action?: string;
  error: string;
  failedInput: Record<string, unknown>;
  workingInput: Record<string, unknown>;
  at: string;
}

export interface ScriptContext {
  workspaceDir: string;
  now: Date;
  callTool: (readOnlyId: string, input?: Record<string, unknown>) => Promise<Receipt>;
  env: Record<string, string | undefined>;
  /** Aborts when the call's deadline passes; pass it to child processes and long waits. */
  signal?: AbortSignal;
  /** Epoch ms by which the call must finish. */
  deadline?: number;
  /** The wake and gap this call serves, when it comes from a wake. */
  wakeId?: string;
  gapId?: string;
}

export type EventSource = 'message' | 'email' | 'calendar' | 'browser' | 'file' | 'system' | (string & {});

export interface EventReaction {
  emoji: string;
  actor?: string;
  at?: string;
}

/** Who a message is from and who it was written to, so a message to the owner is never read as one to Rufus. */
export interface MessageAudience {
  from: string;
  /** `owner`: written to the owner; `rufus`: written to Rufus; `group`: a group chat the owner is in. */
  to: 'owner' | 'rufus' | 'group';
  direction: 'incoming' | 'outgoing';
  network: string;
  chatType: 'dm' | 'group';
  chatTitle?: string;
}

export interface LosslessEvent {
  id: string;
  source: EventSource;
  kind: string;
  timestamp: string;
  actor?: string;
  channel?: string;
  threadId?: string;
  text: string;
  deleted?: boolean;
  reactions?: EventReaction[];
  replyTo?: string;
  /** Set on message events: from whom, to whom, and in what chat. */
  audience?: MessageAudience;
  metadata?: Record<string, unknown>;
  /** Where the event came from; the store fills it in on append when a sense leaves it out. */
  provenance?: Provenance;
}

/** `observed` = sensed from the world, `owner_said` = the owner's own words, `rufus_claimed` = something Rufus said or did. */
export type Provenance = 'observed' | 'owner_said' | 'rufus_claimed';

export type BouncerLabel = 'SLEEP' | 'WAKE';

export interface BouncerDecision {
  label: BouncerLabel;
  confidence: number;
  backend: 'setfit' | 'prototype' | 'rule';
  reason?: string;
  durationMs: number;
}

export interface BouncerExample {
  text: string;
  label: BouncerLabel;
  source: 'seed' | 'pushback' | 'skip' | 'approval' | 'user_message' | 'opus_sleep' | 'opus_acted';
  at: string;
  /** The event this label is about, so a later owner signal on the same event can override it. */
  eventId?: string;
}

export interface ModelRequest {
  system: string;
  prompt: string;
  model?: string;
}

/** Usage, cost and latency of one model call, kept in the wake trace so `rufus stats` can report them. */
export interface ModelCallStats {
  model: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface ModelProvider {
  readonly name: string;
  complete(req: ModelRequest): Promise<string>;
  /** Optional: the same call, plus its usage and cost. */
  completeWithStats?(req: ModelRequest): Promise<{ text: string; stats: ModelCallStats }>;
}

/** A new desired state named inline by Decide; code saves it as a gap in the same step. */
export interface NewGapSpec {
  title: string;
  target: string;
  reality?: string;
  parentId?: string;
  /** `owner` when the owner asked for it, `observed` when Rufus spotted it. */
  source?: 'owner' | 'observed';
  /** When the owner wants it true by (ISO time), only when the owner's words give one. */
  due?: string;
}

export interface RpgAction {
  toolId: string;
  input: Record<string, unknown>;
  thought?: string;
  /** The gap this move serves: an existing gap id, or a new desired state. */
  gap?: string | NewGapSpec;
  /** Set when the model's reply could not be read as an action. */
  invalid?: string;
}

export interface RpgTurnTrace {
  turn: number;
  thought?: string;
  /** The gap this move served. */
  gapId?: string;
  toolId: string;
  input: Record<string, unknown>;
  receipt: Receipt;
}

export interface RpgWakeReport {
  wakeId: string;
  triggerEventId?: string;
  turns: number;
  durationMs: number;
  trace: RpgTurnTrace[];
  receipts: Receipt[];
  sentMessages: string[];
  pendingApprovals: Array<{ toolId: string; input: Record<string, unknown>; receipt: Receipt }>;
  slept: boolean;
  sleepReason?: string;
  acted: boolean;
  /** Why the wake ended: an accepted sleep, the turn cap, unreadable replies in a row, or a crash. */
  endReason?: WakeEndReason;
  /** The crash message, when the wake crashed. */
  error?: string;
}

export type WakeEndReason = 'slept' | 'turn_cap' | 'unreadable' | 'crashed';

export interface MessageSink {
  /** The owner-facing channel this sink writes to (e.g. "telegram", "voice"), so the Speaker knows where it is talking. */
  readonly channel?: string;
  send(text: string): Promise<{ messageId?: string } | void>;
  edit?(messageId: string, text: string): Promise<void>;
  react?(messageId: string, emoji: string | null): Promise<void>;
  /** Optional: mark an incoming message as read (best-effort; callers must tolerate failure). */
  markRead?(chatId: string, messageId: string): Promise<void>;
  /** Optional: show a typing indicator in a chat (defaults to the sink's own chat when chatId is omitted). */
  sendTyping?(chatId?: string): Promise<void>;
}

export interface CoreConfig {
  workspaceDir: string;
  reasoningModel?: string;
  speakerModel?: string;
  heartbeatMs?: number;
  maxTurnsPerWake?: number;
  topKTools?: number;
  topKContext?: number;
  bouncerPython?: string;
  telegram?: { token: string; chatId: string };
}
