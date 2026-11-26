import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventStore, HeartbeatHub, genericEvent, messageEvent } from '../src';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'rufus-v2-m2-'));

describe('Milestone 2: Lossless Event Store & Embedded Retrieval', () => {
  it('preserves timestamps, deleted flags, reactions, and retrieves semantically relevant events at $0', async () => {
    const dir = await tempDir();
    const store = new EventStore({ workspaceDir: dir });

    const m1 = messageEvent({
      id: 'msg_1',
      channel: 'whatsapp',
      actor: 'Alex',
      text: 'Can we move the Thursday design review to 3pm?',
      timestamp: '2026-11-25T15:10:00Z',
      reactions: [{ emoji: '👍', actor: 'owner', at: '2026-11-25T15:11:00Z' }],
    });
    const m2 = messageEvent({
      id: 'msg_2',
      channel: 'whatsapp',
      actor: 'Sam',
      text: 'Sent you the wrong invoice link earlier',
      timestamp: '2026-11-25T16:00:00Z',
      deleted: true,
    });
    const b1 = genericEvent({
      id: 'br_1',
      source: 'browser',
      kind: 'visit',
      text: 'Stripe billing checkout price IDs documentation',
      timestamp: '2026-11-25T18:00:00Z',
      metadata: { url: 'https://docs.stripe.com/checkout' },
    });

    expect(await store.append(m1)).toBe(true);
    expect(await store.append(m1)).toBe(false); // deduplicated
    expect(await store.append(m2)).toBe(true);
    expect(await store.append(b1)).toBe(true);

    // Update reaction without losing history
    expect(await store.update('msg_2', { reactions: [{ emoji: '🙏', actor: 'owner' }] })).toBe(true);

    // Reload from disk and verify zero data loss
    const reloaded = new EventStore({ workspaceDir: dir });
    expect(await reloaded.count()).toBe(3);
    const hits = await reloaded.search('Stripe checkout billing', 2);
    expect(hits[0]?.event.id).toBe('br_1');

    const recent = await reloaded.recent(10);
    const deletedMsg = recent.find((e) => e.id === 'msg_2');
    expect(deletedMsg?.deleted).toBe(true);
    expect(deletedMsg?.reactions?.[0]?.emoji).toBe('🙏');
  });

  it('HeartbeatHub polls pluggable data connectors on their own intervals', async () => {
    let callsA = 0;
    let callsB = 0;
    const hub = new HeartbeatHub();
    hub.add({
      id: 'fast-source',
      intervalMs: 1000,
      poll: async () => {
        callsA++;
        return [genericEvent({ id: `a_${callsA}`, source: 'message', kind: 'chat', text: 'ping' })];
      },
    });
    hub.add({
      id: 'slow-source',
      intervalMs: 60_000,
      poll: async () => {
        callsB++;
        return [genericEvent({ id: `b_${callsB}`, source: 'email', kind: 'unread', text: 'invoice' })];
      },
    });

    const t1 = await hub.tick(10_000);
    expect(t1.events).toHaveLength(2);
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);

    // 2 seconds later: only fast-source runs
    const t2 = await hub.tick(12_000);
    expect(t2.events).toHaveLength(1);
    expect(callsA).toBe(2);
    expect(callsB).toBe(1);
  });

  it('caches embeddings on disk per modelId so reloads skip re-embedding', async () => {
    const dir = await tempDir();
    let embedCalls = 0;
    const makeEmbedder = () => ({
      modelId: 'test-semantic-v1',
      embed: (text: string) => {
        embedCalls++;
        return [text.includes('ticket') ? 1 : 0, text.includes('bus') ? 1 : 0];
      },
      embedBatch: (texts: string[]) => {
        embedCalls += texts.length;
        return texts.map((t) => [t.includes('ticket') ? 1 : 0, t.includes('bus') ? 1 : 0]);
      },
    });

    const s1 = new EventStore({ workspaceDir: dir, embedder: makeEmbedder() });
    await s1.append(genericEvent({ id: 'e1', source: 'email', kind: 'unread', text: 'train ticket confirmed' }));
    expect(embedCalls).toBe(1);

    // Reload with same modelId: 0 new embed calls thanks to events.vectors.jsonl
    const s2 = new EventStore({ workspaceDir: dir, embedder: makeEmbedder() });
    await s2.load();
    expect(embedCalls).toBe(1);
    expect(await s2.count()).toBe(1);
  });
});
