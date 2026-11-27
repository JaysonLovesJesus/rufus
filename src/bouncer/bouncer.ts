import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cosineSimilarity, createLocalEmbedder, normalize, type Embedder, type Vector } from '../embed';
import type { BouncerDecision, BouncerExample, BouncerLabel, LosslessEvent } from '../types';

const execFileAsync = promisify(execFile);
const SIDECAR_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'setfit_sidecar.py');

/**
 * The $0 Bouncer: decides SLEEP vs WAKE for every incoming event.
 * - Direct user messages always WAKE immediately (deterministic rule).
 * - If a trained local SetFit model exists (+ Python venv), uses persistent ~10ms SetFit sidecar.
 * - Otherwise uses a fast $0 local prototype classifier over `bouncer.jsonl` examples.
 */
export class Bouncer {
  readonly dataPath: string;
  readonly modelDir: string;
  private readonly pythonPath?: string;
  private readonly embedder: Embedder;
  private examples: Array<{ ex: BouncerExample; vec: Vector }> = [];
  private loaded = false;
  private sidecar?: {
    proc: ChildProcessWithoutNullStreams;
    pending: Array<(line: string) => void>;
  };

  constructor(opts: { workspaceDir: string; pythonPath?: string; embedder?: Embedder }) {
    this.dataPath = path.join(opts.workspaceDir, 'training', 'bouncer.jsonl');
    this.modelDir = path.join(opts.workspaceDir, 'training', 'setfit-model');
    if (opts.pythonPath) this.pythonPath = opts.pythonPath;
    this.embedder = opts.embedder ?? createLocalEmbedder();
  }

  static eventToFeatureText(e: LosslessEvent): string {
    return [
      `source:${e.source}`,
      `kind:${e.kind}`,
      e.actor ? `actor:${e.actor}` : '',
      e.channel ? `channel:${e.channel}` : '',
      e.deleted ? 'deleted:true' : '',
      e.text,
    ]
      .filter(Boolean)
      .join(' | ');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.dataPath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ex = JSON.parse(line) as BouncerExample;
          if (!ex.text || (ex.label !== 'SLEEP' && ex.label !== 'WAKE')) continue;
          const vec = await this.embedder.embed(ex.text);
          this.examples.push({ ex, vec });
        } catch {
          /* skip corrupt line */
        }
      }
    } catch {
      /* no training data yet */
    }
  }

  /** Appends a labeled training example (from pushback, skip, approval, or Opus sleep/acted). */
  async recordExample(example: BouncerExample): Promise<void> {
    await this.load();
    const vec = await this.embedder.embed(example.text);
    this.examples.push({ ex: example, vec });
    await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
    await fs.appendFile(this.dataPath, `${JSON.stringify(example)}\n`, 'utf8');
  }

  async exampleCount(): Promise<{ total: number; sleep: number; wake: number }> {
    await this.load();
    const sleep = this.examples.filter((x) => x.ex.label === 'SLEEP').length;
    const wake = this.examples.filter((x) => x.ex.label === 'WAKE').length;
    return { total: this.examples.length, sleep, wake };
  }

  /** Trains the real local SetFit model via Python sidecar on `training/bouncer.jsonl`. */
  async trainSetFit(opts: { epochs?: number } = {}): Promise<{ ok: boolean; examples?: number; seconds?: number; error?: string }> {
    if (!this.pythonPath) return { ok: false, error: 'No pythonPath configured for SetFit.' };
    try {
      const { stdout } = await execFileAsync(
        this.pythonPath,
        [SIDECAR_SCRIPT, 'train', '--data', this.dataPath, '--model-dir', this.modelDir, '--epochs', String(opts.epochs ?? 1)],
        { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
      );
      await this.close(); // reload newly trained model on next predict
      return JSON.parse(stdout.trim().split('\n').pop()!) as { ok: boolean; examples?: number; seconds?: number; error?: string };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, error: e.stderr?.trim() || e.stdout?.trim() || e.message || String(err) };
    }
  }

  private async ensureSidecar(): Promise<boolean> {
    if (this.sidecar) return true;
    if (!this.pythonPath) return false;
    const hasModel = await fs.stat(path.join(this.modelDir, 'config.json')).then((s) => s.isFile()).catch(() => false);
    if (!hasModel) return false;

    const proc = spawn(this.pythonPath, [SIDECAR_SCRIPT, 'serve', '--model-dir', this.modelDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    const pending: Array<(line: string) => void> = [];
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const next = pending.shift();
      if (next) next(line);
    });
    proc.on('exit', () => {
      this.sidecar = undefined;
    });

    const readyLine = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SetFit sidecar startup timed out')), 30_000);
      pending.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
    const parsed = JSON.parse(readyLine) as { ready?: boolean };
    if (!parsed.ready) {
      proc.kill();
      return false;
    }
    this.sidecar = { proc, pending };
    return true;
  }

  async close(): Promise<void> {
    if (this.sidecar) {
      this.sidecar.proc.kill();
      this.sidecar = undefined;
    }
  }

  /** Classifies an incoming event as SLEEP or WAKE in milliseconds at $0. */
  async decide(event: LosslessEvent): Promise<BouncerDecision> {
    const t0 = Date.now();
    // Direct messages from the owner to Rufus always wake immediately.
    if (event.source === 'message' && event.kind === 'owner_direct') {
      return { label: 'WAKE', confidence: 1, backend: 'rule', reason: 'direct owner message', durationMs: Date.now() - t0 };
    }
    if (event.source === 'system' && event.kind === 'startup') {
      return { label: 'WAKE', confidence: 1, backend: 'rule', reason: 'startup orientation', durationMs: Date.now() - t0 };
    }
    if (event.source === 'watch') {
      return { label: 'WAKE', confidence: 1, backend: 'rule', reason: 'self-set watch/alarm fired', durationMs: Date.now() - t0 };
    }
    if (event.source === 'gap') {
      return { label: 'WAKE', confidence: 1, backend: 'rule', reason: `gap board trigger (${event.kind})`, durationMs: Date.now() - t0 };
    }

    const text = Bouncer.eventToFeatureText(event);

    // 1. Prefer trained local SetFit model if available
    if (await this.ensureSidecar().catch(() => false)) {
      const replyLine = await new Promise<string>((resolve) => {
        this.sidecar!.pending.push(resolve);
        this.sidecar!.proc.stdin.write(`${JSON.stringify({ text })}\n`);
      });
      const res = JSON.parse(replyLine) as { label: BouncerLabel; confidence: number; durationMs?: number };
      return {
        label: res.label,
        confidence: res.confidence,
        backend: 'setfit',
        durationMs: res.durationMs ?? Date.now() - t0,
      };
    }

    // 2. Built-in $0 local prototype classifier over bouncer.jsonl
    await this.load();
    const sleepVecs = this.examples.filter((x) => x.ex.label === 'SLEEP').map((x) => x.vec);
    const wakeVecs = this.examples.filter((x) => x.ex.label === 'WAKE').map((x) => x.vec);
    if (!sleepVecs.length || !wakeVecs.length) {
      return { label: 'WAKE', confidence: 0.5, backend: 'prototype', reason: 'untrained bouncer defaults to WAKE', durationMs: Date.now() - t0 };
    }

    const q = await this.embedder.embed(text);
    const avg = (vecs: Vector[]): Vector => {
      const dim = vecs[0]!.length;
      const out = new Array<number>(dim).fill(0);
      for (const v of vecs) for (let i = 0; i < dim; i++) out[i] += v[i]!;
      return normalize(out);
    };

    const simSleep = cosineSimilarity(q, avg(sleepVecs));
    const simWake = cosineSimilarity(q, avg(wakeVecs));
    const margin = simWake - simSleep;
    const label: BouncerLabel = margin >= 0 ? 'WAKE' : 'SLEEP';
    const confidence = Math.min(0.99, Math.max(0.5, 0.5 + Math.abs(margin)));
    return {
      label,
      confidence: Number(confidence.toFixed(4)),
      backend: 'prototype',
      durationMs: Date.now() - t0,
    };
  }
}
