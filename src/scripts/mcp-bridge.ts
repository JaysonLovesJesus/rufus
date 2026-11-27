import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolManifest } from '../types';
import type { ToolRegistry } from './registry';

export interface StdioMcpServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpMcpServerConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

interface JsonRpcResponse {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

const READ_ONLY_NAME = /^(?:get|list|read|search|find|inspect|status|snapshot|query|fetch|check|show|describe|count|view|ping|health|whoami|tabs|history)(?:[_-]|$)/i;
const WRITE_NAME = /(?:^|[_-])(?:create|update|delete|remove|write|edit|set|put|post|send|click|type|press|navigate|open|close|run|exec|eval|upload|submit|approve|merge|push|commit|install|kill|stop|start|restart)(?:[_-]|$)/i;

/** Decides whether an MCP tool is read-only (runs quietly) or write (starts at draft on the Trust Ladder). */
export function isMcpToolReadOnly(tool: McpToolDef): boolean {
  if (tool.annotations?.readOnlyHint === true) return true;
  if (tool.annotations?.readOnlyHint === false) return false;
  if (tool.annotations?.destructiveHint === true) return false;
  if (WRITE_NAME.test(tool.name)) return false;
  return READ_ONLY_NAME.test(tool.name);
}

/** Sanitizes a server or tool name into a clean dot-safe Rufus tool id segment. */
function safeSegment(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}

/** Loads configured MCP servers from `<workspaceDir>/config.json` (and `~/.claude.json` when running in the default workspace). */
export async function loadMcpConfigs(workspaceDir: string, opts: { includeClaudeConfig?: boolean } = {}): Promise<Record<string, McpServerConfig>> {
  const merged: Record<string, McpServerConfig> = {};
  const isDefault = path.resolve(workspaceDir) === path.join(os.homedir(), '.rufus-v2');
  const includeClaude = opts.includeClaudeConfig ?? isDefault;
  const sources = [
    ...(includeClaude ? [path.join(os.homedir(), '.claude.json')] : []),
    path.join(workspaceDir, 'config.json'),
  ];
  for (const file of sources) {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
      if (!raw?.mcpServers || typeof raw.mcpServers !== 'object') continue;
      for (const [name, cfg] of Object.entries(raw.mcpServers)) {
        if (!cfg || typeof cfg !== 'object') continue;
        if ('url' in cfg && typeof cfg.url === 'string' && cfg.url.trim()) {
          merged[name] = { type: cfg.type === 'sse' ? 'sse' : 'http', url: cfg.url.trim(), ...(cfg.headers ? { headers: cfg.headers } : {}) };
        } else if ('command' in cfg && typeof cfg.command === 'string' && cfg.command.trim()) {
          merged[name] = {
            type: 'stdio',
            command: cfg.command.trim(),
            ...(Array.isArray(cfg.args) ? { args: cfg.args.map(String) } : {}),
            ...(cfg.env ? { env: cfg.env } : {}),
          };
        }
      }
    } catch {
      /* missing or unreadable config is fine */
    }
  }
  return merged;
}

interface McpClient {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; text: string; raw: unknown }>;
  close(): void;
}

function formatMcpContent(result: Record<string, unknown>): { ok: boolean; text: string; raw: unknown } {
  const isError = result.isError === true;
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content
    .map((item: unknown) => {
      if (!item || typeof item !== 'object') return '';
      const rec = item as Record<string, unknown>;
      if (typeof rec.text === 'string') return rec.text;
      if (rec.type === 'resource' && rec.resource && typeof rec.resource === 'object') {
        const res = rec.resource as Record<string, unknown>;
        return typeof res.text === 'string' ? res.text : JSON.stringify(res);
      }
      return JSON.stringify(rec);
    })
    .filter(Boolean);
  const text = parts.join('\n').trim() || (result.structuredContent ? JSON.stringify(result.structuredContent) : isError ? 'MCP tool returned an error.' : 'ok');
  return { ok: !isError, text, raw: result.structuredContent ?? (parts.length === 1 ? parts[0] : parts) };
}

class StdioMcpClient implements McpClient {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buf = '';
  private pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private initialized = false;

  constructor(private readonly cfg: StdioMcpServerConfig) {}

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return this.proc;
    this.initialized = false;
    this.buf = '';
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.cfg.env ?? {}) },
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl = this.buf.indexOf('\n');
      while (nl >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as JsonRpcResponse;
            if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
              const p = this.pending.get(msg.id)!;
              this.pending.delete(msg.id);
              clearTimeout(p.timer);
              p.resolve(msg);
            }
          } catch {
            /* ignore non-JSON stdout lines */
          }
        }
        nl = this.buf.indexOf('\n');
      }
    });
    const failAll = (reason: string) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      this.pending.clear();
      this.initialized = false;
    };
    proc.on('error', (err) => failAll(err.message));
    proc.on('exit', (code) => failAll(`MCP server exited (${code ?? 'signal'})`));
    this.proc = proc;
    return proc;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const proc = this.ensureStarted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          if (msg.error) reject(new Error(msg.error.message || `MCP error ${msg.error.code ?? ''}`));
          else resolve(msg.result ?? {});
        },
        reject,
        timer,
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private async ensureInit(timeoutMs: number): Promise<void> {
    if (this.initialized) return;
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rufus', version: '0.1.0' } }, timeoutMs);
    this.proc?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.ensureInit(5_000);
    const res = await this.request('tools/list', {}, 5_000);
    return Array.isArray(res.tools) ? (res.tools as McpToolDef[]) : [];
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; text: string; raw: unknown }> {
    await this.ensureInit(Math.min(10_000, timeoutMs));
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return formatMcpContent(res);
  }

  close(): void {
    if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
    this.proc = undefined;
    this.initialized = false;
  }
}

class HttpMcpClient implements McpClient {
  private nextId = 1;
  private sessionId?: string;
  private initialized = false;

  constructor(private readonly cfg: HttpMcpServerConfig) {}

  private async rpc(method: string, params: Record<string, unknown>, timeoutMs: number, isNotification = false): Promise<Record<string, unknown>> {
    const id = isNotification ? undefined : this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params });
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...(this.cfg.headers ?? {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (isNotification) return {};
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const ctype = res.headers.get('content-type') ?? '';
    const rawText = await res.text();
    let msg: JsonRpcResponse | undefined;
    if (ctype.includes('text/event-stream')) {
      for (const line of rawText.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as JsonRpcResponse;
          if (parsed.id === id || parsed.result || parsed.error) msg = parsed;
        } catch {
          /* skip non-json SSE line */
        }
      }
    } else {
      msg = JSON.parse(rawText) as JsonRpcResponse;
    }
    if (!msg) throw new Error('MCP HTTP returned empty response');
    if (msg.error) throw new Error(msg.error.message || `MCP error ${msg.error.code ?? ''}`);
    return msg.result ?? {};
  }

  private async ensureInit(timeoutMs: number): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rufus', version: '0.1.0' } }, timeoutMs);
    await this.rpc('notifications/initialized', {}, 2_000, true).catch(() => undefined);
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.ensureInit(5_000);
    const res = await this.rpc('tools/list', {}, 5_000);
    return Array.isArray(res.tools) ? (res.tools as McpToolDef[]) : [];
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; text: string; raw: unknown }> {
    await this.ensureInit(Math.min(10_000, timeoutMs));
    const res = await this.rpc('tools/call', { name, arguments: args }, timeoutMs);
    return formatMcpContent(res);
  }

  close(): void {
    this.initialized = false;
  }
}

export interface McpBridgeHandle {
  registered: string[];
  failed: Array<{ server: string; error: string }>;
  close(): void;
}

/**
 * Discovers tools from every configured MCP server and registers them into ToolRegistry through the Trust Ladder:
 * read-only MCP tools run quietly (`act_quietly`), and write/mutating MCP tools start at `draft` (asks the owner).
 */
export async function registerMcpTools(opts: {
  registry: ToolRegistry;
  servers: Record<string, McpServerConfig>;
}): Promise<McpBridgeHandle> {
  const clients: McpClient[] = [];
  const registered: string[] = [];
  const failed: Array<{ server: string; error: string }> = [];

  await Promise.all(
    Object.entries(opts.servers).map(async ([serverName, cfg]) => {
      const client: McpClient = 'url' in cfg ? new HttpMcpClient(cfg) : new StdioMcpClient(cfg);
      try {
        const tools = await client.listTools();
        clients.push(client);
        const srv = safeSegment(serverName);
        for (const t of tools) {
          if (!t?.name) continue;
          const id = `mcp.${srv}.${safeSegment(t.name)}`;
          const readOnly = isMcpToolReadOnly(t);
          const schema =
            t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object'
              ? (t.inputSchema as unknown as ToolManifest['inputSchema'])
              : { type: 'object' as const, properties: {}, additionalProperties: true };
          const manifest: ToolManifest = {
            id,
            version: 1,
            description: `[MCP:${serverName}] ${(t.description || t.name).trim().slice(0, 260)}`,
            whenToUse: [`Using ${serverName} MCP tool "${t.name}"`],
            effect: readOnly ? 'read' : 'write',
            requiresApproval: !readOnly,
            defaultTrust: readOnly ? 'act_quietly' : 'draft',
            ...(t.annotations?.destructiveHint === true ? { reversible: false } : {}),
            timeoutMs: 30_000,
            inputSchema: schema,
          };
          await opts.registry.registerInline(manifest, async (input) => {
            try {
              const out = await client.callTool(t.name, input, 28_000);
              return {
                ok: out.ok,
                summary: `${serverName}.${t.name}: ${out.text.slice(0, 240)}`,
                data: out.raw,
                ...(out.ok ? (readOnly ? {} : { changes: [`mcp:${serverName}:${t.name}`] }) : { error: out.text.slice(0, 400) }),
              };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return { ok: false, summary: `${serverName}.${t.name} failed: ${msg}`, error: msg };
            }
          });
          registered.push(id);
        }
      } catch (err) {
        client.close();
        failed.push({ server: serverName, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  return {
    registered,
    failed,
    close: () => {
      for (const c of clients) c.close();
    },
  };
}
