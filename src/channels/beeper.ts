import type { BeeperConfig } from '../types';
import type { IncomingMessage, LiveChannel } from './bridge';

export const DEFAULT_BEEPER_URL = 'http://localhost:23373';

/** Beeper Desktop isn't reachable (not running, API disabled, timeout). Safe to retry later. */
export class BeeperOfflineError extends Error {
  constructor(url: string, cause?: unknown) {
    super(`Beeper Desktop is not reachable at ${url}. Is it running with the Desktop API enabled?`, { cause });
    this.name = 'BeeperOfflineError';
  }
}

/** Beeper answered, but not with success (bad token, wrong chat id...). */
export class BeeperApiError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Beeper API error ${status}: ${detail}`);
    this.name = 'BeeperApiError';
  }
}

export interface BeeperOptions {
  url?: string;
  token: string;
  chatId: string;
  timeoutMs?: number;
  /**
   * Set when the chat is a note-to-self (you and the bot share one account), so your own
   * messages count as replies. The bridge still ignores echoes of texts it sent itself.
   */
  selfChat?: boolean;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Settings from `config.json` (`"beeper": {...}`) overridden by env vars
 * `RUFUS_BEEPER_URL`, `RUFUS_BEEPER_TOKEN`, `RUFUS_BEEPER_CHAT_ID`, `RUFUS_BEEPER_SELF_CHAT`.
 */
export function resolveBeeperOptions(file: BeeperConfig = {}, env: NodeJS.ProcessEnv = process.env): BeeperOptions {
  const token = env.RUFUS_BEEPER_TOKEN || file.token;
  const chatId = env.RUFUS_BEEPER_CHAT_ID || file.chatId;
  const missing = [!token && 'RUFUS_BEEPER_TOKEN', !chatId && 'RUFUS_BEEPER_CHAT_ID'].filter(Boolean);
  if (missing.length) {
    throw new Error(`Beeper is not configured: set ${missing.join(' and ')} (or "beeper" in config.json).`);
  }
  const selfChat = env.RUFUS_BEEPER_SELF_CHAT !== undefined ? /^(1|true|yes)$/i.test(env.RUFUS_BEEPER_SELF_CHAT) : file.selfChat;
  return {
    url: env.RUFUS_BEEPER_URL || file.url || DEFAULT_BEEPER_URL,
    token: token!,
    chatId: chatId!,
    ...(selfChat !== undefined ? { selfChat } : {}),
  };
}

interface BeeperMessage {
  id: string;
  senderID?: string;
  isSender?: boolean;
  isDeleted?: boolean;
  type?: string;
  text?: string;
  timestamp?: string;
  sortKey?: string;
  attachments?: Array<{ transcription?: { transcription?: string } | string }>;
}

const TEXTUAL = new Set(['TEXT', 'VOICE', 'AUDIO']);

/** Beeper Desktop's local HTTP API (`/v1/chats/{chatID}/messages`), with no dependencies. */
export class BeeperChannel implements LiveChannel {
  private readonly url: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: BeeperOptions) {
    this.url = (opts.url ?? DEFAULT_BEEPER_URL).replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? fetch;
  }

  /** Sends to the configured chat. Returns Beeper's pending message id. */
  async send(text: string): Promise<string | void> {
    const res = await this.request('POST', this.messagesPath, { text });
    const body = (await res.json().catch(() => ({}))) as { pendingMessageID?: string };
    return body.pendingMessageID;
  }

  /** Messages from the human at or after `since` (ISO time), oldest first. Our own messages are left out. */
  async poll(since?: string): Promise<IncomingMessage[]> {
    const res = await this.request('GET', this.messagesPath);
    const body = (await res.json().catch(() => ({}))) as { items?: BeeperMessage[] };
    return (body.items ?? [])
      .filter((m) => this.isFromHuman(m) && (!since || (m.timestamp ?? '') >= since))
      .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || (a.sortKey ?? '').localeCompare(b.sortKey ?? ''))
      .flatMap((m): IncomingMessage[] => {
        const text = textOf(m);
        return text ? [{ id: m.id, text, ...(m.timestamp ? { at: m.timestamp } : {}) }] : [];
      });
  }

  /** Never throws: `{ online: false, reason }` when Beeper Desktop isn't running or the config is wrong. */
  async status(): Promise<{ online: true } | { online: false; reason: string }> {
    try {
      await this.request('GET', this.messagesPath);
      return { online: true };
    } catch (err) {
      return { online: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private get messagesPath(): string {
    return `/v1/chats/${encodeURIComponent(this.opts.chatId)}/messages`;
  }

  private isFromHuman(m: BeeperMessage): boolean {
    if (m.isDeleted) return false;
    if (m.isSender && !this.opts.selfChat) return false;
    return m.type === undefined || TEXTUAL.has(m.type);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
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
    return res;
  }
}

function textOf(m: BeeperMessage): string {
  if (m.text?.trim()) return m.text;
  for (const a of m.attachments ?? []) {
    const t = typeof a.transcription === 'string' ? a.transcription : a.transcription?.transcription;
    if (t?.trim()) return t;
  }
  return '';
}

export function createBeeperChannel(file?: BeeperConfig, env?: NodeJS.ProcessEnv): BeeperChannel {
  return new BeeperChannel(resolveBeeperOptions(file, env));
}
