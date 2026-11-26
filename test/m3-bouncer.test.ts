import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bouncer, FakeProvider, RufusCore, messageEvent } from '../src';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'rufus-v2-m3-'));
const NOW = new Date('2026-11-26T14:00:00Z');

describe('Milestone 3: $0 Bouncer & Automatic Training Feedback', () => {
  it('learns SLEEP vs WAKE from pushbacks, approvals, and Opus sleep decisions', async () => {
    const dir = await tempDir();
    const bouncer = new Bouncer({ workspaceDir: dir });

    // Seed with small set of SLEEP and WAKE examples
    for (const txt of [
      'source:message | kind:chat | actor:Partner | Love you so much!',
      'source:message | kind:chat | actor:Partner | Goodnight sweet dreams',
      'source:email | kind:newsletter | Weekly marketing digest unsubscribe',
      'source:message | kind:chat | actor:Friend | lol haha ok',
    ]) {
      await bouncer.recordExample({ text: txt, label: 'SLEEP', source: 'seed', at: NOW.toISOString() });
    }
    for (const txt of [
      'source:email | kind:alert | Stripe payment failed urgent action required',
      'source:calendar | kind:change | Client rescheduled 3pm meeting to 4pm',
      'source:message | kind:chat | actor:Teammate | Production build is broken on main branch',
      'source:email | kind:request | Can you send the contract invoice before 5pm?',
    ]) {
      await bouncer.recordExample({ text: txt, label: 'WAKE', source: 'seed', at: NOW.toISOString() });
    }

    const personal = messageEvent({ channel: 'chat', actor: 'Partner', text: 'Love you, goodnight!', timestamp: NOW.toISOString() });
    const urgent = messageEvent({ channel: 'chat', actor: 'Teammate', text: 'Production build is broken on main!', timestamp: NOW.toISOString() });

    expect((await bouncer.decide(personal)).label).toBe('SLEEP');
    expect((await bouncer.decide(urgent)).label).toBe('WAKE');

    // Direct message from owner always wakes via rule
    const direct = messageEvent({ channel: 'cli', actor: 'owner', text: 'hey', timestamp: NOW.toISOString() });
    direct.kind = 'owner_direct';
    const d = await bouncer.decide(direct);
    expect(d.label).toBe('WAKE');
    expect(d.backend).toBe('rule');
  });

  it('logs SLEEP label automatically when reasoning model wakes and immediately calls sleep', async () => {
    const dir = await tempDir();
    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: new FakeProvider(() => JSON.stringify({ toolId: 'sleep', input: { reason: 'Not actionable' } })),
      speakerProvider: new FakeProvider(() => 'unused'),
      sink: { send: async () => undefined },
      now: () => NOW,
    });

    const ev = messageEvent({ channel: 'email', actor: 'Promo', text: '50% off winter sale today only', timestamp: NOW.toISOString() });
    const res = await core.processEvent(ev);
    expect(res.wake?.acted).toBe(false);
    const counts = await core.bouncer.exampleCount();
    expect(counts.sleep).toBe(1);
    await core.close();
  });
});
