import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BouncerDecision, LosslessEvent, MessageSink, ModelProvider, Receipt, RpgWakeReport } from './types';
import { Bouncer } from './bouncer/bouncer';
import { createSemanticEmbedder } from './embed';
import { recordWake } from './eval/flight-recorder';
import { genericEvent } from './events/ingest';
import { EventStore } from './events/store';
import { runRpgWake } from './rpg/loop';
import { ApprovalStore } from './scripts/approvals';
import { registerBuiltins } from './scripts/builtins';
import { ToolRegistry } from './scripts/registry';
import type { SpeakerWakeContext } from './speaker/speaker';

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
}

export interface ProcessEventResult {
  event: LosslessEvent;
  decision: BouncerDecision;
  wake?: RpgWakeReport;
  shadowLogged?: boolean;
}

/**
 * Unified 24/7 Heartbeat Engine:
 * Waiting Mode ($0 Bouncer) <-> Awake Mode (Text-Based RPG Loop) + automatic SetFit training feedback.
 */
export class RufusCore {
  readonly workspaceDir: string;
  readonly events: EventStore;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalStore;
  readonly bouncer: Bouncer;
  readonly shadow: boolean;
  private readonly reasoningProvider: ModelProvider;
  private readonly speakerProvider: ModelProvider;
  private readonly reasoningModel?: string;
  private readonly speakerModel?: string;
  private readonly realSink: MessageSink;
  private readonly maxTurnsPerWake: number;
  private readonly now: () => Date;
  private wakeReceipts: Receipt[] = [];
  private wakeContext?: SpeakerWakeContext;
  private activeSink?: MessageSink;
  private wakeQueue: Promise<unknown> = Promise.resolve();
  private initialized = false;

  constructor(opts: DaemonOptions) {
    this.workspaceDir = opts.workspaceDir;
    const embedder = opts.pythonPath ? createSemanticEmbedder({ pythonPath: opts.pythonPath }) : undefined;
    this.events = new EventStore({ workspaceDir: opts.workspaceDir, ...(embedder ? { embedder } : {}) });
    this.registry = new ToolRegistry({ toolsDir: path.join(opts.workspaceDir, 'tools') });
    this.approvals = new ApprovalStore(opts.workspaceDir);
    this.bouncer = new Bouncer({
      workspaceDir: opts.workspaceDir,
      ...(opts.pythonPath ? { pythonPath: opts.pythonPath } : {}),
    });
    this.shadow = opts.shadow === true;
    this.reasoningProvider = opts.reasoningProvider;
    this.speakerProvider = opts.speakerProvider;
    if (opts.reasoningModel) this.reasoningModel = opts.reasoningModel;
    if (opts.speakerModel) this.speakerModel = opts.speakerModel;
    this.realSink = opts.sink;
    this.maxTurnsPerWake = opts.maxTurnsPerWake ?? 25;
    this.now = opts.now ?? (() => new Date());
  }

  async init(): Promise<{ loadedTools: string[]; toolErrors: string[] }> {
    if (this.initialized) return { loadedTools: [], toolErrors: [] };
    this.initialized = true;
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await this.events.load();
    await this.bouncer.load();

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
      speakerProvider: this.speakerProvider,
      ...(this.speakerModel ? { speakerModel: this.speakerModel } : {}),
      sink,
      getActiveSink: () => this.activeSink ?? sink,
      getWakeReceipts: () => this.wakeReceipts,
      getWakeContext: () => this.wakeContext,
      getRecentSent: async () =>
        (await this.events.recent(25))
          .filter((e) => e.source === 'message' && e.kind === 'assistant_sent')
          .slice(-4)
          .map((e) => e.text),
      onSent: (text) => {
        void this.events.append(
          genericEvent({ source: 'message', kind: 'assistant_sent', actor: 'rufus', text, timestamp: this.now().toISOString() }),
        );
      },
      onApprovalDecision: async (decision, toolId) => {
        await this.bouncer.recordExample({
          text: `approval:${toolId}`,
          label: decision === 'approved' ? 'WAKE' : 'SLEEP',
          source: decision === 'approved' ? 'approval' : 'pushback',
          at: this.now().toISOString(),
        });
      },
      searchMemory: (query, searchOpts) =>
        this.events.search(query, searchOpts?.limit ?? 8, {
          ...(searchOpts?.source ? { source: searchOpts.source } : {}),
        }),
      onSleep: () => undefined,
    });
    const disk = await this.registry.loadFromDisk();
    return { loadedTools: disk.loaded, toolErrors: disk.errors };
  }

  /** Processes one incoming event through the Bouncer and RPG loop (strictly serialized: ONE wake at a time). */
  async processEvent(
    event: LosslessEvent,
    opts: { pollIncoming?: () => Promise<LosslessEvent[]>; additionalEvents?: LosslessEvent[]; sinkOverride?: MessageSink } = {},
  ): Promise<ProcessEventResult> {
    const run = () => this.processEventSerial(event, opts);
    const next = this.wakeQueue.then(run, run);
    this.wakeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async processEventSerial(
    event: LosslessEvent,
    opts: { pollIncoming?: () => Promise<LosslessEvent[]>; additionalEvents?: LosslessEvent[]; sinkOverride?: MessageSink } = {},
  ): Promise<ProcessEventResult> {
    await this.init();
    await this.events.append(event);
    for (const extra of opts.additionalEvents ?? []) await this.events.append(extra);
    const decision = await this.bouncer.decide(event);

    if (decision.label === 'SLEEP') {
      if (this.shadow) {
        await fs.appendFile(
          path.join(this.workspaceDir, 'shadow.jsonl'),
          `${JSON.stringify({ at: this.now().toISOString(), eventId: event.id, decision })}\n`,
          'utf8',
        );
      }
      return { event, decision, ...(this.shadow ? { shadowLogged: true } : {}) };
    }

    this.wakeReceipts = [];
    this.wakeContext = { trigger: event, arrivals: opts.additionalEvents ?? [] };
    this.activeSink = opts.sinkOverride;
    // Instant $0 status reaction: ⚡ while awake & working, cleared when back to sleep (unless Rufus chose his own reaction)
    const msgId = !this.shadow && !opts.sinkOverride && event.metadata?.messageId !== undefined ? String(event.metadata.messageId) : undefined;
    if (msgId && this.realSink.react) {
      await this.realSink.react(msgId, '⚡').catch(() => undefined);
    }
    let wake: RpgWakeReport;
    try {
      wake = await runRpgWake({
        workspaceDir: this.workspaceDir,
        trigger: event,
        reasoningProvider: this.reasoningProvider,
        ...(this.reasoningModel ? { reasoningModel: this.reasoningModel } : {}),
        registry: this.registry,
        events: this.events,
        approvals: this.approvals,
        maxTurns: this.maxTurnsPerWake,
        now: this.now,
        onReceipt: (r) => this.wakeReceipts.push(r),
        onWakeContext: (ctx) => {
          this.wakeContext = ctx;
        },
        ...(opts.pollIncoming ? { pollIncoming: opts.pollIncoming } : {}),
        ...(opts.additionalEvents?.length ? { additionalEvents: opts.additionalEvents } : {}),
      });
    } finally {
      this.activeSink = undefined;
      this.wakeContext = undefined;
      const rufusReacted = this.wakeReceipts.some((r) => r.toolId === 'react_message' && r.status === 'ok');
      if (msgId && this.realSink.react && !rufusReacted) {
        await this.realSink.react(msgId, null).catch(() => undefined);
      }
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
      sentMessages: wake.sentMessages,
      trace: wake.trace,
    }).catch(() => undefined);

    // Automatic teacher->student label logging for SetFit (skip system startup events)
    if (event.source !== 'system' && event.kind !== 'owner_direct') {
      const featureText = Bouncer.eventToFeatureText(event);
      await this.bouncer.recordExample({
        text: featureText,
        label: wake.acted ? 'WAKE' : 'SLEEP',
        source: wake.acted ? 'opus_acted' : 'opus_sleep',
        at: this.now().toISOString(),
      });
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
    await this.bouncer.recordExample({
      text: Bouncer.eventToFeatureText(event),
      label: feedback === 'approval' ? 'WAKE' : 'SLEEP',
      source: feedback,
      at: this.now().toISOString(),
    });
  }

  /** Runs startup orientation through the exact same RPG + Haiku Speaker pipeline (no special-case hardcoding). */
  async announceStartup(): Promise<ProcessEventResult> {
    const ev = genericEvent({
      source: 'system',
      kind: 'startup',
      text: 'System just started. Run system.startup_snapshot and send a concise, natural orientation message via send_message, then sleep.',
      timestamp: this.now().toISOString(),
    });
    return this.processEvent(ev);
  }

  async close(): Promise<void> {
    await this.events.close();
    await this.bouncer.close();
    (this.reasoningProvider as { close?: () => void }).close?.();
    (this.speakerProvider as { close?: () => void }).close?.();
  }
}
