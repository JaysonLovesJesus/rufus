import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChiefOfStaff,
  Engine,
  FakeProvider,
  MasterLoop,
  ToolRegistry,
  UnifiedDaemon,
  cancelMission,
  createMission,
  formatMissionList,
  listMissions,
  loadMission,
  missionToolRegistry,
  parseMissionReply,
  resolveMission,
  runMission,
  saveMission,
  MAX_MISSION_STEPS,
  MISSIONS_DIR,
  type AiRequest,
  type ChatTurn,
  type IncomingMessage,
  type LiveChannel,
  type ToolDefinition,
} from '../src';
import { main, type Io } from '../src/cli';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 10, 0); // a Wednesday, 10am local
const clock = () => NOW;

/** Read-only and side-effect tools, each recording its calls. */
function fakeTools() {
  const calls: Array<{ tool: string; args: unknown; stage?: string }> = [];
  const tool = (name: string, readOnly: boolean, out: (args: Record<string, unknown>) => unknown, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
    name,
    description: `${name} tool`,
    readOnly,
    ...extra,
    execute(args, ctx) {
      calls.push({ tool: name, args, ...(ctx.stage ? { stage: ctx.stage } : {}) });
      return out(args);
    },
  });
  const tools = new ToolRegistry({
    tools: [
      tool('web.search', true, () => [
        { title: 'United nonstop to Denver', url: 'https://www.united.com/den', snippet: 'Nonstop, lands 2pm. From $320.' },
        { title: 'Frontier to Denver', url: 'https://flyfrontier.com/den', snippet: '1 stop, lands 7pm. From $180.' },
      ]),
      tool('web.fetch', true, (a) => ({ url: a.url, finalUrl: a.url, title: 'United', text: 'Fares from $320. Nonstop.', truncated: false })),
      tool('calendar.read', true, () => [{ title: 'Team sync', start: '16:00', end: '17:00' }]),
      tool('beeper.send', false, () => ({ sent: true }), { sensitivity: ['external'] }),
      tool('shell.run', false, () => 'ran', { sensitivity: ['external'] }),
      tool('calendar.write', false, () => ({ ok: true })),
    ],
  });
  return { tools, calls, sideEffects: () => calls.filter((c) => ['beeper.send', 'shell.run', 'calendar.write'].includes(c.tool)) };
}

const step = (o: unknown): string => JSON.stringify(o);

describe('v22: the mission store', () => {
  it('create, load, list (newest first), cancel, and it all survives a reload from disk', async () => {
    const dir = await tempDir();
    const a = await createMission(dir, { goal: '  Research   flights to Denver ', context: 'must land before 4pm' }, new Date(2026, 10, 25, 9, 0));
    const b = await createMission(dir, { goal: 'Prep a brief for the board meeting', maxSteps: 50 }, new Date(2026, 10, 25, 9, 5));
    expect(a).toMatchObject({ goal: 'Research flights to Denver', context: 'must land before 4pm', status: 'queued', steps: [], maxSteps: 6 });
    expect(a.id).toMatch(/^m-[0-9a-f]{6}$/);
    expect(b.maxSteps).toBe(MAX_MISSION_STEPS);
    expect(JSON.parse(await readFile(path.join(dir, MISSIONS_DIR, `${a.id}.json`), 'utf8'))).toEqual(a);

    expect((await listMissions(dir)).map((m) => m.id)).toEqual([b.id, a.id]);
    expect(await loadMission(dir, a.id)).toEqual(a);
    expect(await loadMission(dir, 'm-nothere')).toBeUndefined();
    expect(await loadMission(dir, '../../etc/passwd')).toBeUndefined(); // never a path outside missions/
    await expect(saveMission(dir, { ...a, id: '../../evil' })).rejects.toThrow('Not a mission id');

    // A unique prefix (with or without "m-") finds it.
    expect((await resolveMission(dir, a.id.slice(2, 6))).id).toBe(a.id);
    await expect(resolveMission(dir, 'zzzz')).rejects.toThrow(/No mission "zzzz"\. Open: /);

    const c = await cancelMission(dir, a.id, NOW);
    expect(c).toMatchObject({ cancelled: true, record: { status: 'cancelled', finishedAt: NOW.toISOString() } });
    expect((await cancelMission(dir, a.id, NOW)).cancelled).toBe(false); // already ended: unchanged
    expect((await loadMission(dir, a.id))!.status).toBe('cancelled');
    expect((await listMissions(dir, { status: 'queued' })).map((m) => m.id)).toEqual([b.id]);
    expect(await listMissions(dir, { limit: 1 })).toHaveLength(1);

    await saveMission(dir, { ...b, steps: [{ at: NOW.toISOString(), tool: 'web.search', args: { query: 'x' }, ok: true, preview: '[]' }] });
    expect((await loadMission(dir, b.id))!.steps).toHaveLength(1);
    await expect(createMission(dir, { goal: '   ' })).rejects.toThrow('needs a goal');
  });

  it('formats the list for chat', async () => {
    const dir = await tempDir();
    expect(await formatMissionList(dir)).toMatch(/^Nothing in the works right now/);
    const m = await createMission(dir, { goal: 'flights to Denver' }, NOW);
    expect(await formatMissionList(dir)).toBe(`Working on 1 thing:\n- flights to Denver (${m.id}, queued)\nSay "cancel mission ${m.id}" to stop one.`);
  });

  it('reads model steps: a tool call, a finish, or plain prose as the summary', () => {
    expect(parseMissionReply('{"tool":"web.search","args":{"query":"x"}}')).toEqual({ kind: 'tool', tool: 'web.search', args: { query: 'x' } });
    expect(parseMissionReply('TOOL_CALL: {"tool":"calendar.read"}')).toEqual({ kind: 'tool', tool: 'calendar.read', args: {} });
    expect(parseMissionReply('```json\n{"done":true,"summary":"All set.","card":{"question":"q"}}\n```')).toEqual({ kind: 'done', summary: 'All set.', card: { question: 'q' } });
    expect(parseMissionReply('Here is what I found.')).toEqual({ kind: 'done', summary: 'Here is what I found.' });
  });
});

describe('v22: running a mission', () => {
  it('multi-step research with read-only tools ends in a Beeper-safe Decision Card, saved after every step', async () => {
    const dir = await tempDir();
    const { tools, calls } = fakeTools();
    const m = await createMission(dir, { goal: 'Find me a flight to Denver on Friday', context: 'must land before my 4pm' }, NOW);
    const seen: number[] = [];
    const provider = new FakeProvider(async (req: AiRequest, n) => {
      if (n > 0) seen.push((await loadMission(dir, m.id))!.steps.length); // progress is on disk before the next step
      return [
        step({ tool: 'calendar.read', args: {} }),
        step({ tool: 'web.search', args: { query: 'flights NYC to Denver Friday' } }),
        step({ tool: 'web.fetch', args: { url: 'https://www.united.com/den' } }),
        step({
          done: true,
          summary: 'Two **solid** options; United gets you there before your 4pm.',
          card: {
            question: 'Flights to Denver',
            options: [
              { name: 'United nonstop', summary: '$320, lands 2pm', url: 'https://www.united.com/den' },
              { name: 'Frontier 1 stop', summary: '$180, lands 7pm', url: 'https://flyfrontier.com/den' },
            ],
            pick: 'A',
            why: 'Lands before your 4pm.',
            next: 'Want me to hold the United fare?',
          },
        }),
      ][n]!;
    });
    const done = await runMission({ dir, id: m.id, tools, provider, now: clock });
    expect(seen).toEqual([1, 2, 3]);
    expect(done.status).toBe('completed');
    expect(done.steps.map((s) => [s.tool, s.ok])).toEqual([
      ['calendar.read', true],
      ['web.search', true],
      ['web.fetch', true],
    ]);
    expect(calls.every((c) => c.stage === 'execute')).toBe(true);
    expect(done.resultText).toBe(
      [
        'Two solid options; United gets you there before your 4pm.',
        '',
        'Flights to Denver',
        'A: United nonstop, $320, lands 2pm (united.com)',
        'B: Frontier 1 stop, $180, lands 7pm (flyfrontier.com)',
        'Pick: A. Lands before your 4pm.',
        'Next: Want me to hold the United fare?',
      ].join('\n'),
    );
    expect(done.resultText!.length).toBeLessThanOrEqual(900);
    expect(done.resultText).not.toMatch(/[|*#`]/);
    expect(await loadMission(dir, m.id)).toEqual(done);
    // The model only ever saw the read-only tools.
    expect(provider.calls[0]!.system).toContain('- web.search:');
    expect(provider.calls[0]!.system).not.toMatch(/beeper\.send|shell\.run|calendar\.write/);
    expect(provider.calls[0]!.messages[0]!.content).toContain('Context: must land before my 4pm');
  });

  it('a card made of sources goes through buildDecisionCard (sources found during the mission are used)', async () => {
    const dir = await tempDir();
    const { tools } = fakeTools();
    const m = await createMission(dir, { goal: 'Cheapest way to Denver' }, NOW);
    const provider = new FakeProvider([
      step({ tool: 'web.search', args: { query: 'Denver flights' } }),
      step({ done: true, summary: 'Frontier is cheapest.', card: { question: 'Denver: cheapest flight' } }),
      // buildDecisionCard's own model call
      step({ a: { name: 'Frontier', summary: '$180, 1 stop', source: 2 }, b: { name: 'United', summary: '$320 nonstop', source: 1 }, pick: 'A', why: 'Cheapest by $140.', next: 'Book on flyfrontier.com?' }),
    ]);
    const done = await runMission({ dir, id: m.id, tools, provider, now: clock });
    expect(done.resultText).toBe('Frontier is cheapest.\n\nDenver: cheapest flight\nA: Frontier, $180, 1 stop (flyfrontier.com)\nB: United, $320 nonstop (united.com)\nPick: A. Cheapest by $140.\nNext: Book on flyfrontier.com?');
    expect(provider.calls[2]!.messages[0]!.content).toContain('https://flyfrontier.com/den');
  });

  it('IRONCLAD: a mission can never run a side-effect tool, whatever the model asks for', async () => {
    const dir = await tempDir();
    const { tools, calls, sideEffects } = fakeTools();
    expect(missionToolRegistry(tools).list().map((t) => t.name)).toEqual(['calendar.read', 'web.fetch', 'web.search']);
    const m = await createMission(dir, { goal: 'Tell Sam I am late', maxSteps: 4 }, NOW);
    const provider = new FakeProvider([
      step({ tool: 'beeper.send', args: { chatId: 'c-sam', text: 'running late' } }),
      step({ tool: 'shell.run', args: { cmd: 'rm -rf /' } }),
      'TOOL_CALL: {"tool":"calendar.write","args":{"title":"x"}}',
      step({ done: true, summary: "I can't send messages from a mission; want me to draft one?" }),
    ]);
    const done = await runMission({ dir, id: m.id, tools, provider, now: clock });
    expect(sideEffects()).toEqual([]);
    expect(calls).toEqual([]);
    expect(done.status).toBe('completed');
    expect(done.steps.map((s) => [s.tool, s.ok, s.preview])).toEqual([
      ['beeper.send', false, 'blocked: beeper.send is not read-only, and missions never act'],
      ['shell.run', false, 'blocked: shell.run is not read-only, and missions never act'],
      ['calendar.write', false, 'blocked: calendar.write is not read-only, and missions never act'],
    ]);
    expect(provider.calls[1]!.messages.at(-1)!.content).toContain('NOT RUN: blocked: beeper.send is not read-only');
    // Even a tool that lies about its name prefix or carries a sensitivity is kept out.
    const sneaky = new ToolRegistry({ tools: [{ name: 'gmail.read', description: 'x', readOnly: true, sensitivity: ['login'], execute: () => 'x' }, { name: 'mission.list', description: 'x', readOnly: true, execute: () => [] }] });
    expect(missionToolRegistry(sneaky).list()).toEqual([]);
  });

  it('cancellation stops a running mission before the next step', async () => {
    const dir = await tempDir();
    const { tools, calls } = fakeTools();
    const m = await createMission(dir, { goal: 'Research tents' }, NOW);
    const provider = new FakeProvider(async (_req, n) => {
      if (n === 1) await cancelMission(dir, m.id, NOW); // the user cancels while step 2 is being decided
      return step({ tool: 'web.search', args: { query: `tents ${n}` } });
    });
    const done = await runMission({ dir, id: m.id, tools, provider, now: clock });
    expect(done.status).toBe('cancelled');
    expect(calls.map((c) => c.tool)).toEqual(['web.search']); // the step after the cancel never ran
    expect(provider.calls).toHaveLength(2);
    expect((await loadMission(dir, m.id))!).toMatchObject({ status: 'cancelled', steps: [{ tool: 'web.search', ok: true }] });
    // Cancelled before it starts: nothing runs at all.
    const q = await createMission(dir, { goal: 'Never mind' }, NOW);
    await cancelMission(dir, q.id, NOW);
    expect((await runMission({ dir, id: q.id, tools, provider: new FakeProvider([]), now: clock })).status).toBe('cancelled');
  });

  it('bounded: out of steps it finishes from what it found; a model failure ends it failed', async () => {
    const dir = await tempDir();
    const { tools } = fakeTools();
    const m = await createMission(dir, { goal: 'Denver flights', maxSteps: 2 }, NOW);
    const provider = new FakeProvider(() => step({ tool: 'web.search', args: { query: 'again' } }));
    const done = await runMission({ dir, id: m.id, tools, provider, now: clock });
    expect(done.status).toBe('completed');
    expect(done.steps).toHaveLength(2);
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[2]!.messages.at(-1)!.content).toContain('No tool calls left');
    expect(done.resultText).toContain('ran out of steps');
    expect(done.resultText).toContain('A: United nonstop to Denver');

    const f = await createMission(dir, { goal: 'Broken' }, NOW);
    const failed = await runMission({ dir, id: f.id, tools, provider: new FakeProvider(() => Promise.reject(new Error('model down'))), now: clock });
    expect(failed).toMatchObject({ status: 'failed', error: 'model down' });
  });
});

// ---------- the daemon ----------

class Chat implements LiveChannel {
  sent: string[] = [];
  inbox: IncomingMessage[] = [];
  private n = 0;
  say(text: string) {
    this.inbox.push({ id: `u${++this.n}`, text, at: new Date(NOW.getTime() + this.n * 1000).toISOString() });
  }
  async send(text: string) {
    this.sent.push(text);
  }
  async poll() {
    const out = this.inbox;
    this.inbox = [];
    return out;
  }
}

async function daemonSetup(provider: FakeProvider, start = NOW) {
  const dir = await tempDir();
  let t = start;
  const now = () => t;
  const chat = new Chat();
  const { tools, calls, sideEffects } = fakeTools();
  const engine = new Engine({ store: dir, provider });
  const loop = new MasterLoop({ dir, sensors: [], handlers: [], tools, now });
  const daemon = new UnifiedDaemon({ loop, engine, channel: chat, heartbeat: false, calendarSync: false, bubblePauseMs: 0, now });
  return { dir, chat, daemon, calls, sideEffects, set: (d: Date) => void (t = d) };
}

const history = async (dir: string): Promise<ChatTurn[]> =>
  (await readFile(path.join(dir, 'chat-history.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as ChatTurn);

describe('v22: missions in rufus start', () => {
  it('chat starts a mission (mission.start), the daemon runs it in the background, and delivers the result exactly once', async () => {
    let missionId = '';
    const provider = new FakeProvider(async (req) => {
      if (req.meta.flowId === 'chief') {
        if (!req.messages.some((m) => m.content.startsWith('TOOL_RESULT'))) return 'TOOL_CALL: {"tool":"mission.start","args":{"goal":"Research standing desks under $500","context":"small apartment"}}';
        missionId = /"id":"(m-[0-9a-f]+)"/.exec(req.messages.at(-1)!.content)![1]!;
        return "On it — I'll dig into standing desks and ping you when I have options ready.";
      }
      // the mission's own steps
      if (req.meta.step === 'mission.0') return step({ tool: 'web.search', args: { query: 'standing desk under $500' } });
      return step({ done: true, summary: 'Two good fits under $500 for a small space.', card: { question: 'Standing desk', options: [{ name: 'Desk One', summary: '$399, 48in' }, { name: 'Desk Two', summary: '$449, 42in' }], pick: 'B', why: 'Fits a small apartment.', next: 'Want the link?' } });
    });
    const s = await daemonSetup(provider);
    await s.daemon.tick(); // first pass: starts listening
    s.chat.say('research standing desks under $500 and get back to me');
    const r1 = await s.daemon.tick();
    expect(s.chat.sent).toEqual(["On it — I'll dig into standing desks and ping you when I have options ready."]);
    expect(missionId).toMatch(/^m-/);
    expect(r1.missions).toEqual({ started: [missionId], delivered: [] });

    const finished = await s.daemon.drainMissions();
    expect(finished.map((m) => [m.id, m.status])).toEqual([[missionId, 'completed']]);
    expect(s.daemon.runningMissions()).toEqual([]);
    expect((await loadMission(s.dir, missionId))!.delivered).toBeUndefined();

    const r2 = await s.daemon.tick();
    expect(r2.missions).toEqual({ started: [], delivered: [missionId] });
    expect(s.chat.sent).toHaveLength(2);
    expect(s.chat.sent[1]).toBe('Done digging into "Research standing desks under $500":\nTwo good fits under $500 for a small space.\n\nStanding desk\nA: Desk One, $399, 48in\nB: Desk Two, $449, 42in\nPick: B. Fits a small apartment.\nNext: Want the link?');
    expect(r2.proactive).toEqual([s.chat.sent[1]]);
    expect((await loadMission(s.dir, missionId))!.delivered).toBe(true);
    expect((await history(s.dir)).at(-1)).toMatchObject({ role: 'assistant', text: s.chat.sent[1], proactive: true });

    // Never twice: more passes say nothing more.
    await s.daemon.tick();
    await s.daemon.tick();
    expect(s.chat.sent).toHaveLength(2);
    expect(s.sideEffects()).toEqual([]);
  });

  it('runs one mission at a time by default, oldest first, without blocking the tick', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = new FakeProvider(async (req) => {
      await gate;
      return step({ done: true, summary: `done ${req.meta.runId}` });
    });
    const s = await daemonSetup(provider);
    const a = await createMission(s.dir, { goal: 'first' }, new Date(NOW.getTime() - 2000));
    const b = await createMission(s.dir, { goal: 'second' }, new Date(NOW.getTime() - 1000));
    const r1 = await s.daemon.tick(); // returns while the mission is still waiting on the model
    expect(r1.missions?.started).toEqual([a.id]);
    expect(s.daemon.runningMissions()).toEqual([a.id]);
    expect((await s.daemon.tick()).missions).toBeUndefined(); // still busy: b waits
    release();
    await s.daemon.drainMissions();
    const r3 = await s.daemon.tick();
    expect(r3.missions).toEqual({ started: [b.id], delivered: [a.id] });
    await s.daemon.drainMissions();
    expect((await s.daemon.tick()).missions).toEqual({ started: [], delivered: [b.id] });
    expect(s.chat.sent.map((t) => t.split('\n')[0])).toEqual(['Done digging into "first":', 'Done digging into "second":']);
  });

  it('a mission left running by a crash resumes; results wait out quiet hours unless urgent; failures are said once', async () => {
    const provider = new FakeProvider((req) => (req.meta.runId === 'broken' ? Promise.reject(new Error('x')) : step({ done: true, summary: 'Brief ready.' })));
    const night = new Date(2026, 10, 25, 23, 30);
    const s = await daemonSetup(provider, night);
    const orphan = await createMission(s.dir, { goal: 'Prep the board brief' }, NOW);
    await saveMission(s.dir, { ...orphan, status: 'running', startedAt: NOW.toISOString(), steps: [{ at: NOW.toISOString(), tool: 'calendar.read', args: {}, ok: true, preview: '[]' }] });
    expect((await s.daemon.tick()).missions?.started).toEqual([orphan.id]);
    await s.daemon.drainMissions();
    expect(provider.calls[0]!.messages[0]!.content).toContain('Steps already done before a restart');
    expect((await loadMission(s.dir, orphan.id))!.status).toBe('completed');

    await s.daemon.tick(); // quiet hours: held
    expect(s.chat.sent).toEqual([]);
    const urgent = await createMission(s.dir, { goal: 'Check the 6am flight status', urgent: true }, night);
    await s.daemon.tick();
    await s.daemon.drainMissions();
    await s.daemon.tick();
    expect(s.chat.sent).toEqual(['Done digging into "Check the 6am flight status":\nBrief ready.']);
    expect((await loadMission(s.dir, urgent.id))!.delivered).toBe(true);
    expect((await loadMission(s.dir, orphan.id))!.delivered).toBeUndefined();

    s.set(new Date(2026, 10, 26, 9, 0)); // morning: the held one goes out
    await s.daemon.tick();
    expect(s.chat.sent[1]).toBe('Done digging into "Prep the board brief":\nBrief ready.');

    // A failed mission is announced once, honestly.
    const f = await createMission(s.dir, { goal: 'Broken one' }, new Date(2026, 10, 26, 9, 0));
    await saveMission(s.dir, { ...f, status: 'failed', error: 'model down', finishedAt: new Date(2026, 10, 26, 9, 0).toISOString() });
    await s.daemon.tick();
    await s.daemon.tick();
    expect(s.chat.sent.slice(2)).toEqual([`I couldn't finish "Broken one" (${f.id}): model down. Want me to try again?`]);
  });

  it('"missions", "what are you working on?" and "cancel mission <id>" are answered by code at $0', async () => {
    const provider = new FakeProvider([]); // any model call would throw
    const dir = await tempDir();
    const engine = new Engine({ store: dir, provider });
    const loop = new MasterLoop({ dir, sensors: [], handlers: [], now: clock });
    const chief = new ChiefOfStaff({ engine, loop, now: clock });
    const m = await createMission(dir, { goal: 'Research tents' }, NOW);

    for (const ask of ['missions', 'What are you working on?', "what're you working on"]) {
      const r = await chief.handle(ask);
      expect(r.via).toBe('command');
      expect(r.text).toContain(`Research tents (${m.id}, queued)`);
    }
    expect((await chief.handle(`cancel mission ${m.id}`)).text).toBe(`Stopped: Research tents (${m.id}, cancelled).`);
    expect((await loadMission(dir, m.id))!.status).toBe('cancelled');
    expect((await chief.handle(`cancel mission ${m.id}`)).text).toBe(`That one already ended: Research tents (${m.id}, cancelled).`);
    expect((await chief.handle('cancel mission')).text).toBe('Nothing is running right now.');
    const n = await createMission(dir, { goal: 'Prep brief' }, NOW);
    expect((await chief.handle('stop the mission')).text).toBe(`Stopped: Prep brief (${n.id}, cancelled).`);
    expect((await chief.handle('cancel mission zzzz')).text).toMatch(/^Couldn't do that: No mission "zzzz"/);
    expect(provider.calls).toEqual([]);
  });

  it('missions: false turns it off (no tools, nothing runs)', async () => {
    const dir = await tempDir();
    const engine = new Engine({ store: dir, provider: new FakeProvider([]) });
    const loop = new MasterLoop({ dir, sensors: [], handlers: [], now: clock });
    const daemon = new UnifiedDaemon({ loop, engine, heartbeat: false, calendarSync: false, missions: false, output: () => undefined, now: clock });
    expect(loop.tools.has('mission.start')).toBe(false);
    await createMission(dir, { goal: 'x' }, NOW);
    expect((await daemon.tick()).missions).toBeUndefined();
    expect((await listMissions(dir))[0]!.status).toBe('queued');
  });
});

describe('v22: rufus missions', () => {
  it('list, start, show and cancel from the terminal', async () => {
    const dir = await tempDir();
    const out: string[] = [];
    const io: Io = { out: (l) => out.push(l), err: (l) => out.push(l) };
    await main(['--dir', dir, 'missions'], io, { now: clock });
    expect(out.pop()).toMatch(/^Nothing in the works/);
    await main(['--dir', dir, 'missions', 'start', 'research', 'standing', 'desks', '--context', 'under $500'], io, { now: clock });
    const id = /Queued mission (m-[0-9a-f]+): research standing desks\./.exec(out.pop()!)![1]!;
    expect((await loadMission(dir, id))!.context).toBe('under $500');
    await main(['--dir', dir, 'missions', 'show', id], io, { now: clock });
    expect(out).toContain(`research standing desks (${id}, queued)`);
    await main(['--dir', dir, 'missions', 'cancel', id], io, { now: clock });
    expect(out.pop()).toBe(`Cancelled ${id}.`);
    await main(['--dir', dir, 'missions', 'list'], io, { now: clock });
    expect(out.join('\n')).toContain(`research standing desks (${id}, cancelled)`);
    const help: string[] = [];
    await main(['--help'], { out: (l) => help.push(l), err: () => undefined });
    expect(help.join('\n')).toMatch(/\n {2}missions \[list/);
  });
});
