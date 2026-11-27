import type { TelegramChannel } from '../channels/telegram';
import type { RufusCore } from '../daemon';
import type { BouncerDecision, LosslessEvent, MessageSink } from '../types';
import type { HeartbeatHub } from './connectors';
import { recordEditFeedback, recordReactionFeedback } from './feedback';
import { SenseHealth } from './health';
import { genericEvent } from './ingest';
import { DEFAULT_ROUTE, isOwnerInput, runWakeLoop, WakeInbox, type WakeBatch } from './inbox';

/** Prefixes every daemon log line with an ISO timestamp. */
export function stampConsole(): void {
  for (const name of ['log', 'error', 'warn'] as const) {
    const orig = console[name].bind(console);
    console[name] = (...args: unknown[]) => orig(`${new Date().toISOString()}`, ...args);
  }
}

export interface SenseRuntimeOptions {
  core: RufusCore;
  hub: HeartbeatHub;
  signal: AbortSignal;
  heartbeatMs: number;
  tg?: TelegramChannel;
  /** Tells the owner a wake on his message failed; defaults to the Telegram channel. */
  failureSink?: MessageSink;
}

export const WAKE_FAILURE_NOTE = 'Sorry, something broke on my side while I was on that, so it may not be done. Send it again if it still matters.';

/**
 * The daemon's runtime: senses and channels only ever push into one inbox; one wake loop drains it.
 * So polling never stops during a long wake, owner input runs first and can join the wake already running,
 * and every sense's health is tracked in `senses.json`.
 */
export function createSenseRuntime(opts: SenseRuntimeOptions) {
  const { core, hub, signal } = opts;
  const inbox = new WakeInbox();
  const health = new SenseHealth(core.workspaceDir);

  const feedbackDeps = {
    workspaceDir: core.workspaceDir,
    findSent: async (text: string) => (await core.events.recent(5000)).reverse().find((e) => e.kind === 'assistant_sent' && e.text.trim() === text.trim()),
    recordFeedback: (e: LosslessEvent, f: 'approval' | 'pushback') => core.recordFeedback(e, f),
  };

  /** Logs one event, runs the Bouncer, and queues a wake if it says WAKE. Undefined when already seen. */
  async function ingest(
    ev: LosslessEvent,
    item: { route?: string; sink?: MessageSink; sense?: string; waitForWake?: boolean } = {},
  ): Promise<BouncerDecision | undefined> {
    const decision = await core.sense(ev);
    if (item.sense) health.recordIngest(item.sense, ev, !!decision);
    if (!decision) return undefined;
    if (decision.label !== 'WAKE') {
      console.log(`[${ev.source}:${ev.id}] bouncer=SLEEP (${decision.backend}, ${decision.durationMs}ms)`);
      return decision;
    }
    let done: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => (done = resolve));
    inbox.push({ event: ev, decision, ...(item.route ? { route: item.route } : {}), ...(item.sink ? { sink: item.sink } : {}), done: done! });
    if (item.waitForWake) await finished;
    return decision;
  }

  async function tickSenses(): Promise<void> {
    // Each sense's events go in as soon as that sense answers, so a slow one never delays the rest.
    const { polls } = await hub.tick(Date.now(), async (p) => {
      health.recordPoll(p);
      if (!p.ok) console.error(`sense ${p.id} failed: ${p.error}`);
      for (const ev of p.events) {
        try {
          await ingest(ev, { sense: p.id });
        } catch (err) {
          console.error(`sense error on ${p.id}:${ev.id}: ${(err as Error).message}`);
        }
      }
    });
    for (const ev of health.transitions()) await ingest(ev).catch(() => undefined);
    if (!inbox.size && !waking) void recheckSlept();
    if (polls.length) await health.save().catch(() => undefined);
  }

  async function telegramLoop(tg: TelegramChannel): Promise<void> {
    while (!signal.aborted) {
      const t0 = Date.now();
      let incoming: LosslessEvent[] = [];
      try {
        incoming = await tg.poll(25);
        health.recordPoll({ id: 'telegram', intervalMs: 0, at: new Date(t0).toISOString(), ok: true, ms: Date.now() - t0, events: incoming, parseFailures: 0 });
      } catch (err) {
        health.recordPoll({ id: 'telegram', intervalMs: 0, at: new Date(t0).toISOString(), ok: false, ms: Date.now() - t0, events: [], parseFailures: 0, error: (err as Error).message });
        await pause(5000, signal); // network down: don't spin
        continue;
      }
      for (const ev of incoming) {
        try {
          // A redelivered update (offset not saved before a restart) was handled already: its feedback must not count twice.
          if (await core.events.has(ev.id)) {
            health.recordIngest('telegram', ev, false);
            continue;
          }
          if (ev.kind === 'owner_reaction') {
            const fb = await recordReactionFeedback({ ...feedbackDeps, reaction: ev });
            if (fb.label) console.log(`[${ev.id}] reaction feedback=${fb.label}${fb.sentId ? ` on ${fb.sentId}` : ''}`);
          } else if (ev.metadata?.editOf) {
            const fb = await recordEditFeedback({ ...feedbackDeps, edit: ev });
            if (fb.superseded.length) console.log(`[${ev.id}] edit supersedes ${fb.superseded.join(', ')}`);
          }
          await ingest(ev, { sense: 'telegram' });
        } catch (err) {
          console.error(`telegram ingest error on ${ev.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  let waking = false;

  /** While nothing waits, a cheap model re-checks what the Bouncer slept on; a miss wakes Rufus now, like any WAKE. */
  async function recheckSlept(): Promise<void> {
    try {
      for (const miss of await core.senseJudge.reviewSlept()) {
        console.log(`[${miss.event.source}:${miss.event.id}] re-check found a miss: ${miss.decision.reason ?? ''}`);
        inbox.push({ event: miss.event, decision: miss.decision, done: () => undefined });
      }
    } catch (err) {
      console.error(`slept re-check failed: ${(err as Error).message}`);
    }
  }

  async function wake(batch: WakeBatch, pollIncoming: () => Promise<LosslessEvent[]>): Promise<void> {
    waking = true;
    try {
      await wakeOnce(batch, pollIncoming);
    } finally {
      waking = false;
    }
  }

  async function wakeOnce(batch: WakeBatch, pollIncoming: () => Promise<LosslessEvent[]>): Promise<void> {
    const res = await core.processEvent(batch.first.event, {
      ...(batch.first.decision ? { decision: batch.first.decision } : {}),
      ...(batch.extras.length ? { additionalEvents: batch.extras.map((i) => i.event) } : {}),
      ...(batch.first.sink ? { sinkOverride: batch.first.sink } : {}),
      pollIncoming,
    });
    const ev = batch.first.event;
    console.log(
      `[${ev.source}:${ev.id}${batch.extras.length ? ` +${batch.extras.length}` : ''}] bouncer=${res.decision.label} (${res.decision.backend}, ${res.decision.durationMs}ms) turns=${res.wake?.turns ?? 0}${res.alreadySeen ? ' (already seen)' : ''}`,
    );
  }

  async function onWakeError(batch: WakeBatch, err: Error): Promise<void> {
    console.error(`wake error on ${batch.first.event.source}:${batch.first.event.id}: ${err.message}`);
    const owner = [batch.first, ...batch.extras].some((i) => isOwnerInput(i.event));
    const sink = batch.first.sink ?? opts.failureSink ?? opts.tg;
    if (!owner || !sink || core.shadow) return;
    // The note is a message to the owner: it goes out only if send_message's rung lets messages go out on their own.
    const talk = core.registry.get('send_message')?.manifest;
    const level = talk ? await core.registry.levelOf(talk) : 'never';
    if (level !== 'act_and_report' && level !== 'act_quietly') return;
    const sent = await sink.send(WAKE_FAILURE_NOTE).then((r) => r ?? {}, () => undefined);
    if (!sent) return;
    // Logged like any message Rufus sends, so the next wake's conversation shows the owner was told.
    const messageId = sent.messageId;
    await core.events
      .append(genericEvent({ source: 'message', kind: 'assistant_sent', actor: 'rufus', text: WAKE_FAILURE_NOTE, timestamp: new Date().toISOString(), ...(messageId ? { metadata: { messageId } } : {}) }))
      .catch(() => undefined);
  }

  async function run(): Promise<void> {
    await health.load();
    // Ticks may overlap: the hub skips any sense still polling from an earlier tick.
    const timer = setInterval(() => {
      if (signal.aborted) return;
      void tickSenses().catch((err) => console.error(`heartbeat error: ${(err as Error).message}`));
    }, Math.max(5000, opts.heartbeatMs));
    timer.unref?.();
    const tgDone = opts.tg ? telegramLoop(opts.tg) : Promise.resolve();
    try {
      // The restart wake runs first; owner messages that arrive meanwhile join it.
      await core
        .announceStartup({ pollIncoming: async () => inbox.drainOwner(DEFAULT_ROUTE) })
        .then((res) => console.log(`[${res.event.source}:${res.event.id}] startup bouncer=${res.decision.label} turns=${res.wake?.turns ?? 0}${res.wake?.endReason ? ` end=${res.wake.endReason}` : ''}`))
        .catch(async (err: Error) => {
          console.error(`startup error: ${err.message}`);
          // Owner messages that joined the restart wake get the same note as any other failed wake.
          const [first, ...extras] = inbox.joinedItems();
          if (first) await onWakeError({ first, extras, route: DEFAULT_ROUTE }, err).catch(() => undefined);
        });
      for (const i of inbox.joinedItems()) i.done?.();
      await runWakeLoop({ inbox, signal, wake, onError: onWakeError });
    } finally {
      clearInterval(timer);
      void tgDone.catch(() => undefined); // its long poll ends on its own within 25s
    }
  }

  return { inbox, health, ingest, tickSenses, run };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}
