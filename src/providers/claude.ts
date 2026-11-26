import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { ModelProvider, ModelRequest } from '../types';

interface WarmSlot {
  proc: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  exited: boolean;
}

/**
 * Fast Claude CLI provider on your existing Claude subscription:
 * - Passes `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools ""` so Claude CLI doesn't load 600k+ tokens of unrelated MCP schemas.
 * - Uses `--input-format stream-json --output-format stream-json --verbose` with a pre-warmed fresh process pool (size 1)
 *   so every turn gets 100% fresh context with zero cold-start process spawn lag!
 */
export class ClaudeCliProvider implements ModelProvider {
  readonly name: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private warmByModel = new Map<string, WarmSlot>();
  private closed = false;

  constructor(opts: { name?: string; model?: string; timeoutMs?: number } = {}) {
    this.defaultModel = opts.model ?? 'opus';
    this.name = opts.name ?? `claude-cli:${this.defaultModel}`;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  private spawnWarm(model: string): WarmSlot {
    const args = [
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
      '--model',
      model,
    ];
    const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const rl = readline.createInterface({ input: proc.stdout });
    const slot: WarmSlot = { proc, rl, exited: false };
    proc.once('exit', () => {
      slot.exited = true;
      if (this.warmByModel.get(model) === slot) this.warmByModel.delete(model);
    });
    return slot;
  }

  /** Pre-warms a fresh Claude CLI process in the background for the next turn. */
  prewarm(model = this.defaultModel): void {
    if (this.closed) return;
    const existing = this.warmByModel.get(model);
    if (existing && !existing.exited) return;
    this.warmByModel.set(model, this.spawnWarm(model));
  }

  close(): void {
    this.closed = true;
    for (const slot of this.warmByModel.values()) {
      try {
        slot.rl.close();
        slot.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.warmByModel.clear();
  }

  async complete(req: ModelRequest): Promise<string> {
    const model = req.model ?? this.defaultModel;
    const existing = this.warmByModel.get(model);
    this.warmByModel.delete(model);
    const slot = existing && !existing.exited ? existing : this.spawnWarm(model);

    // Pre-warm the next fresh process immediately in the background while this turn runs
    this.prewarm(model);

    const combined = `${req.system.trim()}\n\n---\n\n${req.prompt.trim()}`;
    const payload = `${JSON.stringify({ type: 'user', message: { role: 'user', content: combined } })}\n`;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let stderrBuf = '';
      const finish = (err?: Error, value?: string) => {
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
        if (err) reject(err);
        else resolve((value ?? '').trim());
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
            if (msg.is_error) finish(new Error(`claude CLI error: ${msg.result || stderrBuf.trim()}`));
            else finish(undefined, String(msg.result ?? ''));
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
