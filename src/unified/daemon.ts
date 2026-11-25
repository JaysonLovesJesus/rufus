import { createHash } from 'node:crypto';
import { CardBridge, type IncomingMessage, type LiveChannel, type TickReport } from '../channels/bridge';
import { loadAnchor, localDate } from '../anchor/anchor';
import { chiefActionHandler } from '../chief/actions';
import { ChiefOfStaff } from '../chief/chief';
import { appendChatTurns } from '../chief/history';
import { inboxSensor } from '../engine/loop-builtins';
import { ANCHOR_TOOL, anchorUpdateTool } from '../tools/anchor-tool';
import type { Engine } from '../engine/engine';
import { DEFAULT_PENDING_TTL_MS, type HumanDecision, type LoopRun, type LoopRunStatus, type LoopTickReport, type MasterLoop } from '../engine/loop';
import type { Verdict } from '../engine/trust';
import { clip } from '../corpus/types';
import { REMEMBER_TOOL, rememberTool } from '../chief/learning';
import { draftOf, formatCheckin, formatLoopItem, isBareVerdict, parseLoopReply, recipientOf, refOf, type LoopReply } from './loop-text';
import { freshThinkState, think, thinkSkipReason, type ThinkOptions } from './think';
import { acceptNudge, blocksToNudge, DEFAULT_LEAD_MINUTES, DEFAULT_QUIET_HOURS, formatMorningBrief, formatNudge, inQuietHours, isMorning, markNudged, nudgePrompt, phoneSignalHandler, type HeartbeatOptions } from './heartbeat';
import type { ScheduleBlock } from '../anchor/anchor';
import { nowSummary } from './now';
import { assignNumbers, loadStartState, saveStartState, takeCheckinRequest, type StartState } from './state';

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
  now?: () => Date;
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
  /** Problems this pass; the next pass retries. */
  errors: string[];
}

export const DEFAULT_CHECKIN_MS = 2 * 3_600_000;
const KEEP_HANDLED = 500;
const KEEP_SENT = 100;
/** A think-beat never interrupts a live conversation: it waits until the human has been quiet this long. */
const CONVERSATION_QUIET_MS = 5 * 60_000;

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
    private readonly sendText: (text: string, relayed: boolean) => Promise<void>,
    private readonly real: LiveChannel,
  ) {}
  async send(text: string): Promise<void> {
    await this.sendText(text, true);
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
    this.pendingTtlMs = opts.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.bubblePauseMs = Math.max(0, opts.bubblePauseMs ?? 350);
    // Your schedule and goals are editable from chat ("remove the study block"): private and local, so no Verify item.
    if (!this.loop.tools.has(ANCHOR_TOOL)) this.loop.tools.register(anchorUpdateTool());
    // Corrections, preferences and facts said in chat are saved as feedback the next triage/chat pass learns from.
    if (!this.loop.tools.has(REMEMBER_TOOL)) this.loop.tools.register(rememberTool());
    this.chief = opts.chief === false ? undefined : (opts.chief ?? new ChiefOfStaff({ engine: this.engine, loop: this.loop, tools: this.loop.tools, ...(opts.now ? { now: opts.now } : {}) }));
    // Side effects asked for in chat become Verify items; phone context signals are recorded silently.
    if (!this.loop.listHandlers().some((h) => h.id === chiefActionHandler.id)) this.loop.addHandler(chiefActionHandler);
    if (!this.loop.listHandlers().some((h) => h.id === phoneSignalHandler.id)) this.loop.addHandler(phoneSignalHandler);
    if (this.chief?.hasTools && !this.loop.listSensors().some((x) => x.id === 'inbox')) this.loop.addSensor(inboxSensor(this.loop.dir));
    if (this.channel) {
      this.relay = new RelayChannel((text, relayed) => this.say(text, relayed), this.channel);
      this.bridge = new CardBridge({
        engine: this.engine,
        channel: this.relay,
        chief: this.chief ?? false,
        workspaceDir: this.loop.dir,
        now: this.now,
        ...(opts.bubblePauseMs !== undefined ? { bubblePauseMs: opts.bubblePauseMs } : {}),
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

  // ---------- internals ----------

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
      } catch (err) {
        report.errors.push(`loop: ${message(err)}`);
      }
      try {
        await this.deliver(state, report);
      } catch (err) {
        report.errors.push(`deliver: ${message(err)}`);
      }
      if (this.bridge) {
        report.bridge = await this.bridge.tick();
        if (report.bridge.error) report.errors.push(`channel: ${report.bridge.error}`);
      }
      // Chat queued an action ("send Sam ..."): plan and deliver it now, so its "1" works right after the reply.
      if (this.chief?.drainQueued()) {
        try {
          const again = await this.loop.runOnce();
          for (const e of again.errors) report.errors.push(`sensor ${e.sensorId}: ${e.error}`);
          for (const r of again.runs) if (r.actionType?.startsWith('chief.')) this.followUps.add(r.runId);
          await this.deliver(state, report);
        } catch (err) {
          report.errors.push(`loop: ${message(err)}`);
        }
      }
      if (this.heartbeat) {
        try {
          await this.heartbeatPass(state, report, this.heartbeat);
        } catch (err) {
          report.errors.push(`heartbeat: ${message(err)}`);
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
        await this.say(text);
        sent.push(text);
      }
    }

    for (const block of blocksToNudge(anchor, now, state.nudged ?? [], hb.leadMinutes ?? DEFAULT_LEAD_MINUTES)) {
      state.nudged = markNudged(state.nudged, anchor, block);
      const text = hb.phrasing === 'ai' ? await this.phraseNudge(block, now) : formatNudge(block, now);
      await this.say(text);
      sent.push(text);
    }
    if (sent.length) report.proactive = [...(report.proactive ?? []), ...sent];
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
    const provider = this.engine.routeProvider(opts.provider ? { provider: opts.provider } : { tier: 'fast' });
    const r = await think({ provider, dir: this.loop.dir, loop: this.loop, now, tools: this.loop.tools, ...(opts.tools ? { glance: opts.tools } : {}), ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}) });
    if (!r.bubbles) {
      report.thought = 'silent';
      return;
    }
    await this.channel?.typing?.().catch(() => undefined);
    for (const [i, bubble] of r.bubbles.entries()) {
      if (i && this.bubblePauseMs) await new Promise((resolve) => setTimeout(resolve, this.bubblePauseMs));
      await this.say(bubble, false, true);
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
    const pending = await this.loop.pending();
    assignNumbers(state, pending);
    const delivered = pending.filter((r) => state.delivered.includes(r.id)).sort((a, b) => (state.numbers[a.id] ?? 0) - (state.numbers[b.id] ?? 0));
    const passOn = (): void => void this.relay!.inbox.push(msg);
    // With a flow card open, bare answers belong to the card: loop items then need "#n".
    const cardsOpen = (await this.engine.pending()).length > 0;
    const parsed: LoopReply | undefined = parseLoopReply(text, cardsOpen ? 0 : delivered.length);
    if (parsed?.kind === 'checkin') {
      this.chatCheckin = true;
      return;
    }

    if (parsed?.kind === 'decision') {
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
  private async say(text: string, relayed = false, record = false): Promise<void> {
    const state = this.current;
    if (state) {
      state.sent = [...state.sent, hash(text)].slice(-KEEP_SENT);
      await this.persist();
    }
    if (this.channel) await this.channel.send(text);
    else this.output(text);
    if (!relayed && (this.chief || record)) await appendChatTurns(this.loop.dir, [{ role: 'assistant', text, at: this.now().toISOString() }]).catch(() => undefined);
  }
}
