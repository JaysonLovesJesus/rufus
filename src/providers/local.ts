import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ModelCallStats, ModelProvider, ModelRequest } from '../types';

const execFileAsync = promisify(execFile);

/** Finds an already-downloaded local GGUF LLM (skips speech/VAD models like parakeet/silero/whisper). */
export function findLocalLlmModel(workspaceDir?: string, home = os.homedir()): string | undefined {
  const env = process.env.RUFUS_LOCAL_MODEL;
  if (env && existsSync(env)) return env;
  const dirs = [
    ...(workspaceDir ? [path.join(workspaceDir, 'models')] : []),
    path.join(home, '.rufus-v2', 'models'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const match = readdirSync(dir)
      .filter((f) => /\.gguf$/i.test(f) && !/^(?:parakeet|silero|whisper)/i.test(f))
      .sort()[0];
    if (match) return path.join(dir, match);
  }
  return undefined;
}

/**
 * Local llama.cpp (`llama-cli`) provider running on Apple Metal / CPU at $0, completely offline.
 * Designed for low-intelligence tasks (Triage, Speaker, simple fallback wakes) on 8 GB+ machines.
 */
export class LocalLlamaProvider implements ModelProvider {
  readonly name: string;
  readonly modelPath: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly ctxSize: number;

  constructor(opts: { modelPath: string; name?: string; bin?: string; timeoutMs?: number; maxTokens?: number; ctxSize?: number }) {
    this.modelPath = opts.modelPath;
    this.name = opts.name ?? `local:${path.basename(opts.modelPath, '.gguf')}`;
    this.bin =
      opts.bin ??
      (existsSync('/opt/homebrew/bin/llama-completion')
        ? '/opt/homebrew/bin/llama-completion'
        : existsSync('/opt/homebrew/bin/llama-cli')
          ? '/opt/homebrew/bin/llama-cli'
          : 'llama-completion');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxTokens = opts.maxTokens ?? 512;
    this.ctxSize = opts.ctxSize ?? 8192;
  }

  async complete(req: ModelRequest): Promise<string> {
    const { text } = await this.completeWithStats(req);
    return text;
  }

  async completeWithStats(req: ModelRequest): Promise<{ text: string; stats: ModelCallStats }> {
    const started = Date.now();
    const isGemma = /gemma/i.test(path.basename(this.modelPath));
    const sys = req.system?.trim() ?? '';
    const usr = req.prompt.trim();
    const formattedPrompt = isGemma
      ? `<start_of_turn>user\n${sys ? `${sys}\n\n` : ''}${usr}<end_of_turn>\n<start_of_turn>model\n`
      : sys
        ? `<|im_start|>system\n${sys}<|im_end|>\n<|im_start|>user\n${usr}<|im_end|>\n<|im_start|>assistant\n`
        : `<|im_start|>user\n${usr}<|im_end|>\n<|im_start|>assistant\n`;
    const args = [
      '-m',
      this.modelPath,
      '-ngl',
      '99',
      '-c',
      String(this.ctxSize),
      '-n',
      String(this.maxTokens),
      '--no-display-prompt',
      '-no-cnv',
      '--temp',
      '0.2',
      '-p',
      formattedPrompt,
    ];
    try {
      const { stdout } = await execFileAsync(this.bin, args, {
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      // Strip any trailing [end of text] / <end_of_turn> / llama.cpp interactive prompt markers.
      const text = stdout
        .replace(/<end_of_turn>\s*$/i, '')
        .replace(/\[end of text\]\s*$/i, '')
        .replace(/\n>\s*$/, '')
        .trim();
      return {
        text,
        stats: { model: this.name, durationMs: Date.now() - started, costUsd: 0, ok: true },
      };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const detail = (e.stderr?.trim() || e.stdout?.trim() || e.message || String(err)).slice(0, 400);
      const error = new Error(`llama-cli error: ${detail}`);
      throw Object.assign(error, {
        stats: { model: this.name, durationMs: Date.now() - started, costUsd: 0, ok: false, error: detail } satisfies ModelCallStats,
      });
    }
  }
}
