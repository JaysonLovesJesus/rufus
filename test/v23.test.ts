import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APK_MIME,
  ChiefOfStaff,
  EXTERNAL_WRITE_TOOLS,
  Engine,
  FakeProvider,
  HUB_HTML,
  HUB_SW,
  MasterLoop,
  ToolRegistry,
  TrustStore,
  UnifiedDaemon,
  VOICE_CALL_HINT,
  appendAudit,
  buildTools,
  chiefActionHandler,
  commandTool,
  createMission,
  gateReason,
  hubSessionValue,
  inboxSensor,
  isExternalWriteTool,
  loadAudit,
  loadChatHistory,
  loadMission,
  queueChiefAction,
  startJarvisHub,
  type AiRequest,
  type CommandRunner,
  type HubBackend,
  type HubDecision,
  type IncomingMessage,
  type JarvisHub,
  type LiveChannel,
  type SpeechAudio,
  type ToolDefinition,
} from '../src';
import { tempDir } from './helpers';

const TOKEN = 'hub-token-0123456789abcdef';
const NOW = new Date(2026, 10, 25, 14, 0);
const MIN = 60_000;
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { 'content-type': 'application/json' };
const sysOf = (req: AiRequest): string => String(req.system ?? '');

// ---------- 1. Voice-Native Speed: the Chief of Staff ----------

function chiefWith(opts: { fast?: (req: AiRequest) => string; voice?: (req: AiRequest) => string; voiceProvider?: string; dir: string }) {
  const main = new FakeProvider(() => 'Main provider answer.');
  const providers: Record<string, FakeProvider> = {};
  if (opts.fast) providers.fast = new FakeProvider(opts.fast);
  if (opts.voice) providers.voice = new FakeProvider(opts.voice);
  const engine = new Engine({ store: opts.dir, provider: main, providers });
  const chief = new ChiefOfStaff({ engine, now: () => NOW, ...(opts.voiceProvider ? { voiceProvider: opts.voiceProvider } : {}) });
  return { chief, main, providers };
}

describe('v23 voice-native speed: spoken turns', () => {
  it('spoken: true appends the voice-call hint to the system prompt; typed chat does not', async () => {
    const { chief, main } = chiefWith({ dir: await tempDir() });
    await chief.handle("what's next?");
    expect(sysOf(main.calls[0]!)).not.toContain('VOICE CALL');
    const r = await chief.reply("what's next?", { spoken: true });
    expect(r.text).toBe('Main provider answer.');
    const sys = sysOf(main.calls[1]!);
    expect(sys).toContain(VOICE_CALL_HINT);
    expect(sys.trimEnd().endsWith(VOICE_CALL_HINT)).toBe(true);
    expect(VOICE_CALL_HINT).toMatch(/1 to 3 short, natural spoken sentences/);
    expect(VOICE_CALL_HINT).toMatch(/No lists.*markdown.*URLs/);
    expect(main.calls[1]!.meta?.step).toBe('voice');
  });

  it('a spoken turn goes to the fast provider when one is configured; typed chat stays on the chat provider', async () => {
    const { chief, main, providers } = chiefWith({ dir: await tempDir(), fast: () => 'Quick: your next block is at three.' });
    const spoken = await chief.handle('when is my next block?', { spoken: true });
    expect(spoken.text).toBe('Quick: your next block is at three.');
    expect(providers.fast!.calls).toHaveLength(1);
    expect(sysOf(providers.fast!.calls[0]!)).toContain(VOICE_CALL_HINT);
    expect(main.calls).toHaveLength(0);

    const typed = await chief.handle('when is my next block?');
    expect(typed.text).toBe('Main provider answer.');
    expect(providers.fast!.calls).toHaveLength(1);
    expect(main.calls).toHaveLength(1);
  });

  it('voice.provider picks a named provider for spoken turns', async () => {
    const { chief, main, providers } = chiefWith({ dir: await tempDir(), fast: () => 'from fast', voice: () => 'from voice', voiceProvider: 'voice' });
    expect((await chief.handle('hey', { spoken: true })).text).toBe('from voice');
    expect(providers.fast!.calls).toHaveLength(0);
    expect(main.calls).toHaveLength(0);
  });

  it('an unknown voice.provider, or none at all, falls back to the chat provider', async () => {
    const a = chiefWith({ dir: await tempDir(), voiceProvider: 'nope' });
    expect((await a.chief.handle('hey', { spoken: true })).text).toBe('Main provider answer.');
    const b = chiefWith({ dir: await tempDir() });
    expect((await b.chief.handle('hey', { spoken: true })).text).toBe('Main provider answer.');
  });

  it('escalates to the chat provider when the fast provider fails', async () => {
    const { chief, main, providers } = chiefWith({
      dir: await tempDir(),
      fast: () => {
        throw new Error('rate limited');
      },
    });
    const r = await chief.handle('quick question', { spoken: true });
    expect(r.text).toBe('Main provider answer.');
    expect(r.unavailable).toBeUndefined();
    expect(providers.fast!.calls).toHaveLength(1);
    expect(main.calls).toHaveLength(1);
    expect(sysOf(main.calls[0]!)).toContain(VOICE_CALL_HINT); // still spoken style
  });

  it('a long or detail-seeking spoken turn is not "simple": it stays on the chat provider', async () => {
    const { chief, main, providers } = chiefWith({ dir: await tempDir(), fast: () => 'fast' });
    await chief.handle('explain in detail how the trust ladder works', { spoken: true });
    await chief.handle(`so ${'and then '.repeat(60)}what`, { spoken: true });
    expect(providers.fast!.calls).toHaveLength(0);
    expect(main.calls).toHaveLength(2);
  });

  it('plain-code commands are unchanged when spoken ($0, no model call)', async () => {
    const { chief, main, providers } = chiefWith({ dir: await tempDir(), fast: () => 'fast' });
    const r = await chief.handle('pause autonomy', { spoken: true });
    expect(r.via).toBe('command');
    expect(main.calls.length + providers.fast!.calls.length).toBe(0);
  });
});

// ---------- 2. Daemon wiring: Hub calls and Telegram voice notes are spoken turns ----------

class Chat implements LiveChannel {
  sent: string[] = [];
  voices: string[] = [];
  inbox: IncomingMessage[] = [];
  private n = 0;
  async send(text: string) {
    this.sent.push(text);
  }
  async sendVoice(audio: Buffer) {
    this.voices.push(audio.toString());
    return 1;
  }
  async poll(since?: string) {
    return this.inbox.filter((m) => !since || !m.at || m.at >= since);
  }
  human(text: string, voice = false) {
    this.n++;
    this.inbox.push({ id: `in_${this.n}`, text, at: new Date(NOW.getTime() + this.n).toISOString(), ...(voice ? { voice: true } : {}) });
  }
}

const fakeTts = (text: string): Promise<SpeechAudio> => Promise.resolve({ audio: Buffer.from(`VOICE:${text}`), mimeType: 'audio/ogg', ext: 'ogg' });

function recordingRunner(calls: Array<{ command: string; input: unknown }>): CommandRunner {
  return async (command, _args, o) => {
    calls.push({ command, input: JSON.parse(o.input ?? '{}') });
    return '{"ok":true}';
  };
}

async function setup(opts: { chief?: (req: AiRequest) => string; fast?: (req: AiRequest) => string; tts?: boolean; channel?: boolean } = {}) {
  const dir = await tempDir();
  const clock = () => NOW;
  const ran: Array<{ command: string; input: unknown }> = [];
  const main = new FakeProvider((req) => (opts.chief ? opts.chief(req) : 'Sure thing.'));
  const fast = opts.fast ? new FakeProvider(opts.fast) : undefined;
  const engine = new Engine({ store: dir, provider: main, ...(fast ? { providers: { fast } } : {}) });
  const tools = new ToolRegistry({
    tools: [commandTool('calendar.write', { command: 'cal' }, recordingRunner(ran)), commandTool('gmail.draft', { command: 'mail' }, recordingRunner(ran)), commandTool('calendar.read', { command: 'calr' }, async () => '[]')],
  });
  const loop = new MasterLoop({ dir, sensors: [inboxSensor(dir)], handlers: [], tools, now: clock });
  const chat = new Chat();
  const daemon = new UnifiedDaemon({
    loop,
    engine,
    ...(opts.channel === false ? { output: () => undefined } : { channel: chat }),
    chief: new ChiefOfStaff({ engine, loop, now: clock }),
    checkinEveryMs: 2 * 60 * MIN,
    bubblePauseMs: 0,
    heartbeat: false,
    calendarSync: false,
    ...(opts.tts ? { voice: { tts: fakeTts } } : {}),
    now: clock,
  });
  return { dir, loop, daemon, chat, main, fast, ran, engine };
}

const hubs: JarvisHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.close()));
});
async function hub(opts: Partial<Parameters<typeof startJarvisHub>[0]> & { backend: HubBackend; dir: string }): Promise<JarvisHub> {
  const h = await startJarvisHub({ token: TOKEN, port: 0, ...opts });
  hubs.push(h);
  return h;
}

describe('v23 daemon: spoken turns reach the Chief of Staff as spoken', () => {
  it('a Hub call (/api/voice) is a spoken turn on the fast provider; /api/chat is typed', async () => {
    const s = await setup({ fast: () => 'Fast spoken answer.', channel: false });
    const h = await hub({ dir: s.dir, backend: s.daemon.hubBackend(), transcribe: async () => 'what is on today' });
    const v = await (await fetch(`${h.url}/api/voice`, { method: 'POST', headers: auth, body: 'x' })).json();
    expect(v).toMatchObject({ ok: true, transcript: 'what is on today', reply: 'Fast spoken answer.' });
    expect(s.fast!.calls).toHaveLength(1);
    expect(sysOf(s.fast!.calls[0]!)).toContain(VOICE_CALL_HINT);
    expect(s.main.calls).toHaveLength(0);

    const c = await (await fetch(`${h.url}/api/chat`, { method: 'POST', headers: { ...auth, ...json }, body: '{"text":"what is on today"}' })).json();
    expect(c).toEqual({ ok: true, reply: 'Sure thing.' });
    expect(s.main.calls).toHaveLength(1);
    expect(sysOf(s.main.calls[0]!)).not.toContain('VOICE CALL');
  });

  it('a Telegram voice note answered by voice is spoken style; typed chat, or voice with no TTS, is not', async () => {
    const s = await setup({ tts: true });
    s.chat.human("what's next today?", true);
    await s.daemon.tick();
    expect(s.chat.voices).toEqual(['VOICE:Sure thing.']);
    expect(sysOf(s.main.calls.at(-1)!)).toContain(VOICE_CALL_HINT);
    s.chat.human('and after that?');
    await s.daemon.tick();
    expect(sysOf(s.main.calls.at(-1)!)).not.toContain('VOICE CALL');

    const quiet = await setup();
    quiet.chat.human('hey', true);
    await quiet.daemon.tick();
    expect(quiet.chat.sent).toEqual(['Sure thing.']);
    expect(sysOf(quiet.main.calls.at(-1)!)).not.toContain('VOICE CALL');
  });

  it('an ambiguous spoken "yes, put it on my calendar" only QUEUES calendar.write: nothing runs', async () => {
    const s = await setup({
      channel: false,
      fast: (req) =>
        req.messages.some((m) => String(m.content).startsWith('TOOL_RESULT')) ? "It's ready for your OK." : 'TOOL_CALL: {"tool":"calendar.write","args":{"title":"Dentist","start":"2026-11-26T09:00"}}',
    });
    const h = await hub({ dir: s.dir, backend: s.daemon.hubBackend(), transcribe: async () => 'yeah do it, put the dentist on my calendar' });
    const v = await (await fetch(`${h.url}/api/voice`, { method: 'POST', headers: auth, body: 'x' })).json();
    expect(v).toMatchObject({ ok: true, queued: ['calendar.write'] });
    expect(s.ran).toEqual([]);
    const pending = await s.loop.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ actionType: 'chief.calendar.write', status: 'awaiting_human_verify' });
    expect(await loadAudit(s.dir)).toEqual([]);
  });
});

// ---------- 3. Hub controls: trust, missions, APK (fake backend) ----------

function fakeBackend(extra: Partial<HubBackend> = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const ok = (message: string): HubDecision => ({ ok: true, message });
  const backend: HubBackend = {
    async chat(text) {
      return { text };
    },
    async state() {
      return { now: NOW.toISOString(), schedule: [], pending: [], chat: [] };
    },
    async decide() {
      return ok('x');
    },
    async pauseTrust(reason) {
      calls.push({ op: 'pause', args: [reason] });
      return ok('paused');
    },
    async resumeTrust() {
      calls.push({ op: 'resume', args: [] });
      return ok('resumed');
    },
    async setTrustMode(action, mode) {
      calls.push({ op: 'mode', args: [action, mode] });
      return ok(`${action} -> ${mode}`);
    },
    async cancelMission(id) {
      calls.push({ op: 'cancel', args: [id] });
      return id === 'm-gone' ? { ok: false, code: 404, message: 'No mission' } : ok(`cancelled ${id}`);
    },
    ...extra,
  };
  return { backend, calls };
}

const post = (h: JarvisHub, p: string, body?: unknown, headers: Record<string, string> = auth) =>
  fetch(`${h.url}${p}`, { method: 'POST', headers: { ...headers, ...json }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

describe('v23 Hub: trust and mission endpoints', () => {
  it('pause (with an optional reason) and resume', async () => {
    const f = fakeBackend();
    const h = await hub({ dir: await tempDir(), backend: f.backend });
    expect(await (await post(h, '/api/trust/pause', { reason: 'vacation' })).json()).toEqual({ ok: true, message: 'paused' });
    expect((await post(h, '/api/trust/pause')).status).toBe(200);
    expect(await (await post(h, '/api/trust/resume')).json()).toEqual({ ok: true, message: 'resumed' });
    expect(f.calls).toEqual([
      { op: 'pause', args: ['vacation'] },
      { op: 'pause', args: [undefined] },
      { op: 'resume', args: [] },
    ]);
  });

  it('mode needs a valid action, a real rung, and {"confirm": true}', async () => {
    const f = fakeBackend();
    const h = await hub({ dir: await tempDir(), backend: f.backend });
    const noConfirm = await post(h, '/api/trust/mode', { action: 'chief.calendar.write', mode: 'autonomous' });
    expect(noConfirm.status).toBe(400);
    expect((await noConfirm.json()).error).toMatch(/confirm/);
    expect((await post(h, '/api/trust/mode', { action: 'chief.calendar.write', mode: 'autonomous', confirm: 'yes' })).status).toBe(400);
    expect((await post(h, '/api/trust/mode', { action: 'chief.calendar.write', mode: 'godmode', confirm: true })).status).toBe(400);
    expect((await post(h, '/api/trust/mode', { action: 'bad action!', mode: 'check', confirm: true })).status).toBe(400);
    expect((await post(h, '/api/trust/mode', { mode: 'check', confirm: true })).status).toBe(400);
    expect(f.calls).toEqual([]);
    const ok = await post(h, '/api/trust/mode', { action: 'chief.calendar.write', mode: 'auto_notify', confirm: true });
    expect(await ok.json()).toEqual({ ok: true, message: 'chief.calendar.write -> auto_notify' });
    expect(f.calls).toEqual([{ op: 'mode', args: ['chief.calendar.write', 'auto_notify'] }]);
  });

  it('missions/cancel needs an id and passes the backend status through', async () => {
    const f = fakeBackend();
    const h = await hub({ dir: await tempDir(), backend: f.backend });
    expect((await post(h, '/api/missions/cancel', {})).status).toBe(400);
    expect(await (await post(h, '/api/missions/cancel', { id: 'm-abc123' })).json()).toEqual({ ok: true, message: 'cancelled m-abc123' });
    expect((await post(h, '/api/missions/cancel', { id: 'm-gone' })).status).toBe(404);
  });

  it('same auth and CSRF guard: 401 without a token, 403 for a cookie POST without x-rufus-hub, 405 for GET', async () => {
    const f = fakeBackend();
    const h = await hub({ dir: await tempDir(), backend: f.backend });
    const cookie = `rufus_hub=${hubSessionValue(TOKEN)}`;
    for (const p of ['/api/trust/pause', '/api/trust/resume', '/api/trust/mode', '/api/missions/cancel']) {
      expect((await post(h, p, {}, {})).status).toBe(401);
      expect((await post(h, p, { action: 'a.b', mode: 'check', confirm: true, id: 'm-1' }, { cookie })).status).toBe(403);
      expect((await fetch(`${h.url}${p}`, { headers: auth })).status).toBe(405);
    }
    expect((await post(h, '/api/trust/pause', {}, { cookie, 'x-rufus-hub': '1' })).status).toBe(200);
    expect(f.calls).toEqual([{ op: 'pause', args: [undefined] }]);
  });

  it('a backend without the controls answers 501', async () => {
    const h = await hub({ dir: await tempDir(), backend: fakeBackend({ pauseTrust: undefined, resumeTrust: undefined, setTrustMode: undefined, cancelMission: undefined }).backend });
    expect((await post(h, '/api/trust/pause')).status).toBe(501);
    expect((await post(h, '/api/trust/resume')).status).toBe(501);
    expect((await post(h, '/api/trust/mode', { action: 'a.b', mode: 'check', confirm: true })).status).toBe(501);
    expect((await post(h, '/api/missions/cancel', { id: 'm-1' })).status).toBe(501);
  });
});

describe('v23 Hub: GET /download/rufus.apk', () => {
  it('401 unauthenticated, 404 when absent, the APK bytes when present (Bearer or cookie)', async () => {
    const dir = await tempDir();
    const h = await hub({ dir, backend: fakeBackend().backend });
    expect((await fetch(`${h.url}/download/rufus.apk`)).status).toBe(401);
    expect((await fetch(`${h.url}/download/rufus.apk`, { headers: { authorization: 'Bearer wrong-token-wrong-token' } })).status).toBe(401);
    expect((await fetch(`${h.url}/download/rufus.apk`, { headers: auth })).status).toBe(404);

    const apk = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
    await writeFile(path.join(dir, 'rufus.apk'), apk);
    expect((await fetch(`${h.url}/download/rufus.apk`)).status).toBe(401);
    const r = await fetch(`${h.url}/download/rufus.apk`, { headers: auth });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe(APK_MIME);
    expect(APK_MIME).toBe('application/vnd.android.package-archive');
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="rufus.apk"/);
    expect(Buffer.from(await r.arrayBuffer()).equals(apk)).toBe(true);

    const viaCookie = await fetch(`${h.url}/download/rufus.apk`, { headers: { cookie: `rufus_hub=${hubSessionValue(TOKEN)}` } });
    expect(viaCookie.status).toBe(200);
    const head = await fetch(`${h.url}/download/rufus.apk`, { method: 'HEAD', headers: auth });
    expect(head.status).toBe(200);
    expect((await fetch(`${h.url}/download/rufus.apk`, { method: 'POST', headers: auth })).status).toBe(405);
  });

  it('a directory named rufus.apk is not served', async () => {
    const dir = await tempDir();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'rufus.apk'));
    const h = await hub({ dir, backend: fakeBackend().backend });
    expect((await fetch(`${h.url}/download/rufus.apk`, { headers: auth })).status).toBe(404);
  });
});

describe('v23 Hub page', () => {
  it('has the five tabs, the kill switch, promote/demote and mission controls, still self-contained', () => {
    for (const label of ['>Call<', '>Chat<', 'Now &amp; Verify', '>Missions<', 'Trust &amp; Audit']) expect(HUB_HTML).toContain(label);
    for (const needle of ['Pause autonomy', 'Resume autonomy', '/api/trust/pause', '/api/trust/resume', '/api/trust/mode', '/api/missions/cancel', 'confirm:true', 'Promote', 'Demote', '/download/rufus.apk', 'Call Rufus', 'MediaRecorder', '/api/verify/'])
      expect(HUB_HTML).toContain(needle);
    expect(HUB_HTML).not.toMatch(/<script[^>]+src=|<link[^>]+href="https?:/);
    expect(HUB_HTML).not.toContain('${');
    expect(HUB_SW).toContain("indexOf('/download/')");
  });
});

// ---------- 4. Hub controls on the real daemon ----------

describe('v23 Hub on the daemon: /api/state and the controls', () => {
  it('GET /api/state returns trust (write tools at check), missions and the last 15 audit entries', async () => {
    const s = await setup({ channel: false });
    const queued = await createMission(s.dir, { goal: 'compare flights to Denver' }, NOW);
    const done = await createMission(s.dir, { goal: 'find a plumber' }, new Date(NOW.getTime() - 3_600_000));
    const { saveMission } = await import('../src');
    await saveMission(s.dir, { ...done, status: 'completed', resultText: 'Two options, both open Friday.', steps: [{ at: NOW.toISOString(), tool: 'web.search', args: {}, ok: true, preview: 'x' }] });
    for (let i = 0; i < 20; i++) await appendAudit(s.dir, { action: 'chief.calendar.write', tool: 'calendar.write', summary: `entry ${i}`, trustMode: 'check', approval: 'human', ok: true }, new Date(NOW.getTime() - (20 - i) * MIN));
    await new TrustStore(s.dir).setMode('chief.gmail.draft', 'auto_notify');

    const h = await hub({ dir: s.dir, backend: s.daemon.hubBackend() });
    const st = await (await fetch(`${h.url}/api/state`, { headers: auth })).json();
    expect(st.trust.paused).toBe(false);
    const byAction = Object.fromEntries(st.trust.actions.map((a: { action: string }) => [a.action, a]));
    expect(byAction['chief.calendar.write']).toEqual({ action: 'chief.calendar.write', mode: 'check', cleanStreak: 0 });
    expect(byAction['chief.gmail.draft']).toMatchObject({ mode: 'auto_notify' });
    expect(byAction['chief.calendar.read']).toBeUndefined(); // read-only tools are not on the ladder
    expect(st.missions).toEqual([
      { id: queued.id, goal: 'compare flights to Denver', status: 'queued', stepsCount: 0 },
      { id: done.id, goal: 'find a plumber', status: 'completed', stepsCount: 1, resultText: 'Two options, both open Friday.' },
    ]);
    expect(st.audit).toHaveLength(15);
    expect(st.audit[0]).toMatchObject({ summary: 'entry 19', action: 'chief.calendar.write', tool: 'calendar.write', approval: 'human', ok: true });
    expect(st.audit[14].summary).toBe('entry 5');
  });

  it('pause / resume flip the real kill switch; mode moves one action on the ladder', async () => {
    const s = await setup({ channel: false });
    const h = await hub({ dir: s.dir, backend: s.daemon.hubBackend() });
    const p = await (await post(h, '/api/trust/pause', { reason: 'testing' })).json();
    expect(p.ok).toBe(true);
    expect(await s.loop.trust.isPaused()).toBe(true);
    let st = await (await fetch(`${h.url}/api/state`, { headers: auth })).json();
    expect(st.trust).toMatchObject({ paused: true, pauseReason: 'testing' });

    const m = await (await post(h, '/api/trust/mode', { action: 'chief.calendar.write', mode: 'auto_notify', confirm: true })).json();
    expect(m.ok).toBe(true);
    expect(m.message).toMatch(/paused, so it still asks/);
    expect((await s.loop.trust.get('chief.calendar.write')).autonomy).toBe('auto_notify');
    expect(await s.loop.trust.mode('chief.calendar.write')).toBe('check'); // the kill switch wins

    expect((await (await post(h, '/api/trust/resume')).json()).message).toMatch(/Resumed/);
    expect(await s.loop.trust.isPaused()).toBe(false);
    expect(await s.loop.trust.mode('chief.calendar.write')).toBe('auto_notify');

    await post(h, '/api/trust/mode', { action: 'chief.calendar.write', mode: 'check', confirm: true });
    expect((await s.loop.trust.get('chief.calendar.write')).autonomy).toBe('check');
    st = await (await fetch(`${h.url}/api/state`, { headers: auth })).json();
    expect(st.trust.paused).toBe(false);
    const history = (await loadChatHistory(s.dir, 20)).map((t) => t.text).join('\n');
    expect(history).toMatch(/Paused/);
    expect(history).toMatch(/back to check/);
  });

  it('missions/cancel cancels a queued mission; a finished one is 409, an unknown one 404', async () => {
    const s = await setup({ channel: false });
    const m = await createMission(s.dir, { goal: 'research standing desks' }, NOW);
    const h = await hub({ dir: s.dir, backend: s.daemon.hubBackend() });
    const r = await post(h, '/api/missions/cancel', { id: m.id });
    expect(r.status).toBe(200);
    expect((await loadMission(s.dir, m.id))!.status).toBe('cancelled');
    expect((await post(h, '/api/missions/cancel', { id: m.id })).status).toBe(409);
    expect((await post(h, '/api/missions/cancel', { id: 'm-ffffff' })).status).toBe(404);
  });
});

// ---------- 5. Calendar / Gmail write tools: Verify-first, audited, earn trust ----------

describe('v23 standard write tools', () => {
  it('calendar.write, gmail.draft and gmail.send are write + external, and config cannot take that away', () => {
    const run: CommandRunner = async () => '';
    for (const name of ['calendar.write', 'gmail.draft', 'gmail.send']) {
      expect(isExternalWriteTool(name)).toBe(true);
      expect(commandTool(name, { command: 'x' }, run)).toMatchObject({ readOnly: false, sensitivity: ['external'] });
      const sneaky = commandTool(name, { command: 'x', readOnly: true, sensitivity: [] }, run);
      expect(sneaky).toMatchObject({ readOnly: false, sensitivity: ['external'] });
      expect(gateReason(sneaky, { stage: 'execute' })).toMatch(/only runs in commit/);
      expect(gateReason(sneaky, { stage: 'commit' })).toMatch(/needs your approval/);
      expect(gateReason(sneaky, { stage: 'commit', approved: true })).toBeUndefined();
    }
    expect(commandTool('calendar.write', { command: 'x', sensitivity: ['money'] }, run).sensitivity).toEqual(['money', 'external']);
    expect(commandTool('gmail.draft', { command: 'x' }, run).reversible).toBe(true);
    expect(commandTool('gmail.send', { command: 'x' }, run).reversible).toBe(false);
    expect(commandTool('calendar.read', { command: 'x' }, run)).toMatchObject({ readOnly: true });
    expect(commandTool('calendar.read', { command: 'x' }, run).sensitivity).toBeUndefined();
    expect(EXTERNAL_WRITE_TOOLS).toEqual(expect.arrayContaining(['calendar.write', 'gmail.draft', 'gmail.send', 'beeper.send', 'beeper.react']));
  });

  it('buildTools registers configured write tools as external', () => {
    const reg = buildTools({ version: 1, tools: { web: false, commands: { 'calendar.write': { command: 'cal' }, 'gmail.send': { command: 'mail', readOnly: true } } } } as never, { env: {} });
    expect(reg.get('calendar.write')).toMatchObject({ readOnly: false, sensitivity: ['external'] });
    expect(reg.get('gmail.send')).toMatchObject({ readOnly: false, sensitivity: ['external'] });
  });

  async function writeLoop() {
    const dir = await tempDir();
    const ran: Array<{ command: string; input: unknown }> = [];
    const tools = new ToolRegistry({ tools: [commandTool('calendar.write', { command: 'cal' }, recordingRunner(ran)), commandTool('gmail.draft', { command: 'mail' }, recordingRunner(ran))] });
    const loop = new MasterLoop({ dir, sensors: [inboxSensor(dir)], handlers: [chiefActionHandler], tools, now: () => NOW });
    return { dir, ran, loop };
  }

  it('calendar.write starts at check: waits for a yes, runs once on accept, and is audited as human-approved', async () => {
    const { dir, ran, loop } = await writeLoop();
    await queueChiefAction(dir, 'calendar.write', { title: 'Dentist', start: '2026-11-26T09:00' }, NOW);
    const tick = await loop.runOnce();
    const run = await loop.getRun(tick.runs[0]!.runId);
    expect(run).toMatchObject({ actionType: 'chief.calendar.write', status: 'awaiting_human_verify', autonomy: 'check' });
    expect(ran).toEqual([]);
    expect(await loadAudit(dir)).toEqual([]);

    const r = await loop.resolveHumanDecision(run.id, { verdict: 'accept' });
    expect(r.run.committed).toBe(true);
    expect(ran).toEqual([{ command: 'cal', input: { title: 'Dentist', start: '2026-11-26T09:00' } }]);
    expect(await loadAudit(dir)).toMatchObject([
      { action: 'chief.calendar.write', tool: 'calendar.write', approval: 'human', trustMode: 'check', ok: true, reversible: true, summary: 'put "Dentist" on the calendar for 2026-11-26T09:00' },
    ]);
    expect((await loop.trust.get('chief.calendar.write')).consecutiveClean).toBe(1);
  });

  it('gmail.draft: a rejection never runs it; an accept drafts and is audited', async () => {
    const { dir, ran, loop } = await writeLoop();
    await queueChiefAction(dir, 'gmail.draft', { to: 'dana@example.com', subject: 'Deck', text: 'Attached.' }, NOW);
    const first = (await loop.runOnce()).runs[0]!.runId;
    await loop.resolveHumanDecision(first, { verdict: 'reject' });
    expect(ran).toEqual([]);
    expect(await loadAudit(dir)).toEqual([]);

    await queueChiefAction(dir, 'gmail.draft', { to: 'dana@example.com', subject: 'Deck', text: 'Attached.' }, new Date(NOW.getTime() + 1000));
    const second = (await loop.runOnce()).runs[0]!.runId;
    await loop.resolveHumanDecision(second, { verdict: 'accept' });
    expect(ran).toHaveLength(1);
    expect((await loadAudit(dir))[0]).toMatchObject({ tool: 'gmail.draft', approval: 'human', summary: 'drafted "Deck" to dana@example.com' });
  });

  it('earned trust: auto_notify runs calendar.write on its own and audits it; the kill switch makes it ask again', async () => {
    const { dir, ran, loop } = await writeLoop();
    await loop.trust.setMode('chief.calendar.write', 'auto_notify');
    await queueChiefAction(dir, 'calendar.write', { title: 'Gym' }, NOW);
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run).toMatchObject({ status: 'completed', committed: true, autoNotified: true });
    expect(run.autoNotice).toMatch(/Just put "Gym" on the calendar/);
    expect(ran).toHaveLength(1);
    expect(await loadAudit(dir)).toMatchObject([{ tool: 'calendar.write', approval: 'auto_notify', trustMode: 'auto_notify', ok: true }]);

    await loop.trust.pause('hub');
    await queueChiefAction(dir, 'calendar.write', { title: 'Lunch' }, new Date(NOW.getTime() + 1000));
    const paused = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(paused.status).toBe('awaiting_human_verify');
    expect(ran).toHaveLength(1);

    await loop.trust.resume();
    await loop.trust.setMode('chief.calendar.write', 'autonomous');
    await queueChiefAction(dir, 'calendar.write', { title: 'Walk' }, new Date(NOW.getTime() + 2000));
    const quiet = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(quiet).toMatchObject({ status: 'completed', committed: true });
    expect(quiet.autoNotified).toBeUndefined();
    expect(ran).toHaveLength(2);
    expect((await loadAudit(dir)).at(-1)).toMatchObject({ approval: 'autonomous', trustMode: 'autonomous' });
  });

  it('a pre-v21 autonomous record (no explicit external promotion) still asks before a calendar write', async () => {
    const { dir, ran, loop } = await writeLoop();
    await loop.trust.promote('chief.calendar.write'); // pre-v21: internal results only
    await queueChiefAction(dir, 'calendar.write', { title: 'Gym' }, NOW);
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run.status).toBe('awaiting_human_verify');
    expect(ran).toEqual([]);
  });

  it('a write tool called outside commit is gated, even when the chief has it', async () => {
    const t: ToolDefinition = commandTool('gmail.send', { command: 'mail' }, async () => '');
    const reg = new ToolRegistry({ tools: [t] });
    await expect(reg.call('gmail.send', { to: 'a@b.c' }, { dir: '/tmp', now: NOW, stage: 'commit' })).rejects.toThrow(/needs your approval/);
    await expect(reg.call('gmail.send', { to: 'a@b.c' }, { dir: '/tmp', now: NOW, stage: 'execute', approved: true })).rejects.toThrow(/only runs in commit/);
  });
});
