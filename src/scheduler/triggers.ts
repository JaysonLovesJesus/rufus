import type { FileStore } from '../store';

/** What a `when` gate gets to look at. Keep gates cheap, exact and free: this is pure code. */
export interface TriggerContext {
  flowId: string;
  now: Date;
  /** When this flow last actually started, if ever. */
  lastRunAt?: string;
  /** Set only for `onEvent` triggers. */
  event?: { name: string; payload?: unknown };
  /** The workspace, for reading files you keep there. */
  store: FileStore;
  /**
   * Small JSON memory for this flow, saved in `scheduler.json`. Use it to notice change:
   * `const prev = ctx.state.count; ctx.state.count = n; return n !== prev;`
   */
  state: Record<string, unknown>;
}

export interface TriggerOptions {
  /**
   * Deterministic gate, checked when the trigger is due. Return false and the flow is not started:
   * no run, no AI call, $0.00. Most ticks should end here.
   */
  when?: (ctx: TriggerContext) => boolean | Promise<boolean>;
  /** Run even during quiet hours. */
  urgent?: boolean;
  /** Input for the run. A function gets the trigger context. Events default to their payload. */
  input?: unknown | ((ctx: TriggerContext) => unknown);
  /** By default a trigger will not start a flow that is still waiting on a human. */
  allowOverlap?: boolean;
}

export type Trigger =
  | { type: 'manual' }
  | ({ type: 'at'; time: string } & TriggerOptions)
  | ({ type: 'every'; interval: string } & TriggerOptions)
  | ({ type: 'event'; name: string } & TriggerOptions);

/** Once a day at a local "HH:MM". If a tick is late it still runs, once. */
export const at = (time: string, opts: TriggerOptions = {}): Trigger => validateTrigger({ type: 'at', time, ...opts });
/** Every "30s", "30m", "2h" or "1d". */
export const every = (interval: string, opts: TriggerOptions = {}): Trigger =>
  validateTrigger({ type: 'every', interval, ...opts });
/** When `scheduler.emit(name, payload)` is called. */
export const onEvent = (name: string, opts: TriggerOptions = {}): Trigger =>
  validateTrigger({ type: 'event', name, ...opts });

/** "HH:MM" -> minutes since midnight. */
export function parseClock(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const h = m ? Number(m[1]) : NaN;
  const min = m ? Number(m[2]) : NaN;
  if (!m || h > 23 || min > 59) throw new Error(`Invalid time "${time}": use 24-hour "HH:MM", e.g. "08:00".`);
  return h * 60 + min;
}

/** "30s" | "30m" | "2h" | "1d" -> milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(text.trim());
  const n = m ? Number(m[1]) : 0;
  if (!m || n <= 0) throw new Error(`Invalid interval "${text}": use a number and s, m, h or d, e.g. "30m".`);
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

export function validateTrigger<T extends Trigger>(t: T): T {
  if (t.type === 'at') parseClock(t.time);
  else if (t.type === 'every') parseDuration(t.interval);
  else if (t.type === 'event') {
    if (!t.name.trim()) throw new Error('An onEvent trigger needs an event name.');
  } else if (t.type !== 'manual') {
    throw new Error(`Unknown trigger type "${(t as { type: string }).type}".`);
  }
  return t;
}

export interface QuietHours {
  /** Local "HH:MM". The window may wrap midnight, e.g. 22:00 to 07:00. */
  start: string;
  end: string;
}

export function isQuiet(now: Date, quiet: QuietHours | undefined): boolean {
  if (!quiet) return false;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === end) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return start < end ? mins >= start && mins < end : mins >= start || mins < end;
}
