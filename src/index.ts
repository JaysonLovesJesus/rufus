export type * from './types';
export { hashEmbed, normalize, cosineSimilarity, createLocalEmbedder, topKBySimilarity, type Embedder, type Vector } from './embed';
export {
  validateManifest,
  validateInput,
  executeScript,
  readToolStats,
  recordToolStats,
  MANIFEST_FILE,
  RUN_FILE,
  TEST_FILE,
  STATS_FILE,
  BROKEN_FAILURE_THRESHOLD,
} from './scripts/standard';
export { ToolRegistry, type RegisteredTool } from './scripts/registry';
export { registerBuiltins, type BuiltinDeps } from './scripts/builtins';
export { ApprovalStore, type TrustLevel, type TrustTable, type PendingApproval } from './scripts/approvals';
export { GapStore, type Gap, type GapSource, type GapStatus } from './gaps/store';
export { WatchStore, watchConnector, type WatchItem } from './events/watches';
export { loadBrainSkill, runInvestigateBrain, runPlanBrain, runCreateBrain, runVerifyBrain, type BrainStateName } from './brains/states';
export { verifySpokenReply, normalizeMultiline, renderWithSpeaker } from './speaker/speaker';
export { parseRpgAction, runRpgWake, type RpgWakeOptions } from './rpg/loop';
export { EventStore } from './events/store';
export { messageEvent, genericEvent } from './events/ingest';
export {
  HeartbeatHub,
  beeperConnector,
  gmailConnector,
  calendarConnector,
  loadCustomConnectors,
  buildDefaultConnectors,
  type EventConnector,
} from './events/connectors';
export { startEventWebhook, type WebhookOptions } from './events/webhook';
export { Bouncer } from './bouncer/bouncer';
export { ClaudeCliProvider, FakeProvider } from './providers/claude';
export { RufusCore, type DaemonOptions, type ProcessEventResult } from './daemon';
export { TelegramChannel, type TelegramConfig } from './channels/telegram';
export {
  recordWake,
  loadWakes,
  computeScorecard,
  formatScorecard,
  runJudgmentEval,
  type WakeRecord,
  type OutcomeScorecard,
  type JudgmentEvalCase,
  type JudgmentEvalReport,
} from './eval/flight-recorder';
