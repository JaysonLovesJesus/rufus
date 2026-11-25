import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AiVerificationError,
  CorpusStore,
  FakeProvider,
  MasterLoop,
  TrustStore,
  appendSignal,
  emptyAnchor,
  formatLoopReport,
  inboxSensor,
  loadAnchor,
  saveAnchor,
  upsertScheduleBlock,
  type LoopPlan,
  type LoopSignal,
  type Sensor,
  type SignalHandler,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 8, 0);

/** A sensor fed from an array; the cursor is how many were already handed out. */
function listSensor(signals: LoopSignal[], id = 'test'): Sensor & { polls: Array<string | undefined> } {
  const polls: Array<string | undefined> = [];
  return {
    id,
    surface: 'chat',
    polls,
    poll(cursor) {
      polls.push(cursor);
      const from = Number(cursor ?? 0);
      return { signals: signals.slice(from), nextCursor: String(signals.length) };
    },
  };
}

const chat = (id: string, text: string, over: Partial<LoopSignal> = {}): LoopSignal => ({ id, surface: 'chat', kind: 'message.received', text, actor: 'Sam Rivera', ...over });

interface Draft {
  reply: string;
}

/** A small reply handler: code drafts, a cross-check wants a question mark answered with a time. */
function replyHandler(over: Partial<SignalHandler<Draft>> = {}, log: string[] = []): SignalHandler<Draft> {
  return {
    id: 'reply',
    match: { surface: 'chat', kind: 'message.received' },
    plan(signal, ctx) {
      log.push(`plan:${ctx.attempt}:${ctx.replan?.reason ?? ''}`);
      return { goal: `Answer ${signal.actor} with a concrete time`, actionType: 'reply.chat', route: ctx.replan ? ctx.replan.nextRoute : 'code' };
    },
    async execute(plan, signal, ctx) {
      log.push(`execute:${plan.route}`);
      if (plan.route === 'code') return { reply: 'ok' };
      return { reply: await ctx.ai(`Reply to: ${signal.text}`) };
    },
    crossCheck(result) {
      return /\d/.test(result.reply) ? { ok: true } : { ok: false, reason: 'no time in the reply' };
    },
    commit(output) {
      log.push(`commit:${(output as Draft).reply}`);
    },
    ...over,
  };
}

describe('Master Loop: sense', () => {
  it('zero signals: idle, cost 0, and no model is ever called', async () => {
    const dir = await tempDir();
    const fast = new FakeProvider([]);
    const loop = new MasterLoop({ dir, sensors: [listSensor([])], handlers: [replyHandler()], providers: { fast }, now: () => NOW });
    const r = await loop.runOnce();
    expect(r).toMatchObject({ status: 'idle', cost: 0, signals: 0, runs: [] });
    expect(fast.calls).toHaveLength(0);
    expect(formatLoopReport(r)).toEqual(['Idle: no new signals. Cost: 0 model calls.']);
  });

  it('persists cursors in loop-state.json, never handles a signal twice, and reports unhandled ones', async () => {
    const dir = await tempDir();
    const signals = [chat('1', 'free at 3?'), { id: '2', surface: 'chat', kind: 'reaction' }];
    const sensor = listSensor(signals);
    const loop = new MasterLoop({ dir, sensors: [sensor], handlers: [replyHandler()], now: () => NOW });
    const first = await loop.runOnce();
    expect(first.status).toBe('ran');
    expect(first.runs).toHaveLength(1);
    expect(first.unhandled.map((s) => s.id)).toEqual(['2']);
    expect(JSON.parse(await readFile(path.join(dir, 'loop-state.json'), 'utf8')).cursors).toEqual({ test: '2' });

    // A fresh loop (new process) picks the cursor up; a sensor that re-sends old signals does not cause repeats.
    const again = new MasterLoop({ dir, sensors: [{ ...listSensor(signals), poll: () => ({ signals: [signals[0]!] }) }], handlers: [replyHandler()], now: () => NOW });
    const second = await again.runOnce();
    expect(second).toMatchObject({ status: 'idle', cost: 0, duplicates: 1 });
    const third = new MasterLoop({ dir, sensors: [sensor], handlers: [replyHandler()], now: () => NOW });
    await third.runOnce();
    expect(sensor.polls).toEqual([undefined, '2']);
  });

  it('a failing sensor keeps its cursor and does not stop the others', async () => {
    const dir = await tempDir();
    const broken: Sensor = { id: 'broken', surface: 'x', poll: () => Promise.reject(new Error('offline')) };
    const loop = new MasterLoop({ dir, sensors: [broken, listSensor([chat('1', 'at 3?')])], handlers: [replyHandler({ crossCheck: undefined })], now: () => NOW });
    const r = await loop.runOnce();
    expect(r.errors).toEqual([{ sensorId: 'broken', error: 'offline' }]);
    expect(r.runs).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(dir, 'loop-state.json'), 'utf8')).cursors).toEqual({ test: '1' });
    expect(formatLoopReport(r)[0]).toBe('sensor broken failed (will retry next pass): offline');
  });
});

describe('Master Loop: plan -> execute -> verify', () => {
  it('a failed cross-check re-plans up the spectrum (code -> fast), then waits for the human at check', async () => {
    const dir = await tempDir();
    const log: string[] = [];
    const fast = new FakeProvider(['Sure, 3pm works']);
    const loop = new MasterLoop({ dir, sensors: [listSensor([chat('1', 'free at 3?')])], handlers: [replyHandler({}, log)], providers: { fast }, now: () => NOW });
    const r = await loop.runOnce();
    expect(log).toEqual(['plan:0:', 'execute:code', 'plan:1:no time in the reply', 'execute:fast']);
    expect(r.cost).toBe(1);
    const run = await loop.getRun(r.runs[0]!.runId);
    expect(run).toMatchObject({
      status: 'awaiting_human_verify',
      actionType: 'reply.chat',
      route: 'fast',
      replans: 1,
      verified: true,
      crossCheck: 'passed',
      autonomy: 'check',
      result: { reply: 'Sure, 3pm works' },
      aiCalls: 1,
    });
    expect(run.trail.map((t) => [t.route, t.outcome])).toEqual([
      ['code', 'failed'],
      ['fast', 'passed'],
    ]);
    expect(run.spectrum).toMatchObject({ fast: 1, human: 1 });
    expect(fast.calls[0]!.meta).toMatchObject({ flowId: 'loop:reply', step: 'execute', attempt: 1 });
    expect((await loop.pending()).map((p) => p.id)).toEqual([run.id]);
  });

  it('bounded re-plans: still failing goes to the human with the failure, never loops forever', async () => {
    const dir = await tempDir();
    const fast = new FakeProvider(['sure', 'sure!']);
    const loop = new MasterLoop({ dir, sensors: [listSensor([chat('1', 'free?')])], handlers: [replyHandler({ maxReplans: 2 })], providers: { fast }, now: () => NOW });
    const r = await loop.runOnce();
    const run = await loop.getRun(r.runs[0]!.runId);
    expect(run).toMatchObject({ status: 'awaiting_human_verify', verified: false, crossCheck: 'failed', replans: 2, route: 'smart' });
    expect(run.verifyFailure).toBe('still failing after 2 re-plan(s): no time in the reply');
    expect(fast.calls).toHaveLength(2); // smart falls back to the configured provider
  });

  it('a model that fails its own check is a failed attempt to re-plan, not a crash', async () => {
    const dir = await tempDir();
    let n = 0;
    const handler = replyHandler({
      maxReplans: 1,
      execute: () => {
        if (n++ === 0) throw new AiVerificationError('draft', 'empty draft', 2, '');
        return { reply: 'at 4' };
      },
    });
    const loop = new MasterLoop({ dir, sensors: [listSensor([chat('1', 'when?')])], handlers: [handler], now: () => NOW });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run.trail.map((t) => t.reason ?? t.outcome)).toEqual(['empty draft', 'passed']);
    expect(run.status).toBe('awaiting_human_verify');
  });

  it('autonomous actions complete directly and commit; check actions wait', async () => {
    const dir = await tempDir();
    const trust = new TrustStore(dir);
    await trust.promote('reply.chat');
    const log: string[] = [];
    const loop = new MasterLoop({ dir, trust, sensors: [listSensor([chat('1', 'at 3?')])], handlers: [replyHandler({ execute: () => ({ reply: 'yes, 3pm' }) }, log)], now: () => NOW });
    const r = await loop.runOnce();
    expect(r.runs[0]).toMatchObject({ status: 'completed', actionType: 'reply.chat', route: 'code' });
    const run = await loop.getRun(r.runs[0]!.runId);
    expect(run).toMatchObject({ committed: true, autonomy: 'autonomous' });
    expect(run.spectrum.human).toBe(0);
    expect(log).toContain('commit:yes, 3pm');
  });

  it('external, money and login actions always wait for approval, even when autonomous; never-rules block before execution', async () => {
    const dir = await tempDir();
    const trust = new TrustStore(dir);
    await trust.promote('reply.chat');
    await trust.promote('social.post');
    await saveAnchor(dir, { ...emptyAnchor(NOW), boundaries: [{ id: 'no-posts', rule: 'Never post publicly', kind: 'never', appliesTo: ['social.post'] }] }, NOW);
    const executed: string[] = [];
    const loop = new MasterLoop({
      dir,
      trust,
      sensors: [listSensor([chat('1', 'at 3?'), chat('2', 'post this', { kind: 'post.request' })])],
      handlers: [
        replyHandler({ plan: () => ({ goal: 'Send a reply', actionType: 'reply.chat', route: 'code', sensitivity: ['external'] }), execute: () => ({ reply: 'yes 3pm' }) }),
        {
          id: 'post',
          match: { kind: 'post.request' },
          plan: () => ({ goal: 'Post it', actionType: 'social.post', route: 'code' }),
          execute: () => void executed.push('post'),
        },
      ],
      now: () => NOW,
    });
    const r = await loop.runOnce();
    const [reply, post] = await Promise.all(r.runs.map((x) => loop.getRun(x.runId)));
    expect(reply).toMatchObject({ status: 'awaiting_human_verify', autonomy: 'autonomous' });
    expect(reply!.approvals).toEqual(['Always ask before anything external is sent.']);
    expect(post).toMatchObject({ status: 'blocked', blockedBy: ['Never post publicly'] });
    expect(executed).toEqual([]);
  });

  it('pauses with a draft plan when the plan is genuinely unclear; accept runs the draft, edit re-plans with the human words', async () => {
    const dir = await tempDir();
    const seen: Array<string | undefined> = [];
    const handler: SignalHandler<string, LoopPlan> = {
      id: 'brief',
      match: { kind: 'research.request' },
      plan(signal, ctx) {
        seen.push(ctx.humanInput);
        return ctx.humanInput
          ? { goal: `Brief on ${ctx.humanInput}`, actionType: 'research.brief', route: 'code' }
          : { goal: 'Brief on something', actionType: 'research.brief', route: 'code', needsHumanPlan: true, question: 'Which topic exactly?' };
      },
      execute: (plan) => `BRIEF: ${plan.goal}`,
    };
    const loop = new MasterLoop({ dir, sensors: [listSensor([chat('1', 'look into it', { kind: 'research.request' }), chat('2', 'that thing', { kind: 'research.request' })])], handlers: [handler], now: () => NOW });
    const r = await loop.runOnce();
    const [a, b] = r.runs.map((x) => x.runId);
    const paused = await loop.getRun(a!);
    expect(paused).toMatchObject({ status: 'awaiting_human_plan', question: 'Which topic exactly?', draftPlan: { goal: 'Brief on something' } });
    expect(paused.result).toBeUndefined(); // nothing was executed

    const accepted = await loop.resolveHumanDecision(a!, { verdict: 'accept' });
    expect(accepted.run).toMatchObject({ status: 'awaiting_human_verify', result: 'BRIEF: Brief on something', goal: 'Brief on something' });
    expect(accepted.trust).toBeUndefined(); // a plan decision is not a verdict on the action

    const edited = await loop.resolveHumanDecision(b!, { verdict: 'edit', editedOutput: 'solar batteries' });
    expect(edited.run).toMatchObject({ status: 'awaiting_human_verify', result: 'BRIEF: Brief on solar batteries' });
    expect(seen).toEqual([undefined, undefined, 'solar batteries']);
  });

  it('physical steps become a clear human step; a plan routed to human does too', async () => {
    const dir = await tempDir();
    const handler: SignalHandler<unknown, LoopPlan> = {
      id: 'video',
      match: (s) => s.kind === 'content.request',
      plan: (s) =>
        s.text === 'record'
          ? { goal: 'Record the intro video', actionType: 'content.video', route: 'code', needsHumanExecute: true, humanStep: 'Record a 60-second intro video and drop it in ~/Videos.' }
          : { goal: 'Call the venue', actionType: 'content.call', route: 'human' },
      execute: () => {
        throw new Error('never runs');
      },
    };
    const loop = new MasterLoop({ dir, sensors: [listSensor([chat('1', 'record', { kind: 'content.request' }), chat('2', 'call', { kind: 'content.request' })])], handlers: [handler], now: () => NOW });
    const r = await loop.runOnce();
    const [rec, call] = await Promise.all(r.runs.map((x) => loop.getRun(x.runId)));
    expect(rec).toMatchObject({ status: 'awaiting_human_execute', humanStep: 'Record a 60-second intro video and drop it in ~/Videos.' });
    expect(call).toMatchObject({ status: 'awaiting_human_execute', humanStep: 'Call the venue' });
    const done = await loop.resolveHumanDecision(rec!.id, { verdict: 'accept', note: 'uploaded' });
    expect(done.run.status).toBe('accepted');
    expect(done.trust).toBeUndefined();
    expect(done.example.kind).toBe('execute.accept');
  });

  it('a handler that throws marks its run as an error, and the pass carries on', async () => {
    const dir = await tempDir();
    const loop = new MasterLoop({
      dir,
      sensors: [listSensor([chat('1', 'x'), chat('2', 'y', { kind: 'other' })])],
      handlers: [
        { id: 'bad', match: { kind: 'message.received' }, plan: () => ({ goal: '', actionType: 'a.b', route: 'code' }), execute: () => 1 },
        { id: 'good', match: { kind: 'other' }, plan: () => ({ goal: 'g', actionType: 'a.c', route: 'code' }), execute: () => 1 },
      ],
      now: () => NOW,
    });
    const r = await loop.runOnce();
    expect(r.runs.map((x) => x.status)).toEqual(['error', 'awaiting_human_verify']);
    expect((await loop.getRun(r.runs[0]!.runId)).error).toMatch(/non-empty goal/);
  });
});

describe('Master Loop: record', () => {
  it('a human verdict updates trust, applies the edit, and becomes a corpus example the next plan retrieves', async () => {
    const dir = await tempDir();
    const log: string[] = [];
    const retrieved: string[][] = [];
    const sensor = listSensor([chat('1', 'free at 3 tomorrow?')]);
    const handler = replyHandler(
      {
        plan(signal, ctx) {
          retrieved.push(ctx.examples({ actionType: 'reply.chat' }).map((h) => h.item.summary));
          return { goal: 'Answer with a time', actionType: 'reply.chat', route: 'code' };
        },
        execute: () => ({ reply: 'yes at 3' }),
      },
      log,
    );
    const loop = new MasterLoop({ dir, sensors: [sensor], handlers: [handler], now: () => NOW });
    const runId = (await loop.runOnce()).runs[0]!.runId;

    const r = await loop.resolveHumanDecision(runId, { verdict: 'edit', editedOutput: { reply: 'yes! 3pm works' }, note: 'warmer' });
    expect(r.run).toMatchObject({ status: 'edited', committed: true, decision: { verdict: 'edit', note: 'warmer', stage: 'verify' } });
    expect(log).toContain('commit:yes! 3pm works');
    expect(r.trust!.record).toMatchObject({ actionType: 'reply.chat', edited: 1, consecutiveClean: 0 });

    const items = await new CorpusStore(path.join(dir, 'corpus', 'items.jsonl')).load();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'feedback', kind: 'verify.edit', actor: 'Sam Rivera', tags: ['reply.chat', 'edit', 'chat', 'loop'] });
    expect(items[0]!.summary).toBe('In: free at 3 tomorrow? | Proposed: {"reply":"yes at 3"} | Human: edit -> {"reply":"yes! 3pm works"} | Note: warmer');
    expect(items[0]!.metadata).toMatchObject({ runId, verdict: 'edit', final: '{"reply":"yes! 3pm works"}' });

    await expect(loop.resolveHumanDecision(runId, { verdict: 'accept' })).rejects.toThrow(/not waiting for a decision \(it is edited\)/);
    await expect(loop.resolveHumanDecision('loop_nope', { verdict: 'accept' })).rejects.toThrow(/No loop run/);

    // The very next signal's plan sees the example: learning is immediate.
    const next = new MasterLoop({ dir, sensors: [listSensor([chat('1', 'free at 3 tomorrow?'), chat('2', 'free at 3 on friday?')])], handlers: [handler], now: () => NOW });
    await next.runOnce();
    expect(retrieved[0]).toEqual([]);
    expect(retrieved[1]![0]).toContain('Human: edit');
  });

  it('reject never commits; enough clean accepts surface the promotion question on the next pause', async () => {
    const dir = await tempDir();
    const log: string[] = [];
    const trust = new TrustStore(dir, { promotionThreshold: 2 });
    const signals = [chat('1', 'a 1'), chat('2', 'b 2'), chat('3', 'c 3'), chat('4', 'd 4')];
    const loop = new MasterLoop({ dir, trust, sensors: [listSensor(signals)], handlers: [replyHandler({ execute: (_p, s) => ({ reply: s.text! }) }, log)], now: () => NOW });
    const ids = (await loop.runOnce()).runs.map((r) => r.runId);
    const rejected = await loop.resolveHumanDecision(ids[0]!, { verdict: 'reject', note: 'too blunt' });
    expect(rejected.run).toMatchObject({ status: 'rejected' });
    expect(rejected.run.committed).toBeUndefined();
    expect(log.filter((l) => l.startsWith('commit'))).toEqual([]);
    await loop.resolveHumanDecision(ids[1]!, { verdict: 'accept' });
    const second = await loop.resolveHumanDecision(ids[2]!, { verdict: 'accept' });
    expect(second.promotionHint).toContain("You've approved reply.chat cleanly 2 times");

    // A later pause carries the hint; promoting makes the next one complete on its own.
    const more = new MasterLoop({ dir, trust, sensors: [listSensor([...signals, chat('5', 'e 5')])], handlers: [replyHandler({ execute: (_p, s) => ({ reply: s.text! }) }, log)], now: () => NOW });
    const paused = await more.getRun((await more.runOnce()).runs[0]!.runId);
    expect(paused).toMatchObject({ status: 'awaiting_human_verify', promotionSuggested: true });
    expect(paused.promotionHint).toContain('want me to stop checking with you?');
  });
});

describe('Master Loop: built-ins and CLI', () => {
  it('the inbox sensor reads appended lines once, skips broken ones and gives id-less signals a stable id', async () => {
    const dir = await tempDir();
    const sensor = inboxSensor(dir);
    const ctx = { dir, anchor: emptyAnchor(NOW), now: NOW };
    expect(await sensor.poll(undefined, ctx)).toEqual({ signals: [] });
    await appendSignal(dir, { surface: 'email', kind: 'received', text: 'invoice' }, NOW);
    await appendFile(path.join(dir, 'inbox.jsonl'), '{ broken\n{"surface":"chat","kind":"x"}\n');
    const first = await sensor.poll(undefined, ctx);
    expect(first.nextCursor).toBe('3');
    expect(first.signals.map((s) => [s.surface, s.kind])).toEqual([
      ['email', 'received'],
      ['chat', 'x'],
    ]);
    expect(first.signals[1]!.id).toBe((await sensor.poll('0', ctx)).signals[1]!.id); // stable
    expect((await sensor.poll('3', ctx)).signals).toEqual([]);
  });

  it('the schedule handler proposes, refuses overlaps, and writes the Anchor only once approved', async () => {
    const dir = await tempDir();
    await saveAnchor(dir, upsertScheduleBlock(emptyAnchor(NOW), { start: '09:00', end: '11:00', title: 'Deep work', kind: 'protected' }).anchor, NOW);
    await writeFile(
      path.join(dir, 'inbox.jsonl'),
      [
        { id: 'a', surface: 'anchor', kind: 'schedule.request', data: { range: '12:00-13:00', title: 'Gym', kind: 'personal' } },
        { id: 'b', surface: 'anchor', kind: 'schedule.request', data: { start: '10:00', end: '10:30', title: 'Call', kind: 'meeting' } },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
    const run = async (...args: string[]) => {
      const lines: string[] = [];
      await main(['--dir', dir, ...args], { out: (l) => void lines.push(l), err: (l) => void lines.push(l) });
      return lines.join('\n');
    };
    const pass = await run('loop', '--once');
    expect(pass).toContain('Sensed 2 new signal(s); 2 handled, 0 with no handler. Cost: 0 model call(s).');
    expect(pass).toContain('Decide with: rufus decide <runId> accept|edit|reject [note]');
    const status = await run('loop', 'status');
    expect(status).toContain('Waiting on you (2):');
    expect(status).toContain('cross-check: still failing after 0 re-plan(s): overlaps 09:00-11:00 "Deep work"');
    const [gym, call] = [...status.matchAll(/^(loop_[0-9a-f]+)/gm)].map((m) => m[1]!);
    expect((await loadAnchor(dir, NOW)).schedule.blocks).toHaveLength(1); // nothing applied before approval

    const decided = await run('decide', gym!, 'accept', 'looks', 'right');
    expect(decided).toContain(`Recorded accept on ${gym}: now accepted (applied).`);
    expect(decided).toContain('Trust for schedule.block: check, clean streak 1/10.');
    expect((await loadAnchor(dir, NOW)).schedule.blocks.map((b) => `${b.start} ${b.title} ${b.source}`)).toEqual(['09:00 Deep work undefined', '12:00 Gym rufus']);

    // Moving the call by editing: the human's version is what gets applied.
    const moved = await run('decide', call!, 'edit', '--output', '{"date":"2026-11-25","block":{"start":"11:00","end":"11:30","title":"Call","kind":"meeting"}}');
    expect(moved).toContain('now edited (applied)');
    expect((await loadAnchor(dir, NOW)).schedule.blocks.map((b) => b.title)).toEqual(['Deep work', 'Call', 'Gym']);

    expect(await run('loop', '--once')).toBe('Idle: no new signals. Cost: 0 model calls.');
    expect(await run('loop', 'status')).toBe('No loop runs waiting on you.');
    expect(await run('trust')).toContain('schedule.block  check  accepted 1 · edited 1');
    await expect(run('decide', gym!, 'maybe')).rejects.toThrow(/Usage: rufus decide/);
  });

  it('rufus signal queues into the inbox', async () => {
    const dir = await tempDir();
    const lines: string[] = [];
    await main(['--dir', dir, 'signal', 'chat', 'message.received', 'hello', 'there', '--data', '{"thread":"t1"}'], { out: (l) => void lines.push(l), err: (l) => void lines.push(l) });
    expect(lines[0]).toMatch(/^Queued signal sig_[0-9a-f]+ \(chat\/message\.received\)/);
    const saved = JSON.parse((await readFile(path.join(dir, 'inbox.jsonl'), 'utf8')).trim());
    expect(saved).toMatchObject({ surface: 'chat', kind: 'message.received', text: 'hello there', data: { thread: 't1' } });
    const out: string[] = [];
    await main(['--dir', dir, 'loop', '--once'], { out: (l) => void out.push(l), err: (l) => void out.push(l) });
    expect(out.join('\n')).toContain('no handler for chat/message.received');
  });
});
