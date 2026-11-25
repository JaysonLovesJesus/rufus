import { describe, expect, it } from 'vitest';
import {
  Engine,
  FakeProvider,
  defineFlow,
  defineStagedFlow,
  routeRank,
  upgradeRoute,
  type HumanCard,
  type ReplanFeedback,
  type Route,
  type StagePlan,
  type StagedResult,
} from '../src';
import { tempDir } from './helpers';

const saved = (engine: Engine, runId: string) => engine.store.getRun(runId);
const noRetry = { maxRetries: 0 };

/** A tiny reply task: the goal is "at most 3 words". Routes and failures are injected per test. */
interface Reply extends StagePlan {
  prompt?: string;
}
const threeWords = (text: string) => (text.trim().split(/\s+/).length <= 3 ? ({ ok: true } as const) : ({ ok: false, reason: `"${text}" is longer than 3 words` } as const));

function replyFlow(opts: { route: (feedback?: ReplanFeedback) => Route; maxReplans?: number; seen?: ReplanFeedback[]; id?: string }) {
  return defineStagedFlow<{ who: string }, string, Reply>(
    { id: opts.id ?? 'reply', name: 'reply', description: 'reply' },
    {
      maxReplans: opts.maxReplans,
      plan: (input, ctx) => {
        if (ctx.replan) opts.seen?.push(ctx.replan);
        const route = opts.route(ctx.replan);
        return {
          goal: `Reply to ${input.who} in at most 3 words.`,
          route,
          criteria: ['at most 3 words'],
          prompt: ctx.replan ? `Reply to ${input.who} in at most 3 words. Last time: ${ctx.replan.reason}` : `Reply to ${input.who}.`,
        };
      },
      execute: async (plan, ctx) => (plan.route === 'code' ? 'on it' : ctx.ai('draft', { prompt: plan.prompt ?? plan.goal, ...noRetry })),
      verify: (text) => threeWords(text),
    },
  );
}

describe('ctx.staged: plan -> execute -> verify', () => {
  it('runs a pure-code unit with no model call, and counts the stages in the spectrum', async () => {
    const fast = new FakeProvider([]);
    const smart = new FakeProvider([]);
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [replyFlow({ route: () => 'code' })] });
    const r = await engine.start('reply', { who: 'Sam' });
    expect(r).toMatchObject({
      status: 'completed',
      output: { status: 'passed', route: 'code', result: 'on it', replans: 0, goal: 'Reply to Sam in at most 3 words.', trail: [{ attempt: 0, route: 'code', outcome: 'passed' }] },
    });
    expect(fast.calls.length + smart.calls.length).toBe(0);
    // plan (code) + execute (code) + verify (code)
    expect((await saved(engine, r.runId)).spectrum).toEqual({ code: 3, fast: 0, smart: 0, human: 0 });
  });

  it('runs plan -> execute -> verify in that order, and hands each stage the plan', async () => {
    const order: string[] = [];
    const flow = defineStagedFlow<string, string, StagePlan & { n: number }>(
      { id: 'order', name: 'o', description: 'o' },
      {
        plan: (input, ctx) => {
          order.push(`plan:${ctx.stage}`);
          return { goal: `shout ${input}`, route: 'code', n: 7 };
        },
        execute: (plan, ctx) => {
          order.push(`execute:${ctx.stage}:${ctx.route}`);
          return `${plan.n}-${plan.goal.toUpperCase()}`;
        },
        verify: (result, plan, ctx) => {
          order.push(`verify:${ctx.stage}`);
          return result.endsWith('SHOUT HI') && plan.n === 7 ? { ok: true } : { ok: false, reason: 'wrong' };
        },
      },
    );
    const engine = new Engine({ store: await tempDir(), flows: [flow] });
    const r = await engine.start('order', 'hi');
    expect(r).toMatchObject({ status: 'completed', output: { status: 'passed', result: '7-SHOUT HI' } });
    expect(order).toEqual(['plan:plan', 'execute:execute:code', 'verify:verify']);
  });

  it('upfront routing: a plan that routes straight to smart never calls the fast model', async () => {
    const fast = new FakeProvider([]);
    const smart = new FakeProvider(['sure thing']);
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [replyFlow({ route: () => 'smart' })] });
    const r = await engine.start('reply', { who: 'Sam' });
    expect(r).toMatchObject({ status: 'completed', output: { status: 'passed', route: 'smart', result: 'sure thing', replans: 0 } });
    expect(fast.calls).toHaveLength(0); // no cheap -> medium -> expensive cascade
    expect(smart.calls).toHaveLength(1);
    // plan (code) + execute (smart) + verify (code)
    expect((await saved(engine, r.runId)).spectrum).toEqual({ code: 2, fast: 0, smart: 1, human: 0 });
  });

  it('upfront routing: a fast route never touches the smart model when it passes', async () => {
    const fast = new FakeProvider(['sure thing']);
    const smart = new FakeProvider([]);
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [replyFlow({ route: () => 'fast' })] });
    const r = await engine.start('reply', { who: 'Sam' });
    expect(r).toMatchObject({ output: { status: 'passed', route: 'fast', replans: 0 } });
    expect(fast.calls).toHaveLength(1);
    expect(smart.calls).toHaveLength(0);
    expect((await saved(engine, r.runId)).spectrum).toEqual({ code: 2, fast: 1, smart: 0, human: 0 });
  });

  it('inside execute, ctx.ai defaults to the planned route, and an explicit tier still wins', async () => {
    const fast = new FakeProvider(['fast']);
    const smart = new FakeProvider(['smart']);
    const flow = defineStagedFlow<null, string[]>(
      { id: 'tiers', name: 't', description: 't' },
      {
        plan: () => ({ goal: 'two drafts', route: 'smart' }),
        execute: async (_plan, ctx) => [await ctx.ai('a', { prompt: 'p', ...noRetry }), await ctx.ai('b', { prompt: 'p', tier: 'fast', ...noRetry })],
        verify: () => ({ ok: true }),
      },
    );
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [flow] });
    expect(await engine.start('tiers')).toMatchObject({ output: { result: ['smart', 'fast'] } });
  });
});

describe('re-plan escalation on verify failure', () => {
  it('feeds the failure reason into plan, upgrades the route, and re-executes', async () => {
    const seen: ReplanFeedback[] = [];
    const fast = new FakeProvider(['this is far too long']);
    const smart = new FakeProvider(['short one']);
    const flow = replyFlow({ seen, route: (fb) => (fb ? fb.nextRoute : 'fast') });
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [flow] });
    const r = await engine.start('reply', { who: 'Sam' });

    expect(r).toMatchObject({ status: 'completed', output: { status: 'passed', route: 'smart', result: 'short one', replans: 1 } });
    const output = (r as { output: StagedResult<string, Reply> }).output;
    expect(output.trail).toEqual([
      { attempt: 0, route: 'fast', goal: 'Reply to Sam in at most 3 words.', outcome: 'failed', reason: '"this is far too long" is longer than 3 words' },
      { attempt: 1, route: 'smart', goal: 'Reply to Sam in at most 3 words.', outcome: 'passed' },
    ]);

    // The re-plan saw the exact failure, what failed, and the suggested upgrade.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ attempt: 1, reason: '"this is far too long" is longer than 3 words', previousRoute: 'fast', nextRoute: 'smart', lastResult: 'this is far too long' });
    // ... and the smart model's prompt carried that reason (the plan was updated, not blindly retried).
    expect(smart.calls[0]!.messages[0]!.content).toContain('Last time: "this is far too long" is longer than 3 words');
    // One call per rung: the fast model was not retried, and smart was only asked after the re-plan.
    expect(fast.calls).toHaveLength(1);
    expect(smart.calls).toHaveLength(1);
  });

  it('a re-plan can never go cheaper than the route that just failed', async () => {
    const fast = new FakeProvider(['this is far too long', 'ok then']);
    const flow = replyFlow({ route: () => 'fast' }); // a planner that stubbornly says "fast" every time still re-runs on fast
    const engine = new Engine({ store: await tempDir(), providers: { fast }, flows: [flow] });
    expect(await engine.start('reply', { who: 'Sam' })).toMatchObject({ output: { status: 'passed', route: 'fast', replans: 1 } });

    const downgrade = replyFlow({ id: 'down', route: (fb) => (fb ? 'code' : 'smart') });
    const smart = new FakeProvider(['far too many words in here', 'ok then']);
    const e2 = new Engine({ store: await tempDir(), providers: { smart }, flows: [downgrade] });
    const r = await e2.start('down', { who: 'Sam' });
    // The re-plan asked for `code`; the engine kept it on `smart`, so execute asked the model again rather than returning canned text.
    expect(r).toMatchObject({ output: { status: 'passed', route: 'smart', result: 'ok then' } });
    expect(smart.calls).toHaveLength(2);
  });

  it('a model that cannot pass its own step check counts as a failed attempt and is re-planned, not a crashed run', async () => {
    const fast = new FakeProvider(['too long for this check', 'still too long for it']);
    const smart = new FakeProvider(['ok then']);
    const flow = defineStagedFlow<null, string>(
      { id: 'selfcheck', name: 's', description: 's' },
      {
        plan: (_i, ctx) => ({ goal: 'tiny reply', route: ctx.replan ? 'smart' : 'fast' }),
        execute: (_plan, ctx) => ctx.ai('draft', { prompt: 'p', verify: threeWords, maxRetries: 1 }),
        verify: () => ({ ok: true }),
      },
    );
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [flow] });
    const r = await engine.start('selfcheck');
    expect(r).toMatchObject({ status: 'completed', output: { status: 'passed', route: 'smart', result: 'ok then', replans: 1 } });
    expect(fast.calls).toHaveLength(2); // the step's own retry, then the re-plan
  });
});

describe('maxReplans bound -> human', () => {
  const never = (_: string) => ({ ok: false, reason: 'not good enough' }) as const;
  const alwaysFailing = (maxReplans?: number, route: (fb?: ReplanFeedback) => Route = (fb) => fb?.nextRoute ?? 'fast') =>
    defineStagedFlow<null, string>(
      { id: 'never', name: 'n', description: 'n' },
      {
        maxReplans,
        plan: (_i, ctx) => ({ goal: 'an impossible goal', route: route(ctx.replan) }),
        execute: (_plan, ctx) => ctx.ai('draft', { prompt: 'p', ...noRetry }),
        verify: never,
        human: ({ reason, goal }) => ({ title: 'Take over', summary: `${goal} :: ${reason}`, options: ['done'] }),
      },
    );

  it('with the default maxReplans (1): fast fails, one re-plan on smart fails, then a human decides', async () => {
    const dir = await tempDir();
    const fast = new FakeProvider(['a']);
    const smart = new FakeProvider(['b']);
    const first = await new Engine({ store: dir, providers: { fast, smart }, flows: [alwaysFailing()] }).start('never');
    expect(first.status).toBe('waiting_human');
    expect(fast.calls).toHaveLength(1);
    expect(smart.calls).toHaveLength(1);
    const card = (first as { card: HumanCard }).card;
    expect(card.step).toBe('never.human');
    expect(card.summary).toBe('an impossible goal :: verification still failed after 1 re-plan(s): not good enough');

    // Answering resumes without re-calling either model: every attempt and verdict is saved.
    const silent = new FakeProvider([]);
    const engine = new Engine({ store: dir, providers: { fast: silent, smart: silent }, flows: [alwaysFailing()] });
    const done = await engine.answer(card.id, { choice: 'done' });
    expect(done).toMatchObject({
      status: 'completed',
      output: { status: 'human', route: 'human', replans: 1, answer: { choice: 'done' }, lastResult: 'b', trail: [{ route: 'fast', outcome: 'failed' }, { route: 'smart', outcome: 'failed' }] },
    });
    expect(silent.calls).toHaveLength(0);
    expect((await saved(engine, done.runId)).spectrum).toMatchObject({ fast: 1, smart: 1, human: 1 });
  });

  it('maxReplans 0 means no re-plan at all: the first failure goes to a human', async () => {
    const fast = new FakeProvider(['a']);
    const smart = new FakeProvider([]);
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [alwaysFailing(0)] });
    const r = await engine.start('never');
    expect(r.status).toBe('waiting_human');
    expect((r as { card: HumanCard }).card.summary).toContain('after 0 re-plan(s)');
    expect(fast.calls).toHaveLength(1);
    expect(smart.calls).toHaveLength(0);
  });

  it('maxReplans 2 allows exactly three passes, never more', async () => {
    const fast = new FakeProvider(['a']);
    const smart = new FakeProvider(['b', 'c']);
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [alwaysFailing(2)] });
    const r = await engine.start('never');
    expect(r.status).toBe('waiting_human');
    expect(fast.calls).toHaveLength(1);
    expect(smart.calls).toHaveLength(2);
    expect((r as { card: HumanCard }).card.summary).toContain('after 2 re-plan(s)');
  });

  it('the bound is hard-capped, and a negative bound behaves like 0', async () => {
    let plans = 0;
    const flow = defineStagedFlow<null, string>(
      { id: 'cap', name: 'c', description: 'c' },
      { maxReplans: 999, plan: () => (plans++, { goal: 'g', route: 'code' }), execute: () => 'x', verify: () => ({ ok: false, reason: 'nope' }) },
    );
    const engine = new Engine({ store: await tempDir(), flows: [flow] });
    expect((await engine.start('cap')).status).toBe('waiting_human');
    expect(plans).toBe(6); // 1 + the 5-re-plan cap (the plan is saved, so a resume would not plan again)
    const neg = defineStagedFlow<null, string>({ id: 'neg', name: 'n', description: 'n' }, { maxReplans: -3, plan: () => ({ goal: 'g', route: 'code' }), execute: () => 'x', verify: () => ({ ok: false, reason: 'nope' }) });
    const e2 = new Engine({ store: await tempDir(), flows: [neg] });
    expect(((await e2.start('neg')) as { card: HumanCard }).card.summary).toContain('after 0 re-plan(s)');
  });

  it('gives a sensible default card when no human spec is supplied', async () => {
    const flow = defineStagedFlow<null, string>({ id: 'dflt', name: 'd', description: 'd' }, { maxReplans: 0, plan: () => ({ goal: 'ship it', route: 'code' }), execute: () => 'draft text', verify: () => ({ ok: false, reason: 'missing the link' }) });
    const engine = new Engine({ store: await tempDir(), flows: [flow] });
    const r = await engine.start('dflt');
    expect((r as { card: HumanCard }).card).toMatchObject({ title: 'Needs you: dflt', summary: expect.stringContaining('ship it'), details: 'draft text', allowFreeText: true });
  });
});

describe('human boundary', () => {
  it('a plan that routes to human skips execute and every model, and the answer comes back', async () => {
    let executed = false;
    const fast = new FakeProvider([]);
    const smart = new FakeProvider([]);
    const flow = defineStagedFlow<null, string>(
      { id: 'boundary', name: 'b', description: 'b' },
      {
        plan: () => ({ goal: 'approve the refund', route: 'human', reason: 'money moves; a person must decide' }),
        execute: () => ((executed = true), 'never'),
        verify: () => ({ ok: true }),
      },
    );
    const dir = await tempDir();
    const engine = new Engine({ store: dir, providers: { fast, smart }, flows: [flow] });
    const first = await engine.start('boundary');
    expect(first.status).toBe('waiting_human');
    expect((first as { card: HumanCard }).card.summary).toContain('money moves; a person must decide');
    const done = await engine.answer((first as { card: HumanCard }).card.id, { text: 'approved' });
    expect(done).toMatchObject({ output: { status: 'human', route: 'human', replans: 0, reason: 'money moves; a person must decide', answer: { text: 'approved' }, trail: [{ outcome: 'human' }] } });
    expect(executed).toBe(false);
    expect(fast.calls.length + smart.calls.length).toBe(0);
  });

  it('a re-plan may itself hit the human boundary', async () => {
    const flow = defineStagedFlow<null, string>(
      { id: 'late', name: 'l', description: 'l' },
      {
        plan: (_i, ctx) => (ctx.replan ? { goal: 'g', route: 'human', reason: `gave up: ${ctx.replan.reason}` } : { goal: 'g', route: 'code' }),
        execute: () => 'x',
        verify: () => ({ ok: false, reason: 'bad' }),
      },
    );
    const engine = new Engine({ store: await tempDir(), flows: [flow] });
    const r = await engine.start('late');
    expect(r.status).toBe('waiting_human');
    expect((r as { card: HumanCard }).card.summary).toContain('gave up: bad');
  });
});

describe('verification: code first, AI optional', () => {
  it('verify may use an AI review (defaults to the fast tier) against the Stage 1 goal and criteria', async () => {
    const fast = new FakeProvider(['YES']);
    const smart = new FakeProvider(['It is a long and rambling answer.']);
    const flow = defineStagedFlow<null, string>(
      { id: 'aiverify', name: 'a', description: 'a' },
      {
        plan: () => ({ goal: 'a calm, specific answer', route: 'smart', criteria: ['calm', 'specific'] }),
        execute: (_p, ctx) => ctx.ai('draft', { prompt: 'p', ...noRetry }),
        verify: async (result, plan, ctx) => {
          const verdict = await ctx.ai('review', { prompt: `Does this meet "${plan.goal}" (${(plan.criteria ?? []).join(', ')})? Answer YES or NO.`, context: { result }, ...noRetry });
          return verdict.trim().toUpperCase().startsWith('YES') ? { ok: true } : { ok: false, reason: `reviewer said: ${verdict}` };
        },
      },
    );
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [flow] });
    const r = await engine.start('aiverify');
    expect(r).toMatchObject({ output: { status: 'passed', route: 'smart' } });
    expect(smart.calls).toHaveLength(1); // the draft
    expect(fast.calls).toHaveLength(1); // the cheap review
    expect(fast.calls[0]!.messages[0]!.content).toContain('"a calm, specific answer" (calm, specific)');
  });

  it('a verify that returns a malformed failure still fails with a reason', async () => {
    const flow = defineStagedFlow<null, string>({ id: 'weird', name: 'w', description: 'w' }, { maxReplans: 0, plan: () => ({ goal: 'g', route: 'code' }), execute: () => 'x', verify: () => ({ ok: false, reason: '  ' }) });
    const engine = new Engine({ store: await tempDir(), flows: [flow] });
    expect(((await engine.start('weird')) as { card: HumanCard }).card.summary).toContain('verification failed');
  });
});

describe('plan validation and composition', () => {
  it('fails the run loudly on a plan with no goal or an unknown route', async () => {
    const noGoal = defineStagedFlow<null, string>({ id: 'nogoal', name: 'n', description: 'n' }, { plan: () => ({ goal: ' ', route: 'code' }), execute: () => 'x', verify: () => ({ ok: true }) });
    const badRoute = defineStagedFlow<null, string>({ id: 'badroute', name: 'b', description: 'b' }, { plan: () => ({ goal: 'g', route: 'medium' as Route }), execute: () => 'x', verify: () => ({ ok: true }) });
    const engine = new Engine({ store: await tempDir(), flows: [noGoal, badRoute] });
    expect(await engine.start('nogoal')).toMatchObject({ status: 'failed', error: expect.stringContaining('concrete, non-empty goal') });
    expect(await engine.start('badroute')).toMatchObject({ status: 'failed', error: expect.stringContaining('plan().route must be one of') });
  });

  it('works as one unit inside a normal defineFlow, next to ordinary steps, without disturbing them', async () => {
    const smart = new FakeProvider(['all good']);
    const flow = defineFlow<null, { prefix: string; reply: string }>({ id: 'mixed', name: 'm', description: 'm' }, async (ctx) => {
      const prefix = await ctx.code('prefix', () => 'Re:');
      const out = await ctx.staged<string>('inner', { plan: () => ({ goal: 'g', route: 'smart' }), execute: (_p, c) => c.ai('draft', { prompt: 'p', ...noRetry }), verify: () => ({ ok: true }) });
      return { prefix, reply: out.status === 'passed' ? out.result : 'human' };
    });
    const engine = new Engine({ store: await tempDir(), providers: { smart }, flows: [flow] });
    expect(await engine.start('mixed')).toMatchObject({ status: 'completed', output: { prefix: 'Re:', reply: 'all good' } });
  });

  it('every stage outcome is saved: a resumed run does not plan, execute or verify again', async () => {
    let plans = 0;
    let executes = 0;
    const flow = defineFlow<null, string>({ id: 'resume', name: 'r', description: 'r' }, async (ctx) => {
      const out = await ctx.staged<string>('unit', {
        plan: () => (plans++, { goal: 'g', route: 'code' }),
        execute: () => (executes++, 'done'),
        verify: () => ({ ok: true }),
      });
      await ctx.human('after', { title: 't', summary: 's', options: ['ok'] });
      return out.status === 'passed' ? out.result : 'human';
    });
    const dir = await tempDir();
    const first = await new Engine({ store: dir, flows: [flow] }).start('resume');
    const done = await new Engine({ store: dir, flows: [flow] }).answer((first as { card: HumanCard }).card.id, { choice: 'ok' });
    expect(done).toMatchObject({ status: 'completed', output: 'done' });
    expect([plans, executes]).toEqual([1, 1]);
  });
});

describe('compatibility with replay and case capture', () => {
  const noBang = (text: string) => (text.includes('!') ? ({ ok: false, reason: 'No exclamation marks allowed.' } as const) : ({ ok: true } as const));
  const flow = defineFlow<{ topic: string }, string>({ id: 'notes', name: 'n', description: 'n' }, async (ctx) => {
    const out = await ctx.staged<string>('unit', {
      plan: () => ({ goal: 'a line without "!"', route: 'smart' }),
      // Replay judges an ai step by its own `verify`; the stage `verify` below checks the goal.
      execute: (_p, c) => c.ai('draft', { prompt: `One line about ${ctx.input.topic}.`, verify: noBang, ...noRetry }),
      verify: (text) => noBang(text),
    });
    await ctx.human('review', { title: 'Review', summary: out.status === 'passed' ? out.result : '', options: ['Send as-is'] });
    return out.status === 'passed' ? out.result : 'human';
  });

  it('captures the staged ai step as a case, and replay judges it live against today\'s model', async () => {
    const dir = await tempDir();
    const first = new Engine({ store: dir, providers: { smart: new FakeProvider(['Plain line']) }, flows: [flow] });
    const r = (await first.start('notes', { topic: 'tea' })) as { card: HumanCard };
    await first.answer(r.card.id, { choice: '1' });
    const cases = await first.cases.forFlow('notes');
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ stepName: 'draft', aiDraft: 'Plain line' });

    const good = await new Engine({ store: dir, providers: { smart: new FakeProvider(['Another plain line']) }, flows: [flow] }).replay('notes');
    expect(good).toMatchObject({ passed: 1, failed: 0 });
    const bad = await new Engine({ store: dir, providers: { smart: new FakeProvider(['Loud line!']) }, flows: [flow] }).replay('notes');
    expect(bad).toMatchObject({ passed: 0, failed: 1 });
  });
});

describe('spectrum helpers', () => {
  it('orders the routes code < fast < smart < human, and upgrades one rung at a time', () => {
    expect(['human', 'code', 'smart', 'fast'].sort((a, b) => routeRank(a as Route) - routeRank(b as Route))).toEqual(['code', 'fast', 'smart', 'human']);
    expect(upgradeRoute('code')).toBe('fast');
    expect(upgradeRoute('fast')).toBe('smart');
    expect(upgradeRoute('smart')).toBe('smart');
  });
});
