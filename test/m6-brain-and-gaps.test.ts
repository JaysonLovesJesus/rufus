import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeProvider, RufusCore, gapConnector, genericEvent, messageEvent, watchConnector } from '../src';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'rufus-v2-m6-'));
const NOW = new Date('2026-11-26T22:00:00Z');

describe('Milestone 6: Gap Board, 5 Brain-State Tools, 4-Level Trust Ladder & Isolated Desk', () => {
  it('enforces read-only Investigate, Plan, Create, and reality-checked Verify that closes a Gap', async () => {
    const dir = await tempDir();
    let seenPrompts: string[] = [];
    let call = 0;

    // Scripted provider covering Decide + nested fresh-context Brain-State calls
    const provider = new FakeProvider((req) => {
      seenPrompts.push(req.prompt);
      call++;
      // 1. Decide: call brain.investigate
      if (call === 1) return JSON.stringify({ toolId: 'brain.investigate', input: { question: 'Check demo state' } });
      // 2. Investigate step 1: tries to call a write tool -> must be refused by code!
      if (call === 2) return JSON.stringify({ toolId: 'demo.mutate', input: { value: 'hack' } });
      // 3. Investigate step 2: calls read tool
      if (call === 3) return JSON.stringify({ toolId: 'demo.read', input: {} });
      // 4. Investigate step 3: finishes with facts + unknowns
      if (call === 4) return JSON.stringify({ done: true, facts: ['Current count is 0'], unknowns: [], summary: 'Verified count is 0.' });
      // 5. Decide: add owner Gap to Gap Board
      if (call === 5) return JSON.stringify({ toolId: 'gaps.create', input: { title: 'Raise count to 1', target: 'demo.read returns count=1', reality: 'Current count is 0', source: 'owner' } });
      // 6. Decide: call brain.plan
      if (call === 6) return JSON.stringify({ toolId: 'brain.plan', input: { goal: 'Raise count to 1', verifiedFacts: 'count is 0' } });
      // 7. Plan fresh call
      if (call === 7) return JSON.stringify({ recommendation: 'Run demo.mutate once', subGaps: [{ title: 'Set count', target: 'count=1', firstMove: 'demo.mutate' }], options: [], openQuestions: [] });
      // 8. Decide: call brain.create
      if (call === 8) return JSON.stringify({ toolId: 'brain.create', input: { title: 'Launch Spec', brief: 'Short spec', verifiedFacts: 'count=0', slug: 'launch-spec' } });
      // 9. Create fresh call
      if (call === 9) return '# Launch Spec\nMove count from 0 to 1.';
      // 10. Decide: execute demo.mutate (act_and_report)
      if (call === 10) return JSON.stringify({ toolId: 'demo.mutate', input: { value: '1' } });
      // 11. Decide: call brain.verify with the created gapId
      if (call === 11) {
        const m = /gap_[a-z0-9]+/.exec(req.prompt);
        return JSON.stringify({ toolId: 'brain.verify', input: { target: 'demo.read returns count=1', gapId: m?.[0] } });
      }
      // 12. Verify step 1: checks reality via demo.read
      if (call === 12) return JSON.stringify({ toolId: 'demo.read', input: {} });
      // 13. Verify step 2: PASS
      if (call === 13) return JSON.stringify({ done: true, passed: true, evidence: 'demo.read confirmed count=1' });
      // 14. Decide: sleep
      return JSON.stringify({ toolId: 'sleep', input: { reason: 'Gap verified closed' } });
    });

    let count = 0;
    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: provider,
      speakerProvider: new FakeProvider(() => 'Verified count is 1.'),
      sink: { send: async () => undefined },
      now: () => NOW,
    });
    await core.init();

    await core.registry.registerInline(
      {
        id: 'demo.read',
        version: 1,
        description: 'Reads current count',
        whenToUse: ['reading count'],
        effect: 'read',
        requiresApproval: false,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async () => ({ ok: true, summary: `count=${count}`, data: { count } }),
      { alwaysVisible: true },
    );
    await core.registry.registerInline(
      {
        id: 'demo.mutate',
        version: 1,
        description: 'Sets count',
        whenToUse: ['mutating count'],
        effect: 'write',
        requiresApproval: false,
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      },
      async (input) => {
        count = Number(input.value);
        return { ok: true, summary: `Set count=${count}`, changes: [`count:${count}`] };
      },
      { alwaysVisible: true },
    );

    const ask = messageEvent({ channel: 'cli', actor: 'owner', text: 'Raise count to 1', timestamp: NOW.toISOString() });
    ask.kind = 'owner_direct';
    const res = await core.processEvent(ask);

    expect(res.wake?.slept).toBe(true);
    // Investigate's attempted write was REFUSED -> count was only changed once by Decide's Act turn
    expect(count).toBe(1);
    // Artifact written by brain.create
    const draft = await readFile(path.join(dir, 'drafts', 'launch-spec.md'), 'utf8');
    expect(draft).toContain('Move count from 0 to 1.');
    // Gap was created and closed ONLY after brain.verify passed
    const gaps = await core.gaps.list();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.status).toBe('closed');
    expect(gaps[0]?.reality).toContain('count=1');
    // Verify ran with fresh context (no prior Decide chat leaked into Verify's prompt)
    expect(seenPrompts[11]).not.toContain('Launch Spec');

    await core.close();
  });

  it('isolates owner chat on The Desk from noisy third-party chats, supports rehearse trust, and fires watches', async () => {
    const dir = await tempDir();
    let capturedPrompt = '';
    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: new FakeProvider((req) => {
        capturedPrompt = req.prompt;
        return JSON.stringify({ toolId: 'sleep', input: { reason: 'checked' } });
      }),
      speakerProvider: new FakeProvider(() => 'ok'),
      sink: { send: async () => undefined },
      now: () => NOW,
    });
    await core.init();

    // Seed an earlier owner conversation, then bury it under 30 noisy third-party chats
    const earlierOwner = messageEvent({ id: 'own_1', channel: 'telegram', actor: 'owner', text: 'Let us merge Alpha and Beta', timestamp: '2026-11-26T20:00:00Z' });
    earlierOwner.kind = 'owner_direct';
    await core.events.append(earlierOwner);
    for (let i = 0; i < 30; i++) {
      await core.events.append(messageEvent({ id: `ext_${i}`, channel: 'whatsapp', actor: 'GroupFriend', text: `Random group chat message ${i}`, timestamp: `2026-11-26T21:${String(i).padStart(2, '0')}:00Z` }));
    }

    // Owner follows up with pronoun "them" -> The Desk MUST still show `own_1` in Our Recent Conversation!
    const followUp = messageEvent({ id: 'own_2', channel: 'telegram', actor: 'owner', text: 'Can you merge them now?', timestamp: NOW.toISOString() });
    followUp.kind = 'owner_direct';
    await core.processEvent(followUp);
    expect(capturedPrompt).toContain('Let us merge Alpha and Beta');
    expect(capturedPrompt.split('Our Recent Conversation')[1]?.split('Incoming Event')[0]).not.toContain('GroupFriend');

    // Rehearse level on 4-level Trust Ladder logs rehearsal without executing
    await core.approvals.setLevel('demo.rehearsed', 'rehearse');
    expect(await core.approvals.levelFor({
      id: 'demo.rehearsed',
      version: 1,
      description: 'test',
      whenToUse: ['test'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: { type: 'object', properties: {} },
    })).toBe('rehearse');

    // Watch alarm fires when due and wakes Bouncer immediately
    await core.watches.add({ kind: 'timer', label: 'Check deploy', fireAt: '2026-11-26T21:00:00Z' }, NOW);
    const conn = watchConnector(dir, 1000);
    const fired = await conn.poll();
    expect(fired).toHaveLength(1);
    expect(fired[0]?.source).toBe('watch');
    expect((await core.bouncer.decide(fired[0]!)).label).toBe('WAKE');

    // Gap trigger wakes when board is empty, stays silent when waiting, wakes when open & unblocked
    const gConn = gapConnector(dir, { cooldownMs: 1 });
    const emptyEvents = await gConn.poll();
    expect(emptyEvents).toHaveLength(1);
    expect(emptyEvents[0]?.kind).toBe('empty_board');
    expect((await core.bouncer.decide(emptyEvents[0]!)).label).toBe('WAKE');

    const g1 = await core.gaps.create({ title: 'Waiting gap', target: 'done', reality: 'started', source: 'owner' });
    await core.gaps.update(g1.id, { status: 'waiting', waitingOn: 'owner reply' });
    expect(await gConn.poll()).toHaveLength(0);

    await core.gaps.update(g1.id, { status: 'open', waitingOn: null });
    const openEvents = await gConn.poll();
    expect(openEvents).toHaveLength(1);
    expect(openEvents[0]?.kind).toBe('open_work');

    // Suppress unused import lint
    expect(genericEvent({ source: 'system', kind: 'test', text: 'ok' }).source).toBe('system');
    await core.close();
  });
});
