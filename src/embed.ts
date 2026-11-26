/**
 * Fast, zero-dependency local vector embeddings (signed feature hashing over words + char 3-grams)
 * with pluggable external/sentence-transformer embedder support.
 */

export type Vector = number[];

export interface Embedder {
  embed(text: string): Promise<Vector> | Vector;
  embedBatch?(texts: string[]): Promise<Vector[]> | Vector[];
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
    embed: (text) => hashEmbed(text, dim),
    embedBatch: (texts) => texts.map((t) => hashEmbed(t, dim)),
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
