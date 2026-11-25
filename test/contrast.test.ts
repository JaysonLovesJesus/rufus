import { describe, expect, it } from 'vitest';
import { analyzeHistory, buildSituationalContext, conditionalAnalysis, formatAnalysis, incomingFeatures, questionCount, type HistoryPair } from '../src';
import { tierBySender } from '../src/history/profiles';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NAMES = ['Sam Rivera', 'Alex Chen', 'Priya Patel', 'Jordan Lee', 'Casey Morgan', 'Taylor Quinn', 'Riley Brooks', 'Devon Hart', 'Morgan Ellis', 'Avery Cole', 'Jamie Fox', 'Skyler Reed'];
const FILLER = 'here is the long version of what i wanted to say about the plan for the week and the rest of it';
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const longIncoming = (i: number): boolean => i % 10 === 3;
const multiQ = (i: number): boolean => i % 14 === 5;

// 685 synthetic replies. Exactly 35 greet (15 of 118 on cold restarts, 4 of 347 in live chat, 16 of 220 same-day);
// 20 of the 40 incoming greetings are answered with one (15 of the other 645 are). Exactly 2 contain an em dash.
function corpus(): HistoryPair[] {
  const greetReply = new Set([...range(0, 14), ...range(118, 121), ...range(465, 480)]);
  const theyGreet = new Set([...range(0, 11), ...range(20, 27), 118, 119, ...range(130, 133), ...range(465, 470), ...range(490, 497)]);
  return range(0, 684).map((i) => {
    const gap = i < 118 ? 2 * DAY : i < 465 ? 3 * MIN : 3 * HOUR;
    const parts: string[] = [];
    if (theyGreet.has(i)) parts.push('hey there,');
    parts.push(multiQ(i) ? 'can you send it? and when are you free? also where do we meet?' : 'can you send the file');
    if (longIncoming(i)) parts.push(`${FILLER} and some more words to make it longer still ok`);
    const isLong = !greetReply.has(i) && ((longIncoming(i) && i % 3 !== 0) || (multiQ(i) && !longIncoming(i)) || i % 97 === 0);
    const veryLong = isLong && Math.floor(i / 10) % 4 === 0; // enough >100-word replies that no sane cap fits 98%
    let reply = greetReply.has(i) ? 'hey, sounds good' : 'ok will do';
    if (isLong) reply = veryLong ? `${FILLER} `.repeat(7).trim() : `${FILLER} ${FILLER}`;
    if (i === 100 || i === 300) reply = 'ok — sounds good';
    return {
      id: `p${i}`,
      channel: 'whatsapp',
      sender: NAMES[i % NAMES.length]!,
      incoming: parts.join(' '),
      reply,
      incomingAt: new Date(Date.UTC(2025, 0, 1) + i * 3 * HOUR).toISOString(),
      isGroup: false,
      gapSincePreviousMs: gap,
    };
  });
}

const rule = (a: ReturnType<typeof analyzeHistory>, id: string) => a.conditionalRules.find((r) => r.behavior === id);

describe('invariants vs. contrastive conditional logic', () => {
  const pairs = corpus();
  const a = analyzeHistory(pairs);

  it('the synthetic corpus has exactly the shape under test', () => {
    expect(pairs).toHaveLength(685);
    expect(pairs.filter((p) => /^hey\b/.test(p.reply)).length).toBe(35);
    expect(pairs.filter((p) => p.reply.includes('—')).length).toBe(2);
    expect(pairs.filter((p) => p.reply.trim().split(/\s+/).length > 30).length).toBeGreaterThan(40);
  });

  it('a 99.7% rule (no em dashes, 683/685) is a true invariant', () => {
    const em = a.invariants.find((r) => r.id === 'no-em-dash');
    expect(em).toMatchObject({ layer: 'code', rule: 'Do not use em dashes.', support: { count: 683, of: 685 } });
    expect(a.invariantMinShare).toBe(0.98);
  });

  it('a 95% norm with 5% exceptions is NOT a blanket wall', () => {
    const ids = a.invariants.map((r) => r.id);
    expect(ids).not.toContain('no-greeting'); // 650/685 = 94.9%
    expect(ids).not.toContain('short-replies');
    expect(ids).not.toContain('word-cap'); // a 91% cap is not a wall; a 98% cap would exceed 100 words
    expect(a.invariants.map((r) => r.rule).join('\n')).not.toMatch(/straight away|at most 35 words/);
  });

  it('greetings surface their real if / else: cold restart and "they greeted", with exact counts and lift', () => {
    const g = rule(a, 'greeting')!;
    expect(g).toBeDefined();
    expect(g).toMatchObject({ layer: 'context', exceptionIs: 'present', explained: true, exceptions: { count: 35, of: 685, pct: 5.1 }, otherwise: 'jump straight in' });

    const cold = g.triggers.find((t) => t.feature === 'coldRestart')!;
    expect(cold.whenTrue).toMatchObject({ count: 15, of: 118, pct: 12.7 });
    expect(cold.whenFalse).toMatchObject({ count: 20, of: 567 });
    expect(cold.lift).toBe(3.6);
    expect(cold.covers).toMatchObject({ count: 15, of: 35 });

    const said = g.triggers.find((t) => t.feature === 'theyGreeted')!;
    expect(said.whenTrue).toMatchObject({ count: 20, of: 40, pct: 50 });
    expect(said.whenFalse).toMatchObject({ count: 15, of: 645 });
    expect(said.lift).toBe(21.5);
    expect(g.triggers[0]!.feature).toBe('theyGreeted'); // strongest first

    expect(g.rule).toContain('Greeting (35/685 = 5%): much more likely when they greeted (20/40 (50%) vs 15/645 (2%) otherwise, lift 22x)');
    expect(g.rule).toContain('cold restart (>24h) (15/118 (13%) vs 20/567 (4%) otherwise, lift 3.6x)');
    expect(g.rule).toMatch(/; otherwise jump straight in\.$/);
    // Live chat is where greetings almost never happen.
    expect(g.suppressors[0]).toMatchObject({ feature: 'liveChat', whenTrue: { count: 4, of: 347 } });
    expect(g.rule).toContain('rarely when live chat (<10m) (4/347 (1%) vs 31/338 (9%) otherwise)');
  });

  it('long replies are driven by long / multi-question incoming messages, not by a 35-word wall', () => {
    const l = rule(a, 'long-reply')!;
    expect(l).toBeDefined();
    expect(l.explained).toBe(true);
    expect(l.exceptions.pct).toBeGreaterThan(2);
    expect(l.exceptions.pct).toBeLessThan(45);
    const features = l.triggers.map((t) => t.feature);
    expect(features).toEqual(expect.arrayContaining(['longIncoming', 'multiQuestion']));
    for (const t of l.triggers) {
      expect(t.lift === null || t.lift >= 2).toBe(true);
      expect(t.covers.count).toBeGreaterThanOrEqual(3);
    }
    expect(l.rule).toMatch(/^Long replies >30w \(\d+\/685 = \d+%\): much more likely when /);
    expect(l.rule).toMatch(/; otherwise keep it brief \(~3 words\)\.$/);
    expect(l.rule).not.toMatch(/never|max|at most/i);
  });

  it('a behavior with fewer than 5 exceptions or under 2% gets no conditional rule', () => {
    expect(rule(a, 'sign-off')).toBeUndefined(); // 0 exceptions: no sign-off invariant instead
    expect(a.invariants.map((r) => r.id)).toContain('no-sign-off');
    const four = pairs.map((p, i) => (i < 4 ? { ...p, reply: 'thanks again' } : p)); // 4 exceptions
    expect(analyzeHistory(four).conditionalRules.find((r) => r.behavior === 'sign-off')).toBeUndefined();
  });

  it('says so honestly when no single deterministic feature explains the exceptions', () => {
    // Every pair looks identical to code (same live DM, same incoming), but 20 of 100 replies greet.
    const flat: HistoryPair[] = range(0, 99).map((i) => ({
      id: `f${i}`, channel: 'sms', sender: NAMES[i % 6]!, incoming: 'can you send the file', reply: i % 5 === 0 ? 'hey, ok' : 'ok will do', isGroup: false, gapSincePreviousMs: 2 * MIN,
    }));
    const flatAnalysis = analyzeHistory(flat);
    const g = rule(flatAnalysis, 'greeting')!;
    expect(g).toMatchObject({ explained: false, triggers: [], exceptions: { count: 20, of: 100 } });
    expect(g.rule).toBe('Greeting (20/100 = 20%): 20 exceptions, no single simple trigger explains them — keep flexible instead of adding a wall.');
    expect(flatAnalysis.invariants.map((r) => r.id)).not.toContain('no-greeting');
  });

  it('does not let one person fake a trigger (needs several different contacts)', () => {
    // 10 greetings, all to one person who also happens to be the only "new" contact.
    const solo: HistoryPair[] = range(0, 59).map((i) => ({
      id: `s${i}`, channel: 'sms', sender: i < 12 ? 'Sam Rivera' : NAMES[1 + (i % 4)]!, incoming: i < 12 ? 'hey' : 'can you send the file', reply: i < 10 ? 'hey, ok' : 'ok will do', isGroup: false, gapSincePreviousMs: i < 12 ? 2 * DAY : 2 * MIN,
    }));
    const g = rule(analyzeHistory(solo), 'greeting')!;
    expect(g.explained).toBe(false);
  });

  it('thresholds are configurable: invariantMinShare, minExceptions, minLift', () => {
    expect(analyzeHistory(pairs, { invariantMinShare: 0.999 }).invariants.map((r) => r.id)).not.toContain('no-em-dash');
    expect(analyzeHistory(pairs, { invariantMinShare: 0.99 }).invariants.map((r) => r.id)).toContain('no-em-dash'); // 99.7% >= 99%
    expect(rule(analyzeHistory(pairs, { minExceptions: 40 }), 'greeting')).toBeUndefined();
    expect(rule(analyzeHistory(pairs, { minLift: 30 }), 'greeting')!.explained).toBe(false);
  });

  it('prints two clear sections, not one mixed wall list', () => {
    const text = formatAnalysis(a).join('\n');
    expect(text).toContain('Invariants (safe as hard code/verify checks, ≥98%):');
    expect(text).toContain('  [invariant] Do not use em dashes.  (683/685 = 99.7%)');
    expect(text).toContain('Conditional logic (real exceptions — use branching logic, not walls):');
    expect(text).toContain('  [logic] Greeting (35/685 = 5%): much more likely when they greeted');
    expect(text).toContain('  [logic] Long replies >30w');
    expect(text.indexOf('Invariants (')).toBeLessThan(text.indexOf('Conditional logic ('));
    expect(text).not.toContain('Candidate rules from your own replies');
    expect(text).not.toContain('Skip the greeting');
  });

  it('works from pairs alone: conditionalAnalysis is pure and deterministic', () => {
    const tiers = tierBySender(pairs);
    expect(JSON.stringify(conditionalAnalysis(pairs, tiers))).toBe(JSON.stringify(conditionalAnalysis([...pairs], tiers)));
  });
});

describe('incoming features', () => {
  it('derives the deterministic features from the message and its context', () => {
    expect(incomingFeatures({ incoming: 'Good morning! quick one', gapSincePreviousMs: 2 * MIN }, 'regular')).toEqual({ theyGreeted: true, coldRestart: false, liveChat: true, newOrOccasional: false, longIncoming: false, multiQuestion: false });
    expect(incomingFeatures({ incoming: 'where?', gapSincePreviousMs: 24 * HOUR, isGroup: true }, 'occasional')).toMatchObject({ theyGreeted: false, coldRestart: true, liveChat: false, newOrOccasional: true, isGroup: true, isDm: false });
    expect(incomingFeatures({ incoming: 'hi', priorMessages: [] })).toMatchObject({ coldRestart: true, liveChat: false }); // a thread opener is a cold restart
    expect(incomingFeatures({ incoming: 'hi' }).coldRestart).toBeUndefined(); // unknown stays unknown
    expect(incomingFeatures({ incoming: 'word '.repeat(30) }).longIncoming).toBe(true);
    expect(incomingFeatures({ incoming: 'word '.repeat(29) }).longIncoming).toBe(false);
    expect(incomingFeatures({ incoming: 'one? two?' }).multiQuestion).toBe(true);
    expect(incomingFeatures({ incoming: 'one?' }).multiQuestion).toBe(false);
    expect(incomingFeatures({ incoming: 'Need:\n- the file\n- the address' }).multiQuestion).toBe(true);
    expect(questionCount('1) a\n2) b\n3) c')).toEqual({ count: 3, kind: 'items' });
  });
});

describe('buildSituationalContext: decision hints computed in code', () => {
  const history = corpus();

  it('skip + brief for a short live ping', () => {
    const ctx = buildSituationalContext({ channel: 'whatsapp', sender: 'Sam Rivera', isGroup: false, incoming: 'you around?', gapSincePreviousMs: 2 * MIN }, history);
    expect(ctx.greetHint).toBe('skip');
    expect(ctx.greetReason).toBe("live back-and-forth, they didn't greet → skip");
    expect(ctx.lengthBand).toBe('brief');
    expect(ctx.lengthReason).toMatch(/^short live ping \(2 words\) → brief \(~\d+ words\)$/);
    expect(ctx.features).toMatchObject({ liveChat: true, theyGreeted: false, multiQuestion: false });
    expect(ctx.voiceHint).toContain("greeting: live back-and-forth, they didn't greet → skip");
    expect(ctx.voiceHint).toContain('length: short live ping');
  });

  it('greet + detailed for a cold multi-question message that opens with a greeting', () => {
    const ctx = buildSituationalContext({ channel: 'whatsapp', sender: 'Sam Rivera', isGroup: false, incoming: 'Hey! can you send the file? when are you free this week? where should we meet?', gapSincePreviousMs: 3 * DAY }, history);
    expect(ctx.greetHint).toBe('greet');
    expect(ctx.greetReason).toBe('cold restart (>24h) + they greeted → brief greeting fits');
    expect(ctx.lengthBand).toBe('detailed');
    expect(ctx.lengthReason).toBe('incoming has 3 questions (16 words) → detailed');
    expect(ctx.voiceHint).toContain('cold restart (>24h) + they greeted → brief greeting fits');
    expect(ctx.voiceHint).toContain('incoming has 3 questions');
  });

  it('is optional when the signals disagree, and works with no history at all', () => {
    const coldNoGreet = buildSituationalContext({ channel: 'whatsapp', sender: 'Sam Rivera', incoming: 'can you send the file', gapSincePreviousMs: 3 * DAY }, history);
    expect(coldNoGreet.greetHint).toBe('optional');
    const liveGreeted = buildSituationalContext({ channel: 'whatsapp', sender: 'Sam Rivera', incoming: 'hey', gapSincePreviousMs: 2 * MIN }, history);
    expect(liveGreeted.greetHint).toBe('optional');
    const empty = buildSituationalContext({ channel: 'sms', sender: 'Nobody Known', incoming: 'ok' }, []);
    expect(empty).toMatchObject({ greetHint: 'skip', lengthBand: 'brief' });
    expect(empty.approxWords).toBeUndefined();
  });
});
