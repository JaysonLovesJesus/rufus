import type { Engine } from '../engine/engine';
import type { Flow, RunResult } from '../types';
import {
  isQuiet,
  parseClock,
  parseDuration,
  type QuietHours,
  type Trigger,
  type TriggerContext,
} from './triggers';

export type TickStatus = 'ran' | 'not-due' | 'quiet-hours' | 'gate-closed' | 'busy' | 'error';

export interface TickResult {
  flowId: string;
  status: TickStatus;
  /** Present when `status` is `ran`. */
  run?: RunResult;
  /** Present when `status` is `error`. */
  error?: string;
}

interface FlowState {
  /** When the flow last actually started. */
  lastRunAt?: string;
  /** When a due trigger was last handled (started, gated off, or skipped as busy). Drives dedup. */
  lastCheckAt?: string;
  state?: Record<string, unknown>;
}

interface SchedulerFile {
  version: 1;
  flows: Record<string, FlowState>;
}

type Triggered = Exclude<Trigger, { type: 'manual' }>;

/**
 * The heartbeat. `tick()` is one deterministic pass: for each flow with a trigger, work out if it is
 * due and, if so, whether a free code gate says to go. Only then does a run (and maybe AI) start.
 * Run it from cron/launchd (`rufus tick`) or keep it alive with `startLoop()` (`rufus watch`).
 *
 * State lives in `<workspace>/scheduler.json`, so a restart never fires the same slot twice.
 */
export class Scheduler {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly engine: Engine) {}

  /** One pass over every `at` / `every` flow. Passes never overlap within a process. */
  tick(now: Date = new Date()): Promise<TickResult[]> {
    return this.serial(async () => {
      const file = await this.load();
      const quiet = await this.quietHours();
      const results: TickResult[] = [];
      for (const flow of this.triggered()) {
        const trigger = flow.meta.trigger as Triggered;
        if (trigger.type === 'event') continue;
        const st = (file.flows[flow.meta.id] ??= {});
        results.push(await this.handle(flow, trigger, st, file, now, quiet, () => this.isDue(trigger, st, now)));
      }
      return results;
    });
  }

  /** Fire `onEvent(name)` flows. Quiet hours and `when` gates apply; a suppressed event is dropped. */
  emit(name: string, payload?: unknown, now: Date = new Date()): Promise<TickResult[]> {
    return this.serial(async () => {
      const file = await this.load();
      const quiet = await this.quietHours();
      const results: TickResult[] = [];
      for (const flow of this.triggered()) {
        const trigger = flow.meta.trigger as Triggered;
        if (trigger.type !== 'event' || trigger.name !== name) continue;
        const st = (file.flows[flow.meta.id] ??= {});
        results.push(await this.handle(flow, trigger, st, file, now, quiet, () => true, { name, payload }));
      }
      return results;
    });
  }

  /** Tick now, then every `intervalMs` (default 60s) until `stop()`. Errors go to `onError`. */
  startLoop(
    opts: { intervalMs?: number; onTick?: (results: TickResult[]) => void; onError?: (err: Error) => void } = {},
  ): { stop(): Promise<void> } {
    const intervalMs = opts.intervalMs ?? 60_000;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let inFlight: Promise<void> = Promise.resolve();

    const pass = async () => {
      try {
        const results = await this.tick();
        opts.onTick?.(results);
      } catch (err) {
        opts.onError?.(err as Error);
      }
      if (!stopped) timer = setTimeout(() => (inFlight = pass()), intervalMs);
    };
    inFlight = pass();

    return {
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        await inFlight;
      },
    };
  }

  // ---------- internals ----------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private triggered(): Flow[] {
    return this.engine.listFlows().filter((f) => f.meta.trigger && f.meta.trigger.type !== 'manual');
  }

  private async load(): Promise<SchedulerFile> {
    const file = await this.engine.store.readJson<SchedulerFile>(this.engine.store.schedulerFile, {
      version: 1,
      flows: {},
    });
    file.flows ??= {};
    return file;
  }

  private async quietHours(): Promise<QuietHours | undefined> {
    const quiet = (await this.engine.store.loadConfig()).quietHours;
    if (quiet) {
      parseClock(quiet.start);
      parseClock(quiet.end);
    }
    return quiet;
  }

  private isDue(trigger: Triggered, st: FlowState, now: Date): boolean {
    const last = st.lastCheckAt ? Date.parse(st.lastCheckAt) : undefined;
    if (trigger.type === 'every') return last === undefined || now.getTime() - last >= parseDuration(trigger.interval);
    if (trigger.type === 'at') {
      const mins = parseClock(trigger.time);
      const slot = new Date(now);
      slot.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
      return now >= slot && (last === undefined || last < slot.getTime());
    }
    return false;
  }

  /** The shared decision path: due? quiet? busy? gate? then start. Never throws. */
  private async handle(
    flow: Flow,
    trigger: Triggered,
    st: FlowState,
    file: SchedulerFile,
    now: Date,
    quiet: QuietHours | undefined,
    due: () => boolean,
    event?: { name: string; payload?: unknown },
  ): Promise<TickResult> {
    const flowId = flow.meta.id;
    const stamp = now.toISOString();
    try {
      if (!due()) return { flowId, status: 'not-due' };
      // Not recorded as checked, so the slot is still owed once quiet hours end.
      if (isQuiet(now, quiet) && !trigger.urgent) return { flowId, status: 'quiet-hours' };

      if (!event) st.lastCheckAt = stamp;
      if (!trigger.allowOverlap && (await this.isWaitingOnHuman(flowId))) {
        await this.save(file);
        return { flowId, status: 'busy' };
      }

      const state = trigger.when ? (st.state ??= {}) : {};
      const ctx: TriggerContext = {
        flowId,
        now,
        ...(st.lastRunAt ? { lastRunAt: st.lastRunAt } : {}),
        ...(event ? { event } : {}),
        store: this.engine.store,
        state,
      };
      if (trigger.when) {
        let go: boolean;
        try {
          go = await trigger.when(ctx);
        } finally {
          await this.save(file); // keep whatever the gate wrote to `state` and the check time
        }
        if (!go) return { flowId, status: 'gate-closed' };
      }

      const input = typeof trigger.input === 'function' ? trigger.input(ctx) : (trigger.input ?? event?.payload);
      // Claim the slot before starting, so a crash mid-run can't cause a double fire on restart.
      st.lastRunAt = stamp;
      await this.save(file);
      return { flowId, status: 'ran', run: await this.engine.start(flowId, input) };
    } catch (err) {
      return { flowId, status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async isWaitingOnHuman(flowId: string): Promise<boolean> {
    return (await this.engine.store.listRuns()).some((r) => r.flowId === flowId && r.status === 'waiting_human');
  }

  private save(file: SchedulerFile): Promise<void> {
    return this.engine.store.writeJson(this.engine.store.schedulerFile, file);
  }
}
