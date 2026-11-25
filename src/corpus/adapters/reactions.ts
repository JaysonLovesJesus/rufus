import { promises as fs } from 'node:fs';
import { extractReactionExamples, REACTION_SOURCE, type ChatMessageLike } from '../../history/reactions';
import { parseReactions } from '../../tools/beeper-api';
import { limitNewest, parseJsonRecords, type CollectOptions, type CorpusItem, type SourceAdapter } from '../types';

export type ReactionsOptions = CollectOptions;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : undefined);

/** One raw Beeper message (`/v1/chats/{id}/messages` item) as a `ChatMessageLike`. */
function messageOf(m: Record<string, unknown>, chatId: string | undefined, myIds: ReadonlySet<string>): ChatMessageLike {
  const reactions = parseReactions(m.reactions, myIds);
  const id = str(m.id) ?? str(m.messageID);
  const chat = str(m.chatID) ?? str(m.chatId) ?? chatId;
  return {
    ...(id ? { id } : {}),
    ...(chat ? { chatId: chat } : {}),
    text: str(m.text) ?? '',
    ...(typeof m.isSender === 'boolean' ? { isSender: m.isSender } : {}),
    ...(str(m.senderName) ? { senderName: str(m.senderName)! } : {}),
    ...(str(m.timestamp) ? { timestamp: str(m.timestamp)! } : {}),
    ...(m.isDeleted === true ? { isDeleted: true } : {}),
    ...(reactions.length ? { reactions } : {}),
  };
}

const records = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);

/**
 * A saved Beeper messages export as reaction examples: either one chat's messages (`[...]`, `{ "items": [...] }`, JSONL)
 * or several chats (`{ "chats": [{ "id", "title", "messages": [...] }] }`). Only messages you answered with an emoji and
 * no text become items (`source: 'chat_reaction'`).
 */
export function reactionItemsFromExport(raw: unknown[]): CorpusItem[] {
  const chats: Array<{ id?: string; title?: string; messages: Record<string, unknown>[] }> = [];
  const loose: Record<string, unknown>[] = [];
  for (const r of records(raw)) {
    if (Array.isArray(r.chats)) {
      for (const c of records(r.chats)) chats.push({ ...(str(c.id) ? { id: str(c.id)! } : {}), ...(str(c.title) ? { title: str(c.title)! } : {}), messages: records(c.messages ?? c.items) });
    } else if (Array.isArray(r.items) || Array.isArray(r.messages)) {
      chats.push({ messages: records(r.items ?? r.messages) });
    } else loose.push(r);
  }
  // Loose messages: one list per chat id, in the order given.
  const byChat = new Map<string, Record<string, unknown>[]>();
  for (const m of loose) {
    const k = str(m.chatID) ?? str(m.chatId) ?? '';
    byChat.set(k, [...(byChat.get(k) ?? []), m]);
  }
  for (const [id, messages] of byChat) chats.push({ ...(id ? { id } : {}), messages });

  return chats.flatMap((c) => {
    const myIds = new Set(c.messages.flatMap((m) => (m.isSender === true ? [str(m.senderID) ?? str(m.senderId)].filter((x): x is string => !!x) : [])));
    const msgs = c.messages.map((m) => messageOf(m, c.id, myIds)).sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    return extractReactionExamples(msgs, { ...(c.id ? { chatId: c.id } : {}), ...(c.title ? { sender: c.title } : {}) });
  });
}

/** `rufus collect reactions <export.json>`: what you only answered with an emoji, so triage can suggest the same. */
export const reactionsAdapter: SourceAdapter<ReactionsOptions> = {
  id: 'reactions',
  source: REACTION_SOURCE,
  async collect(options) {
    const { records: raw } = parseJsonRecords(await fs.readFile(options.path, 'utf8'));
    return limitNewest(reactionItemsFromExport(raw), options.limit);
  },
};
