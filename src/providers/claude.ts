import { execFile } from 'node:child_process';
import type { ModelProvider, ModelRequest } from '../types';

/** Runs Claude CLI (`claude -p --tools ""`) cleanly with no CLI tool-hijack. */
export class ClaudeCliProvider implements ModelProvider {
  readonly name: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;

  constructor(opts: { name?: string; model?: string; timeoutMs?: number } = {}) {
    this.defaultModel = opts.model ?? 'claude-opus-4-5';
    this.name = opts.name ?? `claude-cli:${this.defaultModel}`;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  async complete(req: ModelRequest): Promise<string> {
    const model = req.model ?? this.defaultModel;
    const combined = `${req.system.trim()}\n\n---\n\n${req.prompt.trim()}`;
    return this.runWithStdin(['-p', '--tools', '', '--model', model], combined);
  }

  private runWithStdin(args: string[], stdinText: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('claude', args, { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`claude CLI failed: ${stderr?.trim() || err.message}`));
        else resolve(stdout.trim());
      });
      child.stdin?.end(stdinText);
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
