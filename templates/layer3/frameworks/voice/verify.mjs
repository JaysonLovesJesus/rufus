// Voice code gate: spoken replies are short and contain nothing that only works on a screen.
// verify(text, { maxSentences?: number }) -> { ok, reason?, problems }

const MARKDOWN = [
  { re: /^\s*#{1,6}\s/m, label: 'a heading' },
  { re: /\*\*[^*]+\*\*|__[^_]+__/, label: 'bold text' },
  { re: /^\s*(?:[-*+]|\d+\.)\s+\S/m, label: 'a list' },
  { re: /`[^`]*`/, label: 'code' },
  { re: /\[[^\]]+\]\([^)]+\)/, label: 'a link' },
];
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/i;
const FILE_PATH = /(?:^|\s)(?:~|\.{1,2})?\/[\w.-]+\/[\w./-]*|\b[\w-]+(?:\/[\w.-]+)+\.\w{1,5}\b|\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|py|sh|txt|yaml|yml|toml|html|css)\b/;

/** Sentences as a listener hears them (ignores decimals like 2.5 and common abbreviations). */
export function countSentences(text) {
  const cleaned = String(text ?? '')
    .replace(/\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st)\./gi, (m) => m.replace(/\./g, ''))
    .replace(/(\d)\.(\d)/g, '$1$2');
  return cleaned.split(/[.!?]+(?=\s|$)/).filter((s) => s.trim()).length;
}

/**
 * @param {string} text
 * @param {{ maxSentences?: number }} [ctx]
 */
export function verify(text, ctx = {}) {
  const spoken = String(text ?? '').trim();
  const max = ctx.maxSentences ?? 3;
  const problems = [];
  if (!spoken) problems.push('Nothing to say.');
  for (const { re, label } of MARKDOWN) if (re.test(spoken)) problems.push(`Contains markdown (${label}); it reads out as noise.`);
  if (URL.test(spoken)) problems.push('Contains a URL. Say "I sent you the link" instead.');
  else if (FILE_PATH.test(spoken)) problems.push('Contains a file path. Say what it is, not where it lives.');
  const n = countSentences(spoken);
  if (n > max) problems.push(`${n} sentences; keep it to ${max} and offer the rest.`);
  return problems.length ? { ok: false, reason: problems.join(' '), problems } : { ok: true, problems };
}

export default verify;
