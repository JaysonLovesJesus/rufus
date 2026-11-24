/**
 * Fix the right layer. A correction can be fixed in three places:
 *  - `code`: an exact, checkable rule belongs in a `verify` function, not in a prompt the model may ignore.
 *  - `context`: a rule that says "know X" means code should fetch X and pass it as `context`.
 *  - `principle`: taste and tone. A short lesson in the prompt is the right home.
 */
export type LessonLayer = 'principle' | 'code' | 'context';

export interface LayerSuggestion {
  layer: LessonLayer;
  reason: string;
}

const UNITS = '(?:words?|characters?|chars?|letters?|sentences?|lines?|paragraphs?|bullets?|bullet points?)';
const LIMIT_WORDS = '(?:at most|no more than|not more than|under|below|within|fewer than|less than|max(?:imum)?(?: of)?|up to|limit(?:ed)? to|capped at|exceed(?:ing)?|over)';
const SPECIAL_CHARS =
  '(?:exclamation (?:marks?|points?)|question marks?|emojis?|emoticons?|em[- ]?dash(?:es)?|en[- ]?dash(?:es)?|semicolons?|colons?|ellipsis|ellipses|hashtags?|quotation marks|quotes|parentheses|brackets|bullet points?|all[- ]caps|capital letters|markdown|exclamations?|links?|urls?)';
const AVOID_VERBS = '(?:never|don\'?t|do not|avoid|no|without|must not|mustn\'?t|stop|not allowed|forbid(?:den)?|ban(?:ned)?)';
const QUOTED = '["“”‘’\'`][^"“”‘’\'`]{1,60}["“”‘’\'`]';

const CODE_RULES: Array<{ test: RegExp; reason: string }> = [
  {
    test: new RegExp(`\\b${LIMIT_WORDS}\\s+(?:about\\s+)?\\d+\\s*${UNITS}\\b|\\b\\d+\\s*${UNITS}\\s*(?:or (?:less|fewer)|max(?:imum)?|limit|tops)\\b`, 'i'),
    reason: 'A length limit can be counted exactly, so enforce it in a `verify` check.',
  },
  {
    test: new RegExp(`\\b${AVOID_VERBS}\\b[^.]*\\b${SPECIAL_CHARS}\\b`, 'i'),
    reason: 'A forbidden character or format can be checked exactly, so enforce it in a `verify` check.',
  },
  {
    test: new RegExp(`\\b${AVOID_VERBS}\\b[^.]*\\b(?:words?|phrases?|terms?|say(?:ing)?|use|using|write|writing|mention|start(?:ing)? with|end(?:ing)? with)\\b[^.]*${QUOTED}`, 'i'),
    reason: 'A forbidden word or phrase can be matched exactly, so enforce it in a `verify` check.',
  },
  {
    test: new RegExp(`\\b(?:always|must|should)?\\s*(?:start|begin|end|close|sign(?: off)?)(?:s|ing)?\\s+(?:with|by)\\b[^.]*${QUOTED}`, 'i'),
    reason: 'A required opening or closing string can be matched exactly, so enforce it in a `verify` check.',
  },
  {
    test: /\b(?:ignore|skip|never|only|always|block|filter|exclude|allow|don'?t|do not|whitelist|blacklist)\b[^.]*(?:\b(?:senders?|domains?)\b|@[\w-]+\.[\w.-]+|\b(?:emails?|messages?|mail)\s+from\b)/i,
    reason: 'A sender or domain filter is a plain code condition, so put it in a `ctx.code` step or the flow trigger.',
  },
];

const CONTEXT_FETCH = /\b(?:check|look(?:ing)? up|lookup|fetch|pull(?: up)?|retrieve|find out|consult|cross-?check|look at|read the|get the|find the)\b/i;
const CONTEXT_INCLUDE = /\b(?:include|mention|reference|cite|attach|quote|state|confirm|verify|know|use the|ask for)\b/i;
const FACT_NOUNS =
  /\b(?:date|dates|time|times|name|names|number|numbers|id|ids|amount|price|prices|total|address|link|url|status|history|balance|order|invoice|ticket|account|schedule|calendar|availability|deadline|location|phone|attachment|policy|version|previous|prior|last|current|latest|thread|context|record|records|data|details|reference|confirmation)\b/i;

/**
 * Pure, deterministic routing of a lesson to the layer that should own it. No AI, no I/O.
 * Checkable rules -> `code`. Missing-fact rules -> `context`. Everything else (taste, tone) -> `principle`.
 */
export function suggestLayer(rule: string): LayerSuggestion {
  const text = rule.trim();
  for (const { test, reason } of CODE_RULES) {
    if (test.test(text)) return { layer: 'code', reason };
  }
  if (CONTEXT_FETCH.test(text) || (CONTEXT_INCLUDE.test(text) && FACT_NOUNS.test(text))) {
    return {
      layer: 'context',
      reason: 'The model is missing a fact. Have a `ctx.code` step fetch it and pass it as `context` instead of asking it in a prompt.',
    };
  }
  return { layer: 'principle', reason: 'Taste or tone cannot be checked exactly, so a short principle in the prompt is the right place.' };
}
