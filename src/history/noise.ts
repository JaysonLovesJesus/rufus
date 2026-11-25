import type { HistoryPair } from './types';

/**
 * Kinds of text that carry no personal style: automated codes, bare reaction echoes, and bridge/sync placeholders
 * (e.g. Beeper's "Old photo. Media will be requested from your phone automatically overnight.").
 */
export type NoiseKind = 'otp' | 'tapback' | 'placeholder';

export interface NoiseCounts {
  otp: number;
  tapback: number;
  /** Media sync placeholders. Present only once one was seen (older reports never carry it). */
  placeholder?: number;
  total: number;
}

export const emptyNoise = (): NoiseCounts => ({ otp: 0, tapback: 0, total: 0 });

export function addNoise(c: NoiseCounts, kind: NoiseKind): void {
  c[kind] = (c[kind] ?? 0) + 1;
  c.total++;
}

// ---- Chat text cleanup (Beeper / Matrix bridges send HTML bodies and sync placeholders) ----

/** Beeper/WhatsApp history-sync stand-ins for media that never arrived: they say nothing about the human. */
const PLACEHOLDER = [
  /^old (?:photo|image|picture|video|sticker|gif|audio|voice message|voice note|file|document|media)\.?\s*media will be requested from your phone automatically overnight\.?$/i,
  /^media will be requested from your phone automatically overnight\.?$/i,
  /^waiting for this message\.?(?:\s*this may take a while\.?)?$/i,
];

/** True for a bridge/sync placeholder such as `Old photo. Media will be requested from your phone automatically overnight.` */
export function isPlaceholderText(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  return !!t && PLACEHOLDER.some((re) => re.test(t));
}

const BLOCK_TAGS = 'p|div|ul|ol|li|blockquote|pre|h[1-6]|tr|table|hr';
const INLINE_TAGS = 'span|strong|b|i|em|u|s|strike|del|ins|a|code|font|sub|sup|small|big|mark|img|td|th|tbody|thead|tfoot|label|abbr|cite|q';
const BR = /<br\s*\/?>/gi;
const REPLY_FALLBACK = /<mx-reply>[\s\S]*?<\/mx-reply>/gi; // Matrix quotes the replied-to message here; it is not what was written
// Attributes must look like `name="value"`, so prose such as `<I love you>` is never mistaken for a tag.
const ATTRS = `(?:\\s+[\\w:-]+=(?:"[^"]*"|'[^']*'|[^\\s"'<>]+))*\\s*\\/?>`;
const BLOCK = new RegExp(`<\\/?(?:${BLOCK_TAGS})${ATTRS}`, 'gi');
const INLINE = new RegExp(`<\\/?(?:${INLINE_TAGS})${ATTRS}`, 'gi');
const LOOKS_HTML = new RegExp(`<br\\s*\\/?>|<mx-reply>|<\\/?(?:${BLOCK_TAGS}|${INLINE_TAGS})${ATTRS}`, 'i');

const NAMED_ENTITIES: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', amp: '&' };

/** `&quot;` `&amp;` `&lt;` `&gt;` `&#39;` `&apos;` `&nbsp;` and numeric entities -> characters. Unknown entities are left alone. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** HTML message body -> plain text: block tags and `<br>` become newlines, inline tags vanish, the Matrix reply quote is dropped. */
export function stripHtml(text: string): string {
  if (!LOOKS_HTML.test(text)) return text;
  const plain = text.replace(REPLY_FALLBACK, '').replace(BR, '\n').replace(BLOCK, '\n').replace(INLINE, '');
  return plain
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * One chat message body -> clean plain text, or `''` when there is nothing a person wrote:
 *  - HTML (`<p>`, `<br>`, `<strong>`, `<ul><li>`, ...) becomes plain text with newlines, and entities are decoded;
 *  - Beeper/WhatsApp sync placeholders (`Old photo. Media will be requested ...`) become `''`.
 */
export function cleanMessageText(text: unknown): string {
  if (typeof text !== 'string') return '';
  const t = decodeEntities(stripHtml(text.replace(/\r\n?/g, '\n'))).trim();
  return !t || isPlaceholderText(t) ? '' : t;
}

const OTP_KEYWORD = /\b(?:passcode|pass code|verification code|verify code|security code|one[- ]time (?:code|password|passcode|pin)|login code|log-in code|sign-in code|confirmation code|authentication code|auth code|2fa code|otp|your code is|use code)\b/i;
const OTP_EXPIRY = /\bexpires? in \d+\s*(?:seconds?|secs?|minutes?|mins?|hours?)\b/i;
const OTP_DIGITS = /(?:^|[^\d])(?:\d{4,8}|\d{3}[- ]\d{3})(?!\d)/;
const OTP_WARNING = /\bdo not share (?:this|your|it)\b|\bnever share (?:this|your|it)\b/i;

const QUOTE_OPEN = '["“”„«‘\']';
const EMOJI_RUN = '\\p{Extended_Pictographic}[\\p{Extended_Pictographic}\\uFE0F\\u200D\\u{1F3FB}-\\u{1F3FF}]*';
const TAPBACK_VERB = /^(?:liked|loved|disliked|laughed at|emphasized|questioned)\s+(?:an?\s+(?:image|photo|picture|video|attachment|message|sticker|link|audio message|voice message)\b.*|["“”„«‘'].*)$/is;
const TAPBACK_EMOJI_TO = new RegExp(`^(?:reacted\\s+)?${EMOJI_RUN}\\s+(?:to|on)\\s+${QUOTE_OPEN}.*$`, 'isu');
const TAPBACK_REMOVED = new RegExp(`^removed\\s+(?:an?\\s+)?(?:${EMOJI_RUN}|heart|like|dislike|laugh|exclamation|question mark|emphasis|reaction)(?:\\s+(?:from|to|on)\\s+.*)?$`, 'isu');
const TAPBACK_REACTED = new RegExp(`^reacted\\s+${EMOJI_RUN}(?:\\s+to\\s+.*)?$`, 'isu');

/**
 * Deterministic check for text that should never teach a voice:
 *  - one-time passcodes / verification codes (a code keyword plus digits or an expiry, or an expiry plus digits);
 *  - bare tapback echoes such as `Liked "..."`, `👍 to “...”`, `Removed 👍`.
 * Conservative on purpose: a human asking "what's the verification code?" is not noise.
 */
export function noiseKind(text: string): NoiseKind | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (TAPBACK_VERB.test(t) || TAPBACK_EMOJI_TO.test(t) || TAPBACK_REMOVED.test(t) || TAPBACK_REACTED.test(t)) return 'tapback';
  if (t.length <= 400) {
    const digits = OTP_DIGITS.test(t);
    const expiry = OTP_EXPIRY.test(t);
    if ((OTP_KEYWORD.test(t) && (digits || expiry)) || (expiry && digits) || (OTP_WARNING.test(t) && digits)) return 'otp';
  }
  return undefined;
}

/** A saved pair is noise if what was written to you is an automated code or a reaction echo, or your "reply" is one. */
export function pairNoiseKind(p: Pick<HistoryPair, 'incoming' | 'reply'>): NoiseKind | undefined {
  return noiseKind(p.incoming) ?? (noiseKind(p.reply) === 'tapback' ? 'tapback' : undefined);
}

export interface FilterNoiseResult<T> {
  /** Pairs worth learning from, with `incoming` and `reply` cleaned. */
  kept: T[];
  /** What was dropped and why. */
  noise: NoiseCounts;
}

/**
 * Cleans and filters (incoming -> reply) pairs in one pass: HTML and entities become plain text, a side that is only a
 * sync placeholder drops the pair (always), and passcodes / tapback echoes drop it unless `includeNoise`.
 */
export function filterNoise<T extends Pick<HistoryPair, 'incoming' | 'reply'>>(pairs: T[], opts: { includeNoise?: boolean } = {}): FilterNoiseResult<T> {
  const noise = emptyNoise();
  const kept: T[] = [];
  for (const p of pairs) {
    const incoming = cleanMessageText(p.incoming);
    const reply = cleanMessageText(p.reply);
    if (!incoming || !reply) {
      if (isPlaceholderText(String(p.incoming ?? '')) || isPlaceholderText(String(p.reply ?? ''))) addNoise(noise, 'placeholder');
      continue;
    }
    const cleaned = incoming === p.incoming && reply === p.reply ? p : { ...p, incoming, reply };
    const kind = opts.includeNoise ? undefined : pairNoiseKind(cleaned);
    if (kind) {
      addNoise(noise, kind);
      continue;
    }
    kept.push(cleaned);
  }
  return { kept, noise };
}
