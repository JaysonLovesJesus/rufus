// boundaries.mjs - Layer 3 boundaries as code: invariants no model can talk its way around.
// Pure, no dependencies, no I/O. Rufus's own Earned Trust and quiet hours still apply; this is your personal floor.

/** Default quiet hours (local time). The window may wrap midnight. Override per call with `ctx.quietHours`. */
export const DEFAULT_QUIET_HOURS = { start: '22:00', end: '07:00' };

/** Sensitivities that always need a fresh human yes, however much trust an action has earned. */
export const ALWAYS_ASK = ['money', 'login'];

const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) throw new Error(`Quiet hours need "HH:MM", not "${hhmm}".`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** True when `now` falls inside the quiet window `{ start, end }` (local time). */
export function isQuietHours(now = new Date(), quiet = DEFAULT_QUIET_HOURS) {
  if (!quiet) return false;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/**
 * May Rufus act right now, on its own? `{ ok: true }` or `{ ok: false, reason, ask }` where `ask` is true when the
 * answer is "ask the human first" (not "never").
 * @param {{ now?: Date, quietHours?: { start: string, end: string } | null, sensitivity?: string[],
 *           urgent?: boolean, approved?: boolean, action?: string }} [ctx]
 */
export function canActNow(ctx = {}) {
  const action = ctx.action ? `"${ctx.action}"` : 'This action';
  const sensitive = (ctx.sensitivity ?? []).filter((s) => ALWAYS_ASK.includes(s));
  if (sensitive.length && ctx.approved !== true) {
    return { ok: false, ask: true, reason: `${action} touches ${sensitive.join(' and ')}: always ask first, whatever its trust level.` };
  }
  const quiet = ctx.quietHours === undefined ? DEFAULT_QUIET_HOURS : ctx.quietHours;
  if (!ctx.urgent && isQuietHours(ctx.now ?? new Date(), quiet)) {
    return { ok: false, ask: false, reason: `Quiet hours (${quiet.start}-${quiet.end}): ${ctx.action ? `"${ctx.action}"` : 'this'} waits until they end, unless it is urgent.` };
  }
  return { ok: true };
}

export default canActNow;
