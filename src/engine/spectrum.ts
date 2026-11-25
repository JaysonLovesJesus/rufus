import type { RunRecord, Spectrum, StepRecord, Tier } from '../types';

export const emptySpectrum = (): Spectrum => ({ code: 0, fast: 0, smart: 0, human: 0 });

/** `fast`/`smart` as a tier when a provider name says so (the README's own convention), else undefined. */
export const tierOfName = (name?: string): Tier | undefined => (name === 'fast' || name === 'smart' ? name : undefined);

/**
 * Count which rung handled each step: `code` steps are code, `human` steps are a person, and an ai step is the tier
 * that produced it (an untiered one counts as `smart`). A step where both models failed and a human took over is
 * counted once, as `human`.
 */
export function summarizeSpectrum(steps: Record<string, StepRecord>): Spectrum {
  const out = emptySpectrum();
  for (const s of Object.values(steps)) {
    if (s.kind === 'code') {
      if (s.done && !s.bookkeeping) out.code++;
    } else if (s.kind === 'human') {
      out.human++;
    } else if (s.done && !s.handoff) {
      out[s.rung ?? 'smart']++;
    }
    if (s.escalated) out.escalated = (out.escalated ?? 0) + 1;
  }
  return out;
}

export function addSpectrum(a: Spectrum, b: Spectrum): Spectrum {
  const escalated = (a.escalated ?? 0) + (b.escalated ?? 0);
  return { code: a.code + b.code, fast: a.fast + b.fast, smart: a.smart + b.smart, human: a.human + b.human, ...(escalated ? { escalated } : {}) };
}

/** The spectrum of a run as saved, or counted from its steps for runs saved before it existed. */
export const spectrumOf = (run: Pick<RunRecord, 'spectrum' | 'steps'>): Spectrum => run.spectrum ?? summarizeSpectrum(run.steps);

export const spectrumTotal = (s: Spectrum): number => s.code + s.fast + s.smart + s.human;

/** `code 2 · fast 1 · smart 0 · human 1` (plus `· 1 escalated` when a cheap rung had to hand up). */
export function formatSpectrum(s: Spectrum): string {
  const base = `code ${s.code} · fast ${s.fast} · smart ${s.smart} · human ${s.human}`;
  return s.escalated ? `${base} · ${s.escalated} escalated` : base;
}
