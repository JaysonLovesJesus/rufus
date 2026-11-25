import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HumanCard, TelegramConfig, TranscribeCommand } from '../types';
import type { IncomingMessage, LiveChannel } from './bridge';
import { commandTranscriber, type Transcriber } from './transcribe';

export const DEFAULT_TELEGRAM_API = 'https://api.telegram.org';
/** Telegram rejects messages longer than 4096 characters. */
const MAX_TEXT = 4000;

/** Telegram isn't reachable (offline, DNS, timeout). Safe to retry later. */
export class TelegramOfflineError extends Error {
  constructor(reason: string) {
    super(`Telegram is not reachable (${reason}). Is the network up?`);
    this.name = 'TelegramOfflineError';
  }
}

/** Telegram answered, but not with success (bad token, wrong chat id, another poller...). */
export class TelegramApiError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Telegram API error ${status}: ${detail}`);
    this.name = 'TelegramApiError';
  }
}

export interface TelegramOptions {
  token: string;
  /** The only chat Rufus talks to. Updates from any other chat are ignored. */
  chatId: string;
  /** Default https://api.telegram.org */
  apiUrl?: string;
  timeoutMs?: number;
  /** Where the `getUpdates` offset is saved, so a restart never re-reads handled updates. Memory only if unset. */
  stateFile?: string;
  /**
   * Turns voice notes and audio into text: a local command (see `TranscribeCommand`) or,
   * for tests, a function. Unset: voice notes and audio are skipped.
   */
  transcribe?: TranscribeCommand | Transcriber;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Settings from `config.json` (`"telegram": {...}`) overridden by env vars
 * `RUFUS_TELEGRAM_TOKEN`, `RUFUS_TELEGRAM_CHAT_ID`, `RUFUS_TELEGRAM_API_URL`.
 */
export function resolveTelegramOptions(file: TelegramConfig = {}, env: NodeJS.ProcessEnv = process.env): TelegramOptions {
  const token = env.RUFUS_TELEGRAM_TOKEN || file.token;
  const chatId = env.RUFUS_TELEGRAM_CHAT_ID || (file.chatId === undefined ? undefined : String(file.chatId));
  const missing = [!token && 'RUFUS_TELEGRAM_TOKEN', !chatId && 'RUFUS_TELEGRAM_CHAT_ID'].filter(Boolean);
  if (missing.length) {
    throw new Error(`Telegram is not configured: set ${missing.join(' and ')} (or "telegram" in config.json).`);
  }
  const apiUrl = env.RUFUS_TELEGRAM_API_URL || file.apiUrl;
  const transcribe = file.transcribe?.command ? file.transcribe : undefined;
  return { token: token!, chatId: chatId!.trim(), ...(apiUrl ? { apiUrl } : {}), ...(transcribe ? { transcribe } : {}) };
}

interface TelegramChat { id: number | string }
interface TelegramUser { is_bot?: boolean }
interface TelegramFileRef { file_id: string; mime_type?: string }
interface TelegramMessage {
  message_id: number;
  date?: number;
  text?: string;
  voice?: TelegramFileRef;
  audio?: TelegramFileRef;
  chat?: TelegramChat;
  from?: TelegramUser;
}
interface TelegramCallback {
  id: string;
  data?: string;
  from?: TelegramUser;
  message?: TelegramMessage;
}
type TelegramReactionType = { type: 'emoji'; emoji: string } | { type: string; emoji?: string };
interface TelegramReaction {
  chat?: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  date?: number;
  old_reaction?: TelegramReactionType[];
  new_reaction?: TelegramReactionType[];
}
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallback;
  message_reaction?: TelegramReaction;
}

/** Telegram Bot API over plain `fetch`, no dependencies. Short-polls `getUpdates`; never reads other chats. */
export class TelegramChannel implements LiveChannel {
  private readonly base: string;
  private readonly fileBase: string;
  private readonly doFetch: typeof fetch;
  private readonly transcriber?: Transcriber;
  private offset?: number;
  private loaded = false;

  constructor(private readonly opts: TelegramOptions) {
    const api = (opts.apiUrl ?? DEFAULT_TELEGRAM_API).replace(/\/+$/, '');
    this.base = `${api}/bot${opts.token}`;
    this.fileBase = `${api}/file/bot${opts.token}`;
    this.doFetch = opts.fetch ?? fetch;
    const t = opts.transcribe;
    this.transcriber = typeof t === 'function' ? t : t?.command ? commandTranscriber(t) : undefined;
  }

  /** Sends to the configured chat (split if longer than Telegram allows). Returns the last message id. */
  async send(text: string): Promise<string | void> {
    return this.sendText(text);
  }

  /** Same text, plus one tap-to-answer button per option. A tap comes back through `poll()` as `"<ref> <n>"`. */
  async sendCard(card: HumanCard, text: string): Promise<string | void> {
    const keyboard = card.options.map((o, i) => [{ text: `${i + 1}) ${o.label}`.slice(0, 64), callback_data: `${card.id} ${i + 1}` }]);
    return this.sendText(text, keyboard.length ? { inline_keyboard: keyboard } : undefined);
  }

  /** Shows "typing..." in the chat while Rufus works. Best effort: never throws. */
  async typing(): Promise<void> {
    await this.call('sendChatAction', { chat_id: this.opts.chatId, action: 'typing' }).catch(() => undefined);
  }

  /** Puts an emoji reaction on a message in the chat (e.g. a 👍 on "ok thanks"). Best effort: never throws. */
  async react(messageId: string, emoji: string): Promise<void> {
    const id = Number(messageId);
    if (!Number.isInteger(id) || !emoji.trim()) return;
    await this.call('setMessageReaction', { chat_id: this.opts.chatId, message_id: id, reaction: [{ type: 'emoji', emoji: emoji.trim() }] }).catch(() => undefined);
  }

  /**
   * New messages from the configured chat, oldest first. Voice notes and audio arrive as their
   * transcript when `transcribe` is set. An emoji reaction the human adds arrives as `[reacted 👍]` with `reaction` set.
   * Other chats, bots and other non-text updates are skipped.
   */
  async poll(since?: string): Promise<IncomingMessage[]> {
    await this.loadOffset();
    const updates = await this.call<TelegramUpdate[]>('getUpdates', {
      timeout: 0,
      allowed_updates: ['message', 'callback_query', 'message_reaction'],
      ...(this.offset !== undefined ? { offset: this.offset } : {}),
    });
    if (!updates.length) return [];
    // Confirm everything we were given, including what we ignore, so it is never delivered again.
    this.offset = Math.max(...updates.map((u) => u.update_id)) + 1;
    await this.saveOffset();

    const sinceMs = since ? Date.parse(since) : undefined;
    const out: IncomingMessage[] = [];
    for (const u of [...updates].sort((a, b) => a.update_id - b.update_id)) {
      if (u.callback_query) {
        const msg = this.fromCallback(u);
        if (msg) out.push(msg);
        // Stops the button's spinner. Best effort: a failure here must not lose the tap.
        void this.call('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => undefined);
        continue;
      }
      if (u.message_reaction) {
        const r = this.fromReaction(u, sinceMs);
        if (r) out.push(r);
        continue;
      }
      const m = u.message;
      if (!m || !this.isFromHuman(m)) continue;
      const audio = m.voice ?? m.audio;
      if (!m.text?.trim() && !(audio?.file_id && this.transcriber)) continue;
      const at = m.date ? new Date(m.date * 1000).toISOString() : undefined;
      // Telegram dates are whole seconds, so treat the second `since` falls in as still new.
      if (sinceMs !== undefined && m.date && (m.date + 1) * 1000 <= sinceMs) continue;
      const text = m.text?.trim() ? m.text : await this.transcribeAudio(audio!.file_id);
      if (text) out.push({ id: `tg_${u.update_id}`, text, messageId: String(m.message_id), ...(at ? { at } : {}) });
    }
    return out;
  }

  /** Never throws: `{ online: false, reason }` when the token or network is bad. */
  async status(): Promise<{ online: true } | { online: false; reason: string }> {
    try {
      await this.call('getMe');
      return { online: true };
    } catch (err) {
      return { online: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------- internals ----------

  /**
   * Downloads a voice note or audio file and returns its transcript. Never throws: on failure it
   * tells the chat briefly (best effort) and returns undefined, so one bad file can't stop polling.
   * The update is already confirmed, so a failing file is not retried forever.
   */
  private async transcribeAudio(fileId: string): Promise<string | undefined> {
    let dir: string | undefined;
    try {
      const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
      if (!file.file_path) throw new Error('Telegram gave no file path (file too big?)');
      const res = await this.download(file.file_path);
      dir = await mkdtemp(path.join(os.tmpdir(), 'rufus-voice-'));
      const ext = path.extname(file.file_path).replace(/[^.\w]/g, '') || '.ogg';
      const local = path.join(dir, `voice${ext}`);
      await writeFile(local, Buffer.from(await res.arrayBuffer()));
      const text = (await this.transcriber!(local)).trim();
      if (!text) throw new Error('no speech found');
      return text;
    } catch (err) {
      const reason = this.scrub(err instanceof Error ? err.message : String(err)).slice(0, 200);
      await this.sendText(`Couldn't transcribe that voice note (${reason}). Try again, or send it as text.`).catch(() => undefined);
      return undefined;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async download(filePath: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.fileBase}/${filePath}`, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000) });
    } catch (err) {
      throw new TelegramOfflineError(this.scrub(err instanceof Error ? err.message : String(err)));
    }
    if (!res.ok) throw new TelegramApiError(res.status, 'file download failed');
    return res;
  }

  private fromCallback(u: TelegramUpdate): IncomingMessage | undefined {
    const cb = u.callback_query!;
    if (cb.from?.is_bot || !cb.data || !this.isConfiguredChat(cb.message?.chat)) return undefined;
    return { id: `tg_${u.update_id}`, text: cb.data };
  }

  /** A reaction the human just added (not one they removed), as a readable message. */
  private fromReaction(u: TelegramUpdate, sinceMs?: number): IncomingMessage | undefined {
    const r = u.message_reaction!;
    if (r.user?.is_bot || !this.isConfiguredChat(r.chat)) return undefined;
    if (sinceMs !== undefined && r.date && (r.date + 1) * 1000 <= sinceMs) return undefined;
    const emojis = (list?: TelegramReactionType[]): string[] => (list ?? []).map((x) => (x.type === 'emoji' && typeof x.emoji === 'string' ? x.emoji : '')).filter(Boolean);
    const before = new Set(emojis(r.old_reaction));
    const emoji = emojis(r.new_reaction).find((e) => !before.has(e));
    if (!emoji) return undefined;
    const at = r.date ? new Date(r.date * 1000).toISOString() : undefined;
    return { id: `tg_${u.update_id}`, text: `[reacted ${emoji}]`, reaction: { emoji, targetMessageId: String(r.message_id) }, ...(at ? { at } : {}) };
  }

  private isFromHuman(m: TelegramMessage): boolean {
    return !m.from?.is_bot && this.isConfiguredChat(m.chat);
  }

  private isConfiguredChat(chat?: TelegramChat): boolean {
    return chat?.id !== undefined && String(chat.id) === this.opts.chatId;
  }

  private async sendText(text: string, replyMarkup?: unknown): Promise<string | void> {
    const chunks = chunk(text);
    let last: string | undefined;
    for (const [i, part] of chunks.entries()) {
      const sent = await this.call<{ message_id?: number }>('sendMessage', {
        chat_id: this.opts.chatId,
        text: part,
        // Buttons go on the last chunk, next to where the reply is expected.
        ...(replyMarkup && i === chunks.length - 1 ? { reply_markup: replyMarkup } : {}),
      });
      if (sent.message_id !== undefined) last = String(sent.message_id);
    }
    return last;
  }

  private async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new TelegramOfflineError(this.scrub(err instanceof Error ? err.message : String(err)));
    }
    const body = (await res.json().catch(() => undefined)) as { ok?: boolean; result?: T; description?: string } | undefined;
    if (!res.ok || !body?.ok) {
      const status = res.status;
      const detail =
        status === 401 || status === 404
          ? 'check RUFUS_TELEGRAM_TOKEN'
          : status === 409
            ? 'another process is polling this bot, or a webhook is set (delete it with deleteWebhook)'
            : body?.description || res.statusText || 'request failed';
      throw new TelegramApiError(status, this.scrub(detail));
    }
    return body.result as T;
  }

  /** Never let the bot token leak into an error message or log. */
  private scrub(s: string): string {
    return s.split(this.opts.token).join('<token>');
  }

  private async loadOffset(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.opts.stateFile) return;
    try {
      const saved = JSON.parse(await readFile(this.opts.stateFile, 'utf8')) as { offset?: unknown };
      if (typeof saved.offset === 'number') this.offset = saved.offset;
    } catch {
      // No state yet, or unreadable: start fresh (the bridge's `since` still skips old chat).
    }
  }

  private async saveOffset(): Promise<void> {
    const file = this.opts.stateFile;
    if (!file || this.offset === undefined) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, offset: this.offset }), 'utf8');
      await rename(tmp, file);
    } catch {
      // The offset is still held in memory; the bridge also remembers handled ids.
    }
  }
}

/** Splits on paragraph/line/space boundaries so no piece passes Telegram's limit. */
function chunk(text: string): string[] {
  if (text.length <= MAX_TEXT) return [text || '(empty)'];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT) {
    const window = rest.slice(0, MAX_TEXT);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > MAX_TEXT / 2 ? cut : MAX_TEXT;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function createTelegramChannel(file?: TelegramConfig, env?: NodeJS.ProcessEnv, extra: Partial<TelegramOptions> = {}): TelegramChannel {
  return new TelegramChannel({ ...resolveTelegramOptions(file, env), ...extra });
}
