// taste.mjs - Layer 3 taste as code. Rufus (and you) can run every draft through verifyDraft before it goes out.
// Pure, no dependencies, no I/O. Edit the lists below to match your own taste; `rufus setup --check` makes sure it
// still imports and runs.

/** Openers that flatter instead of answering. Matched at the very start of a draft. */
export const SYCOPHANTIC_OPENERS = [
  /^(?:what an? )?(?:great|excellent|fantastic|awesome|wonderful|amazing|good) (?:question|idea|point|thought)\b/i,
  /^(?:absolutely|certainly|of course|definitely)\s*[!,.]/i,
  /^sure thing\b/i,
  /^i(?:'d| would) be (?:happy|glad|delighted) to\b/i,
  /^you(?:'re| are) (?:absolutely |so |totally )?right\b/i,
  /^i love (?:this|that|your)\b/i,
];

/** Internal plumbing that should never leak into what a person reads: source paths and config/code file names. */
export const LEAKED_INTERNALS = [
  { pattern: /(?:^|[\s(`'"])\.?\/?src\/[\w./-]+/, label: 'a source path (src/...)' },
  { pattern: /\b[\w-]+(?:\/[\w.-]+)*\.(?:ts|tsx|mts|cts)\b/, label: 'a .ts file name' },
  { pattern: /\b[\w-]+(?:\/[\w.-]+)*\.json[l]?\b/, label: 'a .json file name' },
];

/** Punting a read-only lookup back to the person, instead of just doing it. */
export const PUNTS = [
  /\b(?:do you )?want me to (?:look (?:it|that|this|them|into it) up|look into (?:it|that|this)|check|search|find out|google|dig)\b/i,
  /\b(?:would|do) you like me to (?:look|check|search|find|dig|google)\b/i,
  /\b(?:shall|should) i (?:look|check|search|find|dig|google)\b/i,
  /\blet me know if you(?:'d| would)? (?:like|want) me to (?:look|check|search|find|dig)\b/i,
  /\bi can (?:look (?:it|that|this) up|check|search) (?:for you )?if you(?:'d| would)? like\b/i,
];

/**
 * Checks one draft. Returns `{ ok: true, problems: [] }` or `{ ok: false, reason, problems }` (the same shape as a
 * Rufus `verify`). `ctx.allowPaths` lets a technical audience see file names (e.g. a code review for yourself).
 * @param {string} text
 * @param {{ allowPaths?: boolean }} [ctx]
 */
export function verifyDraft(text, ctx = {}) {
  const draft = String(text ?? '').trim();
  const problems = [];
  if (!draft) problems.push('The draft is empty.');
  for (const re of SYCOPHANTIC_OPENERS) {
    if (re.test(draft)) {
      problems.push('Opens with flattery. Lead with the answer instead.');
      break;
    }
  }
  if (!ctx.allowPaths) {
    for (const { pattern, label } of LEAKED_INTERNALS) {
      if (pattern.test(draft)) problems.push(`Leaks ${label}. Say what it does, not where it lives.`);
    }
  }
  for (const re of PUNTS) {
    if (re.test(draft)) {
      problems.push('Offers to look something up instead of doing it. Read-only lookups need no permission: do it and answer.');
      break;
    }
  }
  return problems.length ? { ok: false, reason: problems.join(' '), problems } : { ok: true, problems };
}

export default verifyDraft;
