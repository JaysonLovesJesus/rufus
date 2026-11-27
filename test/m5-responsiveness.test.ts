import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeProvider, RufusCore, TelegramChannel, ToolRegistry, messageEvent, registerBuiltins, type MessageSink, type Receipt } from '../src';
import { tempDir, topDown } from './helpers';

const NOW = new Date('2026-11-26T14:00:00Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function ownerMessage(text: string, messageId = 42, chatId = 777) {
  const ev = messageEvent({ channel: 'telegram', actor: 'owner', text, timestamp: NOW.toISOString(), metadata: { messageId, chatId } });
  ev.kind = 'owner_direct';
  return ev;
}

describe('Milestone 5: Chat responsiveness (mark read + typing)', () => {
  it('marks the triggering owner message read before the Thinker runs', async () => {
    const dir = await tempDir();
    const log: string[] = [];
    const reasoning = new FakeProvider(
      topDown(() => {
        log.push('thinker');
        return JSON.stringify({ toolId: 'sleep', input: { reason: 'done' } });
      }),
    );
    const sink: MessageSink = {
      send: async () => undefined,
      markRead: async (chatId, messageId) => void log.push(`read:${chatId}:${messageId}`),
    };
    const core = new RufusCore({ workspaceDir: dir, reasoningProvider: reasoning, speakerProvider: new FakeProvider(() => 'ok'), sink, now: () => NOW });

    await core.processEvent(ownerMessage('hey'));
    expect(log).toEqual(['read:777:42', 'thinker']);
    await core.close();
  });

  it('never blocks or fails the wake when markRead hangs or throws', async () => {
    const dir = await tempDir();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reasoning = new FakeProvider(topDown(() => JSON.stringify({ toolId: 'sleep', input: { reason: 'done' } })));
    let calls = 0;
    const sink: MessageSink = {
      send: async () => undefined,
      markRead: (() => {
        calls++;
        if (calls === 1) return new Promise<void>(() => undefined); // hangs forever
        throw new Error('boom'); // throws synchronously
      }) as MessageSink['markRead'],
    };
    const core = new RufusCore({ workspaceDir: dir, reasoningProvider: reasoning, speakerProvider: new FakeProvider(() => 'ok'), sink, now: () => NOW });

    const r1 = await core.processEvent(ownerMessage('first', 1));
    expect(r1.wake?.slept).toBe(true);
    const r2 = await core.processEvent(ownerMessage('second', 2));
    expect(r2.wake?.slept).toBe(true);
    await sleep(0);
    expect(calls).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('markRead failed for message 2: boom'));
    await core.close();
  });

  it('does not mark non-owner (third-party) messages read', async () => {
    const dir = await tempDir();
    const markRead = vi.fn(async () => undefined);
    const reasoning = new FakeProvider(topDown(() => JSON.stringify({ toolId: 'sleep', input: { reason: 'done' } })));
    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: reasoning,
      speakerProvider: new FakeProvider(() => 'ok'),
      sink: { send: async () => undefined, markRead },
      now: () => NOW,
    });
    const ev = messageEvent({ channel: 'whatsapp', actor: 'Sam', text: 'hi', timestamp: NOW.toISOString(), metadata: { messageId: 9 } });
    const res = await core.processEvent(ev);
    expect(res.wake).toBeDefined(); // the wake actually ran, so the owner-only filter is what skipped markRead
    expect(markRead).not.toHaveBeenCalled();
    await core.close();
  });

  async function setupSendMessage(sink: MessageSink, speakerDelayMs: number, speakerFails = false) {
    const dir = await tempDir();
    const reg = new ToolRegistry({ toolsDir: path.join(dir, 'tools') });
    const receipts: Receipt[] = [];
    const speaker = new FakeProvider(async () => {
      await sleep(speakerDelayMs);
      if (speakerFails) throw new Error('speaker down');
      return 'Hello there.';
    });
    await registerBuiltins({
      registry: reg,
      speakerProvider: speaker,
      sink,
      getWakeReceipts: () => receipts,
      onSent: () => undefined,
      onSleep: () => undefined,
      typingRefreshMs: 20,
    });
    return { reg, dir };
  }

  it('sends typing before the Speaker runs, refreshes it, and stops after send', async () => {
    const log: string[] = [];
    const sink: MessageSink = {
      send: async (t) => void log.push(`send:${t}`),
      sendTyping: async () => void log.push('typing'),
    };
    const { reg, dir } = await setupSendMessage(sink, 75);
    const receipt = await reg.call('send_message', { purpose: 'greet' }, { workspaceDir: dir, now: NOW });
    expect(receipt.status).toBe('ok');
    expect(log[0]).toBe('typing');
    const sendIdx = log.findIndex((l) => l.startsWith('send:'));
    expect(sendIdx).toBeGreaterThan(1); // initial + at least one refresh before the send
    expect(log.slice(0, sendIdx).every((l) => l === 'typing')).toBe(true);
    const typingCount = log.filter((l) => l === 'typing').length;
    await sleep(80);
    expect(log.filter((l) => l === 'typing').length).toBe(typingCount); // refresh stopped
  });

  it('stops the typing refresh when the Speaker errors, and typing failures never fail the send', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let typing = 0;
    const failing: MessageSink = {
      send: async () => undefined,
      sendTyping: async () => {
        typing++;
      },
    };
    const { reg, dir } = await setupSendMessage(failing, 30, true);
    const failed = await reg.call('send_message', { purpose: 'greet' }, { workspaceDir: dir, now: NOW });
    expect(failed.status).not.toBe('ok');
    const after = typing;
    await sleep(80);
    expect(typing).toBe(after);

    const sent: string[] = [];
    const brokenTyping: MessageSink = {
      send: async (t) => void sent.push(t),
      sendTyping: async () => {
        throw new Error('network');
      },
    };
    const ok = await setupSendMessage(brokenTyping, 0);
    const receipt = await ok.reg.call('send_message', { purpose: 'greet' }, { workspaceDir: ok.dir, now: NOW });
    expect(receipt.status).toBe('ok');
    expect(sent).toEqual(['Hello there.']);
  });

  it('TelegramChannel.sendTyping posts sendChatAction typing to the configured chat', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true,"result":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const tg = new TelegramChannel({ token: 'T', chatId: '555' });
    await tg.sendTyping();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botT/sendChatAction');
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: '555', action: 'typing' });
  });
});
