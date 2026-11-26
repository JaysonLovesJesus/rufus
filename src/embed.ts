import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Local vector embeddings:
 * - Semantic neural embedder via persistent Python sidecar (paraphrase-MiniLM-L3-v2, ~60MB, ~5ms/query)
 * - Fast zero-dependency fallback (hashEmbed) when Python/sentence-transformers isn't installed or in unit tests.
 */

export type Vector = number[];

export interface Embedder {
  readonly modelId?: string;
  embed(text: string): Promise<Vector> | Vector;
  embedBatch?(texts: string[]): Promise<Vector[]> | Vector[];
  close?(): Promise<void> | void;
}

const DEFAULT_DIM = 256;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic local embedding: fast (<0.5ms), $0, captures both words and subword stems. */
export function hashEmbed(text: string, dim = DEFAULT_DIM): Vector {
  const vec = new Array<number>(dim).fill(0);
  const clean = text.toLowerCase().replace(/[^a-z0-9\s_.-]/g, ' ').trim();
  if (!clean) return vec;
  const tokens = clean.split(/\s+/).filter((t) => t.length > 1);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const h1 = fnv1a(`w:${tok}`);
    vec[h1 % dim] += h1 & 1 ? 1.5 : -1.5;
    if (i + 1 < tokens.length) {
      const bi = fnv1a(`b:${tok}_${tokens[i + 1]}`);
      vec[bi % dim] += bi & 1 ? 1.0 : -1.0;
    }
    if (tok.length >= 4) {
      for (let j = 0; j <= tok.length - 3; j++) {
        const tri = fnv1a(`c:${tok.slice(j, j + 3)}`);
        vec[tri % dim] += tri & 1 ? 0.35 : -0.35;
      }
    }
  }
  return normalize(vec);
}

export function normalize(vec: Vector): Vector {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm) return vec;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a: Vector, b: Vector): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function createLocalEmbedder(dim = DEFAULT_DIM): Embedder {
  return {
    modelId: `hash-${dim}`,
    embed: (text) => hashEmbed(text, dim),
    embedBatch: (texts) => texts.map((t) => hashEmbed(t, dim)),
  };
}

/**
 * Neural semantic embedder backed by the persistent local Python sidecar (paraphrase-MiniLM-L3-v2).
 * Automatically falls back to hashEmbed if Python or sentence-transformers is unavailable.
 */
export function createSemanticEmbedder(opts: { pythonPath?: string; modelName?: string; fallbackDim?: number } = {}): Embedder {
  const modelName = opts.modelName ?? process.env.RUFUS_EMBED_MODEL ?? 'sentence-transformers/paraphrase-MiniLM-L3-v2';
  const fallback = createLocalEmbedder(opts.fallbackDim ?? DEFAULT_DIM);
  const pythonPath = opts.pythonPath;
  const sidecarPath = path.resolve(__dirname, 'events', 'embed_sidecar.py');

  let proc: ChildProcessWithoutNullStreams | undefined;
  let readyPromise: Promise<boolean> | undefined;
  let disabled = !pythonPath || !existsSync(pythonPath) || !existsSync(sidecarPath);
  const waiters: Array<(line: string) => void> = [];
  let queue: Promise<unknown> = Promise.resolve();

  async function ensureReady(): Promise<boolean> {
    if (disabled) return false;
    if (readyPromise) return readyPromise;
    readyPromise = new Promise<boolean>((resolve) => {
      try {
        const child = spawn(pythonPath!, [sidecarPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, RUFUS_EMBED_MODEL: modelName },
        });
        proc = child;
        const rl = readline.createInterface({ input: child.stdout });
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            disabled = true;
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
              if (msg.ready) return resolve(true);
            } catch {
              /* fall through */
            }
            disabled = true;
            return resolve(false);
          }
          const w = waiters.shift();
          if (w) w(line);
        });
        child.on('exit', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(false);
          }
          proc = undefined;
          readyPromise = undefined;
          while (waiters.length) waiters.shift()?.('{"error":"sidecar exited"}');
        });
        child.on('error', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            disabled = true;
            resolve(false);
          }
        });
      } catch {
        disabled = true;
        resolve(false);
      }
    });
    return readyPromise;
  }

  async function requestBatch(texts: string[]): Promise<Vector[] | undefined> {
    if (!texts.length) return [];
    const ok = await ensureReady();
    if (!ok || !proc) return undefined;
    const run = async (): Promise<Vector[] | undefined> => {
      if (!proc) return undefined;
      const response = new Promise<string>((resolve) => waiters.push(resolve));
      proc.stdin.write(`${JSON.stringify({ texts })}\n`);
      const line = await response;
      try {
        const parsed = JSON.parse(line) as { vectors?: Vector[]; error?: string };
        if (Array.isArray(parsed.vectors) && parsed.vectors.length === texts.length) return parsed.vectors;
      } catch {
        /* fall through */
      }
      return undefined;
    };
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    modelId: disabled ? fallback.modelId! : modelName,
    async embed(text: string): Promise<Vector> {
      const vecs = await requestBatch([text]);
      if (vecs?.[0]) return vecs[0];
      return fallback.embed(text);
    },
    async embedBatch(texts: string[]): Promise<Vector[]> {
      const vecs = await requestBatch(texts);
      if (vecs) return vecs;
      return Promise.all(texts.map((t) => fallback.embed(t)));
    },
    close(): void {
      if (proc) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        proc = undefined;
        readyPromise = undefined;
      }
    },
  };
}

export function topKBySimilarity<T>(
  queryVec: Vector,
  items: readonly Array<{ item: T; vector: Vector }>[0][],
  k: number,
): Array<{ item: T; score: number }> {
  return items
    .map((entry) => ({ item: entry.item, score: cosineSimilarity(queryVec, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, k));
}
