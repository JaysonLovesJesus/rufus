import type { HistoryPair } from './types';

/** Kinds of text that carry no personal style: automated codes and bare reaction echoes. */
export type NoiseKind = 'otp' | 'tapback';

export interface NoiseCounts {
  otp: number;
  tapback: number;
  total: number;
}

export const emptyNoise = (): NoiseCounts => ({ otp: 0, tapback: 0, total: 0 });

export function addNoise(c: NoiseCounts, kind: NoiseKind): void {
  c[kind]++;
  c.total++;
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
