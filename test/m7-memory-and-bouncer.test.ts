import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bouncer, EventStore, FakeProvider, RufusCore, genericEvent, messageEvent } from '../src';
import type { SetFitRunner } from '../src/bouncer/bouncer';
import { formatTrainingMetrics, relabelFromWakes, resolveExamples, scoreLabels, shouldPromote, splitHeldOut } from '../src/bouncer/training';
import { formatRecall, recallForDesk } from '../src/events/recall';
import { isRealChange } from '../src/rpg/outcome';
import type { BouncerExample, BouncerLabel, LosslessEvent, Receipt } from '../src/types';
import { tempDir } from './helpers';

const NOW = new Date('2026-11-27T12:00:00Z');
const at = NOW.toISOString();

function ownerSays(text: string, id?: string): LosslessEvent {
  const ev = messageEvent({ ...(id ? { id } : {}), channel: 'telegram', actor: 'owner', text, timestamp: at });
  ev.kind = 'owner_direct';
  return ev;
}

function rufusSent(id: string, text: string, timestamp = at): LosslessEvent {
  return genericEvent({ id, source: 'message', kind: 'assistant_sent', actor: 'rufus', text, timestamp });
}

describe('Memory: provenance', () => {
  it('tags every event as observed, owner-said or Rufus-claimed, and keeps it across reloads', async () => {
    const dir = await tempDir();
    const store = new EventStore({ workspaceDir: dir });
    await store.append(ownerSays('Book the dentist', 'o1'));
    await store.append(rufusSent('r1', 'Booked the dentist for Tuesday'));
    await store.append(genericEvent({ id: 'e1', source: 'email', kind: 'received', text: 'Dentist appointment confirmed', timestamp: at }));
    await store.append(genericEvent({ id: 's1', source: 'self', kind: 'actions', actor: 'rufus', text: 'calendar.write: added dentist', timestamp: at }));
    const reloaded = new EventStore({ workspaceDir: dir });
    const byId = Object.fromEntries((await reloaded.recent(10)).map((e) => [e.id, e.provenance]));
    expect(byId).toEqual({ o1: 'owner_said', r1: 'rufus_claimed', e1: 'observed', s1: 'rufus_claimed' });
  });

  it("ranks the facts above Rufus's own claims, and a superseded claim lower still", async () => {
    const dir = await tempDir();
    const store = new EventStore({ workspaceDir: dir });
    const text = 'Study with the tutor calendar block is on Thursday';
    await store.append(rufusSent('claim', `${text} (no longer on it)`));
    await store.append(genericEvent({ id: 'fact', source: 'calendar', kind: 'event', text, timestamp: at }));
    const hits = await store.search('Study with the tutor calendar block', 2, { now: NOW });
    expect(hits.map((h) => h.event.id)).toEqual(['fact', 'claim']);

    const before = hits[1]!.score;
    await store.append(ownerSays('No, the tutor block is still on the calendar', 'owner_fix'));
    expect(await store.supersede('claim', 'owner_fix', { reason: 'still on the calendar' })).toBe(true);
    const after = (await store.search('Study with the tutor calendar block', 5, { now: NOW })).find((h) => h.event.id === 'claim')!;
    expect(after.score).toBeLessThan(before);
    expect(after.event.metadata?.supersededBy).toBe('owner_fix');
  });

  it('does not store Rufus\'s own message again when it comes back through another channel', async () => {
    const dir = await tempDir();
    const store = new EventStore({ workspaceDir: dir });
    await store.append(rufusSent('r1', 'Your train leaves at 9:40.'));
    const echo = messageEvent({ channel: 'beeper:telegram', actor: 'Rufus', text: 'Your train leaves at 9:40.', timestamp: at });
    expect(await store.append(echo)).toBe(false);
    expect(await store.count()).toBe(1);
  });

  it('memory.supersede marks a claim superseded by what the owner just said, and refuses to supersede facts', async () => {
    const dir = await tempDir();
    let turn = 0;
    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: new FakeProvider((req) => {
        if (!req.system.includes('You are Decide')) return '{}';
        turn++;
        if (turn === 1) return JSON.stringify({ gap: gapId, toolId: 'memory.supersede', input: { claimId: 'claim', reason: 'the block is still there' } });
        if (turn === 2) return JSON.stringify({ gap: gapId, toolId: 'memory.supersede', input: { claimId: 'fact', reason: 'x' } });
        return JSON.stringify({ toolId: 'sleep', input: { reason: 'done' } });
      }),
      speakerProvider: new FakeProvider(() => 'ok'),
      sink: { send: async () => undefined },
      now: () => NOW,
      maxTurnsPerWake: 3,
    });
    await core.init();
    const gapId = (await core.gaps.create({ title: 'Calendar right', target: 'Calendar facts are right', reality: 'unclear', source: 'owner', now: NOW })).id;
    await core.events.append(rufusSent('claim', 'The study block is no longer on the calendar'));
    await core.events.append(genericEvent({ id: 'fact', source: 'calendar', kind: 'event', text: 'Study block Thursday', timestamp: at }));
    const res = await core.processEvent(ownerSays('That is wrong, the study block is still there', 'pushback_msg'));
    expect(res.wake?.trace[0]?.receipt.status).toBe('ok');
    expect(res.wake?.trace[1]?.receipt.status).toBe('failed');
    expect((await core.events.get('claim'))?.metadata?.supersededBy).toBe('pushback_msg');
    expect((await core.events.get('fact'))?.metadata?.supersededBy).toBeUndefined();
    await core.close();
  });
});

describe('Memory: keyword and recency scoring', () => {
  // An embedder that sees no meaning at all, so only the keyword and recency parts can rank.
  const blind = { modelId: 'blind', embed: () => [1, 0], embedBatch: (t: string[]) => t.map(() => [1, 0]) };

  it('finds an exact code by keyword even when meaning cannot tell the events apart', async () => {
    const store = new EventStore({ workspaceDir: await tempDir(), embedder: blind });
    for (let i = 0; i < 5; i++) await store.append(genericEvent({ id: `n${i}`, source: 'email', kind: 'received', text: `Booking reference for your trip ${i}`, timestamp: at }));
    await store.append(genericEvent({ id: 'voucher', source: 'email', kind: 'received', text: 'Your voucher QXZT77120 is ready', timestamp: at }));
    const hits = await store.search('voucher QXZT77120', 1, { now: NOW });
    expect(hits[0]?.event.id).toBe('voucher');
  });

  it('folds accents so a Portuguese word matches without them', async () => {
    const store = new EventStore({ workspaceDir: await tempDir(), embedder: blind });
    await store.append(genericEvent({ id: 'pt', source: 'message', kind: 'chat', text: 'Não vou conseguir amanhã', timestamp: at }));
    await store.append(genericEvent({ id: 'en', source: 'message', kind: 'chat', text: 'See you tomorrow', timestamp: at }));
    expect((await store.search('nao consigo', 1, { now: NOW }))[0]?.event.id).toBe('pt');
  });

  it('prefers the newer of two equally relevant memories', async () => {
    const store = new EventStore({ workspaceDir: await tempDir(), embedder: blind });
    await store.append(genericEvent({ id: 'old', source: 'email', kind: 'received', text: 'Flight gate B12', timestamp: '2026-09-01T00:00:00Z' }));
    await store.append(genericEvent({ id: 'new', source: 'email', kind: 'received', text: 'Flight gate B12 ', timestamp: '2026-11-26T00:00:00Z' }));
    expect((await store.search('flight gate', 2, { now: NOW })).map((h) => h.event.id)).toEqual(['new', 'old']);
  });
});

describe('Memory: one search per gap in play', () => {
  it('searches for the trigger and each gap separately, and labels which gap each memory serves', async () => {
    const store = new EventStore({ workspaceDir: await tempDir() });
    for (let i = 0; i < 8; i++) await store.append(genericEvent({ id: `lunch${i}`, source: 'email', kind: 'received', text: `Lunch order number ${i} is ready`, timestamp: at }));
    await store.append(genericEvent({ id: 'zebra', source: 'email', kind: 'received', text: 'Zebra budget spreadsheet totals came to 4200', timestamp: at }));
    await store.append(genericEvent({ id: 'visa', source: 'email', kind: 'received', text: 'Lisbon visa application approved', timestamp: at }));
    const gaps = [
      { id: 'gap_a', title: 'Reconcile the zebra budget', target: 'The zebra budget spreadsheet totals are reconciled', reality: 'Not yet' },
      { id: 'gap_b', title: 'Lisbon trip ready', target: 'Visa approved and packing done', reality: 'Visa pending' },
    ] as unknown as Parameters<typeof recallForDesk>[1]['gaps'];
    const hits = await recallForDesk(store, { triggerText: 'Lunch order is ready', gaps, k: 4, excludeIds: [], now: NOW });
    expect(hits.find((h) => h.event.id === 'zebra')?.serves).toBe('gap_a');
    expect(hits.find((h) => h.event.id === 'visa')?.serves).toBe('gap_b');
    expect(hits.some((h) => h.serves === 'event')).toBe(true);
    const block = formatRecall(hits, gaps, (iso) => iso);
    expect(block.indexOf('For gap_a')).toBeLessThan(block.indexOf('Zebra budget'));
    expect(block).toContain('For the new event:');
  });

  it('the Desk labels each memory with the gap it was picked for', async () => {
    const dir = await tempDir();
    const prompts: string[] = [];
    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: new FakeProvider((req) => {
        prompts.push(req.prompt);
        return JSON.stringify({ toolId: 'sleep', input: { reason: 'done' } });
      }),
      speakerProvider: new FakeProvider(() => 'ok'),
      sink: { send: async () => undefined },
      now: () => NOW,
      maxTurnsPerWake: 1,
    });
    await core.init();
    const g = await core.gaps.create({ title: 'Reconcile the zebra budget', target: 'The zebra budget spreadsheet totals are reconciled', reality: 'Not yet', source: 'owner', now: NOW });
    await core.events.append(genericEvent({ source: 'email', kind: 'received', text: 'Zebra budget spreadsheet totals came to 4200', timestamp: at }));
    await core.processEvent(genericEvent({ source: 'watch', kind: 'timer_due', text: 'Watch fired: check in', timestamp: at, metadata: { gapId: g.id } }));
    expect(prompts[0]).toContain(`For ${g.id} (Reconcile the zebra budget):\n- [`);
    await core.close();
  });
});

describe('Bouncer: labels from what a wake really changed', () => {
  const r = (toolId: string, effect: Receipt['effect'], status: Receipt['status'] = 'ok', changes: string[] = []) => ({ toolId, effect, status, changes });

  it('counts writes, sends and drafts, not reads or scheduling the next look', () => {
    expect(isRealChange(r('gmail.recent', 'read'))).toBe(false);
    expect(isRealChange(r('watch.set', 'write'))).toBe(false);
    expect(isRealChange(r('sleep', 'meta'))).toBe(false);
    expect(isRealChange(r('send_message', 'write'))).toBe(true);
    expect(isRealChange(r('calendar.write', 'write', 'pending_approval'))).toBe(true);
    expect(isRealChange(r('send_message', 'write', 'failed'))).toBe(false);
    expect(isRealChange(r('memory.search', 'read', 'ok', ['gap_created:gap_x']))).toBe(true);
  });

  it('a wake that only reads is labelled SLEEP, a wake that writes is labelled WAKE, both tied to the event', async () => {
    const dir = await tempDir();
    let gapId = '';
    let plan: string[] = [];
    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: new FakeProvider((req) => {
        if (!req.system.includes('You are Decide')) return '{}';
        const next = plan.shift();
        return next ? JSON.stringify({ gap: gapId, toolId: next, input: next === 'memory.search' ? { query: 'x' } : {} }) : JSON.stringify({ toolId: 'sleep', input: { reason: 'done' } });
      }),
      speakerProvider: new FakeProvider(() => 'ok'),
      sink: { send: async () => undefined },
      now: () => NOW,
      maxTurnsPerWake: 3,
    });
    await core.init();
    await core.registry.registerInline(
      { id: 'demo.write', version: 1, description: 'Writes', whenToUse: ['w'], effect: 'write', requiresApproval: false, inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
      async () => ({ ok: true, summary: 'wrote', changes: ['demo'] }),
      { alwaysVisible: true },
    );
    gapId = (await core.gaps.create({ title: 'Inbox handled', target: 'Mail that matters is handled', reality: 'unread', source: 'owner', now: NOW })).id;
    await core.watches.add({ kind: 'timer', label: 'next', gapId, fireAt: '2099-01-01T00:00:00Z' }, NOW);
    await core.watches.add({ kind: 'timer', label: 'next', gapId: 'gap_root', fireAt: '2099-01-01T00:00:00Z' }, NOW);

    plan = ['memory.search'];
    const readOnly = genericEvent({ id: 'mail_read', source: 'email', kind: 'received', text: '"date": "2026-11-26T21:22:33Z",', timestamp: at });
    expect((await core.processEvent(readOnly)).wake?.acted).toBe(false);
    plan = ['demo.write'];
    const real = genericEvent({ id: 'mail_real', source: 'email', kind: 'received', text: 'Please confirm the ticket by tonight', timestamp: at });
    expect((await core.processEvent(real)).wake?.acted).toBe(true);

    const lines = (await fs.readFile(path.join(dir, 'training', 'bouncer.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as BouncerExample);
    expect(lines.map((l) => [l.eventId, l.label])).toEqual([
      ['mail_read', 'SLEEP'],
      ['mail_real', 'WAKE'],
    ]);
    await core.close();
  });

  it('owner pushback on what Rufus sent relabels the wake that sent it', async () => {
    const dir = await tempDir();
    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: new FakeProvider(() => JSON.stringify({ toolId: 'sleep', input: { reason: 'done' } })),
      speakerProvider: new FakeProvider(() => 'ok'),
      sink: { send: async () => undefined },
      now: () => NOW,
    });
    await core.init();
    const trigger = messageEvent({ id: 'mom_msg', channel: 'whatsapp', actor: 'Mom', text: 'Thinking of you both today', timestamp: at });
    await core.events.append(trigger);
    const sent = rufusSent('rufus_reply', 'Thank you, that is a lovely thought');
    await core.events.append(sent);
    await fs.writeFile(
      path.join(dir, 'wakes.jsonl'),
      `${JSON.stringify({ wakeId: 'w1', at, trigger: { id: 'mom_msg', source: 'message', kind: 'chat', text: trigger.text }, sentMessages: [sent.text], trace: [] })}\n`,
    );
    await core.recordFeedback(sent, 'pushback');
    const lines = (await fs.readFile(path.join(dir, 'training', 'bouncer.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as BouncerExample);
    expect(lines.at(-1)).toMatchObject({ eventId: 'mom_msg', label: 'SLEEP', source: 'pushback' });
    expect((await core.events.get('rufus_reply'))?.metadata?.supersededBy).toBe('owner:pushback');
    await core.close();
  });

  it('cleans the label log: drops non-event text, owner signals win, repeats merge, wakes are re-derived', async () => {
    const ex = (text: string, label: BouncerLabel, source: BouncerExample['source'], eventId?: string): BouncerExample => ({ text, label, source, at, ...(eventId ? { eventId } : {}) });
    const mom = 'source:message | kind:chat | actor:Mom | channel:whatsapp | Thinking of you';
    const frag = 'source:email | kind:unread | "date": "2026-11-26T21:22:33Z",';
    const { examples, stats } = resolveExamples(
      [
        ex('approval:calendar.write', 'WAKE', 'approval'),
        ex(mom, 'WAKE', 'opus_acted', 'm1'),
        ex(mom, 'SLEEP', 'pushback', 'm1'),
        ex(frag, 'WAKE', 'opus_acted'),
        ex(frag, 'SLEEP', 'opus_sleep'),
        ex(frag, 'SLEEP', 'opus_sleep'),
      ],
      new Map([[frag, 'SLEEP' as BouncerLabel]]),
    );
    expect(stats.notFeatureText).toBe(1);
    expect(stats.relabeled).toBe(1);
    expect(examples.find((x) => x.text === mom)?.label).toBe('SLEEP');
    expect(examples.find((x) => x.text === frag)?.label).toBe('SLEEP');
    expect(examples).toHaveLength(2);
  });

  it('re-derives old wake labels from the trace: a read then sleep is SLEEP', async () => {
    const dir = await tempDir();
    const ev = genericEvent({ id: 'gm1', source: 'email', kind: 'unread', text: '{', timestamp: at });
    await fs.writeFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(ev)}\n`);
    const receipt = (toolId: string, effect: string) => ({ toolId, effect, status: 'ok', summary: '', changes: [], durationMs: 0, at });
    await fs.writeFile(
      path.join(dir, 'wakes.jsonl'),
      `${JSON.stringify({ trigger: { id: 'gm1' }, trace: [{ toolId: 'gmail.recent', receipt: receipt('gmail.recent', 'read') }, { toolId: 'sleep', receipt: receipt('sleep', 'meta') }] })}\n`,
    );
    const map = await relabelFromWakes(dir);
    expect(map.get('gm1')).toBe('SLEEP');
    expect(map.get(Bouncer.eventToFeatureText(ev))).toBe('SLEEP');
  });
});

describe('Bouncer: a retrain is promoted only if it is no worse', () => {
  function fakeRunner(predictions: Record<string, (text: string) => BouncerLabel>): SetFitRunner & { trained: number } {
    const runner = {
      trained: 0,
      async train(_data: string, modelDir: string) {
        runner.trained++;
        await fs.mkdir(modelDir, { recursive: true });
        await fs.writeFile(path.join(modelDir, 'config.json'), JSON.stringify({ name: `model${runner.trained}` }));
        return { ok: true, seconds: 0 };
      },
      async predict(modelDir: string, texts: readonly string[]) {
        const name = (JSON.parse(await fs.readFile(path.join(modelDir, 'config.json'), 'utf8')) as { name: string }).name;
        return texts.map((t) => predictions[name]!(t));
      },
    };
    return runner;
  }

  async function seeded(dir: string) {
    const lines: BouncerExample[] = [];
    for (let i = 0; i < 40; i++) lines.push({ text: `source:email | kind:received | newsletter digest ${i}`, label: 'SLEEP', source: 'opus_sleep', at });
    for (let i = 0; i < 15; i++) lines.push({ text: `source:message | kind:chat | actor:Friend${i} | urgent call me ${i}`, label: 'WAKE', source: 'opus_acted', at });
    await fs.mkdir(path.join(dir, 'training'), { recursive: true });
    await fs.writeFile(path.join(dir, 'training', 'bouncer.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }

  it('keeps a held-out set out of training, with WAKE examples in it', () => {
    const exs: BouncerExample[] = Array.from({ length: 3 }, (_, i) => ({ text: `source:x | kind:y | wake ${i}`, label: 'WAKE' as const, source: 'opus_acted' as const, at }));
    const { train, heldOut } = splitHeldOut(exs);
    expect(heldOut.some((x) => x.label === 'WAKE')).toBe(true);
    expect(train.filter((x) => heldOut.includes(x))).toHaveLength(0);
  });

  it('promotes the first model, rejects one with lower WAKE recall, promotes one that holds it, and keeps the previous model', async () => {
    const dir = await tempDir();
    await seeded(dir);
    const truth = (t: string): BouncerLabel => (t.includes('urgent') ? 'WAKE' : 'SLEEP');
    const runner = fakeRunner({ model1: truth, model2: () => 'SLEEP', model3: truth });
    const bouncer = new Bouncer({ workspaceDir: dir, runner });
    const modelName = async (d: string) => (JSON.parse(await fs.readFile(path.join(d, 'config.json'), 'utf8')) as { name: string }).name;

    const first = await bouncer.trainSetFit({ now: NOW });
    expect(first).toMatchObject({ ok: true, promoted: true });
    expect(await modelName(bouncer.modelDir)).toBe('model1');

    const worse = await bouncer.trainSetFit({ now: NOW });
    expect(worse).toMatchObject({ ok: true, promoted: false });
    expect(worse.candidate?.recall).toBe(0);
    expect(await modelName(bouncer.modelDir)).toBe('model1');
    await expect(fs.stat(bouncer.candidateDir)).rejects.toThrow();

    const same = await bouncer.trainSetFit({ now: NOW });
    expect(same).toMatchObject({ ok: true, promoted: true });
    expect(await modelName(bouncer.modelDir)).toBe('model3');
    expect(await modelName(bouncer.previousDir)).toBe('model1');

    const metrics = await Bouncer.readMetrics(dir);
    expect(metrics?.heldOut.wake).toBeGreaterThan(0);
    expect(metrics?.candidate.recall).toBe(1);
    expect(formatTrainingMetrics(metrics).join('\n')).toMatch(/R=1/);
  });

  it('scores WAKE precision and recall', () => {
    const m = scoreLabels(['WAKE', 'WAKE', 'SLEEP', 'SLEEP'], ['WAKE', 'SLEEP', 'WAKE', 'SLEEP']);
    expect(m).toMatchObject({ precision: 0.5, recall: 0.5, accuracy: 0.5 });
    expect(shouldPromote(m, { ...m, recall: 0.75 }).promote).toBe(false);
  });
});
