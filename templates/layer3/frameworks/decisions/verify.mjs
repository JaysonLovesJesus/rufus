// Decisions code gate: blocks vague asks. A packet needs >= 2 options, tradeoffs, a recommendation and next steps.
// verify(packet) -> { ok, reason?, problems }

const OPTION_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:option\s+)?(?:[A-Ea-e]|[1-5])(?:\*\*)?\s*[).:\-]\s*\S/;
const HAS = {
  options: /\boptions?\b/i,
  tradeoffs: /\btrade-?offs?\b|\bpros\b[\s\S]*\bcons\b|\bcosts?\b/i,
  recommendation: /\brecommend(?:ation|ed)?\b|\bmy pick\b|\bi(?:'d| would) (?:go with|pick|choose)\b/i,
  next: /\bnext steps?\b|\bonce you (?:answer|reply|say)\b|\breply [A-E1-5]\b/i,
};
const HEDGE = /\brecommend(?:ation)?\s*:\s*(?:it depends|either|up to you|your call|not sure)\b/i;

/** @param {string} packet */
export function verify(packet) {
  const text = String(packet ?? '');
  const problems = [];
  const options = text.split('\n').filter((l) => OPTION_LINE.test(l)).length;
  if (!HAS.options.test(text) || options < 2) problems.push(`Needs at least two concrete options (found ${options}).`);
  if (!HAS.tradeoffs.test(text)) problems.push('Missing the tradeoffs: what each option costs.');
  if (!HAS.recommendation.test(text)) problems.push('Missing a recommendation that picks one option.');
  else if (HEDGE.test(text)) problems.push('The recommendation hedges. Pick one and say why.');
  if (!HAS.next.test(text)) problems.push('Missing next steps: what happens the moment they answer.');
  return problems.length ? { ok: false, reason: problems.join(' '), problems } : { ok: true, problems };
}

export default verify;
