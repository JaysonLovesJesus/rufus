import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BouncerExample, LosslessEvent } from '../types';
import { featureText } from './training';

/**
 * The owner's own past replies (incoming message -> his reply, with the delay), mined by v1.
 * They say what the owner cared enough to answer, which is not the same as what Rufus should act on,
 * so they are only a weak prior: a feature on live events, and capped low-priority labels that every real label outranks.
 */
export interface ReplyPair {
  threadId?: string;
  channel?: string;
  sender?: string;
  incoming?: string;
  isGroup?: boolean;
  replyDelayMs?: number;
  incomingAt?: string;
}

/** Replied within this: the owner treated it as worth answering now. */
export const FAST_REPLY_MS = 5 * 60_000;
/** Left this long before a reply: it did not need anyone right away. */
export const SLOW_REPLY_MS = 6 * 60 * 60_000;
/** A thread needs this many past replies before its reply habit counts as a signal. */
const MIN_REPLIES = 5;
/** Weak labels never outnumber the real ones by much, and never exceed this. */
const MAX_PAIR_LABELS = 300;
const MIN_PAIR_LABELS = 40;

export function replyPairsPath(workspaceDir: string): string | undefined {
  const own = path.join(workspaceDir, 'training', 'reply-pairs.jsonl');
  // The v1 mine lives in the legacy ~/.rufus folder, which belongs to the owner's real workspace only.
  const legacy = path.join(os.homedir(), '.rufus', 'history', 'pairs.jsonl');
  return path.resolve(workspaceDir) === path.join(os.homedir(), '.rufus-v2') ? `${own}\n${legacy}` : own;
}

export async function loadReplyPairs(workspaceDir: string): Promise<ReplyPair[]> {
  for (const file of (replyPairsPath(workspaceDir) ?? '').split('\n')) {
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    if (!raw) continue;
    const out: ReplyPair[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ReplyPair);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }
  return [];
}

const nameKey = (s: string | undefined) =>
  (s ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .toLowerCase();

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : Infinity;
};

/** How the owner answers each thread and each person: how often and how fast. */
export class ReplyProfile {
  private readonly byThread = new Map<string, number[]>();
  private readonly bySender = new Map<string, number[]>();

  constructor(pairs: readonly ReplyPair[] = []) {
    for (const p of pairs) this.add(p.threadId, p.sender, p.replyDelayMs);
  }

  add(threadId: string | undefined, sender: string | undefined, delayMs: number | undefined): void {
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) return;
    const push = (m: Map<string, number[]>, k: string) => {
      if (!k) return;
      const list = m.get(k) ?? [];
      list.push(delayMs);
      m.set(k, list);
    };
    if (threadId) push(this.byThread, threadId);
    push(this.bySender, nameKey(sender));
  }

  get size(): number {
    return this.byThread.size + this.bySender.size;
  }

  /** `owner_replies:fast|slow|rare` for a message from someone else; nothing for other events. */
  feature(e: Pick<LosslessEvent, 'source' | 'kind' | 'actor' | 'threadId'>): string | undefined {
    if (e.source !== 'message' || e.kind === 'owner_direct' || e.kind === 'owner_sent' || e.kind === 'assistant_sent') return undefined;
    if (!this.size) return undefined;
    const delays = (e.threadId ? this.byThread.get(e.threadId) : undefined) ?? this.bySender.get(nameKey(e.actor)) ?? [];
    if (delays.length < MIN_REPLIES) return 'owner_replies:rare';
    return median(delays) <= 3 * FAST_REPLY_MS ? 'owner_replies:fast' : 'owner_replies:slow';
  }
}

/**
 * Weak WAKE/SLEEP labels from the reply pairs: a fast reply is a weak WAKE, a reply left for hours a weak SLEEP.
 * The texts are built like live Beeper events, so they teach the same features the live model sees.
 * Capped near the number of real labels, newest first, half each way where the pairs allow it.
 */
export function replyPairExamples(pairs: readonly ReplyPair[], realLabels: number, profile = new ReplyProfile(pairs)): BouncerExample[] {
  const cap = Math.min(MAX_PAIR_LABELS, Math.max(MIN_PAIR_LABELS, realLabels));
  const sorted = [...pairs].filter((p) => p.incoming?.trim() && typeof p.replyDelayMs === 'number').sort((a, b) => (b.incomingAt ?? '').localeCompare(a.incomingAt ?? ''));
  const toExample = (p: ReplyPair, label: 'WAKE' | 'SLEEP'): BouncerExample => {
    const ev = { source: 'message', kind: 'chat', actor: (p.sender ?? 'unknown').trim(), ...(p.threadId ? { threadId: p.threadId } : {}) } as const;
    const replies = profile.feature(ev);
    return {
      text: featureText({ ...ev, channel: p.channel ?? 'beeper', text: p.incoming!.trim().slice(0, 500), metadata: { features: [`chat:${p.isGroup ? 'group' : 'dm'}`, ...(replies ? [replies] : [])] } }),
      label,
      source: 'reply_pair',
      at: p.incomingAt ?? new Date(0).toISOString(),
    };
  };
  const fast = sorted.filter((p) => p.replyDelayMs! <= FAST_REPLY_MS).map((p) => toExample(p, 'WAKE'));
  const slow = sorted.filter((p) => p.replyDelayMs! >= SLOW_REPLY_MS).map((p) => toExample(p, 'SLEEP'));
  const half = Math.ceil(cap / 2);
  const takeSlow = Math.min(slow.length, Math.max(half, cap - fast.length));
  const takeFast = Math.min(fast.length, cap - takeSlow);
  return [...fast.slice(0, takeFast), ...slow.slice(0, takeSlow)];
}
