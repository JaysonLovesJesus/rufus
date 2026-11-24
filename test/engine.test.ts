import { describe, expect, it } from 'vitest';
import { Engine, FakeProvider, FileStore, defineFlow, type HumanCard } from '../src';
import { tempDir } from './helpers';

const waiting = (r: { status: string }) => r as { status: 'waiting_human'; runId: string; card: HumanCard };

describe('code steps', () => {
  it('never re-run on resume, even across a fresh Engine reading from disk', async () => {
    const dir = await tempDir();
    let before = 0;
    let after = 0;
    const flow = defineFlow({ id: 'memo', name: 'memo', description: 'memo' }, async (ctx) => {
      const a = await ctx.code('before', () => ({ n: ++before, at: new Date() }));
      const h = await ctx.human('ok', { title: 't', summary: 's', options: ['yes'] });
      const b = await ctx.code('after', () => ++after);
      return { a, h: h.choice, b };
    });

    const first = waiting(await new Engine({ store: dir, flows: [flow] }).start('memo'));
    expect(first.status).toBe('waiting_human');
    expect(before).toBe(1);

    // new process: nothing in memory
    const second = new Engine({ store: dir, flows: [flow] });
    const done = await second.answer(first.card.id, { choice: '1' });

    expect(done.status).toBe('completed');
    expect(before).toBe(1); // NOT re-run
    expect(after).toBe(1);
    // replayed value has the same JSON shape the first pass saw (Date -> string)
    expect((done as any).output.a).toEqual({ n: 1, at: expect.any(String) });
    expect((done as any).output).toMatchObject({ h: 'yes', b: 1 });
  });

  it('lets the same step name repeat (loops) without collisions', async () => {
    const flow = defineFlow({ id: 'loop', name: 'l', description: 'l' }, async (ctx) => {
      const out: number[] = [];
      for (let i = 0; i < 3; i++) out.push(await ctx.code('tick', () => i * 10));
      return out;
    });
    const r = await new Engine({ store: await tempDir(), flows: [flow] }).start('loop');
    expect(r).toMatchObject({ status: 'completed', output: [0, 10, 20] });
  });

  it('records a failure, and resume() retries only the failed step', async () => {
    const dir = await tempDir();
    let first = 0;
    let flaky = 0;
    const flow = defineFlow({ id: 'flaky', name: 'f', description: 'f' }, async (ctx) => {
      await ctx.code('first', () => ++first);
      return ctx.code('flaky', () => {
        if (++flaky === 1) throw new Error('boom');
        return 'ok';
      });
    });
    const engine = new Engine({ store: dir, flows: [flow] });
    const failed = await engine.start('flaky');
    expect(failed).toMatchObject({ status: 'failed', error: 'boom' });
    const again = await engine.resume(failed.runId);
    expect(again).toMatchObject({ status: 'completed', output: 'ok' });
    expect(first).toBe(1);
  });
});

describe('ai steps with verify', () => {
  it('feeds the exact failure reason back, then succeeds on retry', async () => {
    const provider = new FakeProvider(['too long and has [PLACEHOLDER]', 'short and clean']);
    const flow = defineFlow({ id: 'v', name: 'v', description: 'v' }, async (ctx) =>
      ctx.ai('draft', {
        prompt: 'Write it.',
        context: { limit: 20 },
        verify: (out) => (out.includes('[') ? { ok: false, reason: 'Found placeholder [PLACEHOLDER].' } : { ok: true }),
      }),
    );
    const dir = await tempDir();
    const engine = new Engine({ store: dir, provider, flows: [flow] });
    const r = await engine.start('v');

    expect(r).toMatchObject({ status: 'completed', output: 'short and clean' });
    expect(provider.calls).toHaveLength(2);
    const retry = provider.calls[1]!.messages;
    expect(retry.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(retry[1]!.content).toBe('too long and has [PLACEHOLDER]');
    expect(retry[2]!.content).toContain('Found placeholder [PLACEHOLDER].');
    // context is passed to the AI as exact JSON
    expect(provider.calls[0]!.messages[0]!.content).toContain('"limit": 20');
    expect(provider.calls[1]!.meta.attempt).toBe(2);
    expect((await new FileStore(dir).getRun(r.runId)).steps['ai:draft']!.attempts).toBe(2);
  });

  it('fails after maxRetries, and the failure is catchable so a flow can escalate to a human', async () => {
    const provider = new FakeProvider(() => 'nope');
    const bad = defineFlow({ id: 'bad', name: 'b', description: 'b' }, async (ctx) =>
      ctx.ai('x', { prompt: 'p', maxRetries: 1, verify: () => ({ ok: false, reason: 'never good' }) }),
    );
    const failed = await new Engine({ store: await tempDir(), provider, flows: [bad] }).start('bad');
    expect(failed).toMatchObject({ status: 'failed' });
    expect((failed as any).error).toContain('never good');
    expect(provider.calls).toHaveLength(2); // 1 try + 1 retry

    const escalate = defineFlow({ id: 'esc', name: 'e', description: 'e' }, async (ctx) => {
      try {
        return await ctx.ai('x', { prompt: 'p', maxRetries: 0, verify: () => ({ ok: false, reason: 'no' }) });
      } catch (e) {
        const h = await ctx.human('help', { title: 'AI is stuck', summary: String((e as Error).message) });
        return h.text;
      }
    });
    const engine = new Engine({ store: await tempDir(), provider, flows: [escalate] });
    const r = waiting(await engine.start('esc'));
    expect(r.status).toBe('waiting_human');
    expect(await engine.answer(r.card.id, { text: 'I did it' })).toMatchObject({ output: 'I did it' });
  });

  it('supports parse, and treats a parse error as a failed verification', async () => {
    const provider = new FakeProvider(['not json', '{"score": 7}']);
    const flow = defineFlow({ id: 'p', name: 'p', description: 'p' }, async (ctx) =>
      ctx.ai('score', { prompt: 'p', parse: (raw) => JSON.parse(raw) as { score: number } }),
    );
    const r = await new Engine({ store: await tempDir(), provider, flows: [flow] }).start('p');
    expect(r).toMatchObject({ status: 'completed', output: { score: 7 } });
    expect(provider.calls[1]!.messages[2]!.content).toContain('Could not parse the output');
  });

  it('does not call the AI again for a completed ai step on resume', async () => {
    const provider = new FakeProvider(['draft']);
    const flow = defineFlow({ id: 'r', name: 'r', description: 'r' }, async (ctx) => {
      const d = await ctx.ai('d', { prompt: 'p' });
      await ctx.human('h', { title: 't', summary: 's' });
      return d;
    });
    const engine = new Engine({ store: await tempDir(), provider, flows: [flow] });
    const r = waiting(await engine.start('r'));
    expect(await engine.answer(r.card.id, { text: 'go' })).toMatchObject({ output: 'draft' });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('human steps', () => {
  const flow = defineFlow({ id: 'h', name: 'h', description: 'h' }, async (ctx) => {
    const a = await ctx.human('pick', {
      title: 'Pick',
      summary: 'Choose one',
      details: 'more',
      options: ['Red', { id: 'b', label: 'Blue', description: 'cool' }],
    });
    return a;
  });

  it('pauses, persists the card to disk, reloads, answers, and completes', async () => {
    const dir = await tempDir();
    const r = waiting(await new Engine({ store: dir, flows: [flow] }).start('h'));
    expect(r.card).toMatchObject({
      flowId: 'h',
      step: 'pick',
      title: 'Pick',
      details: 'more',
      allowFreeText: true,
      options: [
        { id: 'red', label: 'Red' },
        { id: 'b', label: 'Blue', description: 'cool' },
      ],
    });

    const reloaded = new Engine({ store: dir, flows: [flow] });
    expect((await reloaded.pending()).map((c) => c.id)).toEqual([r.card.id]);
    expect((await new FileStore(dir).getRun(r.runId)).status).toBe('waiting_human');

    const done = await reloaded.answer(r.card.id.slice(0, 4), { choice: 'Blue' });
    expect(done).toMatchObject({ status: 'completed', output: { choice: 'b', choiceLabel: 'Blue' } });
    expect(await reloaded.pending()).toEqual([]);
  });

  it('accepts a 1-based number as a choice and rejects bad answers', async () => {
    const engine = new Engine({ store: await tempDir(), flows: [flow] });
    const r = waiting(await engine.start('h'));
    await expect(engine.answer(r.card.id, { choice: 'green' })).rejects.toThrow(/not one of/);
    await expect(engine.answer(r.card.id, {})).rejects.toThrow(/choice or some text/);
    expect(await engine.answer(r.card.id, { choice: '1' })).toMatchObject({ output: { choice: 'red' } });
    await expect(engine.answer(r.card.id, { choice: '1' })).rejects.toThrow(/No pending card/);
  });

  it('rejects free text on a choice-only card', async () => {
    const strict = defineFlow({ id: 's', name: 's', description: 's' }, (ctx) =>
      ctx.human('go', { title: 't', summary: 's', options: ['A'], allowFreeText: false }),
    );
    const engine = new Engine({ store: await tempDir(), flows: [strict] });
    const r = waiting(await engine.start('s'));
    await expect(engine.answer(r.card.id, { text: 'hmm' })).rejects.toThrow(/only accepts/);
  });

  it('still pauses if the flow author accidentally swallows the pause signal', async () => {
    const sloppy = defineFlow({ id: 'sl', name: 's', description: 's' }, async (ctx) => {
      try {
        await ctx.human('ask', { title: 't', summary: 's' });
      } catch {
        /* swallowed */
      }
      return 'finished early';
    });
    const r = await new Engine({ store: await tempDir(), flows: [sloppy] }).start('sl');
    expect(r.status).toBe('waiting_human');
  });

  it('chains multiple human steps and sends each new card through the channel once', async () => {
    const sent: string[] = [];
    const two = defineFlow({ id: 'two', name: 't', description: 't' }, async (ctx) => {
      const a = await ctx.human('one', { title: 'One', summary: 's' });
      const b = await ctx.human('two', { title: 'Two', summary: 's' });
      return [a.text, b.text];
    });
    const engine = new Engine({
      store: await tempDir(),
      flows: [two],
      channel: { sendCard: async (c) => void sent.push(c.title), parseReply: () => null },
    });
    const r1 = waiting(await engine.start('two'));
    const r2 = waiting(await engine.answer(r1.card.id, { text: 'x' }));
    expect(await engine.answer(r2.card.id, { text: 'y' })).toMatchObject({ output: ['x', 'y'] });
    await engine.resume(r1.runId);
    expect(sent).toEqual(['One', 'Two']);
  });
});
