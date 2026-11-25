import { access, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CardBridge,
  Engine,
  TelegramApiError,
  TelegramChannel,
  TelegramOfflineError,
  commandTranscriber,
  defineFlow,
  transcribeArgs,
  resolveTelegramOptions,
  selectChannel,
  type HumanCard,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const TOKEN = '123456:TEST-TOKEN';
const CHAT = '4242';
const opts = { token: TOKEN, chatId: CHAT };

type Call = { method: string; params: any };
/**
 * A fake Bot API. `handlers` answer by method name; unlisted methods return `{ ok: true, result: true }`.
 * `files` serves downloads from `/file/bot<token>/<path>` (recorded as method `file:<path>`); unknown paths 404.
 */
function fakeTelegram(handlers: Record<string, (params: any) => unknown> = {}, files: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    const filePrefix = `https://api.telegram.org/file/bot${TOKEN}/`;
    if (u.startsWith(filePrefix)) {
      const filePath = u.slice(filePrefix.length);
      calls.push({ method: `file:${filePath}`, params: {} });
      const body = files[filePath];
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
    }
    expect(u.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    const method = u.slice(u.lastIndexOf('/') + 1);
    const params = init.body ? JSON.parse(init.body as string) : {};
    calls.push({ method, params });
    const result = handlers[method]?.(params) ?? true;
    if (result instanceof Response) return result;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls, of: (m: string) => calls.filter((c) => c.method === m) };
}

const msg = (update_id: number, text: string, extra: Record<string, unknown> = {}) => ({
  update_id,
  message: { message_id: update_id, date: 1_800_000_000, text, chat: { id: Number(CHAT) }, from: { id: 7, is_bot: false }, ...extra },
});

describe('TelegramChannel.send', () => {
  it('posts sendMessage to the configured chat and returns the message id', async () => {
    const t = fakeTelegram({ sendMessage: () => ({ message_id: 99 }) });
    const ch = new TelegramChannel({ ...opts, fetch: t.fn });
    expect(await ch.send('hello')).toBe('99');
    expect(t.calls).toEqual([{ method: 'sendMessage', params: { chat_id: CHAT, text: 'hello' } }]);
  });

  it('splits text longer than Telegram allows, in order, without losing any', async () => {
    const t = fakeTelegram({ sendMessage: () => ({ message_id: 1 }) });
    const long = Array.from({ length: 900 }, (_, i) => `line ${i} of the long report`).join('\n');
    await new TelegramChannel({ ...opts, fetch: t.fn }).send(long);
    const parts = t.of('sendMessage').map((c) => c.params.text as string);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('\n').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
  });

  it('sendCard adds one tap-to-answer button per option, carrying the card ref', async () => {
    const t = fakeTelegram();
    const card = { id: 'c_1234abcd', options: [{ id: 'a', label: 'Send' }, { id: 'b', label: 'Discard' }] } as HumanCard;
    await new TelegramChannel({ ...opts, fetch: t.fn }).sendCard(card, 'YOUR TURN');
    expect(t.calls[0]!.params.reply_markup.inline_keyboard).toEqual([
      [{ text: '1) Send', callback_data: 'c_1234abcd 1' }],
      [{ text: '2) Discard', callback_data: 'c_1234abcd 2' }],
    ]);
  });
});

describe('TelegramChannel.poll', () => {
  it('advances the offset so an update is never delivered twice', async () => {
    const batches = [[msg(10, 'one'), msg(11, 'two')], [msg(12, 'three')], []];
    const t = fakeTelegram({ getUpdates: () => batches.shift() });
    const ch = new TelegramChannel({ ...opts, fetch: t.fn });
    expect((await ch.poll()).map((m) => m.text)).toEqual(['one', 'two']);
    expect((await ch.poll()).map((m) => m.text)).toEqual(['three']);
    expect(await ch.poll()).toEqual([]);
    expect(t.of('getUpdates').map((c) => c.params.offset)).toEqual([undefined, 12, 13]);
  });

  it('saves the offset to disk, so a restart picks up where it stopped', async () => {
    const stateFile = path.join(await tempDir(), 'telegram-state.json');
    const first = fakeTelegram({ getUpdates: () => [msg(40, 'hi')] });
    await new TelegramChannel({ ...opts, stateFile, fetch: first.fn }).poll();
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({ offset: 41 });

    const second = fakeTelegram({ getUpdates: () => [] });
    await new TelegramChannel({ ...opts, stateFile, fetch: second.fn }).poll();
    expect(second.calls[0]!.params.offset).toBe(41);
  });

  it('starts fresh when the saved state is unreadable', async () => {
    const stateFile = path.join(await tempDir(), 'telegram-state.json');
    await writeFile(stateFile, '{not json');
    const t = fakeTelegram({ getUpdates: () => [] });
    await expect(new TelegramChannel({ ...opts, stateFile, fetch: t.fn }).poll()).resolves.toEqual([]);
    expect(t.calls[0]!.params.offset).toBeUndefined();
  });

  it('only reads the configured chat: strangers, groups and bots are ignored (but still confirmed)', async () => {
    const t = fakeTelegram({
      getUpdates: () => [
        msg(1, 'from a stranger', { chat: { id: 999 } }),
        msg(2, 'from a bot', { from: { id: 8, is_bot: true } }),
        msg(3, 'a photo with no text', { text: undefined }),
        { update_id: 4, edited_message: { text: 'edited' } },
        msg(5, 'mine'),
      ],
    });
    const ch = new TelegramChannel({ ...opts, fetch: t.fn });
    const got = await ch.poll();
    expect(got).toEqual([{ id: 'tg_5', text: 'mine', at: new Date(1_800_000_000_000).toISOString() }]);
    await ch.poll();
    expect(t.of('getUpdates')[1]!.params.offset).toBe(6); // strangers' updates are not re-delivered
  });

  it('matches a negative group chat id given as a string', async () => {
    const t = fakeTelegram({ getUpdates: () => [msg(1, 'in group', { chat: { id: -100123 } })] });
    expect(await new TelegramChannel({ token: TOKEN, chatId: '-100123', fetch: t.fn }).poll()).toHaveLength(1);
  });

  it('skips messages older than `since` (backlog from before the bridge started)', async () => {
    const t = fakeTelegram({ getUpdates: () => [msg(1, 'old', { date: 1_000 }), msg(2, 'new', { date: 2_000 })] });
    const got = await new TelegramChannel({ ...opts, fetch: t.fn }).poll(new Date(1_500_000).toISOString());
    expect(got.map((m) => m.text)).toEqual(['new']);
  });

  it('turns a button tap from the right chat into a "<ref> <n>" reply and stops the spinner', async () => {
    const tap = (id: number, chat: number) => ({
      update_id: id,
      callback_query: { id: `cb${id}`, data: 'c_1234abcd 2', from: { id: 7 }, message: { message_id: 1, chat: { id: chat } } },
    });
    const t = fakeTelegram({ getUpdates: () => [tap(1, Number(CHAT)), tap(2, 999)] });
    const got = await new TelegramChannel({ ...opts, fetch: t.fn }).poll();
    expect(got).toEqual([{ id: 'tg_1', text: 'c_1234abcd 2' }]);
    await vi.waitFor(() => expect(t.of('answerCallbackQuery').map((c) => c.params.callback_query_id)).toContain('cb1'));
  });
});

describe('TelegramChannel voice notes', () => {
  const voice = (update_id: number, file_id = `voice-${update_id}`, extra: Record<string, unknown> = {}) =>
    msg(update_id, '', { text: undefined, voice: { file_id, duration: 3, mime_type: 'audio/ogg' }, ...extra });
  const withFile = { getFile: (p: any) => ({ file_id: p.file_id, file_path: `voice/${p.file_id}.oga` }) };
  const exists = (p: string) => access(p).then(() => true, () => false);

  it('downloads the voice note, hands the file to `transcribe`, and delivers the transcript like a text', async () => {
    const t = fakeTelegram({ getUpdates: () => [msg(1, 'first'), voice(2), msg(3, 'last')], ...withFile }, { 'voice/voice-2.oga': 'OGG-BYTES' });
    const seen: { path: string; body: string }[] = [];
    const transcribe = async (file: string) => {
      seen.push({ path: file, body: await readFile(file, 'utf8') });
      return '  remind me to call the plumber tomorrow \n';
    };
    const got = await new TelegramChannel({ ...opts, fetch: t.fn, transcribe }).poll();
    expect(got).toEqual([
      { id: 'tg_1', text: 'first', at: new Date(1_800_000_000_000).toISOString() },
      { id: 'tg_2', text: 'remind me to call the plumber tomorrow', at: new Date(1_800_000_000_000).toISOString() },
      { id: 'tg_3', text: 'last', at: new Date(1_800_000_000_000).toISOString() },
    ]);
    expect(t.of('getFile').map((c) => c.params)).toEqual([{ file_id: 'voice-2' }]);
    expect(t.of('file:voice/voice-2.oga')).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe('OGG-BYTES');
    expect(path.relative(os.tmpdir(), seen[0]!.path)).toMatch(/^rufus-voice-/);
    expect(path.extname(seen[0]!.path)).toBe('.oga');
    expect(await exists(seen[0]!.path)).toBe(false); // temp file cleaned up
    expect(t.of('sendMessage')).toEqual([]);
  });

  it('handles audio files the same way', async () => {
    const t = fakeTelegram(
      { getUpdates: () => [msg(4, '', { text: undefined, audio: { file_id: 'aud', mime_type: 'audio/mpeg' } })], getFile: () => ({ file_path: 'music/a.mp3' }) },
      { 'music/a.mp3': 'MP3' },
    );
    const got = await new TelegramChannel({ ...opts, fetch: t.fn, transcribe: async () => 'an audio memo' }).poll();
    expect(got.map((m) => m.text)).toEqual(['an audio memo']);
  });

  it('skips voice notes quietly when `transcribe` is not configured', async () => {
    const t = fakeTelegram({ getUpdates: () => [voice(1), msg(2, 'text still works')] });
    const ch = new TelegramChannel({ ...opts, fetch: t.fn });
    expect((await ch.poll()).map((m) => m.text)).toEqual(['text still works']);
    expect(t.of('getFile')).toEqual([]);
    expect(t.of('sendMessage')).toEqual([]);
    await ch.poll();
    expect(t.of('getUpdates')[1]!.params.offset).toBe(3); // still confirmed, never re-delivered
  });

  it('cleans up the temp file and keeps polling when `transcribe` fails, with a short note to the chat', async () => {
    const t = fakeTelegram({ getUpdates: () => [voice(1), msg(2, 'after')], ...withFile }, { 'voice/voice-1.oga': 'OGG' });
    let tempPath = '';
    const transcribe = async (file: string) => {
      tempPath = file;
      throw new Error('model missing');
    };
    const got = await new TelegramChannel({ ...opts, fetch: t.fn, transcribe }).poll();
    expect(got.map((m) => m.text)).toEqual(['after']);
    expect(tempPath).not.toBe('');
    expect(await exists(tempPath)).toBe(false);
    expect(await exists(path.dirname(tempPath))).toBe(false);
    const notes = t.of('sendMessage').map((c) => c.params.text as string);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/Couldn't transcribe that voice note \(model missing\)/);
  });

  it('treats an empty transcript as a failure instead of delivering a blank message', async () => {
    const t = fakeTelegram({ getUpdates: () => [voice(1)], ...withFile }, { 'voice/voice-1.oga': 'OGG' });
    const got = await new TelegramChannel({ ...opts, fetch: t.fn, transcribe: async () => '   ' }).poll();
    expect(got).toEqual([]);
    expect(t.of('sendMessage')[0]!.params.text).toMatch(/no speech found/);
  });

  it('survives a failed download (no temp file, no crash) and never leaks the token', async () => {
    const t = fakeTelegram({ getUpdates: () => [voice(1)], ...withFile }); // file not served: 404
    const transcribe = vi.fn(async () => 'never');
    const got = await new TelegramChannel({ ...opts, fetch: t.fn, transcribe }).poll();
    expect(got).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
    const note = t.of('sendMessage')[0]!.params.text as string;
    expect(note).toMatch(/file download failed/);
    expect(note).not.toContain(TOKEN);
  });

  it('survives getFile failing, even when the error note cannot be sent', async () => {
    const t = fakeTelegram({
      getUpdates: () => [voice(1), msg(2, 'ok')],
      getFile: () => new Response(JSON.stringify({ ok: false, description: 'file is too big' }), { status: 400 }),
      sendMessage: () => new Response(JSON.stringify({ ok: false }), { status: 500 }),
    });
    const got = await new TelegramChannel({ ...opts, fetch: t.fn, transcribe: async () => 'never' }).poll();
    expect(got.map((m) => m.text)).toEqual(['ok']);
  });

  it('does not download voice notes older than `since`', async () => {
    const t = fakeTelegram({ getUpdates: () => [voice(1, 'old', { date: 1_000 })], ...withFile });
    const got = await new TelegramChannel({ ...opts, fetch: t.fn, transcribe: async () => 'x' }).poll(new Date(1_500_000).toISOString());
    expect(got).toEqual([]);
    expect(t.of('getFile')).toEqual([]);
  });

  it('ignores voice notes from other chats and bots without downloading them', async () => {
    const t = fakeTelegram({ getUpdates: () => [voice(1, 'a', { chat: { id: 999 } }), voice(2, 'b', { from: { id: 8, is_bot: true } })], ...withFile });
    expect(await new TelegramChannel({ ...opts, fetch: t.fn, transcribe: async () => 'x' }).poll()).toEqual([]);
    expect(t.of('getFile')).toEqual([]);
  });

  it('runs a configured command: "{file}" is replaced with the audio path, stdout is the transcript', async () => {
    const t = fakeTelegram({ getUpdates: () => [voice(1)], ...withFile }, { 'voice/voice-1.oga': 'hello from the file' });
    const script = "const fs=require('fs');process.stdout.write('\\n'+process.argv[2]+':'+fs.readFileSync(process.argv[1],'utf8')+'\\n')";
    const transcribe = { command: process.execPath, args: ['-e', script, '{file}', 'TAG'] };
    const got = await new TelegramChannel({ ...opts, fetch: t.fn, transcribe }).poll();
    expect(got.map((m) => m.text)).toEqual(['TAG:hello from the file']);
  });
});

describe('commandTranscriber', () => {
  it('appends the file path as the last arg when "{file}" is absent', () => {
    expect(transcribeArgs(['--fast'], '/tmp/a.ogg')).toEqual(['--fast', '/tmp/a.ogg']);
    expect(transcribeArgs(undefined, '/tmp/a.ogg')).toEqual(['/tmp/a.ogg']);
    expect(transcribeArgs(['-f', '{file}', '-q'], '/tmp/a.ogg')).toEqual(['-f', '/tmp/a.ogg', '-q']);
  });

  it('runs without a shell and returns trimmed stdout', async () => {
    const run = commandTranscriber({ command: process.execPath, args: ['-e', "process.stdout.write('  ' + process.argv[1] + '  ')"] });
    expect(await run('/tmp/x y; rm -rf.ogg')).toBe('/tmp/x y; rm -rf.ogg');
  });

  it('rejects with a short reason when the command fails or times out', async () => {
    await expect(commandTranscriber({ command: process.execPath, args: ['-e', "console.error('boom'); process.exit(3)"] })('/f')).rejects.toThrow(/exit 3: boom/);
    await expect(commandTranscriber({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 100 })('/f')).rejects.toThrow(/timed out/);
    await expect(commandTranscriber({ command: '/no/such/transcriber' })('/f')).rejects.toThrow();
  });
});

describe('TelegramChannel errors', () => {
  const offline = (async () => {
    throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getUpdates`);
  }) as typeof fetch;

  it('reports offline as a typed error that never contains the token', async () => {
    const ch = new TelegramChannel({ ...opts, fetch: offline });
    const err = await ch.send('x').catch((e) => e);
    expect(err).toBeInstanceOf(TelegramOfflineError);
    expect(err.message).not.toContain(TOKEN);
    await expect(ch.poll()).rejects.toBeInstanceOf(TelegramOfflineError);
    expect(await ch.status()).toEqual({ online: false, reason: expect.stringContaining('not reachable') });
  });

  it('turns API failures into TelegramApiError with a useful hint', async () => {
    const bad = (status: number, description: string) =>
      new TelegramChannel({
        ...opts,
        fetch: (async () => new Response(JSON.stringify({ ok: false, description }), { status })) as typeof fetch,
      });
    const unauthorized = await bad(401, 'Unauthorized').send('x').catch((e) => e);
    expect(unauthorized).toBeInstanceOf(TelegramApiError);
    expect(unauthorized.message).toContain('RUFUS_TELEGRAM_TOKEN');
    await expect(bad(409, 'Conflict').poll()).rejects.toThrow(/another process/);
    await expect(bad(400, 'Bad Request: chat not found').send('x')).rejects.toThrow(/chat not found/);
  });

  it('does not advance the offset when polling fails', async () => {
    let fail = true;
    const t = fakeTelegram({
      getUpdates: () => (fail ? new Response('{"ok":false}', { status: 502 }) : [msg(5, 'later')]),
    });
    const ch = new TelegramChannel({ ...opts, fetch: t.fn });
    await expect(ch.poll()).rejects.toBeInstanceOf(TelegramApiError);
    fail = false;
    expect((await ch.poll()).map((m) => m.text)).toEqual(['later']);
    expect(t.of('getUpdates').every((c) => c.params.offset === undefined)).toBe(true);
  });

  it('keeps CardBridge alive while Telegram is down, then delivers once it is back', async () => {
    const flow = defineFlow({ id: 'ask', name: 'ask', description: 'ask' }, async (ctx) => {
      const a = await ctx.human('ok', { title: 'Send it?', summary: 'Draft ready.', options: ['yes', 'no'] });
      return a.choice;
    });
    const engine = new Engine({ store: await tempDir(), flows: [flow] });
    await engine.start('ask');
    let down = true;
    const t = fakeTelegram();
    const flaky = (async (...a: Parameters<typeof fetch>) => {
      if (down) throw new TypeError('offline');
      return t.fn(...a);
    }) as typeof fetch;
    const bridge = new CardBridge({ engine, channel: new TelegramChannel({ ...opts, fetch: flaky }), chief: false });

    const first = await bridge.tick();
    expect(first.error).toMatch(/not reachable/);
    expect(first.delivered).toEqual([]);
    down = false;
    const second = await bridge.tick();
    expect(second.error).toBeUndefined();
    expect(second.delivered).toHaveLength(1);
    // The card went out as a card: buttons for each option.
    expect(t.of('sendMessage')[0]!.params.reply_markup.inline_keyboard).toHaveLength(2);
  });

  it('answers a card from a tapped button end to end through CardBridge', async () => {
    const flow = defineFlow({ id: 'ask', name: 'ask', description: 'ask' }, async (ctx) => {
      const a = await ctx.human('ok', { title: 'Send it?', summary: 'Draft ready.', options: ['yes', 'no'] });
      return a.choice;
    });
    const engine = new Engine({ store: await tempDir(), flows: [flow] });
    const started = (await engine.start('ask')) as { runId: string; card: HumanCard };
    let updates: unknown[] = [];
    const t = fakeTelegram({ getUpdates: () => updates });
    const bridge = new CardBridge({ engine, channel: new TelegramChannel({ ...opts, fetch: t.fn }), chief: false });
    await bridge.tick(); // sends the card
    updates = [{ update_id: 1, callback_query: { id: 'cb', data: `${started.card.id} 2`, message: { chat: { id: Number(CHAT) } } } }];
    const r = await bridge.tick();
    expect(r.answered).toEqual([started.card.id]);
    expect((await engine.store.getRun(started.runId)).output).toBe('no');
  });
});

describe('Telegram config', () => {
  it('reads config.json, with env vars winning and chatId allowed as a number', () => {
    expect(resolveTelegramOptions({ token: 'file-token', chatId: 4242 }, {})).toEqual({ token: 'file-token', chatId: '4242' });
    expect(resolveTelegramOptions({ token: 'file-token', chatId: 4242 }, { RUFUS_TELEGRAM_TOKEN: 'env-token', RUFUS_TELEGRAM_CHAT_ID: '-1' })).toEqual({
      token: 'env-token',
      chatId: '-1',
    });
  });

  it('passes a configured transcribe command through, and ignores one without a command', () => {
    const transcribe = { command: 'node', args: ['/opt/stt.mjs', '{file}'], timeoutMs: 60_000 };
    expect(resolveTelegramOptions({ token: 't', chatId: 1, transcribe }, {})).toEqual({ token: 't', chatId: '1', transcribe });
    expect(resolveTelegramOptions({ token: 't', chatId: 1, transcribe: { command: '' } }, {})).toEqual({ token: 't', chatId: '1' });
  });

  it('says exactly what is missing', () => {
    expect(() => resolveTelegramOptions({}, {})).toThrow(/RUFUS_TELEGRAM_TOKEN and RUFUS_TELEGRAM_CHAT_ID/);
    expect(() => resolveTelegramOptions({ token: 't' }, {})).toThrow(/RUFUS_TELEGRAM_CHAT_ID/);
  });
});

describe('selectChannel and `rufus bridge --channel`', () => {
  const cfg = { version: 1 as const };
  const base = { workspaceDir: '/tmp/ws' };

  it('auto-detects Telegram from env or config, Beeper from config or env', () => {
    const env = { RUFUS_TELEGRAM_TOKEN: 't', RUFUS_TELEGRAM_CHAT_ID: '1' };
    expect(selectChannel(cfg, { ...base, env }).name).toBe('telegram');
    expect(selectChannel({ ...cfg, telegram: { token: 't', chatId: 1 } }, { ...base, env: {} }).name).toBe('telegram');
    expect(selectChannel({ ...cfg, beeper: { token: 't', chatId: 'c' } }, { ...base, env: {} }).name).toBe('beeper');
    expect(selectChannel(cfg, { ...base, env: { RUFUS_BEEPER_TOKEN: 't', RUFUS_BEEPER_CHAT_ID: 'c' } }).name).toBe('beeper');
  });

  it('asks you to choose when both are set up, and an explicit --channel always wins', () => {
    const both = { ...cfg, telegram: { token: 't', chatId: 1 }, beeper: { token: 't', chatId: 'c' } };
    expect(() => selectChannel(both, { ...base, env: {} })).toThrow(/Both telegram and beeper.*--channel/);
    expect(selectChannel(both, { ...base, env: {}, channel: 'beeper' }).name).toBe('beeper');
    expect(selectChannel(both, { ...base, env: {}, channel: 'telegram' }).name).toBe('telegram');
    expect(() => selectChannel(both, { ...base, env: {}, channel: 'sms' })).toThrow(/Unknown --channel "sms"/);
  });

  it('with nothing configured, keeps the Beeper setup error', () => {
    expect(() => selectChannel(cfg, { ...base, env: {} })).toThrow(/Beeper is not configured/);
  });

  describe('CLI wiring', () => {
    afterEach(() => vi.unstubAllGlobals());
    const capture = () => {
      const lines: string[] = [];
      return { lines, io: { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) } };
    };

    it('`bridge --once --channel telegram` texts the pending card and saves its offset in the workspace', async () => {
      const dir = await tempDir();
      await main(['--dir', dir, 'demo'], capture().io); // leaves one card waiting
      await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, telegram: { token: TOKEN, chatId: CHAT } }));
      const t = fakeTelegram({ getUpdates: () => [msg(77, 'chatter from a stranger', { chat: { id: 999 } })] });
      vi.stubGlobal('fetch', t.fn);

      const out = capture();
      await main(['--dir', dir, 'bridge', '--once', '--channel', 'telegram'], out.io);

      expect(out.lines.some((l) => l.startsWith('sent card c_'))).toBe(true);
      const sent = t.of('sendMessage');
      expect(sent[0]!.params.chat_id).toBe(CHAT);
      expect(sent[0]!.params.text).toContain('YOUR TURN');
      expect(sent[0]!.params.reply_markup.inline_keyboard.length).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(path.join(dir, 'telegram-state.json'), 'utf8'))).toMatchObject({ offset: 78 });
    });

    it('auto-detects Telegram from config.telegram when --channel is omitted', async () => {
      const dir = await tempDir();
      await main(['--dir', dir, 'demo'], capture().io);
      await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, telegram: { token: TOKEN, chatId: CHAT } }));
      const t = fakeTelegram();
      vi.stubGlobal('fetch', t.fn);
      await main(['--dir', dir, 'bridge', '--once'], capture().io);
      expect(t.of('sendMessage')).toHaveLength(1);
    });

    it('rejects an unknown --channel and asks for a value', async () => {
      const dir = await tempDir();
      await expect(main(['--dir', dir, 'bridge', '--once', '--channel', 'sms'], capture().io)).rejects.toThrow(/Unknown --channel/);
      await expect(main(['--dir', dir, 'bridge', '--channel'], capture().io)).rejects.toThrow(/--channel needs a value/);
    });

    it('an offline Telegram does not crash `bridge --once`: it reports and sets a failing exit code', async () => {
      const dir = await tempDir();
      await main(['--dir', dir, 'demo'], capture().io);
      await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, telegram: { token: TOKEN, chatId: CHAT } }));
      vi.stubGlobal('fetch', (async () => { throw new TypeError('offline'); }) as typeof fetch);
      const out = capture();
      const prior = process.exitCode;
      await main(['--dir', dir, 'bridge', '--once', '--channel', 'telegram'], out.io);
      expect(out.lines.join('\n')).toMatch(/Channel problem.*not reachable/);
      expect(out.lines.join('\n')).not.toContain(TOKEN);
      process.exitCode = prior;
    });
  });
});


