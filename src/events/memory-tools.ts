import type { ToolRegistry } from '../scripts/registry';
import type { LosslessEvent } from '../types';
import { provenanceOf, type EventStore } from './store';

/** Memory tools that need the event store itself (memory.search lives with the other built-ins). */
export async function registerMemoryTools(deps: {
  registry: ToolRegistry;
  events: EventStore;
  getWakeContext?: () => { trigger?: LosslessEvent } | undefined;
}): Promise<void> {
  await deps.registry.registerInline(
    {
      id: 'memory.supersede',
      version: 1,
      description:
        'Marks one of your own earlier claims in memory as superseded when the owner (or a fresh observation) contradicts it. The claim stays in memory, ranks low, and shows as superseded, so it is never repeated as fact.',
      whenToUse: [
        'The owner says something you claimed earlier is wrong',
        'A memory marked "your own earlier claim" is contradicted by what the owner said or what was observed',
      ],
      notWhen: ["The memory is the owner's words or an observation: those are facts, and newer facts already outrank older ones"],
      effect: 'meta',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          claimId: { type: 'string', description: 'Id of your earlier claim (shown on the Desk as "your own earlier claim <id>")' },
          byEventId: { type: 'string', description: 'Optional id of the event that contradicts it (defaults to the event that woke you)' },
          reason: { type: 'string', description: 'One line: what is actually true' },
        },
        required: ['claimId', 'reason'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const claimId = String(input.claimId ?? '').trim();
      const reason = String(input.reason ?? '').trim();
      const claim = claimId ? await deps.events.get(claimId) : undefined;
      if (!claim) return { ok: false, summary: `No memory with id ${claimId}.`, error: 'unknown claim' };
      if (provenanceOf(claim) !== 'rufus_claimed') {
        return { ok: false, summary: `${claimId} is ${provenanceOf(claim)}, not your claim: facts are never superseded by hand.`, error: 'not a claim' };
      }
      const byId = typeof input.byEventId === 'string' && input.byEventId.trim() ? input.byEventId.trim() : deps.getWakeContext?.()?.trigger?.id;
      const by = byId ? await deps.events.get(byId) : undefined;
      // Only a source of truth can overrule a claim; one claim of Rufus's cannot overrule another.
      if (!by || provenanceOf(by) === 'rufus_claimed') {
        return { ok: false, summary: 'Refused: a claim is superseded only by something the owner said or something observed.', error: 'no source of truth' };
      }
      await deps.events.supersede(claim.id, by.id, { reason, at: ctx.now.toISOString() });
      return { ok: true, summary: `Marked your claim ${claim.id} as superseded by ${by.id}: ${reason}`, changes: [`superseded:${claim.id}`] };
    },
    { alwaysVisible: true },
  );
}
