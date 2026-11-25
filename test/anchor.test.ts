import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ScheduleOverlapError,
  checkBoundaries,
  emptyAnchor,
  formatAnchorSummary,
  initAnchor,
  loadAnchor,
  normalizeAnchor,
  parseTimeRange,
  saveAnchor,
  toMinutes,
  upsertGoal,
  upsertScheduleBlock,
  type Anchor,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 8, 0); // local 2026-11-25 08:00

function capture() {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) } };
}

const withBlocks = (...blocks: Array<[string, string, string, Anchor['schedule']['blocks'][number]['kind']?]>): Anchor =>
  blocks.reduce((a, [start, end, title, kind]) => upsertScheduleBlock(a, { start, end, title, kind }).anchor, emptyAnchor(NOW));

describe('anchor: load, save, init', () => {
  it('is empty (for today) when there is no anchor.json, and init writes the default boundaries once', async () => {
    const dir = await tempDir();
    const empty = await loadAnchor(dir, NOW);
    expect(empty).toEqual({ version: 1, goals: [], projects: [], boundaries: [], schedule: { date: '2026-11-25', blocks: [] } });

    const first = await initAnchor(dir, NOW);
    expect(first.created).toBe(true);
    expect(first.anchor.boundaries.map((b) => [b.kind, b.appliesTo])).toEqual([
      ['require_approval', ['external']],
      ['require_approval', ['money']],
      ['require_approval', ['login']],
    ]);
    const saved = JSON.parse(await readFile(path.join(dir, 'anchor.json'), 'utf8'));
    expect(saved.updatedAt).toBe(NOW.toISOString());

    const withGoal = upsertGoal(first.anchor, { title: 'Ship the beta' }).anchor;
    await saveAnchor(dir, withGoal, NOW);
    const again = await initAnchor(dir, NOW);
    expect(again.created).toBe(false);
    expect(again.anchor.goals).toHaveLength(1); // never overwritten
  });

  it('normalizes hand edits: bad values fall back, broken items are dropped, nothing throws', async () => {
    const a = normalizeAnchor(
      {
        goals: [{ title: 'Write', priority: 'urgent', horizon: 'year' }, { nope: true }, 'x'],
        projects: [{ name: 'Site', status: 'weird', nextStep: 'deploy' }],
        boundaries: [{ rule: 'No calls after 9pm', kind: 'protect_time' }, { kind: 'never' }],
        schedule: { date: '2026-11-25', blocks: [{ start: '9:00', end: '10:00', title: 'Run', kind: 'cardio' }, { start: '11:00', end: '10:00', title: 'Backwards' }, { title: 'No time' }] },
      },
      NOW,
    );
    expect(a.goals).toEqual([{ id: 'write', title: 'Write', priority: 'medium', horizon: 'week', active: true }]);
    expect(a.projects).toEqual([{ id: 'site', name: 'Site', status: 'active', nextStep: 'deploy' }]);
    expect(a.boundaries).toEqual([{ id: 'no-calls-after-9pm', rule: 'No calls after 9pm', kind: 'protect_time' }]);
    expect(a.schedule.blocks).toEqual([{ id: '09:00-run', start: '09:00', end: '10:00', title: 'Run', kind: 'focus', status: 'planned' }]);

    const dir = await tempDir();
    await writeFile(path.join(dir, 'anchor.json'), '{ not json');
    await expect(loadAnchor(dir, NOW)).rejects.toThrow(/not valid JSON/);
  });
});

describe('anchor: goals', () => {
  it('adds, then updates by id (a slug of the title), keeping what was not given', () => {
    const one = upsertGoal(emptyAnchor(NOW), { title: 'Ship the beta!', priority: 'high', horizon: 'today', notes: 'by Friday' });
    expect(one.created).toBe(true);
    expect(one.goal).toEqual({ id: 'ship-the-beta', title: 'Ship the beta!', priority: 'high', horizon: 'today', active: true, notes: 'by Friday' });
    const two = upsertGoal(one.anchor, { title: 'Ship the beta!', horizon: 'week' });
    expect(two.created).toBe(false);
    expect(two.anchor.goals).toEqual([{ ...one.goal, horizon: 'week' }]);
    expect(one.anchor.goals[0]!.horizon).toBe('today'); // pure: the input anchor is untouched
    expect(() => upsertGoal(emptyAnchor(NOW), { title: '  ' })).toThrow(/needs a title/);
    expect(() => upsertGoal(emptyAnchor(NOW), { title: 'x', priority: 'urgent' as never })).toThrow(/priority/);
  });
});

describe('anchor: schedule blocks and overlap detection', () => {
  it('parses and validates times', () => {
    expect(parseTimeRange('9:00-10:30')).toEqual({ start: '09:00', end: '10:30' });
    expect(parseTimeRange('13:00 – 14:00')).toEqual({ start: '13:00', end: '14:00' });
    expect(() => parseTimeRange('10:00-09:00')).toThrow(/end after it starts/);
    expect(() => parseTimeRange('lunch')).toThrow(/HH:MM-HH:MM/);
    expect(() => toMinutes('25:00')).toThrow(/not a time/);
    expect(toMinutes('24:00')).toBe(1440);
  });

  it('keeps blocks sorted, allows back-to-back, and refuses overlaps with the conflicts named', () => {
    const a = withBlocks(['10:00', '11:00', 'Write'], ['09:00', '10:00', 'Email', 'meeting'], ['11:00', '11:15', 'Break', 'break']);
    expect(a.schedule.blocks.map((b) => `${b.start} ${b.title}`)).toEqual(['09:00 Email', '10:00 Write', '11:00 Break']);
    let err: unknown;
    try {
      upsertScheduleBlock(a, { start: '10:30', end: '11:10', title: 'Call', kind: 'meeting' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScheduleOverlapError);
    expect((err as ScheduleOverlapError).conflicts.map((c) => c.title)).toEqual(['Write', 'Break']);
    expect((err as Error).message).toContain('10:30-11:10 "Call" overlaps 10:00-11:00 "Write"');
  });

  it('allowOverlap lets ordinary blocks overlap, but a protected block always wins', () => {
    const a = withBlocks(['09:00', '11:00', 'Deep work', 'protected'], ['13:00', '14:00', 'Lunch', 'break']);
    const ok = upsertScheduleBlock(a, { start: '13:30', end: '14:30', title: 'Walk', kind: 'personal' }, { allowOverlap: true });
    expect(ok.overlaps.map((b) => b.title)).toEqual(['Lunch']);
    expect(() => upsertScheduleBlock(a, { start: '10:30', end: '11:30', title: 'Sync', kind: 'meeting' }, { allowOverlap: true })).toThrow(/protected/);
    // A new protected block cannot be laid over existing plans either.
    expect(() => upsertScheduleBlock(a, { start: '13:30', end: '15:00', title: 'Focus', kind: 'protected' }, { allowOverlap: true })).toThrow(ScheduleOverlapError);
  });

  it('updates a block in place by id (moving it never conflicts with itself), and skipped blocks free their slot', () => {
    const a = withBlocks(['09:00', '10:00', 'Write']);
    const id = a.schedule.blocks[0]!.id;
    const moved = upsertScheduleBlock(a, { id, start: '09:30', end: '10:30', title: 'Write' });
    expect(moved.created).toBe(false);
    expect(moved.anchor.schedule.blocks).toHaveLength(1);
    expect(moved.anchor.schedule.blocks[0]).toMatchObject({ id, start: '09:30', end: '10:30', status: 'planned' });
    const skipped = upsertScheduleBlock(a, { id, start: '09:00', end: '10:00', title: 'Write', status: 'skipped' }).anchor;
    expect(upsertScheduleBlock(skipped, { start: '09:00', end: '10:00', title: 'Read' }).anchor.schedule.blocks).toHaveLength(2);
  });

  it('a block for another date archives the current day instead of losing it', () => {
    const today = withBlocks(['09:00', '10:00', 'Write']);
    const tomorrow = upsertScheduleBlock(today, { start: '09:00', end: '10:00', title: 'Read' }, { date: '2026-11-26' }).anchor;
    expect(tomorrow.schedule).toMatchObject({ date: '2026-11-26', blocks: [{ title: 'Read' }] });
    expect(tomorrow.pastSchedules).toEqual([today.schedule]);
    const back = upsertScheduleBlock(tomorrow, { start: '11:00', end: '12:00', title: 'Edit' }, { date: '2026-11-25' }).anchor;
    expect(back.schedule.blocks.map((b) => b.title)).toEqual(['Write', 'Edit']);
    expect(() => upsertScheduleBlock(today, { start: '09:00', end: '10:00', title: 'x' }, { date: 'tomorrow' })).toThrow(/YYYY-MM-DD/);
  });
});

describe('anchor: boundaries', () => {
  it('external sends, money and logins always need approval; never-rules block; approvals match action types and prefixes', () => {
    const bare = emptyAnchor(NOW);
    expect(checkBoundaries(bare, 'research.brief')).toEqual({ blockedBy: [], approvalBy: [], requiresApproval: false });
    const floor = checkBoundaries(bare, 'reply.chat', ['external']);
    expect(floor.requiresApproval).toBe(true);
    expect(floor.approvalBy[0]!.id).toBe('builtin-external');

    const a: Anchor = {
      ...bare,
      boundaries: [
        { id: 'no-posts', rule: 'Never post publicly', kind: 'never', appliesTo: ['social.post'] },
        { id: 'replies', rule: 'Ask before any reply', kind: 'require_approval', appliesTo: ['reply'] },
        { id: 'pay', rule: 'Ask before paying', kind: 'require_approval', appliesTo: ['money'] },
      ],
    };
    expect(checkBoundaries(a, 'social.post').blockedBy.map((b) => b.id)).toEqual(['no-posts']);
    expect(checkBoundaries(a, 'reply.chat').approvalBy.map((b) => b.id)).toEqual(['replies']);
    expect(checkBoundaries(a, 'shop.order', ['money']).approvalBy.map((b) => b.id)).toEqual(['pay']); // the user's rule, no duplicate floor
    expect(checkBoundaries(a, 'replying.x').requiresApproval).toBe(false); // a prefix means a whole segment
  });
});

describe('anchor: summary and CLI', () => {
  it('formats goals by priority, live projects, boundaries and the day', () => {
    let a = upsertGoal(emptyAnchor(NOW), { title: 'Low thing', priority: 'low' }).anchor;
    a = upsertGoal(a, { title: 'Big thing', priority: 'high', horizon: 'today' }).anchor;
    a = upsertGoal(a, { title: 'Old thing', active: false }).anchor;
    a = { ...a, projects: [{ id: 'p', name: 'Site', status: 'active', nextStep: 'deploy' }, { id: 'q', name: 'Done one', status: 'done' }] };
    a = upsertScheduleBlock(a, { start: '09:00', end: '10:00', title: 'Write', kind: 'focus' }).anchor;
    const text = formatAnchorSummary(a).join('\n');
    expect(text).toContain('Goals (2 active):\n  [high] Big thing (today)\n  [low] Low thing (week)');
    expect(text).toContain('Site [active] next: deploy');
    expect(text).not.toContain('Done one');
    expect(text).not.toContain('Old thing');
    expect(text).toContain('Schedule 2026-11-25:\n  09:00-10:00  focus     Write');
  });

  it('rufus anchor init | goal | block | show', async () => {
    const dir = await tempDir();
    const run = async (...args: string[]) => {
      const c = capture();
      await main(['--dir', dir, 'anchor', ...args], c.io);
      return c.lines.join('\n');
    };
    expect(await run('init')).toContain('Anchor created');
    expect(await run('init')).toContain('already exists');
    expect(await run('goal', 'Ship', 'the', 'beta', '--priority', 'high', '--horizon', 'today')).toBe('Added goal ship-the-beta: [high] Ship the beta (today).');
    expect(await run('block', '09:00-11:00', 'protected', 'Deep', 'work')).toMatch(/Added 09:00-11:00 protected "Deep work" on \d{4}-\d{2}-\d{2}\./);
    await expect(run('block', '10:00-10:30', 'meeting', 'Sync')).rejects.toThrow(/overlaps 09:00-11:00 "Deep work" \(protected\)/);
    await expect(run('block', '12:00-13:00', 'nap', 'Rest')).rejects.toThrow(/kind must be one of/);
    const shown = await run();
    expect(shown).toContain('[high] Ship the beta (today)');
    expect(shown).toContain('09:00-11:00  protected Deep work');
    expect(shown).toContain('ask: Ask me before spending money');
  });
});
