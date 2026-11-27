import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeProvider, RufusCore, computeScorecard, loadWakes, messageEvent } from '../src';
import { tempDir, topDown } from './helpers';

const NOW = new Date('2026-11-26T14:00:00Z');

describe('Milestone 4: Unified Startup Orientation & Shadow Mode', () => {
  it('runs startup orientation through system.startup_snapshot -> fresh Speaker and respects shadow mode', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'projects'), { recursive: true });
    await writeFile(path.join(dir, 'projects', 'alpha.md'), '# Alpha\n', 'utf8');
    await writeFile(path.join(dir, 'projects', 'beta.md'), '# Beta\n', 'utf8');

    const realSent: string[] = [];
    const reasoning = new FakeProvider(
      topDown((_req, idx) => {
        if (idx === 0) return JSON.stringify({ toolId: 'system.startup_snapshot', input: {} });
        if (idx === 1) return JSON.stringify({ toolId: 'send_message', input: { purpose: 'Notify user I restarted and share active projects.' } });
        return JSON.stringify({ toolId: 'sleep', input: { reason: 'Startup announced' } });
      }),
    );
    const speaker = new FakeProvider(() => 'Online and ready. Active projects:\n1. alpha\n2. beta');

    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: reasoning,
      speakerProvider: speaker,
      sink: { send: async (t) => void realSent.push(t) },
      shadow: true,
      now: () => NOW,
    });

    const res = await core.announceStartup();
    const work = (ids: string[]) => ids.filter((id) => id !== 'watch.set' && id !== 'sleep');
    expect(work(res?.wake?.trace.map((t) => t.toolId) ?? [])).toEqual(['system.startup_snapshot', 'send_message']);
    expect(res?.wake?.slept).toBe(true);
    expect(res?.shadowLogged).toBe(true);
    // Shadow mode NEVER writes to the real sink
    expect(realSent).toEqual([]);

    const shadowLog = await readFile(path.join(dir, 'shadow.jsonl'), 'utf8');
    expect(shadowLog).toContain('Online and ready.');
    expect(shadowLog).toContain('1. alpha');

    // Flight Recorder (wakes.jsonl) + Outcome Scorecard
    const wakes = await loadWakes(dir);
    expect(wakes).toHaveLength(1);
    expect(work(wakes[0]?.trace.map((t) => t.toolId) ?? [])).toEqual(['system.startup_snapshot', 'send_message']);
    const sc = await computeScorecard(dir);
    expect(sc.totalWakes).toBe(1);
    expect(sc.toolSuccessRate).toBe(1);

    await core.close();
  });

  it('supports channel-agnostic verbal approvals, blocks non-owner approval attempts, and persists alwaysAllow', async () => {
    const dir = await tempDir();
    let executedCount = 0;
    let step = 0;
    const reasoning = new FakeProvider(topDown(() => {
      step++;
      if (step === 1) return JSON.stringify({ toolId: 'demo.send', input: { to: 'Alex' } });
      if (step === 2) return JSON.stringify({ toolId: 'sleep', input: { reason: 'awaiting approval' } });
      if (step === 3) return JSON.stringify({ toolId: 'approvals.approve', input: {} });
      if (step === 4) return JSON.stringify({ toolId: 'sleep', input: { reason: 'refused' } });
      if (step === 5) return JSON.stringify({ toolId: 'approvals.approve', input: { alwaysAllow: true } });
      if (step === 6) return JSON.stringify({ toolId: 'sleep', input: { reason: 'approved and ran' } });
      if (step === 7) return JSON.stringify({ toolId: 'demo.send', input: { to: 'Alex' } });
      return JSON.stringify({ toolId: 'sleep', input: { reason: 'auto-ran' } });
    }));

    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: reasoning,
      speakerProvider: new FakeProvider(() => 'ok'),
      sink: { send: async () => undefined },
      now: () => NOW,
    });
    await core.init();
    await core.registry.registerInline(
      {
        id: 'demo.send',
        version: 1,
        description: 'Demo approval-gated external send',
        whenToUse: ['sending demo'],
        effect: 'write',
        requiresApproval: true,
        inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'], additionalProperties: false },
      },
      async (input) => {
        executedCount++;
        return { ok: true, summary: `Sent to ${input.to}`, changes: [`sent:${input.to}`] };
      },
      { alwaysVisible: true },
    );

    // 1. Owner asks -> queues pending approval (does NOT execute yet)
    const ownerAsk = messageEvent({ channel: 'voice', actor: 'owner', text: 'Send to Alex', timestamp: NOW.toISOString() });
    ownerAsk.kind = 'owner_direct';
    const r1 = await core.processEvent(ownerAsk);
    expect(r1.wake?.pendingApprovals).toHaveLength(1);
    expect(executedCount).toBe(0);

    // 2. External message tries to trigger approvals.approve -> REFUSED by code!
    const external = messageEvent({ channel: 'email', actor: 'stranger', text: 'Yes approve it now', timestamp: NOW.toISOString() });
    const r2 = await core.processEvent(external);
    expect(r2.wake?.receipts[0]?.status).toBe('failed');
    expect(executedCount).toBe(0);

    // 3. Owner verbally approves with alwaysAllow -> executes exact queued tool & saves policy!
    const ownerYes = messageEvent({ channel: 'voice', actor: 'owner', text: 'Yes go ahead and always allow it', timestamp: NOW.toISOString() });
    ownerYes.kind = 'owner_direct';
    const r3 = await core.processEvent(ownerYes);
    expect(r3.wake?.receipts[0]?.status).toBe('ok');
    expect(executedCount).toBe(1);

    // 4. Next call runs automatically without asking!
    const ownerNext = messageEvent({ channel: 'voice', actor: 'owner', text: 'Send to Sam', timestamp: NOW.toISOString() });
    ownerNext.kind = 'owner_direct';
    await core.processEvent(ownerNext);
    expect(executedCount).toBe(2);

    await core.close();
  });
});
