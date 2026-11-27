import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WakeRecord } from '../eval/flight-recorder';
import { isRealChange } from '../rpg/outcome';
import type { BouncerExample, BouncerLabel, LosslessEvent } from '../types';

/** Training text must be an event's feature text (`source:x | kind:y | ...`), never a tool id or other label. */
const FEATURE_TEXT = /^source:[^|]+ \| kind:/;
/** What the owner said or did about an event outranks what Rufus did with it. */
const OWNER_SIGNALS = new Set<BouncerExample['source']>(['pushback', 'skip', 'approval', 'user_message']);
const OPUS = new Set<BouncerExample['source']>(['opus_acted', 'opus_sleep']);
/** One in five labelled examples is held out, picked by a hash of its text so the split stays the same as data grows. */
const HELD_OUT_EVERY = 5;

export function isFeatureText(text: string): boolean {
  return FEATURE_TEXT.test(text);
}

function textHash(text: string): number {
  return createHash('sha1').update(text).digest().readUInt32BE(0);
}

export function isHeldOut(text: string): boolean {
  return textHash(text) % HELD_OUT_EVERY === 0;
}

/** Feature text the Bouncer classifies; lives here so training code and the Bouncer agree on one format. */
export function featureText(e: Pick<LosslessEvent, 'source' | 'kind' | 'actor' | 'channel' | 'deleted' | 'text'> & { metadata?: Record<string, unknown> }): string {
  // Senses add their own learned signals (chat:group, muted:true, category:updates...) as `metadata.features`.
  const features = Array.isArray(e.metadata?.features) ? e.metadata.features.filter((f): f is string => typeof f === 'string') : [];
  return [`source:${e.source}`, `kind:${e.kind}`, e.actor ? `actor:${e.actor}` : '', e.channel ? `channel:${e.channel}` : '', e.deleted ? 'deleted:true' : '', ...features, e.text]
    .filter(Boolean)
    .join(' | ');
}

export interface ResolveStats {
  raw: number;
  notFeatureText: number;
  relabeled: number;
  merged: number;
}

/**
 * Turns the raw label log into one example per text:
 * - drops anything that is not an event's feature text;
 * - re-derives Rufus's own labels from what each wake really changed (`relabel`, keyed by event id or feature text);
 * - an owner signal (pushback, skip, approval) beats Rufus's labels, which beat the hand-written seeds;
 * - among Rufus's own labels for the same text, the majority wins, ties go to WAKE (a missed event costs more than a wasted wake).
 */
export function resolveExamples(examples: readonly BouncerExample[], relabel?: ReadonlyMap<string, BouncerLabel>): { examples: BouncerExample[]; stats: ResolveStats } {
  const stats: ResolveStats = { raw: examples.length, notFeatureText: 0, relabeled: 0, merged: 0 };
  const byText = new Map<string, BouncerExample[]>();
  for (const ex of examples) {
    if (!ex.text || !isFeatureText(ex.text)) {
      stats.notFeatureText++;
      continue;
    }
    let e = ex;
    if (relabel && OPUS.has(ex.source)) {
      const label = (ex.eventId ? relabel.get(ex.eventId) : undefined) ?? relabel.get(ex.text);
      if (label && label !== ex.label) {
        e = { ...ex, label, source: label === 'WAKE' ? 'opus_acted' : 'opus_sleep' };
        stats.relabeled++;
      }
    }
    const group = byText.get(e.text) ?? [];
    group.push(e);
    byText.set(e.text, group);
  }
  const out: BouncerExample[] = [];
  for (const group of byText.values()) {
    stats.merged += group.length - 1;
    const owner = group.filter((x) => OWNER_SIGNALS.has(x.source));
    if (owner.length) {
      out.push(owner[owner.length - 1]!);
      continue;
    }
    const opus = group.filter((x) => OPUS.has(x.source));
    if (opus.length) {
      const wakes = opus.filter((x) => x.label === 'WAKE').length;
      const label: BouncerLabel = wakes * 2 >= opus.length ? 'WAKE' : 'SLEEP';
      out.push(opus.filter((x) => x.label === label).pop()!);
      continue;
    }
    out.push(group[group.length - 1]!);
  }
  return { examples: out, stats };
}

/**
 * Seeds are the prior and always train; every other example is either trained on or held out, never both.
 * WAKE examples are rare, so each label keeps at least one held-out example once it has a few, or recall could not be measured.
 */
export function splitHeldOut(examples: readonly BouncerExample[]): { train: BouncerExample[]; heldOut: BouncerExample[] } {
  const held = new Set<BouncerExample>();
  for (const label of ['WAKE', 'SLEEP'] as const) {
    const pool = examples.filter((x) => x.source !== 'seed' && x.label === label);
    const picked = pool.filter((x) => isHeldOut(x.text));
    if (!picked.length && pool.length >= 3) picked.push(pool.reduce((a, b) => (textHash(b.text) < textHash(a.text) ? b : a)));
    for (const x of picked) held.add(x);
  }
  return { train: examples.filter((x) => !held.has(x)), heldOut: examples.filter((x) => held.has(x)) };
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/**
 * Re-derives every wake's label from its trace: WAKE only if a move changed a gap, sent something or changed the world.
 * Keyed by the trigger's event id and its feature text (older label lines carry only the text). Reads files directly and never
 * builds an EventStore, so it cannot touch the vector cache.
 */
export async function relabelFromWakes(workspaceDir: string): Promise<Map<string, BouncerLabel>> {
  const wakes = await readJsonl<WakeRecord>(path.join(workspaceDir, 'wakes.jsonl'));
  if (!wakes.length) return new Map();
  const events = new Map<string, LosslessEvent>();
  for (const e of await readJsonl<LosslessEvent>(path.join(workspaceDir, 'events.jsonl'))) if (e.id) events.set(e.id, e);
  const out = new Map<string, BouncerLabel>();
  for (const w of wakes) {
    if (!w.trigger?.id || !Array.isArray(w.trace)) continue;
    const label: BouncerLabel = w.trace.some((t) => t.receipt && isRealChange(t.receipt)) ? 'WAKE' : 'SLEEP';
    out.set(w.trigger.id, label);
    const ev = events.get(w.trigger.id);
    if (ev) out.set(featureText(ev), label);
  }
  return out;
}

/** The wake that put an approval in front of the owner, found through the approval id in its trace. */
export async function wakeForApproval(workspaceDir: string, approvalId: string): Promise<WakeRecord | undefined> {
  const wakes = await readJsonl<WakeRecord>(path.join(workspaceDir, 'wakes.jsonl'));
  return wakes.reverse().find((w) => (w.trace ?? []).some((t) => (t.receipt?.data as { approvalId?: string } | undefined)?.approvalId === approvalId));
}

/** The wake that sent a message, found by its text. */
export async function wakeForSentText(workspaceDir: string, text: string): Promise<WakeRecord | undefined> {
  const wakes = await readJsonl<WakeRecord>(path.join(workspaceDir, 'wakes.jsonl'));
  return wakes.reverse().find((w) => (w.sentMessages ?? []).some((s) => s.trim() === text.trim()));
}

export interface HeldOutMetrics {
  n: number;
  wake: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** WAKE precision and recall; null when undefined (nothing predicted WAKE / no WAKE examples). */
  precision: number | null;
  recall: number | null;
  accuracy: number;
}

export function scoreLabels(gold: readonly BouncerLabel[], predicted: readonly BouncerLabel[]): HeldOutMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let correct = 0;
  gold.forEach((g, i) => {
    const p = predicted[i];
    if (p === g) correct++;
    if (g === 'WAKE' && p === 'WAKE') tp++;
    else if (g !== 'WAKE' && p === 'WAKE') fp++;
    else if (g === 'WAKE' && p !== 'WAKE') fn++;
  });
  const round = (x: number) => Number(x.toFixed(3));
  return {
    n: gold.length,
    wake: tp + fn,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: tp + fp ? round(tp / (tp + fp)) : null,
    recall: tp + fn ? round(tp / (tp + fn)) : null,
    accuracy: gold.length ? round(correct / gold.length) : 0,
  };
}

/** A retrained model replaces the current one only if it misses no more WAKE events on the held-out set. */
export function shouldPromote(candidate: HeldOutMetrics, current: HeldOutMetrics | undefined): { promote: boolean; reason: string } {
  if (!current) return { promote: true, reason: 'no previous model' };
  if (!candidate.n) return { promote: false, reason: 'no held-out examples to compare on; kept the current model' };
  if (candidate.wake === 0) {
    const promote = candidate.accuracy >= current.accuracy;
    return { promote, reason: `no held-out WAKE examples; accuracy ${current.accuracy} -> ${candidate.accuracy}` };
  }
  const promote = (candidate.recall ?? 0) >= (current.recall ?? 0);
  return { promote, reason: `held-out WAKE recall ${current.recall} -> ${candidate.recall}` };
}

export interface TrainingMetrics {
  at: string;
  promoted: boolean;
  reason: string;
  trainExamples: number;
  heldOut: { n: number; wake: number };
  candidate: HeldOutMetrics;
  current?: HeldOutMetrics;
  resolve: ResolveStats;
}

export function formatTrainingMetrics(m: TrainingMetrics | undefined): string[] {
  if (!m) return ['  Bouncer:           not retrained yet (no held-out metrics)'];
  const pr = (x?: HeldOutMetrics) => (x ? `P=${x.precision ?? '-'} R=${x.recall ?? '-'} acc=${x.accuracy}` : 'none');
  return [
    `  Bouncer (held-out ${m.heldOut.n}, ${m.heldOut.wake} WAKE): live ${m.promoted ? pr(m.candidate) : pr(m.current)}`,
    `  Last retrain:      ${m.at.slice(0, 16)} ${m.promoted ? 'promoted' : 'kept previous'} (${m.reason}); candidate ${pr(m.candidate)}`,
    `  Training labels:   ${m.trainExamples} trained on; dropped ${m.resolve.notFeatureText} non-event text(s), merged ${m.resolve.merged} repeat(s), relabeled ${m.resolve.relabeled}`,
  ];
}
