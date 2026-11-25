import { describe, expect, it } from 'vitest';
import { evaluateHoldout, formatHoldout, splitHoldout, type HistoryPair } from '../src';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NAMES = ['Sam Rivera', 'Alex Chen', 'Priya Patel', 'Jordan Lee', 'Casey Morgan', 'Taylor Quinn'];
const at = (i: number): string => new Date(Date.UTC(2025, 0, 1) + i * HOUR).toISOString();

const pair = (i: number, over: Partial<HistoryPair> = {}): HistoryPair => ({
  id: `h${i}`,
  channel: 'sms',
  sender: NAMES[i % NAMES.length]!,
  incoming: 'can you send the file',
  reply: 'ok will do',
  incomingAt: at(i),
  isGroup: false,
  gapSincePreviousMs: 2 * MIN,
  ...over,
});

describe('evaluateHoldout: out-of-sample, no leakage', () => {
  it('splits chronologically (oldest 80% learn, newest 20% are scored), whatever order the pairs arrive in', () => {
    const ordered = Array.from({ length: 50 }, (_, i) => pair(i));
    const shuffled = [...ordered].sort((a, b) => ((Number(a.id.slice(1)) * 7919) % 50) - ((Number(b.id.slice(1)) * 7919) % 50));
    expect(shuffled.map((p) => p.id)).not.toEqual(ordered.map((p) => p.id));

    const { train, test, orderedBy } = splitHoldout(shuffled, 0.2);
    expect(orderedBy).toBe('time');
    expect(train).toHaveLength(40);
    expect(test).toHaveLength(10);
    expect(test.map((p) => p.id)).toEqual(ordered.slice(40).map((p) => p.id));
    expect(new Set([...train, ...test].map((p) => p.id)).size).toBe(50); // disjoint, nothing lost
    expect(Math.max(...train.map((p) => Date.parse(p.incomingAt!)))).toBeLessThan(Math.min(...test.map((p) => Date.parse(p.incomingAt!))));

    // Without timestamps nothing can be sorted: the order given (seed order) is kept, never guessed.
    const bare = ordered.map(({ incomingAt: _drop, ...p }) => p);
    expect(splitHoldout(bare).orderedBy).toBe('input-order');
    expect(splitHoldout(bare).test.map((p) => p.id)).toEqual(ordered.slice(40).map((p) => p.id));
  });

  it('learns nothing from the held-out replies: a style change in the newest 20% is not predicted, it is measured', () => {
    // 40 old pairs: never greet, no em dash. The newest 10: a brand-new contact, greets, cold restart, em dashes.
    const old = Array.from({ length: 40 }, (_, i) => pair(i));
    const fresh = Array.from({ length: 10 }, (_, i) =>
      pair(40 + i, { sender: 'Rowan Blake', incoming: 'hey are you there', reply: 'hey — good to hear from you', gapSincePreviousMs: 3 * 24 * HOUR }),
    );
    const r = evaluateHoldout([...fresh, ...old]); // arrival order must not matter
    if (!r.evaluated) throw new Error(r.reason);

    expect(r.train.count).toBe(40);
    expect(r.test).toMatchObject({ count: 10 });
    expect(r.train.to! <= r.test.from!).toBe(true);
    expect(r.knownContacts).toMatchObject({ count: 0, of: 10 }); // Rowan Blake exists only in the held-out part
    // Invariants were learned from the old pairs alone, so the new style breaks them (it would pass if the test set had leaked in).
    expect(r.invariants!.passAll).toMatchObject({ count: 0, of: 10 });
    expect(r.invariants!.each.find((e) => e.id === 'no-em-dash')!.passed.count).toBe(0);
    // The hint sees a cold restart + they greeted: it says greet, and the held-out replies did greet.
    expect(r.greeting.match).toMatchObject({ count: 10, of: 10 });
    // The old pairs never greeted, so "always guess your usual" is wrong on every held-out reply.
    expect(r.greeting.baseline).toMatchObject({ count: 0, of: 10 });
  });

  it('scores greeting calls, length bands and invariants on unseen replies, and prints three compact lines', () => {
    // 60 pairs with a stable habit: cold + greeted incoming -> greet, long multi-question -> long, else short.
    const pairs = Array.from({ length: 60 }, (_, i) => {
      const cold = i % 5 === 0;
      const long = i % 6 === 0;
      return pair(i, {
        incoming: `${cold ? 'hey, ' : ''}${long ? 'can you send it? and when are you free? also where do we meet?' : 'can you send the file'}`,
        reply: `${cold ? 'hey, ' : ''}${long ? 'here is the long version of what i wanted to say about the plan for the week and the rest of it ok then that is all of it' : 'ok will do'}`,
        gapSincePreviousMs: cold ? 2 * 24 * HOUR : 2 * MIN,
      });
    });
    const r = evaluateHoldout(pairs, { holdoutFraction: 0.25 });
    if (!r.evaluated) throw new Error(r.reason);
    expect(r.test.count).toBe(15);
    expect(r.greeting.match.pct).toBeGreaterThanOrEqual(95);
    expect(r.greeting.match.count).toBeGreaterThan(r.greeting.baseline.count);
    expect(r.length.match.count).toBeGreaterThan(r.length.baseline.count);
    expect(r.length.withinOneBand.count).toBeGreaterThanOrEqual(r.length.match.count);
    expect(r.invariants!.passAll.pct).toBeGreaterThanOrEqual(95);

    const lines = formatHoldout(r).filter(Boolean);
    expect(lines).toHaveLength(3); // heading, greeting + length, invariants
    expect(lines[0]).toContain('Out-of-sample holdout check');
    expect(lines.join('\n')).toMatch(/greeting call \d+(\.\d)?% \(\d+\/15\) vs .* for always guessing your usual/);
    expect(lines.join('\n')).toMatch(/length band .* exact, .* within one band, vs .* for the global median/);
    expect(lines.join('\n')).toMatch(/invariants: .* of unseen replies satisfy all \d+ mined invariant/);
  });

  it('declines to score when there is too little data instead of reporting a meaningless number', () => {
    const r = evaluateHoldout(Array.from({ length: 12 }, (_, i) => pair(i)));
    expect(r.evaluated).toBe(false);
    expect(formatHoldout(r).join('\n')).toContain('skipped');
  });
});
