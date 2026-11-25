import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChiefOfStaff, Engine, FileStore, LessonStore, detectLessonDrift, type HistoryPair } from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const at = (daysAgo: number): string => new Date(NOW - daysAgo * 86_400_000).toISOString();
let n = 0;
const pair = (reply: string, daysAgo: number): HistoryPair => ({
  id: `p${++n}`,
  channel: 'sms',
  sender: `Contact ${n % 6}`,
  incoming: 'are we still on for thursday?',
  reply,
  incomingAt: at(daysAgo),
  replyAt: at(daysAgo),
});

const RULE = 'Do not use em dashes.';
/** 60 old replies that honor the rule, then 10 recent ones that break it. */
const drifting = (): HistoryPair[] => [
  ...Array.from({ length: 60 }, (_, i) => pair('works for me', 300 - i)),
  ...Array.from({ length: 10 }, (_, i) => pair(`works — see you then ${i}`, 10 - i)),
];
const honoring = (): HistoryPair[] => Array.from({ length: 30 }, (_, i) => pair('works for me', 60 - i));

async function store(): Promise<{ dir: string; lessons: LessonStore }> {
  const dir = await tempDir();
  const fs = new FileStore(dir);
  await fs.init();
  return { dir, lessons: new LessonStore(fs) };
}

describe('lessons are living beliefs: review() keeps evidence on each lesson', () => {
  it('flags a lesson in tension and stores the evidence on it', async () => {
    const { lessons } = await store();
    const em = await lessons.add({ scope: 'global', rule: RULE });
    const taste = await lessons.add({ scope: 'global', rule: 'Be warm.' });
    expect(em.evidence).toBeUndefined();

    const tense = await lessons.review(drifting());
    expect(tense.map((l) => l.id)).toEqual([em.id]);
    const saved = (await lessons.all()).find((l) => l.id === em.id)!;
    expect(saved.evidence).toEqual({ forCount: 60, againstCount: 10, recentAgainst: 10, recentTotal: 15, status: 'tension' });
    expect((await lessons.all()).find((l) => l.id === taste.id)!.evidence).toBeUndefined(); // code cannot measure taste
  });

  it('marks a lesson aligned when recent replies agree, stale when there are too few to say, and clears tension when behavior returns', async () => {
    const { lessons } = await store();
    const l = await lessons.add({ scope: 'global', rule: RULE });

    expect(await lessons.review(honoring())).toEqual([]);
    expect((await lessons.all())[0]!.evidence).toMatchObject({ status: 'aligned', againstCount: 0, forCount: 30 });

    expect(await lessons.review(honoring().slice(0, 3))).toEqual([]);
    expect((await lessons.all())[0]!.evidence).toMatchObject({ status: 'stale', recentTotal: 3 });

    await lessons.review(drifting());
    expect((await lessons.all())[0]!.evidence!.status).toBe('tension');
    await lessons.review([...drifting(), ...Array.from({ length: 15 }, (_, i) => pair('works for me', 5 - i * 0.1))]);
    expect((await lessons.all())[0]!.evidence!.status).toBe('aligned');
    expect((await lessons.all())[0]!.id).toBe(l.id);
  });

  it('leaves hardened lessons alone, and never touches count, updatedAt or injection', async () => {
    const { lessons } = await store();
    const a = await lessons.add({ scope: 'global', rule: RULE });
    const b = await lessons.add({ scope: 'flow:x', rule: 'Never use exclamation marks!' });
    await lessons.markHardened(b.id);
    const before = (await lessons.all()).map((l) => ({ id: l.id, count: l.count, updatedAt: l.updatedAt, hardened: l.hardened }));
    await lessons.review([...drifting(), ...Array.from({ length: 20 }, (_, i) => pair('great!!', 20 - i))]);
    const after = await lessons.all();
    expect(after.map((l) => ({ id: l.id, count: l.count, updatedAt: l.updatedAt, hardened: l.hardened }))).toEqual(before);
    expect(after.find((l) => l.id === b.id)!.evidence).toBeUndefined();
    expect(after.find((l) => l.id === a.id)!.evidence!.status).toBe('tension');
  });

  it('agrees with detectLessonDrift (the thin, backwards-compatible view of the same measurement)', async () => {
    const { lessons } = await store();
    const l = await lessons.add({ scope: 'global', rule: RULE });
    const [drift] = detectLessonDrift([l], drifting());
    const [tense] = await lessons.review(drifting());
    expect(drift!.recent).toMatchObject({ violations: tense!.evidence!.recentAgainst, of: tense!.evidence!.recentTotal });
    expect(drift!.allTime.violations).toBe(tense!.evidence!.againstCount);
  });
});

describe('`rufus lessons` and chat show every lesson and flag the ones in tension, in one place', () => {
  async function setup() {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'history'), { recursive: true });
    await writeFile(path.join(dir, 'history', 'pairs.jsonl'), drifting().map((p) => JSON.stringify(p)).join('\n') + '\n');
    const mk = (id: string, scope: string, rule: string) => ({ id, scope, rule, layer: 'principle', count: 1, sourceRunIds: [], hardened: false, createdAt: at(30), updatedAt: at(30) });
    await writeFile(path.join(dir, 'lessons.json'), JSON.stringify({ version: 1, lessons: [mk('l_1', 'global', RULE), mk('l_2', 'global', 'Be warm.')] }));
    return dir;
  }

  it('rufus lessons lists all lessons, tags the one in tension, asks the question, and saves the evidence', async () => {
    const dir = await setup();
    const lines: string[] = [];
    await main(['--dir', dir, 'lessons'], { out: (l) => void lines.push(l), err: (l) => void lines.push(l) });
    const text = lines.join('\n');
    expect(text).toContain(`l_1  x1  global  ${RULE} [in tension]`);
    expect(text).toContain('Keep it as an aspiration, refine it into conditional logic, or retire it?');
    expect(text).toContain('l_2  x1  global  Be warm.');
    expect(text.match(/\[in tension\]/g)).toHaveLength(1);
    const saved = JSON.parse(await readFile(path.join(dir, 'lessons.json'), 'utf8')) as { lessons: Array<{ id: string; evidence?: { status: string } }> };
    expect(saved.lessons.find((l) => l.id === 'l_1')!.evidence!.status).toBe('tension');
  });

  it('chat "lessons" shows the same tension', async () => {
    const dir = await setup();
    const chief = new ChiefOfStaff({ engine: new Engine({ store: dir }) });
    const reply = await chief.handleMessage('lessons');
    expect(reply).toContain(`${RULE} (global, x1, in tension)`);
    expect(reply).toContain('In tension with your latest replies:');
  });

  it('without any history, lessons list as before (nothing to check)', async () => {
    const { dir, lessons } = await store();
    await lessons.add({ scope: 'global', rule: RULE });
    const lines: string[] = [];
    await main(['--dir', dir, 'lessons'], { out: (l) => void lines.push(l), err: (l) => void lines.push(l) });
    expect(lines.join('\n')).not.toContain('tension');
  });
});
