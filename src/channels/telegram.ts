import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LosslessEvent, MessageSink } from '../types';
import { messageEvent } from '../events/ingest';

const execFileAsync = promisify(execFile);

export interface TelegramConfig {
  token: string;
  chatId: string;
  stt?: { command: string; args: string[] };
}

/** Minimal zero-dependency Telegram Bot API channel (lossless text + voice + media poll, send, edit, react). */
export class TelegramChannel implements MessageSink {
  private readonly base: string;
  private readonly fileBase: string;
  private readonly chatId: string;
  private readonly stt?: { command: string; args: string[] };
  private offset = 0;

  constructor(cfg: TelegramConfig) {
    this.base = `https://api.telegram.org/bot${cfg.token}`;
    this.fileBase = `https://api.telegram.org/file/bot${cfg.token}`;
    this.chatId = String(cfg.chatId);
    if (cfg.stt) this.stt = cfg.stt;
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

  async send(text: string): Promise<{ messageId?: string }> {
    const res = await fetch(`${this.base}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage failed (${res.status}): ${await res.text()}`);
    const body = (await res.json().catch(() => ({}))) as { result?: { message_id?: number } };
    return body.result?.message_id !== undefined ? { messageId: String(body.result.message_id) } : {};
  }

  async edit(messageId: string, text: string): Promise<void> {
    const res = await fetch(`${this.base}/editMessageText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, message_id: Number(messageId), text }),
    });
    if (!res.ok) throw new Error(`Telegram editMessageText failed (${res.status}): ${await res.text()}`);
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

  async poll(timeoutSec = 0): Promise<LosslessEvent[]> {
    const t = Math.max(0, Math.min(50, Math.floor(timeoutSec)));
    const url = `${this.base}/getUpdates?timeout=${t}&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}${this.offset ? `&offset=${this.offset}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      ok?: boolean;
      result?: Array<{
        update_id: number;
        message?: {
          message_id: number;
          date: number;
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
      }>;
    };
    if (!data.ok || !data.result?.length) return [];
    const out: LosslessEvent[] = [];
    for (const u of data.result) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const m = u.message;
      if (!m || String(m.chat.id) !== this.chatId) continue;

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
        id: `tg_${m.message_id}`,
        channel: 'telegram',
        actor: m.from?.first_name || m.from?.username || 'owner',
        text,
        timestamp: new Date(m.date * 1000).toISOString(),
        ...(m.reply_to_message ? { replyTo: `tg_${m.reply_to_message.message_id}` } : {}),
        metadata: {
          messageId: m.message_id,
          chatId: m.chat.id,
          ...(isVoice ? { voice: true } : {}),
          ...(replyText ? { replyToText: replyText } : {}),
        },
      });
      ev.kind = 'owner_direct';
      out.push(ev);
    }
    return out;
  }
}
