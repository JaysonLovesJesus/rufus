import type { LosslessEvent, MessageSink } from '../types';
import { messageEvent } from '../events/ingest';

export interface TelegramConfig {
  token: string;
  chatId: string;
}

/** Minimal zero-dependency Telegram Bot API channel (poll + send). */
export class TelegramChannel implements MessageSink {
  private readonly base: string;
  private readonly chatId: string;
  private offset = 0;

  constructor(cfg: TelegramConfig) {
    this.base = `https://api.telegram.org/bot${cfg.token}`;
    this.chatId = String(cfg.chatId);
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

  async poll(): Promise<LosslessEvent[]> {
    const url = `${this.base}/getUpdates?timeout=0&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}${this.offset ? `&offset=${this.offset}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      ok?: boolean;
      result?: Array<{
        update_id: number;
        message?: { message_id: number; date: number; text?: string; chat: { id: number }; from?: { first_name?: string; username?: string } };
      }>;
    };
    if (!data.ok || !data.result?.length) return [];
    const out: LosslessEvent[] = [];
    for (const u of data.result) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const m = u.message;
      if (!m?.text || String(m.chat.id) !== this.chatId) continue;
      const ev = messageEvent({
        id: `tg_${m.message_id}`,
        channel: 'telegram',
        actor: m.from?.first_name || m.from?.username || 'owner',
        text: m.text,
        timestamp: new Date(m.date * 1000).toISOString(),
        metadata: { messageId: m.message_id, chatId: m.chat.id },
      });
      ev.kind = 'owner_direct';
      out.push(ev);
    }
    return out;
  }
}
