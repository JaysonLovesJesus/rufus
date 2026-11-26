// Operator code gate: a ship report is only allowed out when real checks ran and passed.
// verify(report, { checks: [{ name, ok }] }) -> { ok, reason?, problems }

const CLAIMS_DONE = /\b(?:shipped|done|deployed|merged|released|live|finished|complete[d]?)\b/i;
const VERIFIED_LINE = /^\s*(?:\*\*)?verified(?:\*\*)?\s*:\s*\S/im;
const SHIPPED_LINE = /^\s*(?:\*\*)?shipped(?:\*\*)?\s*:\s*\S/im;

/**
 * @param {string} report
 * @param {{ checks?: Array<{ name: string, ok: boolean }> }} [ctx]
 */
export function verify(report, ctx = {}) {
  const text = String(report ?? '');
  const checks = Array.isArray(ctx.checks) ? ctx.checks : [];
  const problems = [];
  if (!checks.length) problems.push('No code-gated checks ran. Run the build/tests (or fetch the live URL) before reporting.');
  const failed = checks.filter((c) => !c || c.ok !== true).map((c) => c?.name ?? 'unnamed check');
  if (failed.length && CLAIMS_DONE.test(text)) problems.push(`Claims done while ${failed.join(', ')} failed. Report the failure, not a win.`);
  if (!SHIPPED_LINE.test(text)) problems.push('Missing a "Shipped:" line saying what changed for the person.');
  if (!VERIFIED_LINE.test(text)) problems.push('Missing a "Verified:" line naming the checks that passed.');
  return problems.length ? { ok: false, reason: problems.join(' '), problems } : { ok: true, problems };
}

export default verify;
