import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cosineSimilarity, hashEmbed } from '../embed';
import type { LosslessEvent, Receipt } from '../types';
import { dueIn, isDone, ROOT_GAP_ID, type Gap, type GapLogEntry } from './store';

/** Scores each text against a query by meaning (the event store's embedder in the daemon). */
export type Similarity = (query: string, texts: readonly string[]) => Promise<number[]>;

/** Zero-dependency fallback when no embedder is wired in (tests, scripts). */
export const hashSimilarity: Similarity = async (query, texts) => {
  const q = hashEmbed(query);
  return texts.map((t) => cosineSimilarity(q, hashEmbed(t)));
};

// ---------------- Move fingerprints ----------------

/** Inputs that name the thing a move acts on: a third call on the same one is a loop unless something changed. */
const TARGET_KEYS = ['messageId', 'threadId', 'path', 'project', 'repo', 'chatId', 'url', 'rfc822', 'cwd'];
/** Inputs that say which kind of call it is (`t3.thread start` vs `t3.thread show`). */
const QUALIFIER_KEYS = ['action', 'subcommand', 'kind'];
/** Filled in by code from the move's gap, so never part of what the move is about. */
const IGNORED_KEYS = new Set(['gapId']);

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => !IGNORED_KEYS.has(k) && o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const short = (v: unknown, n = 80) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export interface MoveKey {
  key: string;
  target?: string;
  inputHash: string;
  inputText: string;
}

/** What a move was about: its qualifiers and target (for the log and the loop check), plus fingerprints of the whole input. */
export function moveKey(toolId: string, input: Record<string, unknown>): MoveKey {
  const parts: string[] = [];
  for (const k of QUALIFIER_KEYS) if (typeof input[k] === 'string' && (input[k] as string).trim()) parts.push(`${k}=${short(input[k], 30)}`);
  const targets: string[] = [];
  for (const k of TARGET_KEYS) if (input[k] !== undefined && input[k] !== '') targets.push(`${k}=${short(input[k], 120)}`);
  // Without a target, the most telling free-text input stands in for the key (it is never treated as a target).
  if (!targets.length) {
    const lead = ['query', 'question', 'title', 'purpose', 'label', 'command', 'goal'].find((k) => typeof input[k] === 'string' && (input[k] as string).trim());
    if (lead) parts.push(`${lead}=${short(input[lead])}`);
  }
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (!TARGET_KEYS.includes(k) && !IGNORED_KEYS.has(k)) rest[k] = v;
  const target = targets.length ? targets.join(' ') : undefined;
  return {
    key: [...parts, ...targets].join(' '),
    ...(target ? { target } : {}),
    inputHash: hash(`${toolId}|${stable(input)}`),
    inputText: stable(rest).slice(0, 400),
  };
}

/** The work-log line code writes after a move. */
export function logEntry(opts: { toolId: string; input: Record<string, unknown>; receipt: Receipt; at: string; wakeId?: string; turn?: number; expect?: string; met?: boolean }): GapLogEntry {
  const k = moveKey(opts.toolId, opts.input);
  const r = opts.receipt;
  const result = r.status === 'ok' || r.status === 'pending_approval' ? r.summary : `${r.error ?? r.summary}${r.error && !r.summary.includes(r.error) ? ` (${r.summary.slice(0, 120)})` : ''}`;
  return {
    at: opts.at,
    ...(opts.wakeId ? { wakeId: opts.wakeId } : {}),
    ...(opts.turn !== undefined ? { turn: opts.turn } : {}),
    toolId: opts.toolId,
    key: k.key,
    ...(k.target ? { target: k.target } : {}),
    inputHash: k.inputHash,
    resultHash: hash(`${r.status}|${r.summary}|${r.error ?? ''}`),
    inputText: k.inputText,
    status: r.status,
    result: result.replace(/\s+/g, ' ').slice(0, 300),
    ...(opts.expect ? { expect: opts.expect.slice(0, 200) } : {}),
    ...(opts.met !== undefined ? { met: opts.met } : {}),
  };
}

const ran = (e: GapLogEntry) => e.status === 'ok' || e.status === 'failed' || e.status === 'timed_out' || e.status === 'pending_approval';
const failed = (e: GapLogEntry) => e.status === 'failed' || e.status === 'timed_out' || (e.status === 'invalid_input' && !e.result.startsWith('repeat_'));

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

/** Word overlap of two inputs' substance: a rewording scores high, a real change of input scores low. */
export function inputOverlap(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

/** Overlap at or above this means the input did not change in substance. */
const SAME_SUBSTANCE = 0.5;

function when(e: GapLogEntry, wakeId?: string): string {
  const turn = e.turn !== undefined ? `turn ${e.turn}` : '';
  return e.wakeId && e.wakeId === wakeId ? `${turn || 'earlier'} of this wake` : `${turn ? `${turn} of ` : ''}${e.wakeId ?? 'an earlier wake'} (${e.at})`;
}

/**
 * Code's check against repeated dead ends, read from the gaps' work logs (so it holds across wakes):
 * - the exact input that already failed is not run again;
 * - a third call of the same tool on the same target, with the input unchanged in substance and the same result each time, is a loop.
 * New words from the owner after a move are new reality, so earlier moves stop counting.
 */
export function checkRepeat(opts: {
  gaps: readonly Gap[];
  servedGapId: string;
  toolId: string;
  input: Record<string, unknown>;
  wakeId?: string;
  /** The owner's latest message time: moves before it no longer count. */
  since?: string;
}): { error: 'repeat_failure' | 'repeat_target'; summary: string } | undefined {
  if (opts.toolId === 'sleep') return undefined;
  const k = moveKey(opts.toolId, opts.input);
  // A move logged at the same moment as the owner's message is treated as before it: when in doubt, the owner's words win.
  const fresh = (e: GapLogEntry) => !opts.since || e.at > opts.since;

  const all = opts.gaps.flatMap((g) => (g.log ?? []).map((e) => ({ e, gapId: g.id })));
  const sameFailure = all
    .filter(({ e }) => fresh(e) && e.toolId === opts.toolId && e.inputHash === k.inputHash && failed(e))
    .pop();
  // A timeout can be passing trouble, so it gets one retry; any other failure of the exact same input will fail again.
  const timeouts = all.filter(({ e }) => fresh(e) && e.toolId === opts.toolId && e.inputHash === k.inputHash && e.status === 'timed_out').length;
  if (sameFailure && (sameFailure.e.status !== 'timed_out' || timeouts >= 2)) {
    return {
      error: 'repeat_failure',
      summary: `Rejected: ${opts.toolId} with this exact input already failed at ${when(sameFailure.e, opts.wakeId)}${sameFailure.gapId !== opts.servedGapId ? ` for ${sameFailure.gapId}` : ''}: ${sameFailure.e.result.slice(0, 200)}. Change approach (a different input, another tool, investigate, or ask). Nothing ran.`,
    };
  }

  if (!k.target) return undefined;
  const served = opts.gaps.find((g) => g.id === opts.servedGapId);
  const prior = (served?.log ?? []).filter((e) => fresh(e) && ran(e) && e.toolId === opts.toolId && e.target === k.target);
  if (prior.length < 2) return undefined;
  const last = prior.slice(-2);
  const sameResult = last.every((e) => e.resultHash === last[0]!.resultHash);
  const sameSubstance = last.some((e) => inputOverlap(e.inputText, k.inputText) >= SAME_SUBSTANCE);
  if (!sameResult || !sameSubstance) return undefined;
  return {
    error: 'repeat_target',
    summary: `Rejected: this would be call ${prior.length + 1} of ${opts.toolId} on ${k.target} for ${opts.servedGapId} (${last.map((e) => when(e, opts.wakeId)).join(', ')}), with the input unchanged in substance, and each time the receipt said: ${last[last.length - 1]!.result.slice(0, 160)}. Trust that receipt. Change approach, or change the input in substance. Nothing ran.`,
  };
}

// ---------------- Project cards ----------------

export interface ProjectCard {
  file: string;
  name: string;
  content: string;
}

/** Cards in `<workspace>/projects/*.md`: repos, branch, autonomy envelope and decision gate for each project. */
export async function loadProjectCards(workspaceDir: string): Promise<ProjectCard[]> {
  const dir = path.join(workspaceDir, 'projects');
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_')).sort();
  } catch {
    return [];
  }
  const cards: ProjectCard[] = [];
  for (const f of files) {
    const content = (await fs.readFile(path.join(dir, f), 'utf8').catch(() => '')).trim();
    if (!content) continue;
    const heading = /^#\s*(?:Project:\s*)?(.+)$/m.exec(content)?.[1]?.trim();
    cards.push({ file: `projects/${f}`, name: heading || f.replace(/\.md$/, ''), content });
  }
  return cards;
}

/** Below this, a card is not about the gap (semantic cosine); a card named in the gap's own words always matches. */
const CARD_MIN_SCORE = 0.3;

/** The project card that matches a gap: named in the gap's words first, else the closest by meaning (if close enough). */
export async function matchProjectCard(cards: readonly ProjectCard[], gapText: string, similarity: Similarity): Promise<ProjectCard | undefined> {
  if (!cards.length || !gapText.trim()) return undefined;
  const text = gapText.toLowerCase();
  const named = cards.find((c) => {
    const slug = path.basename(c.file, '.md').replace(/[-_]+/g, ' ').toLowerCase();
    const lead = c.name.split(/[(&,:—-]/)[0]!.trim().toLowerCase();
    return (slug.length > 2 && text.includes(slug)) || (lead.length > 2 && text.includes(lead));
  });
  if (named) return named;
  const scores = await similarity(gapText, cards.map((c) => `${c.name}\n${c.content}`));
  let best = -1;
  scores.forEach((s, i) => {
    if (best < 0 || s > scores[best]!) best = i;
  });
  return best >= 0 && scores[best]! >= CARD_MIN_SCORE ? cards[best] : undefined;
}

export const gapText = (g: Pick<Gap, 'title' | 'target' | 'reality'>) => `${g.title}. ${g.target}. ${g.reality}`;

// ---------------- Gaps in play ----------------

/**
 * The gaps a wake is about: the gap the last move served (or the one a watch fired for) first,
 * then unclosed and recently closed gaps ranked by meaning against what just arrived.
 */
export async function rankGapsInPlay(opts: {
  gaps: readonly Gap[];
  focusGapId?: string;
  query: string;
  similarity: Similarity;
  now: Date;
  recentlyClosedMs: number;
  limit?: number;
}): Promise<Gap[]> {
  const limit = opts.limit ?? 2;
  const focus = opts.focusGapId ? opts.gaps.find((g) => g.id === opts.focusGapId && g.id !== ROOT_GAP_ID) : undefined;
  const pool = opts.gaps.filter(
    (g) => g.id !== ROOT_GAP_ID && g.id !== focus?.id && (!isDone(g) || opts.now.getTime() - Date.parse(g.updatedAt) <= opts.recentlyClosedMs),
  );
  const picked: Gap[] = focus ? [focus] : [];
  if (pool.length && picked.length < limit) {
    const scores = opts.query.trim() ? await opts.similarity(opts.query, pool.map(gapText)) : pool.map(() => 0);
    const ranked = pool
      .map((g, i) => ({ g, s: scores[i] ?? 0 }))
      // Ties (nothing in the arrivals points anywhere) go to the gap touched last.
      .sort((a, b) => b.s - a.s || Date.parse(b.g.updatedAt) - Date.parse(a.g.updatedAt));
    for (const r of ranked) if (picked.length < limit) picked.push(r.g);
  }
  return picked;
}

// ---------------- Which message raised a gap ----------------

/**
 * The arrival that raised a new gap: of the trigger and the messages that came in mid-wake, the owner's own message closest
 * in meaning to the gap (any event when the owner said nothing). Its id and text become the gap's evidence.
 */
export async function raisingEvent(opts: { spec: { title: string; target: string }; trigger?: LosslessEvent; arrivals?: readonly LosslessEvent[]; similarity: Similarity }): Promise<LosslessEvent | undefined> {
  const all = [...(opts.trigger ? [opts.trigger] : []), ...(opts.arrivals ?? [])];
  const owner = all.filter((e) => e.kind === 'owner_direct');
  const pool = owner.length ? owner : all;
  if (pool.length <= 1) return pool[0];
  const scores = await opts.similarity(`${opts.spec.title}. ${opts.spec.target}`, pool.map((e) => e.text));
  let best = 0;
  scores.forEach((s, i) => {
    // On a tie the later message wins: it is the newest word on the matter.
    if (s >= scores[best]!) best = i;
  });
  return pool[best];
}

// ---------------- What a brain is told about the gap ----------------

/** The gap a brain serves, in full: target, reality, due, what was found and tried, the project card, and the owner's words. */
export function gapBrief(opts: { gap: Gap; card?: ProjectCard; ownerWords?: readonly string[]; now: Date }): string {
  const g = opts.gap;
  const lines = [
    `Gap ${g.id} [${g.status}]: ${g.title}`,
    `Target (what the owner wants true): ${g.target}`,
    `Reality (what is true now): ${g.reality}`,
    ...(g.due ? [`By when: ${g.due} (${dueIn(g.due, opts.now.getTime())})`] : []),
    ...(g.waitingOn ? [`Waiting on: ${g.waitingOn}`] : []),
  ];
  if (g.findings?.length) lines.push(`Found so far:\n${g.findings.map((f) => `- ${f}`).join('\n')}`);
  if (g.log?.length) lines.push(`Work log (moves already made for this gap, oldest first; don't repeat what failed):\n${g.log.map((e) => `- ${e.at} ${e.toolId}${e.key ? ` ${e.key}` : ''} -> ${e.status}: ${e.result.slice(0, 200)}`).join('\n')}`);
  if (opts.card) lines.push(`Project card (${opts.card.file}):\n${opts.card.content.slice(0, 2500)}`);
  if (opts.ownerWords?.length) lines.push(`The owner's own words about it:\n${opts.ownerWords.slice(-8).join('\n')}`);
  return lines.join('\n');
}
