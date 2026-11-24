import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine, FakeProvider, compareFlow, defineFlow, formatCompare, type AiRequest, type HumanCard } from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

/**
 * Code looks up a tracking number the raw message doesn't contain; the draft must quote it (a code-checkable rule).
 * Plain AI can't know it. Code-assisted AI is handed it as `context`.
 */
function makeFlow(onCode?: () => void) {
  return defineFlow<{ order: string; question: string }>(
    { id: 'parcel', name: 'Parcel', description: 'Answer where a parcel is', role: 'support' },
    async (ctx) => {
      const facts = await ctx.code('lookup', () => (onCode?.(), { tracking: `TRK-${ctx.input.order.toUpperCase()}` }));
      const draft = await ctx.ai('draft', {
        prompt: 'Reply to the customer about their parcel in one line.',
        context: { facts },
        verify: (t: string) =>
          t.includes(facts.tracking) ? { ok: true } : { ok: false, reason: `Quote the tracking number ${facts.tracking}.` },
        maxRetries: 2,
      });
      await ctx.human('review', { title: 'Send?', summary: draft, options: ['Send as-is', 'Discard'] });
      return draft;
    },
  );
}

/** Reads the tracking number only if it appears in what the model was shown. */
const model = (req: AiRequest): string => {
  const shown = req.messages.map((m) => m.content).join('\n');
  const id = /TRK-[A-Z0-9]+/.exec(shown)?.[0];
  return id ? `Your parcel ${id} is on its way.` : 'It is on its way.';
};

const ORDERS = ['a1', 'b2', 'c3', 'd4'];

/** The seeding model has the tracking number (from `context`), as the real flow would. */
const seedModel = (req: AiRequest): string => `Your parcel ${/TRK-[A-Z0-9]+/.exec(req.messages[0]!.content)![0]} is on its way.`;

async function seeded(onCode?: () => void) {
  const dir = await tempDir();
  const seed = new Engine({ store: dir, provider: new FakeProvider(seedModel), flows: [makeFlow(onCode)] });
  for (const order of ORDERS) {
    const r = (await seed.start('parcel', { order, question: 'where is it?' })) as { card: HumanCard };
    await seed.answer(r.card.id, { choice: 'Send as-is' });
  }
  return dir;
}

describe('compareFlow: plain AI vs. code-assisted AI', () => {
  it('measures the lift code gives AI on saved cases, with the same verify, and never re-runs ctx.code', async () => {
    let codeRuns = 0;
    const dir = await seeded(() => void codeRuns++);
    expect(codeRuns).toBe(ORDERS.length); // once per original run

    const provider = new FakeProvider(model);
    const engine = new Engine({ store: dir, provider, flows: [makeFlow(() => void codeRuns++)] });
    await engine.lessons.add({ scope: 'flow:parcel', rule: 'Be warm.' });
    const report = await compareFlow(engine, 'parcel');

    expect(codeRuns).toBe(ORDERS.length); // compare reused the saved code results
    expect(report).toMatchObject({
      flowId: 'parcel',
      total: 4,
      skipped: 0,
      plain: { passed: 0, failed: 4, passRate: 0, avgAttempts: 1 },
      assisted: { passed: 4, failed: 0, passRate: 1, avgAttempts: 1 },
      delta: 4,
      deltaRate: 1,
    });
    expect(report.results).toHaveLength(4);
    expect(report.results[0]).toMatchObject({
      stepName: 'draft',
      plain: { status: 'failed', reason: expect.stringMatching(/Quote the tracking number TRK-A1/), attempts: 1 },
      assisted: { status: 'passed', attempts: 1 },
    });

    // Exactly one plain call per case (no retries) and one assisted call.
    expect(provider.calls).toHaveLength(8);
    const plain = provider.calls.filter((c) => !c.system.includes('Lessons learned'));
    const assisted = provider.calls.filter((c) => c.system.includes('Lessons learned'));
    expect(plain).toHaveLength(4);
    expect(assisted).toHaveLength(4);
    for (const call of plain) {
      const prompt = call.messages[0]!.content;
      expect(call.system).not.toContain('Examples');
      expect(call.system).not.toContain('Your role');
      expect(prompt).not.toContain('Context (exact data');
      expect(prompt).not.toContain('TRK-');
      expect(prompt).toContain('Reply to the customer about their parcel in one line.');
      expect(prompt).toMatch(/Input:\n```json\n\{\s+"order": "[a-d]\d",\s+"question": "where is it\?"\s+\}/);
      expect(call.messages).toHaveLength(1);
    }
    for (const call of assisted) {
      expect(call.system).toContain('- Be warm.');
      expect(call.system).toContain('Examples of how a human responded'); // the other three cases
      expect(call.messages[0]!.content).toContain('Context (exact data gathered by code)');
    }
  });

  it('gives the assisted run its verify-retry loop (plain gets none), and reports the attempts', async () => {
    const dir = await seeded();
    // The model ignores the context on the first try for order "c3", and only fixes it after the exact reason comes back.
    const stubborn = new FakeProvider((req) => {
      const shown = req.messages.map((m) => m.content).join('\n');
      const feedback = req.messages.length > 1;
      if (/"order": "c3"/.test(shown) || /TRK-C3/.test(shown)) return feedback ? 'Your parcel TRK-C3 is on its way.' : 'It is on its way.';
      return model(req);
    });
    const report = await new Engine({ store: dir, provider: stubborn, flows: [makeFlow()] }).compare('parcel');

    expect(report.assisted).toMatchObject({ passed: 4, avgAttempts: 1.25 });
    expect(report.plain).toMatchObject({ passed: 0, avgAttempts: 1 });
    expect(report.results.find((r) => r.assisted.attempts === 2)).toBeDefined();
    expect(report.delta).toBe(4);
  });

  it('shows no lift (delta 0) when plain AI already passes, and a negative delta if the scaffolding hurts', async () => {
    const dir = await seeded();
    // A model that always knows the answer, with or without help.
    const knowsIt = (req: AiRequest) => `Your parcel TRK-${/"order": "(\w+)"/.exec(req.messages[0]!.content)?.[1]?.toUpperCase() ?? /TRK-(\w+)/.exec(req.messages[0]!.content)![1]} is on its way.`;
    const same = await new Engine({ store: dir, provider: new FakeProvider(knowsIt), flows: [makeFlow()] }).compare('parcel');
    expect(same).toMatchObject({ total: 4, delta: 0, deltaRate: 0, plain: { passed: 4 }, assisted: { passed: 4 } });

    // A model that is thrown off by lessons in its prompt: fine plain, broken when assisted.
    const thrown = new FakeProvider((req) => (req.system.includes('Lessons learned') ? 'Nope.' : knowsIt(req)));
    const engine = new Engine({ store: dir, provider: thrown, flows: [makeFlow()] });
    await engine.lessons.add({ scope: 'global', rule: 'Be warm.' });
    const worse = await engine.compare('parcel');
    expect(worse).toMatchObject({ plain: { passed: 4 }, assisted: { passed: 0 }, delta: -4 });
    expect(formatCompare(worse)).toContain('Code lift: -4 case(s) (-100 points).');
  });

  it('honours --limit (most recent N), skips cases whose original run is gone, and says so when there are none', async () => {
    const dir = await seeded();
    const engine = new Engine({ store: dir, provider: new FakeProvider(model), flows: [makeFlow()] });
    expect((await engine.compare('parcel', { limit: 2 })).total).toBe(2);

    const [first] = await engine.cases.forFlow('parcel');
    await rm(path.join(dir, 'runs', `${first!.runId}.json`));
    const report = await engine.compare('parcel');
    expect(report).toMatchObject({ total: 3, skipped: 1, delta: 3 });
    expect(formatCompare(report)[0]).toContain('(1 skipped)');

    const empty = await new Engine({ store: await tempDir(), provider: new FakeProvider(model), flows: [makeFlow()] }).compare('parcel');
    expect(empty.total).toBe(0);
    expect(formatCompare(empty)[0]).toMatch(/^No saved cases for "parcel"/);
    await expect(engine.compare('nope')).rejects.toThrow(/not registered/);
  });

  it('leaves provider failures out of the rates instead of scoring them as wrong answers', async () => {
    const dir = await seeded();
    let n = 0;
    const flaky = new FakeProvider((req) => {
      if (++n <= 2) throw new Error('rate limited'); // the first case: both of its calls fail
      return model(req);
    });
    const report = await new Engine({ store: dir, provider: flaky, flows: [makeFlow()] }).compare('parcel', { limit: 2 });
    expect(report).toMatchObject({ total: 1, errored: 1, plain: { passed: 0 }, assisted: { passed: 1 }, delta: 1 });
    expect(report.providerError).toMatch(/rate limited/);
    expect(formatCompare(report).join('\n')).toMatch(/1 more case\(s\) left out: the AI provider failed \(AI provider error: rate limited\)/);

    const allDown = new Engine({ store: dir, flows: [makeFlow()] }); // no provider at all
    const none = await allDown.compare('parcel');
    expect(none).toMatchObject({ total: 0, errored: 4 });
    expect(formatCompare(none)[0]).toMatch(/^4 case\(s\) could not be compared because the AI provider failed: AI provider error: No AI provider configured/);
  });
});

describe('rufus compare (CLI, real command provider)', () => {
  it('shows the lift of the verify-retry loop end to end on a saved demo case', async () => {
    const dir = await tempDir();
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    // A tiny "model" on the command provider: writes a placeholder until it is told its draft failed a check.
    const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(/failed an automatic check/.test(s)?'Happy to move it to Thursday.':'Hi [name], happy to help.'))";
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, provider: { type: 'command', command: process.execPath, args: ['-e', script] } }));

    await main(['--dir', dir, 'demo', '--reply', '1'], io); // a human reviews one draft: that is a saved case
    out.length = 0;
    await main(['--dir', dir, 'compare', 'triage-draft', '--limit', '5'], io);

    expect(out[0]).toBe('Compared 1 case(s) for "triage-draft", graded by the same verify:');
    expect(out[1]).toBe('  plain AI       0/1 passed (0%), avg attempts 1.0');
    expect(out[2]).toBe('  code-assisted  1/1 passed (100%), avg attempts 2.0');
    expect(out[3]).toBe('Code lift: +1 case(s) (+100 points).');
    expect(out[4]).toMatch(/plain FAILED \(The draft contains a placeholder "\[name\]"/);
  });

  it('is wired into the CLI with usage, limit validation and an empty-workspace message', async () => {
    const dir = await tempDir();
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    await expect(main(['--dir', dir, 'compare'], io)).rejects.toThrow(/Usage: rufus compare <flowId>/);
    await main(['--dir', dir, 'compare', 'triage-draft', '--limit', '3'], io);
    expect(out.at(-1)).toMatch(/^No saved cases for "triage-draft"/);
    await expect(main(['--dir', dir, 'compare', 'triage-draft', '--limit', '0'], io)).rejects.toThrow(/positive number/);
  });

  it('says the provider failed (and exits 1) rather than reporting 0% for both', async () => {
    const dir = await tempDir();
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    await main(['--dir', dir, 'demo', '--reply', '1'], io); // saves a case; this workspace has no provider configured
    out.length = 0;
    process.exitCode = undefined;
    await main(['--dir', dir, 'compare', 'triage-draft'], io);
    expect(out).toEqual([expect.stringMatching(/^1 case\(s\) could not be compared because the AI provider failed/)]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
