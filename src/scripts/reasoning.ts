import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RpgTurnTrace } from '../types';
import { loadWakes, type WakeRecord } from '../eval/flight-recorder';
import type { ToolRegistry } from './registry';

interface DecisionEntry {
  at?: string;
  eventId?: string;
  source?: string;
  kind?: string;
  text?: string;
  decision?: { label?: string; confidence?: number; backend?: string; reason?: string };
}

export interface RegisterReasoningOptions {
  /** Returns the turns already recorded in the currently running wake (before it is appended to wakes.jsonl). */
  getCurrentWakeTrace?: () => readonly RpgTurnTrace[];
}

function fmtLocal(iso: string | undefined): string {
  if (!iso) return 'unknown time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function readRecentDecisions(workspaceDir: string, limit = 80): Promise<DecisionEntry[]> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, 'decisions.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean).slice(-limit);
    const out: DecisionEntry[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as DecisionEntry);
      } catch {
        /* ignore malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length >= 2);
}

function matchesQuery(haystack: string, tokens: readonly string[]): boolean {
  if (!tokens.length) return true;
  const lower = haystack.toLowerCase();
  return tokens.some((t) => lower.includes(t));
}

function wakeHaystack(w: WakeRecord): string {
  const parts: string[] = [
    w.wakeId,
    w.trigger.source,
    w.trigger.kind,
    w.trigger.actor ?? '',
    w.trigger.text,
    w.decision?.reason ?? '',
    w.sleepReason ?? '',
    ...w.sentMessages,
  ];
  for (const t of w.trace) {
    parts.push(t.thought ?? '', t.toolId, t.gapId ?? '', t.receipt?.summary ?? '');
  }
  return parts.join(' ');
}

function formatWakeTrace(w: WakeRecord): Record<string, unknown> {
  return {
    wakeId: w.wakeId,
    at: fmtLocal(w.at),
    trigger: `${w.trigger.source}/${w.trigger.kind}${w.trigger.actor ? ` (${w.trigger.actor})` : ''}: ${w.trigger.text.slice(0, 220)}`,
    bouncerDecision: {
      label: w.decision.label,
      backend: w.decision.backend,
      confidence: w.decision.confidence,
      reason: w.decision.reason,
    },
    turns: w.trace.map((t) => ({
      turn: t.turn,
      gapId: t.gapId,
      thought: t.thought ?? '(no thought recorded)',
      toolId: t.toolId,
      status: t.receipt.status,
      summary: t.receipt.summary.slice(0, 240),
    })),
    sentMessages: w.sentMessages.map((m) => m.slice(0, 240)),
    ...(w.sleepReason ? { sleepReason: w.sleepReason } : {}),
  };
}

/**
 * Registers `self.reasoning`: read-only $0 introspection over Rufus's immutable flight recorder
 * (`wakes.jsonl`, `decisions.jsonl`, and the current wake's turns) so Rufus can explain his real
 * recorded reasoning and NEVER confabulate why he did, said, or skipped something.
 */
export async function registerReasoningTool(registry: ToolRegistry, opts: RegisterReasoningOptions = {}): Promise<void> {
  await registry.registerInline(
    {
      id: 'self.reasoning',
      version: 1,
      description:
        'Reads Rufus’s exact recorded thoughts, tool choices, receipts, and Bouncer/Triage decisions from the flight recorder (wakes.jsonl + decisions.jsonl + current wake). Always call this before explaining why you did, said, skipped, or decided something — never guess or invent reasoning.',
      whenToUse: [
        'The owner asks why you did, said, skipped, woke up for, or decided something',
        'You need to inspect your own past thoughts or tool choices accurately without guessing',
      ],
      effect: 'read',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional keywords to match against past triggers, thoughts, tool calls, or sent messages' },
          gapId: { type: 'string', description: 'Optional gap id to filter recorded turns/wakes' },
          includeSkipped: { type: 'boolean', description: 'Include recent SKIP/SLEEP decisions from decisions.jsonl (default true when query is set, false otherwise)' },
          limit: { type: 'number', description: 'Max wakes to return (default 5, max 15)' },
        },
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      const gapId = typeof input.gapId === 'string' ? input.gapId.trim() : '';
      const limit = Math.max(1, Math.min(15, Number(input.limit) || 5));
      const includeSkipped = input.includeSkipped === true || (input.includeSkipped !== false && Boolean(query));
      const tokens = tokenize(query);

      const allWakes = await loadWakes(ctx.workspaceDir, 80);
      const matchedWakes = allWakes
        .filter((w) => {
          if (gapId && !w.trace.some((t) => t.gapId === gapId)) return false;
          if (tokens.length && !matchesQuery(wakeHaystack(w), tokens)) return false;
          return true;
        })
        .slice(-limit)
        .reverse()
        .map(formatWakeTrace);

      const currentTrace = (opts.getCurrentWakeTrace?.() ?? [])
        .filter((t) => !gapId || t.gapId === gapId)
        .filter((t) => {
          if (!tokens.length) return true;
          const h = `${t.thought ?? ''} ${t.toolId} ${t.gapId ?? ''} ${t.receipt.summary}`;
          return matchesQuery(h, tokens);
        })
        .map((t) => ({
          turn: t.turn,
          gapId: t.gapId,
          thought: t.thought ?? '(no thought recorded)',
          toolId: t.toolId,
          status: t.receipt.status,
          summary: t.receipt.summary.slice(0, 240),
        }));

      let skippedDecisions: Array<Record<string, unknown>> = [];
      if (includeSkipped) {
        const decisions = await readRecentDecisions(ctx.workspaceDir, 100);
        skippedDecisions = decisions
          .filter((d) => d.decision?.label === 'SLEEP')
          .filter((d) => {
            if (!tokens.length) return true;
            const h = `${d.source ?? ''} ${d.kind ?? ''} ${d.text ?? ''} ${d.decision?.reason ?? ''}`;
            return matchesQuery(h, tokens);
          })
          .slice(-limit)
          .reverse()
          .map((d) => ({
            at: fmtLocal(d.at),
            source: d.source,
            kind: d.kind,
            text: (d.text ?? '').slice(0, 200),
            label: d.decision?.label,
            backend: d.decision?.backend,
            confidence: d.decision?.confidence,
            reason: d.decision?.reason ?? '(no reason recorded)',
          }));
      }

      const totalMatched = matchedWakes.length + skippedDecisions.length + currentTrace.length;
      if (totalMatched === 0) {
        return {
          ok: true,
          summary: 'No recorded reasoning found matching that query. Do not guess — tell the owner there is no recorded trace for it.',
          data: { matched: 0, wakes: [], currentWakeTurns: [], skippedDecisions: [] },
        };
      }

      const parts: string[] = [];
      if (matchedWakes.length) parts.push(`${matchedWakes.length} recorded wake(s)`);
      if (currentTrace.length) parts.push(`${currentTrace.length} turn(s) in this wake`);
      if (skippedDecisions.length) parts.push(`${skippedDecisions.length} skipped decision(s)`);

      return {
        ok: true,
        summary: `Found ${parts.join(', ')} in the flight recorder. Explain ONLY what is recorded here.`,
        data: {
          matched: totalMatched,
          wakes: matchedWakes,
          ...(currentTrace.length ? { currentWakeTurns: currentTrace } : {}),
          ...(skippedDecisions.length ? { skippedDecisions } : {}),
        },
        nextHints: ['send_message'],
      };
    },
    { alwaysVisible: true },
  );
}
