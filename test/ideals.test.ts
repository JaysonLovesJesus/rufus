import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeHistory,
  buildContactProfiles,
  buildSituationalContext,
  checksForRule,
  detectLessonDrift,
  formatAnalysis,
  idealConstraints,
  rankWeights,
  recencyWeight,
  styleOf,
  type HistoryPair,
} from '../src';
import { main } from '../src/cli';
import { pairWeigher } from '../src/history/profiles';
import { tempDir } from './helpers';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const DAY = 86_400_000;
const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

let n = 0;
const pair = (reply: string, daysAgo: number | undefined, over: Partial<HistoryPair> = {}): HistoryPair => ({
  id: `p${++n}`,
  channel: 'sms',
  sender: ['Sam Rivera', 'Alex Chen', 'Priya Patel', 'Jordan Lee', 'Casey Kim', 'Morgan Diaz'][n % 6]!,
  incoming: 'are we still on for thursday?',
  reply,
  ...(daysAgo !== undefined ? { incomingAt: at(daysAgo), replyAt: at(daysAgo) } : {}),
  ...over,
});

const incoming = { channel: 'sms', sender: 'Sam Rivera', isGroup: false, incoming: 'are we still on for thursday?', gapSincePreviousMs: 5 * 60 * 1000 } as const;

/** A history of curt, greeting-free replies. */
const curt = (count: number, from = 400): HistoryPair[] => Array.from({ length: count }, (_, i) => pair('yep, thursday works', from - i));

describe('recency weighting', () => {
  it('weights halve every half-life; undated and future items count fully; no half-life turns it off', () => {
    expect(recencyWeight(at(0), NOW, 90)).toBe(1);
    expect(recencyWeight(at(90), NOW, 90)).toBeCloseTo(0.5);
    expect(recencyWeight(at(180), NOW, 90)).toBeCloseTo(0.25);
    expect(recencyWeight(undefined, NOW, 90)).toBe(1);
    expect(recencyWeight(new Date(NOW + 5 * DAY), NOW, 90)).toBe(1);
    expect(recencyWeight(at(900), NOW, undefined)).toBe(1);
  });

  it('rank weights count observations, not days: the Nth newest weighs half, whether it took two days or two months', () => {
    const tight = rankWeights([at(0.04), at(0.03), at(0.02), at(0.01), at(0)], 2);
    const spread = rankWeights([at(200), at(150), at(100), at(50), at(0)], 2);
    expect(tight).toEqual(spread);
    expect(tight[4]).toBe(1);
    expect(tight[2]).toBeCloseTo(0.5);
    expect(rankWeights([undefined, at(1)], 1)).toEqual([0.5, 1]);
  });

  it('a recency-weighted style follows your recent habit, not a two-year-old one', () => {
    const old = Array.from({ length: 40 }, (_, i) => pair(`Hi! Thanks so much for checking in, that works for me this week and I will see you then! ${i}`, 700 - i));
    const recent = Array.from({ length: 10 }, (_, i) => pair('works', 10 - i));
    const all = [...old, ...recent];
    const flat = styleOf(all);
    const weighted = styleOf(all, pairWeigher(all, { now: NOW, halfLifeDays: 90 }));
    expect(flat.greetingRate).toBe(0.8);
    expect(weighted.greetingRate).toBeLessThan(0.1);
    expect(weighted.medianWords).toBe(1);
    expect(flat.medianWords).toBeGreaterThan(10);
    expect(weighted.count).toBe(50); // evidence gates still count real replies
    expect(weighted.effectiveCount).toBeLessThan(15);
    expect(styleOf(all, pairWeigher(all, { now: NOW, halfLifeDays: 0 }))).toEqual(flat); // off = exact old arithmetic
    expect(flat.effectiveCount).toBeUndefined();
  });

  it('feeds profiles and the situational lookup, with 180 days as the default half-life', () => {
    const old = Array.from({ length: 30 }, (_, i) => pair('Hello! Sounds good, thanks so much for letting me know about the plan for this week.', 500 - i, { sender: 'Sam Rivera' }));
    const recent = Array.from({ length: 6 }, (_, i) => pair('ok', 5 - i, { sender: 'Sam Rivera' }));
    const all = [...old, ...recent];
    const defaulted = buildContactProfiles(all, { now: NOW });
    const off = buildContactProfiles(all, { now: NOW, halfLifeDays: 0 });
    expect(defaulted.contacts[0]!.style.medianWords).toBeLessThan(off.contacts[0]!.style.medianWords);
    expect(defaulted.contacts[0]!.style.medianWords).toBeLessThanOrEqual(3);
    const ctx = buildSituationalContext(incoming, all, { now: NOW });
    expect(ctx.style!.medianWords).toBeLessThanOrEqual(3);
    expect(ctx.voiceHint).not.toContain('Ideals');
    const flat = buildSituationalContext(incoming, all, { now: NOW, halfLifeDays: 0 });
    expect(flat.style!.medianWords).toBeGreaterThan(10);
    const ranked = buildSituationalContext(incoming, all, { halfLifeObservations: 3 });
    expect(ranked.style!.medianWords).toBeLessThanOrEqual(3);
  });

  it('analyzeHistory reports how you are evolving', () => {
    const old = Array.from({ length: 80 }, (_, i) => pair('no worries, see you then', 600 - i));
    const recent = Array.from({ length: 20 }, (_, i) => pair(`Hi! Great news, see you then! ${i}`, 20 - i * 0.5));
    const a = analyzeHistory([...old, ...recent], { now: NOW });
    expect(a.recency).toBeDefined();
    expect(a.recency!.basis).toBe('half-life 180 days');
    expect(a.recency!.weighted.exclamationRate).toBeGreaterThan(a.recency!.allTime.exclamationRate);
    expect(a.recency!.evolution.join(' ')).toMatch(/Exclamation rate: .* lately vs .* over all history \(up\)/);
    expect(formatAnalysis(a).join('\n')).toContain('Recency-weighted (half-life 180 days');
    expect(analyzeHistory([...old, ...recent], { now: NOW, halfLifeDays: 0 }).recency).toBeUndefined();
    expect(analyzeHistory([...old, ...recent], { now: NOW, halfLifeObservations: 10 }).recency!.basis).toBe('rank half-life 10 replies');
  });

  it('demotes an "invariant" that held for years but not in your latest replies', () => {
    const old = Array.from({ length: 150 }, (_, i) => pair('no worries, see you then', 600 - i));
    const recent = Array.from({ length: 48 }, (_, i) => pair(i < 2 ? `see you then — thanks ${i}` : `see you then ${i}`, 30 - i * 0.5));
    const history = [...old, ...recent]; // 2 em dashes in 198 replies: 99%, a raw invariant
    expect(analyzeHistory(history, { now: NOW, halfLifeDays: 0 }).invariants.map((r) => r.id)).toContain('no-em-dash');
    const a = analyzeHistory(history, { now: NOW });
    expect(a.invariants.map((r) => r.id)).not.toContain('no-em-dash'); // 2 of the latest 60 broke it
    expect(a.recency!.demotedInvariants).toContain('Do not use em dashes.');
    expect(a.notes.join(' ')).toContain('held across all history but not in your latest 60 replies');
    const clean = analyzeHistory([...old, ...Array.from({ length: 48 }, (_, i) => pair(`see you then ${i}`, 30 - i * 0.5))], { now: NOW });
    expect(clean.invariants.map((r) => r.id)).toContain('no-em-dash'); // still true lately: stays a wall
  });
});

describe('ideals override habits (explicitLessons)', () => {
  const history = curt(40); // you never greet, replies are 3 words

  it('labels ideals above the descriptive baseline in voiceHint, and an ideal wins over a habit', () => {
    const base = buildSituationalContext(incoming, history, { now: NOW });
    expect(base.greetHint).toBe('skip');
    expect(base.voiceHint).not.toContain('Ideals');

    const ctx = buildSituationalContext(incoming, history, { now: NOW, explicitLessons: ['Always open with a warm greeting.'] });
    const lines = ctx.voiceHint.split('\n');
    expect(lines[0]).toBe('Ideals (override history): Always open with a warm greeting.');
    expect(ctx.drift).toHaveLength(1); // an aspiration you never lived up to: flagged for you to confirm, still applied
    expect(lines[1]).toMatch(/^Historical habits \(descriptive baseline, recency-weighted\): /);
    expect(lines[2]).toMatch(/^Decision \(ideals applied\): greeting: ideal "Always open with a warm greeting\." → greet \(history alone said skip/);
    expect(ctx.greetHint).toBe('greet'); // the sloppy habit does not win
    expect(ctx.idealOverrides).toEqual([{ aspect: 'greeting', habit: 'skip', ideal: 'greet', rule: 'Always open with a warm greeting.' }]);
    expect(ctx.ideals).toEqual(['Always open with a warm greeting.']);
    expect(ctx.voiceHint.indexOf('Ideals')).toBeLessThan(ctx.voiceHint.indexOf('Historical habits'));
  });

  it('accepts saved Lesson objects, caps length by an ideal word limit, and ignores conditional or conflicting lessons', () => {
    const wordy = Array.from({ length: 40 }, (_, i) => pair('Thanks for the note. I reviewed everything you sent over carefully and I think the plan looks solid overall, so let us go ahead and proceed as discussed earlier this week.', 300 - i));
    const longAsk = { ...incoming, incoming: 'Can you confirm Thursday? Also, which room is it? And who else is coming? One more thing: do we need to bring anything?' };
    const habit = buildSituationalContext(longAsk, wordy, { now: NOW });
    expect(habit.lengthBand).toBe('detailed');
    const ideal = buildSituationalContext(longAsk, wordy, { now: NOW, explicitLessons: [{ id: 'l_1', rule: 'Keep replies to at most 15 words.', updatedAt: at(1) }] });
    expect(ideal.lengthBand).toBe('brief');
    expect(ideal.approxWords).toBe(15);
    expect(ideal.idealOverrides.map((o) => o.aspect)).toEqual(['length']);
    expect(ideal.lengthReason).toContain('ideal "Keep replies to at most 15 words." caps it at 15 words');

    const conditional = buildSituationalContext(incoming, history, { now: NOW, explicitLessons: ['Only greet people in group chats.'] });
    expect(conditional.greetHint).toBe('skip'); // branching logic is not a wall
    expect(conditional.ideals).toEqual(['Only greet people in group chats.']);
    expect(conditional.idealOverrides).toEqual([]);
    const conflict = buildSituationalContext(incoming, history, { now: NOW, explicitLessons: ['Always greet.', 'Skip the greeting.'] });
    expect(conflict.idealOverrides).toEqual([]);
    expect(idealConstraints(['Do not use emoji.'])).toEqual({ from: {} });
  });

  it('reads the claims in a rule: greetings, em dashes, exclamations, emoji, sign-offs, periods, lowercase, word caps', () => {
    const ids = (rule: string): string[] => checksForRule(rule).map((c) => c.id);
    expect(ids('Never start with a greeting.')).toEqual(['no-greeting']);
    expect(ids('Always greet them by name.')).toEqual(['greeting']);
    expect(ids('Do not use em dashes.')).toEqual(['no-em-dash']);
    expect(ids('No exclamation marks, and no emoji.').sort()).toEqual(['no-emoji', 'no-exclamation']);
    expect(ids('Skip the sign-off.')).toEqual(['no-sign-off']);
    expect(ids('Do not end a reply with a period.')).toEqual(['no-trailing-period']);
    expect(ids('Start replies with a lowercase letter.')).toEqual(['lowercase-start']);
    expect(checksForRule('Keep replies to at most 12 words.')[0]).toMatchObject({ id: 'word-cap', maxWords: 12 });
    expect(checksForRule('Keep replies under 12 words.')[0]).toMatchObject({ maxWords: 11 });
    expect(checksForRule('Be warm and kind.')).toEqual([]); // taste, not measurable
    expect(checksForRule('No em dashes unless quoting someone.')).toEqual([]); // conditional
    expect(checksForRule('Do not use em dashes.')[0]!.violates('fine — really')).toBe(true);
  });
});

describe('lesson drift: ideals are surfaced, not enforced forever', () => {
  const rule = 'Do not use em dashes.';

  it('flags a saved lesson that the latest replies keep contradicting, and asks what to do', () => {
    const history = [...Array.from({ length: 60 }, (_, i) => pair('works for me', 300 - i)), ...Array.from({ length: 10 }, (_, i) => pair(`works — see you then ${i}`, 10 - i))];
    const drift = detectLessonDrift([{ id: 'l_7', rule }], history);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ lessonId: 'l_7', rule, check: 'no-em-dash', recent: { violations: 10, of: 15, rate: 0.667 }, allTime: { violations: 10, of: 70 } });
    expect(drift[0]!.message).toBe(`Saved lesson "${rule}" disagrees with 10/15 of your latest replies (67%; 14% of all history). Keep it as an aspiration, refine it into conditional logic, or retire it?`);
  });

  it('does not flag a lesson your recent replies still honor, or one with too few samples; hardened lessons are skipped', () => {
    const honoring = [...Array.from({ length: 5 }, (_, i) => pair(`works — fine ${i}`, 400 - i)), ...Array.from({ length: 15 }, (_, i) => pair(`works ${i}`, 20 - i))];
    expect(detectLessonDrift([rule], honoring)).toEqual([]); // old slips do not count: only the latest 15
    expect(detectLessonDrift([rule], Array.from({ length: 4 }, (_, i) => pair('a — b', 4 - i)))).toEqual([]); // 4 < minSamples 5
    const broken = Array.from({ length: 12 }, (_, i) => pair('a — b', 12 - i));
    expect(detectLessonDrift([{ rule, hardened: true }], broken)).toEqual([]);
    expect(detectLessonDrift([rule], broken)).toHaveLength(1);
    expect(detectLessonDrift(['Be kind.'], broken)).toEqual([]);
  });

  it('judges the last N observations, not calendar days: a shift within 24 hours shows up at once', () => {
    const hour = (h: number): string => new Date(NOW - h * 3600_000).toISOString();
    const quiet = Array.from({ length: 30 }, (_, i) => pair('works', 200 - i * 3));
    const burst = Array.from({ length: 8 }, (_, i) => ({ ...pair(`works — ${i}`, undefined), replyAt: hour(8 - i), incomingAt: hour(8 - i) }));
    const d = detectLessonDrift([rule], [...quiet, ...burst]);
    expect(d).toHaveLength(1);
    expect(d[0]!.recent).toMatchObject({ violations: 8, of: 15 });
    // Same replies, years apart on a slow channel: still the last 15 observations.
    const slow = [...Array.from({ length: 30 }, (_, i) => pair('works', 1500 - i * 20)), ...Array.from({ length: 8 }, (_, i) => pair(`works — ${i}`, 400 - i * 30))];
    expect(detectLessonDrift([rule], slow)[0]!.recent).toMatchObject({ violations: 8, of: 15 });
    // The window and thresholds are configurable.
    expect(detectLessonDrift([rule], [...quiet, ...burst], { windowSize: 8, minRate: 0.9 })[0]!.recent).toMatchObject({ violations: 8, of: 8 });
    expect(detectLessonDrift([rule], [...quiet, ...burst], { windowSize: 30, minRate: 0.5 })).toEqual([]);
  });

  it('appears in mine output and on the situational context, while the ideal still applies', () => {
    const history = [...Array.from({ length: 60 }, (_, i) => pair('works for me', 300 - i)), ...Array.from({ length: 10 }, (_, i) => pair(`works — see you then ${i}`, 10 - i))];
    const a = analyzeHistory(history, { now: NOW, lessons: [{ rule }] });
    expect(a.drift).toHaveLength(1);
    const text = formatAnalysis(a).join('\n');
    expect(text).toContain('Tension / drift');
    expect(text).toContain('[drift] Saved lesson "Do not use em dashes." disagrees with 10/15');
    expect(analyzeHistory(history, { now: NOW }).drift).toEqual([]);
    expect(formatAnalysis(analyzeHistory(history, { now: NOW })).join('\n')).not.toContain('Tension / drift');

    const ctx = buildSituationalContext(incoming, history, { now: NOW, explicitLessons: [rule] });
    expect(ctx.drift).toHaveLength(1);
    expect(ctx.voiceHint.split('\n')[0]).toBe(`Ideals (override history): ${rule}`); // the ideal still applies; the question is for you, not the drafting model
    expect(ctx.drift[0]!.message).toContain('retire it?');
  });
});

describe('rufus mine surfaces drift from saved lessons', () => {
  it('reads lessons.json and prints the tension, without touching the lesson', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'history'), { recursive: true });
    const history = [...Array.from({ length: 60 }, (_, i) => pair('works for me', 300 - i)), ...Array.from({ length: 10 }, (_, i) => pair(`works — see you then ${i}`, 10 - i))];
    await writeFile(path.join(dir, 'history', 'pairs.jsonl'), history.map((p) => JSON.stringify(p)).join('\n') + '\n');
    const lesson = { id: 'l_1', scope: 'global', rule: 'Do not use em dashes.', layer: 'principle', count: 1, sourceRunIds: [], hardened: false, createdAt: at(30), updatedAt: at(30) };
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'lessons.json'), JSON.stringify({ version: 1, lessons: [lesson] }));
    const lines: string[] = [];
    await main(['--dir', dir, 'mine'], { out: (l) => void lines.push(l), err: (l) => void lines.push(l) });
    const text = lines.join('\n');
    expect(text).toContain('Tension / drift');
    expect(text).toContain('Keep it as an aspiration, refine it into conditional logic, or retire it?');
    expect(text).toContain('Recency-weighted (half-life 180 days');
    const saved = JSON.parse(await readFile(path.join(dir, 'lessons.json'), 'utf8')) as { lessons: unknown[] };
    expect(saved.lessons).toHaveLength(1);
  });
});
