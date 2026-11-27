import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LosslessEvent, MessageSink } from '../types';
import { messageEvent } from '../events/ingest';
import { toTelegramHtml } from './format';

const execFileAsync = promisify(execFile);

export interface TelegramConfig {
  token: string;
  chatId: string;
  stt?: { command: string; args: string[] };
  /** Called when getUpdates fails (HTTP error such as 401/409, or network), so the failure is logged instead of looking like silence. */
  onPollError?: (error: string) => void;
  /** Where the getUpdates offset is kept, so a restart neither replays nor drops a message. */
  offsetPath?: string;
}

/** Reactions that read as the owner liking or disliking a message (anything else is just logged). */
const POSITIVE_REACTIONS = new Set(['👍', '❤', '❤️', '🔥', '🙏', '👏', '😍', '💯', '🎉', '👌', '🤩', '🥰', '😁', '⚡', '🏆', '✍️', '🤝']);
const NEGATIVE_REACTIONS = new Set(['👎', '😡', '🤬', '💩', '🤮', '😢', '😭', '🤡', '🥱', '😴', '🙈', '😐']);

export function reactionSentiment(emoji: string): 'positive' | 'negative' | 'neutral' {
  return POSITIVE_REACTIONS.has(emoji) ? 'positive' : NEGATIVE_REACTIONS.has(emoji) ? 'negative' : 'neutral';
}

const OWNER_TO_RUFUS = { from: 'owner', to: 'rufus', direction: 'incoming', network: 'Telegram', chatType: 'dm' } as const;

/** Minimal zero-dependency Telegram Bot API channel (lossless text + voice + media poll, send, edit, react, typing). */
export class TelegramChannel implements MessageSink {
  private readonly base: string;
  private readonly fileBase: string;
  private readonly chatId: string;
  private readonly stt?: { command: string; args: string[] };
  private offset = 0;
  private offsetLoaded = false;
  private readonly offsetPath?: string;
  /** Recent texts Rufus sent, by message id, so a reaction can say what it was a reaction to. */
  private readonly sentTexts = new Map<string, string>();
  private readonly onPollError?: (error: string) => void;
  readonly channel = 'telegram';

  constructor(cfg: TelegramConfig) {
    this.base = `https://api.telegram.org/bot${cfg.token}`;
    this.fileBase = `https://api.telegram.org/file/bot${cfg.token}`;
    this.chatId = String(cfg.chatId);
    if (cfg.stt) this.stt = cfg.stt;
    if (cfg.onPollError) this.onPollError = cfg.onPollError;
    if (cfg.offsetPath) this.offsetPath = cfg.offsetPath;
  }

  private async transcribeVoice(fileId: string): Promise<string> {
    if (!this.stt) return '[voice note — no local transcriber configured]';
    const infoRes = await fetch(`${this.base}/getFile?file_id=${encodeURIComponent(fileId)}`);
    if (!infoRes.ok) return '[voice note — failed to fetch file info]';
    const info = (await infoRes.json()) as { ok?: boolean; result?: { file_path?: string } };
    const remotePath = info.result?.file_path;
    if (!remotePath) return '[voice note — missing file path]';
    const audioRes = await fetch(`${this.fileBase}/${remotePath}`);
    if (!audioRes.ok) return '[voice note — failed to download audio]';
    const ext = path.extname(remotePath) || '.ogg';
    const tmpFile = path.join(os.tmpdir(), `rufus-voice-${Date.now()}${ext}`);
    try {
      await fs.writeFile(tmpFile, Buffer.from(await audioRes.arrayBuffer()));
      const args = this.stt.args.map((a) => a.replace(/\{file\}/g, tmpFile));
      const { stdout } = await execFileAsync(this.stt.command, args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      return stdout.trim() || '[voice note — empty transcript]';
    } catch (err) {
      return `[voice note — transcription failed: ${err instanceof Error ? err.message : String(err)}]`;
    } finally {
      await fs.rm(tmpFile, { force: true }).catch(() => undefined);
    }
  }

  /** Posts text as HTML so the Speaker's light markdown renders; if Telegram can't parse it, the same words go out as plain text. */
  private async postText(method: 'sendMessage' | 'editMessageText', fields: Record<string, unknown>, text: string): Promise<Response> {
    const post = (body: Record<string, unknown>) =>
      fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, ...fields, ...body }),
      });
    const res = await post({ text: toTelegramHtml(text), parse_mode: 'HTML' });
    if (res.status !== 400) return res;
    const detail = await res.clone().text().catch(() => '');
    return /can't parse entities/i.test(detail) ? post({ text }) : res;
  }

  async send(text: string): Promise<{ messageId?: string }> {
    const res = await this.postText('sendMessage', {}, text);
    if (!res.ok) throw new Error(`Telegram sendMessage failed (${res.status}): ${await res.text()}`);
    const body = (await res.json().catch(() => ({}))) as { result?: { message_id?: number } };
    if (body.result?.message_id !== undefined) this.rememberSent(String(body.result.message_id), text);
    return body.result?.message_id !== undefined ? { messageId: String(body.result.message_id) } : {};
  }

  /** A voice note (OGG/Opus) with the words as a plain caption, so he can read it as well as hear it. */
  async sendVoice(audioPath: string, caption?: string): Promise<{ messageId?: string }> {
    const form = new FormData();
    form.set('chat_id', this.chatId);
    form.set('voice', new Blob([await fs.readFile(audioPath)], { type: 'audio/ogg' }), path.basename(audioPath));
    // Telegram caps captions at 1024 characters.
    if (caption?.trim()) form.set('caption', caption.length > 1024 ? `${caption.slice(0, 1023)}…` : caption);
    const res = await fetch(`${this.base}/sendVoice`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Telegram sendVoice failed (${res.status}): ${await res.text()}`);
    const body = (await res.json().catch(() => ({}))) as { result?: { message_id?: number } };
    const id = body.result?.message_id;
    if (id !== undefined && caption) this.rememberSent(String(id), caption);
    return id !== undefined ? { messageId: String(id) } : {};
  }

  async edit(messageId: string, text: string): Promise<void> {
    const res = await this.postText('editMessageText', { message_id: Number(messageId) }, text);
    if (!res.ok) throw new Error(`Telegram editMessageText failed (${res.status}): ${await res.text()}`);
    this.rememberSent(messageId, text);
  }

  private rememberSent(messageId: string, text: string): void {
    this.sentTexts.delete(messageId);
    this.sentTexts.set(messageId, text);
    if (this.sentTexts.size > 300) this.sentTexts.delete(this.sentTexts.keys().next().value!);
  }

  /** The text Rufus sent as `messageId`, if it was sent since this process started. */
  sentText(messageId: string): string | undefined {
    return this.sentTexts.get(messageId);
  }

  private async loadOffset(): Promise<void> {
    if (this.offsetLoaded) return;
    this.offsetLoaded = true;
    if (!this.offsetPath) return;
    const saved = Number((await fs.readFile(this.offsetPath, 'utf8').catch(() => '')).trim());
    if (Number.isFinite(saved) && saved > this.offset) this.offset = saved;
  }

  private async saveOffset(): Promise<void> {
    if (!this.offsetPath) return;
    await fs.mkdir(path.dirname(this.offsetPath), { recursive: true });
    const tmp = `${this.offsetPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, String(this.offset), 'utf8');
    await fs.rename(tmp, this.offsetPath);
  }

  async react(messageId: string, emoji: string | null): Promise<void> {
    await fetch(`${this.base}/setMessageReaction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        message_id: Number(messageId),
        reaction: emoji ? [{ type: 'emoji', emoji }] : [],
      }),
    }).catch(() => undefined);
  }

  /** Shows "typing…" for ~5s (Telegram clears it on the next sent message). Callers refresh it every ~4s. */
  async sendTyping(chatId?: string): Promise<void> {
    const res = await fetch(`${this.base}/sendChatAction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId || this.chatId, action: 'typing' }),
    });
    if (!res.ok) throw new Error(`Telegram sendChatAction failed (${res.status}): ${await res.text()}`);
  }

  // No markRead: the Bot API has no read method for ordinary bot chats (readBusinessMessage only works for business connections).

  async poll(timeoutSec = 0): Promise<LosslessEvent[]> {
    const t = Math.max(0, Math.min(50, Math.floor(timeoutSec)));
    await this.loadOffset();
    const updates = ['message', 'edited_message', 'message_reaction'];
    const url = `${this.base}/getUpdates?timeout=${t}&allowed_updates=${encodeURIComponent(JSON.stringify(updates))}${this.offset ? `&offset=${this.offset}` : ''}`;
    const res = await fetch(url).catch((err: unknown) => {
      this.onPollError?.(`getUpdates network error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    });
    if (!res.ok) {
      // A refused poll (bad token, a second poller, a Telegram outage) comes back at once: throwing lets the caller back off.
      const error = `getUpdates failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`;
      this.onPollError?.(error);
      throw new Error(error);
    }
    type TgMessage = {
      message_id: number;
      date: number;
      edit_date?: number;
      text?: string;
      caption?: string;
      voice?: { file_id: string; duration?: number };
      audio?: { file_id: string; duration?: number };
      photo?: Array<{ file_id: string }>;
      document?: { file_id: string; file_name?: string };
      chat: { id: number };
      from?: { first_name?: string; username?: string };
      reply_to_message?: { message_id: number; text?: string; caption?: string; from?: { first_name?: string; username?: string } };
    };
    type TgReaction = { type: string; emoji?: string };
    const data = (await res.json()) as {
      ok?: boolean;
      result?: Array<{
        update_id: number;
        message?: TgMessage;
        edited_message?: TgMessage;
        message_reaction?: { chat: { id: number }; message_id: number; date: number; old_reaction?: TgReaction[]; new_reaction?: TgReaction[] };
      }>;
    };
    if (!data.ok || !data.result?.length) return [];
    const out: LosslessEvent[] = [];
    const before = this.offset;
    for (const u of data.result) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const r = u.message_reaction;
      if (r && String(r.chat.id) === this.chatId) {
        const ev = this.reactionEvent(r);
        if (ev) out.push(ev);
        continue;
      }
      const m = u.message ?? u.edited_message;
      if (!m || String(m.chat.id) !== this.chatId) continue;
      const edited = !u.message && !!u.edited_message;

      let text = m.text?.trim() || '';
      let isVoice = false;
      if (!text && (m.voice?.file_id || m.audio?.file_id)) {
        isVoice = true;
        text = await this.transcribeVoice((m.voice?.file_id ?? m.audio?.file_id)!);
      } else if (!text) {
        const tag = m.photo ? '[photo]' : m.document ? `[document: ${m.document.file_name || 'file'}]` : '[message]';
        text = m.caption?.trim() ? `${tag} ${m.caption.trim()}` : tag;
      }

      const replyText = m.reply_to_message?.text || m.reply_to_message?.caption;
      const ev = messageEvent({
        // An edit is new owner input about an earlier message, so it gets its own id.
        id: edited ? `tg_${m.message_id}_edit_${m.edit_date ?? u.update_id}` : `tg_${m.message_id}`,
        channel: 'telegram',
        actor: m.from?.first_name || m.from?.username || 'owner',
        text: edited ? `(edited their earlier message) ${text}` : text,
        timestamp: new Date((edited && m.edit_date ? m.edit_date : m.date) * 1000).toISOString(),
        ...(m.reply_to_message ? { replyTo: `tg_${m.reply_to_message.message_id}` } : {}),
        audience: OWNER_TO_RUFUS,
        metadata: {
          messageId: m.message_id,
          chatId: m.chat.id,
          ...(edited ? { editOf: `tg_${m.message_id}` } : {}),
          ...(isVoice ? { voice: true } : {}),
          ...(replyText ? { replyToText: replyText } : {}),
        },
      });
      ev.kind = 'owner_direct';
      out.push(ev);
    }
    if (this.offset !== before) await this.saveOffset().catch(() => undefined);
    return out;
  }

  /** The owner reacting to one of Rufus's messages: feedback on what Rufus said. */
  private reactionEvent(r: { message_id: number; date: number; new_reaction?: Array<{ type: string; emoji?: string }> }): LosslessEvent | undefined {
    const emoji = (r.new_reaction ?? []).map((x) => x.emoji).filter((e): e is string => !!e).join('');
    if (!emoji) return undefined; // a reaction taken back carries nothing new
    const sent = this.sentText(String(r.message_id));
    const sentiment = reactionSentiment(emoji);
    const ev = messageEvent({
      id: `tg_reaction_${r.message_id}_${r.date}`,
      channel: 'telegram',
      actor: 'owner',
      text: `The owner reacted ${emoji} to your message${sent ? `: "${sent.slice(0, 300)}"` : ` (message ${r.message_id})`}`,
      timestamp: new Date(r.date * 1000).toISOString(),
      replyTo: `tg_${r.message_id}`,
      audience: OWNER_TO_RUFUS,
      metadata: { messageId: r.message_id, emoji, sentiment, ...(sent ? { reactedToText: sent } : {}), features: [`reaction:${sentiment}`] },
    });
    ev.kind = 'owner_reaction';
    return ev;
  }
}
