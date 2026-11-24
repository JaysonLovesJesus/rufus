import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  FakeProvider,
  FileStore,
  LessonCapError,
  LessonStore,
  MAX_LESSONS_PER_SCOPE,
  defineFlow,
  suggestLayer,
  type HumanCard,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const store = async (opts?: { maxLessonsPerScope?: number }) => new LessonStore(new FileStore(await tempDir()), opts);

describe('lesson cap', () => {
  it('throws LessonCapError on the 8th distinct lesson in a scope, listing what is there', async () => {
    const lessons = await store();
    for (let i = 1; i <= MAX_LESSONS_PER_SCOPE; i++) await lessons.add({ scope: 'flow:a', rule: `Rule number ${i}` });

    const err = await lessons.add({ scope: 'flow:a', rule: 'One rule too many' }).catch((e) => e);
    expect(err).toBeInstanceOf(LessonCapError);
    expect(err.message).toContain('7 active lessons');
    expect(err.message).toContain('Rule number 1');
    expect(err.message).toContain('Rule number 7');
    expect(err.message).toMatch(/consolidate/);
    expect(err.message).toMatch(/markHardened/);
    expect(err.lessons).toHaveLength(7);
    expect(await lessons.all()).toHaveLength(7); // nothing was saved

    // Another scope has its own budget.
    await expect(lessons.add({ scope: 'flow:b', rule: 'Fine here' })).resolves.toMatchObject({ scope: 'flow:b' });
  });

  it('still counts a repeat of an existing rule, even at the cap', async () => {
    const lessons = await store();
    for (let i = 1; i <= 7; i++) await lessons.add({ scope: 'global', rule: `Rule ${i}` });
    const again = await lessons.add({ scope: 'global', rule: '  rule 3.  ' });
    expect(again.count).toBe(2);
    expect(await lessons.all()).toHaveLength(7);
  });

  it('does not count hardened lessons against the cap, and honours a configured cap', async () => {
    const lessons = await store({ maxLessonsPerScope: 2 });
    const a = await lessons.add({ scope: 'global', rule: 'A' });
    await lessons.add({ scope: 'global', rule: 'B' });
    await expect(lessons.add({ scope: 'global', rule: 'C' })).rejects.toBeInstanceOf(LessonCapError);
    await lessons.markHardened(a.id);
    await expect(lessons.add({ scope: 'global', rule: 'C' })).resolves.toBeDefined();
    expect(() => new LessonStore(new FileStore('/nowhere'), { maxLessonsPerScope: 0 })).toThrow(/at least 1/);
  });

  it('reads the cap from the engine learning option', async () => {
    const engine = new Engine({ store: await tempDir(), learning: { maxLessonsPerScope: 1 } });
    await engine.lessons.add({ scope: 'global', rule: 'One' });
    await expect(engine.lessons.add({ scope: 'global', rule: 'Two' })).rejects.toBeInstanceOf(LessonCapError);
  });

  it('defaults older lessons to the principle layer', async () => {
    const dir = await tempDir();
    const fs = new FileStore(dir);
    await fs.writeJson(fs.lessonsFile, {
      version: 1,
      lessons: [{ id: 'l_old', scope: 'global', rule: 'Old', count: 1, sourceRunIds: [], hardened: false, createdAt: 'x', updatedAt: 'x' }],
    });
    expect((await new LessonStore(fs).all())[0]!.layer).toBe('principle');
  });
});

describe('consolidate and prune', () => {
  it('merges 3 lessons into 1, keeping their counts and sources, atomically', async () => {
    const lessons = await store();
    const a = await lessons.add({ scope: 'flow:a', rule: 'Be brief', sourceRunId: 'r1' });
    await lessons.add({ scope: 'flow:a', rule: 'Be brief', sourceRunId: 'r2' });
    const b = await lessons.add({ scope: 'flow:a', rule: 'Skip the pleasantries', sourceRunId: 'r3' });
    const c = await lessons.add({ scope: 'flow:a', rule: 'No long intros' });
    const keep = await lessons.add({ scope: 'flow:a', rule: 'Sign with first name' });

    const merged = await lessons.consolidate('flow:a', {
      replaceIds: [a.id, b.id, c.id],
      replacementRule: 'Get to the point in the first line.',
      layer: 'principle',
    });
    expect(merged).toMatchObject({ scope: 'flow:a', rule: 'Get to the point in the first line.', count: 4, hardened: false });
    expect(merged.sourceRunIds.sort()).toEqual(['r1', 'r2', 'r3']);

    const rules = (await lessons.all()).map((l) => l.rule).sort();
    expect(rules).toEqual(['Get to the point in the first line.', 'Sign with first name']);
    expect((await lessons.all()).find((l) => l.id === keep.id)).toBeDefined();
  });

  it('refuses a bad consolidation without changing anything', async () => {
    const lessons = await store();
    const a = await lessons.add({ scope: 'flow:a', rule: 'A' });
    const other = await lessons.add({ scope: 'flow:b', rule: 'B' });
    await expect(lessons.consolidate('flow:a', { replaceIds: [a.id, 'l_missing'], replacementRule: 'X' })).rejects.toThrow(/No lesson/);
    await expect(lessons.consolidate('flow:a', { replaceIds: [other.id], replacementRule: 'X' })).rejects.toThrow(/not "flow:a"/);
    await expect(lessons.consolidate('flow:a', { replaceIds: [], replacementRule: 'X' })).rejects.toThrow(/at least one/);
    await expect(lessons.consolidate('flow:a', { replaceIds: [a.id], replacementRule: ' ' })).rejects.toThrow(/non-empty/);
    expect(await lessons.all()).toHaveLength(2);
  });

  it('frees room in a full scope', async () => {
    const lessons = await store({ maxLessonsPerScope: 3 });
    const made = [];
    for (const r of ['A', 'B', 'C']) made.push(await lessons.add({ scope: 'global', rule: r }));
    await expect(lessons.add({ scope: 'global', rule: 'D' })).rejects.toBeInstanceOf(LessonCapError);
    await lessons.consolidate('global', { replaceIds: [made[0]!.id, made[1]!.id], replacementRule: 'A and B together' });
    await expect(lessons.add({ scope: 'global', rule: 'D' })).resolves.toBeDefined();
  });

  it('prunes stale one-off lessons, keeps recurring, recent and hardened ones', async () => {
    const dir = await tempDir();
    const fs = new FileStore(dir);
    const lessons = new LessonStore(fs);
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const mk = (id: string, extra: object) => ({
      id, scope: 'global', rule: id, layer: 'principle', count: 1, sourceRunIds: [], hardened: false, createdAt: old, updatedAt: old, ...extra,
    });
    await fs.writeJson(fs.lessonsFile, {
      version: 1,
      lessons: [
        mk('stale', {}),
        mk('recurring', { count: 3 }),
        mk('hardened', { hardened: true }),
        mk('recent', { updatedAt: new Date().toISOString() }),
        mk('used-lately', { lastUsedAt: new Date().toISOString() }),
      ],
    });
    const removed = await lessons.prune({ olderThanDays: 30 });
    expect(removed.map((l) => l.id)).toEqual(['stale']);
    expect((await lessons.all()).map((l) => l.id)).toEqual(['recurring', 'hardened', 'recent', 'used-lately']);
    expect(await lessons.prune({ olderThanDays: 30 })).toEqual([]);
  });

  it('prune maxUnused keeps the best never-injected lessons per scope', async () => {
    const lessons = await store();
    const a = await lessons.add({ scope: 'global', rule: 'one' });
    await lessons.add({ scope: 'global', rule: 'two' });
    await lessons.add({ scope: 'global', rule: 'two' }); // count 2
    await lessons.add({ scope: 'global', rule: 'three' });
    await lessons.markUsed([a.id]); // injected before, so exempt
    const removed = await lessons.prune({ maxUnused: 1 });
    expect(removed.map((l) => l.rule)).toEqual(['three']);
  });

  it('stamps lastUsedAt on the lessons injected into ctx.ai, and only those', async () => {
    const flow = defineFlow({ id: 'f', name: 'f', description: 'f', role: 'writer' }, async (ctx) => ctx.ai('draft', { prompt: 'x' }));
    const engine = new Engine({ store: await tempDir(), provider: new FakeProvider(() => 'ok'), flows: [flow] });
    await engine.lessons.add({ scope: 'flow:f', rule: 'Applies' });
    await engine.lessons.add({ scope: 'role:writer', rule: 'Applies by role' });
    await engine.lessons.add({ scope: 'flow:other', rule: 'Does not apply' });
    await engine.start('f');
    const byRule = Object.fromEntries((await engine.lessons.all()).map((l) => [l.rule, l.lastUsedAt]));
    expect(byRule['Applies']).toBeDefined();
    expect(byRule['Applies by role']).toBeDefined();
    expect(byRule['Does not apply']).toBeUndefined();
  });
});

describe('suggestLayer', () => {
  it.each([
    'Keep replies under 50 words.',
    'No more than 3 sentences.',
    'Max 280 characters',
    'Never use exclamation marks.',
    'Avoid emojis',
    "Don't use em dashes",
    'Never say "circle back".',
    'Always end with "Best,"',
    'Ignore emails from @newsletter.example.com',
    'Only reply to senders on the team domain',
  ])('routes the exact rule "%s" to code', (rule) => {
    expect(suggestLayer(rule)).toMatchObject({ layer: 'code' });
  });

  it.each([
    'Check the calendar before proposing times.',
    'Look up the order status first',
    'Always include the order number',
    'Fetch the latest invoice before answering',
    'Mention the deadline from the thread',
  ])('routes the missing-fact rule "%s" to context', (rule) => {
    expect(suggestLayer(rule)).toMatchObject({ layer: 'context' });
  });

  it.each(['Be warmer and more conversational.', 'Sound confident but not pushy', 'Keep it short', 'Include a friendly greeting', 'Prefer plain language'])(
    'routes the taste rule "%s" to principle',
    (rule) => {
      expect(suggestLayer(rule)).toMatchObject({ layer: 'principle' });
    },
  );

  it('always explains itself and is deterministic', () => {
    const a = suggestLayer('Never use exclamation marks.');
    expect(a.reason.length).toBeGreaterThan(10);
    expect(suggestLayer('Never use exclamation marks.')).toEqual(a);
  });
});

/** A flow with one reviewed ai step. The draft must not contain "!". */
const makeFlow = (id: string, role: string | undefined, strict = true) =>
  defineFlow<{ topic: string }>({ id, name: id, description: id, ...(role ? { role } : {}) }, async (ctx) => {
    const draft = await ctx.ai('draft', {
      prompt: `Write about ${ctx.input.topic}`,
      verify: strict ? (t: string) => (t.includes('!') ? { ok: false, reason: 'No exclamation marks allowed.' } : { ok: true }) : undefined,
      maxRetries: 0,
    });
    await ctx.human('review', { title: 'Review', summary: draft, options: ['Send as-is'] });
    return draft;
  });

/** Seeds reviewed cases (written before any rule existed, so the seeding flows have no verify). */
async function seed(dir: string, flowId: string, role: string | undefined, topics: Array<string | { topic: string; edit: string }>) {
  const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'Calm line'), flows: [makeFlow(flowId, role, false)] });
  for (const t of topics) {
    const topic = typeof t === 'string' ? t : t.topic;
    const r = (await engine.start(flowId, { topic })) as { card: HumanCard };
    await engine.answer(r.card.id, typeof t === 'string' ? { choice: '1' } : { text: t.edit });
  }
}

/** Provider that records which flow/topic each call was for. */
function spy(reply: (system: string) => string = () => 'Calm') {
  const seen: Array<{ flowId: string; topic: string }> = [];
  const provider = new FakeProvider((req) => {
    seen.push({ flowId: req.meta.flowId, topic: /Write about (\S+)/.exec(req.messages[0]!.content)![1]! });
    return reply(req.system);
  });
  return { provider, seen };
}

describe('scoped layered replay', () => {
  const allFlows = () => [makeFlow('notes', 'writer'), makeFlow('memo', 'writer'), makeFlow('invoices', 'ops')];

  async function workspace() {
    const dir = await tempDir();
    await seed(dir, 'notes', 'writer', ['n1', 'n2']);
    await seed(dir, 'memo', 'writer', ['m1']);
    await seed(dir, 'invoices', 'ops', ['i1', 'i2']);
    return dir;
  }

  it('flow:<id> replays only that flow', async () => {
    const dir = await workspace();
    const { provider, seen } = spy();
    const report = await new Engine({ store: dir, provider, flows: allFlows() }).replayScope('flow:notes');
    expect(report).toMatchObject({ scope: 'flow:notes', total: 2, passed: 2, failed: 0, regressed: 0, skipped: 0 });
    expect(report.flows.map((f) => f.flowId)).toEqual(['notes']);
    expect(new Set(seen.map((s) => s.flowId))).toEqual(new Set(['notes']));
  });

  it('role:<name> replays only the flows in that role', async () => {
    const dir = await workspace();
    const { provider, seen } = spy();
    const report = await new Engine({ store: dir, provider, flows: allFlows() }).replayScope('role:writer');
    expect(report.flows.map((f) => f.flowId).sort()).toEqual(['memo', 'notes']);
    expect(report).toMatchObject({ total: 3, passed: 3 });
    expect(seen.some((s) => s.flowId === 'invoices')).toBe(false); // the unrelated role is skipped

    const none = await new Engine({ store: dir, provider, flows: allFlows() }).replayScope('role:nobody');
    expect(none).toMatchObject({ total: 0, flows: [] });
  });

  it('global replays a bounded golden sample: edited and most recent cases first', async () => {
    const dir = await tempDir();
    await seed(dir, 'notes', 'writer', [{ topic: 'old-edit', edit: 'my own words' }, 'a', 'b', 'c', 'd']);
    await seed(dir, 'invoices', 'ops', ['i1']);
    const lonely = makeFlow('empty', 'ops'); // no cases: left out
    const { provider, seen } = spy();
    const engine = new Engine({ store: dir, provider, flows: [makeFlow('notes', 'writer'), makeFlow('invoices', 'ops'), lonely] });

    const report = await engine.replayScope('global');
    expect(report.total).toBe(3); // 2 + 1, not 6
    expect(report.flows.map((f) => f.flowId).sort()).toEqual(['invoices', 'notes']);
    expect(seen.filter((s) => s.flowId === 'notes').map((s) => s.topic).sort()).toEqual(['d', 'old-edit']);

    seen.length = 0;
    const wider = await engine.replayScope('global', { samplePerFlow: 4 });
    expect(wider.flows.find((f) => f.flowId === 'notes')!.total).toBe(4);
  });

  it('sums regressed/improved/skipped across flows and rejects unknown scopes', async () => {
    const dir = await workspace();
    const { provider } = spy((s) => 'Calm');
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'Loud!'), flows: allFlows() });
    const report = await engine.replayScope('role:writer');
    expect(report).toMatchObject({ total: 3, failed: 3, regressed: 3, passed: 0 });
    expect(report.flows.reduce((n, f) => n + f.regressed, 0)).toBe(3);
    await expect(engine.replayScope('team:x')).rejects.toThrow(/Unknown scope/);
    await expect(engine.replayScope('flow:nope')).rejects.toThrow(/not registered/);
    void provider;
  });
});

describe('replay regression gate (proposeLesson)', () => {
  const readLessons = async (dir: string) =>
    (JSON.parse(await readFile(path.join(dir, 'lessons.json'), 'utf8')) as { lessons: Array<{ rule: string }> }).lessons;

  /** Today's model: obeys any lesson that asks for enthusiasm by shouting, otherwise stays calm. */
  const model = (system: string) => (system.includes('Be enthusiastic') ? 'Wow!' : 'Calm');

  it('rejects a lesson that breaks a passing case, and never writes it to disk', async () => {
    const dir = await tempDir();
    await seed(dir, 'notes', 'writer', ['n1', 'n2']);
    const engine = new Engine({ store: dir, provider: new FakeProvider((r) => model(r.system)), flows: [makeFlow('notes', 'writer')] });
    await engine.lessons.add({ scope: 'flow:notes', rule: 'Stay polite' });
    const before = await readFile(path.join(dir, 'lessons.json'), 'utf8');

    const result = await engine.proposeLesson({ scope: 'flow:notes', rule: 'Be enthusiastic about everything' });
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.report).toMatchObject({ total: 2, regressed: 2, failed: 2 });
    expect(result.reason).toMatch(/broke 2 case\(s\)/);
    expect(result.reason).toContain('No exclamation marks allowed.');
    expect(await readFile(path.join(dir, 'lessons.json'), 'utf8')).toBe(before);
    expect((await readLessons(dir)).map((l) => l.rule)).toEqual(['Stay polite']);
  });

  it('accepts and saves a lesson with 0 regressions, returning the suggested layer', async () => {
    const dir = await tempDir();
    await seed(dir, 'notes', 'writer', ['n1']);
    const engine = new Engine({ store: dir, provider: new FakeProvider((r) => model(r.system)), flows: [makeFlow('notes', 'writer')] });

    const result = await engine.proposeLesson({ scope: 'flow:notes', rule: 'Never use exclamation marks.' });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.report).toMatchObject({ total: 1, regressed: 0, passed: 1 });
    expect(result.suggestedLayer.layer).toBe('code');
    expect(result.lesson).toMatchObject({ scope: 'flow:notes', layer: 'principle', count: 1 });
    expect((await readLessons(dir)).map((l) => l.rule)).toEqual(['Never use exclamation marks.']);
  });

  it('puts the candidate in the replayed prompt and leaves lessons.json alone while it runs', async () => {
    const dir = await tempDir();
    await seed(dir, 'notes', 'writer', ['n1']);
    let onDiskDuringReplay: string[] = [];
    const provider = new FakeProvider(async (req) => {
      onDiskDuringReplay = (await readLessons(dir)).map((l) => l.rule);
      return req.system.includes('Candidate rule') ? 'Calm (saw candidate)' : 'Calm';
    });
    const engine = new Engine({ store: dir, provider, flows: [makeFlow('notes', 'writer')] });
    const result = await engine.proposeLesson({ scope: 'role:writer', rule: 'Candidate rule' });
    expect(result.accepted).toBe(true);
    expect(onDiskDuringReplay).toEqual([]);
    expect(result.report.flows[0]!.results[0]!.output).toBe('Calm (saw candidate)');
  });

  it('lets force save a lesson that regressed, and the report still says so', async () => {
    const dir = await tempDir();
    await seed(dir, 'notes', 'writer', ['n1']);
    const engine = new Engine({ store: dir, provider: new FakeProvider((r) => model(r.system)), flows: [makeFlow('notes', 'writer')] });
    const result = await engine.proposeLesson({ scope: 'flow:notes', rule: 'Be enthusiastic' }, { force: true });
    expect(result).toMatchObject({ accepted: true });
    expect(result.report.regressed).toBe(1);
    expect(await readLessons(dir)).toHaveLength(1);
  });

  it('respects the cap before spending any AI calls, but a repeat of an existing rule passes through', async () => {
    const dir = await tempDir();
    await seed(dir, 'notes', 'writer', ['n1']);
    const { provider, seen } = spy();
    const engine = new Engine({ store: dir, provider, flows: [makeFlow('notes', 'writer')], learning: { maxLessonsPerScope: 1 } });
    await engine.lessons.add({ scope: 'flow:notes', rule: 'Existing' });

    await expect(engine.proposeLesson({ scope: 'flow:notes', rule: 'Brand new' })).rejects.toBeInstanceOf(LessonCapError);
    expect(seen).toHaveLength(0);
    const repeat = await engine.proposeLesson({ scope: 'flow:notes', rule: 'existing.' });
    expect(repeat.accepted && repeat.lesson.count).toBe(2);
  });

  it('says nothing was measured when there are no cases, and rejects bad input', async () => {
    const engine = new Engine({ store: await tempDir(), flows: [makeFlow('notes', 'writer')] });
    const result = await engine.proposeLesson({ scope: 'global', rule: 'Anything' });
    expect(result).toMatchObject({ accepted: true });
    expect(result.report.total).toBe(0);
    await expect(engine.proposeLesson({ scope: 'bogus', rule: 'x' })).rejects.toThrow(/Unknown scope/);
    await expect(engine.proposeLesson({ scope: 'global', rule: ' ' })).rejects.toThrow(/non-empty/);
  });

  it('does not strand a run when a human lesson hits the cap during answer()', async () => {
    const flow = defineFlow({ id: 'f', name: 'f', description: 'f' }, async (ctx) => {
      await ctx.human('ok?', { title: 't', summary: 's' });
      return 'finished';
    });
    const engine = new Engine({ store: await tempDir(), flows: [flow], learning: { maxLessonsPerScope: 1 } });
    await engine.lessons.add({ scope: 'flow:f', rule: 'Full' });
    const r = (await engine.start('f')) as { card: HumanCard };
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const done = await engine.answer(r.card.id, { text: 'yes', lesson: 'One more' });
      expect(done).toMatchObject({ status: 'completed', output: 'finished' });
    } finally {
      console.warn = warn;
    }
    expect(await engine.lessons.all()).toHaveLength(1);
  });
});

describe('cli guardrails', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, io: { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) } };
  };

  it('lessons shows layers and suggestions, --prune removes stale ones', async () => {
    const dir = await tempDir();
    const engine = new Engine({ store: dir });
    await engine.lessons.add({ scope: 'global', rule: 'Keep replies under 50 words.' });
    await engine.lessons.add({ scope: 'global', rule: 'Be warm.' });
    const l = capture();
    await main(['--dir', dir, 'lessons'], l.io);
    expect(l.lines.join('\n')).toMatch(/Keep replies under 50 words\.\n\s+suggested layer: code\./);
    expect(l.lines.join('\n')).not.toMatch(/Be warm\.\n\s+suggested layer/);

    const p = capture();
    await main(['--dir', dir, 'lessons', '--prune'], p.io);
    expect(p.lines).toEqual(['Nothing to prune.']);
    await main(['--dir', dir, 'lessons', '--prune', '--older-than', '0'], p.io);
    expect(p.lines.join('\n')).toMatch(/Pruned 2 stale lesson/);
  });

  it('propose and replay --scope run the gate and the scoped replay', async () => {
    const dir = await tempDir();
    const prev = process.exitCode;
    const l = capture();

    await main(['--dir', dir, 'replay', '--scope', 'global'], l.io);
    expect(l.lines.pop()).toMatch(/No saved cases for "global"/);

    await main(['--dir', dir, 'demo', '--reply', '1'], l.io); // saves one case for triage-draft
    l.lines.length = 0;
    // No provider configured: the case fails, so the candidate regresses or at least is reported.
    await main(['--dir', dir, 'replay', '--scope', 'flow:triage-draft'], l.io);
    expect(l.lines[0]).toMatch(/Replayed 1 case\(s\) across 1 flow\(s\) in "flow:triage-draft": 0 passed, 1 failed/);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;

    await expect(main(['--dir', dir, 'propose', 'global'], l.io)).rejects.toThrow(/Usage: rufus propose/);
    await expect(main(['--dir', dir, 'propose', 'nope', 'Some rule'], l.io)).rejects.toThrow(/Unknown scope/);

    // A scope with no saved cases measures nothing and accepts.
    l.lines.length = 0;
    await main(['--dir', dir, 'propose', 'role:nobody', 'Be', 'kind.'], l.io);
    expect(l.lines[0]).toMatch(/No saved cases in role:nobody, so nothing was checked/);
    expect(l.lines[1]).toMatch(/^Saved lesson l_/);
    expect((await new Engine({ store: dir }).lessons.all()).map((x) => x.rule)).toEqual(['Be kind.']);
  });
});
