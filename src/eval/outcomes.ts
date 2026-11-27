import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LosslessEvent } from '../types';

/**
 * Owner outcomes, at $0: how the owner reacts, not whether tools succeeded.
 * Each owner message is classified by cheap rules and tied to the gap it was about, so `rufus stats` can show
 * time to close, owner messages per closed gap, pushback rate and reply latency.
 */

export type OwnerMessageClass = 'new_ask' | 'correction' | 'repeat' | 'thanks';

const THANKS =
  /^(?:(?:ok(?:ay)?|great|perfect)[,.!\s]+)?(?:thanks|thank you|thx|ty|cheers|perfect|great|awesome|nice|cool|love (?:it|this|that)|appreciate (?:it|that|you)|good job|well done|that works|sounds good)\b|^\p{Extended_Pictographic}+$/iu;

const CORRECTION = new RegExp(
  [
    String.raw`\bthat'?s not (?:what|it|right|true)\b`,
    String.raw`\bnot what i (?:asked|meant|wanted|said)\b`,
    String.raw`\bi (?:already|just) (?:asked|said|told|did)\b`,
    String.raw`\bi (?:know|said|told you)\b`,
    String.raw`\byou (?:didn'?t|haven'?t|forgot|missed|keep|still)\b`,
    String.raw`\bstill (?:see|there|not|isn'?t|haven'?t|hasn'?t|waiting)\b`,
    String.raw`\b(?:isn'?t|wasn'?t|not) (?:done|fixed|gone|working|right)\b`,
    String.raw`\bdoesn'?t (?:work|help)\b`,
    String.raw`\bdidn'?t (?:really )?(?:want|ask)\b`,
    String.raw`\bwhy (?:did|are|do|would) you\b`,
    String.raw`\bstop \w+ing\b`,
    String.raw`\bwrong\b`,
    String.raw`\bnot enough\b`,
    String.raw`\bplease,? i just\b`,
    String.raw`\bfor me\b.*\b(?:am|pm)\b|\b(?:am|pm)\b.*\bfor me\b`,
    String.raw`^no[,.!]`,
  ].join('|'),
  'i',
);

const STOP = new Set(
  'the a an and or but to of in on at for with from by is are was were be been it its this that these those i you he she we they me my your our can could would should will do does did have has had what which who how when where why just please also so now then there here about into than too very really some any all any not no yes ok okay'.split(' '),
);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** How close a message must be to an earlier one (by content words) to count as asking again. */
const REPEAT_SIMILARITY = 0.6;
const REPEAT_WINDOW_MS = 24 * 60 * 60_000;

/** Classifies one owner message against the owner's earlier messages (oldest first). */
export function classifyOwnerMessage(text: string, earlier: ReadonlyArray<{ text: string }> = []): OwnerMessageClass {
  const s = text.trim().replace(/[‘’]/g, "'");
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (s.length <= 80 && THANKS.test(s) && !/\b(?:can you|could you|please|now|also|but|next)\b/i.test(s)) return 'thanks';
  if (CORRECTION.test(s)) return 'correction';
  if (norm(s) && earlier.some((e) => norm(e.text) === norm(s))) return 'repeat';
  const words = contentWords(s);
  if (words.size >= 2 && earlier.some((e) => jaccard(words, contentWords(e.text)) >= REPEAT_SIMILARITY)) return 'repeat';
  return 'new_ask';
}

export function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

interface GapLike {
  id: string;
  title: string;
  status: string;
  evidenceIds?: string[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

interface WakeLike {
  trigger: { id: string };
  trace: Array<{ gapId?: string }>;
}

export interface OwnerMessageOutcome {
  id: string;
  at: string;
  text: string;
  class: OwnerMessageClass;
  gapId?: string;
  /** Time from this message to Rufus's next message, if one came within the hour. */
  replyMs?: number;
}

export interface GapOutcome {
  id: string;
  title: string;
  status: string;
  ownerMessages: number;
  pushbacks: number;
  /** Created to closed, for closed gaps. */
  closeMs?: number;
}

export interface OwnerOutcomes {
  ownerMessages: number;
  byClass: Record<OwnerMessageClass, number>;
  pushbackRate: number;
  linkedToGap: number;
  replyP50Ms?: number;
  replyP90Ms?: number;
  closedGaps: number;
  closeP50Ms?: number;
  ownerMessagesPerClosedGap?: number;
  gaps: GapOutcome[];
  messages: OwnerMessageOutcome[];
}

const REPLY_WINDOW_MS = 60 * 60_000;

/** Computes owner outcomes from the event log, the gap tree and the wake log. Pure: pass the data in. */
export function computeOwnerOutcomes(input: { events: readonly LosslessEvent[]; gaps: readonly GapLike[]; wakes: readonly WakeLike[] }): OwnerOutcomes {
  const chat = input.events
    .filter((e) => e.source === 'message' && (e.kind === 'owner_direct' || e.kind === 'assistant_sent'))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const owner = chat.filter((e) => e.kind === 'owner_direct');
  const sentTimes = chat.filter((e) => e.kind === 'assistant_sent').map((e) => Date.parse(e.timestamp));

  // A message is tied to a gap by the gap's evidence, else by the gap its own wake worked on most.
  const gapByEvidence = new Map<string, string>();
  for (const g of input.gaps) for (const id of g.evidenceIds ?? []) if (!gapByEvidence.has(id)) gapByEvidence.set(id, g.id);
  const gapByWake = new Map<string, string>();
  for (const w of input.wakes) {
    const counts = new Map<string, number>();
    for (const t of w.trace) if (t.gapId && t.gapId !== 'gap_root') counts.set(t.gapId, (counts.get(t.gapId) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && !gapByWake.has(w.trigger.id)) gapByWake.set(w.trigger.id, top[0]);
  }

  const messages: OwnerMessageOutcome[] = [];
  owner.forEach((e, i) => {
    const at = Date.parse(e.timestamp);
    const earlier = owner.slice(0, i).filter((p) => at - Date.parse(p.timestamp) <= REPEAT_WINDOW_MS);
    const reply = sentTimes.find((t) => t > at);
    const gapId = gapByEvidence.get(e.id) ?? gapByWake.get(e.id);
    messages.push({
      id: e.id,
      at: e.timestamp,
      text: e.text,
      class: classifyOwnerMessage(e.text, earlier),
      ...(gapId ? { gapId } : {}),
      ...(reply !== undefined && reply - at <= REPLY_WINDOW_MS ? { replyMs: reply - at } : {}),
    });
  });

  const byClass: Record<OwnerMessageClass, number> = { new_ask: 0, correction: 0, repeat: 0, thanks: 0 };
  for (const m of messages) byClass[m.class]++;
  const pushbacks = byClass.correction + byClass.repeat;
  const replies = messages.flatMap((m) => (m.replyMs !== undefined ? [m.replyMs] : []));

  const gaps: GapOutcome[] = input.gaps
    .filter((g) => g.id !== 'gap_root')
    .map((g) => {
      const mine = messages.filter((m) => m.gapId === g.id);
      const closeMs = g.status === 'closed' ? Date.parse(g.closedAt ?? g.updatedAt) - Date.parse(g.createdAt) : undefined;
      return {
        id: g.id,
        title: g.title,
        status: g.status,
        ownerMessages: mine.length,
        pushbacks: mine.filter((m) => m.class === 'correction' || m.class === 'repeat').length,
        ...(closeMs !== undefined && Number.isFinite(closeMs) ? { closeMs } : {}),
      };
    });
  const closed = gaps.filter((g) => g.closeMs !== undefined);
  const closeP50Ms = percentile(closed.map((g) => g.closeMs!), 50);
  const replyP50Ms = percentile(replies, 50);
  const replyP90Ms = percentile(replies, 90);

  return {
    ownerMessages: messages.length,
    byClass,
    pushbackRate: messages.length ? Number((pushbacks / messages.length).toFixed(3)) : 0,
    linkedToGap: messages.filter((m) => m.gapId).length,
    ...(replyP50Ms !== undefined ? { replyP50Ms } : {}),
    ...(replyP90Ms !== undefined ? { replyP90Ms } : {}),
    closedGaps: closed.length,
    ...(closeP50Ms !== undefined ? { closeP50Ms } : {}),
    ...(closed.length ? { ownerMessagesPerClosedGap: Number((closed.reduce((s, g) => s + g.ownerMessages, 0) / closed.length).toFixed(2)) } : {}),
    gaps,
    messages,
  };
}

/** Reads the raw event log (last line per id wins) without loading the embedder. */
export async function readEventLog(workspaceDir: string): Promise<LosslessEvent[]> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, 'events.jsonl'), 'utf8');
    const byId = new Map<string, LosslessEvent>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LosslessEvent;
        if (e && typeof e.id === 'string') byId.set(e.id, e);
      } catch {
        /* skip */
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

export async function readGaps(workspaceDir: string): Promise<GapLike[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(workspaceDir, 'gaps.json'), 'utf8')) as unknown;
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { gaps?: unknown }).gaps) ? (parsed as { gaps: unknown[] }).gaps : [];
    return list.filter((g): g is GapLike => !!g && typeof g === 'object' && typeof (g as GapLike).id === 'string');
  } catch {
    return [];
  }
}
