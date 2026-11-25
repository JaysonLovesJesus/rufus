import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Engine } from '../engine/engine';
import type { FileStore } from '../store';
import type { ReplayCase } from '../learning/cases';
import { addNoise, emptyNoise, pairNoiseKind, type NoiseCounts } from './noise';
import { normalizePair, type HistoryPair, type InvalidRecord, type PriorMessage } from './types';

/** Epoch, for pairs with no timestamps: history sorts before anything a live run saves. */
const UNDATED = '1970-01-01T00:00:00.000Z';

/** The `input` a seeded replay case hands your flow: the incoming message, as `ctx.input`. */
export interface HistoryInput {
  channel: string;
  threadId?: string;
  sender: string;
  incoming: string;
  incomingAt?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Situation, when the pair carries it: pass `ctx.input` to `buildSituationalContext` inside a `ctx.code` step. */
  isGroup?: boolean;
  gapSincePreviousMs?: number;
  priorMessages?: PriorMessage[];
}

/** A JSON array or JSONL file (one JSON value per line) -> raw records. A line that is not JSON is reported, not fatal. */
export function parseHistoryText(text: string): { records: unknown[]; badLines: InvalidRecord[] } {
  const trimmed = text.trim();
  if (!trimmed) return { records: [], badLines: [] };
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of pairs.');
    return { records: parsed, badLines: [] };
  }
  const records: unknown[] = [];
  const badLines: InvalidRecord[] = [];
  trimmed.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch {
      badLines.push({ index: i, reason: 'not valid JSON' });
    }
  });
  return { records, badLines };
}

export async function loadPairs(store: Pick<FileStore, 'pairsFile'>): Promise<HistoryPair[]> {
  let text: string;
  try {
    text = await fs.readFile(store.pairsFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const pairs: HistoryPair[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const r = normalizePair(JSON.parse(line));
    if ('pair' in r) pairs.push(r.pair);
  }
  return pairs;
}

export function caseFromPair(flowId: string, pair: HistoryPair, step: string): ReplayCase {
  const input: HistoryInput = {
    channel: pair.channel,
    ...(pair.threadId ? { threadId: pair.threadId } : {}),
    sender: pair.sender,
    incoming: pair.incoming,
    ...(pair.incomingAt ? { incomingAt: pair.incomingAt } : {}),
    ...(pair.tags ? { tags: pair.tags } : {}),
    ...(pair.metadata ? { metadata: pair.metadata } : {}),
    ...(pair.isGroup !== undefined ? { isGroup: pair.isGroup } : {}),
    ...(pair.gapSincePreviousMs !== undefined ? { gapSincePreviousMs: pair.gapSincePreviousMs } : {}),
    ...(pair.priorMessages ? { priorMessages: pair.priorMessages } : {}),
  };
  const hash = createHash('sha256').update(`${flowId}\u0000${step}\u0000${pair.id}`).digest('hex').slice(0, 12);
  return {
    id: `case_seed_${hash}`,
    flowId,
    runId: `seed_${pair.id}`,
    at: pair.replyAt ?? pair.incomingAt ?? UNDATED,
    input,
    stepKey: `ai:${step}`,
    stepName: step,
    aiDraft: null,
    humanChoice: null,
    humanText: pair.reply,
    edited: true,
    seeded: true,
  };
}

export interface SeedOptions {
  flowId: string;
  /** Keep only the most recent N pairs of the file (after dropping invalid ones and duplicates). */
  limit?: number;
  /** Report what would happen; write nothing. */
  dryRun?: boolean;
  /** Name of the flow's ai step that writes the reply. Default `draft`. */
  step?: string;
  /** Keep one-time passcodes and bare tapback/reaction echoes instead of skipping them. Default false. */
  includeNoise?: boolean;
}

export interface SeedReport {
  flowId: string;
  step: string;
  dryRun: boolean;
  /** Records in the file. */
  read: number;
  invalid: InvalidRecord[];
  /** Repeats of an earlier pair in the same file. */
  duplicatesInFile: number;
  /** Pairs skipped as automated codes (2FA / OTP) or reaction echoes. Always zero with `includeNoise`. */
  noiseSkipped: NoiseCounts;
  /** Pairs left after `limit`. */
  considered: number;
  /** Pairs already in `history/pairs.jsonl`. */
  alreadySeeded: number;
  /** New pairs written to `history/pairs.jsonl`. */
  added: number;
  /** New replay cases written for the flow. */
  casesAdded: number;
  /** Pairs in `history/pairs.jsonl` afterwards. */
  totalPairs: number;
}

export const DEFAULT_SEED_STEP = 'draft';

/**
 * Day-1 bootstrap: read real past (incoming -> reply) pairs, save them, and turn them into replay cases for a flow
 * so `rufus replay` and `rufus compare` have real material before any live run. Safe to repeat: pairs are
 * deduplicated by id (or a hash of channel + sender + incoming + reply) and so are the cases.
 */
export async function seedHistory(engine: Engine, file: string, opts: SeedOptions): Promise<SeedReport> {
  engine.getFlow(opts.flowId); // fail early on an unknown flow
  if (opts.limit !== undefined && !(opts.limit > 0)) throw new Error('limit must be a positive number.');
  const step = opts.step ?? DEFAULT_SEED_STEP;
  const store = engine.store;
  await store.init();

  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No such file: ${file}`);
    throw err;
  }
  const { records, badLines } = parseHistoryText(text);

  const invalid: InvalidRecord[] = [...badLines];
  const seenInFile = new Set<string>();
  let duplicatesInFile = 0;
  const noiseSkipped = emptyNoise();
  let pairs: HistoryPair[] = [];
  records.forEach((raw, index) => {
    const r = normalizePair(raw);
    if ('error' in r) return void invalid.push({ index, reason: r.error });
    const noise = opts.includeNoise ? undefined : pairNoiseKind(r.pair);
    if (noise) return void addNoise(noiseSkipped, noise);
    if (seenInFile.has(r.pair.id)) return void duplicatesInFile++;
    seenInFile.add(r.pair.id);
    pairs.push(r.pair);
  });
  if (opts.limit !== undefined) pairs = pairs.slice(-Math.floor(opts.limit));

  const existing = await loadPairs(store);
  const have = new Set(existing.map((p) => p.id));
  const fresh = pairs.filter((p) => !have.has(p.id));

  const cases = pairs.map((p) => caseFromPair(opts.flowId, p, step));
  const haveCases = new Set((await engine.cases.forFlow(opts.flowId)).map((c) => c.id));
  let casesAdded = cases.filter((c) => !haveCases.has(c.id)).length;

  if (!opts.dryRun) {
    if (fresh.length) {
      const all = [...existing, ...fresh];
      await store.writeText(store.pairsFile, all.map((p) => JSON.stringify(p)).join('\n') + '\n');
    }
    casesAdded = await engine.cases.addMany(opts.flowId, cases);
  }

  return {
    flowId: opts.flowId,
    step,
    dryRun: !!opts.dryRun,
    read: records.length + badLines.length,
    invalid,
    duplicatesInFile,
    noiseSkipped,
    considered: pairs.length,
    alreadySeeded: pairs.length - fresh.length,
    added: fresh.length,
    casesAdded,
    totalPairs: existing.length + (opts.dryRun ? 0 : fresh.length),
  };
}

export function formatSeed(r: SeedReport): string[] {
  const lines = [
    r.dryRun
      ? `Dry run: would add ${r.added} new pair(s) and ${r.casesAdded} replay case(s) for "${r.flowId}" (step "${r.step}"). Nothing was written.`
      : `Seeded "${r.flowId}": ${r.added} new pair(s) saved, ${r.casesAdded} replay case(s) added (step "${r.step}"). ${r.totalPairs} pair(s) in history.`,
    `  read ${r.read}, invalid ${r.invalid.length}, repeated in file ${r.duplicatesInFile}, already seeded ${r.alreadySeeded}`,
  ];
  if (r.noiseSkipped.total) {
    const { otp, tapback } = r.noiseSkipped;
    lines.push(`  skipped ${r.noiseSkipped.total} noise item(s): ${otp} one-time passcode(s) / verification code(s), ${tapback} tapback reaction(s). Add --include-noise to keep them.`);
  }
  for (const bad of r.invalid.slice(0, 5)) lines.push(`  skipped record ${bad.index + 1}: ${bad.reason}`);
  if (r.invalid.length > 5) lines.push(`  ...and ${r.invalid.length - 5} more skipped.`);
  if (!r.dryRun && r.casesAdded) lines.push(`Next: rufus replay ${r.flowId} --limit 5   or   rufus compare ${r.flowId} --limit 5   (each case calls your provider)`);
  return lines;
}
