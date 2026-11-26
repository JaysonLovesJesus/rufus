import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface SynthesizeResult {
  ok: boolean;
  clipId?: string;
  outPath?: string;
  voice?: string;
  audioSeconds?: number;
  durationMs?: number;
  error?: string;
}

/**
 * Persistent local Kokoro-82M neural TTS client (default voice: bm_daniel).
 * Keeps the ONNX model warm in RAM so every spoken sentence synthesizes rapidly.
 */
export class KokoroTts {
  readonly pythonPath: string;
  readonly ttsDir: string;
  readonly clipsDir: string;
  readonly voice: string;
  readonly lang: string;
  private proc?: ChildProcessWithoutNullStreams;
  private readyPromise?: Promise<boolean>;
  private waiters: Array<(line: string) => void> = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: { workspaceDir: string; pythonPath?: string; voice?: string; lang?: string }) {
    this.ttsDir = path.join(opts.workspaceDir, 'tts');
    this.clipsDir = path.join(os.tmpdir(), 'rufus-voice-clips');
    this.pythonPath = opts.pythonPath || process.env.RUFUS_KOKORO_PYTHON || path.join(opts.workspaceDir, 'kokoro-venv', 'bin', 'python');
    this.voice = opts.voice || process.env.RUFUS_VOICE || 'bm_daniel';
    this.lang = opts.lang || process.env.RUFUS_VOICE_LANG || (this.voice.startsWith('b') ? 'en-gb' : 'en-us');
  }

  get available(): boolean {
    const sidecar = path.resolve(HERE, 'kokoro_sidecar.py');
    return existsSync(this.pythonPath) && existsSync(path.join(this.ttsDir, 'kokoro-v1.0.int8.onnx')) && existsSync(sidecar);
  }

  private async ensureReady(): Promise<boolean> {
    if (!this.available) return false;
    if (this.readyPromise) return this.readyPromise;
    const sidecar = path.resolve(HERE, 'kokoro_sidecar.py');
    this.readyPromise = new Promise<boolean>((resolve) => {
      try {
        const child = spawn(this.pythonPath, [sidecar], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            RUFUS_TTS_DIR: this.ttsDir,
            RUFUS_VOICE: this.voice,
            RUFUS_VOICE_LANG: this.lang,
          },
        });
        this.proc = child;
        const rl = readline.createInterface({ input: child.stdout });
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill();
            resolve(false);
          }
        }, 30_000);
        rl.on('line', (line) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try {
              const msg = JSON.parse(line) as { ready?: boolean };
              return resolve(msg.ready === true);
            } catch {
              return resolve(false);
            }
          }
          const w = this.waiters.shift();
          if (w) w(line);
        });
        child.on('exit', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(false);
          }
          this.proc = undefined;
          this.readyPromise = undefined;
          while (this.waiters.length) this.waiters.shift()?.('{"ok":false,"error":"kokoro sidecar exited"}');
        });
        child.on('error', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(false);
          }
        });
      } catch {
        resolve(false);
      }
    });
    return this.readyPromise;
  }

  async synthesize(text: string, opts: { voice?: string; speed?: number } = {}): Promise<SynthesizeResult> {
    const clean = text.trim();
    if (!clean) return { ok: false, error: 'empty text' };
    const ready = await this.ensureReady();
    if (!ready || !this.proc) return { ok: false, error: 'Kokoro TTS sidecar unavailable' };
    await fs.mkdir(this.clipsDir, { recursive: true });
    const clipId = randomUUID().slice(0, 12);
    const outPath = path.join(this.clipsDir, `${clipId}.wav`);

    const run = async (): Promise<SynthesizeResult> => {
      if (!this.proc) return { ok: false, error: 'Kokoro sidecar not running' };
      const response = new Promise<string>((resolve) => this.waiters.push(resolve));
      this.proc.stdin.write(
        `${JSON.stringify({ text: clean, voice: opts.voice || this.voice, speed: opts.speed ?? 1.0, outPath })}\n`,
      );
      const line = await response;
      try {
        const parsed = JSON.parse(line) as SynthesizeResult;
        return parsed.ok ? { ...parsed, clipId } : parsed;
      } catch {
        return { ok: false, error: 'unparseable sidecar response' };
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  clipPath(clipId: string): string {
    const safe = clipId.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.clipsDir, `${safe}.wav`);
  }

  close(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = undefined;
      this.readyPromise = undefined;
    }
  }
}
