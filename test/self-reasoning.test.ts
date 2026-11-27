import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordWake } from '../src/eval/flight-recorder';
import { registerReasoningTool } from '../src/scripts/reasoning';
import { ToolRegistry } from '../src/scripts/registry';
import { isBlockingViolation, verifySpokenReply } from '../src/speaker/speaker';
import type { Receipt, RpgTurnTrace } from '../src/types';

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    toolId: 'self.reasoning',
    status: 'ok',
    effect: 'read',
    summary: 'Found 1 recorded wake(s) in the flight recorder.',
    changes: [],
    durationMs: 5,
    at: '2026-11-27T18:05:00.000Z',
    ...overrides,
  };
}

describe('Self-aware reasoning & anti-confabulation', () => {
  it('reads verbatim thoughts, tool calls, and skipped decisions from the flight recorder', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rufus-reasoning-'));
    try {
      await recordWake(dir, {
        wakeId: 'wake_abc',
        at: '2026-11-27T18:00:00.000Z',
        trigger: { id: 'ev_1', source: 'email', kind: 'email_received', actor: 'Gotogate', text: 'Flight TK 8 schedule change' },
        decision: { label: 'WAKE', confidence: 0.94, backend: 'triage', reason: 'Flight change affects upcoming trip', durationMs: 42 },
        turns: 1,
        trace: [
          {
            turn: 1,
            gapId: 'gap_flights',
            thought: 'Checking the Gotogate email details before alerting the owner about the TK 8 time shift.',
            toolId: 'gmail.read',
            input: { id: '123' },
            receipt: makeReceipt({ toolId: 'gmail.read', summary: 'TK 8 moved to 21:20.' }),
          },
        ],
        durationMs: 1200,
        acted: true,
        slept: true,
        sleepReason: 'Alerted owner and set follow-up watch.',
        sentMessages: ['Your TK 8 flight shifted to 9:20 PM.'],
      });

      await fs.writeFile(
        path.join(dir, 'decisions.jsonl'),
        `${JSON.stringify({
          at: '2026-11-27T17:30:00.000Z',
          eventId: 'ev_promo',
          source: 'email',
          kind: 'email_received',
          text: '50% off winter coats newsletter',
          decision: { label: 'SLEEP', confidence: 0.98, backend: 'setfit', reason: 'Promotional newsletter, no action needed' },
        })}\n`,
        'utf8',
      );

      const liveTurns: RpgTurnTrace[] = [
        {
          turn: 1,
          gapId: 'gap_flights',
          thought: 'Owner asked why I flagged TK 8; pulling the exact recorded trace.',
          toolId: 'self.reasoning',
          input: { query: 'TK 8' },
          receipt: makeReceipt(),
        },
      ];

      const registry = new ToolRegistry({ toolsDir: path.join(dir, 'tools') });
      await registerReasoningTool(registry, { getCurrentWakeTrace: () => liveTurns });

      const res = await registry.call('self.reasoning', { query: 'TK 8' }, { workspaceDir: dir, now: new Date('2026-11-27T18:05:00.000Z') });
      expect(res.status).toBe('ok');
      const data = res.data as { matched: number; wakes: Array<{ wakeId: string; turns: Array<{ thought: string }> }>; currentWakeTurns: Array<{ thought: string }> };
      expect(data.matched).toBeGreaterThanOrEqual(1);
      expect(data.wakes[0]?.wakeId).toBe('wake_abc');
      expect(data.wakes[0]?.turns[0]?.thought).toContain('Checking the Gotogate email details');
      expect(data.currentWakeTurns[0]?.thought).toContain('pulling the exact recorded trace');

      const skipRes = await registry.call('self.reasoning', { query: 'winter coats', includeSkipped: true }, { workspaceDir: dir, now: new Date('2026-11-27T18:05:00.000Z') });
      const skipData = skipRes.data as { skippedDecisions: Array<{ reason: string }> };
      expect(skipData.skippedDecisions).toHaveLength(1);
      expect(skipData.skippedDecisions[0]?.reason).toContain('Promotional newsletter');

      const missRes = await registry.call('self.reasoning', { query: 'nonexistent-zebra-topic' }, { workspaceDir: dir, now: new Date('2026-11-27T18:05:00.000Z') });
      expect(missRes.summary).toContain('No recorded reasoning found');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks unbacked reasoning claims in Speaker until self.reasoning has run', () => {
    const blocked = verifySpokenReply('I skipped that email because it looked like a newsletter.', []);
    expect(blocked.some((v) => v.startsWith('unbacked reasoning claim'))).toBe(true);
    expect(blocked.some(isBlockingViolation)).toBe(true);

    const blockedWhenAsked = verifySpokenReply('It seemed urgent based on the subject line.', [], {
      ownerPrompt: 'Why did you wake up for that email?',
    });
    expect(blockedWhenAsked.some((v) => v.startsWith('unbacked reasoning claim'))).toBe(true);

    const allowedHonest = verifySpokenReply("I don't have a record of why I woke up for that.", [], {
      ownerPrompt: 'Why did you wake up for that email?',
    });
    expect(allowedHonest.filter(isBlockingViolation)).toHaveLength(0);

    const allowedWithReceipt = verifySpokenReply('I skipped that email because the bouncer marked it as a promotional newsletter.', [makeReceipt()], {
      ownerPrompt: 'Why did you skip that email?',
    });
    expect(allowedWithReceipt.filter(isBlockingViolation)).toHaveLength(0);
  });
});
