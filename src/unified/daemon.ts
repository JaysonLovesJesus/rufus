import { createHash } from 'node:crypto';
import { CardBridge, type IncomingMessage, type LiveChannel, type TickReport } from '../channels/bridge';
import { loadAnchor, localDate, protectedNow, toMinutes } from '../anchor/anchor';
import { chiefActionHandler } from '../chief/actions';
import { ChiefOfStaff } from '../chief/chief';
import { appendChatTurns } from '../chief/history';
import { inboxSensor } from '../engine/loop-builtins';
import { ANCHOR_TOOL, anchorUpdateTool } from '../tools/anchor-tool';
import type { Engine } from '../engine/engine';
import { DEFAULT_PENDING_TTL_MS, type HumanDecision, type LoopRun, type LoopRunStatus, type LoopTickReport, type MasterLoop } from '../engine/loop';
import { assertActionType, type TrustMode, type Verdict } from '../engine/trust';
import { isExternalWriteTool } from '../tools/tools';
import { loadAudit } from './audit';
import { clip } from '../corpus/types';
import { REMEMBER_TOOL, rememberTool } from '../chief/learning';
import { draftOf, formatCheckin, formatLoopItem, isBareVerdict, parseLoopReply, recipientOf, refOf, type LoopReply } from './loop-text';
import { DEFAULT_REVIEW_AFTER, runSelfReview, type SelfReviewOptions } from './review';
import { freshThinkState, think, thinkSkipReason, type ThinkOptions } from './think';
import { acceptNudge, blocksToNudge, DEFAULT_LEAD_MINUTES, DEFAULT_QUIET_HOURS, formatMorningBrief, formatNudge, inQuietHours, isMorning, markNudged, nudgePrompt, phoneSignalHandler, type HeartbeatOptions } from './heartbeat';
import type { BlockKind, ScheduleBlock } from '../anchor/anchor';
import { loadSoul, scheduleNow } from '../soul/soul';
import { CALENDAR_TOOL, conflictKey, syncCalendarToAnchor, type CalendarSyncResult } from './calendar-sync';
import { loadPendingPlan, openGaps, proposeDayPlan, range12, savePendingPlan, type PlannerOptions } from './planner';
import { buildBreakDigest } from './digest';
import { speakableTitle } from './heartbeat';
import { nowSummary } from './now';
import { assignNumbers, loadStartState, saveStartState, takeCheckinRequest, type StartState } from './state';
import { cancelMission, formatMissionDelivery, isActiveMission, listMissions, loadMission, runMission, saveMission, type MissionRecord } from './missions';
import { MISSION_START_TOOL, missionTools } from '../tools/mission-tools';
import { PENDING_CLEAR_TOOL, pendingClearTool } from '../tools/pending-tool';
import { pruneHandledPendingItems } from '../engine/cross-verify';
import { parseAutonomyCommand, runAutonomyCommand } from './autonomy';
import { commandSynthesizer, resolveVoiceReplyMode, shouldSpeakReply, type Synthesizer } from '../channels/voice';
import type { TtsCommandConfig, VoiceReplyMode } from '../types';
import { loadChatHistory } from '../chief/history';
import { curateMemoryDream, describeDream, MEMORY_WRITE_TOOL, memoryWriteTool } from '../memory/markdown-memory';
import { SKILL_LIST_TOOL, skillTools } from '../skills/skills';
import type { HubAuditEntry, HubBackend, HubBlock, HubDecision, HubItem, HubMission, HubState, HubTrust } from './hub';

/**
 * `rufus start`: ONE daemon for everything.
 *
 *   - the Master Loop senses (inbox.jsonl + configured app sensors), plans, executes and verifies;
 *   - items waiting on you go to your chat as short plain text (no buttons: they work in any chat app, Beeper included):
 *     `urgent` ones right away, `normal` ones batched into one check-in every `checkinEveryMs` (or when you say
 *     "checkin" / run `rufus now`), so Rufus never pings you for every tiny event;
 *   - your replies ("1", "2 too long", "edit: ...", "#2 yes") resolve them, which updates Earned Trust, commits through
 *     real tools when approved, and saves an example;
 *   - anything else goes to the CardBridge: flow cards and the Chief of Staff, as before.
 */

export interface UnifiedDaemonOptions {
  loop: MasterLoop;
  engine: Engine;
  /** Where you talk with Rufus. Without one, items go to `output` (the terminal) and you decide with `rufus decide`. */
  channel?: LiveChannel;
  /** Terminal output when there is no channel. */
  output?: (text: string) => void;
  /** Answers chat that is not a reply to an item. Default: a Chief of Staff that also sees the loop. `false`: none. */
  chief?: ChiefOfStaff | false;
  /** How often normal items are delivered together. Default 2 hours. */
  checkinEveryMs?: number;
  /** Proactive schedule heads-ups and the good-morning brief (code only, $0). Default on; `false` turns it off. */
  heartbeat?: HeartbeatOptions | false;
  /** Pause between two bubbles of one chat reply. Default 350ms. */
  bubblePauseMs?: number;
  /**
   * v15: how long a Verify item may wait after it reached you. Older ones expire: never sent, never revived by a later
   * message. Default 60 minutes.
   */
  pendingTtlMs?: number;
  /** v15: the proactive Jarvis think-beat. Off unless set (`rufus start` turns it on every 45 minutes by default). */
  think?: ThinkOptions | false;
  /**
   * v17: mirror today's real calendar (`calendar.read`, read-only) into the Anchor, on the first pass and then every
   * `everyMs` (default 20 minutes). Plain code, $0. On by default whenever `calendar.read` is registered; `false`: off.
   */
  calendarSync?: { everyMs?: number } | false;
  /** v17: the proactive day planner: once a day, offers a plan for a big open stretch. Off unless set. */
  planner?: DayPlannerOptions | false;
  /** v17: a curated break digest at the start of scheduled `scroll` (and other chosen) blocks. Off unless set. */
  breakDigest?: BreakDigestOptions | false;
  /**
   * v18: the daily self-review (once each evening, code only). Writes `self-review.jsonl`; says one short note only when
   * something is actionable. Off unless set (`rufus start` turns it on).
   */
  selfReview?: SelfReviewOptions | false;
  /**
   * v22: durable background missions. Queued missions (`mission.start` from chat, or `rufus missions start`) run in the
   * background with read-only tools only, and the result is sent to you once when done. Default on; `false`: off.
   */
  missions?: MissionDaemonOptions | false;
  /**
   * v24b: the evening "dreaming" pass over `memory/YYYY-MM-DD.md`: once a day after `after` (default 19:00), repeated
   * notes the human said are promoted into USER.md / MEMORY.md and repeats there are folded. Silent; code only unless
   * `ai: true` (one fast-tier call). Default on; `false`: off.
   */
  memoryDream?: { after?: string; ai?: boolean } | false;
  /**
   * v20: spoken replies. With `tts` set (a local command, or a function in tests), a chat reply to a voice note comes
   * back as a voice note too (`replyMode: 'match'`, the default), or every chat reply does (`'always'`). Loop items,
   * check-ins and cards are always text. If speaking fails, the reply is sent as text.
   */
  voice?: { tts?: TtsCommandConfig | Synthesizer; replyMode?: VoiceReplyMode };
  /**
   * v24a "Code Prepares": before a check-in or the think-beat, pending Beeper reply items are checked against the live
   * chat (`beeper.read`); the ones you already answered or reacted to are dismissed at $0, so Rufus never nudges about
   * them. Checked at most every `everyMs` (default 5 minutes) outside check-ins. On whenever `beeper.read` is
   * registered; `false`: off.
   */
  staleGuard?: { everyMs?: number } | false;
  now?: () => Date;
}

export interface MissionDaemonOptions {
  /** Missions running at the same time. Default 1. */
  concurrency?: number;
  /** Named provider for missions. Default: the `smart` tier (or the default provider). */
  provider?: string;
  /** Per tool call inside a mission. Default 30s. */
  toolTimeoutMs?: number;
}

export interface DayPlannerOptions extends PlannerOptions {
  /** Offer a plan only when at least this many minutes are open. Default 90. */
  minOpenMinutes?: number;
  /** Local `HH:MM-HH:MM` window in which it may offer. Default `09:00-17:00`. */
  window?: string;
  /** One fast-tier call lays out the plan (checked in code). Default false: plain code, $0. */
  ai?: boolean;
}

export interface BreakDigestOptions {
  /** Block kinds that get a digest when they start. Default `['scroll']`. */
  kinds?: BlockKind[];
  /** Word the bullets with one fast-tier call. Default false: plain code, $0. */
  ai?: boolean;
  /** Only this soon after the block starts. Default 10 minutes. */
  withinMinutes?: number;
}

export interface StartTickReport {
  /** The Master Loop pass. */
  loop?: LoopTickReport;
  /** Run ids sent on their own right away (urgent, or the next step of something you just answered). */
  sentNow: string[];
  /** Run ids holding for the next check-in. */
  batched: string[];
  /** Run ids delivered in a check-in this pass. */
  checkin: string[];
  /** Your decisions applied this pass. */
  decided: Array<{ runId: string; n: number; verdict: Verdict; status: LoopRunStatus }>;
  /** Flow cards and chat (the CardBridge). */
  bridge?: TickReport;
  /** Proactive messages Rufus started this pass (schedule heads-ups, the good-morning brief, the think-beat). */
  proactive?: string[];
  /** v15: Verify items that expired unanswered this pass (nothing was sent). */
  expired?: string[];
  /** v15: what the think-beat did this pass: `sent`, `silent`, `started`, or `skipped: <why>`. */
  thought?: string;
  /** v17: the calendar sync this pass, when it ran. */
  calendar?: CalendarSyncResult;
  /** v17: the day plan proposed this pass. */
  planned?: string;
  /** v17: the break digest sent this pass. */
  digest?: string;
  /** v18: what the daily self-review did this pass: `noted`, `silent`, or `skipped: <why>`. */
  reviewed?: string;
  /** v24b: what the evening memory curation did this pass. */
  dreamed?: string;
  /** v22: missions started in the background, and finished ones announced, this pass. */
  missions?: { started: string[]; delivered: string[] };
  /** v21: runs that acted on their own at `auto_notify` and were announced this pass. */
  autoNotified?: string[];
  /** v24a: Verify items dismissed this pass because you already replied or reacted in Beeper (nothing was sent). */
  pruned?: string[];
  /** Problems this pass; the next pass retries. */
  errors: string[];
}

export const DEFAULT_CHECKIN_MS = 2 * 3_600_000;
/** v24a: how often the Beeper staleness guard reads the chats outside check-ins and think-beats. */
export const DEFAULT_STALE_GUARD_MS = 5 * 60_000;
const KEEP_HANDLED = 500;
const KEEP_SENT = 100;
/** A think-beat never interrupts a live conversation: it waits until the human has been quiet this long. */
const CONVERSATION_QUIET_MS = 5 * 60_000;
export const DEFAULT_CALENDAR_SYNC_MS = 20 * 60_000;
const KEEP_KEYS = 200;
/** v21: a bare "undo" / "demote" refers to the last auto_notify action for this long. */
const AUTO_UNDO_WINDOW_MS = 24 * 3_600_000;
const UNDO_OR_DEMOTE = /^(undo|demote|demote (?:it|that)|ask (?:me )?first(?: again)?)[.!\s]*$/i;
const hhmmToMin = (t: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

const hash = (text: string): string => createHash('sha1').update(text.trim()).digest('hex');
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const oneLine = (s: string, max = 200): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Hands the CardBridge only what the daemon did not consume, and sends through the daemon (so echoes are known). */
class RelayChannel implements LiveChannel {
  inbox: IncomingMessage[] = [];
  constructor(
    /** `chat`: a Chief of Staff reply (may be spoken); otherwise a card. */
    private readonly sendText: (text: string, chat: boolean) => Promise<void>,
    private readonly real: LiveChannel,
  ) {}
  async send(text: string): Promise<void> {
    await this.sendText(text, true);
  }
  /** Cards stay plain text (no buttons), and are never spoken. */
  async sendCard(_card: unknown, text: string): Promise<void> {
    await this.sendText(text, false);
  }
  async typing(): Promise<void> {
    await this.real.typing?.().catch(() => undefined);
  }
  get react(): LiveChannel['react'] {
    const real = this.real;
    return real.react ? (id, emoji) => real.react!(id, emoji) : undefined;
  }
  async poll(): Promise<IncomingMessage[]> {
    const out = this.inbox;
    this.inbox = [];
    return out;
  }
}

function parseEdit(text: string): unknown {
  const t = text.trim();
  if (/^[{[]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* plain text */
    }
  }
  return t;
}

export class UnifiedDaemon {
  readonly loop: MasterLoop;
  readonly engine: Engine;
  private readonly channel?: LiveChannel;
  private readonly output: (text: string) => void;
  private readonly chief?: ChiefOfStaff;
  private readonly checkinEveryMs: number;
  private readonly heartbeat: HeartbeatOptions | false;
  private readonly thinkOpts: ThinkOptions | false;
  private readonly calendarSync: { everyMs: number } | false;
  private readonly planner: DayPlannerOptions | false;
  private readonly digestOpts: BreakDigestOptions | false;
  private readonly reviewOpts: SelfReviewOptions | false;
  private readonly dreamOpts: { after?: string; ai?: boolean } | false;
  private readonly missionOpts: Required<Pick<MissionDaemonOptions, 'concurrency'>> & MissionDaemonOptions | false;
  /** v22: missions running in this process right now, by id. */
  private readonly inflight = new Map<string, Promise<MissionRecord | undefined>>();
  private readonly pendingTtlMs: number;
  private readonly bubblePauseMs: number;
  private readonly now: () => Date;
  private readonly relay?: RelayChannel;
  private readonly bridge?: CardBridge;
  private queue: Promise<unknown> = Promise.resolve();
  /** Set while handling a "checkin" typed in chat. */
  private chatCheckin = false;
  /** Runs you just answered whose next step should come right away, not at the next check-in. */
  private readonly followUps = new Set<string>();
  /** The state of the current pass, so the relay's sends are recorded in it. */
  private current?: StartState;
  private readonly synth?: Synthesizer;
  private readonly voiceMode: VoiceReplyMode;
  /** Set while the chat being answered this pass came in as a voice note. */
  private voiceTurn = false;
  /** v24a: the Beeper staleness guard, and when it last read the chats. */
  private readonly staleGuard: { everyMs: number } | false;
  private lastPruneAt?: number;

  constructor(opts: UnifiedDaemonOptions) {
    this.loop = opts.loop;
    this.engine = opts.engine;
    this.channel = opts.channel;
    this.output = opts.output ?? ((t) => console.log(t));
    this.now = opts.now ?? (() => new Date());
    this.checkinEveryMs = opts.checkinEveryMs ?? DEFAULT_CHECKIN_MS;
    if (!(this.checkinEveryMs > 0)) throw new Error('checkinEveryMs must be above 0.');
    this.heartbeat = opts.heartbeat === false ? false : (opts.heartbeat ?? {});
    this.thinkOpts = opts.think && opts.think.everyMs > 0 ? opts.think : false;
    this.calendarSync = opts.calendarSync === false ? false : { everyMs: Math.max(60_000, opts.calendarSync?.everyMs ?? DEFAULT_CALENDAR_SYNC_MS) };
    this.planner = opts.planner ? opts.planner : false;
    this.digestOpts = opts.breakDigest ? opts.breakDigest : false;
    this.reviewOpts = opts.selfReview ? opts.selfReview : false;
    this.dreamOpts = opts.memoryDream === false ? false : (opts.memoryDream ?? {});
    this.missionOpts = opts.missions === false ? false : { ...opts.missions, concurrency: Math.max(1, Math.floor(opts.missions?.concurrency ?? 1)) };
    this.pendingTtlMs = opts.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.bubblePauseMs = Math.max(0, opts.bubblePauseMs ?? 350);
    const tts = opts.voice?.tts;
    this.synth = tts && (typeof tts === 'function' || tts.command) ? commandSynthesizer(tts) : undefined;
    this.voiceMode = this.synth ? resolveVoiceReplyMode({ tts: true, ...(opts.voice?.replyMode ? { replyMode: opts.voice.replyMode } : {}) }) : 'never';
    // Your schedule and goals are editable from chat ("remove the study block"): private and local, so no Verify item.
    if (!this.loop.tools.has(ANCHOR_TOOL)) this.loop.tools.register(anchorUpdateTool());
    // Corrections, preferences and facts said in chat are saved as feedback the next triage/chat pass learns from.
    if (!this.loop.tools.has(REMEMBER_TOOL)) this.loop.tools.register(rememberTool());
    // v24a: chat can dismiss Verify items you already handled yourself ("I already replied to #1-#4"); it updates this
    // pass's live start state, so the numbers stay right.
    if (!this.loop.tools.has(PENDING_CLEAR_TOOL)) this.loop.tools.register(pendingClearTool({ loop: this.loop, liveState: () => this.current }));
    this.staleGuard = opts.staleGuard === false ? false : { everyMs: Math.max(0, opts.staleGuard?.everyMs ?? DEFAULT_STALE_GUARD_MS) };
    // v22: chat can hand deep research to a background mission ("research X and get back to me").
    // v24b: plain-markdown memory (USER.md, MEMORY.md, daily notes) and the read-only skill tools.
    if (!this.loop.tools.has(MEMORY_WRITE_TOOL)) this.loop.tools.register(memoryWriteTool());
    if (!this.loop.tools.has(SKILL_LIST_TOOL)) for (const t of skillTools()) if (!this.loop.tools.has(t.name)) this.loop.tools.register(t);
    if (this.missionOpts && !this.loop.tools.has(MISSION_START_TOOL)) for (const t of missionTools()) if (!this.loop.tools.has(t.name)) this.loop.tools.register(t);
    this.chief = opts.chief === false ? undefined : (opts.chief ?? new ChiefOfStaff({ engine: this.engine, loop: this.loop, tools: this.loop.tools, ...(opts.now ? { now: opts.now } : {}) }));
    // Side effects asked for in chat become Verify items; phone context signals are recorded silently.
    if (!this.loop.listHandlers().some((h) => h.id === chiefActionHandler.id)) this.loop.addHandler(chiefActionHandler);
    if (!this.loop.listHandlers().some((h) => h.id === phoneSignalHandler.id)) this.loop.addHandler(phoneSignalHandler);
    if (this.chief?.hasTools && !this.loop.listSensors().some((x) => x.id === 'inbox')) this.loop.addSensor(inboxSensor(this.loop.dir));
    if (this.channel) {
      this.relay = new RelayChannel((text, chat) => this.say(text, true, false, false, chat), this.channel);
      this.bridge = new CardBridge({
        engine: this.engine,
        channel: this.relay,
        chief: this.chief ?? false,
        workspaceDir: this.loop.dir,
        now: this.now,
        ...(opts.bubblePauseMs !== undefined ? { bubblePauseMs: opts.bubblePauseMs } : {}),
        // v23: a reply that will be spoken (a voice note answered by voice) is written for the ear, on the fast provider.
        spokenReply: (cameAsVoice) => shouldSpeakReply(this.voiceMode, cameAsVoice),
      });
    }
  }

  /** One pass: read your replies, run the loop, deliver what needs you, then flow cards and chat. Never throws on channel errors. */
  tick(): Promise<StartTickReport> {
    const run = this.queue.then(() => this.runTick());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Tick until `signal` aborts, waiting `intervalMs` between passes. */
  async run(opts: { intervalMs: number; signal?: AbortSignal; onTick?: (r: StartTickReport) => void }): Promise<void> {
    const { signal } = opts;
    while (!signal?.aborted) {
      opts.onTick?.(await this.tick());
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, opts.intervalMs);
        signal?.addEventListener('abort', done, { once: true });
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        }
      });
    }
  }

  /**
   * v22: waits for every background mission running in this process to finish (for tests and a clean shutdown). Returns
   * the missions that finished. Their results are announced on the next tick.
   */
  async drainMissions(): Promise<MissionRecord[]> {
    const done: MissionRecord[] = [];
    while (this.inflight.size) for (const r of await Promise.all([...this.inflight.values()])) if (r) done.push(r);
    return done;
  }

  /** v22: ids of the missions running in this process right now. */
  runningMissions(): string[] {
    return [...this.inflight.keys()];
  }

  // ---------- internals ----------

  /**
   * v22: announces finished missions once (quiet hours hold them unless urgent), then starts queued ones in the
   * background, up to `concurrency` at a time. A `running` mission no process is running (left by a crash) resumes.
   * Never waits for a mission to finish.
   */
  private async missionPass(report: StartTickReport, opts: MissionDaemonOptions & { concurrency: number }): Promise<void> {
    const dir = this.loop.dir;
    const now = this.now();
    const started: string[] = [];
    const delivered: string[] = [];
    const finished = (await listMissions(dir, { status: ['completed', 'failed'] })).filter((m) => !m.delivered && !this.inflight.has(m.id)).reverse();
    const quiet = finished.length ? inQuietHours(now, this.quietHours()) : false;
    for (const m of finished) {
      if (quiet && !m.urgent) continue;
      const fresh = await loadMission(dir, m.id);
      if (!fresh || fresh.delivered) continue;
      // Marked BEFORE it is said: a crash between the two can drop a message, never send it twice.
      await saveMission(dir, { ...fresh, delivered: true });
      const text = formatMissionDelivery(fresh);
      try {
        await this.say(text, false, true, true);
      } catch (err) {
        await saveMission(dir, { ...fresh, delivered: false }).catch(() => undefined);
        throw err;
      }
      delivered.push(m.id);
      report.proactive = [...(report.proactive ?? []), text];
    }
    const waiting = (await listMissions(dir, { status: ['queued', 'running'] })).reverse(); // oldest first
    for (const m of waiting) {
      if (this.inflight.size >= opts.concurrency) break;
      if (this.inflight.has(m.id)) continue;
      this.startMission(m.id, opts);
      started.push(m.id);
    }
    if (started.length || delivered.length) report.missions = { started, delivered };
  }

  private startMission(id: string, opts: MissionDaemonOptions): void {
    const dir = this.loop.dir;
    let provider;
    try {
      provider = this.engine.routeProvider(opts.provider ? { provider: opts.provider } : { tier: 'smart' });
    } catch {
      provider = undefined; // runMission records why it cannot run
    }
    const run = runMission({ dir, id, engine: this.engine, tools: this.loop.tools, now: this.now, ...(provider ? { provider } : {}), ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}) })
      .catch(async (err: unknown) => {
        const m = await loadMission(dir, id).catch(() => undefined);
        if (!m || m.status === 'cancelled' || m.status === 'completed' || m.status === 'failed') return m;
        const failed: MissionRecord = { ...m, status: 'failed', error: oneLine(message(err)), finishedAt: this.now().toISOString() };
        await saveMission(dir, failed).catch(() => undefined);
        return failed;
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, run);
  }

  private async runTick(): Promise<StartTickReport> {
    const report: StartTickReport = { sentNow: [], batched: [], checkin: [], decided: [], errors: [] };
    const state = await loadStartState(this.loop.dir);
    this.current = state;
    try {
      // Stale Verify items expire BEFORE any reply is read, so an old item can never be triggered by a later message.
      try {
        await this.expireStale(state, report);
      } catch (err) {
        report.errors.push(`expire: ${message(err)}`);
      }
      // The real calendar goes into the Anchor first, so chat, heads-ups and the planner all see the real day.
      if (this.calendarSync && this.loop.tools.has(CALENDAR_TOOL)) {
        try {
          await this.calendarPass(state, report, this.calendarSync.everyMs);
        } catch (err) {
          report.errors.push(`calendar: ${message(err)}`);
        }
      }
      if (this.channel?.poll) {
        if (state.since === undefined) {
          state.since = this.now().toISOString(); // first pass: listen from now on, never replay old chat
          await this.persist();
        }
        try {
          await this.receive(state, report);
        } catch (err) {
          report.errors.push(`channel: ${message(err)}`);
        }
      }
      try {
        report.loop = await this.loop.runOnce();
        for (const e of report.loop.errors) report.errors.push(`sensor ${e.sensorId}: ${e.error}`);
        await this.announceAuto(state, report, report.loop);
      } catch (err) {
        report.errors.push(`loop: ${message(err)}`);
      }
      try {
        await this.pruneStale(state, report, this.chatCheckin || this.checkinDue(state));
      } catch (err) {
        report.errors.push(`stale-guard: ${message(err)}`);
      }
      try {
        await this.deliver(state, report);
      } catch (err) {
        report.errors.push(`deliver: ${message(err)}`);
      }
      if (this.bridge) {
        try {
          report.bridge = await this.bridge.tick();
        } finally {
          this.voiceTurn = false;
        }
        if (report.bridge.error) report.errors.push(`channel: ${report.bridge.error}`);
      }
      // Chat queued an action ("send Sam ..."): plan and deliver it now, so its "1" works right after the reply.
      if (this.chief?.drainQueued()) {
        try {
          const again = await this.loop.runOnce();
          for (const e of again.errors) report.errors.push(`sensor ${e.sensorId}: ${e.error}`);
          for (const r of again.runs) if (r.actionType?.startsWith('chief.')) this.followUps.add(r.runId);
          await this.announceAuto(state, report, again);
          await this.deliver(state, report);
        } catch (err) {
          report.errors.push(`loop: ${message(err)}`);
        }
      }
      if (this.missionOpts) {
        try {
          await this.missionPass(report, this.missionOpts);
        } catch (err) {
          report.errors.push(`missions: ${message(err)}`);
        }
      }
      if (this.heartbeat) {
        try {
          await this.heartbeatPass(state, report, this.heartbeat);
        } catch (err) {
          report.errors.push(`heartbeat: ${message(err)}`);
        }
      }
      if (this.digestOpts) {
        try {
          await this.digestPass(state, report, this.digestOpts);
        } catch (err) {
          report.errors.push(`digest: ${message(err)}`);
        }
      }
      if (this.planner) {
        try {
          await this.plannerPass(state, report, this.planner);
        } catch (err) {
          report.errors.push(`planner: ${message(err)}`);
        }
      }
      if (this.reviewOpts) {
        try {
          await this.reviewPass(state, report, this.reviewOpts);
        } catch (err) {
          report.errors.push(`self-review: ${message(err)}`);
        }
      }
      if (this.dreamOpts) {
        try {
          await this.dreamPass(state, report, this.dreamOpts);
        } catch (err) {
          report.errors.push(`memory dream: ${message(err)}`);
        }
      }
      if (this.thinkOpts) {
        try {
          await this.thinkPass(state, report, this.thinkOpts);
        } catch (err) {
          report.errors.push(`think: ${message(err)}`);
        }
      }
    } finally {
      await this.persist();
      this.current = undefined;
      this.chatCheckin = false;
    }
    return report;
  }

  /** Proactive, code-only: a heads-up before the next real block, and the good-morning brief on the first unlock. */
  private async heartbeatPass(state: StartState, report: StartTickReport, hb: HeartbeatOptions): Promise<void> {
    const now = this.now();
    const quiet = hb.quietHours ?? DEFAULT_QUIET_HOURS;
    const unlocked = (report.loop?.runs ?? []).some((r) => r.actionType === 'phone.unlocked');
    if (inQuietHours(now, quiet)) return;
    const anchor = await loadAnchor(this.loop.dir, now);
    const sent: string[] = [];

    if (unlocked && (hb.morningBrief ?? true) && isMorning(now, { quietHours: quiet, ...(hb.morningUntil ? { morningUntil: hb.morningUntil } : {}) })) {
      const date = localDate(now);
      if (state.lastMorningBrief !== date) {
        state.lastMorningBrief = date;
        const text = formatMorningBrief(anchor, now, (await this.loop.pending()).length);
        await this.say(text, false, false, true);
        sent.push(text);
      }
    }

    for (const block of blocksToNudge(anchor, now, state.nudged ?? [], hb.leadMinutes ?? DEFAULT_LEAD_MINUTES)) {
      state.nudged = markNudged(state.nudged, anchor, block);
      const text = hb.phrasing === 'ai' ? await this.phraseNudge(block, now) : formatNudge(block, now);
      await this.say(text, false, false, true);
      sent.push(text);
    }
    if (sent.length) report.proactive = [...(report.proactive ?? []), ...sent];
  }

  /** The quiet hours every proactive pass respects (the heartbeat's, else the think-beat's, else the default). */
  private quietHours(): string | false {
    if (this.heartbeat && this.heartbeat.quietHours !== undefined) return this.heartbeat.quietHours;
    if (this.thinkOpts && this.thinkOpts.quietHours !== undefined) return this.thinkOpts.quietHours;
    return DEFAULT_QUIET_HOURS;
  }

  /**
   * v17: mirrors today's calendar into the Anchor (first pass, then every `everyMs`). $0. A new collision between a real
   * event still ahead and one of your own blocks is mentioned once (outside quiet hours); nothing is moved for you.
   */
  private async calendarPass(state: StartState, report: StartTickReport, everyMs: number): Promise<void> {
    const now = this.now();
    if (state.lastCalendarSyncAt && now.getTime() - Date.parse(state.lastCalendarSyncAt) < everyMs) return;
    state.lastCalendarSyncAt = now.toISOString(); // a failing calendar is retried next interval, not every pass
    const result = await syncCalendarToAnchor(this.loop.dir, this.loop.tools, now);
    report.calendar = result;
    if (inQuietHours(now, this.quietHours())) return;
    const date = localDate(now);
    const minsNow = now.getHours() * 60 + now.getMinutes();
    const said = state.calendarConflicts ?? [];
    for (const c of result.conflicts) {
      const key = conflictKey(date, c);
      if (said.includes(key) || hhmmToMin(c.event.end) <= minsNow) continue;
      said.push(key);
      const mine = c.blocks.map((b) => speakableTitle(b.title, 32));
      const text = `Heads up — your calendar has ${speakableTitle(c.event.title, 40)} at ${range12(c.event.start, c.event.end)}, right on top of your ${mine.join(' and ')} block. Want me to move ${mine.length > 1 ? 'them' : 'it'}?`;
      await this.say(text, false, true, true);
      report.proactive = [...(report.proactive ?? []), text];
    }
    state.calendarConflicts = said.filter((k) => k.startsWith(`${date}:`)).slice(-KEEP_KEYS);
  }

  /**
   * v17: once a day, when a big stretch is open and you're not mid-conversation, offers a plan for it. It only asks:
   * the blocks wait in `day-plan.json` until you say yes.
   */
  private async plannerPass(state: StartState, report: StartTickReport, opts: DayPlannerOptions): Promise<void> {
    const now = this.now();
    const date = localDate(now);
    if (state.lastPlanOffer === date || report.proactive?.length) return;
    const [from, to] = (opts.window ?? '09:00-17:00').split('-').map(hhmmToMin);
    const mins = now.getHours() * 60 + now.getMinutes();
    if (!(mins >= from! && mins < to!)) return;
    if (inQuietHours(now, this.quietHours())) return;
    if (state.lastHumanAt && now.getTime() - Date.parse(state.lastHumanAt) < CONVERSATION_QUIET_MS) return;
    const anchor = await loadAnchor(this.loop.dir, now);
    if (protectedNow(anchor, now)) return;
    if (await loadPendingPlan(this.loop.dir, now)) return;
    const open = openGaps(anchor, now, opts).reduce((n, g) => n + g.minutes, 0);
    if (open < (opts.minOpenMinutes ?? 90)) return;
    const ai = opts.ai ? this.engine.routeProvider({ tier: 'fast' }) : undefined;
    const soul = opts.ai ? await loadSoul(this.loop.dir).catch(() => undefined) : undefined;
    const plan = await proposeDayPlan({ anchor, now, options: opts, ...(ai ? { ai } : {}), ...(soul ? { soul } : {}) });
    if (!plan.blocks.length) return;
    await savePendingPlan(this.loop.dir, plan, now);
    state.lastPlanOffer = date;
    await this.say(plan.summary, false, true, true);
    if (state.think) {
      state.think.unanswered += 1;
      state.think.lastSentAt = now.toISOString();
      state.think.lastAt = now.toISOString();
    }
    report.planned = plan.summary;
    report.proactive = [...(report.proactive ?? []), plan.summary];
  }

  /** v17: at the start of a scheduled scroll (or chosen) block, a short curated digest instead of a feed. */
  private async digestPass(state: StartState, report: StartTickReport, opts: BreakDigestOptions): Promise<void> {
    const now = this.now();
    if (inQuietHours(now, this.quietHours())) return;
    const anchor = await loadAnchor(this.loop.dir, now);
    const { current } = scheduleNow(anchor, now);
    if (!current || current.status !== 'planned' || !(opts.kinds ?? ['scroll']).includes(current.kind)) return;
    const since = now.getHours() * 60 + now.getMinutes() - hhmmToMin(current.start);
    if (since > (opts.withinMinutes ?? 10)) return;
    const key = `${localDate(now)}:${current.id}`;
    if (state.digested?.includes(key)) return;
    state.digested = [...(state.digested ?? []), key].slice(-KEEP_KEYS);
    const ai = opts.ai ? this.engine.routeProvider({ tier: 'fast' }) : undefined;
    const digest = await buildBreakDigest({ dir: this.loop.dir, anchor, now, ...(ai ? { ai } : {}) });
    await this.say(digest.text, false, true, true);
    report.digest = digest.text;
    report.proactive = [...(report.proactive ?? []), digest.text];
  }

  /**
   * v18: the daily self-review. Once each evening, never in quiet hours or protected time, and never mid-conversation or
   * right after the heartbeat spoke (it simply waits for a later pass). The record is always saved; at most ONE short
   * note is said, and only when something is actionable.
   */
  private async reviewPass(state: StartState, report: StartTickReport, opts: SelfReviewOptions): Promise<void> {
    const now = this.now();
    if (report.proactive?.length) {
      report.reviewed = 'skipped: heartbeat spoke';
      return;
    }
    if (state.lastHumanAt && now.getTime() - Date.parse(state.lastHumanAt) < CONVERSATION_QUIET_MS) {
      report.reviewed = 'skipped: in conversation';
      return;
    }
    const anchor = await loadAnchor(this.loop.dir, now);
    const quietHours = opts.quietHours !== undefined ? opts.quietHours : this.heartbeat ? (this.heartbeat.quietHours ?? DEFAULT_QUIET_HOURS) : DEFAULT_QUIET_HOURS;
    const r = await runSelfReview({ dir: this.loop.dir, now, anchor, state: (state.selfReview ??= {}), options: { ...opts, quietHours } });
    if ('skipped' in r) {
      report.reviewed = `skipped: ${r.skipped}`;
      return;
    }
    if (!r.note) {
      report.reviewed = 'silent';
      return;
    }
    await this.say(r.note, false, true, true);
    if (state.think) state.think.lastAt = now.toISOString(); // that was the beat
    report.reviewed = 'noted';
    report.proactive = [...(report.proactive ?? []), r.note];
  }

  /**
   * v24b: the evening dreaming pass. Once per local date, after `after` (default 19:00): curates the daily notes into
   * USER.md / MEMORY.md. Silent (nothing is said). A workspace with no notes and no memory files is left untouched.
   */
  private async dreamPass(state: StartState, report: StartTickReport, opts: { after?: string; ai?: boolean }): Promise<void> {
    const now = this.now();
    const today = localDate(now);
    if (state.memoryDream?.lastDate === today) return;
    if (now.getHours() * 60 + now.getMinutes() < toMinutes(opts.after ?? DEFAULT_REVIEW_AFTER)) return;
    const ai = opts.ai ? this.engine.routeProvider({ tier: 'fast' }) : undefined;
    const r = await curateMemoryDream(this.loop.dir, { now, ...(ai ? { ai } : {}) });
    if (!r.scanned && !r.duplicatesRemoved) return;
    state.memoryDream = { lastDate: today };
    report.dreamed = describeDream(r);
  }

  /** True when the batched check-in would go out on this pass. */
  private checkinDue(state: StartState): boolean {
    return state.lastCheckinAt !== undefined && this.now().getTime() - Date.parse(state.lastCheckinAt) >= this.checkinEveryMs;
  }

  /**
   * v24a Code Prepares: dismisses pending Beeper reply items you already answered or reacted to (live `beeper.read`, $0).
   * `force`: a check-in or the think-beat is about to speak; otherwise at most every `staleGuard.everyMs`. Beeper being
   * offline is never an error: nothing changes.
   */
  private async pruneStale(state: StartState, report: StartTickReport, force: boolean): Promise<void> {
    if (!this.staleGuard || !this.loop.tools.has('beeper.read')) return;
    const now = this.now();
    if (!force && this.lastPruneAt !== undefined && now.getTime() - this.lastPruneAt < this.staleGuard.everyMs) return;
    this.lastPruneAt = now.getTime();
    const r = await pruneHandledPendingItems(this.loop.dir, this.loop, this.loop.tools, state, { now });
    if (r.pruned.length) report.pruned = [...(report.pruned ?? []), ...r.pruned];
  }

  /** Expires Verify items that reached you more than `pendingTtlMs` ago. Undelivered items wait for their check-in. */
  private async expireStale(state: StartState, report: StartTickReport): Promise<void> {
    const now = this.now().toISOString();
    const at = (state.deliveredAt ??= {});
    for (const id of state.delivered) at[id] ??= now; // items delivered before v15: their clock starts now
    const expired = await this.loop.expireStale({ ttlMs: this.pendingTtlMs, startedAt: (r) => at[r.id], reason: `no decision within ${Math.round(this.pendingTtlMs / 60_000)} min of reaching you` });
    if (!expired.length) return;
    report.expired = [...(report.expired ?? []), ...expired.map((r) => r.id)];
    assignNumbers(state, await this.loop.pending()); // frees their numbers; nothing can answer them any more
  }

  /**
   * The proactive think-beat: every `everyMs` (doubling while two or more proactive messages go unanswered), never in
   * quiet hours, a protected window, or mid-conversation. One model call; `SILENT` sends nothing.
   */
  private async thinkPass(state: StartState, report: StartTickReport, opts: ThinkOptions): Promise<void> {
    const now = this.now();
    const t = (state.think ??= freshThinkState());
    if (!t.lastAt) {
      t.lastAt = now.toISOString(); // the clock starts with the daemon: no thought on the very first pass
      report.thought = 'started';
      return;
    }
    if (report.proactive?.length) {
      t.lastAt = now.toISOString(); // the heartbeat already spoke this pass: that was the beat
      report.thought = 'skipped: heartbeat spoke';
      return;
    }
    const anchor = await loadAnchor(this.loop.dir, now);
    const quietHours = opts.quietHours !== undefined ? opts.quietHours : this.heartbeat ? (this.heartbeat.quietHours ?? DEFAULT_QUIET_HOURS) : DEFAULT_QUIET_HOURS;
    const skip = thinkSkipReason({ now, anchor, state: t, everyMs: opts.everyMs, quietHours, ...(opts.backoffAfter !== undefined ? { backoffAfter: opts.backoffAfter } : {}) });
    if (skip) {
      report.thought = `skipped: ${skip}`;
      return;
    }
    if (state.lastHumanAt && now.getTime() - Date.parse(state.lastHumanAt) < CONVERSATION_QUIET_MS) {
      report.thought = 'skipped: in conversation';
      return;
    }
    t.lastAt = now.toISOString();
    // v24a Code Prepares: the beat never sees (or nudges about) an item you already answered in Beeper.
    await this.pruneStale(state, report, true).catch((err) => report.errors.push(`stale-guard: ${message(err)}`));
    const provider = this.engine.routeProvider(opts.provider ? { provider: opts.provider } : { tier: 'fast' });
    const r = await think({ provider, dir: this.loop.dir, loop: this.loop, now, tools: this.loop.tools, ...(opts.tools ? { glance: opts.tools } : {}), ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}) });
    if (!r.bubbles) {
      report.thought = 'silent';
      return;
    }
    await this.channel?.typing?.().catch(() => undefined);
    for (const [i, bubble] of r.bubbles.entries()) {
      if (i && this.bubblePauseMs) await new Promise((resolve) => setTimeout(resolve, this.bubblePauseMs));
      await this.say(bubble, false, true, true);
    }
    t.unanswered += 1;
    t.lastSentAt = now.toISOString();
    report.thought = 'sent';
    report.proactive = [...(report.proactive ?? []), ...r.bubbles];
  }

  /** One fast-tier call words the heads-up; the plain code line whenever the model is missing, fails or rambles. */
  private async phraseNudge(block: ScheduleBlock, now: Date): Promise<string> {
    try {
      const raw = await this.engine.routeProvider({ tier: 'fast' }).complete({
        system: 'You write short, natural text messages.',
        messages: [{ role: 'user', content: nudgePrompt(block, now) }],
        meta: { runId: 'heartbeat', flowId: 'heartbeat', step: 'nudge', attempt: 1 },
      });
      return acceptNudge(raw) ?? formatNudge(block, now);
    } catch {
      return formatNudge(block, now);
    }
  }

  /**
   * v21: an action that ran on its own at `auto_notify` is told to you right away, never batched ("Just reacted 😂 to
   * Mom — reply 'undo' or 'demote' if you want me to ask first again").
   */
  private async announceAuto(state: StartState, report: StartTickReport, loop: LoopTickReport): Promise<void> {
    for (const r of loop.runs) {
      if (!r.autoNotified) continue;
      try {
        const run = await this.loop.getRun(r.runId);
        await this.say(run.autoNotice ?? `Just did ${run.actionType ?? 'something'} on my own — reply 'undo' or 'demote' if you want me to ask first again.`);
        state.lastAutoNotified = { runId: run.id, actionType: run.actionType ?? run.handlerId, at: this.now().toISOString() };
        (report.autoNotified ??= []).push(run.id);
      } catch (err) {
        report.errors.push(`auto-notify: ${message(err)}`);
      }
    }
  }

  /** v21: "undo" / "demote" right after an auto_notify action: that action goes back to `check` (a complaint). */
  private async undoOrDemote(state: StartState, text: string): Promise<boolean> {
    const last = state.lastAutoNotified;
    if (!last || !UNDO_OR_DEMOTE.test(text)) return false;
    if (this.now().getTime() - Date.parse(last.at) > AUTO_UNDO_WINDOW_MS) return false;
    await this.loop.trust.recordComplaint(last.actionType, text);
    delete state.lastAutoNotified;
    const undo = /^undo/i.test(text);
    await this.say(
      undo
        ? `Got it — ${last.actionType} is back to check, so I'll ask first next time. I can't take that one back myself; undo it in the chat if it matters.`
        : `Done — ${last.actionType} is back to check. I'll ask you first every time.`,
    );
    return true;
  }

  private async persist(): Promise<void> {
    if (this.current) await saveStartState(this.loop.dir, this.current);
  }

  private async receive(state: StartState, report: StartTickReport): Promise<void> {
    for (const msg of await this.channel!.poll!(state.since)) {
      if (state.handled.includes(msg.id)) continue;
      state.handled = [...state.handled, msg.id].slice(-KEEP_HANDLED);
      if (msg.at && (!state.since || msg.at > state.since)) state.since = msg.at;
      await this.persist();
      const text = msg.text.trim();
      if (!text || state.sent.includes(hash(text))) continue; // an echo of our own text never answers itself
      // The human said (or reacted) something: proactive back-off resets.
      state.lastHumanAt = this.now().toISOString();
      if (state.think) state.think.unanswered = 0;
      await this.handleIncoming(state, msg, text, report);
    }
  }

  /**
   * v15, Ironclad Send Safety. Only explicit commands touch a loop item (`1`, `send`, `2 <reason>`, `edit: ...`, `#2 send`);
   * every other message, typed or a voice note, is conversation and goes to the Chief of Staff. Nothing free-form can
   * ever approve, edit or send an item.
   */
  private async handleIncoming(state: StartState, msg: IncomingMessage, text: string, report: StartTickReport): Promise<void> {
    // An emoji reaction is seen and remembered by the chat side, never read as an answer or an edit.
    if (msg.reaction) return void this.relay!.inbox.push(msg);
    // v21: "undo" / "demote" right after something Rufus did on its own demotes it at once.
    if (await this.undoOrDemote(state, text)) return;
    // v21: the kill switch and friends work even with no Chief of Staff.
    if (!this.chief) {
      const cmd = parseAutonomyCommand(text);
      if (cmd) return this.say(await runAutonomyCommand(this.loop.dir, cmd, { trust: this.loop.trust, now: this.now() }));
    }
    const pending = await this.loop.pending();
    assignNumbers(state, pending);
    const delivered = pending.filter((r) => state.delivered.includes(r.id)).sort((a, b) => (state.numbers[a.id] ?? 0) - (state.numbers[b.id] ?? 0));
    const passOn = (): void => {
      const voice = msg.voice === true || this.channel?.isVoiceNote?.(msg.id) === true;
      if (voice) this.voiceTurn = true;
      this.relay!.inbox.push(voice && !msg.voice ? { ...msg, voice: true } : msg);
    };
    // With a flow card open, bare answers belong to the card: loop items then need "#n".
    const cardsOpen = (await this.engine.pending()).length > 0;
    const parsed: LoopReply | undefined = parseLoopReply(text, cardsOpen ? 0 : delivered.length);
    if (parsed?.kind === 'checkin') {
      this.chatCheckin = true;
      return;
    }

    if (parsed?.kind === 'decision') {
      // v17: a bare "yes" while a day plan also waits for a yes: never guess which (it could send a message).
      if (parsed.ref === undefined && /^(yes|y)[.!\s]*$/i.test(text) && (await loadPendingPlan(this.loop.dir, this.now()))) {
        const n = state.numbers[delivered[0]!.id];
        return this.say(`Did you mean the plan or #${n}? Reply "plan yes" for the plan, or "#${n} send" for that one.`);
      }
      if (parsed.ref !== undefined) {
        const target = pending.find((r) => state.numbers[r.id] === parsed.ref);
        if (!target) {
          // "#3 ..." may still be meant for a flow card or the chief when no loop item has that number.
          if (!pending.length) return passOn();
          return this.say(`Nothing is waiting as #${parsed.ref}. Open: ${pending.map((r) => state.numbers[r.id]!).sort((x, y) => x - y).map((n) => `#${n}`).join(', ')}.`);
        }
        return this.decide(state, target, parsed, report);
      }
      // Without a number, parseLoopReply only answers when exactly one item is open on your screen.
      return this.decide(state, delivered[0]!, parsed, report);
    }

    // A bare "1" / "send" with several items open: ask which, never guess.
    if (!cardsOpen && delivered.length > 1 && isBareVerdict(text)) {
      const n = state.numbers[delivered[0]!.id];
      return this.say(`${delivered.length} items are waiting. Start with the number, like "#${n} 1" or "#${n} 2".`);
    }
    // "#2 see you at 8": aimed at an item, but not a command. Say the exact forms instead of guessing an edit.
    const ref = refOf(text);
    if (ref !== undefined && pending.some((r) => state.numbers[r.id] === ref)) {
      return this.say(`For #${ref}, reply "#${ref} send", "#${ref} skip", or "#${ref} edit: <your version>".`);
    }
    passOn();
  }

  private async decide(state: StartState, run: LoopRun, reply: Extract<LoopReply, { kind: 'decision' }>, report: StartTickReport): Promise<void> {
    const n = state.numbers[run.id] ?? 0;
    const stage = run.status;
    const decision: HumanDecision = {
      verdict: reply.verdict,
      ...(reply.verdict === 'edit' && reply.edit !== undefined ? { editedOutput: parseEdit(reply.edit) } : {}),
      ...(reply.note ? { note: reply.note } : {}),
    };
    let result;
    try {
      await this.channel?.typing?.().catch(() => undefined); // committing may run real tools (and a re-plan, a model)
      result = await this.loop.resolveHumanDecision(run.id, decision);
    } catch (err) {
      return this.say(`Couldn't apply that to #${n}: ${oneLine(message(err))}`);
    }
    const after = result.run;
    report.decided.push({ runId: run.id, n, verdict: reply.verdict, status: after.status });
    if (result.held) {
      // An edit of an external send: the new draft is saved, NOTHING was sent. It stays open for an explicit "send".
      (state.deliveredAt ??= {})[run.id] = this.now().toISOString();
      const draft = draftOf(after.result) ?? reply.edit ?? '';
      return this.say(`Updated draft for ${recipientOf(after)}: "${clip(draft, 500)}" — reply #${n} send to send it, or #${n} skip to drop it.`);
    }
    state.delivered = state.delivered.filter((id) => id !== run.id);
    if (state.lastItem === run.id) delete state.lastItem;

    const parts: string[] = [];
    if (stage === 'awaiting_human_plan') {
      parts.push(reply.verdict === 'reject' ? `#${n} dropped.` : `#${n}: plan ${reply.verdict === 'edit' ? 'updated' : 'approved'}.`);
      if (after.status === 'completed') parts.push('Done.');
      else if (after.status === 'blocked') parts.push(`Blocked: ${(after.blockedBy ?? []).join('; ')}`);
      else if (after.status === 'error') parts.push(`It failed: ${oneLine(after.error ?? 'unknown error')}`);
    } else if (stage === 'awaiting_human_execute') {
      parts.push(reply.verdict === 'reject' ? `#${n} skipped.` : `#${n} marked done.`);
    } else {
      const applied = after.committed ? ' Done.' : '';
      parts.push(reply.verdict === 'accept' ? `#${n} approved.${applied}` : reply.verdict === 'edit' ? `#${n} saved with your edit.${applied}` : `#${n} rejected.`);
      if (after.commitError) parts.push(`Not applied: ${oneLine(after.commitError)}`);
    }
    if (result.promotionHint) parts.push(result.promotionHint);
    await this.say(parts.join(' '));
    if (['awaiting_human_plan', 'awaiting_human_execute', 'awaiting_human_verify'].includes(after.status)) this.followUps.add(run.id);
  }

  private async deliver(state: StartState, report: StartTickReport): Promise<void> {
    const pending = await this.loop.pending();
    assignNumbers(state, pending);
    const byNumber = (a: LoopRun, b: LoopRun): number => (state.numbers[a.id] ?? 0) - (state.numbers[b.id] ?? 0);
    const now = this.now();
    const fileRequest = await takeCheckinRequest(this.loop.dir);

    // A check-in you asked for: everything waiting on you, in one message.
    if (this.chatCheckin || fileRequest) {
      const items = [...pending].sort(byNumber);
      if (items.length || this.chatCheckin) {
        const text = this.chatCheckin ? `${(await nowSummary({ loop: this.loop, engine: this.engine, numbers: state.numbers, now })).join('\n')}\n\n${formatCheckin(items.map((run) => ({ run, n: state.numbers[run.id]! })))}` : formatCheckin(items.map((run) => ({ run, n: state.numbers[run.id]! })));
        await this.say(text);
        for (const r of items) if (!state.delivered.includes(r.id)) state.delivered.push(r.id);
        for (const r of items) (state.deliveredAt ??= {})[r.id] = now.toISOString();
        report.checkin.push(...items.map((r) => r.id));
        if (items.length === 1) state.lastItem = items[0]!.id;
        else delete state.lastItem;
      }
      state.lastCheckinAt = now.toISOString();
      this.followUps.clear();
      return;
    }

    const fresh = pending.filter((r) => !state.delivered.includes(r.id)).sort(byNumber);
    const urgent = fresh.filter((r) => r.urgency === 'urgent' || this.followUps.has(r.id));
    for (const r of urgent) {
      const openAfter = state.delivered.length + 1;
      await this.say(formatLoopItem(r, state.numbers[r.id]!, { multi: openAfter > 1 }));
      state.delivered.push(r.id);
      (state.deliveredAt ??= {})[r.id] = now.toISOString();
      state.lastItem = r.id;
      this.followUps.delete(r.id);
      report.sentNow.push(r.id);
    }
    const normal = fresh.filter((r) => !urgent.includes(r));
    if (state.lastCheckinAt === undefined) state.lastCheckinAt = now.toISOString(); // the check-in clock starts now
    const due = now.getTime() - Date.parse(state.lastCheckinAt) >= this.checkinEveryMs;
    if (normal.length && due) {
      const multi = normal.length > 1 || state.delivered.length > 0;
      const text =
        normal.length > 1 ? formatCheckin(normal.map((run) => ({ run, n: state.numbers[run.id]! }))) : formatLoopItem(normal[0]!, state.numbers[normal[0]!.id]!, { multi });
      await this.say(text);
      state.delivered.push(...normal.map((r) => r.id));
      for (const r of normal) (state.deliveredAt ??= {})[r.id] = now.toISOString();
      if (normal.length === 1 && !multi) state.lastItem = normal[0]!.id;
      else delete state.lastItem;
      state.lastCheckinAt = now.toISOString();
      report.checkin.push(...normal.map((r) => r.id));
    } else {
      report.batched.push(...normal.map((r) => r.id));
    }
  }

  /**
   * Records what we send (so its echo is ignored), then sends it, or prints it when there is no channel. What the daemon
   * itself says (items, heads-ups) also goes into the chat history; relayed chief replies are recorded by the chief.
   */
  private async say(text: string, relayed = false, record = false, proactive = false, chat = false): Promise<void> {
    const state = this.current;
    if (state) {
      state.sent = [...state.sent, hash(text)].slice(-KEEP_SENT);
      await this.persist();
    }
    if (this.channel) {
      if (!(chat && shouldSpeakReply(this.voiceMode, this.voiceTurn) && (await this.speak(text)))) await this.channel.send(text);
    } else this.output(text);
    if (!relayed && (this.chief || record || proactive)) await appendChatTurns(this.loop.dir, [{ role: 'assistant', text, at: this.now().toISOString(), ...(proactive ? { proactive: true } : {}) }]).catch(() => undefined);
  }

  /**
   * v20: sends a chat reply as a voice note (the text as its caption, or after it when too long for one). False when the
   * channel can't take voice or speaking failed: the caller then sends plain text, so nothing is ever lost.
   */
  private async speak(text: string): Promise<boolean> {
    if (!this.synth || !this.channel?.sendVoice || !text.trim()) return false;
    let audio;
    try {
      audio = await this.synth(text);
    } catch {
      return false;
    }
    const caption = text.length <= 1000 ? text : undefined;
    try {
      await this.channel.sendVoice(audio.audio, { filename: `rufus.${audio.ext}`, mimeType: audio.mimeType, ...(caption ? { caption } : {}) });
    } catch {
      return false;
    }
    if (!caption) await this.channel.send(text);
    return true;
  }

  // ---------- v20: the Jarvis Hub ----------

  /** Runs `fn` between passes (never during one), so the Hub and the daemon never edit state at the same time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** What the Jarvis Hub (`startJarvisHub`) talks to. Chat and voice reach the Chief of Staff; only `decide` resolves items. */
  hubBackend(): HubBackend {
    return {
      chat: (text, o) => this.hubChat(text, o?.voice === true),
      state: () => this.hubState(),
      decide: (ref, verdict, note) => this.hubDecide(ref, verdict, note),
      pauseTrust: (reason) => this.hubTrust(async () => {
        await this.loop.trust.pause(reason ?? 'paused from the Hub');
        return "Paused. I won't do anything on my own — every action asks you first until you resume.";
      }),
      resumeTrust: () => this.hubTrust(async () => {
        const was = await this.loop.trust.isPaused();
        await this.loop.trust.resume();
        return was ? 'Resumed. Actions that earned it run on their own again (and I tell you when they do).' : "Autonomy wasn't paused — nothing changed.";
      }),
      setTrustMode: (action, mode) => this.hubSetTrustMode(action, mode),
      cancelMission: (id) => this.hubCancelMission(id),
    };
  }

  /** v23: a Hub trust change, said back in the chat history too. */
  private hubTrust(fn: () => Promise<string>): Promise<HubDecision> {
    return this.exclusive(async () => {
      let text: string;
      try {
        text = await fn();
      } catch (err) {
        return { ok: false, code: 400, message: oneLine(message(err)) };
      }
      await appendChatTurns(this.loop.dir, [{ role: 'assistant', text, at: this.now().toISOString() }]).catch(() => undefined);
      return { ok: true, message: text };
    });
  }

  /** v23: the Hub's one-tap Promote / Demote (the Hub already required `confirm: true`). */
  private hubSetTrustMode(action: string, mode: TrustMode): Promise<HubDecision> {
    return this.hubTrust(async () => {
      const t = assertActionType(action);
      const before = await this.loop.trust.get(t);
      const r = await this.loop.trust.setMode(t, mode);
      const paused = await this.loop.trust.isPaused();
      if (before.autonomy === r.autonomy) return `${t} is already at ${mode}.`;
      const what =
        mode === 'blocked'
          ? `${t} is blocked: it never runs.`
          : mode === 'check'
            ? `${t} is back to check: I'll ask you first every time.`
            : mode === 'auto_notify'
              ? `${t} now runs on its own and tells you each time.`
              : `${t} now runs on its own, quietly (it's still in the audit log).`;
      return paused && (mode === 'auto_notify' || mode === 'autonomous') ? `${what} Autonomy is paused, so it still asks until you resume.` : what;
    });
  }

  /** v23: the Hub's Cancel button on a mission. */
  private hubCancelMission(id: string): Promise<HubDecision> {
    return this.exclusive(async () => {
      try {
        const { record, cancelled } = await cancelMission(this.loop.dir, id, this.now());
        return cancelled
          ? { ok: true, message: `Cancelled mission ${record.id}.`, status: record.status }
          : { ok: false, code: 409, message: `Mission ${record.id} already ${record.status}.`, status: record.status };
      } catch (err) {
        return { ok: false, code: 404, message: oneLine(message(err)) };
      }
    });
  }

  /** v23: the kill switch and every action's rung, plus the standard external write tools (at `check` until changed). */
  private async hubTrustState(): Promise<HubTrust> {
    const file = await this.loop.trust.load();
    const actions = new Map(Object.values(file.actions).map((r) => [r.actionType, { action: r.actionType, mode: r.autonomy, cleanStreak: r.consecutiveClean, ...(r.promotionSuggested ? { promotionSuggested: true } : {}) }]));
    for (const t of this.loop.tools.list()) {
      if (t.readOnly || !(isExternalWriteTool(t.name) || (t.sensitivity ?? []).includes('external'))) continue;
      const action = `chief.${t.name}`;
      if (!actions.has(action)) actions.set(action, { action, mode: 'check' as TrustMode, cleanStreak: 0 });
    }
    return { paused: file.paused === true, ...(file.paused && file.pauseReason ? { pauseReason: file.pauseReason } : {}), actions: [...actions.values()].sort((a, b) => a.action.localeCompare(b.action)) };
  }

  /** v23: active missions, then the most recent finished ones. */
  private async hubMissions(): Promise<HubMission[]> {
    const all = await listMissions(this.loop.dir);
    const shown = [...all.filter(isActiveMission), ...all.filter((m) => !isActiveMission(m)).slice(0, 5)];
    return shown.map((m) => ({ id: m.id, goal: m.goal, status: m.status, stepsCount: m.steps.length, ...(m.resultText ? { resultText: m.resultText } : {}) }));
  }

  /** v23: the last 15 audit entries, newest first. */
  private async hubAudit(): Promise<HubAuditEntry[]> {
    return (await loadAudit(this.loop.dir, { limit: 15 })).reverse().map((e) => ({
      id: e.id,
      at: e.at,
      action: e.action,
      ...(e.tool ? { tool: e.tool } : {}),
      summary: e.summary,
      approval: e.approval,
      trustMode: e.trustMode,
      ok: e.ok,
      ...(e.error ? { error: e.error } : {}),
    }));
  }

  /**
   * A Hub chat turn (typed or spoken): always conversation. Like Telegram chat, it can only QUEUE a side effect as a
   * Verify item; nothing it says is ever read as an approval. The queued item is planned right away so it shows up.
   */
  private hubChat(text: string, spoken = false): Promise<{ text: string; bubbles?: string[]; queued?: string[] }> {
    return this.exclusive(async () => {
      if (!this.chief) return { text: 'Chat is off on this Rufus.' };
      const state = await loadStartState(this.loop.dir);
      state.lastHumanAt = this.now().toISOString();
      if (state.think) state.think.unanswered = 0;
      await saveStartState(this.loop.dir, state);
      // v23: a live call answers in short spoken sentences, on the fast provider.
      const reply = await this.chief.handle(text, spoken ? { spoken: true } : {});
      if (this.chief.drainQueued()) {
        const again = await this.loop.runOnce().catch(() => undefined);
        for (const r of again?.runs ?? []) if (r.actionType?.startsWith('chief.')) this.followUps.add(r.runId);
      }
      const shown = reply.silent ? '' : reply.react ? reply.react : reply.text;
      return { text: shown, ...(reply.bubbles && !reply.silent && !reply.react ? { bubbles: reply.bubbles } : {}), ...(reply.queued?.length ? { queued: reply.queued } : {}) };
    });
  }

  private async hubState(): Promise<HubState> {
    const now = this.now();
    const [anchor, pending, state, chat, trust, missions, audit] = await Promise.all([
      loadAnchor(this.loop.dir, now),
      this.loop.pending(),
      loadStartState(this.loop.dir),
      loadChatHistory(this.loop.dir, 60).catch(() => []),
      this.hubTrustState(),
      this.hubMissions().catch(() => []),
      this.hubAudit().catch(() => []),
    ]);
    const numbers = assignNumbers(state, pending); // a read: the numbers a pass would give, not saved
    const block = (b: ScheduleBlock): HubBlock => ({ start: b.start, end: b.end, title: b.title, kind: b.kind, status: b.status });
    const { current, next } = scheduleNow(anchor, now);
    const items: HubItem[] = [...pending]
      .sort((a, b) => Number(b.urgency === 'urgent') - Number(a.urgency === 'urgent') || (numbers[a.id] ?? 0) - (numbers[b.id] ?? 0))
      .map((r) => ({
        id: r.id,
        ...(numbers[r.id] !== undefined ? { n: numbers[r.id] } : {}),
        stage: r.status === 'awaiting_human_plan' ? 'plan' : r.status === 'awaiting_human_execute' ? 'execute' : 'verify',
        urgent: r.urgency === 'urgent',
        text: formatLoopItem(r, numbers[r.id] ?? 0, { multi: true, hint: false }),
      }));
    const today = anchor.schedule.date === localDate(now) ? [...anchor.schedule.blocks].sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start)) : [];
    return { now: now.toISOString(), ...(current ? { current: block(current) } : {}), ...(next ? { next: block(next) } : {}), schedule: today.map(block), pending: items, chat, trust, missions, audit };
  }

  /** The Hub's Approve / Reject buttons. `ref` is a run id, or `n` / `#n` as shown in chat. */
  private hubDecide(ref: string, verdict: 'accept' | 'reject', note?: string): Promise<HubDecision> {
    return this.exclusive(async () => {
      const state = await loadStartState(this.loop.dir);
      const pending = await this.loop.pending();
      assignNumbers(state, pending);
      const short = /^#?(\d{1,4})$/.exec(ref.trim());
      const target = short ? pending.find((r) => state.numbers[r.id] === Number(short[1])) : pending.find((r) => r.id === ref.trim());
      if (!target) return { ok: false, code: 404, message: `Nothing is waiting as ${short ? `#${short[1]}` : ref}.` };
      const n = state.numbers[target.id];
      const stage = target.status;
      let result;
      try {
        result = await this.loop.resolveHumanDecision(target.id, { verdict, ...(note ? { note } : {}) });
      } catch (err) {
        return { ok: false, code: 409, message: `Couldn't apply that to #${n}: ${oneLine(message(err))}` };
      }
      const after = result.run;
      state.delivered = state.delivered.filter((id) => id !== target.id);
      if (state.lastItem === target.id) delete state.lastItem;
      if (['awaiting_human_plan', 'awaiting_human_execute', 'awaiting_human_verify'].includes(after.status)) this.followUps.add(target.id);
      await saveStartState(this.loop.dir, state);
      const what =
        stage === 'awaiting_human_execute'
          ? verdict === 'accept' ? `#${n} marked done.` : `#${n} dropped.`
          : verdict === 'accept'
            ? `#${n} approved.${after.committed ? ' Done.' : ''}${after.commitError ? ` Not applied: ${oneLine(after.commitError)}` : ''}`
            : `#${n} rejected.`;
      await appendChatTurns(this.loop.dir, [{ role: 'assistant', text: what, at: this.now().toISOString() }]).catch(() => undefined);
      return { ok: true, message: what, status: after.status, committed: !!after.committed };
    });
  }
}
