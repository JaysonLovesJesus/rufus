import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine, FakeProvider, defineFlow, type HumanCard, type ReplayCase } from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

/** A flow whose draft must not contain "!" (a stand-in for any code-checkable house rule). */
function makeFlow(opts: { includeExamples?: number | false; onCode?: () => void; noHuman?: boolean; strict?: boolean } = {}) {
  return defineFlow<{ topic: string }>(
    { id: 'notes', name: 'notes', description: 'notes', role: 'writer' },
    async (ctx) => {
      const facts = await ctx.code('facts', () => (opts.onCode?.(), { topic: ctx.input.topic }));
      const draft = await ctx.ai('draft', {
        prompt: `Write one line about ${facts.topic}.`,
        verify: opts.strict === false ? undefined : (t: string) => (t.includes('!') ? { ok: false, reason: 'No exclamation marks allowed.' } : { ok: true }),
        includeExamples: opts.includeExamples,
        maxRetries: 0,
      });
      if (opts.noHuman) return draft;
      await ctx.human('review', {
        title: 'Review',
        summary: draft,
        options: ['Send as-is', 'Discard'],
      });
      return draft;
    },
  );
}

async function reviewOnce(engine: Engine, topic: string, reply: { choice?: string; text?: string }) {
  const r = (await engine.start('notes', { topic })) as { card: HumanCard };
  await engine.answer(r.card.id, reply);
  return r.card;
}

const readCases = async (dir: string) =>
  (JSON.parse(await readFile(path.join(dir, 'cases', 'notes.json'), 'utf8')) as { cases: ReplayCase[] }).cases;

describe('automatic case capture', () => {
  it('saves a compact case in cases/<flowId>.json when a human card is answered', async () => {
    const dir = await tempDir();
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'Plain draft'), flows: [makeFlow()] });

    const r = (await engine.start('notes', { topic: 'tea' })) as { runId: string; card: HumanCard };
    expect(await engine.cases.forFlow('notes')).toEqual([]); // nothing until a human answers
    await engine.answer(r.card.id, { choice: '1' });
    await reviewOnce(engine, 'coffee', { text: 'Better words' });

    const [a, b] = await readCases(dir);
    expect(a).toMatchObject({
      flowId: 'notes',
      runId: r.runId,
      input: { topic: 'tea' },
      stepKey: 'ai:draft',
      stepName: 'draft',
      aiDraft: 'Plain draft',
      humanChoice: 'Send as-is',
      humanText: null,
      edited: false,
    });
    expect(a!.id).toMatch(/^case_/);
    expect(Date.parse(a!.at)).not.toBeNaN();
    expect(b).toMatchObject({ input: { topic: 'coffee' }, humanChoice: null, humanText: 'Better words', edited: true });
  });

  it('skips human steps that have no AI draft before them', async () => {
    const dir = await tempDir();
    const flow = defineFlow({ id: 'plain', name: 'p', description: 'p' }, async (ctx) => {
      await ctx.human('ok?', { title: 't', summary: 's' });
    });
    const engine = new Engine({ store: dir, flows: [flow] });
    const r = (await engine.start('plain')) as { card: HumanCard };
    await engine.answer(r.card.id, { text: 'yes' });
    expect(await engine.cases.forFlow('plain')).toEqual([]);
  });
});

describe('code-assembled memory in ctx.ai', () => {
  it('shows the last 3 human reviews as a small Examples block, next to the lessons', async () => {
    const provider = new FakeProvider(() => 'Draft');
    const engine = new Engine({ store: await tempDir(), provider, flows: [makeFlow()] });
    for (const topic of ['one', 'two', 'three', 'four']) {
      await reviewOnce(engine, topic, { text: `human rewrite of ${topic}`});
    }
    await reviewOnce(engine, 'five', { choice: 'Discard' });
    await engine.lessons.add({ scope: 'flow:notes', rule: 'Keep it warm.' });

    await engine.start('notes', { topic: 'six' });
    const system = provider.calls.at(-1)!.system;

    expect(system).toContain('- Keep it warm.');
    expect(system).toContain('Examples of how a human responded');
    expect(system).not.toContain('"topic":"one"'); // only the last 3 of 5
    expect(system).not.toContain('human rewrite of two');
    expect(system).toContain('human rewrite of three');
    expect(system).toContain('human rewrite of four');
    expect(system).toContain('Input: {"topic":"five"}');
    expect(system).toContain('Human chose "Discard"');
    expect(system).toContain('Draft: Draft');
    expect(system.indexOf('Lessons learned')).toBeLessThan(system.indexOf('Examples of how'));
    expect((system.match(/Example \d+:/g) ?? []).length).toBe(3);
  });

  it('has no Examples block before there are cases, and honours includeExamples (number or false)', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(() => 'Draft');
    const seed = new Engine({ store: dir, provider, flows: [makeFlow()] });
    await seed.start('notes', { topic: 'first' });
    expect(provider.calls[0]!.system).not.toContain('Examples');
    await reviewOnce(seed, 'a', { text: 'rewrite a' });
    await reviewOnce(seed, 'b', { text: 'rewrite b' });

    const run = async (includeExamples: number | false | undefined) => {
      const p = new FakeProvider(() => 'Draft');
      await new Engine({ store: dir, provider: p, flows: [makeFlow({ includeExamples })] }).start('notes', { topic: 'x' });
      return p.calls[0]!.system;
    };
    expect(await run(false)).not.toContain('Examples');
    expect(await run(0)).not.toContain('Examples');
    expect(((await run(1)).match(/Example \d+:/g) ?? []).length).toBe(1);
    expect(await run(1)).toContain('rewrite b'); // the most recent
    expect(((await run(undefined)).match(/Example \d+:/g) ?? []).length).toBe(2);
  });

  it('only shows examples from the same ai step of the same flow', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(() => 'Draft');
    const two = defineFlow({ id: 'two', name: 't', description: 't' }, async (ctx) => {
      const a = await ctx.ai('classify', { prompt: 'c' });
      await ctx.ai('write', { prompt: 'w' });
      await ctx.human('r', { title: 't', summary: a });
    });
    const engine = new Engine({ store: dir, provider, flows: [two, makeFlow()] });
    const r = (await engine.start('two')) as { card: HumanCard };
    await engine.answer(r.card.id, { text: 'fine' });
    await reviewOnce(engine, 'other flow', { text: 'unrelated' });

    provider.calls.length = 0;
    await engine.start('two');
    const [classify, write] = provider.calls;
    expect(classify!.system).not.toContain('Examples'); // the only case is for step "write"
    expect(write!.system).toContain('Examples');
    expect(write!.system).not.toContain('unrelated');
  });

  it('keeps each example short', async () => {
    const provider = new FakeProvider(() => 'x'.repeat(5000));
    const engine = new Engine({ store: await tempDir(), provider, flows: [makeFlow()] });
    await reviewOnce(engine, 'y'.repeat(5000), { text: 'z'.repeat(5000) });
    await engine.start('notes', { topic: 't' });
    expect(provider.calls.at(-1)!.system.length).toBeLessThan(1500);
  });
});

describe('replayFlow', () => {
  /** Seed a workspace with reviewed drafts, one of which breaks today's rule. */
  async function seeded(extra: { onCode?: () => void } = {}) {
    // The rule did not exist when these drafts were written, so the seeding flow has no verify.
    const dir = await tempDir();
    const drafts = ['Calm line', 'Loud line!'];
    const seed = new Engine({ store: dir, provider: new FakeProvider(() => drafts.shift()!), flows: [makeFlow({ ...extra, strict: false })] });
    await reviewOnce(seed, 'tea', { choice: 'Send as-is' }); // "Calm line" passes today's check
    await reviewOnce(seed, 'coffee', { text: 'Calm replacement' }); // "Loud line!" fails it
    return dir;
  }

  it('reports exact pass/fail counts, the verify reason, and improved/regressed vs the saved drafts', async () => {
    const dir = await seeded();
    // Today's model: fixes the case whose draft was loud, breaks the one that was fine.
    const provider = new FakeProvider((req) =>
      req.messages[0]!.content.includes('tea') ? 'Now loud!' : 'Now calm',
    );
    const engine = new Engine({ store: dir, provider, flows: [makeFlow()] });
    const report = await engine.replay('notes');

    expect(report).toMatchObject({
      flowId: 'notes', total: 2, passed: 1, failed: 1, skipped: 0, improved: 1, regressed: 1, unchanged: 0,
    });
    const [tea, coffee] = report.results;
    expect(tea).toMatchObject({ status: 'failed', reason: 'No exclamation marks allowed.', before: 'passed', change: 'regressed', attempts: 1 });
    expect(coffee).toMatchObject({ status: 'passed', output: 'Now calm', before: 'failed', change: 'improved' });
  });

  it('reports unchanged when behaviour matches, and respects limit (most recent cases)', async () => {
    const dir = await seeded();
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'Calm line'), flows: [makeFlow()] });
    expect(await engine.replay('notes')).toMatchObject({ total: 2, passed: 2, improved: 1, regressed: 0, unchanged: 1 });
    const limited = await engine.replay('notes', { limit: 1 });
    expect(limited.total).toBe(1);
    expect(limited.results[0]!.change).toBe('improved'); // the coffee case is the most recent
  });

  it('uses the current verify retries: a draft that is fixed on retry still passes', async () => {
    const dir = await seeded();
    const flow = defineFlow<{ topic: string }>({ id: 'notes', name: 'n', description: 'n', role: 'writer' }, async (ctx) => {
      await ctx.code('facts', () => ({ topic: ctx.input.topic }));
      await ctx.ai('draft', {
        prompt: 'x',
        verify: (t: string) => (t.includes('!') ? { ok: false, reason: 'No exclamation marks allowed.' } : { ok: true }),
        maxRetries: 1,
      });
      await ctx.human('review', { title: 'r', summary: 's' });
    });
    const provider = new FakeProvider(['bad!', 'good', 'bad!', 'good']);
    const report = await new Engine({ store: dir, provider, flows: [flow] }).replay('notes');
    expect(report).toMatchObject({ passed: 2, failed: 0 });
    expect(report.results.map((r) => r.attempts)).toEqual([2, 2]);
  });

  it('uses current lessons and leaves the case under test out of its own examples', async () => {
    const dir = await seeded();
    const provider = new FakeProvider(() => 'Calm line');
    const engine = new Engine({ store: dir, provider, flows: [makeFlow()] });
    await engine.lessons.add({ scope: 'flow:notes', rule: 'A lesson learned after the cases were saved.' });
    await engine.replay('notes');
    const [teaCall, coffeeCall] = provider.calls;
    expect(teaCall!.system).toContain('A lesson learned after the cases were saved.');
    expect(teaCall!.system).not.toContain('Input: {"topic":"tea"}'); // itself
    expect(teaCall!.system).toContain('Input: {"topic":"coffee"}'); // the other case
    expect(coffeeCall!.system).not.toContain('Input: {"topic":"coffee"}');
    expect(teaCall!.meta.runId).toMatch(/^replay_/);
  });

  it('never re-runs code steps (they may have side effects) and never touches saved runs', async () => {
    let sideEffects = 0;
    const dir = await seeded({ onCode: () => sideEffects++ });
    expect(sideEffects).toBe(2); // once per original run
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'Calm'), flows: [makeFlow({ onCode: () => sideEffects++ })] });
    const before = (await engine.store.listRuns()).map((r) => r.updatedAt);
    await engine.replay('notes');
    expect(sideEffects).toBe(2);
    expect((await engine.store.listRuns()).map((r) => r.updatedAt)).toEqual(before);
    expect(await engine.pending()).toEqual([]); // replay never opens a human card
  });

  it('skips (and says why) when the original run is gone or the flow no longer reaches the step', async () => {
    const dir = await seeded();
    const [first] = await readCases(dir);
    await rm(path.join(dir, 'runs', `${first!.runId}.json`));
    const reshaped = defineFlow({ id: 'notes', name: 'n', description: 'n' }, async (ctx) => ctx.code('other', () => 1));
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'Calm'), flows: [reshaped] });
    const report = await engine.replay('notes');
    expect(report).toMatchObject({ total: 2, skipped: 2, passed: 0, failed: 0 });
    expect(report.results[0]!.reason).toMatch(/no longer in the workspace/);
    expect(report.results[1]!.reason).toBe('The original run has no saved result for "code:other".');

    const gone = defineFlow({ id: 'notes', name: 'n', description: 'n' }, async () => 'nothing to do');
    const again = await new Engine({ store: dir, flows: [gone] }).replay('notes', { limit: 1 });
    expect(again.results[0]!.reason).toBe('The flow no longer reaches step "ai:draft".');
  });

  it('counts a provider outage as a failed case with the reason, not a crash', async () => {
    const dir = await seeded();
    const engine = new Engine({ store: dir, flows: [makeFlow()] }); // no provider
    const report = await engine.replay('notes');
    expect(report).toMatchObject({ failed: 2, passed: 0 });
    expect(report.results[0]!.reason).toMatch(/No AI provider configured/);
  });

  it('works on a flow that has no cases yet', async () => {
    const engine = new Engine({ store: await tempDir(), flows: [makeFlow()] });
    expect(await engine.replay('notes')).toMatchObject({ total: 0, passed: 0 });
    await expect(engine.replay('nope')).rejects.toThrow(/not registered/);
  });
});

describe('cli replay', () => {
  it('prints the summary and each failure, and `rufus tick` runs due flows', async () => {
    const dir = await tempDir();
    const lines: string[] = [];
    const io = { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) };

    await main(['--dir', dir, 'replay', 'triage-draft'], io);
    expect(lines.pop()).toMatch(/No saved cases for "triage-draft"/);

    // The built-in demo captures a case when its card is answered.
    await main(['--dir', dir, 'demo', '--reply', '1'], io);
    lines.length = 0;
    await main(['--dir', dir, 'tick'], io);
    expect(lines).toEqual(['No flows have an at()/every() trigger.']);

    // No provider is configured, so the replay fails the case with a clear reason (and sets exit code 1).
    const prev = process.exitCode;
    lines.length = 0;
    await main(['--dir', dir, 'replay', 'triage-draft'], io);
    expect(lines[0]).toBe('Replayed 1 case(s) for "triage-draft": 0 passed, 1 failed, 0 skipped.');
    expect(lines.join('\n')).toMatch(/FAILED case_[0-9a-f]+ \(draft-reply\): AI provider error: No AI provider configured/);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;
  });
});
