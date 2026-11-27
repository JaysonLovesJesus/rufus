import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cosineSimilarity, createLocalEmbedder, normalize, type Embedder, type Vector } from '../embed';
import type { BouncerDecision, BouncerExample, BouncerLabel, LosslessEvent } from '../types';
import type { GapLook } from './gap-lens';
import { loadReplyPairs, replyPairExamples } from './reply-pairs';
import type { Triage } from './triage';
import {
  featureText,
  isFeatureText,
  relabelFromWakes,
  resolveExamples,
  scoreLabels,
  shouldPromote,
  splitHeldOut,
  type HeldOutMetrics,
  type TrainingMetrics,
} from './training';

const execFileAsync = promisify(execFile);

/** Below this confidence the classifier is unsure, and a cheap model makes the first call instead of waking Opus. */
export const SURE_CONFIDENCE = 0.9;
/** WAKE from this probability up (high recall: a missed event costs far more than a wasted wake). Matches setfit_sidecar.py. */
export const WAKE_THRESHOLD = 0.3;
const SIDECAR_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'setfit_sidecar.py');

/** Trains and runs SetFit models; the default shells out to the Python sidecar, tests pass a fake. */
export interface SetFitRunner {
  train(dataPath: string, modelDir: string, epochs: number): Promise<{ ok: boolean; seconds?: number; error?: string }>;
  predict(modelDir: string, texts: readonly string[]): Promise<BouncerLabel[]>;
}

function pythonRunner(pythonPath: string): SetFitRunner {
  return {
    async train(dataPath, modelDir, epochs) {
      const { stdout } = await execFileAsync(pythonPath, [SIDECAR_SCRIPT, 'train', '--data', dataPath, '--model-dir', modelDir, '--epochs', String(epochs)], {
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return JSON.parse(stdout.trim().split('\n').pop()!) as { ok: boolean; seconds?: number; error?: string };
    },
    async predict(modelDir, texts) {
      const tmp = path.join(os.tmpdir(), `rufus-bouncer-eval-${process.pid}-${Date.now()}.jsonl`);
      await fs.writeFile(tmp, texts.map((text) => JSON.stringify({ text })).join('\n'), 'utf8');
      try {
        const { stdout } = await execFileAsync(pythonPath, [SIDECAR_SCRIPT, 'predict', '--model-dir', modelDir, '--data', tmp], {
          timeout: 180_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout.trim().split('\n').pop()!) as { labels?: BouncerLabel[] };
        if (!Array.isArray(parsed.labels) || parsed.labels.length !== texts.length) throw new Error('predict returned the wrong number of labels');
        return parsed.labels;
      } finally {
        await fs.rm(tmp, { force: true });
      }
    },
  };
}

async function hasModel(dir: string): Promise<boolean> {
  return fs.stat(path.join(dir, 'config.json')).then((s) => s.isFile()).catch(() => false);
}

/**
 * The $0 Bouncer: decides SLEEP vs WAKE for every incoming event.
 * - Direct user messages always WAKE immediately (deterministic rule).
 * - If a trained local SetFit model exists (+ Python venv), uses persistent ~10ms SetFit sidecar.
 * - Otherwise uses a fast $0 local prototype classifier over `bouncer.jsonl` examples.
 */
export class Bouncer {
  readonly workspaceDir: string;
  readonly dataPath: string;
  readonly modelDir: string;
  /** A retrain lands here first, and replaces modelDir only if it is no worse on the held-out set. */
  readonly candidateDir: string;
  /** The model a promotion replaced, kept for rollback. */
  readonly previousDir: string;
  readonly metricsPath: string;
  private readonly pythonPath?: string;
  private readonly runner?: SetFitRunner;
  private readonly embedder: Embedder;
  private examples: Array<{ ex: BouncerExample; vec: Vector }> = [];
  private loaded = false;
  private sidecar?: {
    proc: ChildProcessWithoutNullStreams;
    pending: Array<(line: string) => void>;
  };

  constructor(opts: { workspaceDir: string; pythonPath?: string; embedder?: Embedder; runner?: SetFitRunner }) {
    this.workspaceDir = opts.workspaceDir;
    const training = path.join(opts.workspaceDir, 'training');
    this.dataPath = path.join(training, 'bouncer.jsonl');
    this.modelDir = path.join(training, 'setfit-model');
    this.candidateDir = path.join(training, 'setfit-candidate');
    this.previousDir = path.join(training, 'setfit-model.prev');
    this.metricsPath = path.join(training, 'bouncer-metrics.json');
    if (opts.pythonPath) this.pythonPath = opts.pythonPath;
    const runner = opts.runner ?? (opts.pythonPath ? pythonRunner(opts.pythonPath) : undefined);
    if (runner) this.runner = runner;
    this.embedder = opts.embedder ?? createLocalEmbedder();
  }

  static eventToFeatureText(e: LosslessEvent): string {
    return featureText(e);
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
          if (!ex.text || !isFeatureText(ex.text) || (ex.label !== 'SLEEP' && ex.label !== 'WAKE')) continue;
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
    if (isFeatureText(example.text)) this.examples.push({ ex: example, vec: await this.embedder.embed(example.text) });
    await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
    await fs.appendFile(this.dataPath, `${JSON.stringify(example)}\n`, 'utf8');
  }

  async exampleCount(): Promise<{ total: number; sleep: number; wake: number }> {
    await this.load();
    const sleep = this.examples.filter((x) => x.ex.label === 'SLEEP').length;
    const wake = this.examples.filter((x) => x.ex.label === 'WAKE').length;
    return { total: this.examples.length, sleep, wake };
  }

  private async rawExamples(): Promise<BouncerExample[]> {
    const raw = await fs.readFile(this.dataPath, 'utf8').catch(() => '');
    const out: BouncerExample[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ex = JSON.parse(line) as BouncerExample;
        if (ex.label === 'SLEEP' || ex.label === 'WAKE') out.push(ex);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  /**
   * The cleaned, relabelled label set split into train and held-out (see training.ts).
   * The owner's past reply pairs join as a weak, capped prior: they always train, are never held out, and any real label
   * for the same text replaces them.
   */
  async preparedSet(): Promise<{ train: BouncerExample[]; heldOut: BouncerExample[]; stats: TrainingMetrics['resolve'] }> {
    const raw = await this.rawExamples();
    const real = raw.filter((x) => x.source !== 'seed').length;
    const pairs = replyPairExamples(await loadReplyPairs(this.workspaceDir), real);
    const { examples, stats } = resolveExamples([...pairs, ...raw], await relabelFromWakes(this.workspaceDir));
    return { ...splitHeldOut(examples), stats };
  }

  /** WAKE precision/recall of a model directory on the held-out set. */
  async evaluate(modelDir: string, heldOut: readonly BouncerExample[]): Promise<HeldOutMetrics> {
    if (!this.runner) throw new Error('No SetFit runner configured.');
    const predicted = heldOut.length ? await this.runner.predict(modelDir, heldOut.map((x) => x.text)) : [];
    return scoreLabels(heldOut.map((x) => x.label), predicted);
  }

  static async readMetrics(workspaceDir: string): Promise<TrainingMetrics | undefined> {
    try {
      return JSON.parse(await fs.readFile(path.join(workspaceDir, 'training', 'bouncer-metrics.json'), 'utf8')) as TrainingMetrics;
    } catch {
      return undefined;
    }
  }

  /**
   * Retrains SetFit on the cleaned labels, minus a held-out set. The new model is promoted only if its held-out WAKE recall is
   * not lower than the current model's; the replaced model is kept in `setfit-model.prev`. Metrics land in `bouncer-metrics.json`.
   */
  async trainSetFit(opts: { epochs?: number; now?: Date } = {}): Promise<{
    ok: boolean;
    examples?: number;
    seconds?: number;
    promoted?: boolean;
    reason?: string;
    candidate?: HeldOutMetrics;
    current?: HeldOutMetrics;
    error?: string;
  }> {
    if (!this.runner) return { ok: false, error: 'No pythonPath configured for SetFit.' };
    try {
      const { train, heldOut, stats } = await this.preparedSet();
      const trainPath = path.join(path.dirname(this.dataPath), 'bouncer.train.jsonl');
      await fs.mkdir(path.dirname(trainPath), { recursive: true });
      await fs.writeFile(trainPath, train.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
      await fs.writeFile(path.join(path.dirname(this.dataPath), 'bouncer.heldout.jsonl'), heldOut.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
      await fs.rm(this.candidateDir, { recursive: true, force: true });
      const trained = await this.runner.train(trainPath, this.candidateDir, opts.epochs ?? 1);
      if (!trained.ok) return { ok: false, ...(trained.error ? { error: trained.error } : {}) };

      const candidate = await this.evaluate(this.candidateDir, heldOut);
      const current = (await hasModel(this.modelDir)) ? await this.evaluate(this.modelDir, heldOut) : undefined;
      const decision = shouldPromote(candidate, current);
      if (decision.promote) {
        await fs.rm(this.previousDir, { recursive: true, force: true });
        if (await hasModel(this.modelDir)) await fs.rename(this.modelDir, this.previousDir);
        else await fs.rm(this.modelDir, { recursive: true, force: true });
        await fs.rename(this.candidateDir, this.modelDir);
        await this.close(); // the next decide() loads the promoted model
      } else {
        await fs.rm(this.candidateDir, { recursive: true, force: true });
      }
      const metrics: TrainingMetrics = {
        at: (opts.now ?? new Date()).toISOString(),
        promoted: decision.promote,
        reason: decision.reason,
        trainExamples: train.length,
        heldOut: { n: candidate.n, wake: candidate.wake },
        candidate,
        ...(current ? { current } : {}),
        resolve: stats,
      };
      await fs.writeFile(this.metricsPath, JSON.stringify(metrics, null, 2), 'utf8');
      return {
        ok: true,
        examples: train.length,
        ...(trained.seconds !== undefined ? { seconds: trained.seconds } : {}),
        promoted: decision.promote,
        reason: decision.reason,
        candidate,
        ...(current ? { current } : {}),
      };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, error: e.stderr?.trim() || e.stdout?.trim() || e.message || String(err) };
    }
  }

  private sidecarStarting?: Promise<boolean>;

  private async ensureSidecar(): Promise<boolean> {
    if (this.sidecar) return true;
    // Senses and wakes call decide() concurrently: start one sidecar, not two.
    this.sidecarStarting ??= this.startSidecar().finally(() => {
      this.sidecarStarting = undefined;
    });
    return this.sidecarStarting;
  }

  private async startSidecar(): Promise<boolean> {
    if (!this.pythonPath) return false;
    if (!(await hasModel(this.modelDir))) return false;

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
    // Ambient app-switching context is logged to Memory, never wakes Rufus up.
    if (event.source === 'screen' && event.kind === 'focus') {
      return { label: 'SLEEP', confidence: 1, backend: 'rule', reason: 'ambient screen focus (memory only)', durationMs: Date.now() - t0 };
    }

    const text = Bouncer.eventToFeatureText(event);

    // 1. Prefer trained local SetFit model if available
    if (await this.ensureSidecar().catch(() => false)) {
      const replyLine = await new Promise<string>((resolve) => {
        this.sidecar!.pending.push(resolve);
        this.sidecar!.proc.stdin.write(`${JSON.stringify({ text })}\n`);
      });
      const res = JSON.parse(replyLine) as { label: BouncerLabel; confidence: number; wakeP?: number; durationMs?: number };
      const wakeScore = typeof res.wakeP === 'number' ? res.wakeP : res.label === 'WAKE' ? res.confidence : 1 - res.confidence;
      return {
        label: res.label,
        confidence: res.confidence,
        backend: 'setfit',
        wakeScore,
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
      wakeScore: Number(Math.min(1, Math.max(0, 0.5 + margin)).toFixed(4)),
      durationMs: Date.now() - t0,
    };
  }

  /**
   * The Bouncer with the gap tree in view. The local classifier decides alone when it is sure and the event touches no gap.
   * Otherwise a cheap model makes the first call: unsure classifier, or the classifier would sleep on an event close to
   * (or tied by person or thread to) an open gap. Opus wakes only when the cheap model says WAKE or cannot tell.
   * With no cheap model (or when it fails), an event tied to or very near a gap wakes: recall beats cost.
   */
  async judge(event: LosslessEvent, ctx: { look?: GapLook; triage?: Triage } = {}): Promise<BouncerDecision> {
    const base = await this.decide(event);
    if (base.backend === 'rule') return base;
    const t0 = Date.now() - base.durationMs;
    const look = ctx.look ?? { features: [], hints: [] };
    const tied = look.hints.filter((h) => h.tie);
    const nearHigh = look.features.includes('gap_near:high');
    const near = nearHigh || look.features.includes('gap_near:mid');
    const gapIds = (tied.length ? tied : near ? look.hints : []).map((h) => h.id);
    const withGaps = { ...base, ...(gapIds.length ? { gapIds } : {}) };
    const touchesGap = tied.length > 0 || near;
    const unsure = base.confidence < SURE_CONFIDENCE;
    if (!unsure && !(touchesGap && base.label === 'SLEEP')) return withGaps;
    const fallback = (why: string): BouncerDecision =>
      base.label === 'SLEEP' && (tied.length > 0 || nearHigh)
        ? { ...withGaps, label: 'WAKE', reason: `${tied.length ? `tied to ${tied[0]!.id} by ${tied[0]!.tie}` : `close to ${gapIds[0]}`}${why}`, durationMs: Date.now() - t0 }
        : withGaps;
    if (!ctx.triage) return fallback('');
    try {
      const v = await ctx.triage.decide(event, { hints: look.hints, ...(base.wakeScore !== undefined ? { wakeScore: base.wakeScore } : {}) });
      const ids = v.gapId ? [v.gapId, ...gapIds.filter((g) => g !== v.gapId)] : gapIds;
      return {
        ...base,
        label: v.sure ? v.label : 'WAKE',
        confidence: v.sure ? 0.8 : 0.5,
        backend: 'triage',
        reason: v.sure ? v.reason || 'cheap model' : `cheap model unsure (${v.reason || 'no reason'}): Opus decides`,
        ...(ids.length ? { gapIds: ids } : {}),
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      return fallback(` (cheap model failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
