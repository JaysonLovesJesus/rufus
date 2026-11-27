import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Bouncer,
  FakeProvider,
  HeartbeatHub,
  RufusCore,
  SenseHealth,
  TelegramChannel,
  WakeInbox,
  assessSenses,
  beeperConnector,
  browserConnector,
  describeAudience,
  diffCalendar,
  formatParty,
  genericEvent,
  isNonSpeech,
  messageEvent,
  parseGmail,
  readSensesFile,
  repoConnector,
  watchConnector,
  WatchStore,
  type LosslessEvent,
} from '../src';
import { recordEditFeedback, recordReactionFeedback } from '../src/events/feedback';
import { createSenseRuntime, WAKE_FAILURE_NOTE } from '../src/events/runtime';
import { createVoiceHttpHandler } from '../src/voice/server';
import type { KokoroTts } from '../src/voice/kokoro';
import { tempDir, topDown, waitFor } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SLEEP_MOVE = JSON.stringify({ toolId: 'sleep', input: { reason: 'done' } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function owner(text: string, id: string): LosslessEvent {
  const ev = messageEvent({ id, channel: 'telegram', actor: 'owner', text, timestamp: new Date().toISOString() });
  ev.kind = 'owner_direct';
  return ev;
}

describe('Gmail sense', () => {
  const READER_OUTPUT = JSON.stringify(
    [
      { id: '19a0001', subject: 'Your tickets', from: 'Box Office <tickets@example.com>', fromEmail: 'tickets@example.com', snippet: 'Order confirmed', date: '2026-11-26T15:00:00Z', labels: ['updates'] },
      { id: '19a0002', subject: 'Dinner?', from: 'Sam <sam@example.com>', fromEmail: 'sam@example.com', snippet: 'Free Friday?', date: '2026-11-26T16:00:00Z', labels: [] },
    ],
    null,
    1,
  );

  it('parses the pretty-printed JSON list into one event per email with a stable id, sender, date and category features', () => {
    const { events, parseFailures } = parseGmail(READER_OUTPUT);
    expect(parseFailures).toBe(0);
    expect(events.map((e) => e.id)).toEqual(['email_19a0001', 'email_19a0002']);
    expect(events[0]).toMatchObject({ source: 'email', actor: 'Box Office <tickets@example.com>', text: 'Your tickets — Order confirmed', timestamp: '2026-11-26T15:00:00.000Z' });
    expect(events[0]!.metadata?.features).toEqual(['category:updates']);
    expect(Bouncer.eventToFeatureText(events[0]!)).toContain('category:updates');
    // Polled again: the same ids, so the store keeps one event per email.
    expect(parseGmail(READER_OUTPUT).events.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(parseGmail('[]').events).toEqual([]);
  });

  it('fails loudly on output that is not a JSON list, instead of turning fragments into events', () => {
    expect(() => parseGmail('{\n "id": "1",')).toThrow(/not JSON/);
    expect(parseGmail(JSON.stringify([{ subject: 'no id' }])).parseFailures).toBe(1);
  });
});

describe('Message audience', () => {
  it('says who wrote to whom, so a message to the owner never reads as one to Rufus', () => {
    expect(describeAudience({ from: 'Mom', to: 'owner', direction: 'incoming', network: 'WhatsApp', chatType: 'dm', chatTitle: 'Mom' })).toBe('Mom → the owner (WhatsApp DM)');
    expect(describeAudience({ from: 'Alex', to: 'group', direction: 'incoming', network: 'WhatsApp', chatType: 'group', chatTitle: 'Family' })).toBe('Alex → group "Family" (WhatsApp group)');
    expect(formatParty(owner('hi', 'tg_1'))).toBe(' / the owner → you (Rufus) (Telegram DM)');
    expect(formatParty(genericEvent({ source: 'email', kind: 'unread', text: 'x', actor: 'Sam' }))).toBe(' / Sam');
  });
});

/** A tiny stand-in for Beeper Desktop's local API. */
async function fakeBeeper(state: { chats: unknown[]; messages: Record<string, Array<Record<string, unknown>>> }) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/v1/chats') return res.end(JSON.stringify({ items: state.chats }));
    const m = /^\/v1\/chats\/([^/]+)\/messages$/.exec(url.pathname);
    if (m) {
      const all = state.messages[decodeURIComponent(m[1]!)] ?? [];
      const cursor = url.searchParams.get('cursor');
      const items = cursor ? all.filter((x) => Number(x.sortKey) > Number(cursor)) : all;
      return res.end(JSON.stringify({ items: [...items].reverse(), hasMore: false }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('Beeper sense', () => {
  it('reads every chat by cursor, read or unread, skips the owner and Rufus, and carries chat metadata as features', async () => {
    const dir = await tempDir();
    const chat = (id: string, sortKey: string, extra: Record<string, unknown> = {}) => ({
      id,
      title: id === 'dm1' ? 'Mom' : 'Family',
      network: 'WhatsApp',
      type: id === 'dm1' ? 'single' : 'group',
      unreadCount: 0,
      participants: { items: [{ id: 'me', isSelf: true }] },
      preview: { id: `m${sortKey}`, sortKey },
      ...extra,
    });
    const state = {
      chats: [chat('dm1', '10'), chat('grp1', '20', { isMuted: true })],
      messages: {
        dm1: [{ id: 'm10', sortKey: '10', senderName: 'Mom', text: 'old', timestamp: '2026-11-26T10:00:00Z', type: 'TEXT' }],
        grp1: [{ id: 'm20', sortKey: '20', senderName: 'Alex', text: 'old group', timestamp: '2026-11-26T10:00:00Z', type: 'TEXT' }],
      } as Record<string, Array<Record<string, unknown>>>,
    };
    const api = await fakeBeeper(state);
    const conn = beeperConnector({ baseUrl: api.url, token: 't', statePath: path.join(dir, 'beeper.json'), recentSent: async () => ['Here is your summary, sir.'] });
    try {
      // First run only records where each chat stands.
      expect((await conn.poll() as { events: LosslessEvent[] }).events).toEqual([]);

      state.messages.dm1!.push(
        { id: 'm11', sortKey: '11', senderName: 'Mom', text: 'Call me when you can', timestamp: '2026-11-26T11:00:00Z', type: 'TEXT', isUnread: false },
        { id: 'm12', sortKey: '12', senderName: 'Owner', text: 'ok', timestamp: '2026-11-26T11:01:00Z', type: 'TEXT', isSender: true },
        { id: 'm13', sortKey: '13', senderName: 'Mom', timestamp: '2026-11-26T11:02:00Z', type: 'VOICE' },
      );
      state.messages.grp1!.push(
        { id: 'm21', sortKey: '21', senderName: 'Rufus', text: 'echo', timestamp: '2026-11-26T11:03:00Z', type: 'TEXT' },
        { id: 'm22', sortKey: '22', senderName: 'Alex', text: 'Here is your summary, sir.', timestamp: '2026-11-26T11:04:00Z', type: 'TEXT' },
        { id: 'm23', sortKey: '23', senderName: 'Alex', text: '@owner are you coming?', timestamp: '2026-11-26T11:05:00Z', type: 'TEXT', mentions: ['me'] },
      );
      state.chats = [chat('dm1', '13'), chat('grp1', '23', { isMuted: true })];
      const { events } = (await conn.poll()) as { events: LosslessEvent[] };
      expect(events.map((e) => e.text)).toEqual(['Call me when you can', '[voice note]', '@owner are you coming?']);
      const [mom, , group] = events;
      expect(mom!.id).toBe('beeper_dm1_m11');
      expect(mom!.audience).toMatchObject({ from: 'Mom', to: 'owner', chatType: 'dm', network: 'WhatsApp' });
      expect(group!.audience).toMatchObject({ to: 'group', chatType: 'group', chatTitle: 'Family' });
      expect(group!.metadata).toMatchObject({ isMuted: true, mentionsOwner: true, chatType: 'group' });
      expect(Bouncer.eventToFeatureText(group!)).toContain('chat:group | muted:true | mentions_owner:true');
      expect(api.requests.some((r) => r.includes('cursor=10&direction=after'))).toBe(true);

      // Nothing new: nothing emitted, and a fresh connector resumes from the saved cursors.
      expect(((await conn.poll()) as { events: LosslessEvent[] }).events).toEqual([]);
      const again = beeperConnector({ baseUrl: api.url, token: 't', statePath: path.join(dir, 'beeper.json') });
      expect(((await again.poll()) as { events: LosslessEvent[] }).events).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it('a Beeper error is a failed poll, not silence', async () => {
    const api = await fakeBeeper({ chats: [], messages: {} });
    await api.close();
    const hub = new HeartbeatHub();
    hub.add(beeperConnector({ baseUrl: api.url, token: 't' }));
    const { polls } = await hub.tick();
    expect(polls[0]).toMatchObject({ id: 'beeper', ok: false });
  });
});

describe('Calendar sense', () => {
  const NOW = new Date('2026-11-27T12:00:00Z');
  const H = 3_600_000;
  const item = (id: string, startMs: number, title = 'Study block') => ({
    id: `${id}@google.com|${new Date(startMs).toISOString()}`,
    title,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + H).toISOString(),
    calendar: 'Primary',
    allDay: false,
  });

  it('emits created, changed, deleted and upcoming events keyed by the calendar event id', () => {
    const t = NOW.getTime();
    const first = diffCalendar(undefined, [item('a', t + 5 * H), item('b', t + 6 * H)], NOW, 72 * H);
    expect(first.events).toEqual([]); // first look is a baseline

    const later = new Date(t + 4 * H + 40 * 60_000); // 20 min before "a"
    const next = diffCalendar(first.state, [item('a', t + 5 * H), item('c', t + 8 * H, 'Dentist'), item('b', t + 7 * H, 'Study block (moved)')], later, 72 * H);
    const kinds = next.events.map((e) => e.kind).sort();
    expect(kinds).toEqual(['event_changed', 'event_created', 'upcoming']);
    expect(next.events.find((e) => e.kind === 'event_changed')!.metadata).toMatchObject({ calendarEventId: 'b@google.com' });
    expect(next.events.find((e) => e.kind === 'upcoming')!.text).toMatch(/^Upcoming in ~20 min: Study block/);

    const gone = diffCalendar(next.state, [item('a', t + 5 * H), item('b', t + 7 * H, 'Study block (moved)')], new Date(later.getTime() + 60_000), 72 * H);
    expect(gone.events.map((e) => e.kind)).toEqual(['event_deleted']);
    // An event that slides into view at the far end of the window is not "created".
    const slid = diffCalendar(gone.state, [item('a', t + 5 * H), item('b', t + 7 * H, 'Study block (moved)'), item('z', later.getTime() + 90_000 + 72 * H)], new Date(later.getTime() + 2 * 60_000), 72 * H);
    expect(slid.events).toEqual([]);
  });
});

describe('Browser sense', () => {
  it('reads Yab history from a baseline, one event per new visit keyed by URL plus visit time', async () => {
    const dir = await tempDir();
    const hist = path.join(dir, 'history.json');
    const cocoa = (ms: number) => (ms - Date.UTC(2001, 0, 1)) / 1000;
    const t0 = Date.parse('2026-11-27T10:00:00Z');
    await fs.writeFile(hist, JSON.stringify([{ url: 'https://example.com/a', key: 'a', title: 'A', last: cocoa(t0), count: 1 }]));
    const conn = browserConnector({ sources: [{ browser: 'Yab', path: hist, format: 'yab' }], statePath: path.join(dir, 'state.json') });
    expect(((await conn.poll()) as { events: LosslessEvent[] }).events).toEqual([]);
    await fs.writeFile(
      hist,
      JSON.stringify([
        { url: 'https://example.com/a', key: 'a', title: 'A', last: cocoa(t0), count: 1 },
        { url: 'https://docs.example.com/checkout', key: 'b', title: 'Checkout docs', last: cocoa(t0 + 60_000), count: 1 },
      ]),
    );
    const { events } = (await conn.poll()) as { events: LosslessEvent[] };
    expect(events.map((e) => e.text)).toEqual(['Visited Checkout docs (https://docs.example.com/checkout)']);
    expect(events[0]!.timestamp).toBe(new Date(t0 + 60_000).toISOString());
  });
});

describe('Repos sense', () => {
  it('emits each new commit on any branch once', async () => {
    const dir = await tempDir();
    const repo = path.join(dir, 'app');
    await fs.mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'first');
    const conn = repoConnector({ repos: async () => [{ name: 'demo/app', dir: repo }], statePath: path.join(dir, 'state.json') });
    expect(((await conn.poll()) as { events: LosslessEvent[] }).events).toEqual([]);
    git('commit', '-q', '--allow-empty', '-m', 'Add checkout page');
    const { events } = (await conn.poll()) as { events: LosslessEvent[] };
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'repo', kind: 'commit', actor: 'Test' });
    expect(events[0]!.text).toMatch(/New commit in demo\/app.*: Add checkout page/);
    expect(((await conn.poll()) as { events: LosslessEvent[] }).events).toEqual([]);
  });
});

describe('Sense health', () => {
  it('tracks last success, failures, duplicates and parse failures, flags a broken sense once, and saves senses.json', async () => {
    const dir = await tempDir();
    let now = new Date('2026-11-27T12:00:00Z');
    const health = new SenseHealth(dir, () => now);
    const poll = (ok: boolean, extra: Record<string, unknown> = {}) => ({ id: 'gmail', intervalMs: 1000, at: now.toISOString(), ok, ms: 5, events: [], parseFailures: 0, ...extra });
    health.recordPoll(poll(true));
    const ev = (id: string) => genericEvent({ id, source: 'email', kind: 'unread', text: '{' });
    health.recordIngest('gmail', ev('a'), true);
    health.recordIngest('gmail', ev('a'), false);
    expect(health.snapshot().senses.gmail).toMatchObject({ status: 'ok', events24h: 1, repeats24h: 1, duplicates24h: 0 });
    for (const id of ['b', 'c', 'd', 'e', 'f']) health.recordIngest('gmail', ev(id), true);
    expect(health.snapshot().senses.gmail).toMatchObject({ status: 'broken', duplicates24h: 5 });
    expect(health.transitions().map((e) => e.kind)).toEqual(['sense_broken']);
    expect(health.transitions()).toEqual([]); // only on the change

    for (let i = 0; i < 3; i++) health.recordPoll(poll(false, { error: 'reader exited 1' }));
    expect(health.snapshot().senses.gmail!.consecutiveFailures).toBe(3);
    await health.save();
    const file = await readSensesFile(dir);
    expect(file?.senses.gmail?.lastError).toBe('reader exited 1');
    expect(assessSenses(file, ['gmail'], now).passed).toBe(false);

    now = new Date(now.getTime() + 25 * 3_600_000); // a day later the bad hour has rolled off
    const fresh = new SenseHealth(dir, () => now);
    await fresh.load();
    fresh.recordPoll(poll(true));
    fresh.recordIngest('gmail', genericEvent({ id: 'g', source: 'email', kind: 'unread', text: 'Real email' }), true);
    expect(fresh.transitions().map((e) => e.kind)).toEqual(['sense_recovered']);
    expect(assessSenses(fresh.snapshot(), ['gmail'], now)).toMatchObject({ passed: true });
    expect(assessSenses(undefined, ['gmail'], now).passed).toBe(false);
  });
});

describe('One inbox for wakes', () => {
  it('puts owner input first, batches it per route, and merges watch timers due within a few minutes', () => {
    const inbox = new WakeInbox();
    const sensed = genericEvent({ id: 'e1', source: 'email', kind: 'unread', text: 'mail' });
    const w1 = genericEvent({ id: 'w1', source: 'watch', kind: 'timer_due', text: 'a', timestamp: '2026-11-27T13:00:00Z' });
    const w2 = genericEvent({ id: 'w2', source: 'watch', kind: 'timer_due', text: 'b', timestamp: '2026-11-27T13:02:00Z' });
    const w3 = genericEvent({ id: 'w3', source: 'watch', kind: 'timer_due', text: 'c', timestamp: '2026-11-27T13:30:00Z' });
    inbox.push({ event: sensed });
    inbox.push({ event: w1 });
    inbox.push({ event: w2 });
    inbox.push({ event: w3 });
    inbox.push({ event: owner('one', 'tg_1') });
    inbox.push({ event: owner('voice', 'v_1'), route: 'voice' });
    inbox.push({ event: owner('two', 'tg_2') });

    const b1 = inbox.takeNow()!;
    expect([b1.first.event.id, ...b1.extras.map((i) => i.event.id)]).toEqual(['tg_1', 'tg_2']);
    expect(inbox.takeNow()!.first.event.id).toBe('v_1');
    expect(inbox.takeNow()!.first.event.id).toBe('e1');
    const watches = inbox.takeNow()!;
    expect([watches.first.event.id, ...watches.extras.map((i) => i.event.id)]).toEqual(['w1', 'w2']);
    expect(inbox.takeNow()!.first.event.id).toBe('w3');
    expect(inbox.takeNow()).toBeUndefined();
  });

  it('a running wake drains owner input on its own route only', () => {
    const inbox = new WakeInbox();
    inbox.push({ event: owner('text', 'tg_9') });
    inbox.push({ event: owner('spoken', 'v_9'), route: 'voice' });
    expect(inbox.drainOwner('voice').map((e) => e.id)).toEqual(['v_9']);
    expect(inbox.size).toBe(1);
  });

  it('fires timers due within a few minutes of a due one together', async () => {
    const dir = await tempDir();
    const store = new WatchStore(dir);
    const now = Date.now();
    await store.add({ kind: 'timer', label: 'due', fireAt: new Date(now - 1000).toISOString() });
    await store.add({ kind: 'timer', label: 'soon', fireAt: new Date(now + 2 * 60_000).toISOString() });
    await store.add({ kind: 'timer', label: 'later', fireAt: new Date(now + 30 * 60_000).toISOString() });
    const fired = await watchConnector(dir).poll();
    expect(fired.map((e) => e.text.split(': ').pop())).toEqual(['due', 'soon']);
  });
});

describe('Senses run apart from wakes', () => {
  it('keeps sensing while a long wake runs, lets new owner input join it, and skips events already handled', async () => {
    const dir = await tempDir();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let decideCalls = 0;
    const reasoning = new FakeProvider(
      topDown(async () => {
        decideCalls++;
        if (decideCalls === 1) await gate; // the first move takes "forever"
        return SLEEP_MOVE;
      }),
    );
    const core = new RufusCore({ workspaceDir: dir, reasoningProvider: reasoning, speakerProvider: new FakeProvider(() => 'ok'), sink: { send: async () => undefined } });
    await core.init();
    let n = 0;
    const hub = new HeartbeatHub();
    hub.add({ id: 'fake', intervalMs: 0, poll: async () => [genericEvent({ id: `fake_${++n}`, source: 'screen', kind: 'focus', text: `tick ${n}` })] });
    const stop = new AbortController();
    const rt = createSenseRuntime({ core, hub, signal: stop.signal, heartbeatMs: 60_000 });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const wakeDone = rt.ingest(owner('Do the long thing', 'tg_100'), { waitForWake: true });
    const running = rt.run();
    while (decideCalls < 1) await sleep(5);
    // The wake is blocked inside Decide; senses still poll and log.
    await rt.tickSenses();
    await rt.tickSenses();
    expect(await core.events.has('fake_1')).toBe(true);
    expect(await core.events.has('fake_2')).toBe(true);
    await rt.ingest(owner('Also do this', 'tg_101'));
    release();
    await wakeDone;
    // The second message joined the running wake as an arrival instead of waiting for its own.
    const prompts = reasoning.calls.map((c) => c.prompt).join('\n');
    expect(prompts).toContain('Also do this');
    expect(rt.inbox.size).toBeLessThanOrEqual(2);
    // The same Telegram message delivered again (after a restart) is not handled twice.
    expect(await rt.ingest(owner('Do the long thing', 'tg_100'))).toBeUndefined();
    const res = await core.processEvent(owner('Do the long thing', 'tg_100'));
    expect(res.alreadySeen).toBe(true);
    expect(res.wake).toBeUndefined();
    stop.abort();
    await running;
    await core.close();
  });

  it('tells the owner when a wake on his message crashes, and keeps going', async () => {
    const dir = await tempDir();
    const sent: string[] = [];
    const reasoning = new FakeProvider(() => {
      throw new Error('model exploded');
    });
    const core = new RufusCore({ workspaceDir: dir, reasoningProvider: reasoning, speakerProvider: new FakeProvider(() => 'ok'), sink: { send: async (t) => void sent.push(t) } });
    await core.init();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(core, 'processEvent').mockRejectedValueOnce(new Error('wake crashed')).mockRejectedValueOnce(new Error('wake crashed'));
    const stop = new AbortController();
    const rt = createSenseRuntime({ core, hub: new HeartbeatHub(), signal: stop.signal, heartbeatMs: 60_000, failureSink: { send: async (t) => void sent.push(t) } });
    const done = rt.ingest(owner('Please do X', 'tg_200'), { waitForWake: true });
    const running = rt.run();
    await done;
    expect(sent).toContain(WAKE_FAILURE_NOTE);
    // Logged like any message Rufus sends, so the next wake knows the owner was told.
    await vi.waitFor(async () => expect((await core.events.recent(50)).some((e) => e.kind === 'assistant_sent' && e.text === WAKE_FAILURE_NOTE)).toBe(true));
    stop.abort();
    await running;
    await core.close();
  });
});

describe('Voice turn-taking', () => {
  it('drops sound-only transcripts and merges a burst of utterances into one owner turn', async () => {
    expect(isNonSpeech('(keyboard clicking)')).toBe(true);
    expect(isNonSpeech('[plop] ...')).toBe(true);
    expect(isNonSpeech('Also, (cough) starting at noon')).toBe(false);

    const turns: LosslessEvent[] = [];
    const tts = { voice: 'test', synthesize: async () => ({ ok: false }), clipPath: () => '' } as unknown as KokoroTts;
    const handler = createVoiceHttpHandler({ tts, turnHoldMs: 80, onVoiceTurn: async (ev) => void turns.push(ev) });
    const server = http.createServer((req, res) => void handler(req, res, new URL(req.url ?? '/', 'http://x').pathname));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/voice/turn`;
    const say = async (text: string) => (await fetch(url, { method: 'POST', body: JSON.stringify({ text }) })).json() as Promise<Record<string, unknown>>;
    try {
      expect(await say('Also,')).toMatchObject({ held: true });
      expect(await say('(keyboard clicking)')).toMatchObject({ ignored: 'no speech' });
      await say('starting at noon, block my calendar');
      await waitFor(() => turns.length > 0);
      expect(turns.map((t) => t.text)).toEqual(['Also, starting at noon, block my calendar']);
      expect(turns[0]!.kind).toBe('owner_direct');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Telegram reactions and edits', () => {
  it('senses edits and reactions, keeps the update offset on disk, and turns a reaction into feedback', async () => {
    const dir = await tempDir();
    const offsetPath = path.join(dir, 'tg-offset');
    const urls: string[] = [];
    const updates = [
      { update_id: 500, edited_message: { message_id: 7, date: 1_795_000_000, edit_date: 1_795_000_100, text: 'Meet at 4, not 3', chat: { id: 1 }, from: { first_name: 'Owner' } } },
      { update_id: 501, message_reaction: { chat: { id: 1 }, message_id: 99, date: 1_795_000_200, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👎' }] } },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes('/sendMessage')) return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }));
        return new Response(JSON.stringify({ ok: true, result: urls.filter((u) => u.includes('getUpdates')).length === 1 ? updates : [] }));
      }),
    );
    const tg = new TelegramChannel({ token: 'x', chatId: '1', offsetPath });
    await tg.send('Your inbox has three urgent emails.');
    const events = await tg.poll(0);
    expect(decodeURIComponent(urls.find((u) => u.includes('getUpdates'))!)).toContain('"message_reaction"');
    expect(events.map((e) => e.kind)).toEqual(['owner_direct', 'owner_reaction']);
    expect(events[0]).toMatchObject({ id: 'tg_7_edit_1795000100', metadata: { editOf: 'tg_7' } });
    expect(events[1]!.text).toContain('reacted 👎 to your message: "Your inbox has three urgent emails."');
    expect(await fs.readFile(offsetPath, 'utf8')).toBe('502');
    // A restarted channel resumes after the last update instead of replaying it.
    const tg2 = new TelegramChannel({ token: 'x', chatId: '1', offsetPath });
    await tg2.poll(0);
    expect(urls[urls.length - 1]).toContain('offset=502');

    // The reaction goes to recordFeedback on Rufus's own message, and becomes a Speaker label.
    const sentEv = genericEvent({ id: 'sent_1', source: 'message', kind: 'assistant_sent', actor: 'rufus', text: 'Your inbox has three urgent emails.' });
    const labels: Array<[string, string]> = [];
    const deps = { workspaceDir: dir, findSent: async (t: string) => (t === sentEv.text ? sentEv : undefined), recordFeedback: async (e: LosslessEvent, f: string) => void labels.push([e.id, f]) };
    expect(await recordReactionFeedback({ ...deps, reaction: events[1]! })).toEqual({ label: 'pushback', sentId: 'sent_1' });
    expect(await fs.readFile(path.join(dir, 'training', 'speaker.jsonl'), 'utf8')).toContain('"label":"bad"');

    // An edit to a message Rufus already answered supersedes that answer.
    await fs.writeFile(path.join(dir, 'wakes.jsonl'), `${JSON.stringify({ wakeId: 'w1', at: new Date().toISOString(), trigger: { id: 'tg_7', source: 'message', kind: 'owner_direct', text: 'Meet at 3' }, sentMessages: [sentEv.text] })}\n`);
    expect(await recordEditFeedback({ ...deps, edit: events[0]! })).toEqual({ superseded: ['sent_1'] });
    expect(labels).toEqual([
      ['sent_1', 'pushback'],
      ['sent_1', 'pushback'],
    ]);
  });
});
