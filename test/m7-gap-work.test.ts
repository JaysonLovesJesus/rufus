import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeProvider, ROOT_GAP_ID, RufusCore, genericEvent, messageEvent } from '../src';
import { brainTools, clipData, runInvestigateBrain, splitChat } from '../src/brains/states';
import { servesGap } from '../src/events/watches';
import { checkRepeat, logEntry, moveKey } from '../src/gaps/context';
import { GAP_LOG_KEEP, dueIn } from '../src/gaps/store';
import { ToolRegistry } from '../src/scripts/registry';
import type { LosslessEvent, ModelRequest, Receipt } from '../src/types';
import { tempDir } from './helpers';

const T0 = Date.parse('2026-11-27T03:00:00Z');
const isDecide = (req: ModelRequest) => req.system.includes('You are Decide');

/** A core with a scripted Decide, a ticking clock, and a few demo tools. */
async function harness(decide: (turn: number, req: ModelRequest) => unknown, brain?: (req: ModelRequest) => string, opts: { maxTurns?: number } = {}) {
  const dir = await tempDir();
  let clock = T0;
  let turn = 0;
  const sent: string[] = [];
  const edits: Array<{ id: string; text: string }> = [];
  let nextId = 500;
  const reasoning = new FakeProvider((req) => {
    if (isDecide(req)) {
      const out = decide(turn++, req);
      return typeof out === 'string' ? out : JSON.stringify(out);
    }
    return brain ? brain(req) : JSON.stringify({ done: true, facts: [], unknowns: [], summary: 'nothing', passed: false, evidence: 'none' });
  });
  const core = new RufusCore({
    workspaceDir: dir,
    reasoningProvider: reasoning,
    speakerProvider: new FakeProvider(() => 'Here it is.'),
    sink: {
      send: async (t) => {
        sent.push(t);
        return { messageId: String(nextId++) };
      },
      edit: async (id, text) => {
        edits.push({ id, text });
      },
    },
    // Every reading of the clock moves it a second, so moves get distinct times like they do live.
    now: () => new Date((clock += 1000)),
    maxTurnsPerWake: opts.maxTurns ?? 6,
  });
  await core.init();
  let failures = 0;
  await core.registry.registerInline(
    {
      id: 'demo.start',
      version: 1,
      description: 'Starts work in a project',
      whenToUse: ['start work'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: { type: 'object', properties: { action: { type: 'string' }, project: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false },
    },
    async (input) => {
      if (String(input.project).includes('wrong')) {
        failures++;
        return { ok: false, summary: 'Could not start.', error: `No project matches '${String(input.project)}'` };
      }
      return { ok: true, summary: `Started in ${String(input.project)}` };
    },
    { alwaysVisible: true },
  );
  const owner = (text: string, extra: Partial<LosslessEvent> = {}): LosslessEvent => {
    const ev = messageEvent({ channel: 'telegram', actor: 'owner', text, timestamp: new Date((clock += 1000)).toISOString(), ...extra });
    ev.kind = 'owner_direct';
    return ev;
  };
  return {
    dir,
    core,
    sent,
    edits,
    owner,
    failures: () => failures,
    decidePrompts: () => reasoning.calls.filter(isDecide).map((c) => c.prompt),
    brainCalls: () => reasoning.calls.filter((c) => !isDecide(c)),
    tick: (ms: number) => (clock += ms),
    nowIso: () => new Date(clock).toISOString(),
  };
}

const SLEEP = { toolId: 'sleep', input: { reason: 'done' } };
const ok = (r?: Receipt) => r?.status === 'ok';

describe('Milestone 7: gap work log, repeat guard, brains that know the gap, and a safety net that says why', () => {
  it('logs each move on the gap it served, keeps the last 10, and shows them under the gap on the Desk', async () => {
    let gapId = '';
    const h = await harness((t) => (t < 12 ? { gap: gapId, toolId: 'demo.start', input: { action: 'start', project: `/p/${t}` } } : SLEEP), undefined, { maxTurns: 13 });
    gapId = (await h.core.gaps.create({ title: 'Ship the thing', target: 'The thing ships', reality: 'Not yet', source: 'owner' })).id;
    await h.core.processEvent(h.owner('Ship it.'));
    const g = await h.core.gaps.get(gapId);
    expect(g?.log).toHaveLength(GAP_LOG_KEEP);
    const last = g!.log![GAP_LOG_KEEP - 1]!;
    expect(last).toMatchObject({ toolId: 'demo.start', key: 'action=start project=/p/11', status: 'ok', result: 'Started in /p/11' });
    expect(last.wakeId).toMatch(/^wake_/);
    // The Desk shows the log under its gap, before anything else on the page.
    const desk = h.decidePrompts().at(-1)!;
    const tree = desk.split('NEW REALITY')[0]!;
    expect(tree).toContain('Work log (last 10');
    expect(tree).toContain('demo.start action=start project=/p/11 -> ok: Started in /p/11');
  });

  it('rejects the exact move that already failed, across wakes, until the owner speaks again', async () => {
    let gapId = '';
    const move = () => ({ gap: gapId, toolId: 'demo.start', input: { action: 'start', project: '/p/wrong-repo' } });
    const h = await harness((t) => (t % 2 === 0 ? move() : SLEEP), undefined, { maxTurns: 2 });
    gapId = (await h.core.gaps.create({ title: 'Start the work', target: 'Work started', reality: 'Not yet', source: 'owner' })).id;
    await h.core.watches.add({ kind: 'timer', label: 'root look', gapId: ROOT_GAP_ID, fireAt: '2099-01-01T00:00:00Z' });
    await h.core.watches.add({ kind: 'timer', label: 'next', gapId, fireAt: '2099-01-01T00:00:00Z' });

    await h.core.processEvent(h.owner('Start the work.'));
    expect(h.failures()).toBe(1);
    // A later wake (a timer, not the owner) tries the same thing: code refuses before it runs.
    const res = await h.core.processEvent(genericEvent({ source: 'watch', kind: 'timer_due', text: 'Watch fired: retry', timestamp: h.nowIso(), metadata: { gapId } }));
    const first = res.wake!.trace[0]!;
    expect(first.receipt.error).toBe('repeat_failure');
    expect(first.receipt.summary).toContain("No project matches '/p/wrong-repo'");
    expect(h.failures()).toBe(1);
    // New words from the owner are new reality: the same move may run again.
    await h.core.processEvent(h.owner('I created the project, try again.'));
    expect(h.failures()).toBe(2);
  });

  it('rejects a third same-target call when the input and the receipt did not change, but allows a real change', async () => {
    const gaps = [
      {
        id: 'gap_a',
        title: 'Fix the message',
        source: 'owner' as const,
        status: 'open' as const,
        target: 't',
        reality: 'r',
        evidenceIds: [],
        createdAt: '',
        updatedAt: '',
        log: [1, 2].map((n) =>
          logEntry({
            toolId: 'edit_message',
            input: { messageId: '2358', purpose: `Fix the wording of the sermon thoughts, version ${n}` },
            receipt: { toolId: 'edit_message', effect: 'write', status: 'ok', durationMs: 1, summary: 'Edited message 2358 in place.', changes: [], at: '' },
            at: `2026-11-27T03:0${n}:00Z`,
            wakeId: 'wake_x',
            turn: n,
          }),
        ),
      },
    ];
    const reworded = checkRepeat({ gaps, servedGapId: 'gap_a', toolId: 'edit_message', input: { messageId: '2358', purpose: 'Fix the wording of the sermon thoughts, version 3' } });
    expect(reworded?.error).toBe('repeat_target');
    expect(reworded?.summary).toContain('messageId=2358');
    const changed = checkRepeat({ gaps, servedGapId: 'gap_a', toolId: 'edit_message', input: { messageId: '2358', purpose: 'Replace everything with two short questions about rest' } });
    expect(changed).toBeUndefined();
    const otherMessage = checkRepeat({ gaps, servedGapId: 'gap_a', toolId: 'edit_message', input: { messageId: '2360', purpose: 'Fix the wording of the sermon thoughts, version 3' } });
    expect(otherMessage).toBeUndefined();
    // gapId is filled in by code and never part of what a move is about.
    expect(moveKey('x', { gapId: 'gap_a', path: '/a' }).key).toBe('path=/a');
  });

  it('marks truncated reads, keeps brains out of the brain tool list, and returns partial facts before the timeout', async () => {
    expect(clipData('x'.repeat(18229), 4000)).toContain('showing 4000 of 18229 chars');
    const dir = await tempDir();
    const registry = new ToolRegistry({ toolsDir: path.join(dir, 'tools') });
    await registry.registerInline(
      { id: 'files.read', version: 1, description: 'Reads a file', whenToUse: ['read'], effect: 'read', requiresApproval: false, inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
      async () => ({ ok: true, summary: 'lines 1-900 of 900', data: 'L'.repeat(30_000) }),
    );
    await registry.registerInline(
      { id: 'brain.verify', version: 1, description: 'nested brain', whenToUse: ['x'], effect: 'read', requiresApproval: false, inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
      async () => ({ ok: true, summary: 'should never run' }),
    );
    expect(brainTools(registry).map((t) => t.id)).toEqual(['files.read']);

    let step = 0;
    const prompts: string[] = [];
    const provider = new FakeProvider(async (req) => {
      prompts.push(req.prompt);
      step++;
      if (step === 1) return JSON.stringify({ toolId: 'brain.verify', input: {} });
      if (step === 2 || step === 3) return JSON.stringify({ toolId: 'files.read', input: { path: '/x', startLine: step } });
      // The fourth model call hangs past the deadline.
      await new Promise((r) => setTimeout(r, 2000));
      return JSON.stringify({ done: true, facts: ['late'], unknowns: [], summary: 'late' });
    });
    const started = Date.now();
    const res = await runInvestigateBrain({ workspaceDir: dir, provider, registry, question: 'What is in /x?', maxSteps: 6, timeoutMs: 600, now: new Date() });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.partial).toContain('ran out of time');
    expect(res.facts.join(' ')).toContain('files.read: lines 1-900 of 900');
    expect(res.receipts[0]).toMatchObject({ toolId: 'brain.verify', status: 'failed' });
    // The registry marks its cut of a big read; the brain marks its own cut of an older receipt.
    expect(prompts[3]).toContain('[TRUNCATED: showing 24000 of 30000 chars');
    expect(prompts[3]).toMatch(/\[TRUNCATED: showing 4000 of 24\d+ chars/);
  });

  it('picks the gaps in play by meaning and puts their project card on the Desk and into brain missions', async () => {
    let tunes = '';
    const h = await harness(
      (t) => (t === 0 ? { gap: tunes, toolId: 'brain.investigate', input: { question: 'Where does the checkout branch live?' } } : SLEEP),
      () => JSON.stringify({ done: true, facts: ['Checkout lives on the fix-checkout branch'], unknowns: [], summary: 'found it' }),
      { maxTurns: 3 },
    );
    await mkdir(path.join(h.dir, 'projects'), { recursive: true });
    await writeFile(path.join(h.dir, 'projects', 'tunebox.md'), '# Project: Tunebox (piano course)\n\n- **Repo:** `/work/tunebox-friends` (`fix-checkout`)\n- CARD_MARKER\n');
    await writeFile(path.join(h.dir, 'projects', 'chordviz.md'), '# Project: Chordviz\n\n- **Repo:** `/work/chordviz`\n');
    tunes = (await h.core.gaps.create({ title: 'Tunebox paid checkout works', target: 'Tunebox piano course checkout takes a real payment', reality: 'Untested', source: 'owner' })).id;
    h.tick(60_000);
    // A newer, unrelated gap: by recency it would be in play; by meaning it is not.
    await h.core.gaps.create({ title: 'Garden watering schedule', target: 'Tomatoes get watered every morning', reality: 'Ad hoc', source: 'owner' });
    await h.core.processEvent(h.owner('How is the Tunebox checkout coming along?'));
    const desk = h.decidePrompts()[0]!;
    expect(desk).toMatch(new RegExp(`Memories picked for the gaps in play \\(${tunes}`));
    expect(desk).toContain(`${tunes} -> projects/tunebox.md`);
    expect(desk).toContain('CARD_MARKER');
    expect(desk).not.toContain('/work/chordviz');
    // The brain got the gap and the card without Decide retyping them, and its facts went back onto the gap.
    const mission = h.brainCalls()[0]!.prompt;
    expect(mission).toContain('Tunebox piano course checkout takes a real payment');
    expect(mission).toContain('CARD_MARKER');
    expect(mission).toContain('How is the Tunebox checkout coming along?');
    expect((await h.core.gaps.get(tunes))?.findings).toContain('Checkout lives on the fix-checkout branch');
  });

  it('brain.create returns the full content, a chat-length version and the path', async () => {
    expect(splitChat('# Title\n\nLong body.\n===CHAT===\nShort version.')).toEqual({ content: '# Title\n\nLong body.', chat: 'Short version.' });
    expect(splitChat(`Para one.\n\n${'y'.repeat(900)}`).chat).toBe('Para one.');
    let gapId = '';
    const h = await harness((t) => (t === 0 ? { gap: gapId, toolId: 'brain.create', input: { title: 'Bedtime thoughts', brief: 'A few thoughts' } } : SLEEP), () => '# Bedtime thoughts\n\nFULL_BODY_MARKER\n===CHAT===\nCHAT_MARKER', { maxTurns: 3 });
    gapId = (await h.core.gaps.create({ title: 'Thoughts', target: 'A few thoughts in chat', reality: 'none', source: 'owner' })).id;
    const res = await h.core.processEvent(h.owner('Give me a few thoughts.'));
    const data = res.wake!.trace[0]!.receipt.data as { content: string; chat: string; path: string };
    expect(data.content).toContain('FULL_BODY_MARKER');
    expect(data.chat).toBe('CHAT_MARKER');
    expect(await readFile(data.path, 'utf8')).toContain('FULL_BODY_MARKER');
  });

  it('stores a due time from the owner, sorts the Desk by it, and makes verify check the by-when', async () => {
    let soon = '';
    const verifier = (cites: boolean) => () =>
      JSON.stringify(
        cites
          ? { done: true, passed: true, evidence: 'ok', criteria: [{ element: 'what', criterion: 'draft exists', receiptIndex: 1, observed: 'yes', met: true }] }
          : { toolId: 'memory.search', input: { query: 'x' } },
      );
    let brainStep = 0;
    const h = await harness(
      (t) => (t === 0 ? { gap: soon, toolId: 'brain.verify', input: {} } : SLEEP),
      (req) => (brainStep++ === 0 ? verifier(false)() : verifier(true)()),
      { maxTurns: 3 },
    );
    await h.core.gaps.create({ title: 'LATER_MARKER', target: 'later thing', reality: 'r', source: 'owner', due: '2026-12-05T00:00:00Z' });
    soon = (await h.core.gaps.create({ title: 'SOON_MARKER', target: 'sermon notes ready', reality: 'r', source: 'owner', due: new Date(T0 + 26 * 3600_000).toISOString() })).id;
    await h.core.gaps.create({ title: 'UNDATED_MARKER', target: 'whenever', reality: 'r', source: 'owner', due: 'not a date' });
    await h.core.processEvent(h.owner('Is it ready?'));
    const desk = h.decidePrompts()[0]!;
    expect(desk.indexOf('SOON_MARKER')).toBeLessThan(desk.indexOf('LATER_MARKER'));
    expect(desk.indexOf('LATER_MARKER')).toBeLessThan(desk.indexOf('UNDATED_MARKER'));
    expect(desk).toMatch(/due in 26h/);
    expect((await h.core.gaps.list()).find((g) => g.title === 'UNDATED_MARKER')?.due).toBeUndefined();
    // The verifier said PASS but never checked the by-when: code fails it and records why on the gap.
    const g = await h.core.gaps.get(soon);
    expect(g?.status).toBe('open');
    expect(g?.lastVerify?.passed).toBe(false);
    expect(h.brainCalls()[0]!.prompt).toContain('By when: the owner wants this true by');
    expect(dueIn(new Date(T0 - 3 * 3600_000).toISOString(), T0)).toBe('OVERDUE by 3h');
  });

  it('fails any verify criterion without a successful receipt, and keeps the cited receipts on the gap', async () => {
    let gapId = '';
    let step = 0;
    const h = await harness(
      (t) => (t === 0 ? { gap: gapId, toolId: 'brain.verify', input: {} } : SLEEP),
      () =>
        step++ === 0
          ? JSON.stringify({ toolId: 'no.such_tool', input: {} })
          : step === 2
            ? JSON.stringify({ toolId: 'memory.search', input: { query: 'draft' } })
            : JSON.stringify({
                done: true,
                passed: true,
                evidence: 'looks done',
                criteria: [
                  { element: 'what', criterion: 'a draft exists', receiptIndex: 2, observed: 'found', met: true },
                  { element: 'form', criterion: 'sent in chat', receiptIndex: 1, observed: 'assumed', met: true },
                ],
              }),
      { maxTurns: 3 },
    );
    gapId = (await h.core.gaps.create({ title: 'Draft in chat', target: 'A draft, sent in chat', reality: 'r', source: 'owner' })).id;
    const res = await h.core.processEvent(h.owner('Did you send it?'));
    const g = await h.core.gaps.get(gapId);
    expect(g?.status).toBe('open');
    expect(g?.lastVerify?.criteria).toEqual([
      expect.objectContaining({ criterion: 'a draft exists', met: true, receipt: expect.objectContaining({ step: 2, toolId: 'memory.search', status: 'ok' }) }),
      expect.objectContaining({ criterion: 'sent in chat', met: false, receipt: expect.objectContaining({ step: 1, status: 'failed' }) }),
    ]);
    expect(res.wake!.trace[0]!.receipt.summary).toContain('"sent in chat" cites no successful receipt');
  });

  it('retires watches when a gap closes or is dropped, and attaches or retires stray ones at wake start', async () => {
    let dropMe = '';
    const h = await harness((t) => (t === 0 ? { gap: dropMe, toolId: 'gaps.update', input: { status: 'dropped' } } : SLEEP), undefined, { maxTurns: 3 });
    dropMe = (await h.core.gaps.create({ title: 'Unwanted thing', target: 'u', reality: 'r', source: 'owner' })).id;
    const garden = (await h.core.gaps.create({ title: 'Water the tomatoes every morning', target: 'Tomatoes watered every morning', reality: 'r', source: 'owner' })).id;
    const closed = (await h.core.gaps.create({ title: 'Old thing', target: 'o', reality: 'r', source: 'owner' })).id;
    await h.core.gaps.closeVerified(closed, 'done');
    await h.core.watches.add({ kind: 'timer', label: 'chase about it', gapId: dropMe, fireAt: '2099-01-01T00:00:00Z' });
    await h.core.watches.add({ kind: 'timer', label: 'follow up', gapId: closed, fireAt: '2099-01-01T00:00:00Z' });
    await h.core.watches.add({ kind: 'timer', label: 'check the tomatoes were watered this morning', fireAt: '2099-01-01T00:00:00Z' });
    await h.core.watches.add({ kind: 'timer', label: 'Empty board: look around', fireAt: '2099-01-01T00:00:00Z' });
    await h.core.processEvent(h.owner("I don't want the unwanted thing anymore."));
    const active = await h.core.watches.active();
    expect(active.some((w) => w.gapId === dropMe)).toBe(false);
    expect(active.some((w) => w.gapId === closed)).toBe(false);
    expect(active.find((w) => w.label.startsWith('check the tomatoes'))?.gapId).toBe(garden);
    expect(active.find((w) => w.label.startsWith('Empty board'))?.gapId).toBe(ROOT_GAP_ID);
  });

  it('points a new gap at the arrival that raised it, logs messageIds, refuses editing the owner, and updates the log on edit', async () => {
    const gapOf = (req: ModelRequest) => /\[(gap_[a-z0-9]+) \| open \| owner\] Payment link/.exec(req.prompt)?.[1];
    const h = await harness(
      (t, req) =>
        t === 0
          ? { gap: { title: 'Payment link', target: 'The owner has a $99 payment link ready to paste', source: 'owner' }, toolId: 'send_message', input: { purpose: 'Confirm the payment link task' } }
          : t === 1
            ? { gap: gapOf(req), toolId: 'watch.set', input: { kind: 'timer', label: 'chase', minutesFromNow: 30 } }
            : t === 2
              ? { gap: ROOT_GAP_ID, toolId: 'watch.set', input: { kind: 'timer', label: 'next look', minutesFromNow: 60 } }
              : t === 4
                ? { gap: gapOf(req), toolId: 'edit_message', input: { messageId: '41', purpose: 'Edit the owner message' } }
                : t === 5
                  ? { gap: gapOf(req), toolId: 'edit_message', input: { messageId: '500', purpose: 'Add that it takes 5 minutes' } }
                  : SLEEP,
      undefined,
      { maxTurns: 4 },
    );
    const trigger = h.owner('Morning!', { metadata: { messageId: 40 } });
    const ask = h.owner('Can you set up the 99 dollar payment link?', { metadata: { messageId: 41 } });
    await h.core.processEvent(trigger, { additionalEvents: [ask] });
    const gap = (await h.core.gaps.list()).find((g) => g.title === 'Payment link')!;
    expect(gap.evidenceIds).toEqual([ask.id]);
    expect(gap.reality).toContain('Raised by: Can you set up the 99 dollar payment link?');
    const sent = (await h.core.events.recent(50)).find((e) => e.kind === 'assistant_sent');
    expect(sent?.metadata?.messageId).toBe('500');

    const res = await h.core.processEvent(h.owner('Add how long it takes, please.', { metadata: { messageId: 42 } }));
    const chat = h.decidePrompts().at(-1)!.split('Our Recent Conversation')[1]!.split('Incoming Event')[0]!;
    expect(chat).toContain('You (Rufus) [messageId:500]');
    expect(chat).toContain('[messageId:41]');
    const [ownersEdit, ownEdit] = res.wake!.trace;
    expect(ownersEdit!.receipt.error).toBe('not_own_message');
    expect(ok(ownEdit!.receipt)).toBe(true);
    expect(h.edits).toEqual([{ id: '500', text: 'Here it is.' }]);
    const logged = (await h.core.events.recent(50)).find((e) => e.kind === 'assistant_sent' && e.metadata?.messageId === '500');
    expect(logged?.metadata?.editedAt).toBeTruthy();
    expect(logged?.metadata?.originalText).toBe(sent?.text);
  });

  it('records a crashed wake with its partial trace and reason, and schedules ONE quick return that says why', async () => {
    let gapA = '';
    const h = await harness((t) => {
      if (t === 0) return { gap: gapA, toolId: 'demo.start', input: { action: 'start', project: '/p/wrong-place' } };
      throw new Error('model timed out');
    });
    gapA = (await h.core.gaps.create({ title: 'Gap A', target: 'a', reality: 'r', source: 'owner' })).id;
    const gapB = (await h.core.gaps.create({ title: 'Gap B', target: 'b', reality: 'r', source: 'owner' })).id;
    const err = await h.core.processEvent(h.owner('Go.')).then(() => '', (e: Error) => e.message);
    expect(err).toBe('model timed out');
    const wakes = (await readFile(path.join(h.dir, 'wakes.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(wakes.at(-1)).toMatchObject({ endReason: 'crashed', error: 'model timed out', turns: 2 });
    expect(wakes.at(-1).trace[0].toolId).toBe('demo.start');
    const resumes = (await h.core.watches.active()).filter((w) => w.label.startsWith('Resume'));
    expect(resumes).toHaveLength(1);
    const w = resumes[0]!;
    for (const id of [gapA, gapB, ROOT_GAP_ID]) expect(servesGap(w, id)).toBe(true);
    expect(w.label).toContain('it crashed after 2 turn(s): model timed out');
    expect(w.label).toContain("No project matches '/p/wrong-place'");
    // The attempt count lives on each gap, so it survives however the timers fire.
    expect((await h.core.gaps.get(gapA))?.resumeAttempts).toBe(1);
    await h.core.watches.markFired(w.id);
    await h.core.processEvent(genericEvent({ source: 'watch', kind: 'timer_due', text: 'Watch fired: Resume', timestamp: h.nowIso(), metadata: { gapId: gapA, gapIds: w.gapIds } })).catch(() => undefined);
    expect((await h.core.gaps.get(gapB))?.resumeAttempts).toBe(2);
  });
});
