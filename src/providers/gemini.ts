import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import type { ModelCallStats, ModelProvider, ModelRequest } from '../types';

const execFileAsync = promisify(execFile);

/**
 * Gemini CLI provider (headless `-p` mode) — clean cloud fallback when Claude hits its limit,
 * or primary for users who prefer Gemini.
 */
export class GeminiCliProvider implements ModelProvider {
  readonly name: string;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly cwd: string;
  private readonly bin: string;

  constructor(opts: { name?: string; model?: string; timeoutMs?: number; cwd?: string; bin?: string } = {}) {
    if (opts.model) this.model = opts.model;
    this.name = opts.name ?? (opts.model ? `gemini-cli:${opts.model}` : 'gemini-cli');
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.cwd = opts.cwd ?? os.tmpdir();
    this.bin = opts.bin ?? (existsSync('/opt/homebrew/bin/gemini') ? '/opt/homebrew/bin/gemini' : 'gemini');
  }

  async complete(req: ModelRequest): Promise<string> {
    const { text } = await this.completeWithStats(req);
    return text;
  }

  async completeWithStats(req: ModelRequest): Promise<{ text: string; stats: ModelCallStats }> {
    const model = req.model ?? this.model;
    const started = Date.now();
    const combined = req.system?.trim() ? `${req.system.trim()}\n\n---\n\n${req.prompt.trim()}` : req.prompt.trim();
    const args = ['-p', combined, '-o', 'text', ...(model ? ['-m', model] : [])];
    try {
      const { stdout } = await execFileAsync(this.bin, args, {
        cwd: this.cwd,
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' },
      });
      const text = stdout.trim();
      return {
        text,
        stats: { model: model ?? 'gemini-default', durationMs: Date.now() - started, ok: true },
      };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const detail = (e.stderr?.trim() || e.stdout?.trim() || e.message || String(err)).slice(0, 400);
      const error = new Error(`gemini CLI error: ${detail}`);
      throw Object.assign(error, {
        stats: { model: model ?? 'gemini-default', durationMs: Date.now() - started, ok: false, error: detail } satisfies ModelCallStats,
      });
    }
  }
}
