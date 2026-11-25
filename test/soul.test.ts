import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChiefOfStaff,
  CorpusStore,
  Engine,
  FakeProvider,
  MasterLoop,
  SOUL_TEMPLATE,
  anchorBrief,
  buildPersona,
  emptyAnchor,
  initSoul,
  loadAnchor,
  loadSoul,
  saveAnchor,
  upsertGoal,
  upsertScheduleBlock,
  withPersona,
  type CorpusItem,
  type LoopSignal,
  type Sensor,
  type SignalHandler,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 8, 0);
const SOUL = '# Voice\nShort and warm. Never book anything before 10:00.';

const oneSignal = (signal: LoopSignal): Sensor => ({ id: 'one', surface: signal.surface, poll: (cursor) => (cursor ? { signals: [] } : { signals: [signal], nextCursor: '1' }) });

async function workspace(): Promise<string> {
  const dir = await tempDir();
  await writeFile(path.join(dir, 'SOUL.md'), SOUL, 'utf8');
  let anchor = upsertGoal(emptyAnchor(NOW), { title: 'Ship the beta', priority: 'high', horizon: 'week' }).anchor;
  anchor = upsertScheduleBlock(anchor, { start: '09:00', end: '11:00', kind: 'protected', title: 'Deep work' }).anchor;
  await saveAnchor(dir, anchor, NOW);
  return dir;
}

const fact = (id: string, summary: string, source = 'file'): CorpusItem => ({ id, source, kind: 'note', title: id, summary, timestamp: NOW.toISOString() });

describe('loadSoul / initSoul', () => {
  it('reads SOUL.md, and is undefined when missing, blank or only comments', async () => {
    const dir = await tempDir();
    expect(await loadSoul(dir)).toBeUndefined();
    await writeFile(path.join(dir, 'SOUL.md'), '   \n\n', 'utf8');
    expect(await loadSoul(dir)).toBeUndefined();
    await writeFile(path.join(dir, 'SOUL.md'), SOUL_TEMPLATE, 'utf8');
    expect(await loadSoul(dir)).toBeUndefined();
    await writeFile(path.join(dir, 'SOUL.md'), `<!-- a note to self -->\n${SOUL}\n`, 'utf8');
    expect(await loadSoul(dir)).toBe(SOUL);
  });

  it('initSoul writes the template once and never overwrites your words', async () => {
    const dir = await tempDir();
    expect(await initSoul(dir)).toBe(true);
    expect(await initSoul(dir)).toBe(false);
    await writeFile(path.join(dir, 'SOUL.md'), SOUL, 'utf8');
    expect(await initSoul(dir)).toBe(false);
    expect(await loadSoul(dir)).toBe(SOUL);
  });

  it('rufus init creates the SOUL.md template', async () => {
    const dir = await tempDir();
    const out: string[] = [];
    await main(['--dir', dir, 'init'], { out: (l) => void out.push(l), err: (l) => void out.push(l) });
    expect(out.join('\n')).toContain('SOUL.md template');
    expect(await loadSoul(dir)).toBeUndefined(); // all comments: changes nothing until you write in it
  });
});

describe('buildPersona', () => {
  it('is empty when there is nothing to add', () => {
    expect(buildPersona({})).toBe('');
    expect(withPersona('base', '')).toBe('base');
  });

  it('puts SOUL.md, a compact Anchor, examples and facts together', async () => {
    const anchor = await loadAnchor(await workspace(), NOW);
    expect(anchorBrief(anchor)).toContain('[high/week] Ship the beta');
    expect(anchorBrief(anchor)).toContain('09:00-11:00 protected Deep work');
    const persona = buildPersona({
      soul: SOUL,
      anchor,
      examples: [{ item: fact('e1', 'In: lunch? | Human: edit -> Sorry, booked', 'feedback'), score: 1, matched: [] }],
      facts: [{ item: fact('f1', 'The beta ships Friday.'), score: 1, matched: ['beta'] }],
    });
    expect(persona).toContain('## Who you work for (SOUL.md)\n# Voice');
    expect(persona).toContain('Ship the beta');
    expect(persona).toContain('Human: edit -> Sorry, booked');
    expect(persona).toContain('[file] f1: The beta ships Friday.');
  });
});

describe('SOUL.md in the Master Loop', () => {
  const handler = (calls: string[] = []): SignalHandler<{ reply: string }> => ({
    id: 'reply',
    match: { surface: 'chat' },
    async plan(_s, ctx) {
      calls.push(ctx.soul ?? '');
      await ctx.ai('Classify this.');
      return { goal: 'Answer about the beta', actionType: 'reply.chat', route: 'fast' };
    },
    async execute(_p, s, ctx) {
      return { reply: await ctx.ai(`Reply to: ${s.text}`) };
    },
    async crossCheck(r, _p, _s, ctx) {
      return (await ctx.ai(`Is this fine? ${r.reply}`, { persona: false })) === 'yes' ? { ok: true } : { ok: false, reason: 'no' };
    },
  });

  it('every plan / execute / verify call carries SOUL.md + the Anchor + the closest examples and facts', async () => {
    const dir = await workspace();
    await new CorpusStore(path.join(dir, 'corpus', 'items.jsonl')).add([
      fact('beta-note', 'The beta release needs the export fix first.'),
      { ...fact('fb1', 'In: is the beta ready? | Proposed: yes | Human: edit -> Almost, Friday', 'feedback'), tags: ['reply.chat', 'edit', 'chat', 'loop'] },
    ]);
    const provider = new FakeProvider(['batch', 'Almost there, Friday.', 'yes']);
    const souls: string[] = [];
    const loop = new MasterLoop({ dir, sensors: [oneSignal({ id: 's1', surface: 'chat', kind: 'message.received', text: 'is the beta ready?' })], handlers: [handler(souls)], providers: { fast: provider }, now: () => NOW });
    const report = await loop.runOnce();
    expect(report.runs[0]!.status).toBe('awaiting_human_verify');
    expect(souls).toEqual([SOUL]);
    const [plan, execute, verify] = provider.calls;
    for (const req of [plan!, execute!]) {
      expect(req.system).toContain('You are Rufus, a careful chief of staff.');
      expect(req.system).toContain('Never book anything before 10:00.');
      expect(req.system).toContain('Ship the beta');
      expect(req.system).toContain('09:00-11:00 protected Deep work');
      expect(req.system).toContain('The beta release needs the export fix first.');
    }
    expect(execute!.system).toContain('Human: edit -> Almost, Friday'); // the run's action type is known by then
    expect(verify!.system).not.toContain('SOUL.md'); // persona: false opts out per call
  });

  it('soul: false turns it off, and a string replaces the file', async () => {
    const dir = await workspace();
    const off = new FakeProvider(['x', 'y', 'yes']);
    await new MasterLoop({ dir, soul: false, sensors: [oneSignal({ id: 'a', surface: 'chat', kind: 'm', text: 'hi' })], handlers: [handler()], providers: { fast: off }, now: () => NOW }).runOnce();
    expect(off.calls[0]!.system).not.toContain('Never book');
    expect(off.calls[0]!.system).toContain('Ship the beta'); // the Anchor still goes in

    const dir2 = await tempDir();
    const custom = new FakeProvider(['x', 'y', 'yes']);
    await new MasterLoop({ dir: dir2, soul: 'Be terse.', sensors: [oneSignal({ id: 'b', surface: 'chat', kind: 'm', text: 'hi' })], handlers: [handler()], providers: { fast: custom }, now: () => NOW }).runOnce();
    expect(custom.calls[0]!.system).toContain('Be terse.');
  });

  it('a workspace without SOUL.md, anchor or corpus keeps the old system prompt (plus default boundaries only)', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(['x', 'y', 'yes']);
    await new MasterLoop({ dir, sensors: [oneSignal({ id: 'c', surface: 'chat', kind: 'm', text: 'hi' })], handlers: [handler()], providers: { fast: provider }, now: () => NOW }).runOnce();
    expect(provider.calls[0]!.system).toMatch(/^You are Rufus, a careful chief of staff\. Answer exactly what is asked\./);
    expect(provider.calls[0]!.system).not.toContain('SOUL.md');
  });
});

describe('SOUL.md in Chief of Staff chat', () => {
  it('injects SOUL.md, the Anchor and the closest corpus facts into the system prompt', async () => {
    const dir = await workspace();
    await new CorpusStore(path.join(dir, 'corpus', 'items.jsonl')).add([fact('beta-note', 'The beta release needs the export fix first.')]);
    const provider = new FakeProvider(() => 'Friday, once export is fixed.');
    const engine = new Engine({ store: dir, provider, flows: [] });
    const reply = await new ChiefOfStaff({ engine }).handle('when does the beta ship?');
    expect(reply.text).toBe('Friday, once export is fixed.');
    const req = provider.calls[0]!;
    expect(req.system).toMatch(/never invent/); // the chief's own rules stay first
    expect(req.system).toContain('Short and warm. Never book anything before 10:00.');
    expect(req.system).toContain('[high/week] Ship the beta');
    expect(req.system).toContain('The beta release needs the export fix first.');
  });
});
