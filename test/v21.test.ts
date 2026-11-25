import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_FILE,
  BeeperApi,
  ChiefOfStaff,
  Engine,
  FakeProvider,
  MasterLoop,
  ToolError,
  ToolGatedError,
  ToolRegistry,
  TrustStore,
  UnifiedDaemon,
  appendAudit,
  beeperTools,
  buildTools,
  demoteAction,
  formatAuditSummary,
  formatAutoNotice,
  formatTrust,
  loadAudit,
  parseAutonomyCommand,
  pauseAutonomy,
  resumeAutonomy,
  setTrustMode,
  trustMode,
  type IncomingMessage,
  type LiveChannel,
  type LoopSignal,
  type Sensor,
  type SignalHandler,
  type ToolContext,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 14, 0);
const HOUR = 3_600_000;
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ dir: '/tmp', now: NOW, ...over });

function capture() {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) } };
}

/** A fake Beeper Desktop API: records every request; `fail` answers every POST with that status. */
function fakeBeeper(opts: { fail?: number; down?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    if (opts.down) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'POST' && opts.fail) return new Response('nope', { status: opts.fail });
    if (method === 'GET') return Response.json({ items: [] });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { fetch: f, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

/** Hands out its signals once. */
const onceSensor = (signals: LoopSignal[]): Sensor => ({ id: 'test', surface: 'chat', poll: (cursor) => (cursor ? { signals: [] } : { signals, nextCursor: 'done' }) });
const reactSignal = (id = '1'): LoopSignal => ({ id, surface: 'chat', kind: 'react.request', text: 'haha that is hilarious', actor: 'Mom', data: { chatId: 'c-mom', messageId: `m${id}` } });

/** Reacts 😂 to a message through `beeper.react` (declared in `uses`). */
const reactHandler = (over: Partial<SignalHandler> = {}): SignalHandler => ({
  id: 'react',
  match: { kind: 'react.request' },
  plan: () => ({ goal: 'React to the message', actionType: 'chat.react', route: 'code', uses: ['beeper.react'] }),
  execute: (_p, s) => ({ chatId: s.data!.chatId, messageId: s.data!.messageId, emoji: '😂', to: 'Mom' }),
  async commit(out, _p, _s, c) {
    await c.tools.call('beeper.react', out as Record<string, unknown>);
  },
  ...over,
});

async function reactLoop(over: { handler?: SignalHandler; signals?: LoopSignal[]; fail?: number } = {}) {
  const dir = await tempDir();
  const b = fakeBeeper({ ...(over.fail ? { fail: over.fail } : {}) });
  const loop = new MasterLoop({ dir, sensors: [onceSensor(over.signals ?? [reactSignal()])], handlers: [over.handler ?? reactHandler()], tools: new ToolRegistry({ tools: beeperTools({ fetch: b.fetch }) }), now: () => NOW });
  return { dir, b, loop, first: async () => loop.getRun((await loop.runOnce()).runs[0]!.runId) };
}

// ---------- 1. the graduated ladder ----------

describe('v21 graduated trust ladder', () => {
  it('reads a pre-v21 trust.json unchanged, keeps the new rungs, and treats an unknown rung as check', async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'trust.json'),
      JSON.stringify({
        version: 1,
        actions: {
          'reply.chat': { autonomy: 'autonomous', accepted: 12, consecutiveClean: 12 },
          'schedule.block': { autonomy: 'check', accepted: 1 },
          'chat.react': { autonomy: 'auto_notify', coversExternal: true },
          'social.post': { autonomy: 'blocked' },
          'odd.one': { autonomy: 'yolo' },
        },
      }),
    );
    const trust = new TrustStore(dir);
    expect(await trust.get('reply.chat')).toMatchObject({ autonomy: 'autonomous', accepted: 12 });
    expect((await trust.get('reply.chat')).coversExternal).toBeUndefined(); // pre-v21: external still asks
    expect(await trust.get('chat.react')).toMatchObject({ autonomy: 'auto_notify', coversExternal: true });
    expect(await trust.mode('social.post')).toBe('blocked');
    expect(await trust.mode('odd.one')).toBe('check');
    expect(await trust.mode('never.seen')).toBe('check');
    expect(formatTrust(await trust.all()).join('\n')).toContain('chat.react  auto_notify (incl. external)');
  });

  it('promotes up the ladder only when the human says so; a rejection drops auto_notify or autonomous straight to check', async () => {
    const dir = await tempDir();
    const trust = new TrustStore(dir, { promotionThreshold: 2 });
    expect((await trust.get('chat.react')).autonomy).toBe('check'); // everything starts at check
    await trust.recordFeedback('chat.react', 'accept');
    const second = await trust.recordFeedback('chat.react', 'accept');
    expect(second).toMatchObject({ promotionNewlySuggested: true, record: { autonomy: 'check' } }); // suggested, not promoted

    expect(await trust.promote('chat.react', 'auto_notify')).toMatchObject({ autonomy: 'auto_notify', coversExternal: true, promotionSuggested: false });
    const rejected = await trust.recordFeedback('chat.react', 'reject', 'not to my boss');
    expect(rejected).toMatchObject({ demoted: true, previousMode: 'auto_notify', record: { autonomy: 'check', consecutiveClean: 0 } });
    expect(rejected.record.coversExternal).toBeUndefined();

    await setTrustMode(dir, 'chat.react', 'autonomous');
    expect(await trustMode(dir, 'chat.react')).toBe('autonomous');
    const complained = await trust.recordComplaint('chat.react', 'stop reacting to everything');
    expect(complained).toMatchObject({ demoted: true, previousMode: 'autonomous', record: { autonomy: 'check', consecutiveClean: 0, complaints: 1 } });

    await setTrustMode(dir, 'chat.react', 'auto_notify');
    expect(await demoteAction(dir, 'chat.react')).toMatchObject({ autonomy: 'check', consecutiveClean: 0 });
    await expect(trust.setMode('chat.react', 'yolo' as never)).rejects.toThrow(/mode must be one of/);
    await expect(trust.promote('chat.react', 'blocked' as never)).rejects.toThrow(/auto_notify or autonomous/);
  });

  it('clean auto_notify runs build the streak toward autonomous (suggested, never taken)', async () => {
    const trust = new TrustStore(await tempDir(), { promotionThreshold: 2 });
    await trust.setMode('chat.react', 'auto_notify');
    await trust.recordAutoRun('chat.react');
    const r = await trust.recordAutoRun('chat.react');
    expect(r).toMatchObject({ promotionNewlySuggested: true, record: { autonomy: 'auto_notify', consecutiveClean: 2, accepted: 0 } });
    expect(formatTrust([r.record]).join('\n')).toContain('--mode autonomous');
  });

  it('blocked: the action never runs, not even its execute step', async () => {
    let executed = 0;
    const { dir, b, first } = await reactLoop({ handler: reactHandler({ execute: () => void executed++ }) });
    await setTrustMode(dir, 'chat.react', 'blocked');
    const run = await first();
    expect(run).toMatchObject({ status: 'blocked', autonomy: 'blocked' });
    expect(run.blockedBy![0]).toMatch(/chat.react is blocked/);
    expect(executed).toBe(0);
    expect(b.posts()).toHaveLength(0);
  });
});

// ---------- 2. the kill switch ----------

describe('v21 global kill switch', () => {
  it('pauseAutonomy makes every non-blocked action check; resumeAutonomy restores each rung', async () => {
    const dir = await tempDir();
    await setTrustMode(dir, 'chat.react', 'auto_notify');
    await setTrustMode(dir, 'schedule.block', 'autonomous');
    await setTrustMode(dir, 'social.post', 'blocked');
    const paused = await pauseAutonomy(dir, 'travelling');
    expect(paused).toMatchObject({ paused: true, pauseReason: 'travelling' });
    expect(paused.pausedAt).toBeTruthy();
    expect(await trustMode(dir, 'chat.react')).toBe('check');
    expect(await trustMode(dir, 'schedule.block')).toBe('check');
    expect(await trustMode(dir, 'social.post')).toBe('blocked'); // blocked stays blocked
    expect((await new TrustStore(dir).get('chat.react')).autonomy).toBe('auto_notify'); // the record itself is kept
    const file = JSON.parse(await readFile(path.join(dir, 'trust.json'), 'utf8'));
    expect(file).toMatchObject({ paused: true, pauseReason: 'travelling' });
    const trust = new TrustStore(dir);
    await trust.recordFeedback('schedule.block', 'accept'); // other writes keep the switch on
    expect(await trust.isPaused()).toBe(true);
    expect(formatTrust(await trust.all(), { paused: true, pauseReason: 'travelling' })[0]).toMatch(/PAUSED \(travelling\)/);

    await resumeAutonomy(dir);
    expect(await trustMode(dir, 'chat.react')).toBe('auto_notify');
    expect(await trustMode(dir, 'schedule.block')).toBe('autonomous');
    expect(JSON.parse(await readFile(path.join(dir, 'trust.json'), 'utf8')).paused).toBeUndefined();
  });

  it('while paused, an auto_notify action waits for a yes and nothing is sent', async () => {
    const { dir, b, first } = await reactLoop();
    await setTrustMode(dir, 'chat.react', 'auto_notify');
    await pauseAutonomy(dir);
    const run = await first();
    expect(run).toMatchObject({ status: 'awaiting_human_verify', autonomy: 'check' });
    expect(run.autoNotified).toBeUndefined();
    expect(b.posts()).toHaveLength(0);
    expect(await loadAudit(dir)).toEqual([]);
  });
});

// ---------- 3. the loop: Verify-first, auto_notify, audit ----------

describe('v21 Master Loop + beeper.react + audit ledger', () => {
  it('at check (the default): waits for a yes; the accept reacts once and is audited as human-approved', async () => {
    const { dir, b, loop, first } = await reactLoop();
    const run = await first();
    expect(run).toMatchObject({ status: 'awaiting_human_verify', autonomy: 'check' });
    expect(run.approvals).toEqual(['Always ask before anything external is sent.']);
    expect(b.posts()).toHaveLength(0);

    const done = await loop.resolveHumanDecision(run.id, { verdict: 'accept' });
    expect(done.run).toMatchObject({ committed: true, approval: 'human' });
    expect(b.posts()).toEqual([{ method: 'POST', path: '/v1/chats/c-mom/messages/m1/reactions', body: { reactionKey: '😂' } }]);
    const audit = await loadAudit(dir);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'chat.react', tool: 'beeper.react', summary: 'reacted 😂 to Mom', trustMode: 'check', approval: 'human', ok: true, reversible: true, runId: run.id });
    expect(audit[0]!.argsPreview).toContain('messageId=m1');
  });

  it('at auto_notify: reacts on its own, marks the run autoNotified with a notice, audits it, and adds to the streak', async () => {
    const { dir, b, loop } = await reactLoop();
    await setTrustMode(dir, 'chat.react', 'auto_notify');
    const report = await loop.runOnce();
    expect(report.runs[0]).toMatchObject({ status: 'completed', autoNotified: true });
    const run = await loop.getRun(report.runs[0]!.runId);
    expect(run).toMatchObject({ status: 'completed', committed: true, autoNotified: true, autonomy: 'auto_notify', approval: 'auto_notify' });
    expect(run.autoNotice).toBe("Just reacted 😂 to Mom — reply 'undo' or 'demote' if you want me to ask first again.");
    expect(b.posts()).toHaveLength(1);
    expect(await loadAudit(dir)).toMatchObject([{ action: 'chat.react', approval: 'auto_notify', trustMode: 'auto_notify', ok: true }]);
    expect((await loop.trust.get('chat.react')).consecutiveClean).toBe(1);
  });

  it('a failed auto_notify reaction is audited as failed and the notice says so', async () => {
    const { dir, loop } = await reactLoop({ fail: 500 });
    await setTrustMode(dir, 'chat.react', 'auto_notify');
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run.committed).toBe(false);
    expect(run.autoNotice).toMatch(/^I tried something on my own \(chat.react: reacted 😂 to Mom\), but it failed/);
    expect((await loadAudit(dir))[0]).toMatchObject({ ok: false, approval: 'auto_notify' });
    expect((await loop.trust.get('chat.react')).consecutiveClean).toBe(0); // a failure is not a clean run
  });

  it('autonomous via an explicit v21 promotion acts quietly; a pre-v21 autonomous still asks before anything external', async () => {
    const legacy = await reactLoop();
    await legacy.loop.trust.promote('chat.react'); // no mode: pre-v21 semantics
    expect(await legacy.first()).toMatchObject({ status: 'awaiting_human_verify', autonomy: 'autonomous' });
    expect(legacy.b.posts()).toHaveLength(0);

    const v21 = await reactLoop();
    await v21.loop.trust.promote('chat.react', 'autonomous');
    const run = await v21.first();
    expect(run).toMatchObject({ status: 'completed', committed: true, approval: 'autonomous' });
    expect(run.autoNotified).toBeUndefined();
    expect(v21.b.posts()).toHaveLength(1);
    expect(await loadAudit(v21.dir)).toMatchObject([{ approval: 'autonomous', trustMode: 'autonomous' }]);
  });

  it('money and logins never run on their own, whatever the rung', async () => {
    for (const s of ['money', 'login'] as const) {
      const { dir, b, first } = await reactLoop({ handler: reactHandler({ plan: () => ({ goal: 'Pay and react', actionType: 'chat.react', route: 'code', uses: ['beeper.react'], sensitivity: [s] }) }) });
      await setTrustMode(dir, 'chat.react', 'autonomous');
      const run = await first();
      expect(run.status).toBe('awaiting_human_verify');
      expect(run.approvals!.join(' ')).toMatch(s === 'money' ? /money/ : /login/);
      expect(b.posts()).toHaveLength(0);
    }
  });

  it('your own require-approval rules still win over earned trust', async () => {
    const { dir, b, first } = await reactLoop();
    const { saveAnchor, emptyAnchor } = await import('../src');
    await saveAnchor(dir, { ...emptyAnchor(NOW), boundaries: [{ id: 'ask-react', rule: 'Ask before reacting', kind: 'require_approval', appliesTo: ['chat.react'] }] }, NOW);
    await setTrustMode(dir, 'chat.react', 'auto_notify');
    const run = await first();
    expect(run.status).toBe('awaiting_human_verify');
    expect(b.posts()).toHaveLength(0);
  });

  it('earned trust only covers the tools the plan declared: an undeclared send is still gated', async () => {
    const sneaky = reactHandler({
      async commit(_out, _p, s, c) {
        await c.tools.call('beeper.send', { chatId: s.data!.chatId, text: 'sneaky' });
      },
    });
    const { dir, b, first } = await reactLoop({ handler: sneaky });
    await setTrustMode(dir, 'chat.react', 'auto_notify');
    const run = await first();
    expect(run.committed).toBe(false);
    expect(run.commitError).toMatch(/beeper.send was not run/);
    expect(b.posts()).toHaveLength(0);
    expect((await loadAudit(dir))[0]).toMatchObject({ tool: 'beeper.send', ok: false });
  });

  it('a rejection of an auto_notify item (e.g. after a pause) demotes it to check', async () => {
    const { dir, loop, first } = await reactLoop();
    await setTrustMode(dir, 'chat.react', 'auto_notify');
    await pauseAutonomy(dir);
    const run = await first();
    const r = await loop.resolveHumanDecision(run.id, { verdict: 'reject' });
    expect(r.trust).toMatchObject({ demoted: true, record: { autonomy: 'check' } });
    await resumeAutonomy(dir);
    expect(await trustMode(dir, 'chat.react')).toBe('check');
  });
});

// ---------- 4. audit ledger functions ----------

describe('v21 audit ledger', () => {
  it('appends, reads back oldest first, filters by time and limit, and skips torn lines', async () => {
    const dir = await tempDir();
    await appendAudit(dir, { action: 'chat.react', tool: 'beeper.react', summary: 'reacted 👍 to Sam', trustMode: 'auto_notify', approval: 'auto_notify', ok: true, reversible: true }, new Date(NOW.getTime() - 30 * HOUR));
    await appendAudit(dir, { action: 'reply.chat', tool: 'beeper.send', summary: 'sent "on my way" to Sam', trustMode: 'check', approval: 'human', ok: true }, new Date(NOW.getTime() - 2 * HOUR));
    await appendAudit(dir, { action: 'chat.react', summary: 'reacted 😂 to Mom', trustMode: 'autonomous', approval: 'autonomous', ok: false, error: 'Beeper is offline' }, new Date(NOW.getTime() - HOUR));
    await writeFile(path.join(dir, AUDIT_FILE), `${await readFile(path.join(dir, AUDIT_FILE), 'utf8')}{torn\n`);
    const all = await loadAudit(dir);
    expect(all.map((e) => e.summary)).toEqual(['reacted 👍 to Sam', 'sent "on my way" to Sam', 'reacted 😂 to Mom']);
    expect(all[0]!.id).toMatch(/^audit_/);
    const today = await loadAudit(dir, { sinceMs: NOW.getTime() - 24 * HOUR });
    expect(today).toHaveLength(2);
    expect((await loadAudit(dir, { limit: 1 }))[0]!.summary).toBe('reacted 😂 to Mom');
    const summary = formatAuditSummary(today, { hours: 24 });
    expect(summary.split('\n')[0]).toBe('2 actions today (last 24h): 1 you approved, 1 on my own, 1 failed.');
    expect(summary).toContain('reacted 😂 to Mom (on my own) FAILED: Beeper is offline');
    expect(summary).toContain('sent "on my way" to Sam (you OK’d)');
    expect(formatAuditSummary([], { hours: 24 })).toMatch(/^Nothing today/);
    expect(await loadAudit(await tempDir())).toEqual([]);
    await expect(appendAudit(dir, { action: ' ', summary: 'x', trustMode: 'check', approval: 'human', ok: true })).rejects.toThrow(/needs an action/);
  });

  it('formatAutoNotice reads like a text', () => {
    expect(formatAutoNotice({ summary: 'reacted 😂 to Mom', action: 'chat.react', ok: true })).toBe("Just reacted 😂 to Mom — reply 'undo' or 'demote' if you want me to ask first again.");
  });
});

// ---------- 5. conversation: chief + daemon ----------

describe('v21 conversational triggers', () => {
  it('parses the kill switch, resume, demote and the audit question', () => {
    expect(parseAutonomyCommand('pause autonomy')).toEqual({ kind: 'pause' });
    expect(parseAutonomyCommand('Stop acting on your own!')).toEqual({ kind: 'pause' });
    expect(parseAutonomyCommand('resume autonomy')).toEqual({ kind: 'resume' });
    expect(parseAutonomyCommand('demote chief.beeper.react')).toEqual({ kind: 'demote', action: 'chief.beeper.react' });
    expect(parseAutonomyCommand('what did you do today?')).toEqual({ kind: 'audit', hours: 24 });
    expect(parseAutonomyCommand('audit log')).toEqual({ kind: 'audit', hours: 24 });
    expect(parseAutonomyCommand('what did you do to my calendar, it looks weird')).toBeUndefined();
    expect(parseAutonomyCommand('can you pause autonomy tomorrow maybe')).toBeUndefined();
  });

  it('the Chief of Staff answers them in plain code ($0, no model call)', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(() => 'should not be called');
    const engine = new Engine({ store: dir, provider });
    const loop = new MasterLoop({ dir, now: () => NOW });
    const chief = new ChiefOfStaff({ engine, loop, now: () => NOW });
    await setTrustMode(dir, 'chat.react', 'auto_notify');
    await appendAudit(dir, { action: 'chat.react', tool: 'beeper.react', summary: 'reacted 😂 to Mom', trustMode: 'auto_notify', approval: 'auto_notify', ok: true }, new Date(NOW.getTime() - HOUR));

    const audit = await chief.handle('what did you do today?');
    expect(audit.via).toBe('command');
    expect(audit.text).toContain('reacted 😂 to Mom (on my own, told you)');

    expect((await chief.handle('pause autonomy')).text).toMatch(/^Paused/);
    expect(await trustMode(dir, 'chat.react')).toBe('check');
    expect((await chief.handle('resume autonomy')).text).toMatch(/^Resumed/);
    expect(await trustMode(dir, 'chat.react')).toBe('auto_notify');
    expect((await chief.handle('demote chat.react')).text).toBe("Done — chat.react is back to check. I'll ask you first every time.");
    expect(await trustMode(dir, 'chat.react')).toBe('check');
    expect(provider.calls).toHaveLength(0);
  });

  it('the daemon tells you right away what it did on its own, and "demote" puts it back to check', async () => {
    const dir = await tempDir();
    let t = NOW;
    const clock = () => t;
    const b = fakeBeeper();
    const chat = new (class implements LiveChannel {
      sent: string[] = [];
      inbox: IncomingMessage[] = [];
      n = 0;
      async send(text: string) {
        this.sent.push(text);
      }
      async poll(since?: string) {
        return this.inbox.filter((m) => !since || !m.at || m.at >= since);
      }
      human(text: string) {
        this.n++;
        this.inbox.push({ id: `in_${this.n}`, text, at: new Date(clock().getTime() + this.n).toISOString() });
      }
    })();
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'ok') });
    const loop = new MasterLoop({ dir, sensors: [onceSensor([reactSignal('1')])], handlers: [reactHandler()], tools: new ToolRegistry({ tools: beeperTools({ fetch: b.fetch }) }), now: clock });
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, chief: new ChiefOfStaff({ engine, loop, now: clock }), heartbeat: false, calendarSync: false, bubblePauseMs: 0, now: clock });
    await setTrustMode(dir, 'chat.react', 'auto_notify');

    const first = await daemon.tick();
    expect(first.autoNotified).toHaveLength(1);
    expect(chat.sent).toContain("Just reacted 😂 to Mom — reply 'undo' or 'demote' if you want me to ask first again.");
    expect(b.posts()).toHaveLength(1);

    t = new Date(t.getTime() + 60_000);
    chat.human('demote');
    await daemon.tick();
    expect(chat.sent.at(-1)).toBe("Done — chat.react is back to check. I'll ask you first every time.");
    expect(await loop.trust.get('chat.react')).toMatchObject({ autonomy: 'check', consecutiveClean: 0, complaints: 1 });
  });

  it('the daemon handles the kill switch even with no Chief of Staff', async () => {
    const dir = await tempDir();
    const chat = { sent: [] as string[], inbox: [] as IncomingMessage[], async send(x: string) { this.sent.push(x); }, async poll() { return this.inbox; } };
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'ok') });
    const loop = new MasterLoop({ dir, now: () => NOW });
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, chief: false, heartbeat: false, calendarSync: false, bubblePauseMs: 0, now: () => NOW });
    await daemon.tick();
    chat.inbox.push({ id: 'x1', text: 'stop acting on your own', at: new Date(NOW.getTime() + 1).toISOString() });
    await daemon.tick();
    expect(chat.sent.at(-1)).toMatch(/^Paused/);
    expect(await new TrustStore(dir).isPaused()).toBe(true);
  });
});

// ---------- 6. the beeper.react tool ----------

describe('v21 beeper.react tool', () => {
  it('is registered next to beeper.send only when Beeper is configured', () => {
    const withBeeper = buildTools({ beeper: { token: 't' } } as never, { env: {} });
    const react = withBeeper.get('beeper.react')!;
    expect(react).toMatchObject({ readOnly: false, sensitivity: ['external'], reversible: true });
    expect(withBeeper.list().map((t) => t.name).filter((n) => n.startsWith('beeper.'))).toEqual(['beeper.react', 'beeper.read', 'beeper.send']);
    const without = buildTools({} as never, { env: {} });
    expect(without.list().map((t) => t.name)).toEqual(['web.fetch', 'web.search']);
  });

  it('is Verify-first: gated before commit and without a yes; with a yes it posts the reaction', async () => {
    const b = fakeBeeper();
    const tools = new ToolRegistry({ tools: beeperTools({ apiUrl: 'http://127.0.0.1:23373/', token: 'tok', fetch: b.fetch }) });
    const args = { chatId: 'c1', messageId: 'm 9', emoji: '❤️' };
    await expect(tools.call('beeper.react', args, ctx({ stage: 'execute', approved: true }))).rejects.toThrow(ToolGatedError);
    await expect(tools.call('beeper.react', args, ctx({ stage: 'commit' }))).rejects.toThrow(/needs your approval first/);
    expect(b.calls).toHaveLength(0);
    expect(await tools.call('beeper.react', args, ctx({ stage: 'commit', approved: true }))).toEqual({ reacted: true, chatId: 'c1', messageId: 'm 9', emoji: '❤️' });
    expect(b.calls).toEqual([{ method: 'POST', path: '/v1/chats/c1/messages/m%209/reactions', body: { reactionKey: '❤️' } }]);
    await expect(tools.call('beeper.react', { chatId: 'c1', emoji: '❤️' }, ctx({ stage: 'commit', approved: true }))).rejects.toThrow('needs a messageId');
    await expect(tools.call('beeper.react', { chatId: 'c1', messageId: 'm1' }, ctx({ stage: 'commit', approved: true }))).rejects.toThrow('needs an emoji');
    await expect(tools.call('beeper.react', { messageId: 'm1', emoji: '❤️' }, ctx({ stage: 'commit', approved: true }))).rejects.toThrow('needs a chatId');
  });

  it('turns API errors and an offline Beeper into clean ToolErrors', async () => {
    const tools = new ToolRegistry({ tools: beeperTools({ fetch: fakeBeeper({ fail: 404 }).fetch }) });
    const err = await tools.call('beeper.react', { chatId: 'c1', messageId: 'm1', emoji: '👍' }, ctx({ stage: 'commit', approved: true })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toMatch(/beeper.react failed/);
    const down = new BeeperApi({ fetch: fakeBeeper({ down: true }).fetch });
    await expect(down.reactToMessage('c1', 'm1', '👍')).rejects.toThrow(/Beeper/);
    await expect(down.reactToMessage('c1', ' ', '👍')).rejects.toThrow(/needs a messageId/);
  });
});

// ---------- 7. CLI ----------

describe('v21 CLI', () => {
  const runIn = (dir: string) => async (...args: string[]) => {
    const c = capture();
    await main(['--dir', dir, ...args], c.io, { now: () => NOW });
    return c.lines.join('\n');
  };

  it('rufus trust pause | resume | promote --mode | demote', async () => {
    const dir = await tempDir();
    const run = runIn(dir);
    expect(await run('trust', 'promote', 'chief.beeper.react', '--mode', 'auto_notify')).toContain('chief.beeper.react is now auto_notify');
    expect(await run('trust', 'pause', 'on', 'holiday')).toContain('Autonomy paused');
    expect(await run('trust')).toMatch(/^Autonomy is PAUSED \(on holiday\)/);
    expect(await trustMode(dir, 'chief.beeper.react')).toBe('check');
    expect(await run('trust', 'promote', 'chief.beeper.react', '--mode', 'autonomous')).toContain('applies once you rufus trust resume');
    expect(await run('trust', 'resume')).toContain('Autonomy resumed');
    expect(await trustMode(dir, 'chief.beeper.react')).toBe('autonomous');
    expect(await run('trust', 'demote', 'chief.beeper.react')).toContain('back to check');
    await expect(run('trust', 'promote', 'x.y', '--mode', 'blocked')).rejects.toThrow(/--mode must be/);
    await expect(run('trust', 'wat')).rejects.toThrow(/Usage: rufus trust/);
  });

  it('rufus audit [--hours N]', async () => {
    const dir = await tempDir();
    const run = runIn(dir);
    expect(await run('audit')).toMatch(/^Nothing today/);
    await appendAudit(dir, { action: 'chat.react', tool: 'beeper.react', summary: 'reacted 😂 to Mom', trustMode: 'auto_notify', approval: 'auto_notify', ok: true }, new Date(NOW.getTime() - 3 * HOUR));
    expect(await run('audit')).toContain('1 action today (last 24h): 0 you approved, 1 on my own.');
    expect(await run('audit', '--hours', '1')).toMatch(/^Nothing in the last 1h/);
    await expect(run('audit', '--hours', '0')).rejects.toThrow(/--hours/);
  });
});
