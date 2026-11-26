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
}

export interface ScriptContext {
  workspaceDir: string;
  now: Date;
  callTool: (readOnlyId: string, input?: Record<string, unknown>) => Promise<Receipt>;
  env: Record<string, string | undefined>;
}

export type EventSource = 'message' | 'email' | 'calendar' | 'browser' | 'file' | 'system' | (string & {});

export interface EventReaction {
  emoji: string;
  actor?: string;
  at?: string;
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
  metadata?: Record<string, unknown>;
}

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
}

export interface ModelRequest {
  system: string;
  prompt: string;
  model?: string;
}

export interface ModelProvider {
  readonly name: string;
  complete(req: ModelRequest): Promise<string>;
}

export interface RpgAction {
  toolId: string;
  input: Record<string, unknown>;
  thought?: string;
}

export interface RpgWakeReport {
  triggerEventId?: string;
  turns: number;
  receipts: Receipt[];
  sentMessages: string[];
  pendingApprovals: Array<{ toolId: string; input: Record<string, unknown>; receipt: Receipt }>;
  slept: boolean;
  sleepReason?: string;
  acted: boolean;
}

export interface MessageSink {
  send(text: string): Promise<{ messageId?: string } | void>;
  edit?(messageId: string, text: string): Promise<void>;
  react?(messageId: string, emoji: string | null): Promise<void>;
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
