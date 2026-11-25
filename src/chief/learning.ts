import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CorpusStore, EmbeddingCache, LocalEmbeddingProvider, corpusEmbedItems, type CorpusItem, type EmbeddingProvider } from '../corpus';
import { clip, stableId } from '../corpus/types';
import type { ToolDefinition } from '../tools/tools';

/**
 * Conversational self-learning (v15). When the human gives a correction, a preference or a fact in normal chat or a voice
 * note ("ignore WhatsApp call alerts", "keep messages less dense", "I'm meeting the pastor on Friday"), Rufus saves it at
 * once into `<workspace>/corpus/items.jsonl` as a high-signal `feedback` item. Triage and chat already retrieve feedback
 * examples from the corpus, so the note shapes the very next decision: Rufus learns from conversation, not only from
 * "2 <reason>" on an item.
 *
 * Everything is local: no message leaves, nothing is sent. The `remember` tool is therefore `local` (chat runs it right
 * away when the human says something worth keeping) and never needs a Verify item.
 */

export const REMEMBER_TOOL = 'remember';

/** `feedback`: a correction ("stop flagging X"). `preference`: how they like things. `fact`: something true to keep in mind. */
export type NoteKind = 'feedback' | 'preference' | 'fact';
/** `reject`: "don't do / don't bother me with that". `note`: keep this in mind. */
export type NoteVerdict = 'reject' | 'note';

export const NOTE_KINDS: readonly NoteKind[] = ['feedback', 'preference', 'fact'];

/** Action types a note always reaches: chat and email triage + drafting, and the Chief of Staff. */
export const NOTE_ACTION_TYPES: readonly string[] = ['reply.chat', 'reply.email', 'triage', 'chief'];

/** Tag every human note carries, so code can find them. */
export const HUMAN_NOTE_TAG = 'human_note';

export interface HumanNote {
  /** The correction, preference or fact, in their words (or a faithful short paraphrase). */
  text: string;
  kind?: NoteKind;
  verdict?: NoteVerdict;
  /** Who or what it is about ("WhatsApp", "Pastor X"), if any. */
  about?: string;
  /** Extra action types it applies to (`reply.chat`, `schedule.block`, ...). Chat/email triage and chat are always included. */
  appliesTo?: string[];
  /** Where it was said: `chat` (default) or `voice`. */
  via?: string;
}

export interface RememberOptions {
  now?: Date;
  /**
   * Embeds the new item into `corpus/embeddings.jsonl` with this provider. Default: only when that cache already exists,
   * and only with the free, offline local provider if the cache holds local vectors. `false`: never embed.
   */
  embeddings?: EmbeddingProvider | false;
}

export interface RememberResult {
  item: CorpusItem;
  /** True when the item was also embedded into the cache. */
  embedded: boolean;
}

const corpusFile = (dir: string): string => path.join(dir, 'corpus', 'items.jsonl');
const embeddingsFile = (dir: string): string => path.join(dir, 'corpus', 'embeddings.jsonl');

/** A sensible default verdict: "ignore / stop / don't / never ..." is a rejection; anything else a note. */
export function guessVerdict(text: string): NoteVerdict {
  return /\b(ignore|stop|don'?t|do not|never|no more|skip|quit|drop|mute|less of|not worry|needn'?t|no need)\b/i.test(text) ? 'reject' : 'note';
}

/** A sensible default kind. */
export function guessKind(text: string, verdict: NoteVerdict): NoteKind {
  if (verdict === 'reject') return 'feedback';
  if (/\b(i prefer|prefer|keep (it|them|messages|replies)|less|more|shorter|longer|always|i like|i'd like|i want|please)\b/i.test(text)) return 'preference';
  return 'fact';
}

/** One human note as a corpus feedback item, written so triage/drafting prompts read it as a rule. */
export function noteItem(note: HumanNote, now: Date = new Date()): CorpusItem {
  const text = note.text.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('A note needs text.');
  const verdict: NoteVerdict = note.verdict === 'reject' || note.verdict === 'note' ? note.verdict : guessVerdict(text);
  const kind: NoteKind = NOTE_KINDS.includes(note.kind as NoteKind) ? (note.kind as NoteKind) : guessKind(text, verdict);
  const via = note.via?.trim() || 'chat';
  const about = note.about?.trim() || undefined;
  const appliesTo = [...new Set([...NOTE_ACTION_TYPES, ...(note.appliesTo ?? []).map((t) => t.trim()).filter(Boolean)])];
  const summary = [`Human ${kind} (told in ${via})${about ? ` about ${about}` : ''}`, `Human: ${verdict}`, `Note: ${text}`].join(' | ');
  return {
    id: stableId('note', kind, text.toLowerCase()),
    source: 'feedback',
    kind,
    title: clip(`${kind}: ${text}`, 200),
    summary: clip(summary, 500),
    ...(about ? { actor: about } : {}),
    timestamp: now.toISOString(),
    tags: [...new Set([HUMAN_NOTE_TAG, kind, verdict, via, ...appliesTo])],
    metadata: { verdict, kind, note: text, via, appliesTo, ...(about ? { about } : {}) },
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves a human note into `<dir>/corpus/items.jsonl` (the same text twice is one item, refreshed), and embeds it into
 * the cache when embeddings are in use. Embedding is best-effort: the note is saved even if it fails.
 */
export async function rememberNote(dir: string, note: HumanNote, opts: RememberOptions = {}): Promise<RememberResult> {
  const item = noteItem(note, opts.now ?? new Date());
  await new CorpusStore(corpusFile(dir)).add([item]);
  let embedded = false;
  if (opts.embeddings !== false) {
    try {
      const cache = new EmbeddingCache(embeddingsFile(dir));
      let provider: EmbeddingProvider | undefined = opts.embeddings;
      if (!provider && (await exists(cache.file))) {
        const local = new LocalEmbeddingProvider();
        if ((await cache.stats())[local.id]) provider = local;
      }
      if (provider) embedded = (await cache.sync(corpusEmbedItems([item]), provider)).total > 0;
    } catch {
      /* embedding is best-effort; the note itself is saved */
    }
  }
  return { item, embedded };
}

/** Saved human notes, newest first (for prompts that should always respect them, like the think-beat). */
export async function loadHumanNotes(dir: string, limit = 8): Promise<CorpusItem[]> {
  const items = await new CorpusStore(corpusFile(dir)).load().catch(() => [] as CorpusItem[]);
  return items
    .filter((i) => i.source === 'feedback' && i.tags?.includes(HUMAN_NOTE_TAG))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, Math.max(0, limit));
}

/** The built-in `remember` tool: chat saves corrections, preferences and facts as it hears them. */
export function rememberTool(opts: { embeddings?: EmbeddingProvider | false } = {}): ToolDefinition<Record<string, unknown>, { saved: string; kind: NoteKind; verdict: NoteVerdict; embedded: boolean }> {
  return {
    name: REMEMBER_TOOL,
    description:
      'Save a correction, preference or fact the human just told you, so you follow it from now on (private, local). Use it whenever they correct you or tell you how they want things. args: {"text":"<the rule or fact, in their words>","kind":"feedback"|"preference"|"fact","verdict":"reject"|"note","about"?:"<who/what>"}',
    readOnly: false,
    local: true,
    async execute(args, ctx) {
      const text = typeof args?.text === 'string' ? args.text : typeof args?.note === 'string' ? args.note : '';
      if (!text.trim()) throw new Error('remember needs "text".');
      const r = await rememberNote(
        ctx.dir,
        {
          text,
          ...(typeof args.kind === 'string' ? { kind: args.kind as NoteKind } : {}),
          ...(typeof args.verdict === 'string' ? { verdict: args.verdict as NoteVerdict } : {}),
          ...(typeof args.about === 'string' ? { about: args.about } : {}),
          ...(Array.isArray(args.appliesTo) ? { appliesTo: args.appliesTo.filter((x): x is string => typeof x === 'string') } : {}),
          ...(typeof args.via === 'string' ? { via: args.via } : {}),
        },
        { now: ctx.now, ...(opts.embeddings !== undefined ? { embeddings: opts.embeddings } : {}) },
      );
      const meta = r.item.metadata as { kind: NoteKind; verdict: NoteVerdict };
      return { saved: clip(text, 200), kind: meta.kind, verdict: meta.verdict, embedded: r.embedded };
    },
  };
}
