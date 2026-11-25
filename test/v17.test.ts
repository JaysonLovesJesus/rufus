import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChiefOfStaff,
  CorpusStore,
  EMPTY_DIGEST,
  Engine,
  FakeProvider,
  MasterLoop,
  ToolRegistry,
  UnifiedDaemon,
  anchorUpdateTool,
  appendSignal,
  buildBreakDigest,
  codePlan,
  commitPendingPlan,
  dayPlanFile,
  digestCandidates,
  emptyAnchor,
  inboxSensor,
  isNoisePage,
  loadAnchor,
  loadPendingPlan,
  localDate,
  mergeCalendarEvents,
  messageTriageHandler,
  openGaps,
  overlaps,
  parseCalendarEvents,
  proposeDayPlan,
  range12,
  saveAnchor,
  savePendingPlan,
  syncCalendarToAnchor,
  toMinutes,
  type AiRequest,
  type Anchor,
  type CorpusItem,
  type DayPlan,
  type IncomingMessage,
  type LiveChannel,
  type ScheduleBlock,
  type ToolDefinition,
} from '../src';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 14, 0); // Wednesday, 2pm local
const MIN = 60_000;
const at = (h: number, m = 0, day = 25): string => new Date(2026, 10, day, h, m).toISOString();

const block = (over: Partial<ScheduleBlock> & Pick<ScheduleBlock, 'id' | 'start' | 'end' | 'title'>): ScheduleBlock => ({ kind: 'focus', status: 'planned', ...over });

function anchorWith(blocks: ScheduleBlock[], over: Partial<Anchor> = {}, now = NOW): Anchor {
  return { ...emptyAnchor(now), ...over, schedule: { date: localDate(now), blocks } };
}

/** A read-only `calendar.read` whose output the test controls, counting calls. */
function fakeCalendar(out: () => unknown) {
  const calls: Array<Record<string, unknown>> = [];
  const tool: ToolDefinition = {
    name: 'calendar.read',
    description: 'Read calendar events (JSON).',
    readOnly: true,
    execute(args) {
      calls.push(args);
      return out();
    },
  };
  return { tool, calls, registry: new ToolRegistry({ tools: [tool] }) };
}

/** No two blocks overlap, and none overlaps the given existing blocks. */
function assertNoOverlaps(blocks: Array<{ start: string; end: string }>, existing: Array<{ start: string; end: string }> = []): void {
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) expect(overlaps(blocks[i]!, blocks[j]!), `${JSON.stringify(blocks[i])} vs ${JSON.stringify(blocks[j])}`).toBe(false);
    for (const e of existing) expect(overlaps(blocks[i]!, e), `${JSON.stringify(blocks[i])} vs existing ${JSON.stringify(e)}`).toBe(false);
  }
}

class Chat implements LiveChannel {
  sent: string[] = [];
  inbox: IncomingMessage[] = [];
  private n = 0;
  constructor(private readonly clock: () => Date) {}
  async send(text: string) {
    this.sent.push(text);
  }
  async poll(since?: string) {
    return this.inbox.filter((m) => !since || !m.at || m.at >= since);
  }
  human(text: string) {
    this.n++;
    this.inbox.push({ id: `in_${this.n}`, text, at: new Date(this.clock().getTime() + this.n).toISOString() });
  }
}

// ---------- 1. Real Calendar Sync ----------

describe('v17 calendar sync: parsing calendar.read output', () => {
  it("keeps today's timed events as local HH:MM, from plain or Google-style records", () => {
    const events = parseCalendarEvents(
      [
        { id: 'e1', title: 'Standup', start: at(9), end: at(9, 15) },
        { summary: 'Dentist', start: { dateTime: at(15) }, end: { dateTime: at(16) } },
        { title: 'Lunch with Sam', start: '12:30', end: '13:15' },
        { title: 'Tomorrow thing', start: at(10, 0, 26), end: at(11, 0, 26) },
        { title: 'Holiday', start: { date: '2026-11-25' }, end: { date: '2026-11-26' } },
        { title: 'Offsite', allDay: true, start: at(0), end: at(23, 59) },
        { title: 'Cancelled sync', status: 'cancelled', start: at(17), end: at(18) },
        { title: 'Late call', start: at(23, 30), end: at(0, 30, 26) },
        { title: 'No end', start: at(18) },
      ],
      NOW,
    )!;
    expect(events).toEqual([
      { id: 'e1', title: 'Standup', start: '09:00', end: '09:15' },
      { title: 'Lunch with Sam', start: '12:30', end: '13:15' },
      { title: 'Dentist', start: '15:00', end: '16:00' },
      { title: 'No end', start: '18:00', end: '18:30' },
      { title: 'Late call', start: '23:30', end: '24:00' },
    ]);
  });

  it('reads wrapped lists, and says "no list" for output that is not one (so nothing gets wiped)', () => {
    expect(parseCalendarEvents({ events: [{ title: 'A', start: '10:00', end: '11:00' }] }, NOW)).toHaveLength(1);
    expect(parseCalendarEvents({ items: [] }, NOW)).toEqual([]);
    expect(parseCalendarEvents('Error: not signed in', NOW)).toBeUndefined();
    expect(parseCalendarEvents({ error: 'nope' }, NOW)).toBeUndefined();
  });
});

describe('v17 calendar sync: syncCalendarToAnchor', () => {
  it('adds, updates and removes only calendar blocks, keeps your own, and reports conflicts with focus blocks', async () => {
    const dir = await tempDir();
    await saveAnchor(
      dir,
      anchorWith([
        block({ id: 'deep', start: '14:30', end: '16:00', title: 'Deep work', source: 'manual' }),
        block({ id: 'gym', start: '18:00', end: '19:00', title: 'Gym', kind: 'personal', source: 'chat' }),
        block({ id: 'cal-old', start: '11:00', end: '11:30', title: 'Cancelled 1:1', kind: 'meeting', source: 'calendar' }),
      ]),
      NOW,
    );
    let events: unknown[] = [
      { id: 'e1', title: 'Standup', start: at(9), end: at(9, 15) },
      { id: 'e2', title: 'Dentist', start: at(15), end: at(16) },
    ];
    const cal = fakeCalendar(() => events);

    const first = await syncCalendarToAnchor(dir, cal.registry, NOW);
    expect(first).toMatchObject({ synced: 2, added: ['cal-e1', 'cal-e2'], removed: ['cal-old'], updated: [], changed: true });
    expect(first.conflicts).toHaveLength(1);
    expect(first.conflicts[0]!.event).toMatchObject({ id: 'cal-e2', title: 'Dentist', source: 'calendar' });
    expect(first.conflicts[0]!.blocks.map((b) => b.id)).toEqual(['deep']);
    expect(cal.calls[0]).toMatchObject({ date: '2026-11-25' });

    let anchor = await loadAnchor(dir, NOW);
    expect(anchor.schedule.blocks.map((b) => `${b.start} ${b.title} ${b.source}`)).toEqual([
      '09:00 Standup calendar',
      '14:30 Deep work manual',
      '15:00 Dentist calendar',
      '18:00 Gym chat',
    ]);
    expect(anchor.schedule.blocks.find((b) => b.id === 'cal-e1')).toMatchObject({ kind: 'meeting', status: 'planned' });

    // The dentist moves to 4pm: an update (same id), and the conflict is gone.
    events = [
      { id: 'e1', title: 'Standup', start: at(9), end: at(9, 15) },
      { id: 'e2', title: 'Dentist', start: at(16), end: at(17) },
    ];
    const second = await syncCalendarToAnchor(dir, cal.registry, NOW);
    expect(second).toMatchObject({ synced: 2, added: [], removed: [], updated: ['cal-e2'], conflicts: [], changed: true });
    anchor = await loadAnchor(dir, NOW);
    expect(anchor.schedule.blocks.find((b) => b.id === 'cal-e2')).toMatchObject({ start: '16:00', end: '17:00' });
    expect(anchor.schedule.blocks.find((b) => b.id === 'deep')).toMatchObject({ start: '14:30', end: '16:00', source: 'manual' });

    // Nothing changed: the file is not rewritten.
    const before = (await stat(path.join(dir, 'anchor.json'))).mtimeMs;
    const savedAt = anchor.updatedAt;
    const third = await syncCalendarToAnchor(dir, cal.registry, new Date(NOW.getTime() + 20 * MIN));
    expect(third).toMatchObject({ changed: false, added: [], removed: [], updated: [] });
    expect((await loadAnchor(dir, NOW)).updatedAt).toBe(savedAt);
    expect((await stat(path.join(dir, 'anchor.json'))).mtimeMs).toBe(before);

    // The calendar empties: calendar blocks go, yours stay.
    events = [];
    const fourth = await syncCalendarToAnchor(dir, cal.registry, NOW);
    expect(fourth).toMatchObject({ synced: 0, removed: ['cal-e1', 'cal-e2'] });
    expect((await loadAnchor(dir, NOW)).schedule.blocks.map((b) => b.id)).toEqual(['deep', 'gym']);
  });

  it('keeps a status you set on a calendar block (done, skipped) across syncs', () => {
    const anchor = anchorWith([block({ id: 'cal-e1', start: '09:00', end: '09:15', title: 'Standup', kind: 'meeting', source: 'calendar', status: 'done' })]);
    const { anchor: next, result } = mergeCalendarEvents(anchor, [{ id: 'e1', title: 'Standup', start: '09:00', end: '09:15' }], NOW);
    expect(result.changed).toBe(false);
    expect(next.schedule.blocks[0]!.status).toBe('done');
  });

  it("starts a fresh day: yesterday's schedule is archived, not lost or merged", () => {
    const yesterday = new Date(2026, 10, 24, 9, 0);
    const anchor = anchorWith([block({ id: 'old', start: '10:00', end: '11:00', title: 'Yesterday focus' })], {}, yesterday);
    const { anchor: next, result } = mergeCalendarEvents(anchor, [{ title: 'Standup', start: '09:00', end: '09:15' }], NOW);
    expect(result.changed).toBe(true);
    expect(next.schedule.date).toBe('2026-11-25');
    expect(next.schedule.blocks.map((b) => b.title)).toEqual(['Standup']);
    expect(next.pastSchedules?.[0]).toMatchObject({ date: '2026-11-24' });
  });

  it('without calendar.read, or when it fails or prints junk, the Anchor is left exactly as it was', async () => {
    const dir = await tempDir();
    await saveAnchor(dir, anchorWith([block({ id: 'cal-x', start: '10:00', end: '11:00', title: 'Review', kind: 'meeting', source: 'calendar' })]), NOW);
    const raw = await readFile(path.join(dir, 'anchor.json'), 'utf8');

    expect(await syncCalendarToAnchor(dir, new ToolRegistry(), NOW)).toMatchObject({ synced: 0, changed: false, skipped: expect.stringContaining('calendar.read') });
    await expect(syncCalendarToAnchor(dir, fakeCalendar(() => 'Error: token expired').registry, NOW)).rejects.toThrow(/did not return a list/);
    const broken = fakeCalendar(() => {
      throw new Error('offline');
    });
    await expect(syncCalendarToAnchor(dir, broken.registry, NOW)).rejects.toThrow(/offline/);
    expect(await readFile(path.join(dir, 'anchor.json'), 'utf8')).toBe(raw);
  });
});

describe('v17 calendar sync in the daemon', () => {
  async function daemonWith(events: () => unknown, opts: { calendarSync?: { everyMs?: number } | false } = {}) {
    const dir = await tempDir();
    let t = NOW;
    const clock = () => t;
    const cal = fakeCalendar(events);
    const out: string[] = [];
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'SILENT') });
    const loop = new MasterLoop({ dir, sensors: [], handlers: [], tools: cal.registry, now: clock });
    const daemon = new UnifiedDaemon({ loop, engine, chief: false, heartbeat: false, output: (s) => out.push(s), ...(opts.calendarSync !== undefined ? { calendarSync: opts.calendarSync } : {}), now: clock });
    return { dir, cal, out, daemon, advance: (ms: number) => void (t = new Date(t.getTime() + ms)) };
  }

  it('syncs on startup, then only every 20 minutes ($0: no model call)', async () => {
    const d = await daemonWith(() => [{ id: 'e1', title: 'Standup', start: at(16), end: at(16, 15) }]);
    const r1 = await d.daemon.tick();
    expect(r1.errors).toEqual([]);
    expect(r1.calendar).toMatchObject({ synced: 1, added: ['cal-e1'] });
    expect((await loadAnchor(d.dir, NOW)).schedule.blocks.map((b) => b.title)).toEqual(['Standup']);
    d.advance(5 * MIN);
    expect((await d.daemon.tick()).calendar).toBeUndefined();
    expect(d.cal.calls).toHaveLength(1);
    d.advance(16 * MIN);
    expect((await d.daemon.tick()).calendar).toMatchObject({ synced: 1, changed: false });
    expect(d.cal.calls).toHaveLength(2);
  });

  it('mentions a new conflict with one of your blocks once, in plain words', async () => {
    const d = await daemonWith(() => [{ id: 'e2', title: 'Dentist', start: at(15), end: at(16) }], { calendarSync: { everyMs: 60_000 } });
    await saveAnchor(d.dir, anchorWith([block({ id: 'deep', start: '14:30', end: '16:00', title: 'Deep work' })]), NOW);
    await d.daemon.tick();
    expect(d.out).toEqual(['Heads up — your calendar has Dentist at 3–4pm, right on top of your Deep work block. Want me to move it?']);
    d.advance(2 * MIN);
    await d.daemon.tick();
    expect(d.out).toHaveLength(1);
  });

  it('a failing calendar is a reported problem, not a crash, and leaves your schedule alone', async () => {
    const d = await daemonWith(() => {
      throw new Error('offline');
    });
    await saveAnchor(d.dir, anchorWith([block({ id: 'deep', start: '15:00', end: '16:00', title: 'Deep work' })]), NOW);
    const r = await d.daemon.tick();
    expect(r.errors.some((e) => e.startsWith('calendar:') && e.includes('offline'))).toBe(true);
    expect((await loadAnchor(d.dir, NOW)).schedule.blocks.map((b) => b.id)).toEqual(['deep']);
  });

  it('calendarSync: false turns it off', async () => {
    const d = await daemonWith(() => [], { calendarSync: false });
    await d.daemon.tick();
    expect(d.cal.calls).toHaveLength(0);
  });
});

// ---------- 2. Proactive Day Planner ----------

const GOALS: Partial<Anchor> = {
  goals: [
    { id: 'blog', title: 'Draft the launch blog post', priority: 'medium', horizon: 'week', active: true },
    { id: 'deck', title: 'Finish the investor deck', priority: 'high', horizon: 'today', active: true },
    { id: 'old', title: 'Old goal', priority: 'high', horizon: 'today', active: false },
  ],
  projects: [{ id: 'garden', name: 'Garden shed', status: 'active', nextStep: 'order lumber' }],
};

describe('v17 day planner: open gaps', () => {
  it('starts from now (rounded up), skips planned blocks, and stops at lights-out', () => {
    const anchor = anchorWith([block({ id: 'cal-1', start: '15:00', end: '15:30', title: 'Call', kind: 'meeting', source: 'calendar' })], {
      boundaries: [{ id: 'lights', rule: 'Lights out', kind: 'protect_time', when: '22:00-07:00' }],
    });
    expect(openGaps(anchor, new Date(2026, 10, 25, 14, 7), { dayEnd: '23:00' })).toEqual([
      { start: '14:15', end: '15:00', minutes: 45 },
      { start: '15:30', end: '22:00', minutes: 390 },
    ]);
  });

  it('respects a Sabbath window: Friday evening and Saturday daytime are not plannable', () => {
    const anchor = anchorWith([], { boundaries: [{ id: 'sabbath', rule: 'Sabbath', kind: 'protect_time', when: 'fri 18:00 - sat 18:00' }] }, new Date(2026, 10, 27, 14));
    expect(openGaps(anchor, new Date(2026, 10, 27, 14, 0))).toEqual([{ start: '14:00', end: '18:00', minutes: 240 }]);
    const sat = { ...anchor, schedule: { date: '2026-11-28', blocks: [] } };
    expect(openGaps(sat, new Date(2026, 10, 28, 10, 0))).toEqual([{ start: '18:00', end: '21:00', minutes: 180 }]);
  });
});

describe('v17 day planner: proposeDayPlan', () => {
  it('proposes focus + breaks + one curated scroll slot, with zero overlaps, in priority order', async () => {
    const existing = [
      block({ id: 'cal-1', start: '15:30', end: '16:00', title: 'Call with Robin', kind: 'meeting', source: 'calendar' }),
      block({ id: 'dinner', start: '18:00', end: '19:00', title: 'Dinner', kind: 'personal', source: 'manual' }),
    ];
    const anchor = anchorWith(existing, GOALS);
    const plan = await proposeDayPlan({ anchor, now: NOW });
    expect(plan.via).toBe('code');
    expect(plan.gaps.map((g) => `${g.start}-${g.end}`)).toEqual(['14:00-15:30', '16:00-18:00', '19:00-21:00']);
    assertNoOverlaps(plan.blocks, existing);
    for (const b of plan.blocks) expect(plan.gaps.some((g) => toMinutes(g.start) <= toMinutes(b.start) && toMinutes(b.end) <= toMinutes(g.end))).toBe(true);
    const focus = plan.blocks.filter((b) => b.kind === 'focus');
    expect(focus[0]!.title).toBe('Finish the investor deck');
    expect(focus[1]!.title).toBe('Draft the launch blog post');
    expect(focus.some((b) => b.title === 'Garden shed: order lumber')).toBe(true);
    expect(focus.some((b) => b.title === 'Old goal')).toBe(false);
    expect(plan.blocks.filter((b) => b.kind === 'scroll')).toHaveLength(1);
    expect(plan.blocks.filter((b) => b.kind === 'break').length).toBeGreaterThan(0);
    for (const b of focus) expect(toMinutes(b.end) - toMinutes(b.start)).toBeLessThanOrEqual(120);
  });

  it('writes a short human summary: 12-hour times, a question, no tags', async () => {
    const anchor = anchorWith([block({ id: 'cal-1', start: '17:00', end: '21:00', title: 'Event', kind: 'meeting' })], GOALS);
    const plan = await proposeDayPlan({ anchor, now: NOW });
    expect(plan.blocks.map((b) => `${b.start}-${b.end} ${b.kind}`)).toEqual(['14:00-15:20 focus', '15:20-15:35 break', '15:35-17:00 focus']);
    expect(plan.summary).toBe("You've got open time from 2 to 5pm — want me to block 2–3:20pm for Finish the investor deck, a 15m break, and 3:35–5pm for Draft the launch blog post?");
    expect(plan.summary).not.toMatch(/\b(1[0-9]|2[0-3]):[0-5]\d\b/);
    expect(range12('11:00', '13:00')).toBe('11am–1pm');
  });

  it('plans nothing on a protected day or a full day, and says so kindly', async () => {
    const sunday = new Date(2026, 10, 29, 10, 0);
    const sabbath = anchorWith([], { ...GOALS, boundaries: [{ id: 'rest', rule: 'Rest day, sun', kind: 'protect_time', when: 'sun' }] }, sunday);
    const plan = await proposeDayPlan({ anchor: sabbath, now: sunday });
    expect(plan.blocks).toEqual([]);
    expect(plan.summary).toMatch(/nothing open/i);
    const full = anchorWith([block({ id: 'all', start: '08:00', end: '21:00', title: 'Conference', kind: 'meeting' })], GOALS);
    expect((await proposeDayPlan({ anchor: full, now: NOW })).blocks).toEqual([]);
  });

  it('uses the model plan only when every block fits; otherwise the code plan (and never throws)', async () => {
    const anchor = anchorWith([block({ id: 'cal-1', start: '16:00', end: '17:00', title: 'Call', kind: 'meeting' })], GOALS);
    const good = JSON.stringify({
      blocks: [
        { start: '14:00', end: '15:30', title: 'Investor deck', kind: 'focus' },
        { start: '15:30', end: '15:45', title: 'Break', kind: 'break' },
        { start: '17:15', end: '18:30', title: 'Blog post', kind: 'focus' },
      ],
      summary: 'Open from 2 to 4 and after 5 — deck 2–3:30pm, a quick break, then the blog 5:15–6:30pm?',
    });
    const ai = new FakeProvider([good]);
    const p1 = await proposeDayPlan({ anchor, now: NOW, ai, soul: 'I like mornings slow.' });
    expect(p1.via).toBe('ai');
    expect(p1.summary).toContain('deck 2–3:30pm');
    expect(ai.calls[0]!.messages[0]!.content).toContain('14:00-16:00');
    expect(ai.calls[0]!.messages[0]!.content).toContain('I like mornings slow.');

    const overlapping = JSON.stringify({ blocks: [{ start: '15:30', end: '16:30', title: 'Deck', kind: 'focus' }], summary: 'ok?' });
    const p2 = await proposeDayPlan({ anchor, now: NOW, ai: new FakeProvider([overlapping]) });
    expect(p2.via).toBe('code');
    assertNoOverlaps(p2.blocks, anchor.schedule.blocks);

    const p3 = await proposeDayPlan({ anchor, now: NOW, ai: new FakeProvider(['not json at all']) });
    expect(p3.via).toBe('code');
    const p4 = await proposeDayPlan({ anchor, now: NOW, ai: { complete: async () => Promise.reject(new Error('rate limited')) } });
    expect(p4.via).toBe('code');
    expect(p4.blocks.length).toBeGreaterThan(0);
  });

  it('codePlan never overlaps, whatever the gaps', () => {
    const gaps = [
      { start: '08:00', end: '08:40', minutes: 40 },
      { start: '09:00', end: '12:05', minutes: 185 },
      { start: '13:00', end: '13:20', minutes: 20 },
    ];
    const blocks = codePlan(gaps, ['A', 'B']);
    assertNoOverlaps(blocks);
    expect(blocks.every((b) => toMinutes(b.end) > toMinutes(b.start))).toBe(true);
    expect(blocks.some((b) => b.start === '13:00')).toBe(false); // too short to plan
  });

  it('never silently commits: proposing changes nothing; only a yes writes the blocks', async () => {
    const dir = await tempDir();
    await saveAnchor(dir, anchorWith([block({ id: 'cal-1', start: '17:00', end: '21:00', title: 'Event', kind: 'meeting', source: 'calendar' })], GOALS), NOW);
    const raw = await readFile(path.join(dir, 'anchor.json'), 'utf8');
    const plan = await proposeDayPlan({ anchor: await loadAnchor(dir, NOW), now: NOW });
    expect(await readFile(path.join(dir, 'anchor.json'), 'utf8')).toBe(raw);

    await savePendingPlan(dir, plan, NOW);
    expect(await readFile(path.join(dir, 'anchor.json'), 'utf8')).toBe(raw);
    expect(await loadPendingPlan(dir, new Date(NOW.getTime() + 4 * 3_600_000))).toBeUndefined(); // stale after 3h

    const done = await commitPendingPlan(dir, new Date(NOW.getTime() + MIN));
    expect(done!.text).toBe("Done — it's on the schedule: 2–3:20pm Finish the investor deck and 3:35–5pm Draft the launch blog post.");
    const after = await loadAnchor(dir, NOW);
    expect(after.schedule.blocks.filter((b) => b.source === 'rufus').map((b) => `${b.start}-${b.end} ${b.kind}`)).toEqual(['14:00-15:20 focus', '15:20-15:35 break', '15:35-17:00 focus']);
    expect(after.schedule.blocks.find((b) => b.id === 'cal-1')).toBeDefined();
    expect(await loadPendingPlan(dir, NOW)).toBeUndefined();
    expect(await commitPendingPlan(dir, NOW)).toBeUndefined(); // a second yes does nothing
  });

  it('a block that got taken since the proposal is skipped, not double-booked', async () => {
    const dir = await tempDir();
    await saveAnchor(dir, anchorWith([], GOALS), NOW);
    const plan: DayPlan = { date: '2026-11-25', gaps: [], via: 'code', summary: 'x?', blocks: [{ start: '14:00', end: '15:00', title: 'Deck', kind: 'focus' }, { start: '15:15', end: '16:00', title: 'Blog', kind: 'focus' }] };
    await savePendingPlan(dir, plan, NOW);
    await saveAnchor(dir, anchorWith([block({ id: 'cal-x', start: '14:30', end: '15:00', title: 'Surprise call', kind: 'meeting', source: 'calendar' })], GOALS), NOW);
    const done = await commitPendingPlan(dir, NOW);
    expect(done!.added.map((b) => b.title)).toEqual(['Blog']);
    expect(done!.skipped.map((b) => b.title)).toEqual(['Deck']);
    expect(done!.text).toContain('Skipped 1');
  });

  it('anchor.update {op:"apply_plan"} writes the pending plan, and refuses when there is none', async () => {
    const dir = await tempDir();
    await saveAnchor(dir, anchorWith([], GOALS), NOW);
    const tool = anchorUpdateTool();
    await expect(Promise.resolve(tool.execute({ op: 'apply_plan' }, { dir, now: NOW }))).rejects.toThrow(/no day plan/i);
    await savePendingPlan(dir, { date: '2026-11-25', gaps: [], via: 'code', summary: 'x?', blocks: [{ start: '14:00', end: '15:00', title: 'Deck', kind: 'focus' }] }, NOW);
    const r = await tool.execute({ op: 'apply_plan' }, { dir, now: NOW });
    expect(r.today).toEqual(['14:00-15:00 focus Deck']);
  });
});

describe('v17 day planner from chat', () => {
  async function chiefSetup(ai: (req: AiRequest) => string = () => 'not json') {
    const dir = await tempDir();
    const calls: AiRequest[] = [];
    const engine = new Engine({ store: dir, provider: new FakeProvider((req) => (calls.push(req), ai(req))) });
    const chief = new ChiefOfStaff({ engine, now: () => NOW });
    await saveAnchor(dir, anchorWith([block({ id: 'cal-1', start: '17:00', end: '21:00', title: 'Event', kind: 'meeting', source: 'calendar' })], GOALS), NOW);
    return { dir, chief, calls };
  }

  it('"plan my day" proposes, "yes" writes it', async () => {
    const { dir, chief, calls } = await chiefSetup();
    const raw = await readFile(path.join(dir, 'anchor.json'), 'utf8');
    const r = await chief.handle('plan my day');
    expect(r.via).toBe('command');
    expect(r.text).toMatch(/^You've got open time from 2 to 5pm — want me to block .*\?$/);
    expect(calls.map((c) => c.meta.flowId)).toEqual(['planner']); // one planning call; it fell back to code
    expect(await readFile(path.join(dir, 'anchor.json'), 'utf8')).toBe(raw);
    expect(await loadPendingPlan(dir, NOW)).toBeDefined();

    const yes = await chief.handle('yes');
    expect(yes.text).toMatch(/^Done — it's on the schedule/);
    expect((await loadAnchor(dir, NOW)).schedule.blocks.filter((b) => b.source === 'rufus')).toHaveLength(3);
  });

  it.each(['schedule the rest of today', 'Can you plan the rest of my day?', 'plan my afternoon'])('%j is a plan request', async (text) => {
    const { chief } = await chiefSetup();
    expect(chief.isCommand(text)).toBe(true);
    expect((await chief.handle(text)).text).toContain('want me to block');
  });

  it('"no" drops the proposal; without a proposal, "yes" is just chat', async () => {
    const { dir, chief, calls } = await chiefSetup((req) => (req.meta.flowId === 'chief' ? 'REACT: 👍' : 'nope'));
    await chief.handle('plan my day');
    const no = await chief.handle('nah');
    expect(no.text).toMatch(/leave that time open/);
    expect(await loadPendingPlan(dir, NOW)).toBeUndefined();
    expect((await loadAnchor(dir, NOW)).schedule.blocks.filter((b) => b.source === 'rufus')).toHaveLength(0);
    const yes = await chief.handle('yes');
    expect(yes.via).toBe('chat');
    expect(calls.at(-1)!.meta.flowId).toBe('chief');
  });
});

describe('v17 day planner in the daemon (proactive, never silent commits)', () => {
  async function setup(opts: { planner?: Record<string, unknown> } = {}) {
    const dir = await tempDir();
    let t = NOW;
    const clock = () => t;
    const chat = new Chat(clock);
    const sends: Array<Record<string, unknown>> = [];
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'Got it.') });
    const loopAi = new FakeProvider((req) => (/Triage this/.test(String(req.messages[0]!.content)) ? '{"label":"batch","reason":"a question"}' : '{"reply":"Yes, see you at 7."}'));
    const send: ToolDefinition = { name: 'beeper.send', description: 'Send.', sensitivity: ['external'], execute: (args) => (sends.push(args), { ok: true }) };
    const loop = new MasterLoop({ dir, sensors: [inboxSensor(dir)], handlers: [messageTriageHandler()], tools: new ToolRegistry({ tools: [send] }), providers: { fast: loopAi }, now: clock });
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, chief: new ChiefOfStaff({ engine, loop, now: clock }), heartbeat: false, bubblePauseMs: 0, planner: { ...opts.planner }, now: clock });
    await saveAnchor(dir, anchorWith([block({ id: 'cal-1', start: '17:00', end: '21:00', title: 'Event', kind: 'meeting', source: 'calendar' })], GOALS), NOW);
    return { dir, chat, daemon, sends, advance: (ms: number) => void (t = new Date(t.getTime() + ms)) };
  }

  it('offers a plan once a day and writes nothing until yes', async () => {
    const s = await setup();
    const raw = await readFile(path.join(s.dir, 'anchor.json'), 'utf8');
    const r = await s.daemon.tick();
    expect(r.planned).toMatch(/want me to block/);
    expect(s.chat.sent).toEqual([r.planned]);
    expect(await readFile(path.join(s.dir, 'anchor.json'), 'utf8')).toBe(raw);
    s.advance(10 * MIN);
    expect((await s.daemon.tick()).planned).toBeUndefined();
    expect(s.chat.sent).toHaveLength(1);

    s.chat.human('sounds good');
    await s.daemon.tick();
    expect(s.chat.sent.at(-1)).toMatch(/^Done — it's on the schedule/);
    expect((await loadAnchor(s.dir, NOW)).schedule.blocks.filter((b) => b.source === 'rufus').length).toBeGreaterThan(0);
  });

  it('stays quiet outside its window and when the day is mostly booked', async () => {
    const s = await setup({ planner: { window: '09:00-12:00' } });
    expect((await s.daemon.tick()).planned).toBeUndefined();
    const t = await setup({ planner: { minOpenMinutes: 240 } });
    expect((await t.daemon.tick()).planned).toBeUndefined();
    expect(t.chat.sent).toEqual([]);
  });

  it('a bare "yes" while both a plan and a send wait never sends: it asks which', async () => {
    const s = await setup({ planner: { window: '00:00-00:01' } });
    await appendSignal(s.dir, { surface: 'chat', kind: 'message.received', text: 'Dinner at 7?', actor: 'Robin', urgency: 'urgent', data: { chatId: 'c-robin' } }, new Date(NOW.getTime() + 1000));
    await s.daemon.tick();
    expect(s.chat.sent.at(-1)).toContain('Robin');
    await savePendingPlan(s.dir, await proposeDayPlan({ anchor: await loadAnchor(s.dir, NOW), now: NOW }), NOW);
    s.chat.human('yes');
    await s.daemon.tick();
    expect(s.sends).toEqual([]);
    expect(s.chat.sent.at(-1)).toMatch(/Did you mean the plan or #1\? Reply "plan yes"/);
    s.chat.human('plan yes');
    await s.daemon.tick();
    expect(s.sends).toEqual([]);
    expect(s.chat.sent.at(-1)).toMatch(/^Done — it's on the schedule/);
  });
});

// ---------- 3. Curated Research / Break Digest ----------

const visit = (url: string, title: string, visits = 1, hoursAgo = 2): CorpusItem => {
  const u = new URL(url);
  return {
    id: `browser_${createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
    source: 'browser',
    kind: 'visit',
    title,
    summary: `${title} (${u.hostname}${u.pathname}) · ${visits} visits`,
    domain: u.hostname.replace(/^www\./, ''),
    timestamp: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    metadata: { url, visitCount: visits },
  };
};

const HISTORY: CorpusItem[] = [
  visit('https://accounts.google.com/signin/v2', 'Sign in - Google Accounts', 9),
  visit('https://www.google.com/search', 'investor deck tips - Google Search', 6),
  visit('https://mail.google.com/mail/u/0', 'Inbox (3)', 20),
  visit('https://www.instagram.com/explore', 'Instagram', 15),
  visit('https://x.com/home', 'Home / X', 30),
  visit('https://www.reddit.com', 'reddit: the front page', 12),
  visit('https://example.com/login', 'Log in to Example', 4),
  visit('https://docs.example.org/guides/pitch-deck-structure', 'How to structure an investor pitch deck - Guide', 3, 5),
  visit('https://blog.example.net/posts/writing-launch-posts', 'Writing launch blog posts that people read', 1, 20),
  visit('https://github.com/acme/widget', 'acme/widget: a tiny widget library', 4, 10),
  visit('https://news.example.com/random-story', 'A random story', 1, 3),
  visit('https://old.example.com/deck-history', 'Deck history archive', 5, 24 * 10),
];

describe('v17 break digest', () => {
  it('filters login, search, inbox and feed pages', () => {
    const noisy = HISTORY.filter(isNoisePage).map((i) => i.domain);
    expect(noisy).toEqual(['accounts.google.com', 'google.com', 'mail.google.com', 'instagram.com', 'x.com', 'reddit.com', 'example.com']);
    expect(isNoisePage(visit('https://www.youtube.com/watch', 'A talk on pitch decks'))).toBe(false);
    expect(isNoisePage(visit('https://www.youtube.com/', 'YouTube'))).toBe(true);
    expect(isNoisePage(visit('https://x.com/someone/status/1', 'A thread about decks'))).toBe(false);
  });

  it('ranks what ties into active goals first, keeps revisited pages, drops lone unrelated and old visits', () => {
    const topics = digestCandidates(HISTORY, anchorWith([], GOALS), NOW);
    expect(topics.map((t) => t.title)).toEqual(['How to structure an investor pitch deck', 'Writing launch blog posts that people read', 'acme/widget']);
    expect(topics[0]!.ties).toContain('Finish the investor deck');
    expect(topics[2]!.ties).toEqual([]);
  });

  it('builds a crisp 2-3 bullet digest from the workspace corpus (code, $0)', async () => {
    const dir = await tempDir();
    await new CorpusStore(path.join(dir, 'corpus', 'items.jsonl')).add(HISTORY);
    await saveAnchor(dir, anchorWith([], GOALS), NOW);
    const d = await buildBreakDigest({ dir, now: NOW });
    expect(d.via).toBe('code');
    expect(d.bullets).toHaveLength(3);
    expect(d.text).toBe(
      [
        'Worth a look on your break:',
        '• How to structure an investor pitch deck (docs.example.org) — ties into Finish the investor deck',
        '• Writing launch blog posts that people read (blog.example.net) — ties into Draft the launch blog post',
        '• acme/widget (github.com) — you came back to it 4 times',
      ].join('\n'),
    );
    expect(d.text).not.toMatch(/instagram|x\.com|reddit|Sign in|Inbox/i);
  });

  it('handles an empty history (or only noise) cleanly, without a model call', async () => {
    const dir = await tempDir();
    const ai = new FakeProvider([]);
    const d = await buildBreakDigest({ dir, now: NOW, ai });
    expect(d).toEqual({ bullets: [], topics: [], text: EMPTY_DIGEST, via: 'empty' });
    const noiseOnly = await buildBreakDigest({ dir, now: NOW, ai, items: HISTORY.filter(isNoisePage) });
    expect(noiseOnly.via).toBe('empty');
    expect(ai.calls).toHaveLength(0);
  });

  it('uses model bullets when they are crisp, code bullets when it rambles or fails', async () => {
    const anchor = anchorWith([], GOALS);
    const ai = new FakeProvider(['• Pitch deck structure guide — straight input for today\'s deck\n• Launch post piece — good angle for the blog draft']);
    const d = await buildBreakDigest({ dir: await tempDir(), anchor, now: NOW, ai, items: HISTORY });
    expect(d.via).toBe('ai');
    expect(d.bullets).toEqual(["Pitch deck structure guide — straight input for today's deck", 'Launch post piece — good angle for the blog draft']);
    expect(ai.calls[0]!.messages[0]!.content).not.toMatch(/instagram|Sign in/i);

    const rambling = await buildBreakDigest({ dir: await tempDir(), anchor, now: NOW, ai: new FakeProvider(['Sure! Here are some great reads for you:\n• one\n• two']), items: HISTORY });
    expect(rambling.via).toBe('code');
    const failing = await buildBreakDigest({ dir: await tempDir(), anchor, now: NOW, ai: { complete: () => Promise.reject(new Error('down')) }, items: HISTORY });
    expect(failing.via).toBe('code');
  });

  it('is callable from chat ("break digest", "what\'s interesting?")', async () => {
    const dir = await tempDir();
    await new CorpusStore(path.join(dir, 'corpus', 'items.jsonl')).add(HISTORY);
    await saveAnchor(dir, anchorWith([], GOALS), NOW);
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'not bullets') });
    const chief = new ChiefOfStaff({ engine, now: () => NOW });
    for (const text of ['break digest', "what's interesting?", 'give me a digest']) {
      const r = await chief.handle(text);
      expect(r.via).toBe('command');
      expect(r.text).toMatch(/^Worth a look on your break:\n• How to structure an investor pitch deck/);
    }
    expect(chief.isCommand('what is the weather')).toBe(false);
  });

  it('arrives once at the start of a scheduled scroll block (when enabled)', async () => {
    const dir = await tempDir();
    let t = new Date(2026, 10, 25, 15, 32);
    const out: string[] = [];
    await new CorpusStore(path.join(dir, 'corpus', 'items.jsonl')).add(HISTORY);
    await saveAnchor(dir, anchorWith([block({ id: 'scroll', start: '15:30', end: '15:45', title: 'Curated scroll', kind: 'scroll', source: 'rufus' })], GOALS), NOW);
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'SILENT') });
    const loop = new MasterLoop({ dir, now: () => t });
    const daemon = new UnifiedDaemon({ loop, engine, chief: false, heartbeat: false, breakDigest: {}, output: (s) => out.push(s), now: () => t });
    const r = await daemon.tick();
    expect(r.digest).toMatch(/^Worth a look on your break/);
    t = new Date(t.getTime() + 2 * MIN);
    await daemon.tick();
    expect(out).toHaveLength(1);
    // Off by default.
    const quiet: string[] = [];
    const plain = new UnifiedDaemon({ loop, engine, chief: false, heartbeat: false, output: (s) => quiet.push(s), now: () => t });
    await plain.tick();
    expect(quiet).toEqual([]);
  });
});

describe('v17 day plan file', () => {
  it('lives at <workspace>/day-plan.json', async () => {
    const dir = await tempDir();
    expect(dayPlanFile(dir)).toBe(path.join(dir, 'day-plan.json'));
  });
});
