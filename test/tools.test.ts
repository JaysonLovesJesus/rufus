import { describe, expect, it } from 'vitest';
import {
  BeeperApi,
  MasterLoop,
  ToolError,
  ToolGatedError,
  ToolRegistry,
  beeperTools,
  buildTools,
  commandTool,
  fillArgs,
  formatTools,
  gateReason,
  parseOutput,
  runCommand,
  type CommandRunner,
  type LoopSignal,
  type Sensor,
  type SignalHandler,
  type ToolDefinition,
} from '../src';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 8, 0);
const ctx = (over: Partial<Parameters<ToolRegistry['call']>[2]> = {}) => ({ dir: '/tmp', now: NOW, ...over });

/** Records every request; answers from a small route table. */
function fakeFetch(routes: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown; auth?: string }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = String(url);
    calls.push({ method, url: u, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    const key = `${method} ${new URL(u).pathname}`;
    const body = routes[key] ?? (method === 'POST' ? { pendingMessageID: 'pm_1' } : { items: [] });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const echo: ToolDefinition = { name: 'echo.read', description: 'echo', readOnly: true, execute: (args) => ({ got: args }) };
const write: ToolDefinition = { name: 'note.write', description: 'writes', execute: () => 'written' };
const send: ToolDefinition = { name: 'msg.send', description: 'sends', sensitivity: ['external'], execute: (a) => `sent ${String(a.text)}` };

describe('ToolRegistry', () => {
  it('registers, lists and refuses bad or duplicate tools', () => {
    const r = new ToolRegistry({ tools: [send, echo] });
    expect(r.list().map((t) => t.name)).toEqual(['echo.read', 'msg.send']);
    expect(r.has('echo.read')).toBe(true);
    expect(() => r.register(echo)).toThrow('registered twice');
    expect(() => r.register({ name: 'bad name!', description: '', execute: () => 1 })).toThrow('needs a name');
    expect(r.sensitivityOf(['msg.send', 'echo.read', 'nope'])).toEqual(['external']);
  });

  it('read-only tools run in any stage; side effects only in commit', async () => {
    const r = new ToolRegistry({ tools: [echo, write] });
    expect(await r.call('echo.read', { a: 1 }, ctx({ stage: 'plan' }))).toEqual({ got: { a: 1 } });
    await expect(r.call('note.write', {}, ctx({ stage: 'execute' }))).rejects.toThrow(ToolGatedError);
    await expect(r.call('note.write', {}, ctx({ stage: 'verify' }))).rejects.toThrow(/only runs in commit/);
    expect(await r.call('note.write', {}, ctx({ stage: 'commit' }))).toBe('written');
  });

  it('a sensitive tool needs a human yes, unless explicitly trusted', async () => {
    const r = new ToolRegistry({ tools: [send] });
    await expect(r.call('msg.send', { text: 'hi' }, ctx({ stage: 'commit' }))).rejects.toThrow(/external, so it needs your approval first/);
    expect(await r.call('msg.send', { text: 'hi' }, ctx({ stage: 'commit', approved: true }))).toBe('sent hi');
    const trusted = new ToolRegistry({ tools: [send], trusted: ['msg.send'] });
    expect(await trusted.call('msg.send', { text: 'yo' }, ctx({ stage: 'commit' }))).toBe('sent yo');
    // Trust never lets a side effect run before commit.
    expect(gateReason(send, { stage: 'execute', approved: true }, true)).toMatch(/only runs in commit/);
  });

  it('an unknown tool says what is available', async () => {
    await expect(new ToolRegistry({ tools: [echo] }).call('nope', {}, ctx())).rejects.toThrow('no such tool. Available: echo.read');
    await expect(new ToolRegistry().call('nope', {}, ctx())).rejects.toThrow('configure tools in config.json');
  });

  it('formatTools shows read-only, sensitivity and trust', () => {
    expect(formatTools(new ToolRegistry({ tools: [echo, send], trusted: ['msg.send'] }))).toEqual(['echo.read (read-only): echo', 'msg.send (acts, external, trusted): sends']);
  });
});

describe('command tools', () => {
  it('fills {{placeholders}}, sends args as JSON on stdin, and parses JSON output', async () => {
    const seen: Array<{ command: string; args: string[]; input?: string; timeoutMs?: number }> = [];
    const run: CommandRunner = async (command, args, opts) => {
      seen.push({ command, args, input: opts.input, timeoutMs: opts.timeoutMs });
      return '[{"id":"e1","title":"Standup"}]\n';
    };
    const tool = commandTool('calendar.read', { command: 'cal-cli', args: ['list', '--day', '{{date}}', '--max={{max}}'], timeoutMs: 5000 }, run);
    expect(tool.readOnly).toBe(true);
    expect(await tool.execute({ date: '2026-11-25', max: 3 }, ctx())).toEqual([{ id: 'e1', title: 'Standup' }]);
    expect(seen[0]).toEqual({ command: 'cal-cli', args: ['list', '--day', '2026-11-25', '--max=3'], input: '{"date":"2026-11-25","max":3}', timeoutMs: 5000 });
  });

  it('knows sensible defaults for the well-known names, all overridable', () => {
    const run: CommandRunner = async () => '';
    expect(commandTool('calendar.write', { command: 'x' }, run)).toMatchObject({ readOnly: false });
    expect(commandTool('gmail.read', { command: 'x' }, run)).toMatchObject({ readOnly: true });
    expect(commandTool('gmail.draft', { command: 'x' }, run)).toMatchObject({ readOnly: false });
    expect(commandTool('shell.run', { command: 'x' }, run)).toMatchObject({ readOnly: false, sensitivity: ['external'] });
    expect(commandTool('shell.run', { command: 'x', sensitivity: [] }, run).sensitivity).toBeUndefined();
    expect(commandTool('notes.search', { command: 'x' }, run).readOnly).toBe(true);
    expect(() => commandTool('x.read', { command: ' ' }, run)).toThrow('needs a "command"');
  });

  it('wraps failures in a clear ToolError', async () => {
    const tool = commandTool('gmail.read', { command: 'mail' }, async () => {
      throw new Error('command not found: mail (is it installed and on PATH?)');
    });
    const err: unknown = await Promise.resolve(tool.execute({}, ctx())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toBe('Tool gmail.read failed: command not found: mail (is it installed and on PATH?)');
  });

  it('runCommand: real processes, with clear errors for missing commands, timeouts and exit codes', async () => {
    expect(parseOutput(await runCommand(process.execPath, ['-e', 'process.stdin.on("data",d=>process.stdout.write(JSON.stringify({echo:JSON.parse(d)})))'], { input: '{"a":1}' }))).toEqual({ echo: { a: 1 } });
    await expect(runCommand('rufus-no-such-command-xyz', [], {})).rejects.toThrow('command not found: rufus-no-such-command-xyz');
    await expect(runCommand(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 150 })).rejects.toThrow(/timed out after 150ms/);
    await expect(runCommand(process.execPath, ['-e', 'console.error("bad input");process.exit(3)'], {})).rejects.toThrow(/exited with code 3: bad input/);
  }, 10_000);

  it('fillArgs and parseOutput', () => {
    expect(fillArgs(['{{a}}', 'x{{b}}y', '{{missing}}', '{{obj}}'], { a: 'A', b: 2, obj: { k: 1 } })).toEqual(['A', 'x2y', '', '{"k":1}']);
    expect(parseOutput('  plain text \n')).toBe('plain text');
    expect(parseOutput('{"ok":true}')).toEqual({ ok: true });
    expect(parseOutput('{broken')).toBe('{broken');
    expect(parseOutput('')).toBe('');
  });
});

describe('Beeper tools', () => {
  it('beeper.read and beeper.send talk to the local Beeper Desktop API', async () => {
    const f = fakeFetch({ 'GET /v1/chats/c%201/messages': { items: [{ id: 'm1', text: 'hi', timestamp: '2026-11-25T08:00:00Z', senderName: 'Sam' }] } });
    const tools = new ToolRegistry({ tools: beeperTools({ apiUrl: 'http://127.0.0.1:23373/', token: 'tok', fetch: f.fetch }) });
    const msgs = await tools.call<Array<{ text: string }>>('beeper.read', { chatId: 'c 1' }, ctx({ stage: 'plan' }));
    expect(msgs.map((m) => m.text)).toEqual(['hi']);
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'http://127.0.0.1:23373/v1/chats/c%201/messages?limit=20', auth: 'Bearer tok' });

    expect(tools.get('beeper.send')!.sensitivity).toEqual(['external']);
    await expect(tools.call('beeper.send', { chatId: 'c1', text: 'yo' }, ctx({ stage: 'commit' }))).rejects.toThrow(ToolGatedError);
    expect(f.calls).toHaveLength(1); // nothing was sent
    expect(await tools.call('beeper.send', { chatId: 'c1', text: ' yo ' }, ctx({ stage: 'commit', approved: true }))).toEqual({ sent: true, pendingMessageId: 'pm_1' });
    expect(f.calls[1]).toMatchObject({ method: 'POST', url: 'http://127.0.0.1:23373/v1/chats/c1/messages', body: { text: 'yo' } });
    await expect(tools.call('beeper.send', { chatId: 'c1', text: '  ' }, ctx({ stage: 'commit', approved: true }))).rejects.toThrow('needs a non-empty text');
    await expect(tools.call('beeper.read', {}, ctx())).rejects.toThrow('needs a chatId');
  });

  it('reports an offline Beeper Desktop clearly', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const tools = new ToolRegistry({ tools: beeperTools(new BeeperApi({ fetch: down })) });
    await expect(tools.call('beeper.read', { chatId: 'c1' }, ctx())).rejects.toThrow('Beeper Desktop is not reachable at http://127.0.0.1:23373');
  });
});

describe('buildTools (config.json)', () => {
  it('Beeper tools when Beeper is configured, every configured command, and the trusted list', async () => {
    const f = fakeFetch();
    const r = buildTools(
      {
        version: 1,
        beeper: { apiUrl: 'http://127.0.0.1:9999', token: 't' },
        tools: { commands: { 'calendar.read': { command: 'cal' }, 'shell.run': { command: 'sh', args: ['-c', '{{cmd}}'] } }, trusted: ['calendar.read'] },
      },
      { env: {}, fetch: f.fetch, run: async () => '[]' },
    );
    expect(r.list().map((t) => t.name)).toEqual(['beeper.react', 'beeper.read', 'beeper.send', 'calendar.read', 'shell.run', 'web.fetch', 'web.search']);
    expect(r.isTrusted('calendar.read')).toBe(true);
    await r.call('beeper.read', { chatId: 'x' }, ctx());
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:9999/v1/chats/x/messages?limit=20');
  });

  it('nothing configured: only the built-in web tools; the env token alone turns Beeper on; tools.beeper false turns it off', () => {
    expect(buildTools({ version: 1 }, { env: {} }).list().map((t) => t.name)).toEqual(['web.fetch', 'web.search']);
    expect(buildTools({ version: 1, tools: { web: false } }, { env: {} }).list()).toEqual([]);
    expect(buildTools({ version: 1 }, { env: { RUFUS_BEEPER_TOKEN: 't' } }).has('beeper.send')).toBe(true);
    expect(buildTools({ version: 1, beeper: {}, tools: { beeper: false, web: false } }, { env: {} }).list()).toEqual([]);
  });
});

describe('ctx.tools in the Master Loop', () => {
  const signal: LoopSignal = { id: 's1', surface: 'chat', kind: 'message.received', text: 'are we on for 3?', data: { chatId: 'c1' } };
  const sensor = (s: LoopSignal = signal): Sensor => ({ id: 'one', surface: 'chat', poll: (c) => (c ? { signals: [] } : { signals: [s], nextCursor: '1' }) });
  const replyHandler = (over: Partial<SignalHandler<{ reply: string }>> = {}): SignalHandler<{ reply: string }> => ({
    id: 'reply',
    match: { surface: 'chat' },
    plan: () => ({ goal: 'Confirm the time', actionType: 'reply.chat', route: 'code', uses: ['beeper.send'] }),
    async execute(_p, s, ctx) {
      const history = await ctx.tools.call<unknown[]>('beeper.read', { chatId: s.data!.chatId }); // read-only: fine while executing
      return { reply: `Yes, 3 works (${history.length} earlier).` };
    },
    async commit(out, _p, s, ctx) {
      await ctx.tools.call('beeper.send', { chatId: s.data!.chatId, text: (out as { reply: string }).reply });
    },
    ...over,
  });

  it('a tool with an external sensitivity makes the run wait for a yes, even when the action is autonomous', async () => {
    const dir = await tempDir();
    const f = fakeFetch();
    const loop = new MasterLoop({ dir, sensors: [sensor()], handlers: [replyHandler()], tools: new ToolRegistry({ tools: beeperTools({ fetch: f.fetch }) }), now: () => NOW });
    await loop.trust.promote('reply.chat');
    const r = await loop.runOnce();
    const run = await loop.getRun(r.runs[0]!.runId);
    expect(run.status).toBe('awaiting_human_verify');
    expect(run.approvals).toEqual(['Always ask before anything external is sent.']);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(run.toolCalls).toMatchObject([{ tool: 'beeper.read', stage: 'execute', ok: true }]);

    const decided = await loop.resolveHumanDecision(run.id, { verdict: 'accept' });
    expect(decided.run.committed).toBe(true);
    expect(f.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ text: 'Yes, 3 works (0 earlier).' }]);
    expect(decided.run.toolCalls!.map((t) => `${t.stage}:${t.tool}:${t.ok}`)).toEqual(['execute:beeper.read:true', 'commit:beeper.send:true']);
  });

  it('an autonomous commit cannot sneak an undeclared external send past the gate', async () => {
    const dir = await tempDir();
    const f = fakeFetch();
    const loop = new MasterLoop({
      dir,
      sensors: [sensor()],
      handlers: [replyHandler({ plan: () => ({ goal: 'Confirm', actionType: 'reply.chat', route: 'code' }) })], // no `uses`
      tools: new ToolRegistry({ tools: beeperTools({ fetch: f.fetch }) }),
      now: () => NOW,
    });
    await loop.trust.promote('reply.chat');
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run.status).toBe('completed');
    expect(run.committed).toBe(false);
    expect(run.commitError).toMatch(/beeper.send was not run: it is external, so it needs your approval first/);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // ...unless you trusted that tool by name.
    const f2 = fakeFetch();
    const dir2 = await tempDir();
    const trusted = new MasterLoop({ dir: dir2, sensors: [sensor()], handlers: [replyHandler({ plan: () => ({ goal: 'Confirm', actionType: 'reply.chat', route: 'code' }) })], tools: new ToolRegistry({ tools: beeperTools({ fetch: f2.fetch }), trusted: ['beeper.send'] }), now: () => NOW });
    await trusted.trust.promote('reply.chat');
    const ok = await trusted.getRun((await trusted.runOnce()).runs[0]!.runId);
    expect(ok.committed).toBe(true);
    expect(f2.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a side effect during execute is refused, and the run reports it', async () => {
    const dir = await tempDir();
    const f = fakeFetch();
    const loop = new MasterLoop({
      dir,
      sensors: [sensor()],
      handlers: [replyHandler({ execute: async (_p, s, ctx) => ((await ctx.tools.call('beeper.send', { chatId: s.data!.chatId, text: 'too early' })) as never) })],
      tools: new ToolRegistry({ tools: beeperTools({ fetch: f.fetch }) }),
      now: () => NOW,
    });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/only runs in commit \(after Verify\), not during execute/);
    expect(f.calls).toHaveLength(0);
  });

  it('ctx.tools.list describes what a handler can use', async () => {
    const dir = await tempDir();
    let listed: unknown;
    const loop = new MasterLoop({
      dir,
      sensors: [sensor()],
      handlers: [{ id: 'h', match: { surface: 'chat' }, plan: (_s, c) => ((listed = c.tools.list()), { goal: 'g', actionType: 'x.y', route: 'code' }), execute: () => 1 }],
      tools: new ToolRegistry({ tools: [echo, send] }),
      now: () => NOW,
    });
    await loop.runOnce();
    expect(listed).toEqual([
      { name: 'echo.read', description: 'echo', readOnly: true, sensitivity: [] },
      { name: 'msg.send', description: 'sends', readOnly: false, sensitivity: ['external'] },
    ]);
  });
});
