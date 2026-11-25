import { describe, expect, it } from 'vitest';
import { ChiefOfStaff, Engine, FakeProvider, defineFlow, formatSpectrum, summarizeSpectrum, type HumanCard } from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const short = (s: string) => (s.split(/\s+/).length <= 3 ? ({ ok: true } as const) : ({ ok: false, reason: 'must be at most 3 words' } as const));
const run = async (engine: Engine, runId: string) => engine.store.getRun(runId);

describe('ctx.ai tier', () => {
  const flow = defineFlow({ id: 'tiers', name: 't', description: 't' }, async (ctx) => ({
    fast: await ctx.ai('a', { prompt: 'p', tier: 'fast' }),
    smart: await ctx.ai('b', { prompt: 'p', tier: 'smart' }),
    plain: await ctx.ai('c', { prompt: 'p' }),
  }));

  it('resolves tier to providers.fast / providers.smart, and no tier to the default', async () => {
    const dflt = new FakeProvider(['from-default']);
    const fast = new FakeProvider(['from-fast']);
    const smart = new FakeProvider(['from-smart']);
    const engine = new Engine({ store: await tempDir(), provider: dflt, providers: { fast, smart }, flows: [flow] });
    expect(await engine.start('tiers')).toMatchObject({ status: 'completed', output: { fast: 'from-fast', smart: 'from-smart', plain: 'from-default' } });
  });

  it('falls back to the default provider when a tier is not configured (zero breaking changes)', async () => {
    const dflt = new FakeProvider(['d1', 'd2', 'd3']);
    const engine = new Engine({ store: await tempDir(), provider: dflt, flows: [flow] });
    expect(await engine.start('tiers')).toMatchObject({ status: 'completed', output: { fast: 'd1', smart: 'd2', plain: 'd3' } });
  });

  it('falls back to the flow provider, and an explicit provider name beats the tier', async () => {
    const claude = new FakeProvider(['claude-1']);
    const fast = new FakeProvider(['fast-1']);
    const f = defineFlow({ id: 'f', name: 'f', description: 'f', provider: 'claude' }, async (ctx) => ({
      tiered: await ctx.ai('a', { prompt: 'p', tier: 'smart' }), // smart not configured -> the flow's provider
      named: await ctx.ai('b', { prompt: 'p', tier: 'smart', provider: 'fast' }),
    }));
    const engine = new Engine({ store: await tempDir(), providers: { claude, fast }, flows: [f] });
    expect(await engine.start('f')).toMatchObject({ output: { tiered: 'claude-1', named: 'fast-1' } });
  });
});

describe('ctx.escalate: fast -> smart -> human', () => {
  const draft = defineFlow({ id: 'draft', name: 'd', description: 'd' }, async (ctx) => {
    const r = await ctx.escalate('write', { prompt: 'Write a tiny reply.', verify: short, fast: { maxRetries: 1 }, smart: { maxRetries: 1 } });
    return r;
  });

  it('stays on fast when fast passes verify; smart is never called', async () => {
    const fast = new FakeProvider(['ok then']);
    const smart = new FakeProvider([]);
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [draft] });
    const r = await engine.start('draft');
    expect(r).toMatchObject({ status: 'completed', output: { rung: 'fast', value: 'ok then', attempts: 1 } });
    expect(smart.calls).toHaveLength(0);
    expect((await run(engine, r.runId)).spectrum).toEqual({ code: 0, fast: 1, smart: 0, human: 0 });
  });

  it('retries fast with the exact reason first, and only then escalates to smart', async () => {
    const fast = new FakeProvider(['this is far too long', 'still way too long here']);
    const smart = new FakeProvider(['ok then']);
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [draft] });
    const r = await engine.start('draft');
    expect(r).toMatchObject({ status: 'completed', output: { rung: 'smart', value: 'ok then', attempts: 3 } });
    expect(fast.calls).toHaveLength(2); // 1 try + 1 retry
    expect(fast.calls[1]!.messages.at(-1)!.content).toContain('must be at most 3 words');
    expect(smart.calls).toHaveLength(1);
    const saved = await run(engine, r.runId);
    expect(saved.steps['ai:write']).toMatchObject({ rung: 'smart', escalated: true });
    expect(saved.spectrum).toEqual({ code: 0, fast: 0, smart: 1, human: 0, escalated: 1 });
  });

  it('fails like a normal ai step when every rung fails and no human is offered', async () => {
    const fast = new FakeProvider(['too long here now', 'too long here now']);
    const smart = new FakeProvider(['also too long here', 'also too long here']);
    const engine = new Engine({ store: await tempDir(), providers: { fast, smart }, flows: [draft] });
    const r = await engine.start('draft');
    expect(r.status).toBe('failed');
    expect((r as { error: string }).error).toContain('failed verification after 4 attempt(s)');
  });

  it('hands to a human when smart also fails, replays without re-asking the models, and counts the human rung', async () => {
    const dir = await tempDir();
    const flow = defineFlow({ id: 'h', name: 'h', description: 'h' }, async (ctx) => {
      const r = await ctx.escalate('write', {
        prompt: 'Write a tiny reply.',
        verify: short,
        fast: { maxRetries: 0 },
        smart: { maxRetries: 0 },
        human: ({ reason }) => ({ title: 'Write it yourself', summary: reason, options: ['sent'] }),
      });
      return r.rung === 'human' ? { by: 'human', choice: r.answer.choice } : { by: r.rung };
    });
    const fast = new FakeProvider(['way too many words here']);
    const smart = new FakeProvider(['also way too many words']);
    const first = await new Engine({ store: dir, providers: { fast, smart }, flows: [flow] }).start('h');
    expect(first.status).toBe('waiting_human');
    const card = (first as { card: HumanCard }).card;
    expect(card.summary).toBe('must be at most 3 words');

    // A fresh engine whose models would throw if called: the failed attempts are saved, not re-run.
    const silent = new FakeProvider([]);
    const engine = new Engine({ store: dir, providers: { fast: silent, smart: silent }, flows: [flow] });
    const done = await engine.answer(card.id, { choice: 'sent' });
    expect(done).toMatchObject({ status: 'completed', output: { by: 'human', choice: 'sent' } });
    expect(silent.calls).toHaveLength(0);
    expect((await run(engine, done.runId)).spectrum).toEqual({ code: 0, fast: 0, smart: 0, human: 1, escalated: 1 });
  });

  it('does not ask the same model twice when no separate fast tier is configured', async () => {
    const only = new FakeProvider(['too many words in this', 'ok then']);
    const engine = new Engine({ store: await tempDir(), provider: only, flows: [draft] });
    const r = await engine.start('draft');
    expect(r).toMatchObject({ status: 'completed', output: { rung: 'smart', value: 'ok then' } });
    expect(only.calls).toHaveLength(2); // smart's own retry, not a second pass of fast + smart
    expect((await run(engine, r.runId)).spectrum).toEqual({ code: 0, fast: 0, smart: 1, human: 0 });
  });
});

describe('run.spectrum accounting', () => {
  const mixed = defineFlow({ id: 'mixed', name: 'm', description: 'm' }, async (ctx) => {
    const a = await ctx.code('gather', () => 1);
    await ctx.code('sum', () => a + 1);
    await ctx.ai('phrase', { prompt: 'p', tier: 'fast' });
    await ctx.ai('judge', { prompt: 'p', tier: 'smart' });
    await ctx.ai('untiered', { prompt: 'p' }); // counts as smart
    await ctx.human('ok', { title: 't', summary: 's', options: ['yes'] });
    return 'done';
  });

  it('counts code / fast / smart / human per step, and shows it in the run summary and chat status', async () => {
    const dir = await tempDir();
    const engine = new Engine({ store: dir, providers: { fast: new FakeProvider(['f']), smart: new FakeProvider(['s']) }, provider: new FakeProvider(['d']), flows: [mixed] });
    const first = await engine.start('mixed');
    expect(first.status).toBe('waiting_human');
    expect((await run(engine, first.runId)).spectrum).toEqual({ code: 2, fast: 1, smart: 2, human: 1 });

    const done = await engine.answer((first as { card: HumanCard }).card.id, { choice: 'yes' });
    expect(done.status).toBe('completed');
    const saved = await run(engine, done.runId);
    expect(saved.spectrum).toEqual({ code: 2, fast: 1, smart: 2, human: 1 });
    expect(formatSpectrum(saved.spectrum!)).toBe('code 2 · fast 1 · smart 2 · human 1');

    const chief = new ChiefOfStaff({ engine });
    expect(await chief.handleMessage('status')).toContain('Handled by (1 run): code 2 · fast 1 · smart 2 · human 1');
  });

  it('counts runs saved before the spectrum existed (ai without a rung is smart)', () => {
    expect(
      summarizeSpectrum({
        'code:a': { kind: 'code', name: 'a', done: true },
        'ai:b': { kind: 'ai', name: 'b', done: true, result: 'x', attempts: 1 },
      }),
    ).toEqual({ code: 1, fast: 0, smart: 1, human: 0 });
  });

  it('prints "Handled by" after `rufus run`', async () => {
    const dir = await tempDir();
    const lines: string[] = [];
    await main(['--dir', dir, 'demo'], { out: (l) => void lines.push(l), err: (l) => void lines.push(l) });
    expect(lines.join('\n')).toMatch(/Handled by: code \d+ · fast \d+ · smart \d+ · human \d+/);
  });
});
