import { createHash } from 'node:crypto';
import { CardBridge, type IncomingMessage, type LiveChannel, type TickReport } from '../channels/bridge';
import { ChiefOfStaff } from '../chief/chief';
import type { Engine } from '../engine/engine';
import type { HumanDecision, LoopRun, LoopRunStatus, LoopTickReport, MasterLoop } from '../engine/loop';
import type { Verdict } from '../engine/trust';
import { formatCheckin, formatLoopItem, parseLoopReply, type LoopReply } from './loop-text';
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
  /** Problems this pass; the next pass retries. */
  errors: string[];
}

export const DEFAULT_CHECKIN_MS = 2 * 3_600_000;
const KEEP_HANDLED = 500;
const KEEP_SENT = 100;

const hash = (text: string): string => createHash('sha1').update(text.trim()).digest('hex');
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const oneLine = (s: string, max = 200): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Hands the CardBridge only what the daemon did not consume, and sends through the daemon (so echoes are known). */
class RelayChannel implements LiveChannel {
  inbox: IncomingMessage[] = [];
  constructor(private readonly sendText: (text: string) => Promise<void>) {}
  async send(text: string): Promise<void> {
    await this.sendText(text);
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
    this.chief = opts.chief === false ? undefined : (opts.chief ?? new ChiefOfStaff({ engine: this.engine, loop: this.loop }));
    if (this.channel) {
      this.relay = new RelayChannel((text) => this.say(text));
      this.bridge = new CardBridge({ engine: this.engine, channel: this.relay, chief: this.chief ?? false, workspaceDir: this.loop.dir, now: this.now });
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
    } finally {
      await this.persist();
      this.current = undefined;
      this.chatCheckin = false;
    }
    return report;
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
      await this.handleIncoming(state, msg, text, report);
    }
  }

  private async handleIncoming(state: StartState, msg: IncomingMessage, text: string, report: StartTickReport): Promise<void> {
    const parsed: LoopReply | undefined = parseLoopReply(text);
    if (parsed?.kind === 'checkin') {
      this.chatCheckin = true;
      return;
    }
    const pending = await this.loop.pending();
    assignNumbers(state, pending);
    const delivered = pending.filter((r) => state.delivered.includes(r.id)).sort((a, b) => (state.numbers[a.id] ?? 0) - (state.numbers[b.id] ?? 0));
    const passOn = (): void => void this.relay!.inbox.push(msg);

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
      if (!delivered.length) return passOn();
      if ((await this.engine.pending()).length) return passOn(); // a flow card is open too: plain answers go to it, loop items need "#n"
      if (delivered.length > 1) {
        const n = state.numbers[delivered[0]!.id];
        return this.say(`${delivered.length} items are waiting. Start with the number, like "#${n} 1" or "#${n} 2".`);
      }
      return this.decide(state, delivered[0]!, parsed, report);
    }

    // Plain typed text right after a lone item is your edit of it ("or type your edit"). Questions and commands are chat.
    const lone = delivered.length === 1 && state.lastItem === delivered[0]!.id ? delivered[0]! : undefined;
    if (lone && lone.status !== 'awaiting_human_execute' && !/\?\s*$/.test(text) && !this.chief?.isCommand(text) && !(await this.engine.pending()).length) {
      return this.decide(state, lone, { kind: 'decision', verdict: 'edit', edit: text }, report);
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
      result = await this.loop.resolveHumanDecision(run.id, decision);
    } catch (err) {
      return this.say(`Couldn't apply that to #${n}: ${oneLine(message(err))}`);
    }
    const after = result.run;
    report.decided.push({ runId: run.id, n, verdict: reply.verdict, status: after.status });
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
      if (normal.length === 1 && !multi) state.lastItem = normal[0]!.id;
      else delete state.lastItem;
      state.lastCheckinAt = now.toISOString();
      report.checkin.push(...normal.map((r) => r.id));
    } else {
      report.batched.push(...normal.map((r) => r.id));
    }
  }

  /** Records what we send (so its echo is ignored), then sends it, or prints it when there is no channel. */
  private async say(text: string): Promise<void> {
    const state = this.current;
    if (state) {
      state.sent = [...state.sent, hash(text)].slice(-KEEP_SENT);
      await this.persist();
    }
    if (this.channel) await this.channel.send(text);
    else this.output(text);
  }
}
