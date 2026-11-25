import { writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  McpClient,
  ToolError,
  ToolGatedError,
  ToolRegistry,
  classifyMcpTool,
  mcpResultValue,
  mcpToolName,
  missionMayUse,
  missionToolRegistry,
  parseSseEvents,
  registerMcpTools,
  type McpServerConfig,
  type RegisterMcpToolsResult,
} from '../src';
import { main, type Io } from '../src/cli';
import { tempDir } from './helpers';

// ---------- a tiny real stdio MCP server (inline `node -e`) ----------

const STDIO_SERVER = String.raw`
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let initialized = false;
process.stderr.write('mock stdio mcp: ready\n');
process.stdout.write('this log line is not JSON\n');
const TOOLS = [
  { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'create_issue', description: 'Create an issue.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
  { name: 'whoami', description: 'Who is signed in.' },
  { name: 'delete_everything', description: 'Deletes everything.', annotations: { destructiveHint: true } },
  { name: 'explicitly_not_read_only', description: 'Says it writes.', annotations: { readOnlyHint: false } },
  { name: 'fail', description: 'Always fails.', annotations: { readOnlyHint: true } },
  { name: 'slow', description: 'Never answers.', annotations: { readOnlyHint: true } },
];
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) { if (m.method === 'notifications/initialized') initialized = true; return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock-stdio', version: '1.0.0' } } });
  if (!initialized) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'not initialized' } });
  if (m.method === 'tools/list') {
    // Two pages, to exercise nextCursor.
    if (!m.params || !m.params.cursor) return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS.slice(0, 3), nextCursor: 'page-2' } });
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS.slice(3) } });
  }
  if (m.method === 'tools/call') {
    const { name, arguments: args } = m.params;
    if (name === 'echo') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo: ' + args.text }] } });
    if (name === 'create_issue') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"id":42}' }], structuredContent: { id: 42, title: args.title } } });
    if (name === 'whoami') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '{"user":"test-user"}' }] } });
    if (name === 'fail') return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'the widget is broken' }] } });
    if (name === 'slow') return;
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool ' + name } });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
});
rl.on('close', () => process.exit(0));
`;

/** A server that ignores stdin closing, so close() has to SIGTERM it. */
const STUBBORN_SERVER = String.raw`
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stubborn' } } }) + '\n');
  if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }) + '\n');
});
rl.on('close', () => {});
setInterval(() => {}, 1000);
`;

const stdioServer = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({ command: process.execPath, args: ['-e', STDIO_SERVER], ...extra });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------- a tiny real HTTP MCP server (ephemeral port) ----------

interface HttpLog {
  requests: Array<{ method: string; rpc?: string; session?: string; protocol?: string; accept?: string; auth?: string }>;
  deleted?: string;
}

function startHttpMcp(): Promise<{ server: Server; url: string; log: HttpLog }> {
  const log: HttpLog = { requests: [] };
  const SESSION = 'sess-abc-123';
  const header = (h: IncomingHttpHeaders, k: string): string | undefined => (typeof h[k] === 'string' ? (h[k] as string) : undefined);
  const server = createServer((req, res) => {
    if (req.method === 'DELETE') {
      log.deleted = header(req.headers, 'mcp-session-id');
      res.writeHead(200).end();
      return;
    }
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const m = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      log.requests.push({ method: req.method ?? '', rpc: m.method, session: header(req.headers, 'mcp-session-id'), protocol: header(req.headers, 'mcp-protocol-version'), accept: header(req.headers, 'accept'), auth: header(req.headers, 'authorization') });
      if (m.id === undefined) return void res.writeHead(202).end();
      const json = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      if (m.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': SESSION });
        return void res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-http' } } }));
      }
      if (header(req.headers, 'mcp-session-id') !== SESSION) return void res.writeHead(400).end('missing session');
      if (m.method === 'tools/list') {
        return json({
          tools: [
            { name: 'search_docs', description: 'Search the docs.', annotations: { readOnlyHint: true } },
            { name: 'post_message', description: 'Post a message to a channel.', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } },
          ],
        });
      }
      if (m.method === 'tools/call' && m.params?.name === 'search_docs') {
        // SSE answer: a progress notification first, then the result; the stream is left open on purpose.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `found: ${String(m.params.arguments?.q)}` }] } })}\n\n`);
        return;
      }
      if (m.method === 'tools/call' && m.params?.name === 'post_message') return json({ content: [{ type: 'text', text: `posted to ${String(m.params.arguments?.channel)}` }] });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, log })));
}

/** A localhost URL nothing listens on. */
async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}/mcp`;
}

const ctx = { dir: '/tmp', now: new Date(2026, 10, 25, 10, 0) };

let http: Awaited<ReturnType<typeof startHttpMcp>>;
beforeAll(async () => {
  http = await startHttpMcp();
});
afterAll(async () => {
  http.server.closeAllConnections();
  await new Promise<void>((r) => http.server.close(() => r()));
});

const opened: RegisterMcpToolsResult[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((r) => r.close()));
});
const register = async (registry: ToolRegistry, servers: Record<string, McpServerConfig>) => {
  const r = await registerMcpTools(registry, servers);
  opened.push(r);
  return r;
};

describe('v24c: MCP client over stdio', () => {
  it('initialize -> tools/list (paged) -> tools/call end to end, tolerating log lines on stdout', async () => {
    const client = new McpClient('local', stdioServer());
    try {
      const init = await client.connect();
      expect(init.serverInfo?.name).toBe('mock-stdio');
      expect(client.transportKind).toBe('stdio');
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo', 'create_issue', 'whoami', 'delete_everything', 'explicitly_not_read_only', 'fail', 'slow']);
      const r = await client.callTool('echo', { text: 'hi' });
      expect(r.content?.[0]?.text).toBe('echo: hi');
      expect(client.stderr).toContain('mock stdio mcp: ready');
      await expect(client.callTool('nope')).rejects.toThrow(/unknown tool nope/);
    } finally {
      await client.close();
    }
  });

  it('registers mcp.<server>.<tool>, read-only only when the server or config says so; everything else is external', async () => {
    const registry = new ToolRegistry();
    const r = await register(registry, { gh: stdioServer({ readOnlyTools: ['whoami'], denyTools: ['delete_everything'] }) });
    expect(r.errors).toEqual([]);
    expect(r.servers).toEqual([{ name: 'gh', transport: 'stdio', tools: 6 }]);
    expect(r.registered.sort()).toEqual(['mcp.gh.create_issue', 'mcp.gh.echo', 'mcp.gh.explicitly_not_read_only', 'mcp.gh.fail', 'mcp.gh.slow', 'mcp.gh.whoami']);

    // denyTools: hidden completely.
    expect(registry.has('mcp.gh.delete_everything')).toBe(false);

    // readOnlyHint: true -> read-only, no sensitivity.
    const echo = registry.get('mcp.gh.echo')!;
    expect(echo.readOnly).toBe(true);
    expect(echo.sensitivity).toBeUndefined();
    // readOnlyTools in config -> read-only.
    expect(registry.get('mcp.gh.whoami')!.readOnly).toBe(true);

    // No annotation, or readOnlyHint: false -> a write tool marked external.
    for (const name of ['mcp.gh.create_issue', 'mcp.gh.explicitly_not_read_only']) {
      const t = registry.get(name)!;
      expect(t.readOnly).toBe(false);
      expect(t.sensitivity).toEqual(['external']);
      expect(t.description).toContain('needs your yes');
    }
    expect(echo.description).toBe('[MCP gh] Echo the text back. args: {"text":string}');
  });

  it('write tools are gated: never during plan / execute / verify, need a yes in commit, and never reach a mission', async () => {
    const registry = new ToolRegistry();
    await register(registry, { gh: stdioServer({ readOnlyTools: ['whoami'] }) });

    // Read-only tools run in any stage.
    expect(await registry.call('mcp.gh.echo', { text: 'plan stage' }, { ...ctx, stage: 'plan' })).toBe('echo: plan stage');
    expect(await registry.call('mcp.gh.whoami', {}, { ...ctx, stage: 'execute' })).toEqual({ user: 'test-user' }); // JSON text is parsed

    // A write tool in a read-only stage: stopped before anything is sent to the server.
    for (const stage of ['plan', 'execute', 'verify'] as const) {
      await expect(registry.call('mcp.gh.create_issue', { title: 'x' }, { ...ctx, stage })).rejects.toBeInstanceOf(ToolGatedError);
    }
    // In commit, without your yes: external, so it waits for Verify.
    await expect(registry.call('mcp.gh.create_issue', { title: 'x' }, { ...ctx, stage: 'commit' })).rejects.toThrow(/external, so it needs your approval/);
    // After your yes it runs; structured content comes back as the value.
    expect(await registry.call('mcp.gh.create_issue', { title: 'Bug' }, { ...ctx, stage: 'commit', approved: true })).toEqual({ id: 42, title: 'Bug' });

    // Missions only ever see the read-only ones.
    expect(missionMayUse(registry.get('mcp.gh.echo')!)).toBe(true);
    expect(missionMayUse(registry.get('mcp.gh.create_issue')!)).toBe(false);
    const mission = missionToolRegistry(registry);
    expect(mission.has('mcp.gh.echo')).toBe(true);
    expect(mission.has('mcp.gh.create_issue')).toBe(false);
    expect(mission.has('mcp.gh.explicitly_not_read_only')).toBe(false);

    // A trusted write tool (config.tools.trusted) runs in commit without a per-run yes, like any other tool.
    const trusted = new ToolRegistry({ trusted: ['mcp.gh2.create_issue'] });
    await register(trusted, { gh2: stdioServer() });
    expect(await trusted.call('mcp.gh2.create_issue', { title: 'T' }, { ...ctx, stage: 'commit' })).toEqual({ id: 42, title: 'T' });
  });

  it('an MCP isError and a timeout become clear ToolErrors', async () => {
    const registry = new ToolRegistry();
    await register(registry, { gh: stdioServer({ timeoutMs: 300 }) });
    await expect(registry.call('mcp.gh.fail', {}, ctx)).rejects.toThrow(ToolError);
    await expect(registry.call('mcp.gh.fail', {}, ctx)).rejects.toThrow(/the widget is broken/);
    await expect(registry.call('mcp.gh.slow', {}, ctx)).rejects.toThrow(/timed out after 300ms/);
  });

  it('close() stops the stdio child, even one that ignores stdin closing', async () => {
    const client = new McpClient('local', stdioServer());
    await client.connect();
    const pid = client.pid!;
    expect(isAlive(pid)).toBe(true);
    await client.close();
    expect(isAlive(pid)).toBe(false);
    await expect(client.callTool('echo', { text: 'x' })).rejects.toThrow(/not connected/);

    const registry = new ToolRegistry();
    const r = await registerMcpTools(registry, { stubborn: { command: process.execPath, args: ['-e', STUBBORN_SERVER] } });
    const stubbornPid = r.clients.stubborn!.pid!;
    expect(isAlive(stubbornPid)).toBe(true);
    await r.close();
    expect(isAlive(stubbornPid)).toBe(false);
  });
});

describe('v24c: MCP client over HTTP', () => {
  it('initialize -> tools/list -> tools/call with JSON and SSE answers, keeping the Mcp-Session-Id', async () => {
    const registry = new ToolRegistry();
    const r = await register(registry, { docs: { url: http.url, headers: { authorization: 'Bearer test-token' } } });
    expect(r.errors).toEqual([]);
    expect(r.servers).toEqual([{ name: 'docs', transport: 'http', tools: 2 }]);
    expect(r.clients.docs!.sessionId).toBe('sess-abc-123');

    const search = registry.get('mcp.docs.search_docs')!;
    expect(search.readOnly).toBe(true);
    const post = registry.get('mcp.docs.post_message')!;
    expect(post.readOnly).toBe(false);
    expect(post.sensitivity).toEqual(['external']);
    expect(post.description).toContain('args: {"channel":string,"text":string}');

    // SSE answer (stream left open by the server): read incrementally, the progress notification is skipped.
    expect(await registry.call('mcp.docs.search_docs', { q: 'mcp' }, { ...ctx, stage: 'execute' })).toBe('found: mcp');
    // A write is gated until approved, then runs.
    await expect(registry.call('mcp.docs.post_message', { channel: 'general', text: 'hi' }, { ...ctx, stage: 'execute' })).rejects.toBeInstanceOf(ToolGatedError);
    expect(await registry.call('mcp.docs.post_message', { channel: 'general', text: 'hi' }, { ...ctx, stage: 'commit', approved: true })).toBe('posted to general');

    const rpcs = http.log.requests.map((q) => q.rpc);
    expect(rpcs).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/call']);
    const [init, ...after] = http.log.requests;
    expect(init!.session).toBeUndefined();
    for (const q of after) {
      expect(q.session).toBe('sess-abc-123');
      expect(q.protocol).toBe('2025-06-18');
    }
    for (const q of http.log.requests) {
      expect(q.accept).toBe('application/json, text/event-stream');
      expect(q.auth).toBe('Bearer test-token');
    }

    await r.close();
    expect(http.log.deleted).toBe('sess-abc-123'); // the session is ended with a DELETE
  });

  it('parses SSE data events, multi-line and CRLF', () => {
    expect(parseSseEvents('event: message\r\ndata: {"a":1}\r\n\r\ndata: line1\ndata: line2\n\ndata: partial')).toEqual({ events: ['{"a":1}', 'line1\nline2'], rest: 'data: partial' });
  });
});

describe('v24c: failing gracefully', () => {
  it('an offline HTTP server, a missing command and a bad config are reported; the healthy server still registers', async () => {
    const registry = new ToolRegistry();
    const dead = await deadUrl();
    const r = await register(registry, {
      offline: { url: dead, timeoutMs: 2_000 },
      missing: { command: 'rufus-no-such-mcp-server-binary' },
      empty: {},
      good: stdioServer(),
    });
    expect(r.servers.map((s) => s.name)).toEqual(['good']);
    expect(r.registered).toContain('mcp.good.echo');
    expect(r.errors).toHaveLength(3);
    expect(r.errors.find((e) => e.startsWith('offline:'))).toMatch(/cannot reach/);
    expect(r.errors.find((e) => e.startsWith('missing:'))).toMatch(/command not found|exited/);
    expect(r.errors.find((e) => e.startsWith('empty:'))).toMatch(/needs a "command" \(stdio\) or a "url"/);
  });

  it('a name clash is reported per tool instead of crashing', async () => {
    const registry = new ToolRegistry({ tools: [{ name: 'mcp.gh.echo', description: 'already here', readOnly: true, execute: () => 'mine' }] });
    const r = await register(registry, { gh: stdioServer() });
    expect(r.errors).toEqual([expect.stringMatching(/^gh\.echo: "mcp\.gh\.echo" is already registered/)]);
    expect(await registry.call('mcp.gh.echo', {}, ctx)).toBe('mine');
    expect(registry.has('mcp.gh.create_issue')).toBe(true);
  });
});

describe('v24c: helpers', () => {
  it('classifies strictly: only an explicit readOnlyHint === true or readOnlyTools is read-only', () => {
    expect(classifyMcpTool({ name: 'a', annotations: { readOnlyHint: true } })).toEqual({ readOnly: true });
    expect(classifyMcpTool({ name: 'a' }, { readOnlyTools: ['a'] })).toEqual({ readOnly: true });
    expect(classifyMcpTool({ name: 'a' })).toEqual({ readOnly: false, sensitivity: ['external'] });
    expect(classifyMcpTool({ name: 'a', annotations: { readOnlyHint: 'true' as unknown as boolean } })).toEqual({ readOnly: false, sensitivity: ['external'] });
    expect(classifyMcpTool({ name: 'a', annotations: { destructiveHint: false } })).toEqual({ readOnly: false, sensitivity: ['external'] });
  });

  it('names are safe registry names; results become plain values', () => {
    expect(mcpToolName('git hub', 'issues/create')).toBe('mcp.git_hub.issues_create');
    expect(mcpResultValue({ structuredContent: { a: 1 }, content: [{ type: 'text', text: 'x' }] })).toEqual({ a: 1 });
    expect(mcpResultValue({ content: [{ type: 'text', text: '[1,2]' }] })).toEqual([1, 2]);
    expect(mcpResultValue({ content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }] })).toEqual([{ type: 'image', data: 'AAA', mimeType: 'image/png' }]);
  });
});

describe('v24c: rufus tools', () => {
  it('lists MCP tools with their safety flags and reports an offline server without failing', async () => {
    const dir = await tempDir();
    const dead = await deadUrl();
    await writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ version: 1, tools: { web: false, mcp: { gh: stdioServer({ denyTools: ['delete_everything'] }), down: { url: dead, timeoutMs: 2_000 } } } }),
    );
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };
    await main(['--dir', dir, 'tools'], io);
    const text = out.join('\n');
    expect(text).toContain('MCP: gh (stdio, 6 tools).');
    expect(text).toMatch(/mcp\.gh\.echo \(read-only\): \[MCP gh\] Echo the text back/);
    expect(text).toMatch(/mcp\.gh\.create_issue \(acts, external\)/);
    expect(text).not.toContain('delete_everything');
    expect(err.join('\n')).toMatch(/MCP server skipped \(Rufus keeps running without it\): down: .*cannot reach/);
  });
});
