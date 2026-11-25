// Shared deterministic helpers for history analysis: intent buckets, text and number utilities. No I/O.
import type { HistoryPair } from './types';

export interface IntentBucket {
  id: string;
  label: string;
  /** Matched against the incoming message. First bucket that matches wins, so counts add up to the total. */
  pattern: RegExp;
}

/** Lightweight keyword buckets, first match wins. Pass your own `buckets` (or put them in `config.mine.buckets`). */
export const DEFAULT_BUCKETS: IntentBucket[] = [
  { id: 'confirmation', label: 'Confirmations', pattern: /\b(?:confirm(?:ed|ing|ation)?|still (?:on|good|works|happening)|does (?:that|this) work|rsvp|are you (?:coming|joining)|see you (?:there|then))\b/i },
  { id: 'follow-up', label: 'Follow-ups', pattern: /\b(?:following up|follow(?:ing)? up|checking in|check(?:ing)? in|any (?:update|news)|circling back|reminder|haven'?t heard|just wondering|bump(?:ing)?)\b/i },
  {
    id: 'scheduling',
    label: 'Scheduling',
    pattern: /\b(?:schedul\w*|reschedul\w*|meet(?:ing)?|call|calendar|available|availability|free (?:at|on|tomorrow|today|this)|what time|book(?:ing)?|appointment|slot|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s?(?:am|pm))\b/i,
  },
  { id: 'logistics', label: 'Logistics', pattern: /\b(?:address|directions?|parking|where|location|pick ?up|drop ?off|arriv\w*|eta|invoice|receipt|payment|pay|link|file|document|attach\w*|forward|send (?:me )?(?:the|a|over))\b/i },
  { id: 'question', label: 'Questions', pattern: /\?/ },
];

export const OTHER_BUCKET: Pick<IntentBucket, 'id' | 'label'> = { id: 'other', label: 'Everything else' };

export function classify(pair: Pick<HistoryPair, 'incoming'>, buckets: IntentBucket[] = DEFAULT_BUCKETS): string {
  for (const b of buckets) if (new RegExp(b.pattern.source, b.pattern.flags.replace('g', '')).test(pair.incoming)) return b.id;
  return OTHER_BUCKET.id;
}

export const SHORT_WORDS = 20;
export const SNIPPET = 160;

export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const words = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);
export const snippet = (s: string, max = SNIPPET): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
/** Nearest-rank percentile of a sorted list. */
export const percentile = (sorted: number[], p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]! : 0);
export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
export const tally = <T>(items: T[], key: (t: T) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return m;
};
export const top = (m: Map<string, number>, n: number): Array<[string, number]> => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

export const GREETING = /^\W*(hi+|hey+|hello|hiya|yo|howdy|good (?:morning|afternoon|evening)|morning|evening)\b/i;
export const SIGN_OFF = /\b(thanks(?: again| so much| a lot)?|thank you(?: so much)?|cheers|best|best regards|regards|talk soon|see you(?: soon| then)?|take care|ttyl|appreciate it)\W*$/i;
export const EMOJI = /\p{Extended_Pictographic}/u;

