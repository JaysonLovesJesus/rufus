import { featureText } from './training';
import { formatParty } from '../events/ingest';
import type { Gap } from '../gaps/store';
import type { BouncerLabel, LosslessEvent, ModelProvider } from '../types';
import type { GapHint } from './gap-lens';

/**
 * The cheap second opinion (a small model, not Opus): it decides WAKE or SLEEP when the local classifier is unsure,
 * and re-checks batches of events the Bouncer slept on. It judges against the gap tree, so "wake" means "this changes
 * what the owner wants true, or what is true, for some gap" (or it is new and needs the owner's attention now).
 */
export const TRIAGE_SYSTEM = [
  "You are the Bouncer's second opinion for Rufus, a personal chief of staff.",
  'Rufus has a gap tree: each gap is what the owner wants true (target) minus what is true (reality).',
  'Waking Rufus costs an expensive model run, but a missed event that mattered costs far more.',
  'Say WAKE when the event changes a gap (new reality, progress, a blocker, an answer someone was waiting for),',
  'asks the owner for something, is time-sensitive, or is something the owner would clearly want to know now.',
  'Say SLEEP for noise: newsletters, promotions, routine notifications, chatter that changes no gap, app switches with no bearing on a gap.',
  'Messages written to the owner by other people are for the owner, not for Rufus; judge whether the owner needs Rufus on it.',
  'Reply with JSON only, no prose.',
].join('\n');

export interface TriageVerdict {
  label: BouncerLabel;
  /** False when the model could not tell; the caller then wakes Rufus so the big model decides. */
  sure: boolean;
  gapId?: string;
  reason: string;
}

const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One gap per line, short enough that every open gap fits the cheap model's prompt. */
export function gapLines(gaps: readonly Pick<Gap, 'id' | 'title' | 'target' | 'reality' | 'status'>[], limit = 25): string {
  const open = gaps.filter((g) => g.status !== 'closed' && g.status !== 'dropped').slice(0, limit);
  if (!open.length) return '(no open gaps)';
  return open.map((g) => `- ${g.id} [${g.status}] ${shorten(g.title, 90)} | target: ${shorten(g.target, 220)} | reality: ${shorten(g.reality || 'unknown', 220)}`).join('\n');
}

export function eventLine(e: LosslessEvent): string {
  return `[${e.timestamp}] (${e.source}/${e.kind}${formatParty(e)}) ${shorten(e.text, 600)}\n  features: ${featureText(e).split(' | ').filter((f) => /^[a-z_]+:/.test(f) && !f.startsWith('source:') && !f.startsWith('kind:')).join(', ') || 'none'}`;
}

/** Pulls the first JSON object or array out of a model reply. */
export function parseJsonReply(raw: string): unknown {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const i = t.indexOf(open);
    const j = t.lastIndexOf(close);
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1));
      } catch {
        /* try the other shape */
      }
    }
  }
  return undefined;
}

export interface Triage {
  decide(event: LosslessEvent, ctx: { hints: readonly GapHint[]; wakeScore?: number }): Promise<TriageVerdict>;
  review(events: readonly LosslessEvent[]): Promise<Array<{ eventId: string; label: BouncerLabel; reason: string; gapId?: string }>>;
}

/** The cheap model's two jobs, bound to a provider and the live gap tree. */
export function createTriage(opts: { provider: ModelProvider; model?: string; gaps: () => Promise<Gap[]>; timeoutMs?: number }): Triage {
  const call = async (prompt: string): Promise<string> => {
    const timeout = opts.timeoutMs ?? 45_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        opts.provider.complete({ system: TRIAGE_SYSTEM, prompt, ...(opts.model ? { model: opts.model } : {}) }),
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`triage timed out after ${timeout}ms`)), timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    async decide(event, ctx) {
      const gaps = await opts.gaps();
      const near = ctx.hints.length
        ? ctx.hints.map((h) => `- ${h.id} ${h.title}${h.tie ? ` (tied by ${h.tie})` : ''}, closeness ${h.score}`).join('\n')
        : '(none stood out)';
      const prompt = [
        'Open gaps:',
        gapLines(gaps),
        '',
        'Gaps this event looks close to:',
        near,
        '',
        `The local classifier gave it WAKE probability ${ctx.wakeScore ?? 'unknown'} and was not sure.`,
        '',
        'Event:',
        eventLine(event),
        '',
        'Reply as {"wake": true|false, "sure": true|false, "gap": "<gap id it changes, or empty>", "reason": "<under 15 words>"}',
      ].join('\n');
      const parsed = parseJsonReply(await call(prompt)) as { wake?: unknown; sure?: unknown; gap?: unknown; reason?: unknown } | undefined;
      if (!parsed || typeof parsed.wake !== 'boolean') throw new Error('triage reply was not a verdict');
      const gapId = typeof parsed.gap === 'string' && /^gap_/.test(parsed.gap) ? parsed.gap : undefined;
      return {
        label: parsed.wake ? 'WAKE' : 'SLEEP',
        sure: parsed.sure !== false,
        ...(gapId ? { gapId } : {}),
        reason: typeof parsed.reason === 'string' ? shorten(parsed.reason, 160) : '',
      };
    },
    async review(events) {
      if (!events.length) return [];
      const gaps = await opts.gaps();
      const prompt = [
        'Open gaps:',
        gapLines(gaps),
        '',
        'The local Bouncer let Rufus sleep through these events. Find any it should NOT have slept on.',
        '',
        ...events.map((e, i) => `#${i + 1} ${eventLine(e)}`),
        '',
        'Reply as a JSON list with one entry per event: [{"n": 1, "wake": true|false, "gap": "<gap id or empty>", "reason": "<under 12 words>"}]',
      ].join('\n');
      const parsed = parseJsonReply(await call(prompt));
      if (!Array.isArray(parsed)) throw new Error('review reply was not a list');
      const out: Array<{ eventId: string; label: BouncerLabel; reason: string; gapId?: string }> = [];
      for (const row of parsed as Array<{ n?: unknown; wake?: unknown; gap?: unknown; reason?: unknown }>) {
        const ev = typeof row?.n === 'number' ? events[row.n - 1] : undefined;
        if (!ev || typeof row.wake !== 'boolean') continue;
        const gapId = typeof row.gap === 'string' && /^gap_/.test(row.gap) ? row.gap : undefined;
        out.push({ eventId: ev.id, label: row.wake ? 'WAKE' : 'SLEEP', reason: typeof row.reason === 'string' ? shorten(row.reason, 120) : '', ...(gapId ? { gapId } : {}) });
      }
      return out;
    },
  };
}
