import type { Gap } from '../gaps/store';
import type { LosslessEvent } from '../types';
import { provenanceOf, supersededBy, type EventStore, type RecallHit } from './store';
import { formatParty } from './ingest';

export const TRIGGER_KEY = 'event';

/**
 * Memories for the Desk: one search for the new event and one per gap in play, merged with MMR.
 * Separate queries keep each gap's own words inside the embedder's input window instead of truncated off the end of one long query.
 */
export async function recallForDesk(
  events: EventStore,
  opts: { triggerText: string; gaps: readonly Gap[]; k: number; excludeIds: string[]; now: Date },
): Promise<RecallHit[]> {
  // Gaps pick first: the Desk is top-down, and a memory that fits both a gap and the event is shown under the gap.
  const queries = [
    ...opts.gaps.map((g) => ({ key: g.id, text: `${g.title}. ${g.target}. ${g.reality}` })),
    { key: TRIGGER_KEY, text: opts.triggerText },
  ];
  return events.searchEach(queries, opts.k, { excludeIds: opts.excludeIds, now: opts.now });
}

function provenanceNote(e: LosslessEvent): string {
  const by = supersededBy(e);
  if (by) {
    const why = typeof e.metadata?.supersededReason === 'string' ? `: ${e.metadata.supersededReason}` : '';
    return ` {your own earlier claim ${e.id}, SUPERSEDED by ${by}${why}}`;
  }
  return provenanceOf(e) === 'rufus_claimed' ? ` {your own earlier claim ${e.id}, not proof}` : '';
}

/** One memory line: when, where from, what, and whose word it is. */
export function formatMemoryLine(e: LosslessEvent, formatTime: (iso: string) => string): string {
  return (
    `- [${formatTime(e.timestamp)}] (${e.source}${formatParty(e)}${e.deleted ? ' / DELETED' : ''}): ${e.text}` +
    (e.reactions?.length ? ` [reactions: ${e.reactions.map((x) => x.emoji).join(' ')}]` : '') +
    provenanceNote(e)
  );
}

/** The memories block, grouped by what each memory was picked for. */
export function formatRecall(hits: readonly RecallHit[], gaps: readonly Gap[], formatTime: (iso: string) => string): string {
  if (!hits.length) return '(none)';
  const order = [...gaps.map((g) => g.id), TRIGGER_KEY];
  const groups = order.filter((key) => hits.some((h) => h.serves === key));
  return groups
    .map((key) => {
      const gap = gaps.find((g) => g.id === key);
      const head = gap ? `For ${gap.id} (${gap.title}):` : 'For the new event:';
      return [head, ...hits.filter((h) => h.serves === key).map((h) => formatMemoryLine(h.event, formatTime))].join('\n');
    })
    .join('\n');
}
