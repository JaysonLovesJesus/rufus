import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChiefOfStaff,
  Engine,
  FakeProvider,
  HUB_HTML,
  MasterLoop,
  TelegramChannel,
  ToolRegistry,
  UnifiedDaemon,
  appendSignal,
  audioExt,
  createHubHandler,
  hubSessionValue,
  inboxSensor,
  loadChatHistory,
  messageTriageHandler,
  resolveVoiceReplyMode,
  saveAnchor,
  emptyAnchor,
  shouldSpeakReply,
  startJarvisHub,
  synthesizeSpeech,
  toSpeakableText,
  ttsArgs,
  type AiRequest,
  type HubBackend,
  type IncomingMessage,
  type JarvisHub,
  type LiveChannel,
  type SpeechAudio,
  type ToolDefinition,
  type TtsCommandConfig,
  type UnifiedDaemonOptions,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const NODE = process.execPath;
const TOKEN = 'hub-token-0123456789abcdef';
const NOW = new Date(2026, 10, 25, 14, 0);
const MIN = 60_000;

/** A $0 fake TTS: writes "AUDIO<text>" to {out}. */
const writeTts = (extra: Partial<TtsCommandConfig> = {}): TtsCommandConfig => ({
  command: NODE,
  args: ['-e', 'require("fs").writeFileSync(process.argv[1], "AUDIO<" + process.argv[2] + ">")', '{out}', '{text}'],
  ...extra,
});

// ---------- 1. toSpeakableText ----------

describe('v20 toSpeakableText: text for the ear', () => {
  it('strips markdown emphasis, headings, bullets and quotes', () => {
    expect(toSpeakableText('## Today\n- **Call** the _plumber_\n- `standup` at 9\n> note this')).toBe('Today Call the plumber standup at 9 note this');
  });

  it('speaks a link as its label, and a bare URL as "a link on <host>"', () => {
    expect(toSpeakableText('See [the doc](https://docs.example.com/x?y=1) and https://www.news.example.org/a/b.')).toBe('See the doc and a link on news.example.org.');
  });

  it('drops code blocks and bubble breaks, collapses whitespace', () => {
    expect(toSpeakableText('Here you go:\n```js\nconst x = 1;\n```\n---\nAnything else?')).toBe('Here you go: (code in the chat). Anything else?');
    expect(toSpeakableText('a | b | c')).toBe('a, b, c');
    expect(toSpeakableText('   ')).toBe('');
  });

  it('cuts long text at a sentence', () => {
    const long = 'One short sentence here. '.repeat(20);
    const out = toSpeakableText(long, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('.')).toBe(true);
  });

  it('ttsArgs fills {text} and {out}, also inside a longer arg', () => {
    expect(ttsArgs(['--text', '{text}', '--out={out}'], 'hi', '/tmp/x.ogg')).toEqual(['--text', 'hi', '--out=/tmp/x.ogg']);
  });

  it('reply mode: match by default once tts is set, never without it', () => {
    expect(resolveVoiceReplyMode({})).toBe('never');
    expect(resolveVoiceReplyMode({ tts: writeTts() })).toBe('match');
    expect(resolveVoiceReplyMode({ tts: writeTts(), replyMode: 'always' })).toBe('always');
    expect(shouldSpeakReply('match', true)).toBe(true);
    expect(shouldSpeakReply('match', false)).toBe(false);
    expect(shouldSpeakReply('always', false)).toBe(true);
    expect(shouldSpeakReply('never', true)).toBe(false);
  });
});

// ---------- 2. synthesizeSpeech ----------

describe('v20 synthesizeSpeech: a local command, $0', () => {
  it('runs the command with {text} and {out}, returns the audio and cleaned text', async () => {
    const r = await synthesizeSpeech('**Hi** there, see https://example.com', writeTts());
    expect(r.audio.toString()).toBe('AUDIO<Hi there, see a link on example.com>');
    expect(r).toMatchObject({ mimeType: 'audio/ogg', ext: 'ogg' });
  });

  it('pipes the text on stdin and reads stdout when there is no {text} / {out}', async () => {
    const r = await synthesizeSpeech('Hello _world_', { command: NODE, args: ['-e', 'process.stdin.pipe(process.stdout)'], outputFormat: 'wav' });
    expect(r.audio.toString()).toBe('Hello world');
    expect(r).toMatchObject({ mimeType: 'audio/wav', ext: 'wav' });
  });

  it('reports a failing command with its last stderr line', async () => {
    await expect(synthesizeSpeech('hi', { command: NODE, args: ['-e', 'console.error("voice model missing"); process.exit(3)'] })).rejects.toThrow(/TTS exit 3: voice model missing/);
  });

  it('times out cleanly', async () => {
    await expect(synthesizeSpeech('hi', { command: NODE, args: ['-e', 'setTimeout(() => {}, 20000)'], timeoutMs: 300 })).rejects.toThrow(/timed out/);
  });

  it('a missing command, empty audio and empty text are clear errors', async () => {
    await expect(synthesizeSpeech('hi', { command: 'rufus-no-such-tts-cmd', args: [] })).rejects.toThrow(/not found/);
    await expect(synthesizeSpeech('hi', { command: NODE, args: ['-e', '0', '{out}'] })).rejects.toThrow(/no audio/);
    await expect(synthesizeSpeech('   ', writeTts())).rejects.toThrow(/nothing to say/);
  });

  it('enforces maxChars before speaking', async () => {
    const r = await synthesizeSpeech('First sentence is here. Second sentence is much longer and goes on.', writeTts({ maxChars: 30 }));
    expect(r.audio.toString()).toBe('AUDIO<First sentence is here.>');
  });

  it('rufus say writes the audio file', async () => {
    const dir = await tempDir();
    await import('node:fs/promises').then((fs) => fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, voice: { tts: writeTts() } })));
    const out: string[] = [];
    const file = path.join(dir, 'hello.ogg');
    await main(['--dir', dir, 'say', 'hello', '**there**', '--out', file], { out: (l) => out.push(l), err: (l) => out.push(l) });
    expect((await readFile(file)).toString()).toBe('AUDIO<hello there>');
    expect(out.join('\n')).toMatch(/Wrote 18 bytes \(audio\/ogg\)/);
  });
});

// ---------- 3. Telegram sendVoice ----------

describe('v20 TelegramChannel.sendVoice', () => {
  it('uploads multipart/form-data with chat_id, the voice file and a caption', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
    }) as typeof fetch;
    const ch = new TelegramChannel({ token: '1:T', chatId: '42', fetch: fetchFn });
    const id = await ch.sendVoice(Buffer.from('OGGDATA'), { caption: 'Hi there', filename: 'reply.ogg' });
    expect(id).toBe(77);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.telegram.org/bot1:T/sendVoice');
    const body = seen[0]!.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(seen[0]!.init.headers).toBeUndefined(); // fetch sets the multipart boundary itself
    expect(body.get('chat_id')).toBe('42');
    expect(body.get('caption')).toBe('Hi there');
    const voice = body.get('voice') as File;
    expect(voice.name).toBe('reply.ogg');
    expect(voice.type).toBe('audio/ogg');
    expect(Buffer.from(await voice.arrayBuffer()).toString()).toBe('OGGDATA');
    // The real multipart encoding names the field "voice".
    const encoded = await new Response(body).text();
    expect(encoded).toMatch(/name="voice"; filename="reply.ogg"/);
  });

  it('remembers which polled messages were voice notes', async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/file/')) return new Response('OGG');
      const method = u.slice(u.lastIndexOf('/') + 1);
      const result =
        method === 'getUpdates'
          ? [
              { update_id: 1, message: { message_id: 1, date: 1_800_000_000, chat: { id: 42 }, from: { is_bot: false }, voice: { file_id: 'v' } } },
              { update_id: 2, message: { message_id: 2, date: 1_800_000_000, chat: { id: 42 }, from: { is_bot: false }, text: 'typed' } },
            ]
          : method === 'getFile'
            ? { file_path: 'voice/v.oga' }
            : true;
      return new Response(JSON.stringify({ ok: true, result }));
    }) as typeof fetch;
    const ch = new TelegramChannel({ token: '1:T', chatId: '42', fetch: fetchFn, transcribe: async () => 'spoken words' });
    const got = await ch.poll();
    expect(got.map((m) => m.text)).toEqual(['spoken words', 'typed']);
    expect(ch.isVoiceNote('tg_1')).toBe(true);
    expect(ch.isVoiceNote('tg_2')).toBe(false);
  });
});

// ---------- 4. The daemon: voice-note replies ----------

class VoiceChat implements LiveChannel {
  sent: string[] = [];
  voices: Array<{ audio: string; caption?: string }> = [];
  inbox: IncomingMessage[] = [];
  failVoice = false;
  private n = 0;
  constructor(private readonly clock: () => Date) {}
  async send(text: string) {
    this.sent.push(text);
  }
  async sendVoice(audio: Buffer, opts: { caption?: string } = {}) {
    if (this.failVoice) throw new Error('upload failed');
    this.voices.push({ audio: audio.toString(), ...(opts.caption ? { caption: opts.caption } : {}) });
    return 1;
  }
  async poll(since?: string) {
    return this.inbox.filter((m) => !since || !m.at || m.at >= since);
  }
  human(text: string, voice = false) {
    this.n++;
    this.inbox.push({ id: `in_${this.n}`, text, at: new Date(this.clock().getTime() + this.n).toISOString(), ...(voice ? { voice: true } : {}) });
  }
}

function fakeSend(calls: Array<Record<string, unknown>>): ToolDefinition {
  return {
    name: 'beeper.send',
    description: 'Send a chat message.',
    sensitivity: ['external'],
    async execute(args) {
      calls.push(args);
      return { ok: true };
    },
  };
}

async function setup(opts: { chief?: (req: AiRequest) => string; voice?: UnifiedDaemonOptions['voice']; channel?: boolean } = {}) {
  const dir = await tempDir();
  const t = NOW;
  const clock = () => t;
  const sends: Array<Record<string, unknown>> = [];
  const chat = new VoiceChat(clock);
  const chiefCalls: AiRequest[] = [];
  const engine = new Engine({
    store: dir,
    provider: new FakeProvider((req) => {
      chiefCalls.push(req);
      return opts.chief ? opts.chief(req) : 'Sure thing.';
    }),
  });
  const loopAi = new FakeProvider((req) => (/Triage this/.test(String(req.messages[0]!.content)) ? '{"label":"batch","reason":"a question"}' : '{"reply":"Yes, see you at 7."}'));
  const loop = new MasterLoop({ dir, sensors: [inboxSensor(dir)], handlers: [messageTriageHandler()], tools: new ToolRegistry({ tools: [fakeSend(sends)] }), providers: { fast: loopAi }, now: clock });
  const daemon = new UnifiedDaemon({
    loop,
    engine,
    ...(opts.channel === false ? { output: () => undefined } : { channel: chat }),
    chief: new ChiefOfStaff({ engine, loop, now: clock }),
    checkinEveryMs: 2 * 60 * MIN,
    bubblePauseMs: 0,
    heartbeat: false,
    calendarSync: false,
    ...(opts.voice ? { voice: opts.voice } : {}),
    now: clock,
  });
  let k = 0;
  const incoming = (text: string, actor = 'Robin') =>
    appendSignal(dir, { surface: 'chat', kind: 'message.received', text, actor, urgency: 'urgent', data: { chatId: `c-${actor.toLowerCase()}` } }, new Date(t.getTime() + ++k * 1000));
  return { dir, chat, engine, loop, daemon, sends, chiefCalls, incoming };
}

const fakeTts = (text: string): Promise<SpeechAudio> => Promise.resolve({ audio: Buffer.from(`VOICE:${text}`), mimeType: 'audio/ogg', ext: 'ogg' });

describe('v20 daemon: voice-note replies', () => {
  it('match: a voice note gets a voice note back (text as its caption); typed chat stays text', async () => {
    const s = await setup({ voice: { tts: fakeTts } });
    s.chat.human("what's next today?", true);
    await s.daemon.tick();
    expect(s.chat.voices).toEqual([{ audio: 'VOICE:Sure thing.', caption: 'Sure thing.' }]);
    expect(s.chat.sent).toEqual([]);

    s.chat.human('and after that?');
    await s.daemon.tick();
    expect(s.chat.voices).toHaveLength(1);
    expect(s.chat.sent).toEqual(['Sure thing.']);
  });

  it('a real TTS command works end to end', async () => {
    const s = await setup({ voice: { tts: writeTts() } });
    s.chat.human('hey', true);
    await s.daemon.tick();
    expect(s.chat.voices[0]).toEqual({ audio: 'AUDIO<Sure thing.>', caption: 'Sure thing.' });
  });

  it('falls back to text when speaking or uploading fails', async () => {
    const s = await setup({ voice: { tts: () => Promise.reject(new Error('no model')) } });
    s.chat.human('hey', true);
    await s.daemon.tick();
    expect(s.chat.sent).toEqual(['Sure thing.']);

    const u = await setup({ voice: { tts: fakeTts } });
    u.chat.failVoice = true;
    u.chat.human('hey', true);
    await u.daemon.tick();
    expect(u.chat.sent).toEqual(['Sure thing.']);
  });

  it('never: text even for a voice note; always: voice even for typed chat', async () => {
    const s = await setup({ voice: { tts: fakeTts, replyMode: 'never' } });
    s.chat.human('hey', true);
    await s.daemon.tick();
    expect(s.chat.voices).toEqual([]);
    expect(s.chat.sent).toEqual(['Sure thing.']);

    const a = await setup({ voice: { tts: fakeTts, replyMode: 'always' } });
    a.chat.human('typed');
    await a.daemon.tick();
    expect(a.chat.voices).toHaveLength(1);
  });

  it('loop items are never spoken, even with always; a spoken "yes send it" never sends', async () => {
    const s = await setup({ voice: { tts: fakeTts, replyMode: 'always' } });
    await s.incoming('are we still on for tonight?');
    await s.daemon.tick();
    expect(s.chat.sent.at(-1)).toContain('Robin texted "are we still on for tonight?"');
    expect(s.chat.voices).toEqual([]);
    s.chat.human('yeah sounds good, send it to her', true);
    const r = await s.daemon.tick();
    expect(r.decided).toEqual([]);
    expect(s.sends).toEqual([]);
    expect(await s.loop.pending()).toHaveLength(1);
  });
});

// ---------- 5. The Jarvis Hub ----------

const hubs: JarvisHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.close()));
});

async function hub(opts: Partial<Parameters<typeof startJarvisHub>[0]> & { backend: HubBackend; dir: string }): Promise<JarvisHub> {
  const h = await startJarvisHub({ token: TOKEN, port: 0, ...opts });
  hubs.push(h);
  return h;
}

const auth = { authorization: `Bearer ${TOKEN}` };
const json = { 'content-type': 'application/json' };

function fakeBackend() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const backend: HubBackend = {
    async chat(text, o) {
      calls.push({ op: 'chat', args: [text, o] });
      return { text: `You said: ${text}` };
    },
    async state() {
      return { now: NOW.toISOString(), schedule: [], pending: [{ id: 'run_1', n: 1, stage: 'verify', urgent: false, text: 'Ready to send' }], chat: [] };
    },
    async decide(ref, verdict, note) {
      calls.push({ op: 'decide', args: [ref, verdict, note] });
      return { ok: true, message: `${ref} ${verdict}` };
    },
  };
  return { backend, calls };
}

describe('v20 Jarvis Hub: auth and pages', () => {
  it('refuses to start without a real token', async () => {
    const dir = await tempDir();
    await expect(startJarvisHub({ dir, token: 'short', port: 0, backend: fakeBackend().backend })).rejects.toThrow(/at least 16/);
  });

  it('401 without a token or with a wrong one; 200 with the Bearer token', async () => {
    const dir = await tempDir();
    const h = await hub({ dir, backend: fakeBackend().backend });
    expect((await fetch(`${h.url}/api/health`)).status).toBe(401);
    expect((await fetch(`${h.url}/api/health`, { headers: { authorization: 'Bearer wrong-token-wrong-token' } })).status).toBe(401);
    expect((await fetch(`${h.url}/`)).status).toBe(401);
    expect((await fetch(`${h.url}/?token=nope`, { redirect: 'manual' })).status).toBe(401);
    const ok = await fetch(`${h.url}/api/health`, { headers: auth });
    expect(ok.status).toBe(200);
  });

  it('?token= swaps for an HttpOnly SameSite=Strict cookie, then serves the PWA', async () => {
    const dir = await tempDir();
    const h = await hub({ dir, backend: fakeBackend().backend });
    const r = await fetch(`${h.url}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/');
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^rufus_hub=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toContain(TOKEN); // the raw token never goes in the cookie
    const value = cookie.split(';')[0]!;
    expect(value).toBe(`rufus_hub=${hubSessionValue(TOKEN)}`);
    const page = await fetch(`${h.url}/`, { headers: { cookie: value } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    const html = await page.text();
    expect(html).toBe(HUB_HTML);
    expect(html).toContain('Call Rufus');
    expect(html).toContain('MediaRecorder');
    expect(html).toContain('/api/verify/');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href="https?:/); // no CDN, fully self-contained
    // Cookie GETs work; cookie POSTs also need the x-rufus-hub header.
    expect((await fetch(`${h.url}/api/state`, { headers: { cookie: value } })).status).toBe(200);
    expect((await fetch(`${h.url}/api/chat`, { method: 'POST', headers: { cookie: value, ...json }, body: '{"text":"hi"}' })).status).toBe(403);
    expect((await fetch(`${h.url}/api/chat`, { method: 'POST', headers: { cookie: value, 'x-rufus-hub': '1', ...json }, body: '{"text":"hi"}' })).status).toBe(200);
  });

  it('manifest, icon and service worker are public and data-free', async () => {
    const dir = await tempDir();
    const h = await hub({ dir, backend: fakeBackend().backend });
    const m = await fetch(`${h.url}/manifest.webmanifest`);
    expect(m.status).toBe(200);
    expect(JSON.parse(await m.text())).toMatchObject({ name: 'Rufus', display: 'standalone', start_url: '/' });
    expect((await fetch(`${h.url}/icon.svg`)).status).toBe(200);
    expect(await (await fetch(`${h.url}/sw.js`)).text()).toContain("indexOf('/api/')");
  });

  it('GET /api/health reports voice and pending count', async () => {
    const dir = await tempDir();
    const h = await hub({ dir, backend: fakeBackend().backend, transcribe: async () => 'x', now: () => NOW });
    const body = await (await fetch(`${h.url}/api/health`, { headers: auth })).json();
    expect(body).toEqual({ ok: true, voice: { stt: true, tts: false }, pendingCount: 1, now: NOW.toISOString() });
  });

  it('POST /api/verify/:ref/approve needs {"confirm": true}; reject does not', async () => {
    const dir = await tempDir();
    const f = fakeBackend();
    const h = await hub({ dir, backend: f.backend });
    const noConfirm = await fetch(`${h.url}/api/verify/run_1/approve`, { method: 'POST', headers: auth });
    expect(noConfirm.status).toBe(400);
    expect(f.calls).toEqual([]);
    expect((await fetch(`${h.url}/api/verify/run_1/approve`, { method: 'GET', headers: auth })).status).toBe(405);
    const ok = await fetch(`${h.url}/api/verify/run_1/approve`, { method: 'POST', headers: { ...auth, ...json }, body: '{"confirm":true}' });
    expect(await ok.json()).toEqual({ ok: true, message: 'run_1 accept' });
    await fetch(`${h.url}/api/verify/%232/reject`, { method: 'POST', headers: { ...auth, ...json }, body: '{"note":"not now"}' });
    expect(f.calls).toEqual([
      { op: 'decide', args: ['run_1', 'accept', undefined] },
      { op: 'decide', args: ['#2', 'reject', 'not now'] },
    ]);
  });

  it('POST /signal keeps working exactly like the old webhook (Bearer only, 202, inbox.jsonl)', async () => {
    const dir = await tempDir();
    const h = await hub({ dir, backend: fakeBackend().backend });
    expect((await fetch(`${h.url}/signal`, { method: 'POST', body: '{"kind":"phone.unlocked"}' })).status).toBe(401);
    expect((await fetch(`${h.url}/signal`, { headers: auth })).status).toBe(405);
    expect((await fetch(`${h.url}/signal`, { method: 'POST', headers: auth, body: 'nope' })).status).toBe(400);
    const r = await fetch(`${h.url}/signal`, { method: 'POST', headers: auth, body: '{"kind":"app.opened","text":"Maps"}' });
    expect(r.status).toBe(202);
    expect((await r.json()).ok).toBe(true);
    const inbox = await readFile(path.join(dir, 'inbox.jsonl'), 'utf8');
    expect(inbox).toContain('"kind":"app.opened"');
    expect(inbox).toContain('"surface":"phone"');
  });

  it('a separate signal token is honoured for /signal only', async () => {
    const dir = await tempDir();
    const h = await hub({ dir, backend: fakeBackend().backend, signalToken: 'signal-token-0123456789' });
    expect((await fetch(`${h.url}/signal`, { method: 'POST', headers: auth, body: '{"kind":"phone.unlocked"}' })).status).toBe(401);
    expect((await fetch(`${h.url}/signal`, { method: 'POST', headers: { authorization: 'Bearer signal-token-0123456789' }, body: '{"kind":"phone.unlocked"}' })).status).toBe(202);
  });

  it('createHubHandler mounts on any node:http server; audioExt maps recorder types', () => {
    expect(typeof createHubHandler({ dir: '/tmp', token: TOKEN, backend: fakeBackend().backend })).toBe('function');
    expect(audioExt('audio/webm;codecs=opus')).toBe('.webm');
    expect(audioExt('audio/mp4')).toBe('.m4a');
    expect(audioExt('audio/ogg')).toBe('.ogg');
    expect(audioExt(undefined)).toBe('.webm');
  });

  it('POST /api/voice answers 501 without speech-to-text, 422 on silence', async () => {
    const dir = await tempDir();
    const h = await hub({ dir, backend: fakeBackend().backend });
    expect((await fetch(`${h.url}/api/voice`, { method: 'POST', headers: auth, body: 'x' })).status).toBe(501);
    const h2 = await hub({ dir, backend: fakeBackend().backend, transcribe: async () => '  ' });
    expect((await fetch(`${h2.url}/api/voice`, { method: 'POST', headers: { ...auth, 'content-type': 'audio/webm' }, body: 'x' })).status).toBe(422);
  });
});

describe('v20 Jarvis Hub: live with the real daemon', () => {
  it('GET /api/state shows the Anchor, Verify items and the chat; POST /api/chat talks to the Chief of Staff', async () => {
    const s = await setup({ chief: () => 'You have a focus block next.' });
    const anchor = emptyAnchor(NOW);
    anchor.schedule.blocks.push({ id: 'b1', start: '13:30', end: '15:00', title: 'Deep work', kind: 'focus', status: 'planned' }, { id: 'b2', start: '16:00', end: '16:30', title: 'Walk', kind: 'break', status: 'planned' });
    await saveAnchor(s.dir, anchor);
    await s.incoming('are we still on for tonight?');
    await s.daemon.tick();
    const h = await hub({ dir: s.dir, backend: s.daemon.hubBackend() });

    const chat = await (await fetch(`${h.url}/api/chat`, { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({ text: "what's next?" }) })).json();
    expect(chat).toEqual({ ok: true, reply: 'You have a focus block next.' });

    const state = await (await fetch(`${h.url}/api/state`, { headers: auth })).json();
    expect(state.current).toMatchObject({ title: 'Deep work', start: '13:30' });
    expect(state.next).toMatchObject({ title: 'Walk' });
    expect(state.schedule).toHaveLength(2);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({ n: 1, stage: 'verify', urgent: true });
    expect(state.pending[0].text).toContain('Yes, see you at 7.');
    expect(state.chat.map((t: { text: string }) => t.text)).toEqual(expect.arrayContaining(["what's next?", 'You have a focus block next.']));
    expect(s.sends).toEqual([]);
  });

  it('FULL CALL: audio -> transcribe command -> Chief of Staff -> TTS command -> audio back; never sends', async () => {
    const s = await setup({ chief: () => 'Got it — your next block is **Deep work** at 3pm.' });
    await s.incoming('lunch tomorrow?');
    await s.daemon.tick();
    const h = await hub({
      dir: s.dir,
      backend: s.daemon.hubBackend(),
      // The "audio" bytes are the words; the STT command just reads them back.
      transcribe: { command: NODE, args: ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', '{file}'] },
      tts: writeTts(),
    });
    const r = await fetch(`${h.url}/api/voice`, { method: 'POST', headers: { ...auth, 'content-type': 'audio/webm;codecs=opus' }, body: 'yes send it, approve that one' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.transcript).toBe('yes send it, approve that one');
    expect(body.reply).toBe('Got it — your next block is **Deep work** at 3pm.');
    expect(body.mimeType).toBe('audio/ogg');
    expect(Buffer.from(body.audioBase64, 'base64').toString()).toBe('AUDIO<Got it — your next block is Deep work at 3pm.>');
    // Ambiguous speech is conversation: the Verify item is untouched and nothing was sent.
    expect(s.sends).toEqual([]);
    expect(await s.loop.pending()).toHaveLength(1);
    expect(s.chiefCalls.some((c) => String(c.messages[0]!.content).includes('yes send it, approve that one'))).toBe(true);
    const history = await loadChatHistory(s.dir, 10);
    expect(history.map((t) => t.text)).toContain('yes send it, approve that one');
  });

  it('a voice reply without server TTS returns audioBase64: null (the page uses the browser voice)', async () => {
    const s = await setup();
    const h = await hub({ dir: s.dir, backend: s.daemon.hubBackend(), transcribe: async () => 'hello' });
    const body = await (await fetch(`${h.url}/api/voice`, { method: 'POST', headers: auth, body: 'x' })).json();
    expect(body).toMatchObject({ ok: true, transcript: 'hello', reply: 'Sure thing.', audioBase64: null, mimeType: null });
  });

  it('only the explicit Approve endpoint sends; Reject drops; unknown refs are 404', async () => {
    const s = await setup();
    await s.incoming('are we still on for tonight?', 'Robin');
    await s.incoming('dinner friday?', 'Alex');
    await s.daemon.tick();
    const h = await hub({ dir: s.dir, backend: s.daemon.hubBackend() });
    const state = await (await fetch(`${h.url}/api/state`, { headers: auth })).json();
    expect(state.pending).toHaveLength(2);
    const [robin, alex] = [...state.pending].sort((a: { n: number }, b: { n: number }) => a.n - b.n);

    // Chat that sounds like approval is just chat.
    await fetch(`${h.url}/api/chat`, { method: 'POST', headers: { ...auth, ...json }, body: '{"text":"1"}' });
    await fetch(`${h.url}/api/chat`, { method: 'POST', headers: { ...auth, ...json }, body: '{"text":"yes send"}' });
    expect(s.sends).toEqual([]);

    expect((await fetch(`${h.url}/api/verify/${robin.id}/approve`, { method: 'POST', headers: auth })).status).toBe(400);
    expect(s.sends).toEqual([]);

    const ok = await (await fetch(`${h.url}/api/verify/${robin.id}/approve`, { method: 'POST', headers: { ...auth, ...json }, body: '{"confirm":true}' })).json();
    expect(ok).toMatchObject({ ok: true, committed: true });
    expect(ok.message).toBe(`#${robin.n} approved. Done.`);
    expect(s.sends).toHaveLength(1);
    expect(s.sends[0]).toMatchObject({ text: 'Yes, see you at 7.' });

    const no = await (await fetch(`${h.url}/api/verify/%23${alex.n}/reject`, { method: 'POST', headers: auth })).json();
    expect(no).toMatchObject({ ok: true, message: `#${alex.n} rejected.` });
    expect(s.sends).toHaveLength(1);
    expect(await s.loop.pending()).toEqual([]);

    const gone = await fetch(`${h.url}/api/verify/${robin.id}/approve`, { method: 'POST', headers: { ...auth, ...json }, body: '{"confirm":true}' });
    expect(gone.status).toBe(404);
    expect(s.sends).toHaveLength(1);
  });

  it('a side effect asked for in Hub chat is only queued for Verify', async () => {
    let n = 0;
    const s = await setup({ chief: () => (++n === 1 ? 'TOOL_CALL: {"tool":"beeper.send","args":{"chatId":"c-sam","text":"running late"}}' : 'Ready to send that — approve it under Verify.') });
    const h = await hub({ dir: s.dir, backend: s.daemon.hubBackend() });
    const chat = await (await fetch(`${h.url}/api/chat`, { method: 'POST', headers: { ...auth, ...json }, body: '{"text":"tell sam I am running late"}' })).json();
    expect(chat).toMatchObject({ ok: true, queued: ['beeper.send'] });
    expect(s.sends).toEqual([]);
    const state = await (await fetch(`${h.url}/api/state`, { headers: auth })).json();
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0].stage).toBe('verify');
  });
});
