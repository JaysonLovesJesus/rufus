import { assertActionType, TrustStore } from '../engine/trust';
import { AUDIT_REQUEST, auditSummary } from './audit';

/**
 * v21 chat commands for Earned Trust 2.0, answered by plain code ($0) in the Chief of Staff and the daemon:
 *   "pause autonomy" / "stop acting on your own"   the kill switch: everything asks first
 *   "resume autonomy"                               back to each action's own rung
 *   "demote <action>"                               that action back to `check`
 *   "what did you do today?" / "audit log"          the audit ledger, last 24h
 */
export type AutonomyCommand = { kind: 'pause'; reason?: string } | { kind: 'resume' } | { kind: 'demote'; action: string } | { kind: 'audit'; hours: number };

const PAUSE = /^(?:pause\s+(?:your\s+)?autonomy|stop\s+acting\s+on\s+your\s+own|kill\s+switch|stop\s+doing\s+things\s+on\s+your\s+own)(?:\s*[:,-]\s*(.+?))?\s*[.!]*$/i;
const RESUME = /^(?:resume\s+(?:your\s+)?autonomy|unpause\s+autonomy)\s*[.!]*$/i;
const DEMOTE = /^demote\s+([a-z0-9][a-z0-9_.:-]*)\s*[.!]*$/i;

export function parseAutonomyCommand(text: string): AutonomyCommand | undefined {
  const t = text.trim();
  const pause = PAUSE.exec(t);
  if (pause) return { kind: 'pause', ...(pause[1]?.trim() ? { reason: pause[1].trim() } : {}) };
  if (RESUME.test(t)) return { kind: 'resume' };
  const demote = DEMOTE.exec(t);
  if (demote) {
    try {
      return { kind: 'demote', action: assertActionType(demote[1]!) };
    } catch {
      return undefined;
    }
  }
  if (AUDIT_REQUEST.test(t)) return { kind: 'audit', hours: 24 };
  return undefined;
}

/** Runs one command and returns the confirmation to say back. */
export async function runAutonomyCommand(dir: string, cmd: AutonomyCommand, opts: { trust?: TrustStore; now?: Date } = {}): Promise<string> {
  const trust = opts.trust ?? new TrustStore(dir);
  switch (cmd.kind) {
    case 'pause':
      await trust.pause(cmd.reason ?? 'asked in chat');
      return "Paused. I won't do anything on my own — every action asks you first until you say \"resume autonomy\".";
    case 'resume': {
      const wasPaused = await trust.isPaused();
      await trust.resume();
      return wasPaused ? 'Resumed. Actions that earned it run on their own again (and I tell you when they do).' : "Autonomy wasn't paused — nothing changed.";
    }
    case 'demote': {
      const before = await trust.get(cmd.action);
      if (before.autonomy === 'blocked') return `${before.actionType} is blocked: it never runs. Lifting a block is a terminal job: rufus trust demote ${before.actionType} puts it back to check.`;
      const r = await trust.demote(cmd.action);
      return before.autonomy === 'check' ? `${r.actionType} was already at check: I ask you every time.` : `Done — ${r.actionType} is back to check. I'll ask you first every time.`;
    }
    case 'audit':
      return auditSummary(dir, { hours: cmd.hours, ...(opts.now ? { now: opts.now } : {}) });
  }
}
