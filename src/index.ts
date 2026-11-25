export { defineFlow, isFlow } from './engine/flow';
export { Engine, type EngineOptions } from './engine/engine';
export { AiVerificationError } from './engine/ai';
export { summarizeSpectrum, formatSpectrum, spectrumOf, addSpectrum, emptySpectrum } from './engine/spectrum';
export { GeminiProvider, type GeminiConfig } from './providers/gemini';
export { FakeProvider, OpenAiCompatibleProvider, CommandProvider, createProvider, createProviders, pickProvider, DEFAULT_PROVIDER } from './engine/providers';
export { FileStore } from './store';
export { CaseStore, captureCase, formatExamples, type ReplayCase } from './learning/cases';
export { compareFlow, formatCompare, type CompareOptions, type CompareReport, type CompareArm, type CompareCaseResult } from './learning/compare';
export { ChiefOfStaff, type ChiefCommand, type ChiefOfStaffOptions, type ChiefReply } from './chief/chief';
export { replayFlow, replayScope, goldenSample, type ReplayOptions, type ReplayReport, type ReplayCaseResult, type ScopedReplayOptions, type ScopedReplayReport } from './learning/replay';
export { proposeLesson, type ProposeInput, type ProposeOptions, type ProposeResult } from './learning/propose';
export { suggestLayer, type LessonLayer, type LayerSuggestion } from './learning/layers';
export { Scheduler, type TickResult, type TickStatus } from './scheduler/scheduler';
export { at, every, onEvent, isQuiet, type Trigger, type TriggerContext, type TriggerOptions, type QuietHours } from './scheduler/triggers';
export { LessonStore, LessonCapError, MAX_LESSONS_PER_SCOPE, scopes, describeTension, type Lesson, type LessonEvidence, type LessonStoreOptions } from './learning/lessons';
export { formatCardAsText, parseTextReply, PlainTextChannel, type ChannelAdapter } from './channels/text';
export type * from './types';
export { CardBridge, type CardBridgeOptions, type IncomingMessage, type LiveChannel, type TickReport } from './channels/bridge';
export { BeeperChannel, BeeperOfflineError, BeeperApiError, createBeeperChannel, resolveBeeperOptions, type BeeperOptions } from './channels/beeper';
export { TelegramChannel, TelegramOfflineError, TelegramApiError, createTelegramChannel, resolveTelegramOptions, type TelegramOptions } from './channels/telegram';
export { selectChannel, configuredChannels, type ChannelName } from './channels/select';
export { extractPairsFromMessages, extractHistoryFromMessages, cleanText, type HistoryMessage, type ExtractOptions, type ExtractResult, type ReplyHabit } from './history/extract';
export { noiseKind, pairNoiseKind, type NoiseKind, type NoiseCounts } from './history/noise';
export { pairHash, normalizePair, type HistoryPair, type PriorMessage } from './history/types';
export {
  buildContactProfiles,
  buildSituationalContext,
  incomingFeatures,
  greetDecision,
  lengthDecision,
  questionCount,
  type IncomingFeatures,
  type GreetHint,
  type LengthBand,
  closenessTier,
  tierBySender,
  styleOf,
  describeStyle,
  rhythmFromGap,
  rhythmOf,
  chatKindOf,
  DEFAULT_TIER_THRESHOLDS,
  type ClosenessTier,
  type Rhythm,
  type ChatKind,
  type StyleSlice,
  type ContactProfile,
  type ContactProfiles,
  type ProfileOptions,
  type TierThresholds,
  type SituationInput,
  type SituationalContext,
  type SituationOptions,
  type SituationExample,
  type StyleBasis,
} from './history/profiles';
export { seedHistory, formatSeed, loadPairs, caseFromPair, parseHistoryText, type SeedOptions, type SeedReport, type HistoryInput } from './history/seed';
export {
  analyzeHistory,
  formatAnalysis,
  formatContext,
  situationalRules,
  situationalAnalysis,
  type ContextBreakdown,
  mineHistory,
  formatMine,
  synthesizeHistory,
  representativeSample,
  proposeCommand,
  defaultMineProvider,
  bucketsFromConfig,
  classify,
  DEFAULT_BUCKETS,
  type AnalyzeOptions,
  type HistoryAnalysis,
  type VoiceFingerprint,
  type CandidateRule,
  type IntentBucket,
  type IntentCluster,
  type MineOptions,
  type MineReport,
  type Synthesis,
  type WorkflowBlueprint,
  type CandidateLesson,
} from './history/mine';
export { evaluateHoldout, splitHoldout, formatHoldout, invariantHolds, type HoldoutEvaluation, type HoldoutResult, type HoldoutOptions, type HoldoutSplit } from './history/eval';
export { conditionalAnalysis, describeTrigger, DEFAULT_CONTRAST, FEATURE_LABELS, LONG_REPLY_WORDS, type ConditionalRule, type ContrastOptions, type Trigger as ConditionalTrigger, type FeatureId, type BehaviorId } from './history/contrast';
export { DEFAULT_HALF_LIFE_DAYS, DEFAULT_HALF_LIFE_OBSERVATIONS, pairWeigher, type WeightOptions, type IdealOverride } from './history/profiles';
export { detectLessonDrift, lessonEvidence, tensionMessage, checksForRule, idealConstraints, type DriftOptions, type LessonDrift, type LessonInput, type LessonCheck, type IdealConstraints } from './history/ideals';
export type { RecencyReport } from './history/mine';
export { recencyWeight, rankWeights, resolveHalfLife, resolveRecencyMode, type RecencyMode, type RecencyOptions } from './recency';
export {
  ADAPTERS,
  CorpusStore,
  GENERIC_MAIL_DOMAINS,
  aiPromptsAdapter,
  cleanPromptText,
  humanPrompts,
  tagPrompt,
  browserAdapter,
  buildCorpusSummary,
  isAutomatedSender,
  projectFolderOf,
  GENERIC_FOLDERS,
  DEFAULT_CORPUS_HALF_LIFE_OBSERVATIONS,
  calendarAdapter,
  categoryOfDomain,
  collectInto,
  corpusItemsFromPairs,
  emailAdapter,
  filesAdapter,
  formatCorpusSummary,
  formatHits,
  getAdapter,
  normalizeItem,
  queryCorpus,
  type AddReport,
  type AiPromptsOptions,
  type PromptKind,
  type BrowserOptions,
  type CalendarOptions,
  type CollectOptions,
  type CollectResult,
  type CorpusHit,
  type CorpusItem,
  type CorpusSummary,
  type AutomatedSender,
  type DomainActivity,
  type EmailOptions,
  type FilesOptions,
  type QueryOptions,
  type RecurringCommitment,
  type SourceAdapter,
  type SourceVolume,
  type SummaryOptions,
  type UpcomingCommitment,
} from './corpus';
