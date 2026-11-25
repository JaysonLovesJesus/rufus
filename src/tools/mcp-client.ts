import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Sensitivity } from '../anchor/anchor';
import type { McpServerConfig } from '../types';
import { parseOutput, ToolError, type ToolDefinition, type ToolRegistry } from './tools';

/**
 * v24c: a zero-dependency MCP (Model Context Protocol) client, so any MCP server (GitHub, Linear, Notion, a calendar,
 * your own) plugs straight into the `ToolRegistry` instead of a bespoke script per app.
 *
 * Two transports, both plain JSON-RPC 2.0:
 *  - stdio: spawn a local server process and exchange newline-delimited JSON messages on stdin / stdout.
 *  - HTTP ("Streamable HTTP"): POST each message; the answer is either `application/json` or a `text/event-stream`
 *    whose `data:` lines carry it. An `Mcp-Session-Id` from the server is sent back on every later request.
 *
 * Every discovered tool is registered as `mcp.<server>.<tool>`, and Rufus's own guardrails decide when it may run:
 * a tool is read-only ONLY when the server says so (`annotations.readOnlyHint === true`) or you listed it in
 * `readOnlyTools`. Everything else is a write tool marked `external`: it never runs during plan / execute / verify or in
 * a mission, waits for your yes on Verify (Earned Trust starts it at `check`), stops on the kill switch, and is written
 * to `audit.jsonl` when it runs.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
/** How much of a stdio server's stderr is kept for error messages. */
const STDERR_KEEP = 4_000;
const CLIENT_INFO = { name: 'rufus', version: '0.1.0' };

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One tool as `tools/list` describes it. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  annotations?: McpToolAnnotations;
}

export interface McpContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** What `tools/call` answers. */
export interface McpCallResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpInitializeResult {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
}

/** A JSON-RPC error answered by the server. */
export class McpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'McpError';
  }
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpTransport {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

const describeErr = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const fromRpcError = (e: NonNullable<JsonRpcMessage['error']>): McpError => new McpError(typeof e.code === 'number' ? e.code : -32603, e.message ?? 'unknown error', e.data);

const timeoutText = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);

// ---------- stdio ----------

class StdioTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private buffer = '';
  private stderrTail = '';
  private exited = false;
  private exitError: Error | undefined;
  private readonly exitPromise: Promise<void>;

  constructor(private readonly label: string, command: string, args: string[], env: Record<string, string> | undefined) {
    this.child = spawn(command, args, { env: { ...process.env, ...(env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_KEEP);
    });
    this.child.stdin.on('error', () => undefined); // a closed pipe surfaces through 'exit'
    this.exitPromise = new Promise<void>((resolve) => {
      this.child.once('error', (err: NodeJS.ErrnoException) => {
        this.fail(err.code === 'ENOENT' ? new Error(`command not found: ${command} (is it installed and on PATH?)`) : err);
        resolve();
      });
      this.child.once('exit', (code, signal) => {
        this.fail(new Error(`the server process exited (${signal ?? `code ${code}`})${this.stderr ? `: ${this.stderr.slice(-300)}` : ''}`));
        resolve();
      });
    });
  }

  /** The last few KB the server wrote to stderr. */
  get stderr(): string {
    return this.stderrTail.trim();
  }

  private fail(err: Error): void {
    this.exited = true;
    this.exitError ??= err;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.exitError);
      this.pending.delete(id);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // a server printing logs to stdout: ignore the line
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (msg.method !== undefined) {
      // A request from the server (ping, sampling, roots...). Answer ping; refuse the rest. Notifications are ignored.
      if (msg.id !== undefined && msg.id !== null) {
        const reply = msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Rufus does not support ${msg.method}` } };
        this.write(reply);
      }
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(fromRpcError(msg.error));
    else p.resolve(msg.result);
  }

  private write(msg: unknown): void {
    if (this.exited || !this.child.stdin.writable) throw this.exitError ?? new Error('the server process is not running');
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.exited) return Promise.reject(this.exitError ?? new Error('the server process is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: ${method} timed out after ${timeoutText(timeoutMs)}${this.stderr ? ` (stderr: ${this.stderr.slice(-300)})` : ''}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /** Closes stdin (the MCP way to ask a stdio server to stop), then SIGTERM, then SIGKILL. Resolves once it exited. */
  async close(): Promise<void> {
    if (!this.exited) {
      this.child.stdin.end();
      const exitedWithin = (ms: number) => Promise.race([this.exitPromise.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
      if (!(await exitedWithin(1_000))) {
        this.child.kill('SIGTERM');
        if (!(await exitedWithin(1_000))) {
          this.child.kill('SIGKILL');
          await this.exitPromise;
        }
      }
    }
    this.fail(new Error('the MCP client was closed'));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }
}

// ---------- HTTP ----------

/** Parses SSE `data:` events out of a text stream, one complete event at a time. */
export function parseSseEvents(text: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const blocks = text.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (data.length) events.push(data.join('\n'));
  }
  return { events, rest };
}

class HttpTransport implements McpTransport {
  private nextId = 1;
  private sessionId: string | undefined;
  protocolVersion: string | undefined;

  constructor(private readonly label: string, private readonly url: string, private readonly headers: Record<string, string>, private readonly fetchImpl: typeof fetch) {}

  private requestHeaders(): Record<string, string> {
    return {
      ...this.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    };
  }

  private async post(body: JsonRpcMessage, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, { method: 'POST', headers: this.requestHeaders(), body: JSON.stringify(body), signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new Error(`${this.label}: cannot reach ${this.url} (${describeErr((err as { cause?: unknown }).cause ?? err)})`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    return res;
  }

  /** Runs `fn` with an abort signal that fires after `timeoutMs` (it also cuts a stream that never answers). */
  private async timed<T>(method: string, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fn(ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error(`${this.label}: ${method} timed out after ${timeoutText(timeoutMs)}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return this.timed(method, timeoutMs, (signal) => this.exchange(id, method, params, signal));
  }

  private async exchange(id: number, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const res = await this.post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, signal);
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).trim().slice(0, 300);
      throw new Error(`${this.label}: ${method} got HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const type = res.headers.get('content-type') ?? '';
    const match = (msg: JsonRpcMessage): unknown => {
      if (msg.error) throw fromRpcError(msg.error);
      return msg.result;
    };
    if (type.includes('text/event-stream')) {
      if (!res.body) throw new Error(`${this.label}: ${method} answered an empty event stream`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (value) buf += decoder.decode(value, { stream: true });
          if (done) buf += '\n\n';
          const parsed = parseSseEvents(buf);
          buf = parsed.rest;
          for (const data of parsed.events) {
            let msg: JsonRpcMessage | JsonRpcMessage[];
            try {
              msg = JSON.parse(data) as JsonRpcMessage | JsonRpcMessage[];
            } catch {
              continue;
            }
            for (const m of Array.isArray(msg) ? msg : [msg]) if (m.id === id && m.method === undefined) return match(m);
          }
          if (done) break;
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }
      throw new Error(`${this.label}: ${method} stream ended without an answer`);
    }
    const text = await res.text();
    let body: JsonRpcMessage | JsonRpcMessage[];
    try {
      body = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
    } catch {
      throw new Error(`${this.label}: ${method} answered something that is not JSON: ${text.trim().slice(0, 200)}`);
    }
    const hit = (Array.isArray(body) ? body : [body]).find((m) => m.id === id);
    if (!hit) throw new Error(`${this.label}: ${method} answered without a matching id`);
    return match(hit);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.timed(method, DEFAULT_MCP_TIMEOUT_MS, async (signal) => {
      const res = await this.post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }, signal);
      await res.body?.cancel().catch(() => undefined);
    });
  }

  /** Ends the session (a best-effort `DELETE`, as the spec asks). */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_000);
    try {
      const res = await this.fetchImpl(this.url, { method: 'DELETE', headers: { ...this.headers, 'mcp-session-id': this.sessionId }, signal: ctrl.signal });
      await res.body?.cancel().catch(() => undefined);
    } catch {
      /* the session just times out server-side */
    } finally {
      clearTimeout(timer);
      this.sessionId = undefined;
    }
  }

  get session(): string | undefined {
    return this.sessionId;
  }
}

// ---------- the client ----------

export interface McpClientOptions {
  /** The fetch used by the HTTP transport (tests). Default: global fetch. */
  fetch?: typeof fetch;
}

/** One connection to one MCP server, over stdio (`command`) or HTTP (`url`). */
export class McpClient {
  private transport: McpTransport | undefined;
  private readonly timeoutMs: number;
  /** What `initialize` answered, once connected. */
  server: McpInitializeResult | undefined;

  constructor(readonly name: string, readonly config: McpServerConfig, private readonly opts: McpClientOptions = {}) {
    if (!config || (!config.command?.trim() && !config.url?.trim())) throw new Error(`MCP server "${name}" needs a "command" (stdio) or a "url" (HTTP) in config.tools.mcp.`);
    if (config.command?.trim() && config.url?.trim()) throw new Error(`MCP server "${name}" has both "command" and "url": pick one.`);
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_MCP_TIMEOUT_MS;
  }

  get transportKind(): 'stdio' | 'http' {
    return this.config.command?.trim() ? 'stdio' : 'http';
  }

  /** The last few KB a stdio server wrote to stderr ('' for HTTP). */
  get stderr(): string {
    return this.transport instanceof StdioTransport ? this.transport.stderr : '';
  }

  /** The stdio server's process id (tests). */
  get pid(): number | undefined {
    return this.transport instanceof StdioTransport ? this.transport.pid : undefined;
  }

  /** The `Mcp-Session-Id` the HTTP server gave, if any. */
  get sessionId(): string | undefined {
    return this.transport instanceof HttpTransport ? this.transport.session : undefined;
  }

  private get live(): McpTransport {
    if (!this.transport) throw new Error(`MCP server "${this.name}" is not connected.`);
    return this.transport;
  }

  /** Starts (or reaches) the server, then `initialize` + `notifications/initialized`. */
  async connect(): Promise<McpInitializeResult> {
    if (this.transport) throw new Error(`MCP server "${this.name}" is already connected.`);
    const label = `MCP server "${this.name}"`;
    const cfg = this.config;
    this.transport = cfg.command?.trim()
      ? new StdioTransport(label, cfg.command, cfg.args ?? [], cfg.env)
      : new HttpTransport(label, cfg.url!, cfg.headers ?? {}, this.opts.fetch ?? fetch);
    try {
      const init = ((await this.live.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, this.timeoutMs)) ?? {}) as McpInitializeResult;
      if (this.transport instanceof HttpTransport) this.transport.protocolVersion = init.protocolVersion ?? MCP_PROTOCOL_VERSION;
      await this.live.notify('notifications/initialized');
      this.server = init;
      return init;
    } catch (err) {
      await this.close().catch(() => undefined);
      throw err;
    }
  }

  /** Every tool the server offers (follows `nextCursor` pages). */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = ((await this.live.request('tools/list', cursor ? { cursor } : {}, this.timeoutMs)) ?? {}) as { tools?: McpTool[]; nextCursor?: string };
      for (const t of res.tools ?? []) if (t && typeof t.name === 'string' && t.name) tools.push(t);
      cursor = typeof res.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    return ((await this.live.request('tools/call', { name, arguments: args }, this.timeoutMs)) ?? {}) as McpCallResult;
  }

  async close(): Promise<void> {
    const t = this.transport;
    if (!t) return;
    this.transport = undefined;
    await t.close();
  }
}

// ---------- registering MCP tools ----------

/** Rufus tool names are `[a-z0-9_.:-]`: anything else in a server or tool name becomes `_`. */
const safePart = (s: string): string => s.replace(/[^a-z0-9_:-]/gi, '_').replace(/^[^a-z0-9]/i, (c) => `x${c}`);

/** The registry name of an MCP tool: `mcp.<server>.<tool>`. */
export const mcpToolName = (server: string, tool: string): string => `mcp.${safePart(server)}.${safePart(tool)}`;

/**
 * The ironclad default: read-only only when the server explicitly says so (`annotations.readOnlyHint === true`) or you
 * listed the tool in `readOnlyTools`. Anything else is a write that reaches outside: `readOnly: false`, `external`.
 */
export function classifyMcpTool(tool: McpTool, cfg: Pick<McpServerConfig, 'readOnlyTools'> = {}): { readOnly: boolean; sensitivity?: Sensitivity[] } {
  const readOnly = Boolean(tool.annotations?.readOnlyHint === true || cfg.readOnlyTools?.includes(tool.name));
  return readOnly ? { readOnly: true } : { readOnly: false, sensitivity: ['external'] };
}

/** A `tools/call` answer as a plain value: structured content, else the text (parsed as JSON when it is JSON), else the content list. */
export function mcpResultValue(result: McpCallResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length && content.every((c) => c?.type === 'text' && typeof c.text === 'string')) return parseOutput(content.map((c) => c.text).join('\n'));
  return content;
}

const resultText = (result: McpCallResult): string =>
  (Array.isArray(result.content) ? result.content : [])
    .map((c) => (typeof c?.text === 'string' ? c.text : ''))
    .join(' ')
    .trim();

function describeMcpTool(server: string, tool: McpTool, readOnly: boolean): string {
  const base = (tool.description ?? tool.annotations?.title ?? tool.title ?? tool.name).replace(/\s+/g, ' ').trim();
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const keys = Object.keys(props);
  const args = keys.length ? ` args: {${keys.map((k) => `"${k}"${required.has(k) ? '' : '?'}:${props[k]?.type ?? 'any'}`).join(',')}}` : '';
  const safety = readOnly ? '' : ' External: needs your yes until it earned trust.';
  return `[MCP ${server}] ${base.length > 300 ? `${base.slice(0, 299)}…` : base}${args}${safety}`;
}

/** Wraps one MCP tool as a Rufus `ToolDefinition` (classified by `classifyMcpTool`). */
export function mcpToolDefinition(server: string, client: Pick<McpClient, 'callTool'>, tool: McpTool, cfg: Pick<McpServerConfig, 'readOnlyTools'> = {}): ToolDefinition<Record<string, unknown>, unknown> {
  const name = mcpToolName(server, tool.name);
  const cls = classifyMcpTool(tool, cfg);
  return {
    name,
    description: describeMcpTool(server, tool, cls.readOnly),
    ...cls,
    async execute(args) {
      let result: McpCallResult;
      try {
        result = await client.callTool(tool.name, args ?? {});
      } catch (err) {
        throw new ToolError(name, describeErr(err));
      }
      if (result.isError) throw new ToolError(name, resultText(result).slice(0, 300) || 'the MCP server reported an error');
      return mcpResultValue(result);
    },
  };
}

export interface RegisterMcpToolsOptions extends McpClientOptions {}

export interface RegisterMcpToolsResult {
  /** Registry names of every tool registered (`mcp.<server>.<tool>`). */
  registered: string[];
  /** One line per server (or tool) that failed. A failed server never stops the others. */
  errors: string[];
  /** The servers that connected, with their tool counts. */
  servers: Array<{ name: string; transport: 'stdio' | 'http'; tools: number }>;
  /** The live clients, by server name. */
  clients: Record<string, McpClient>;
  /** Closes every connection (stdio children are stopped). */
  close: () => Promise<void>;
}

/**
 * Connects to each configured MCP server (in parallel) and registers its tools as `mcp.<server>.<tool>`. A server that
 * is offline, missing or broken is reported in `errors` and skipped: Rufus keeps running without it.
 */
export async function registerMcpTools(registry: ToolRegistry, servers: Record<string, McpServerConfig>, opts: RegisterMcpToolsOptions = {}): Promise<RegisterMcpToolsResult> {
  const out: RegisterMcpToolsResult = { registered: [], errors: [], servers: [], clients: {}, close: async () => undefined };
  const entries = Object.entries(servers ?? {});
  const connected = await Promise.all(
    entries.map(async ([name, cfg]) => {
      let client: McpClient | undefined;
      try {
        client = new McpClient(name, cfg, opts);
        await client.connect();
        return { name, cfg, client, tools: await client.listTools() };
      } catch (err) {
        await client?.close().catch(() => undefined);
        return { name, error: describeErr(err) };
      }
    }),
  );
  for (const c of connected) {
    if ('error' in c) {
      out.errors.push(`${c.name}: ${c.error}`);
      continue;
    }
    const deny = new Set(c.cfg.denyTools ?? []);
    let count = 0;
    for (const tool of c.tools) {
      if (deny.has(tool.name)) continue;
      try {
        const def = mcpToolDefinition(c.name, c.client, tool, c.cfg);
        if (registry.has(def.name)) throw new Error(`"${def.name}" is already registered`);
        registry.register(def);
        out.registered.push(def.name);
        count++;
      } catch (err) {
        out.errors.push(`${c.name}.${tool.name}: ${describeErr(err)}`);
      }
    }
    out.clients[c.name] = c.client;
    out.servers.push({ name: c.name, transport: c.client.transportKind, tools: count });
  }
  out.close = async () => {
    await Promise.all(Object.values(out.clients).map((cl) => cl.close().catch(() => undefined)));
  };
  return out;
}
