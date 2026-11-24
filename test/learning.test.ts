import { describe, expect, it } from 'vitest';
import { Engine, FakeProvider, FileStore, LessonStore, defineFlow, scopes, type HumanCard } from '../src';
import { tempDir } from './helpers';

describe('LessonStore', () => {
  it('adds, dedupes by normalized rule (recurrence count), and filters by scope', async () => {
    const lessons = new LessonStore(new FileStore(await tempDir()));
    await lessons.add({ scope: scopes.flow('a'), rule: 'Keep it short.', sourceRunId: 'r1' });
    const again = await lessons.add({ scope: scopes.flow('a'), rule: '  keep it   SHORT ', sourceRunId: 'r2' });
    await lessons.add({ scope: scopes.role('writer'), rule: 'Be warm' });
    await lessons.add({ scope: scopes.global, rule: 'No jargon' });
    await lessons.add({ scope: scopes.flow('other'), rule: 'Not for a' });

    expect(again).toMatchObject({ count: 2, sourceRunIds: ['r1', 'r2'] });
    const rules = (await lessons.forScope({ flowId: 'a', role: 'writer' })).map((l) => l.rule);
    expect(rules[0]).toBe('Keep it short.'); // most repeated first
    expect(rules.sort()).toEqual(['Be warm', 'Keep it short.', 'No jargon']);
    expect(await lessons.forScope({ flowId: 'zzz' })).toHaveLength(1); // only global
  });

  it('survives concurrent adds without losing writes', async () => {
    const lessons = new LessonStore(new FileStore(await tempDir()));
    await Promise.all(Array.from({ length: 10 }, (_, i) => lessons.add({ scope: 'global', rule: `rule ${i}` })));
    expect(await lessons.all()).toHaveLength(10);
  });

  it('rejects empty rules', async () => {
    const lessons = new LessonStore(new FileStore(await tempDir()));
    expect(() => lessons.add({ scope: 'global', rule: '  ' })).toThrow(/non-empty/);
  });
});

describe('Human -> AI -> Code hardening loop', () => {
  const flow = defineFlow({ id: 'letters', name: 'l', description: 'l', role: 'writer' }, async (ctx) => {
    const draft = await ctx.ai('draft', { prompt: 'Write a note.' });
    await ctx.human('review', { title: 'Review', summary: draft });
    return draft;
  });

  it('captures a lesson from a human reply, injects it into the next ai run, and flags recurrence for code', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(() => 'a draft');
    const engine = new Engine({ store: dir, provider, flows: [flow] });

    // run 1: no lessons yet
    const r1 = (await engine.start('letters')) as { card: HumanCard };
    expect(provider.calls[0]!.system).not.toContain('Lessons learned');
    await engine.answer(r1.card.id, { text: 'too long', lesson: 'Never use exclamation marks.' });
    expect(await engine.lessons.candidatesForCode()).toEqual([]); // seen once

    // run 2: lesson is injected automatically
    const r2 = (await engine.start('letters')) as { card: HumanCard };
    expect(provider.calls[1]!.system).toContain('Lessons learned');
    expect(provider.calls[1]!.system).toContain('- Never use exclamation marks.');
    // same correction again -> recurrence
    await engine.answer(r2.card.id, { text: 'again', lesson: 'never use exclamation marks' });

    const candidates = await engine.lessons.candidatesForCode();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ count: 2, scope: 'flow:letters', hardened: false });
    expect(candidates[0]!.sourceRunIds).toHaveLength(2);

    // once enforced in code it stops being a candidate, but is still injected
    await engine.lessons.markHardened(candidates[0]!.id);
    expect(await engine.lessons.candidatesForCode()).toEqual([]);

    // persisted on disk, readable by a brand-new store
    expect(await new LessonStore(new FileStore(dir)).all()).toHaveLength(1);
  });

  it('supports role and global scopes on a reply, and a custom minCount', async () => {
    const provider = new FakeProvider(() => 'd');
    const engine = new Engine({ store: await tempDir(), provider, flows: [flow] });
    const r = (await engine.start('letters')) as { card: HumanCard };
    await engine.answer(r.card.id, { text: 'x', lesson: { rule: 'Sign off warmly', scope: scopes.role('writer') } });
    await engine.start('letters');
    expect(provider.calls[1]!.system).toContain('- Sign off warmly');
    expect(await engine.lessons.candidatesForCode(1)).toHaveLength(1);
  });
});
