// Research code gate: never punt the lookup back, and always show where the answer came from.
// verify(answer, { sources?: string[] }) -> { ok, reason?, problems }

const PUNTS = [
  /\b(?:do you )?want me to (?:look (?:it|that|this|them) up|look into|check|search|find out|google|dig)\b/i,
  /\b(?:would|do) you like me to (?:look|check|search|find|dig|google)\b/i,
  /\b(?:shall|should) i (?:look|check|search|find|dig|google)\b/i,
  /\byou (?:could|can|might|may want to|should) (?:try )?(?:search|google|look (?:it )?up|check (?:online|the web|their (?:site|website)))\b/i,
  /\bi (?:can(?:no|')t|cannot|am unable to|don't have (?:the ability|access)) (?:to )?(?:browse|search|access the (?:internet|web)|look (?:it|that|this) up)\b/i,
  /\bi (?:recommend|suggest) (?:checking|searching|looking (?:it )?up)\b/i,
];
const SOURCE = /https?:\/\/[^\s)]+|^\s*(?:\*\*)?sources?(?:\*\*)?\s*:\s*\S/im;

/**
 * @param {string} answer
 * @param {{ sources?: string[] }} [ctx] sources the research step already collected (counts as citing them)
 */
export function verify(answer, ctx = {}) {
  const text = String(answer ?? '').trim();
  const problems = [];
  if (!text) problems.push('The answer is empty.');
  if (PUNTS.some((re) => re.test(text))) problems.push('Punts the research back to the person. Do the lookup and answer.');
  const cited = SOURCE.test(text) || (Array.isArray(ctx.sources) && ctx.sources.length > 0);
  if (!cited) problems.push('No sources. Add the URLs (or a "Sources:" line) the answer came from.');
  return problems.length ? { ok: false, reason: problems.join(' '), problems } : { ok: true, problems };
}

export default verify;
