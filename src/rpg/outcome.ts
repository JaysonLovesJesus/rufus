import type { Receipt } from '../types';

/** Scheduling Rufus's own next look is how every wake is allowed to end, and notes on a gap are bookkeeping: on their own they are not a change. */
const SCHEDULING_TOOLS = new Set(['watch.set', 'gaps.note']);

/**
 * Did this move change something: a gap, a message sent, or the world (including a draft put in front of the owner, or a
 * rehearsed write)? Reads, brains that only think, and scheduling the next look do not count.
 */
export function isRealChange(r: Pick<Receipt, 'toolId' | 'effect' | 'status'> & { changes?: readonly string[]; actions?: Receipt['actions'] }): boolean {
  if (r.changes?.some((c) => c.startsWith('gap_created:'))) return true;
  // An action a tool took through the ladder (brain.verify closing its gap) counts like the same action taken as a move.
  if (r.actions?.some((a) => isRealChange({ toolId: a.toolId, effect: 'write', status: a.status, changes: a.changes }))) return true;
  if (r.effect !== 'write' || SCHEDULING_TOOLS.has(r.toolId)) return false;
  return r.status === 'ok' || r.status === 'pending_approval';
}
