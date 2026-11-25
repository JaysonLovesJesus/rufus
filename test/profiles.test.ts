import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  FakeProvider,
  FileStore,
  analyzeHistory,
  buildContactProfiles,
  buildSituationalContext,
  closenessTier,
  defineFlow,
  extractHistoryFromMessages,
  extractPairsFromMessages,
  formatAnalysis,
  formatSeed,
  loadPairs,
  mineHistory,
  noiseKind,
  normalizePair,
  rhythmFromGap,
  seedHistory,
  situationalAnalysis,
  situationalRules,
  type HistoryInput,
  type HistoryMessage,
  type HistoryPair,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const msg = (id: string, sender: string, text: string, at: string, over: Partial<HistoryMessage> = {}): HistoryMessage => ({
  id,
  threadId: 't1',
  channel: 'whatsapp',
  sender,
  isFromMe: sender === 'me',
  text,
  timestamp: at,
  ...over,
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('noise filtering', () => {
  it('recognises one-time passcodes and tapback echoes, but not people asking about codes or liking things', () => {
    for (const t of [
      'Your verification code is 482913. It expires in 10 minutes.',
      '482913 is your one-time code. Do not share it.',
      'Use passcode 7731 to sign in',
      'G-204518 is your security code',
      'Code 123-456 expires in 5 minutes',
    ]) expect(noiseKind(t), t).toBe('otp');
    for (const t of ['Liked "see you at 7"', 'Loved “sounds great”', 'Disliked "no"', 'Laughed at "that is hilarious"', 'Loved an image', '👍 to “on my way”', 'Removed 👍', 'Removed a heart from “thanks”', 'Reacted 😂 to "lol"'])
      expect(noiseKind(t), t).toBe('tapback');
    for (const t of ['what was the verification code?', 'send me the passcode when you get it', 'Liked your idea, lets do it', 'I loved the restaurant', 'see you in 10 minutes', 'my pin is in the safe'])
      expect(noiseKind(t), t).toBeUndefined();
  });

  it('skips noise before turns are built, counts it, and lets includeNoise opt out', () => {
    const input = [
      msg('1', 'Sam Rivera', 'Your verification code is 482913. It expires in 10 minutes.', '2026-01-05T09:58:00Z'),
      msg('2', 'Sam Rivera', 'are you free thursday?', '2026-01-05T10:00:00Z'),
      msg('3', 'me', 'Liked "are you free thursday?"', '2026-01-05T10:01:00Z'),
      msg('4', 'me', 'yes, 3pm', '2026-01-05T10:02:00Z'),
      msg('5', 'Sam Rivera', 'Loved "yes, 3pm"', '2026-01-05T10:03:00Z'),
    ];
    const r = extractHistoryFromMessages(input);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]).toMatchObject({ incoming: 'are you free thursday?', reply: 'yes, 3pm' });
    expect(r.noise).toEqual({ otp: 1, tapback: 2, total: 3 });
    // A reaction echo is not an unanswered message either.
    expect(r.ignored).toEqual([{ channel: 'whatsapp', sender: 'Sam Rivera', isGroup: false, answered: 1, unanswered: 0 }]);

    const kept = extractHistoryFromMessages(input, { includeNoise: true });
    expect(kept.noise.total).toBe(0);
    expect(kept.pairs[0]!.incoming).toContain('verification code'); // opted out: the passcode joins the burst
    expect(extractPairsFromMessages(input)).toEqual(r.pairs);
  });
});

describe('situational extraction', () => {
  const thread = [
    msg('1', 'Sam Rivera', 'hey', '2026-03-02T09:00:00Z'), // Monday 09:00 UTC
    msg('2', 'me', 'hey! whats up', '2026-03-02T09:01:00Z'),
    msg('3', 'Sam Rivera', 'coffee later?', '2026-03-02T09:03:00Z'),
    msg('4', 'me', 'sure', '2026-03-02T09:08:00Z'),
    msg('5', 'Sam Rivera', 'ok around 3', '2026-03-02T14:00:00Z'), // 5h52m after my last turn
    msg('6', 'me', '3 works', '2026-03-02T14:20:00Z'),
    msg('7', 'Sam Rivera', 'did you get the notes?', '2026-03-05T18:30:00Z'), // Thursday, 3 days later
    msg('8', 'me', 'yep, sending now', '2026-03-05T18:31:00Z'),
  ];

  it('attaches the last turns, the gap since the previous turn, the reply delay, hour and weekday', () => {
    const pairs = extractPairsFromMessages(thread, { utcOffsetMinutes: 0 });
    expect(pairs).toHaveLength(4);
    const [first, second, third, fourth] = pairs as [HistoryPair, HistoryPair, HistoryPair, HistoryPair];

    expect(first.priorMessages).toEqual([]); // opened the thread
    expect(first.gapSincePreviousMs).toBeUndefined();
    expect(first).toMatchObject({ isGroup: false, replyDelayMs: MIN, incomingHour: 9, incomingDayOfWeek: 1 });

    expect(second.gapSincePreviousMs).toBe(2 * MIN); // live ping-pong
    expect(second.priorMessages!.map((m) => [m.isFromMe, m.text])).toEqual([
      [false, 'hey'],
      [true, 'hey! whats up'],
    ]);
    expect(second.replyDelayMs).toBe(5 * MIN);

    expect(third.gapSincePreviousMs).toBe(Date.parse('2026-03-02T14:00:00Z') - Date.parse('2026-03-02T09:08:00Z'));
    expect(rhythmFromGap(third.gapSincePreviousMs!)).toBe('same-day');

    expect(fourth.gapSincePreviousMs).toBe(Date.parse('2026-03-05T18:30:00Z') - Date.parse('2026-03-02T14:20:00Z'));
    expect(rhythmFromGap(fourth.gapSincePreviousMs!)).toBe('cold');
    expect(fourth).toMatchObject({ incomingHour: 18, incomingDayOfWeek: 4 });
    expect(fourth.priorMessages).toHaveLength(4); // capped at the default of 4 turns
    expect(fourth.priorMessages!.at(-1)).toMatchObject({ isFromMe: true, text: '3 works', timestamp: '2026-03-02T14:20:00.000Z' });
  });

  it('honours priorMessageCount, a fixed UTC offset, and detects group chats', () => {
    const none = extractPairsFromMessages(thread, { priorMessageCount: 0, utcOffsetMinutes: 0 });
    expect(none.every((p) => p.priorMessages === undefined)).toBe(true);

    const shifted = extractPairsFromMessages(thread, { utcOffsetMinutes: -300 })[0]!;
    expect(shifted).toMatchObject({ incomingHour: 4, incomingDayOfWeek: 1 });
    expect(extractPairsFromMessages([msg('1', 'Sam Rivera', 'hi', '2026-03-02T09:00:00Z'), msg('2', 'me', 'hey', '2026-03-02T09:01:00Z')], { utcOffsetMinutes: 600 })[0]).toMatchObject({ incomingHour: 19 });

    const group = extractPairsFromMessages([
      msg('1', 'Sam Rivera', 'dinner?', '2026-03-02T09:00:00Z', { threadId: 'g' }),
      msg('2', 'Alex Chen', 'im in', '2026-03-02T09:01:00Z', { threadId: 'g' }),
      msg('3', 'me', 'count me in', '2026-03-02T09:02:00Z', { threadId: 'g' }),
      msg('4', 'Priya Patel', 'hello', '2026-03-02T09:00:00Z', { threadId: 'flagged', isGroup: true }),
      msg('5', 'me', 'hi', '2026-03-02T09:01:00Z', { threadId: 'flagged' }),
    ]);
    expect(group.map((p) => [p.sender, p.isGroup])).toEqual([
      ['Priya Patel', true],
      ['Alex Chen', true],
    ]);
  });

  it('tracks who you leave on read: answered vs. unanswered per channel and sender', () => {
    const r = extractHistoryFromMessages(
      [
        msg('1', 'Sam Rivera', 'ping', '2026-04-01T10:00:00Z'),
        msg('2', 'me', 'pong', '2026-04-01T10:01:00Z'),
        msg('3', 'Sam Rivera', 'ping again', '2026-04-01T11:00:00Z'),
        msg('4', 'me', 'pong again', '2026-04-01T11:01:00Z'),
        msg('5', 'Sam Rivera', 'one more', '2026-04-02T12:00:00Z'),
        msg('6', 'Dana Whitfield', 'buy now!!!', '2026-04-01T12:00:00Z', { threadId: 'promo', channel: 'sms' }),
        msg('7', 'Dana Whitfield', 'last chance', '2026-04-02T12:00:00Z', { threadId: 'promo', channel: 'sms' }),
        msg('8', 'Alex Chen', 'late question', '2026-04-03T12:00:00Z', { threadId: 'late' }),
        msg('9', 'me', 'way too late', '2026-04-09T12:00:00Z', { threadId: 'late' }), // past maxGap: not an answer
      ],
      { maxGapMs: DAY },
    );
    expect(r.pairs).toHaveLength(2);
    expect(r.ignored).toEqual([
      { channel: 'whatsapp', sender: 'Sam Rivera', isGroup: false, answered: 2, unanswered: 1 },
      { channel: 'sms', sender: 'Dana Whitfield', isGroup: false, answered: 0, unanswered: 2 },
      { channel: 'whatsapp', sender: 'Alex Chen', isGroup: false, answered: 0, unanswered: 1 },
    ]);
  });

  it('round-trips the new fields through normalizePair and leaves older pairs untouched', () => {
    const legacy = normalizePair({ incoming: 'a', reply: 'b' });
    expect(legacy).toEqual({ pair: expect.not.objectContaining({ isGroup: expect.anything() }) });
    const full = normalizePair({
      incoming: 'a',
      reply: 'b',
      isGroup: true,
      gapSincePreviousMs: 1000,
      replyDelayMs: 5,
      incomingHour: 23,
      incomingDayOfWeek: 6,
      priorMessages: [{ sender: 'Sam Rivera', isFromMe: false, text: 'hi' }, { text: '   ' }, 'nope'],
    });
    expect(full).toMatchObject({ pair: { isGroup: true, gapSincePreviousMs: 1000, replyDelayMs: 5, incomingHour: 23, incomingDayOfWeek: 6, priorMessages: [{ sender: 'Sam Rivera', isFromMe: false, text: 'hi' }] } });
    const bad = normalizePair({ incoming: 'a', reply: 'b', isGroup: 'yes', gapSincePreviousMs: -5, incomingHour: 25, incomingDayOfWeek: 1.5 });
    expect(bad).toEqual({ pair: expect.not.objectContaining({ isGroup: expect.anything(), gapSincePreviousMs: expect.anything(), incomingHour: expect.anything(), incomingDayOfWeek: expect.anything() }) });
  });
});

// ---- A synthetic history with real differences between situations ----

const phrase = (n: number): string => Array.from({ length: n }, (_, i) => ['word', 'thing', 'plan', 'sounds', 'fine', 'later', 'today', 'review'][i % 8]).join(' ');
let seq = 0;
function pair(over: Partial<HistoryPair> & { sender: string; channel: string; reply: string }): HistoryPair {
  seq++;
  const incoming = over.incoming ?? `message number ${seq}`;
  return {
    id: `h${seq}`,
    incoming,
    incomingAt: `2026-02-${String((seq % 27) + 1).padStart(2, '0')}T12:00:00.000Z`,
    ...over,
  };
}

function history(): HistoryPair[] {
  seq = 0;
  const out: HistoryPair[] = [];
  // Sam Rivera: ten quick, lowercase WhatsApp DMs, ~6 words, no greeting. Rapid + frequent => inner-circle.
  for (let i = 0; i < 10; i++)
    out.push(pair({ sender: 'Sam Rivera', channel: 'whatsapp', incoming: i % 2 ? 'are you coming tonight?' : 'running late, sorry', reply: `ok ${phrase(5)}`, isGroup: false, gapSincePreviousMs: 2 * MIN, replyDelayMs: MIN, priorMessages: [{ sender: 'me', isFromMe: true, text: 'ok' }] }));
  // Alex Chen: eight email DMs, ~14 words, greeting + sign-off, same-day threads. Regular.
  for (let i = 0; i < 8; i++)
    out.push(pair({ sender: 'Alex Chen', channel: 'email', incoming: 'Can you review the draft for the meeting?', reply: `Hi Alex, ${phrase(11)} thanks`, isGroup: false, gapSincePreviousMs: 3 * HOUR, replyDelayMs: 90 * MIN }));
  // Dev Kapoor: four cold SMS DMs, ~30 words. Occasional.
  for (let i = 0; i < 4; i++)
    out.push(pair({ sender: 'Dev Kapoor', channel: 'sms', incoming: 'Hope you are well, any update on the invoice?', reply: `Hi Dev, ${phrase(28)}`, isGroup: false, gapSincePreviousMs: 3 * DAY, replyDelayMs: 5 * HOUR }));
  // Priya Patel: three cold SMS replies inside a group chat, ~30 words. Occasional.
  for (let i = 0; i < 3; i++)
    out.push(pair({ sender: 'Priya Patel', channel: 'sms', incoming: 'Where should we meet on Friday?', reply: `Hi all, ${phrase(28)}`, isGroup: true, gapSincePreviousMs: 2 * DAY, replyDelayMs: 3 * HOUR }));
  // Jordan Lee: one WhatsApp group message, same day. New.
  out.push(pair({ sender: 'Jordan Lee', channel: 'whatsapp', incoming: 'who is bringing snacks?', reply: 'me', isGroup: true, gapSincePreviousMs: 30 * MIN, replyDelayMs: 4 * MIN }));
  return out;
}

describe('buildContactProfiles', () => {
  const pairs = history();
  const p = buildContactProfiles(pairs);

  it('classifies closeness from real interaction history', () => {
    const tier = (s: string) => p.contacts.find((c) => c.sender === s)!.tier;
    expect(tier('Sam Rivera')).toBe('inner-circle'); // only 10 pairs, but every one is a rapid live reply
    expect(tier('Alex Chen')).toBe('regular');
    expect(tier('Dev Kapoor')).toBe('occasional');
    expect(tier('Priya Patel')).toBe('occasional');
    expect(tier('Jordan Lee')).toBe('new');
    expect(p.byTier.map((t) => [t.tier, t.contacts, t.count])).toEqual([
      ['inner-circle', 1, 10],
      ['regular', 1, 8],
      ['occasional', 2, 7],
      ['new', 1, 1],
    ]);
    // Plain thresholds: 20+ is inner-circle even when slow; 5-19 regular; 2-4 occasional; 1 new.
    expect([closenessTier(20, 0), closenessTier(19, 0), closenessTier(10, 0.4), closenessTier(10, 0.5), closenessTier(5, 1), closenessTier(4, 1), closenessTier(2, 1), closenessTier(1, 1)]).toEqual([
      'inner-circle',
      'regular',
      'regular',
      'inner-circle',
      'regular',
      'occasional',
      'occasional',
      'new',
    ]);
  });

  it('computes exact per-contact style', () => {
    const sam = p.contacts.find((c) => c.sender === 'Sam Rivera')!;
    expect(sam).toMatchObject({ channels: ['whatsapp'], dmCount: 10, groupCount: 0, liveShare: 1 });
    expect(sam.style).toEqual({ count: 10, medianWords: 6, p90Words: 6, greetingRate: 0, signOffRate: 0, emojiRate: 0, exclamationRate: 0, lowercaseRate: 1, medianReplyMins: 1, distinctContacts: 1, topContactShare: 1, effectiveCount: expect.any(Number) });
    expect(Object.keys(sam.byRhythm)).toEqual(['live']);
    const alex = p.contacts.find((c) => c.sender === 'Alex Chen')!;
    expect(alex.style).toMatchObject({ count: 8, medianWords: 14, greetingRate: 1, signOffRate: 1, lowercaseRate: 0, medianReplyMins: 90 });
  });

  it('aggregates by DM vs. group, channel, rhythm and channel x intent', () => {
    expect(p.byChatKind.map((k) => [k.kind, k.count, k.medianWords])).toEqual([
      ['dm', 22, 14],
      ['group', 4, 30],
    ]);
    expect(p.byChannel.map((c) => [c.channel, c.count, c.medianWords, c.greetingRate])).toEqual([
      ['whatsapp', 11, 6, 0],
      ['email', 8, 14, 1],
      ['sms', 7, 30, 1],
    ]);
    expect(p.byRhythm.map((r) => [r.rhythm, r.count, r.medianWords])).toEqual([
      ['live', 10, 6],
      ['same-day', 9, 14],
      ['cold', 7, 30],
    ]);
    expect(p.known).toEqual({ chatKind: 26, rhythm: 26 });
    const cell = (channel: string, intent: string) => p.byChannelIntent.find((c) => c.channel === channel && c.intent === intent)!;
    expect(cell('whatsapp', 'confirmation')).toMatchObject({ count: 5, medianWords: 6 });
    expect(cell('whatsapp', 'other')).toMatchObject({ count: 5, medianWords: 6 });
    expect(cell('email', 'scheduling')).toMatchObject({ count: 8, medianWords: 14, greetingRate: 1, signOffRate: 1 });
    expect(cell('sms', 'follow-up')).toMatchObject({ count: 4, medianWords: 30 });
    expect(cell('sms', 'scheduling')).toMatchObject({ count: 3, medianWords: 30 });
  });
});

describe('reply rates from silence', () => {
  it('adds how often you answer when reply habits are supplied', () => {
    const pairs = history();
    const p = buildContactProfiles(pairs, {
      replyHabits: [
        { channel: 'whatsapp', sender: 'Sam Rivera', isGroup: false, answered: 10, unanswered: 0 },
        { channel: 'sms', sender: 'Dev Kapoor', isGroup: false, answered: 4, unanswered: 12 },
      ],
    });
    expect(p.contacts.find((c) => c.sender === 'Dev Kapoor')).toMatchObject({ replyRate: 0.25, unanswered: 12 });
    expect(p.contacts.find((c) => c.sender === 'Sam Rivera')).toMatchObject({ replyRate: 1, unanswered: 0 });
    expect(p.contacts.find((c) => c.sender === 'Alex Chen')!.replyRate).toBeUndefined();
    expect(p.byChannel.find((c) => c.channel === 'sms')).toMatchObject({ replyRate: 0.25, unanswered: 12 });
  });

  it('does not guess DM vs. group or rhythm for older pairs', () => {
    const legacy: HistoryPair[] = [{ id: 'x', channel: 'chat', sender: 'Sam Rivera', incoming: 'hi', reply: 'hey' }];
    const p = buildContactProfiles(legacy);
    expect(p.byChatKind).toEqual([]);
    expect(p.byRhythm).toEqual([]);
    expect(p.known).toEqual({ chatKind: 0, rhythm: 0 });
    expect(p.contacts[0]).toMatchObject({ tier: 'new' });
  });
});

// The tiny fixture above has 1-4 contacts per situation; these thresholds switch the breadth guardrails off so the rule mechanics can be tested on it.
const RELAXED = { minSlicePairs: 5, minDistinctContacts: 1, maxTopContactShare: 1 };

describe('situationalRules', () => {
  it('emits context rules only where a situation really differs, with exact support', () => {
    const pairs = history();
    const rules = situationalRules(pairs, buildContactProfiles(pairs), RELAXED);
    expect(rules.every((r) => r.layer === 'context')).toBe(true);
    const byText = (re: RegExp) => rules.find((r) => re.test(r.rule));
    const inner = byText(/inner-circle WhatsApp DMs/)!;
    expect(inner.rule).toBe('For inner-circle WhatsApp DMs, keep replies ~6 words, no greeting, no sign-off.');
    expect(inner.support).toEqual({ count: 10, of: 10 }); // all 10 are shorter than the overall median of 14
    expect(inner.evidence).toContain('Median 6 vs 14 words overall');
    const cold = byText(/cold restart/)!;
    expect(cold.rule).toBe('For occasional contacts in cold restart threads, use fuller sentences (~30 words), open with a greeting, no sign-off.');
    expect(cold.support).toEqual({ count: 7, of: 7 });
    // Alex's emails (median 14) match the overall median: no length rule, and nothing is said about them.
    expect(rules.some((r) => /email/i.test(r.rule) && /words/.test(r.rule))).toBe(false);
  });

  it('stays quiet when everyone is written to the same way, or evidence is thin', () => {
    const flat: HistoryPair[] = Array.from({ length: 30 }, (_, i) => ({
      id: `f${i}`,
      channel: i % 2 ? 'whatsapp' : 'sms',
      sender: `Sender ${i % 3}`,
      incoming: 'hello there',
      reply: 'sure thing see you soon',
      isGroup: i % 4 === 0,
      gapSincePreviousMs: (i % 3) * 20 * HOUR,
    }));
    expect(situationalRules(flat, buildContactProfiles(flat), RELAXED)).toEqual([]);
    const small = history().slice(0, 4);
    expect(analyzeHistory(small).contextRules).toEqual([]); // below minPairs
  });
});

describe('buildSituationalContext', () => {
  const pairs = history();

  it('describes a known inner-circle contact: tier, rhythm, their own style, their own examples', () => {
    const ctx = buildSituationalContext(
      { channel: 'whatsapp', sender: 'Sam Rivera', isGroup: false, incoming: 'are you coming tonight?', gapSincePreviousMs: 90 * 1000, priorMessages: [{ sender: 'Sam Rivera', isFromMe: false, text: 'hey' }] },
      pairs,
    );
    expect(ctx).toMatchObject({ tier: 'inner-circle', known: true, contactPairs: 10, chatKind: 'dm', rhythm: 'live', rhythmLabel: 'live back-and-forth', intent: 'confirmation', styleBasis: 'contact+rhythm' });
    expect(ctx.style).toMatchObject({ count: 10, medianWords: 6, greetingRate: 0, lowercaseRate: 1 });
    expect(ctx.voiceHint).toBe("Inner-circle WhatsApp DM (10 past exchanges), live chat: median 6 words, casual, lowercase, no greeting/sign-off; greeting: live back-and-forth, they didn't greet → skip; length: short live ping (4 words) → brief (~6 words)");
    expect(ctx.examples).toHaveLength(3);
    expect(ctx.examples.every((e) => e.because[0] === 'same sender')).toBe(true);
    expect(ctx.examples.every((e) => e.channel === 'whatsapp' && e.incoming === 'are you coming tonight?')).toBe(true); // same intent ranks first
    expect(ctx.examples[0]!.because).toEqual(['same sender', 'same channel+dm', 'same intent', 'same rhythm']);
  });

  it('falls back cleanly for a contact with no history: channel + DM/group + intent, then wider', () => {
    const fresh = buildSituationalContext({ channel: 'sms', sender: 'Casey Morgan', isGroup: false, incoming: 'any update on the invoice?', gapSincePreviousMs: 4 * DAY }, pairs);
    expect(fresh).toMatchObject({ tier: 'new', known: false, contactPairs: 0, chatKind: 'dm', rhythm: 'cold', intent: 'follow-up', styleBasis: 'channel+chat+intent' });
    expect(fresh.style).toMatchObject({ count: 4, medianWords: 30, greetingRate: 1 });
    expect(fresh.voiceHint).toBe("New contact on SMS DM (no history with them), cold restart: median 30 words, more formal, usually greets (from 4 similar follow-up SMS DMs); greeting: cold restart (>24h), but they didn't greet → greeting optional; length: ordinary cold-restart message (5 words) → medium");
    expect(fresh.examples.length).toBeGreaterThanOrEqual(2);
    expect(fresh.examples.length).toBeLessThanOrEqual(4);
    expect(fresh.examples.some((e) => e.because.includes('same sender'))).toBe(false);
    expect(fresh.examples[0]!.because).toContain('same intent');

    // An unseen channel falls back to everything you have written.
    const odd = buildSituationalContext({ channel: 'carrier-pigeon', sender: 'Casey Morgan', incoming: 'hello' }, pairs);
    expect(odd).toMatchObject({ tier: 'new', known: false, styleBasis: 'overall' });
    expect(odd).not.toHaveProperty('rhythm');
    expect(odd).not.toHaveProperty('chatKind');
    expect(odd.style!.count).toBe(pairs.length);
    expect(odd.examples).toEqual([]);
    expect(odd.voiceHint).toMatch(/^New contact on carrier-pigeon chat/);
  });

  it('treats a thread opener as a cold restart, uses prebuilt profiles, and handles empty history', () => {
    expect(buildSituationalContext({ channel: 'whatsapp', sender: 'Sam Rivera', incoming: 'hey', priorMessages: [] }, pairs).rhythm).toBe('cold');
    const profiles = buildContactProfiles(pairs);
    expect(buildSituationalContext({ channel: 'whatsapp', sender: 'Alex Chen', incoming: 'hi', gapSincePreviousMs: 2 * HOUR }, pairs, { profiles, examples: 99 }).examples).toHaveLength(4);
    const empty = buildSituationalContext({ channel: 'sms', sender: 'Sam Rivera', incoming: 'hi' }, []);
    expect(empty).toMatchObject({ tier: 'new', known: false, styleBasis: 'none', examples: [] });
    expect(empty.style).toBeUndefined();
    expect(empty.voiceHint).toContain('no history to learn from yet');
  });

  it('is usable inside a flow ctx.code step from a seeded case', async () => {
    const dir = await tempDir();
    const engine = new Engine({ store: new FileStore(dir) });
    const flow = defineFlow<HistoryInput>({ id: 'ctx', name: 'Ctx', description: 'Situation-aware', role: 'assistant' }, async (ctx) => {
      const sit = await ctx.code('situation', () =>
        buildSituationalContext({ channel: ctx.input.channel, sender: ctx.input.sender, isGroup: ctx.input.isGroup, incoming: ctx.input.incoming, gapSincePreviousMs: ctx.input.gapSincePreviousMs, priorMessages: ctx.input.priorMessages }, pairs),
      );
      return sit.voiceHint;
    });
    engine.register(flow);
    const file = path.join(dir, 'in.jsonl');
    await writeFile(file, JSON.stringify({ ...pairs[0], id: 'seeded1', reply: 'ok' }) + '\n');
    await seedHistory(engine, file, { flowId: 'ctx' });
    const [c] = await engine.cases.forFlow('ctx');
    expect(c!.input).toMatchObject({ isGroup: false, gapSincePreviousMs: 2 * MIN, priorMessages: [{ text: 'ok' }] });
  });
});

describe('seed noise filtering', () => {
  const records = [
    { id: 'a', channel: 'sms', sender: 'Sam Rivera', incoming: 'are you free?', reply: 'yes' },
    { id: 'b', channel: 'sms', sender: 'Acme Bank', incoming: 'Your verification code is 482913. It expires in 10 minutes.', reply: 'ok' },
    { id: 'c', channel: 'imessage', sender: 'Alex Chen', incoming: 'Loved "see you at 7"', reply: 'haha' },
    { id: 'd', channel: 'imessage', sender: 'Alex Chen', incoming: 'see you at 7?', reply: 'Liked "see you at 7?"' },
    { id: 'e', channel: 'sms', sender: 'Priya Patel', incoming: 'passcode 7731, do not share', reply: 'k' },
  ];

  it('skips and reports OTP and tapback pairs, and --include-noise keeps them', async () => {
    const dir = await tempDir();
    const engine = new Engine({ store: new FileStore(dir) });
    engine.register(defineFlow({ id: 'reply', name: 'Reply', description: 'x', role: 'assistant' }, async () => 'x'));
    const file = path.join(dir, 'h.jsonl');
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const dry = await seedHistory(engine, file, { flowId: 'reply', dryRun: true });
    expect(dry).toMatchObject({ read: 5, added: 1, considered: 1, noiseSkipped: { otp: 2, tapback: 2, total: 4 } });
    const text = formatSeed(dry).join('\n');
    expect(text).toContain('skipped 4 noise item(s): 2 one-time passcode(s) / verification code(s), 2 tapback reaction(s)');

    const real = await seedHistory(engine, file, { flowId: 'reply' });
    expect(real.noiseSkipped.total).toBe(4);
    expect((await loadPairs(engine.store)).map((p) => p.id)).toEqual(['a']);
    expect(real.casesAdded).toBe(1);

    const all = await seedHistory(engine, file, { flowId: 'reply', includeNoise: true });
    expect(all).toMatchObject({ noiseSkipped: { total: 0 }, considered: 5, added: 4 });
    expect(formatSeed(all).join('\n')).not.toContain('noise');
  });

  it('exposes --include-noise on the CLI', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'h.jsonl');
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n'));
    const run = async (...extra: string[]) => {
      const lines: string[] = [];
      await main(['--dir', dir, 'seed', file, '--flow', 'triage-draft', '--dry-run', ...extra], { out: (l) => void lines.push(l), err: (l) => void lines.push(l) });
      return lines.join('\n');
    };
    const filtered = await run();
    expect(filtered).toContain('would add 1 new pair(s)');
    expect(filtered).toContain('skipped 4 noise item(s)');
    const kept = await run('--include-noise');
    expect(kept).toContain('would add 5 new pair(s)');
    expect(kept).not.toContain('noise');
  });
});

describe('mine: situational breakdown', () => {
  it('shows closeness, DM vs. group, channel and rhythm, plus context rules, in the report', () => {
    const lines = formatAnalysis(analyzeHistory(history(), RELAXED)).join('\n');
    expect(lines).toContain('Your voice by situation');
    expect(lines).toMatch(/inner-circle: 10 replies \(1 contact(?: — person-specific, not generalized)?\), median 6 words \(90th pct 6\), greeting 0%, sign-off 0%/);
    expect(lines).toMatch(/regular: 8 replies \(1 contact(?: — [^)]*)?\), median 14 words/);
    expect(lines).toMatch(/occasional: 7 replies \(2 contacts(?: — [^)]*)?\), median 30 words/);
    expect(lines).toMatch(/DM: 22 replies \(3 contacts\), median 14 words/);
    expect(lines).toMatch(/group chat: 4 replies \(2 contacts — person-specific, not generalized\), median 30 words/);
    expect(lines).toMatch(/WhatsApp: 11 replies \(\d contacts?(?: — [^)]*)?\), median 6 words/);
    expect(lines).toMatch(/SMS: 7 replies \(2 contacts(?: — [^)]*)?\), median 30 words/);
    expect(lines).toMatch(/Email: 8 replies \(1 contact(?: — [^)]*)?\), median 14 words.*greeting 100%, sign-off 100%/);
    expect(lines).toMatch(/live back-and-forth \(< 10 min\): 10 replies/);
    expect(lines).toMatch(/cold restart \(> 24 h\): 7 replies/);
    expect(lines).toContain('[context] For inner-circle WhatsApp DMs, keep replies ~6 words, no greeting, no sign-off.  (10/10)');
    expect(lines).toContain('[context] For occasional contacts in cold restart threads, use fuller sentences (~30 words)');
  });

  it('says so when older pairs carry no situation', () => {
    const legacy: HistoryPair[] = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, channel: 'chat', sender: 'Sam Rivera', incoming: 'hi', reply: 'hey' }));
    const lines = formatAnalysis(analyzeHistory(legacy)).join('\n');
    expect(lines).toContain('DM vs. group chat: unknown');
    expect(lines).toContain('By conversation rhythm: unknown');
  });

  it('sends the AI anonymized situational slices and context-aware instructions, never names or prior messages', async () => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    const pairs = history().map((p) => ({ ...p, priorMessages: [{ sender: 'Sam Rivera', isFromMe: false, text: 'a private earlier message' }] }));
    await store.writeText(store.pairsFile, pairs.map((p) => JSON.stringify(p)).join('\n') + '\n');
    const smart = new FakeProvider([JSON.stringify({ blueprints: [], lessons: [{ rule: 'For inner-circle WhatsApp DMs, keep replies ~6 words.', layer: 'context' }] })]);
    const engine = new Engine({ store, providers: { smart } });
    const report = await mineHistory(engine, { ai: true, provider: 'smart', sampleSize: 10, ...RELAXED });
    expect(report.ai!.lessons[0]).toMatchObject({ layer: 'context' });

    const sent = smart.calls[0]!.messages[0]!.content;
    expect(sent).toContain('"situations"');
    expect(sent).toContain('"byCloseness"');
    expect(sent).toContain('"byRhythm"');
    expect(sent).toContain('"rhythm": "cold"');
    expect(sent).toContain('"closeness": "inner-circle"'); // sample items say how close, not who
    expect(sent).toContain('For inner-circle WhatsApp DMs, keep replies ~6 words, no greeting, no sign-off.');
    expect(sent).toMatch(/closeness tier.*DM vs\. group.*conversation rhythm/s);
    for (const name of ['Sam Rivera', 'Alex Chen', 'Dev Kapoor', 'Priya Patel', 'Jordan Lee', 'private earlier message']) expect(sent).not.toContain(name);
    expect(await readFile(store.pairsFile, 'utf8')).toContain('priorMessages'); // stored locally, just never sent
  });
});

// ---- Confounding & contact-diversity guardrails ----

describe('contact-diversity and sender-confounding guardrails', () => {
  const SHORT = 'ok sounds good'; // 3 words: your everyday baseline
  const LONG = phrase(16);

  /** A busy baseline channel: 8 contacts x 8 short replies (all `regular`), so the overall median is 3 words. */
  const baseline = (): HistoryPair[] => {
    seq = 0;
    const out: HistoryPair[] = [];
    for (let c = 0; c < 8; c++) for (let i = 0; i < 8; i++) out.push(pair({ sender: `Wa Contact ${c}`, channel: 'whatsapp', reply: SHORT }));
    return out;
  };
  const rule = <T extends { id: string }>(rules: T[], channel: string): T | undefined => rules.find((r) => r.id === `context-channel-${channel}`);
  const NO_GATE = { minSlicePairs: 5, minDistinctContacts: 1, maxTopContactShare: 1 };

  it('does not turn a channel dominated by 1-2 people into a channel rule, and says why', () => {
    // 36 iMessage replies: one person has 25 of them, two others have 6 and 5. All long.
    const pairs = baseline();
    for (const [who, n] of [['Chatty Person', 25], ['Second Person', 6], ['Third Person', 5]] as const)
      for (let i = 0; i < n; i++) pairs.push(pair({ sender: who, channel: 'imessage', reply: LONG }));

    const profiles = buildContactProfiles(pairs);
    const im = profiles.byChannel.find((c) => c.channel === 'imessage')!;
    expect(im).toMatchObject({ count: 36, distinctContacts: 3, topContactShare: 0.694 });

    const { rules, suppressed } = situationalAnalysis(pairs, profiles);
    expect(rule(rules, 'imessage')).toBeUndefined();
    expect(rules.some((r) => /iMessage/.test(r.rule))).toBe(false);
    expect(suppressed.join('\n')).toMatch(/iMessage messages \(36 replies across 3 contacts; top contact 69%\) — longer replies but only 3 contacts \(need 5\).*handled per-contact instead/);

    // Proof it is the guardrail: with it off, the old behaviour (a fake channel rule) comes back.
    expect(rule(situationalAnalysis(pairs, profiles, NO_GATE).rules, 'imessage')!.rule).toContain('use fuller sentences');

    // ...and it shows in the `rufus mine` report, right next to the reply count.
    const report = formatAnalysis(analyzeHistory(pairs)).join('\n');
    expect(report).toContain('iMessage: 36 replies (3 contacts — person-specific, not generalized)');
    expect(report).toContain('WhatsApp: 64 replies (8 contacts)');
    expect(report).toContain('Not generalized');
    expect(analyzeHistory(pairs).suppressedSlices.some((n) => /iMessage/.test(n))).toBe(true);
  });

  it('suppresses a diverse-looking channel when only a minority of its contacts individually write longer', () => {
    // 6 contacts, no one above 20%: 3 long writers (7 each) and 3 who write like your baseline (5 each).
    // The slice median is long, but weighting each contact equally only 3 of 6 (50%) deviate.
    const pairs = baseline();
    for (let c = 0; c < 6; c++) for (let i = 0; i < (c < 3 ? 7 : 5); i++) pairs.push(pair({ sender: `Sms Contact ${c}`, channel: 'sms', reply: c < 3 ? LONG : SHORT }));
    const profiles = buildContactProfiles(pairs);
    expect(profiles.byChannel.find((c) => c.channel === 'sms')).toMatchObject({ count: 36, distinctContacts: 6 });
    const { rules, suppressed } = situationalAnalysis(pairs, profiles);
    expect(rule(rules, 'sms')).toBeUndefined();
    expect(suppressed.join('\n')).toMatch(/SMS messages \(36 replies across 6 contacts; top contact 19%\).*only 3 of 6 contacts individually show it/);
  });

  it('does emit a channel rule when 5+ contacts each individually write longer', () => {
    const pairs = baseline();
    for (let c = 0; c < 6; c++) for (let i = 0; i < 6; i++) pairs.push(pair({ sender: `Sms Contact ${c}`, channel: 'sms', reply: c < 5 ? LONG : SHORT })); // 5 of 6 (83%) write long
    const profiles = buildContactProfiles(pairs);
    const { rules, suppressed } = situationalAnalysis(pairs, profiles);
    const sms = rule(rules, 'sms')!;
    expect(sms.rule).toBe('For SMS messages, use fuller sentences (~16 words), no greeting.');
    expect(sms.support).toEqual({ count: 30, of: 36 });
    expect(suppressed.some((n) => /SMS/.test(n))).toBe(false);
    expect(formatAnalysis(analyzeHistory(pairs)).join('\n')).toContain('SMS: 36 replies (6 contacts)');
  });

  it('thresholds come from config (minSlicePairs / minDistinctContacts / maxTopContactShare)', () => {
    const pairs = baseline();
    for (let c = 0; c < 4; c++) for (let i = 0; i < 6; i++) pairs.push(pair({ sender: `Sms Contact ${c}`, channel: 'sms', reply: LONG })); // 24 replies, 4 contacts, 25% each
    expect(rule(analyzeHistory(pairs).contextRules, 'sms')).toBeUndefined(); // default: 30 replies, 5 contacts
    expect(rule(analyzeHistory(pairs, { minSlicePairs: 20, minDistinctContacts: 4 }).contextRules, 'sms')).toBeDefined();
    expect(rule(analyzeHistory(pairs, { minSlicePairs: 20, minDistinctContacts: 4, maxTopContactShare: 0.2 }).contextRules, 'sms')).toBeUndefined();
  });

  it('buildSituationalContext still gives a known contact their own style when their channel rule was suppressed', () => {
    const pairs = baseline();
    for (const [who, n] of [['Chatty Person', 25], ['Second Person', 6], ['Third Person', 5]] as const)
      for (let i = 0; i < n; i++) pairs.push(pair({ sender: who, channel: 'imessage', reply: LONG, isGroup: false }));
    expect(rule(situationalAnalysis(pairs, buildContactProfiles(pairs)).rules, 'imessage')).toBeUndefined();

    const ctx = buildSituationalContext({ channel: 'imessage', sender: 'Chatty Person', isGroup: false, incoming: 'hey, are you free later?' }, pairs);
    expect(ctx.known).toBe(true);
    expect(ctx.styleBasis).toBe('contact');
    expect(ctx.contactPairs).toBe(25);
    expect(ctx.style).toMatchObject({ medianWords: 16, count: 25, distinctContacts: 1 });
    expect(ctx.voiceHint).toContain('median 16 words');
    expect(ctx.examples[0]!.because).toContain('same sender');

    // A different person on the same channel gets their own slice too, not the dominant person's.
    const other = buildSituationalContext({ channel: 'imessage', sender: 'Wa Contact 1', isGroup: false, incoming: 'hey' }, pairs);
    expect(other.styleBasis).toBe('contact');
    expect(other.style!.medianWords).toBe(3);
  });
});
