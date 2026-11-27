import { cosineSimilarity, type Embedder, type Vector } from '../embed';
import { ROOT_GAP_ID, type Gap } from '../gaps/store';
import type { LosslessEvent } from '../types';

/** One open gap an event touches, and how. */
export interface GapHint {
  id: string;
  title: string;
  target: string;
  reality: string;
  /** Best cosine of the event against the gap's target or its reality. */
  score: number;
  /** The event's person or chat is named in the gap, or the gap's evidence comes from the same thread. */
  tie?: 'person' | 'thread';
}

export interface GapLook {
  /** Bouncer-readable tags (`gap_person:true`, `gap_near:high`...): learned signals, not rules. */
  features: string[];
  /** The gaps worth showing a second opinion, closest first. */
  hints: GapHint[];
}

/**
 * Cosine cut-offs per embedder: how close an event must be to a gap's target or reality to count as near it.
 * Each model spreads scores differently, so each gets its own pair, measured on the live log.
 */
const NEAR: Array<{ match: RegExp; high: number; mid: number }> = [
  // e5 (off by default, behind RUFUS_EMBED_MODEL), with query/passage roles.
  { match: /e5/i, high: 0.6, mid: 0.5 },
  // On the live log, 0.45+ is about the top 2% of events (travel mail vs the trip gap); below 0.38 is noise.
  { match: /MiniLM/i, high: 0.45, mid: 0.38 },
  { match: /^hash-/, high: 0.3, mid: 0.2 },
];
const DEFAULT_NEAR = { high: 0.45, mid: 0.38 };

export function nearThresholds(modelId: string | undefined): { high: number; mid: number } {
  return NEAR.find((n) => n.match.test(modelId ?? '')) ?? DEFAULT_NEAR;
}

/** Words that name nobody in particular. */
const NOT_A_NAME = new Set(['someone', 'unknown', 'owner', 'rufus', 'group', 'the', 'and', 'you', 'me', 'sender', 'beeper', 'whatsapp', 'telegram', 'chat', 'team', 'support', 'info', 'noreply', 'no-reply', 'notifications']);

/** Lowercased letters only (emoji and punctuation gone), so "Sam 🫶" and "Sam" compare equal. */
function clean(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}@.\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordIn(haystack: string, word: string): boolean {
  if (!word) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(haystack);
}

/** Names that identify who the event is from or which chat it is in. */
export function eventNames(e: LosslessEvent): { names: string[]; phrases: string[] } {
  const names = new Set<string>();
  const phrases = new Set<string>();
  const people = [e.actor, e.audience?.from, typeof e.metadata?.fromEmail === 'string' ? e.metadata.fromEmail.split('@')[0] : undefined];
  for (const p of people) {
    if (!p) continue;
    const c = clean(p.replace(/<[^>]*>/g, ''));
    if (!c || NOT_A_NAME.has(c)) continue;
    phrases.add(c);
    // A person's first name is how the owner usually writes them into a gap ("reply to Sam").
    const first = c.split(' ')[0]!;
    if (first.length >= 3 && !NOT_A_NAME.has(first)) names.add(first);
  }
  const title = e.audience?.chatTitle ?? (typeof e.metadata?.chatTitle === 'string' ? e.metadata.chatTitle : undefined);
  if (title) {
    const c = clean(title);
    // A chat title only counts whole: a group named "The Axis Movement" must not tie to any gap that says "movement".
    if (c.length >= 3 && !NOT_A_NAME.has(c)) phrases.add(c);
  }
  return { names: [...names], phrases: [...phrases] };
}

const gapText = (g: Gap) => clean([g.title, g.target, g.reality, g.waitingOn ?? '', ...(g.findings ?? []).slice(-3)].join(' \n '));

/** How the event is tied to a gap by who or where, if at all. */
export function gapTie(e: LosslessEvent, g: Gap): GapHint['tie'] | undefined {
  if (e.threadId) {
    const prefix = `beeper_${e.threadId}_`;
    if (g.evidenceIds.some((id) => id.startsWith(prefix)) || `${g.reality}\n${g.target}`.includes(e.threadId)) return 'thread';
  }
  const hay = gapText(g);
  // The owner's own message ties by the chat he wrote in (the person he answered), never by his own name.
  if (e.kind === 'owner_direct' || e.kind === 'owner_sent' || e.audience?.from === 'owner') {
    const title = clean(e.audience?.chatTitle ?? '');
    const first = title.split(' ')[0]!;
    const dmFirstName = e.audience?.chatType !== 'group' && first.length >= 3 && !NOT_A_NAME.has(first) && wordIn(hay, first);
    return title.length >= 3 && (wordIn(hay, title) || dmFirstName) ? 'person' : undefined;
  }
  const { names, phrases } = eventNames(e);
  if (phrases.some((p) => wordIn(hay, p)) || names.some((n) => wordIn(hay, n))) return 'person';
  return undefined;
}

/**
 * The Bouncer's view of the gap tree: which open gaps an event is close to (by meaning) or tied to (by person or thread).
 * The root gap is left out, since every event is "near" finding gaps.
 */
export class GapLens {
  private readonly cache = new Map<string, Vector>();
  constructor(private readonly opts: { gaps: () => Promise<Gap[]>; embedder: Embedder }) {}

  private async vec(text: string, query = false): Promise<Vector> {
    const key = `${query ? 'q' : 'p'}:${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const e = this.opts.embedder;
    const v = query && e.embedQuery ? await e.embedQuery(text) : await e.embed(text);
    // Gap texts repeat on every event; event texts never do, so only gap texts stay cached.
    if (!query) {
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(key, v);
    }
    return v;
  }

  async look(e: LosslessEvent): Promise<GapLook> {
    const gaps = (await this.opts.gaps()).filter((g) => g.id !== ROOT_GAP_ID && g.status !== 'closed' && g.status !== 'dropped');
    if (!gaps.length) return { features: [], hints: [] };
    const { high, mid } = nearThresholds(this.opts.embedder.modelId);
    const who = [e.actor, e.audience?.chatTitle].filter(Boolean).join(' / ');
    const q = await this.vec(`${who ? `${who}: ` : ''}${e.text}`.slice(0, 1000), true);
    const hints: GapHint[] = [];
    for (const g of gaps) {
      const t = await this.vec(`${g.title}. ${g.target}`.slice(0, 1000));
      const r = g.reality ? await this.vec(g.reality.slice(0, 1000)) : undefined;
      const score = Number(Math.max(cosineSimilarity(q, t), r ? cosineSimilarity(q, r) : -1).toFixed(4));
      const tie = gapTie(e, g);
      hints.push({ id: g.id, title: g.title, target: g.target, reality: g.reality, score, ...(tie ? { tie } : {}) });
    }
    hints.sort((a, b) => (b.tie ? 1 : 0) - (a.tie ? 1 : 0) || b.score - a.score);
    const best = Math.max(...hints.map((h) => h.score));
    const features = [
      hints.some((h) => h.tie === 'person') ? 'gap_person:true' : '',
      hints.some((h) => h.tie === 'thread') ? 'gap_thread:true' : '',
      best >= high ? 'gap_near:high' : best >= mid ? 'gap_near:mid' : '',
    ].filter(Boolean);
    const shown = hints.filter((h) => h.tie || h.score >= mid);
    return { features, hints: (shown.length ? shown : hints).slice(0, 3) };
  }
}

/** Adds sense-time features to an event without dropping the ones its sense set. */
export function withFeatures(e: LosslessEvent, extra: readonly string[]): LosslessEvent {
  if (!extra.length) return e;
  const had = Array.isArray(e.metadata?.features) ? (e.metadata!.features as unknown[]).filter((f): f is string => typeof f === 'string') : [];
  const features = [...new Set([...had, ...extra])];
  return { ...e, metadata: { ...(e.metadata ?? {}), features } };
}
