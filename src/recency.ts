// Recency weighting shared by history analysis and the life-context corpus. Pure arithmetic, no I/O.
// Exponential decay: an event `halfLifeDays` old counts half as much as one from today, two half-lives old a quarter.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Anything `Date` can read: an ISO string, epoch milliseconds, or a `Date`. */
export type TimeLike = string | number | Date | undefined;

export interface RecencyOptions {
  /** Reference "today" (default: the current time). Only matters for absolute weights; ranking shares are scale-free. */
  now?: TimeLike;
  /** Days for a weight to halve. `0`, a negative number or `Infinity` turns weighting off. */
  halfLifeDays?: number;
}

/** Epoch milliseconds for a time-like value, or `undefined` when missing or unreadable. */
export function toMs(t: TimeLike): number | undefined {
  if (t === undefined || t === null || t === '') return undefined;
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(ms) ? ms : undefined;
}

/** A usable half-life, or `undefined` when weighting is off (non-positive or infinite). */
export function resolveHalfLife(days: number | undefined, fallback: number): number | undefined {
  const h = days ?? fallback;
  return Number.isFinite(h) && h > 0 ? h : undefined;
}

/**
 * Weight in (0, 1]. Undated and future items count fully (we cannot call them old), so a missing timestamp never
 * silently erases evidence; with no half-life every item weighs 1.
 */
export function recencyWeight(at: TimeLike, nowMs: number, halfLifeDays: number | undefined): number {
  if (halfLifeDays === undefined) return 1;
  const ms = toMs(at);
  if (ms === undefined) return 1;
  const ageDays = Math.max(0, (nowMs - ms) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Rank-based weights for fast shifts: the newest item weighs 1, the one `halfLifeObservations` places older weighs 0.5,
 * and so on, whether those items span two days or two months. `times` are in any order; undated items rank oldest and
 * ties go to the later index. Returns one weight per input, in input order.
 */
export function rankWeights(times: TimeLike[], halfLifeObservations: number): number[] {
  const newestFirst = times
    .map((t, i) => ({ i, t: toMs(t) ?? -Infinity }))
    .sort((a, b) => (a.t === b.t ? b.i - a.i : a.t > b.t ? -1 : 1));
  const out = new Array<number>(times.length).fill(1);
  newestFirst.forEach((e, rank) => {
    out[e.i] = Math.pow(0.5, rank / halfLifeObservations);
  });
  return out;
}

export type RecencyMode = { kind: 'off' } | { kind: 'days'; half: number } | { kind: 'rank'; half: number };

/**
 * Pick the weighting mode. Evidence pace is the default: a valid `halfLifeObservations` wins, then an explicitly passed
 * `halfLifeDays` (`0`/`Infinity` = off), else `defaultObservations`. A wall-clock timer only applies when asked for.
 */
export function resolveRecencyMode(opts: { halfLifeDays?: number; halfLifeObservations?: number }, defaultObservations: number): RecencyMode {
  const obs = opts.halfLifeObservations;
  if (obs !== undefined && Number.isFinite(obs) && obs > 0) return { kind: 'rank', half: obs };
  if (opts.halfLifeDays !== undefined) {
    const half = resolveHalfLife(opts.halfLifeDays, opts.halfLifeDays);
    return half === undefined ? { kind: 'off' } : { kind: 'days', half };
  }
  return { kind: 'rank', half: defaultObservations };
}
