import { BeeperApiError, BeeperOfflineError } from '../channels/beeper';
import type { BeeperConfig } from '../types';

/** Beeper Desktop's local API, by default on this machine only. */
export const DEFAULT_BEEPER_API_URL = 'http://127.0.0.1:23373';

export interface BeeperApiOptions {
  apiUrl?: string;
  token?: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** One chat, as the sensor needs it. Unknown fields are kept loose: Beeper versions differ. */
export interface BeeperChat {
  id: string;
  title?: string;
  /** `single` or `group` where Beeper says so. */
  type?: string;
  network?: string;
  /** ISO time of the last activity, when Beeper reports it. */
  lastActivity?: string;
  isMuted?: boolean;
  isArchived?: boolean;
  raw: Record<string, unknown>;
}

export interface BeeperApiMessage {
  id: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
  /** True when you sent it. */
  isSender?: boolean;
  isDeleted?: boolean;
  type?: string;
  text: string;
  timestamp?: string;
  sortKey?: string;
  /** v18: emoji reactions on this message, when Beeper returns them. `isMe` marks yours. */
  reactions?: BeeperReaction[];
}

/** One emoji reaction on a message. */
export interface BeeperReaction {
  emoji: string;
  participantId?: string;
  /** True when you reacted. */
  isMe?: boolean;
}

/** v18 name for a Beeper message as the sensor and tools see it. */
export type BeeperMessage = BeeperApiMessage;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : undefined);
const listOf = (body: unknown): Record<string, unknown>[] => {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const b = (body ?? {}) as Record<string, unknown>;
  for (const k of ['items', 'chats', 'messages', 'data']) if (Array.isArray(b[k])) return b[k] as Record<string, unknown>[];
  return [];
};

function textOf(m: Record<string, unknown>): string {
  const t = str(m.text);
  if (t?.trim()) return t;
  for (const a of (Array.isArray(m.attachments) ? m.attachments : []) as Array<Record<string, unknown>>) {
    const tr = a?.transcription as unknown;
    const s = typeof tr === 'string' ? tr : str((tr as Record<string, unknown> | undefined)?.transcription);
    if (s?.trim()) return s;
  }
  return '';
}

/**
 * Reactions as Beeper Desktop returns them (`reactions: [{ reactionKey, participantID, emoji, ... }]`), read loosely:
 * `emoji` may be the emoji itself or a flag next to `reactionKey`. `myIds` are your own participant ids (the senders of
 * messages marked `isSender`), so a reaction is yours even when Beeper does not say `isMe`.
 */
export function parseReactions(raw: unknown, myIds: ReadonlySet<string> = new Set()): BeeperReaction[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): BeeperReaction[] => {
    if (typeof r === 'string') return r.trim() ? [{ emoji: r.trim() }] : [];
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const emoji = (typeof o.emoji === 'string' ? str(o.emoji) : undefined) ?? str(o.reactionKey) ?? str(o.key) ?? str(o.reaction) ?? str(o.text);
    if (!emoji?.trim()) return [];
    const participantId = str(o.participantID) ?? str(o.participantId) ?? str(o.senderID) ?? str(o.senderId) ?? str(o.userID) ?? str(o.userId);
    const flag = typeof o.isMe === 'boolean' ? o.isMe : typeof o.isSender === 'boolean' ? o.isSender : undefined;
    const isMe = flag ?? (participantId !== undefined && myIds.has(participantId) ? true : undefined);
    return [{ emoji: emoji.trim(), ...(participantId ? { participantId } : {}), ...(isMe !== undefined ? { isMe } : {}) }];
  });
}

/** Settings from `config.beeper` (`apiUrl`, or the older `url`), with `RUFUS_BEEPER_URL` / `RUFUS_BEEPER_TOKEN` winning. */
export function beeperApiOptions(file: BeeperConfig = {}, env: NodeJS.ProcessEnv = process.env): BeeperApiOptions {
  const token = env.RUFUS_BEEPER_TOKEN || file.token;
  return { apiUrl: env.RUFUS_BEEPER_URL || file.apiUrl || file.url || DEFAULT_BEEPER_API_URL, ...(token ? { token } : {}) };
}

/** A tiny client for Beeper Desktop's local HTTP API (`/v1/chats`, `/v1/chats/{id}/messages`). No dependencies. */
export class BeeperApi {
  readonly url: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: BeeperApiOptions = {}) {
    this.url = (opts.apiUrl ?? DEFAULT_BEEPER_API_URL).replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? fetch;
  }

  async listChats(): Promise<BeeperChat[]> {
    const body = await this.json('GET', '/v1/chats');
    return listOf(body).flatMap((c): BeeperChat[] => {
      const id = str(c.id) ?? str(c.chatID) ?? str(c.chatId);
      if (!id) return [];
      return [
        {
          id,
          ...(str(c.title) ? { title: str(c.title)! } : {}),
          ...(str(c.type) ? { type: str(c.type)! } : {}),
          ...(str(c.network) ?? str(c.accountID) ? { network: (str(c.network) ?? str(c.accountID))! } : {}),
          ...(str(c.lastActivity) ? { lastActivity: str(c.lastActivity)! } : {}),
          ...(typeof c.isMuted === 'boolean' ? { isMuted: c.isMuted } : {}),
          ...(typeof c.isArchived === 'boolean' ? { isArchived: c.isArchived } : {}),
          raw: c,
        },
      ];
    });
  }

  /** Messages of one chat, oldest first. */
  async listMessages(chatId: string, opts: { limit?: number } = {}): Promise<BeeperApiMessage[]> {
    const q = opts.limit ? `?limit=${encodeURIComponent(String(opts.limit))}` : '';
    const body = await this.json('GET', `/v1/chats/${encodeURIComponent(chatId)}/messages${q}`);
    const raw = listOf(body);
    const myIds = new Set(raw.flatMap((m) => (m.isSender === true ? [str(m.senderID) ?? str(m.senderId)].filter((x): x is string => !!x) : [])));
    return raw
      .flatMap((m): BeeperApiMessage[] => {
        const id = str(m.id) ?? str(m.messageID);
        if (!id) return [];
        const reactions = parseReactions(m.reactions, myIds);
        return [
          {
            id,
            chatId,
            ...(str(m.senderID) ?? str(m.senderId) ? { senderId: (str(m.senderID) ?? str(m.senderId))! } : {}),
            ...(str(m.senderName) ? { senderName: str(m.senderName)! } : {}),
            ...(typeof m.isSender === 'boolean' ? { isSender: m.isSender } : {}),
            ...(m.isDeleted === true ? { isDeleted: true } : {}),
            ...(str(m.type) ? { type: str(m.type)! } : {}),
            text: textOf(m),
            ...(str(m.timestamp) ? { timestamp: str(m.timestamp)! } : {}),
            ...(str(m.sortKey) ? { sortKey: str(m.sortKey)! } : {}),
            ...(reactions.length ? { reactions } : {}),
          },
        ];
      })
      .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || (a.sortKey ?? '').localeCompare(b.sortKey ?? ''));
  }

  /** Sends a text to a chat. Returns Beeper's pending message id, if any. */
  async sendMessage(chatId: string, text: string): Promise<string | undefined> {
    const body = (await this.json('POST', `/v1/chats/${encodeURIComponent(chatId)}/messages`, { text })) as { pendingMessageID?: string } | undefined;
    return body?.pendingMessageID;
  }

  /**
   * v21: adds an emoji reaction to one message (`POST /v1/chats/{chatID}/messages/{messageID}/reactions`,
   * `{ reactionKey }`). Throws `BeeperOfflineError` when Beeper Desktop is not reachable, `BeeperApiError` otherwise.
   */
  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<{ reacted: true; chatId: string; messageId: string; emoji: string }> {
    const c = typeof chatId === 'string' ? chatId.trim() : '';
    const m = typeof messageId === 'string' ? messageId.trim() : '';
    const e = typeof emoji === 'string' ? emoji.trim() : '';
    if (!c) throw new Error('reactToMessage needs a chatId.');
    if (!m) throw new Error('reactToMessage needs a messageId.');
    if (!e || e.length > 32) throw new Error('reactToMessage needs one emoji.');
    await this.json('POST', `/v1/chats/${encodeURIComponent(c)}/messages/${encodeURIComponent(m)}/reactions`, { reactionKey: e });
    return { reacted: true, chatId: c, messageId: m, emoji: e };
  }

  private async json(method: 'GET' | 'POST', p: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.url}${p}`, {
        method,
        headers: {
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new BeeperOfflineError(this.url, err);
    }
    if (!res.ok) {
      const detail = res.status === 401 || res.status === 403 ? 'check RUFUS_BEEPER_TOKEN (sending needs a token that allows sensitive actions)' : (await res.text().catch(() => '')).slice(0, 200) || res.statusText;
      throw new BeeperApiError(res.status, detail);
    }
    return res.json().catch(() => undefined);
  }
}
