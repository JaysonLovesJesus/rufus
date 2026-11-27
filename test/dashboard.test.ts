import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDashboard } from '../src/dashboard/server';

// A synthetic workspace: neutral, made-up data only.
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const wake = {
  wakeId: 'wake_test0001',
  at: iso(60_000),
  trigger: { id: 'evt_1', source: 'message', kind: 'user_message', actor: 'owner', text: 'Please water the plants' },
  decision: { label: 'WAKE', confidence: 0.9, backend: 'prototype' },
  turns: 2,
  durationMs: 4_000,
  acted: true,
  slept: true,
  sentMessages: ['Done, the plants are watered.'],
  trace: [
    {
      turn: 1,
      thought: 'Tell the owner it is done.',
      gapId: 'gap_plants',
      toolId: 'send_message',
      input: { text: 'Done, the plants are watered.' },
      receipt: { toolId: 'send_message', effect: 'write', status: 'ok', durationMs: 20, summary: 'Sent', changes: [], data: { text: 'Done, the plants are watered.' }, at: iso(62_000) },
    },
    {
      turn: 2,
      thought: 'Nothing else to do.',
      toolId: 'sleep',
      input: {},
      receipt: { toolId: 'sleep', effect: 'read', status: 'ok', durationMs: 1, summary: 'Asleep', changes: [], at: iso(61_000) },
    },
  ],
};

let dir: string;
let dash: Awaited<ReturnType<typeof startDashboard>>;

function get(urlPath: string, host?: string): Promise<{ status: number; body: string }> {
  const u = new URL(urlPath, dash.url);
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: host ? { host } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'rufus-dash-'));
  await writeFile(
    path.join(dir, 'gaps.json'),
    JSON.stringify([
      { id: 'gap_plants', parentId: 'gap_root', title: 'Plants stay alive', source: 'owner', status: 'open', target: 'Plants watered weekly', reality: 'Watered today', evidenceIds: [], createdAt: iso(3_600_000), updatedAt: iso(60_000) },
    ]),
  );
  await writeFile(path.join(dir, 'watches.json'), JSON.stringify([{ id: 'watch_1', kind: 'timer', label: 'Check the plants again', gapId: 'gap_plants', fireAt: new Date(now + 3_600_000).toISOString(), createdAt: iso(60_000) }]));
  await writeFile(path.join(dir, 'live.json'), JSON.stringify({ status: 'asleep', wakeId: wake.wakeId, endedAt: iso(60_000) }));
  await writeFile(path.join(dir, 'wakes.jsonl'), jsonl([wake]));
  await writeFile(path.join(dir, 'events.jsonl'), jsonl([{ id: 'evt_1', source: 'message', kind: 'user_message', actor: 'owner', text: 'Please water the plants', timestamp: iso(70_000) }]));
  dash = await startDashboard({ workspaceDir: dir, port: 0, healthCheck: async () => false });
});

afterAll(async () => {
  await dash?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('dashboard', () => {
  it('binds to loopback only', () => {
    expect(dash.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
  });

  it('serves a snapshot of the whole anatomy', async () => {
    const res = await get('/api/snapshot');
    expect(res.status).toBe(200);
    const snap = JSON.parse(res.body);
    expect(snap.outline).toHaveLength(10);
    expect(snap.live.status).toBe('asleep');
    expect(snap.daemon.up).toBe(false);
    expect(snap.anatomy.senses.length).toBeGreaterThan(0);
    expect(snap.gaps.map((g: { id: string }) => g.id)).toEqual(expect.arrayContaining(['gap_root', 'gap_plants']));
    expect(snap.wakes.map((w: { wakeId: string }) => w.wakeId)).toContain(wake.wakeId);
    expect(snap.credits).toBeDefined();
    expect(typeof snap.credits.left5hPct).toBe('number');
    expect(snap.telemetry).toBeDefined();
    expect(typeof snap.telemetry.medianTurns).toBe('number');
  });

  it('serves one wake for playback, and 404 for an unknown one', async () => {
    const res = await get(`/api/wake/${wake.wakeId}`);
    expect(res.status).toBe(200);
    const w = JSON.parse(res.body);
    expect(w.trace).toHaveLength(2);
    expect(w.trace[0].receipt.sentText).toBe('Done, the plants are watered.');
    expect(w.trace[0].receipt.realChange).toBe(true);
    expect(w.trace[1].receipt.realChange).toBe(false);
    expect((await get('/api/wake/wake_nope')).status).toBe(404);
  });

  it('serves the timeline', async () => {
    const res = await get('/api/timeline?hours=24');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).wakes).toHaveLength(1);
  });

  it('refuses requests addressed to another host name', async () => {
    expect((await get('/api/snapshot', 'evil.example:4747')).status).toBe(403);
  });

  it('serves the page itself', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<svg');
  });
});

describe('dashboard: newer records (end reasons, cost, due dates, work log, sense health)', () => {
  let dir2: string;
  let dash2: Awaited<ReturnType<typeof startDashboard>>;
  const getJson = async (urlPath: string) => {
    const res = await fetch(new URL(urlPath, dash2.url));
    return { status: res.status, body: await res.json() };
  };
  const base = { ...wake, sentMessages: [], trace: wake.trace.slice(0, 1) };

  beforeAll(async () => {
    dir2 = await mkdtemp(path.join(os.tmpdir(), 'rufus-dash2-'));
    await writeFile(
      path.join(dir2, 'wakes.jsonl'),
      jsonl([
        { ...base, wakeId: 'wake_crash001', slept: false, turns: 1, endReason: 'crashed', error: 'model call failed', costUsd: 0.12, modelCalls: [{ ok: true, costUsd: 0.1 }, { ok: false, costUsd: 0.02 }] },
        { ...base, wakeId: 'wake_garble01', slept: false, turns: 3, endReason: 'unreadable', modelCalls: [{ ok: true, costUsd: 0.05 }] },
        { ...base, wakeId: 'wake_capped01', slept: false, turns: 25, endReason: 'turn_cap' },
        { ...base, wakeId: 'wake_old00001', slept: false, turns: 4 },
      ]),
    );
    await writeFile(
      path.join(dir2, 'gaps.json'),
      JSON.stringify([
        {
          id: 'gap_garden',
          parentId: 'gap_root',
          title: 'Garden is weeded',
          source: 'owner',
          status: 'open',
          target: 'No weeds',
          reality: 'Some weeds',
          evidenceIds: [],
          due: new Date(now + 26 * 3_600_000).toISOString(),
          log: [1, 2, 3, 4].map((n) => ({ at: iso(n * 60_000), toolId: 'memory.search', key: `q${n}`, inputHash: 'a', resultHash: 'b', inputText: 'q', status: 'ok', result: `Found note ${n}` })),
          createdAt: iso(3_600_000),
          updatedAt: iso(60_000),
        },
      ]),
    );
    await writeFile(
      path.join(dir2, 'senses.json'),
      JSON.stringify({
        updatedAt: iso(1_000),
        senses: {
          gmail: { id: 'gmail', intervalMs: 60_000, status: 'broken', problem: '4 failed polls in a row', consecutiveFailures: 4, eventsLastHour: 0, events24h: 0, polls24h: 10, failures24h: 4, duplicates24h: 0, repeats24h: 0, parseFailures24h: 0, avgLatencyMs: 10, buckets: [] },
          telegram: { id: 'telegram', intervalMs: 0, status: 'ok', consecutiveFailures: 0, eventsLastHour: 1, events24h: 3, polls24h: 10, failures24h: 0, duplicates24h: 0, repeats24h: 0, parseFailures24h: 0, avgLatencyMs: 10, buckets: [] },
        },
      }),
    );
    dash2 = await startDashboard({ workspaceDir: dir2, port: 0, healthCheck: async () => true });
  });

  afterAll(async () => {
    await dash2?.close();
    await rm(dir2, { recursive: true, force: true });
  });

  it('reads the ending from endReason, and infers it for older records', async () => {
    const { body: snap } = await getJson('/api/snapshot');
    const ending = Object.fromEntries(snap.wakes.map((w: { wakeId: string; ending: string }) => [w.wakeId, w.ending]));
    expect(ending).toEqual({ wake_crash001: 'crashed', wake_garble01: 'unreadable', wake_capped01: 'cap', wake_old00001: 'safety' });
    expect(snap.anatomy.sleep.ended24h).toMatchObject({ crashed: 1, unreadable: 1, cap: 1, safety: 1, sleep: 0 });
  });

  it('reports model cost per wake and over 24h', async () => {
    const { body: snap } = await getJson('/api/snapshot');
    expect(snap.anatomy.desk.metered24h).toBe(2);
    expect(snap.anatomy.desk.cost24h).toBeCloseTo(0.17);
    expect(snap.anatomy.desk.modelCalls24h).toBe(3);
    const { body: w } = await getJson('/api/wake/wake_crash001');
    expect(w).toMatchObject({ ending: 'crashed', error: 'model call failed', costUsd: 0.12, modelCalls: 2, modelFailures: 1 });
  });

  it('passes a gap’s due date and its last three work-log moves', async () => {
    const { body: snap } = await getJson('/api/snapshot');
    const g = snap.gaps.find((x: { id: string }) => x.id === 'gap_garden');
    expect(g.due).toBeTruthy();
    expect(g.log.map((e: { result: string }) => e.result)).toEqual(['Found note 2', 'Found note 3', 'Found note 4']);
  });

  it('marks a broken sense on its plate row and lists every sense’s health', async () => {
    const { body: snap } = await getJson('/api/snapshot');
    const email = snap.anatomy.senses.find((s: { id: string }) => s.id === 'email');
    expect(email).toMatchObject({ health: 'broken' });
    expect(email.problem).toContain('4 failed polls');
    expect(snap.anatomy.senses.find((s: { id: string }) => s.id === 'message').health).toBe('ok');
    expect(snap.anatomy.senseHealth.map((h: { id: string }) => h.id).sort()).toEqual(['gmail', 'telegram']);
  });
});
