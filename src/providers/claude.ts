import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import readline from 'node:readline';
import type { ModelCallStats, ModelProvider, ModelRequest } from '../types';

interface WarmSlot {
  proc: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  exited: boolean;
}

/** Warm processes kept per provider (e.g. Decide plus one brain state); the oldest is dropped past this. */
const MAX_WARM = 2;

/**
 * The CLI flags that keep a daemon model call isolated from the owner's own Claude Code setup:
 * - Rufus's rules are the system prompt (`--system-prompt`), so the default agent prompt never loads and the rules cache across turns;
 * - no user/project/local settings, CLAUDE.md, memory, hooks, skills or plugins (`--setting-sources ""`, `--safe-mode`);
 * - no MCP servers or tools, and nothing saved to the owner's session history (`--no-session-persistence`).
 */
export function claudeCliArgs(model: string, system: string): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--safe-mode',
    '--no-session-persistence',
    '--system-prompt',
    system,
    '--model',
    model,
  ];
}

/** Reads usage and cost from the CLI's final `result` line. */
export function statsFromResult(model: string, durationMs: number, msg: Record<string, unknown>): ModelCallStats {
  const usage = (msg.usage && typeof msg.usage === 'object' ? msg.usage : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const stats: ModelCallStats = { model, durationMs, ok: msg.is_error !== true };
  const fields: Array<[keyof ModelCallStats, unknown]> = [
    ['inputTokens', usage.input_tokens],
    ['outputTokens', usage.output_tokens],
    ['cacheReadTokens', usage.cache_read_input_tokens],
    ['cacheWriteTokens', usage.cache_creation_input_tokens],
    ['costUsd', msg.total_cost_usd],
  ];
  for (const [k, v] of fields) {
    const n = num(v);
    if (n !== undefined) (stats as unknown as Record<string, number>)[k] = n;
  }
  return stats;
}

/**
 * Claude CLI provider on the owner's existing Claude subscription.
 * - Each call is a fresh process with fresh context (stream-json in and out), isolated by `claudeCliArgs`.
 * - A warm process per (model, system prompt) is spawned ahead of the next call, so turns skip the cold start.
 * - Runs from the workspace (never the git repo), so no project CLAUDE.md or developer memory applies.
 */
export class ClaudeCliProvider implements ModelProvider {
  readonly name: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly cwd: string;
  private warm = new Map<string, WarmSlot>();
  private closed = false;

  constructor(opts: { name?: string; model?: string; timeoutMs?: number; cwd?: string } = {}) {
    this.defaultModel = opts.model ?? 'opus';
    this.name = opts.name ?? `claude-cli:${this.defaultModel}`;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.cwd = opts.cwd ?? os.tmpdir();
  }

  private static key(model: string, system: string): string {
    return `${model}:${createHash('sha1').update(system).digest('hex')}`;
  }

  private spawnWarm(model: string, system: string): WarmSlot {
    const key = ClaudeCliProvider.key(model, system);
    const proc = spawn('claude', claudeCliArgs(model, system), { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const rl = readline.createInterface({ input: proc.stdout });
    const slot: WarmSlot = { proc, rl, exited: false };
    proc.once('error', () => {
      slot.exited = true;
    });
    proc.once('exit', () => {
      slot.exited = true;
      if (this.warm.get(key) === slot) this.warm.delete(key);
    });
    return slot;
  }

  /** Pre-warms a fresh Claude CLI process in the background for the next call with this model and system prompt. */
  prewarm(model = this.defaultModel, system = ''): void {
    if (this.closed) return;
    const key = ClaudeCliProvider.key(model, system);
    const existing = this.warm.get(key);
    if (existing && !existing.exited) return;
    while (this.warm.size >= MAX_WARM) {
      const [oldKey, old] = this.warm.entries().next().value as [string, WarmSlot];
      this.warm.delete(oldKey);
      try {
        old.rl.close();
        old.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.warm.set(key, this.spawnWarm(model, system));
  }

  close(): void {
    this.closed = true;
    for (const slot of this.warm.values()) {
      try {
        slot.rl.close();
        slot.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.warm.clear();
  }

  async complete(req: ModelRequest): Promise<string> {
    return (await this.completeWithStats(req)).text;
  }

  async completeWithStats(req: ModelRequest): Promise<{ text: string; stats: ModelCallStats }> {
    const model = req.model ?? this.defaultModel;
    const system = req.system.trim();
    const key = ClaudeCliProvider.key(model, system);
    const existing = this.warm.get(key);
    this.warm.delete(key);
    const slot = existing && !existing.exited ? existing : this.spawnWarm(model, system);

    // Pre-warm the next fresh process for the same model and rules while this call runs
    this.prewarm(model, system);

    const payload = `${JSON.stringify({ type: 'user', message: { role: 'user', content: req.prompt.trim() } })}\n`;
    const started = Date.now();

    return new Promise<{ text: string; stats: ModelCallStats }>((resolve, reject) => {
      let settled = false;
      let stderrBuf = '';
      const finish = (err?: Error, value?: string, stats?: ModelCallStats) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          slot.rl.close();
          slot.proc.stdin.end();
          slot.proc.kill();
        } catch {
          /* ignore */
        }
        if (err) reject(Object.assign(err, { stats: stats ?? { model, durationMs: Date.now() - started, ok: false, error: err.message } }));
        else resolve({ text: (value ?? '').trim(), stats: stats ?? { model, durationMs: Date.now() - started, ok: true } });
      };

      const timer = setTimeout(() => finish(new Error(`claude CLI timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      timer.unref?.();

      slot.proc.stderr.on('data', (chunk) => {
        stderrBuf += String(chunk);
      });

      slot.rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line) as { type?: string; is_error?: boolean; result?: string };
          if (msg.type === 'result') {
            const stats = statsFromResult(model, Date.now() - started, msg as Record<string, unknown>);
            if (msg.is_error) finish(new Error(`claude CLI error: ${msg.result || stderrBuf.trim()}`), undefined, { ...stats, error: String(msg.result || stderrBuf.trim()).slice(0, 300) });
            else finish(undefined, String(msg.result ?? ''), stats);
          }
        } catch {
          /* ignore non-JSON line */
        }
      });

      slot.proc.once('exit', (code) => {
        if (!settled) finish(new Error(`claude CLI exited (${code}): ${stderrBuf.trim()}`));
      });

      slot.proc.stdin.write(payload);
      slot.proc.stdin.end();
    });
  }
}

/** Deterministic in-memory provider for unit and integration tests. */
export class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  readonly calls: ModelRequest[] = [];
  private readonly responder: (req: ModelRequest, index: number) => string | Promise<string>;

  constructor(responder: (req: ModelRequest, index: number) => string | Promise<string>) {
    this.responder = responder;
  }

  async complete(req: ModelRequest): Promise<string> {
    const idx = this.calls.length;
    this.calls.push(req);
    return await this.responder(req, idx);
  }
}
