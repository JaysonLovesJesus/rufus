import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BouncerDecision, LosslessEvent, MessageSink, ModelProvider, Receipt, RpgWakeReport } from './types';
import { Bouncer } from './bouncer/bouncer';
import { wakeForApproval, wakeForSentText } from './bouncer/training';
import { SenseJudge } from './bouncer/sensing';
import { createTriage } from './bouncer/triage';
import { createLocalEmbedder, createSemanticEmbedder } from './embed';
import { meterProvider, recordWake, type WakeModelCall } from './eval/flight-recorder';
import { appendRotating } from './eval/ops-log';
import { genericEvent } from './events/ingest';
import { registerMemoryTools } from './events/memory-tools';
import { EventStore, provenanceOf } from './events/store';
import { WatchStore } from './events/watches';
import { GapStore } from './gaps/store';
import { CreditTracker, isRateLimitError } from './providers/credits';
import { FallbackProvider } from './providers/fallback';
import { runRpgWake } from './rpg/loop';
import { handleZeroAiMessage } from './rpg/zero-ai';
import { ApprovalStore } from './scripts/approvals';
import { registerBuiltins } from './scripts/builtins';
import { loadMcpConfigs, registerMcpTools, type McpBridgeHandle } from './scripts/mcp-bridge';
import { ToolRegistry } from './scripts/registry';
import type { SpeakerWakeContext } from './speaker/speaker';

/** A restart is new reality like any other event. */
export const STARTUP_TEXT =
  'Rufus just restarted (system.startup_snapshot shows what changed). New reality: if the owner would want to know an update landed, that is a small gap. Tell him in one line what he will notice, in his words, not code terms, and never an update the conversation shows he was already told about. Then work the gap tree as usual.';

/** `decisions.jsonl` moves to `decisions.1.jsonl` past this size (the dashboard reads at most the last 16 MB anyway). */
const DECISIONS_LOG_MAX_BYTES = 20 * 1024 * 1024;

export interface DaemonOptions {
  workspaceDir: string;
  reasoningProvider: ModelProvider;
  speakerProvider: ModelProvider;
  reasoningModel?: string;
  speakerModel?: string;
  sink: MessageSink;
  pythonPath?: string;
  /** Shadow mode: runs Bouncer + RPG loop and logs decisions to shadow.jsonl without sending to the real sink. */
  shadow?: boolean;
  maxTurnsPerWake?: number;
  now?: () => Date;
  /** A cheap model (e.g. haiku) that makes the first call when the Bouncer is unsure, and re-checks what it slept on. */
  triageProvider?: ModelProvider;
  triageModel?: string;
}

export interface ProcessEventResult {
  event: LosslessEvent;
  decision: BouncerDecision;
  wake?: RpgWakeReport;
  shadowLogged?: boolean;
  /** The event was already in the log, so it was not handled again. */
  alreadySeen?: boolean;
}

export interface ProcessEventOptions {
  /** Drains owner input that arrived while the wake runs (the shared inbox). */
  pollIncoming?: () => Promise<LosslessEvent[]>;
  additionalEvents?: LosslessEvent[];
  sinkOverride?: MessageSink;
  /** Set when `sense()` already logged the event and ran the Bouncer. */
  decision?: BouncerDecision;
}

/**
 * Unified 24/7 Heartbeat Engine:
 * Waiting Mode ($0 Bouncer) <-> Awake Mode (Text-Based RPG Loop) + automatic SetFit training feedback.
 */
interface LiveWake {
  status: 'awake';
  wakeId: string;
  startedAt: string;
  updatedAt?: string;
  trigger: { id: string; source: string; kind: string; text: string };
  decision: unknown;
  turns: unknown[];
}

export class RufusCore {
  readonly workspaceDir: string;
  readonly events: EventStore;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalStore;
  readonly gaps: GapStore;
  readonly watches: WatchStore;
  readonly credits: CreditTracker;
  readonly bouncer: Bouncer;
  /** Gap and reply-habit features, the cheap model's first call, and the re-check of slept events. */
  readonly senseJudge: SenseJudge;
  private readonly triageProvider: ModelProvider | undefined;
  readonly shadow: boolean;
  private readonly rawReasoningProvider: ModelProvider;
  private readonly reasoningProvider: ModelProvider;
  private readonly speakerProvider: ModelProvider;
  private readonly reasoningModel?: string;
  private readonly speakerModel?: string;
  private readonly realSink: MessageSink;
  private readonly maxTurnsPerWake: number;
  private readonly now: () => Date;
  private wakeReceipts: Receipt[] = [];
  private wakeModelCalls: WakeModelCall[] = [];
  private wakeTurn = 1;
  private mcpBridge?: McpBridgeHandle;
  private wakeContext?: SpeakerWakeContext;
  private activeSink?: MessageSink;
  private wakeQueue: Promise<unknown> = Promise.resolve();
  private newBouncerExamples = 0;
  private retraining = false;
  private initializing?: Promise<{ loadedTools: string[]; toolErrors: string[] }>;

  constructor(opts: DaemonOptions) {
    this.workspaceDir = opts.workspaceDir;
    const embedder = opts.pythonPath ? createSemanticEmbedder({ pythonPath: opts.pythonPath }) : undefined;
    this.events = new EventStore({ workspaceDir: opts.workspaceDir, ...(embedder ? { embedder } : {}) });
    this.registry = new ToolRegistry({ toolsDir: path.join(opts.workspaceDir, 'tools') });
    this.approvals = new ApprovalStore(opts.workspaceDir);
    this.gaps = new GapStore(opts.workspaceDir);
    this.watches = new WatchStore(opts.workspaceDir);
    this.credits = new CreditTracker(opts.workspaceDir);
    this.rawReasoningProvider = opts.reasoningProvider;
    this.bouncer = new Bouncer({
      workspaceDir: opts.workspaceDir,
      ...(opts.pythonPath ? { pythonPath: opts.pythonPath } : {}),
    });
    this.senseJudge = new SenseJudge({
      workspaceDir: opts.workspaceDir,
      bouncer: this.bouncer,
      gaps: this.gaps,
      events: this.events,
      // Shares the memory's sidecar, so gap closeness is measured in the same space as memory search.
      embedder: embedder ?? createLocalEmbedder(),
      ...(opts.triageProvider
        ? { triage: createTriage({ provider: opts.triageProvider, ...(opts.triageModel ? { model: opts.triageModel } : {}), gaps: () => this.gaps.list() }) }
        : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.triageProvider = opts.triageProvider;
    this.shadow = opts.shadow === true;
    // Every model call is metered into the current wake's trace (usage, cost, latency, failures).
    const onCall = (c: Omit<WakeModelCall, 'turn'>) => this.wakeModelCalls.push({ ...c, turn: this.wakeTurn });
    this.reasoningProvider = meterProvider(opts.reasoningProvider, onCall);
    this.speakerProvider = meterProvider(opts.speakerProvider, onCall);
    if (opts.reasoningModel) this.reasoningModel = opts.reasoningModel;
    if (opts.speakerModel) this.speakerModel = opts.speakerModel;
    this.realSink = opts.sink;
    this.maxTurnsPerWake = opts.maxTurnsPerWake ?? 25;
    this.now = opts.now ?? (() => new Date());
  }

  /** Loads everything once; a concurrent caller waits for the same load instead of running on a half-loaded core. */
  init(): Promise<{ loadedTools: string[]; toolErrors: string[] }> {
    this.initializing ??= this.initOnce();
    return this.initializing;
  }

  private async initOnce(): Promise<{ loadedTools: string[]; toolErrors: string[] }> {
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await this.events.load();
    await this.bouncer.load();
    await this.gaps.ensureRoot();

    const sink: MessageSink = this.shadow
      ? {
          send: async (text) => {
            await fs.appendFile(
              path.join(this.workspaceDir, 'shadow.jsonl'),
              `${JSON.stringify({ at: this.now().toISOString(), kind: 'shadow_send', text })}\n`,
              'utf8',
            );
          },
        }
      : this.realSink;

    await registerBuiltins({
      registry: this.registry,
      approvals: this.approvals,
      gaps: this.gaps,
      watches: this.watches,
      brainProvider: this.reasoningProvider,
      ...(this.reasoningModel ? { brainModel: this.reasoningModel } : {}),
      speakerProvider: this.speakerProvider,
      ...(this.speakerModel ? { speakerModel: this.speakerModel } : {}),
      sink,
      getActiveSink: () => this.activeSink ?? sink,
      getWakeReceipts: () => this.wakeReceipts,
      getWakeContext: () => this.wakeContext,
      onSent: async (text, messageId) => {
        // The channel's messageId travels with the logged message, so edits and the Desk can point at it.
        await this.events.append(
          genericEvent({ source: 'message', kind: 'assistant_sent', actor: 'rufus', text, timestamp: this.now().toISOString(), ...(messageId ? { metadata: { messageId } } : {}) }),
        );
      },
      onEdited: async (messageId, text) => {
        const sent = (await this.events.recent(5000)).filter((e) => e.kind === 'assistant_sent' && String(e.metadata?.messageId ?? '') === messageId).pop();
        if (sent) await this.events.update(sent.id, { text, metadata: { editedAt: this.now().toISOString(), ...(sent.metadata?.originalText ? {} : { originalText: sent.text }) } });
      },
      messageAuthor: async (messageId) => {
        const hit = (await this.events.recent(5000)).filter((e) => e.source === 'message' && String(e.metadata?.messageId ?? '') === messageId).pop();
        return hit ? (hit.kind === 'assistant_sent' ? 'rufus' : hit.kind === 'owner_direct' ? 'owner' : undefined) : undefined;
      },
      similarity: (query, texts) => this.events.similarity(query, texts),
      // The owner's yes or no is his verdict on the wake that drafted it, so it labels that wake's trigger event.
      onApprovalDecision: async (decision, _toolId, approvalId) => {
        const wake = approvalId ? await wakeForApproval(this.workspaceDir, approvalId) : undefined;
        if (wake) await this.labelTrigger(wake.trigger.id, decision === 'approved' ? 'approval' : 'pushback');
      },
      searchMemory: (query, searchOpts) =>
        this.events.search(query, searchOpts?.limit ?? 8, {
          ...(searchOpts?.source ? { source: searchOpts.source } : {}),
        }),
      onSleep: () => undefined,
      // Starts with the owner's message that opened the gap (just before it was created), so the owner's own words travel with it.
      getConversationSince: async (iso) => {
        const chat = (await this.events.recent(5000)).filter((e) => e.source === 'message' && (e.kind === 'owner_direct' || e.kind === 'assistant_sent'));
        // The owner's request can span several messages sent just before the gap was saved.
        const windowStart = new Date(Date.parse(iso) - 15 * 60_000).toISOString();
        const before = chat.filter((e) => e.timestamp < iso);
        const lastOwner = before.filter((e) => e.kind === 'owner_direct').pop();
        const openers = before.filter((e) => e.kind === 'owner_direct' && e.timestamp >= windowStart).slice(-3);
        const lead = openers.length ? openers : lastOwner ? [lastOwner] : [];
        return [...lead, ...chat.filter((e) => e.timestamp >= iso)].map(
          // The owner's words are evidence; Rufus's messages are claims (they prove only that they were sent).
          (e) => `- [${e.timestamp}] ${e.kind === 'assistant_sent' ? 'Rufus (claim)' : 'Owner (evidence)'}: ${e.text}`,
        );
      },
    });
    await registerMemoryTools({ registry: this.registry, events: this.events, getWakeContext: () => this.wakeContext });
    const disk = await this.registry.loadFromDisk();
    if (!/^(0|off|false|no)$/i.test(process.env.RUFUS_MCP ?? '')) {
      const mcpServers = await loadMcpConfigs(this.workspaceDir);
      if (Object.keys(mcpServers).length) {
        this.mcpBridge = await registerMcpTools({ registry: this.registry, servers: mcpServers });
      }
    }
    return { loadedTools: disk.loaded, toolErrors: disk.errors };
  }

  /** `live.json`: the wake in progress, turn by turn (or `asleep`). Written atomically; read by the dashboard. */
  private liveWrites: Promise<void> = Promise.resolve();
  private writeLive(state: Record<string, unknown> | LiveWake): Promise<void> {
    // Serialized, so a late turn update can never land after the final `asleep`.
    const text = JSON.stringify(state);
    const file = path.join(this.workspaceDir, 'live.json');
    const tmp = `${file}.${process.pid}.tmp`;
    this.liveWrites = this.liveWrites.then(() =>
      fs
        .writeFile(tmp, text, 'utf8')
        .then(() => fs.rename(tmp, file))
        .catch(() => undefined),
    );
    return this.liveWrites;
  }

  /** Processes one incoming event through the Bouncer and RPG loop (strictly serialized: ONE wake at a time). */
  async processEvent(event: LosslessEvent, opts: ProcessEventOptions = {}): Promise<ProcessEventResult> {
    const run = () => this.processEventSerial(event, opts);
    const next = this.wakeQueue.then(run, run);
    this.wakeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Senses one event without waiting for any wake: logs it and runs the Bouncer.
   * Returns undefined when the event was already seen, so it is never handled twice.
   */
  async sense(event: LosslessEvent): Promise<BouncerDecision | undefined> {
    await this.init();
    if (await this.events.has(event.id)) return undefined;
    // Gap and reply-habit features go into the logged event, so training later reads exactly what the Bouncer saw.
    const { event: seen, look } = await this.senseJudge.prepare(event);
    if (!(await this.events.append(seen))) return undefined;
    return this.judge(seen, look);
  }

  private async judge(event: LosslessEvent, look?: Awaited<ReturnType<SenseJudge['prepare']>>['look']): Promise<BouncerDecision> {
    const decision = await this.senseJudge.judge(event, look);
    // Every bouncer call is logged (WAKE and SLEEP), so the dashboard can show what Rufus sensed and what he let through.
    // One line per sensed event adds up, so the log rotates to decisions.1.jsonl past its cap.
    await appendRotating(
      path.join(this.workspaceDir, 'decisions.jsonl'),
      `${JSON.stringify({ at: this.now().toISOString(), eventId: event.id, source: event.source, kind: event.kind, text: event.text.slice(0, 200), ...decision })}\n`,
      DECISIONS_LOG_MAX_BYTES,
    ).catch(() => undefined);
    if (decision.label === 'SLEEP' && this.shadow) {
      await fs.appendFile(
        path.join(this.workspaceDir, 'shadow.jsonl'),
        `${JSON.stringify({ at: this.now().toISOString(), eventId: event.id, decision })}\n`,
        'utf8',
      );
    }
    return decision;
  }

  private async processEventSerial(event: LosslessEvent, opts: ProcessEventOptions = {}): Promise<ProcessEventResult> {
    await this.init();
    // A sensed event (opts.decision) is already in the log, features and all; anything else is prepared the same way first.
    const prepared = opts.decision || (await this.events.has(event.id)) ? undefined : await this.senseJudge.prepare(event);
    if (prepared) event = prepared.event;
    const fresh = opts.decision ? true : await this.events.append(event);
    for (const extra of opts.additionalEvents ?? []) await this.events.append(extra);
    if (!fresh) {
      return { event, decision: { label: 'SLEEP', confidence: 1, backend: 'rule', reason: 'already seen', durationMs: 0 }, alreadySeen: true };
    }
    if (opts.decision) event = (await this.events.get(event.id)) ?? event;
    const decision = opts.decision ?? (await this.judge(event, prepared?.look));

    if (decision.label === 'SLEEP') {
      return { event, decision, ...(this.shadow ? { shadowLogged: true } : {}) };
    }

    this.wakeReceipts = [];
    this.wakeModelCalls = [];
    this.wakeTurn = 1;
    this.wakeContext = { trigger: event, arrivals: opts.additionalEvents ?? [] };
    this.activeSink = opts.sinkOverride;
    // The owner's own message on the real channel (not shadow, not voice), so it can be marked read.
    const msgId =!this.shadow && !opts.sinkOverride && event.metadata?.messageId !== undefined ? String(event.metadata.messageId) : undefined;
    // Best-effort, non-blocking read receipt for the owner's own incoming message (never delays or fails the wake)
    if (msgId && event.kind === 'owner_direct' && this.realSink.markRead) {
      const chatId = event.metadata?.chatId !== undefined ? String(event.metadata.chatId) : '';
      const sink = this.realSink;
      void Promise.resolve()
        .then(() => sink.markRead!(chatId, msgId))
        .catch((err) => console.error(`markRead failed for message ${msgId}: ${err instanceof Error ? err.message : String(err)}`));
    }
    let wake: RpgWakeReport;
    let live: LiveWake | undefined;
    try {
      wake = await runRpgWake({
        workspaceDir: this.workspaceDir,
        trigger: event,
        reasoningProvider: this.reasoningProvider,
        ...(this.reasoningModel ? { reasoningModel: this.reasoningModel } : {}),
        registry: this.registry,
        events: this.events,
        approvals: this.approvals,
        gaps: this.gaps,
        watches: this.watches,
        maxTurns: this.maxTurnsPerWake,
        now: this.now,
        getCreditsLine: async () => {
          const fb = this.rawReasoningProvider instanceof FallbackProvider ? this.rawReasoningProvider : undefined;
          return this.credits.formatForDesk({
            activeProvider: fb ? fb.activeProviderName() : this.rawReasoningProvider.name,
            primaryProvider: fb ? fb.primaryProviderName() : this.rawReasoningProvider.name,
            ...(fb ? { backups: fb.backupNames() } : {}),
            now: this.now(),
          });
        },
        onReceipt: (r) => this.wakeReceipts.push(r),
        onWakeStart: (wakeId) => {
          live = { status: 'awake', wakeId, startedAt: this.now().toISOString(), trigger: { id: event.id, source: event.source, kind: event.kind, text: event.text.slice(0, 500) }, decision, turns: [] };
          void this.writeLive(live);
        },
        onTurn: (t) => {
          this.wakeTurn = t.turn + 1;
          if (!live) return;
          live.turns.push(t);
          live.updatedAt = this.now().toISOString();
          void this.writeLive(live);
        },
        onWakeContext: (ctx) => {
          this.wakeContext = ctx;
        },
        ...(opts.pollIncoming ? { pollIncoming: opts.pollIncoming } : {}),
        ...(opts.additionalEvents?.length ? { additionalEvents: opts.additionalEvents } : {}),
      });
    } catch (err) {
      // A crashed wake still leaves a flight record: its partial trace and why it ended.
      const partial = (err as { wakeReport?: RpgWakeReport }).wakeReport;
      if (partial) {
        await recordWake(this.workspaceDir, {
          wakeId: partial.wakeId,
          at: this.now().toISOString(),
          trigger: { id: event.id, source: event.source, kind: event.kind, ...(event.actor ? { actor: event.actor } : {}), text: event.text },
          decision,
          turns: partial.turns,
          durationMs: partial.durationMs,
          acted: partial.acted,
          slept: false,
          endReason: 'crashed',
          ...(partial.error ? { error: partial.error } : {}),
          sentMessages: partial.sentMessages,
          trace: partial.trace,
          modelCalls: this.wakeModelCalls,
          // A crashed wake still spent what its model calls cost.
          costUsd: Number(this.wakeModelCalls.reduce((s, c) => s + (c.costUsd ?? 0), 0).toFixed(6)),
        }).catch(() => undefined);
      }
      // If every model failed/hit its limit on a direct owner message, answer in natural language via pure code ($0).
      const errMsg = err instanceof Error ? err.message : String(err);
      if (event.kind === 'owner_direct' && (/All providers failed/i.test(errMsg) || isRateLimitError(errMsg))) {
        const fb = this.rawReasoningProvider instanceof FallbackProvider ? this.rawReasoningProvider : undefined;
        const primary = fb ? fb.primaryProviderName() : this.rawReasoningProvider.name;
        if (isRateLimitError(errMsg)) await this.credits.recordLimit(primary, errMsg, this.now()).catch(() => undefined);
        const reply = await handleZeroAiMessage(event.text, {
          workspaceDir: this.workspaceDir,
          registry: this.registry,
          gaps: this.gaps,
          approvals: this.approvals,
          credits: this.credits,
          primaryProvider: primary,
          now: this.now,
        }).catch(() => undefined);
        if (reply && !this.shadow) {
          const active = this.activeSink ?? this.realSink;
          await active.send(reply.text).catch(() => undefined);
        }
      }
      throw err;
    } finally {
      this.activeSink = undefined;
      this.wakeContext = undefined;
      await this.writeLive({ status: 'asleep', ...(live ? { wakeId: live.wakeId, startedAt: live.startedAt } : {}), endedAt: this.now().toISOString() });
    }

    // Record full RPG Flight Recorder transcript (`wakes.jsonl`)
    await recordWake(this.workspaceDir, {
      wakeId: wake.wakeId,
      at: this.now().toISOString(),
      trigger: { id: event.id, source: event.source, kind: event.kind, ...(event.actor ? { actor: event.actor } : {}), text: event.text },
      decision,
      turns: wake.turns,
      durationMs: wake.durationMs,
      acted: wake.acted,
      slept: wake.slept,
      ...(wake.sleepReason ? { sleepReason: wake.sleepReason } : {}),
      ...(wake.endReason ? { endReason: wake.endReason } : {}),
      sentMessages: wake.sentMessages,
      trace: wake.trace,
      modelCalls: this.wakeModelCalls,
      costUsd: Number(this.wakeModelCalls.reduce((s, c) => s + (c.costUsd ?? 0), 0).toFixed(6)),
    }).catch(() => undefined);

    // Also record Rufus's own real actions into Event Log so long-term semantic recall remembers what he did
    const nonChatActions = wake.trace
      .filter((t) => t.receipt.status === 'ok' && t.toolId !== 'sleep' && t.toolId !== 'send_message' && t.toolId !== 'edit_message')
      .map((t) => `${t.toolId}: ${t.receipt.summary}`);
    if (nonChatActions.length) {
      await this.events
        .append(
          genericEvent({
            id: `self_${wake.wakeId}`,
            source: 'self',
            kind: 'actions',
            actor: 'rufus',
            text: nonChatActions.join(' | ').slice(0, 600),
            timestamp: this.now().toISOString(),
          }),
        )
        .catch(() => undefined);
    }

    // Automatic teacher->student label logging for SetFit + periodic non-blocking auto-retrain
    if (event.source !== 'system' && event.kind !== 'owner_direct' && event.source !== 'watch') {
      const featureText = Bouncer.eventToFeatureText(event);
      await this.bouncer.recordExample({
        text: featureText,
        label: wake.acted ? 'WAKE' : 'SLEEP',
        source: wake.acted ? 'opus_acted' : 'opus_sleep',
        at: this.now().toISOString(),
        eventId: event.id,
      });
      this.newBouncerExamples++;
      if (this.newBouncerExamples >= 40 && !this.retraining) {
        this.newBouncerExamples = 0;
        this.retraining = true;
        void this.bouncer
          .trainSetFit({ epochs: 1 })
          .catch(() => undefined)
          .finally(() => {
            this.retraining = false;
          });
      }
    }

    if (this.shadow) {
      await fs.appendFile(
        path.join(this.workspaceDir, 'shadow.jsonl'),
        `${JSON.stringify({ at: this.now().toISOString(), eventId: event.id, decision, turns: wake.turns, acted: wake.acted, sent: wake.sentMessages })}\n`,
        'utf8',
      );
    }

    return { event, decision, wake, ...(this.shadow ? { shadowLogged: true } : {}) };
  }

  /** Records explicit human feedback (pushback/skip -> SLEEP, approval -> WAKE) for SetFit retraining. */
  async recordFeedback(event: LosslessEvent, feedback: 'pushback' | 'skip' | 'approval'): Promise<void> {
    await this.init();
    if (provenanceOf(event) !== 'rufus_claimed') return this.labelTrigger(event.id, feedback, event);
    // Feedback on one of Rufus's own messages is about the wake that sent it; pushback also means the claim no longer stands.
    if (feedback === 'pushback') await this.events.supersede(event.id, 'owner:pushback', { at: this.now().toISOString() });
    const wake = await wakeForSentText(this.workspaceDir, event.text);
    if (wake) await this.labelTrigger(wake.trigger.id, feedback);
  }

  /** An owner signal about the event that woke Rufus; it overrides Rufus's own label for that event at training time. */
  private async labelTrigger(eventId: string, feedback: 'pushback' | 'skip' | 'approval', known?: LosslessEvent): Promise<void> {
    const event = known ?? (await this.events.get(eventId));
    // Events the Bouncer always wakes on by rule teach it nothing.
    if (!event || event.source === 'system' || event.source === 'watch' || event.kind === 'owner_direct') return;
    await this.bouncer.recordExample({
      text: Bouncer.eventToFeatureText(event),
      label: feedback === 'approval' ? 'WAKE' : 'SLEEP',
      source: feedback,
      at: this.now().toISOString(),
      eventId: event.id,
    });
  }

  /** A restart is just new reality, run through the same top-down loop as any other event. */
  async announceStartup(opts: ProcessEventOptions = {}): Promise<ProcessEventResult> {
    const ev = genericEvent({
      source: 'system',
      kind: 'startup',
      text: STARTUP_TEXT,
      timestamp: this.now().toISOString(),
    });
    return this.processEvent(ev, opts);
  }

  async close(): Promise<void> {
    this.mcpBridge?.close();
    await this.events.close();
    await this.bouncer.close();
    (this.reasoningProvider as { close?: () => void }).close?.();
    (this.speakerProvider as { close?: () => void }).close?.();
    (this.triageProvider as { close?: () => void } | undefined)?.close?.();
  }
}
