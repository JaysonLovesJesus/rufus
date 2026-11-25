import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { commandTranscriber, type Transcriber } from '../channels/transcribe';
import { commandSynthesizer, type Synthesizer } from '../channels/voice';
import type { ChatTurn } from '../chief/history';
import type { LoopSignal } from '../engine/loop';
import { isTrustMode, TRUST_MODES, type TrustMode } from '../engine/trust';
import type { TranscribeCommand, TtsCommandConfig } from '../types';
import { HUB_HTML, HUB_ICON, HUB_MANIFEST, HUB_SW } from './hub-page';
import { authorized, DEFAULT_WEBHOOK_PORT, handleSignalRequest, listen, requireWebhookToken, type SignalWebhook } from './webhook';

/**
 * v20: the Ambient Jarvis Hub. One small `node:http` server (no dependencies) that serves:
 *
 *   - `GET /`: a self-contained phone/desktop web app (chat, a hands-free "Call Rufus" voice call, Now & Verify);
 *   - `GET /api/health`, `GET /api/state`, `POST /api/chat`, `POST /api/voice` (audio in: transcript, reply, spoken audio);
 *   - `POST /api/verify/:ref/approve|reject`: the ONLY way the Hub resolves a Verify item, and approve also needs
 *     `{"confirm": true}`. Chat and voice go to the Chief of Staff, which can only queue side effects, never run them;
 *   - `POST /signal`: the phone webhook, byte-for-byte the same as `startSignalWebhook`.
 *
 * v23 adds the controls: `POST /api/trust/pause|resume` (the kill switch), `POST /api/trust/mode` (one action's rung,
 * with `{"confirm": true}`), `POST /api/missions/cancel`, and `GET /download/rufus.apk` (an optional native launcher
 * placed at `<workspace>/rufus.apk`). `GET /api/state` also returns `trust`, `missions` and the last `audit` entries.
 *
 * Auth: `Authorization: Bearer <token>`, or open `/?token=<token>` once, which sets an HttpOnly, SameSite=Strict session
 * cookie. Cookie-authenticated POSTs must also carry `x-rufus-hub: 1`, so another web page cannot post on your behalf.
 */

/** What the Hub needs from the running daemon (`UnifiedDaemon.hubBackend()`), or a fake in tests. */
export interface HubBackend {
  /** One chat turn with the Chief of Staff (it may queue side effects as Verify items; it never runs them). */
  chat(text: string, opts?: { voice?: boolean }): Promise<HubChatReply>;
  /** The live board. */
  state(): Promise<HubState>;
  /** Resolves one Verify item by run id or short number. Only these two verdicts exist here. */
  decide(ref: string, verdict: 'accept' | 'reject', note?: string): Promise<HubDecision>;
  /** v23: the kill switch. Unset: the endpoint answers 501. */
  pauseTrust?(reason?: string): Promise<HubDecision>;
  resumeTrust?(): Promise<HubDecision>;
  /** v23: puts one action on one rung (the Hub already checked `confirm: true`). */
  setTrustMode?(action: string, mode: TrustMode): Promise<HubDecision>;
  /** v23: cancels a queued or running background mission. */
  cancelMission?(id: string): Promise<HubDecision>;
}

export interface HubChatReply {
  /** What to show (bubbles joined). Empty when nothing needed saying. */
  text: string;
  bubbles?: string[];
  /** Side-effect tools queued for approval (they show up under Verify). */
  queued?: string[];
}

export interface HubBlock {
  start: string;
  end: string;
  title: string;
  kind: string;
  status: string;
}

export interface HubItem {
  /** The loop run id (what `/api/verify/:ref/...` takes, as does `#n`). */
  id: string;
  n?: number;
  /** `verify`, `plan` or `execute` (a to-do: approve means done). */
  stage: 'verify' | 'plan' | 'execute';
  urgent: boolean;
  text: string;
}

/** v23: one action on the Earned Trust ladder, as the Hub shows it. */
export interface HubTrustAction {
  action: string;
  /** Its own rung (`blocked`, `check`, `auto_notify`, `autonomous`); while paused everything but `blocked` acts as `check`. */
  mode: TrustMode;
  cleanStreak: number;
  promotionSuggested?: boolean;
}

export interface HubTrust {
  /** The kill switch is on: nothing runs on its own. */
  paused: boolean;
  pauseReason?: string;
  actions: HubTrustAction[];
}

export interface HubMission {
  id: string;
  goal: string;
  status: string;
  stepsCount: number;
  resultText?: string;
}

export interface HubAuditEntry {
  id: string;
  at: string;
  action: string;
  tool?: string;
  summary: string;
  approval: string;
  trustMode: string;
  ok: boolean;
  error?: string;
}

export interface HubState {
  now: string;
  current?: HubBlock;
  next?: HubBlock;
  schedule: HubBlock[];
  pending: HubItem[];
  chat: ChatTurn[];
  /** v23: the kill switch and every action's rung. */
  trust?: HubTrust;
  /** v23: active and recent background missions, newest first. */
  missions?: HubMission[];
  /** v23: the last audit entries (newest first). */
  audit?: HubAuditEntry[];
}

export interface HubDecision {
  ok: boolean;
  /** HTTP status to answer with when not ok (404 unknown item, 409 conflict...). */
  code?: number;
  message: string;
  status?: string;
  committed?: boolean;
}

export interface JarvisHubOptions {
  /** The workspace (for `/signal`). */
  dir: string;
  /** Required, 16+ characters. */
  token: string;
  backend: HubBackend;
  /** Token for `POST /signal`. Default: `token`. */
  signalToken?: string;
  /** Default 8787 (the webhook's port: the Hub replaces it and keeps `/signal`). 0 picks a free port. */
  port?: number;
  /** Default `127.0.0.1`. Put it behind `tailscale serve` for HTTPS on your phone (the mic needs HTTPS). */
  host?: string;
  /** Speech-to-text for `/api/voice`. Unset: the call answers 501 and the page says so. */
  transcribe?: TranscribeCommand | Transcriber;
  /** Text-to-speech for replies. Unset: the page speaks with the browser's own voice. */
  tts?: TtsCommandConfig | Synthesizer;
  /** Largest voice upload. Default 15 MB. */
  maxAudioBytes?: number;
  now?: () => Date;
  onSignal?: (signal: LoopSignal) => void;
}

export type JarvisHub = SignalWebhook;

export const HUB_COOKIE = 'rufus_hub';
/** v23: the optional Android launcher, served from `<workspace>/rufus.apk` at `/download/rufus.apk`. */
export const HUB_APK_FILE = 'rufus.apk';
export const APK_MIME = 'application/vnd.android.package-archive';
const MAX_APK_BYTES = 200 * 1024 * 1024;
const MAX_JSON = 32 * 1024;
const DEFAULT_MAX_AUDIO = 15 * 1024 * 1024;
const MAX_CHAT_CHARS = 4000;
const COOKIE_DAYS = 30;

const sendJson = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const sendText = (res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': type, ...extra });
  res.end(body);
};
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The cookie value for a token: an HMAC, so the raw token never sits in the browser's cookie jar. */
export function hubSessionValue(token: string): string {
  return createHmac('sha256', token).update('rufus-hub-session-v1').digest('base64url');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

type Auth = 'bearer' | 'cookie' | undefined;

function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max * 4) req.destroy();
      else if (size <= max) chunks.push(c);
    });
    req.on('end', () => (size > max ? reject(Object.assign(new Error('body too large'), { status: 413 })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readRaw(req, MAX_JSON)).toString('utf8').trim();
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('body must be JSON'), { status: 400 });
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error('body must be a JSON object'), { status: 400 });
  return v as Record<string, unknown>;
}

/** `audio/webm;codecs=opus` -> `.webm`. */
export function audioExt(contentType: string | undefined): string {
  const t = (contentType ?? '').toLowerCase();
  if (t.includes('webm')) return '.webm';
  if (t.includes('ogg') || t.includes('opus')) return '.ogg';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return '.m4a';
  if (t.includes('wav')) return '.wav';
  if (t.includes('mpeg') || t.includes('mp3')) return '.mp3';
  return '.webm';
}

/**
 * The Hub's request handler, for mounting on any `node:http` server. `startJarvisHub` wraps it in its own server.
 */
export function createHubHandler(opts: JarvisHubOptions): RequestListener {
  const token = requireWebhookToken(opts.token, 'The Jarvis Hub');
  const signalToken = opts.signalToken?.trim() || token;
  const session = hubSessionValue(token);
  const transcriber: Transcriber | undefined = typeof opts.transcribe === 'function' ? opts.transcribe : opts.transcribe?.command ? commandTranscriber(opts.transcribe) : undefined;
  const synth: Synthesizer | undefined = opts.tts && (typeof opts.tts === 'function' || opts.tts.command) ? commandSynthesizer(opts.tts) : undefined;
  const maxAudio = opts.maxAudioBytes ?? DEFAULT_MAX_AUDIO;
  const now = opts.now ?? (() => new Date());

  const authOf = (req: IncomingMessage): Auth => {
    if (req.headers.authorization) return authorized(req.headers.authorization, token) ? 'bearer' : undefined;
    const c = cookieOf(req, HUB_COOKIE);
    return c && same(c, session) ? 'cookie' : undefined;
  };

  const cookieHeader = (req: IncomingMessage): string => {
    const secure = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https' ? '; Secure' : '';
    return `${HUB_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_DAYS * 86_400}${secure}`;
  };

  const voice = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!transcriber) return sendJson(res, 501, { ok: false, error: 'Speech-to-text is not configured (voice.stt or telegram.transcribe).' });
    const audio = await readRaw(req, maxAudio);
    if (!audio.length) return sendJson(res, 400, { ok: false, error: 'send the recorded audio as the request body' });
    let dir: string | undefined;
    let transcript: string;
    try {
      dir = await mkdtemp(path.join(os.tmpdir(), 'rufus-hub-'));
      const file = path.join(dir, `call${audioExt(req.headers['content-type'])}`);
      await writeFile(file, audio);
      transcript = (await transcriber(file)).trim();
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: `Couldn't transcribe that (${message(err).slice(0, 200)}).` });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!transcript) return sendJson(res, 422, { ok: false, error: 'No speech found.', transcript: '' });
    // Voice is conversation, always: it goes to the Chief of Staff, never to a Verify item.
    const reply = await opts.backend.chat(transcript, { voice: true });
    let spoken: { audioBase64: string; mimeType: string } | undefined;
    let ttsError: string | undefined;
    if (synth && reply.text.trim()) {
      try {
        const a = await synth(reply.text);
        spoken = { audioBase64: a.audio.toString('base64'), mimeType: a.mimeType };
      } catch (err) {
        ttsError = message(err).slice(0, 200);
      }
    }
    return sendJson(res, 200, {
      ok: true,
      transcript,
      reply: reply.text,
      ...(reply.bubbles ? { bubbles: reply.bubbles } : {}),
      ...(reply.queued?.length ? { queued: reply.queued } : {}),
      audioBase64: spoken?.audioBase64 ?? null,
      mimeType: spoken?.mimeType ?? null,
      ...(ttsError ? { ttsError } : {}),
    });
  };

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';

      // The phone webhook, exactly as before (its own Bearer token, never the cookie).
      if (url.pathname === '/signal') return await handleSignalRequest(req, res, { dir: opts.dir, token: signalToken, now, ...(opts.onSignal ? { onSignal: opts.onSignal } : {}) });

      // Static, data-free assets (the browser fetches the manifest without cookies).
      if (method === 'GET' && p === '/manifest.webmanifest') return sendText(res, 200, 'application/manifest+json', HUB_MANIFEST);
      if (method === 'GET' && p === '/icon.svg') return sendText(res, 200, 'image/svg+xml', HUB_ICON, { 'cache-control': 'max-age=86400' });
      if (method === 'GET' && p === '/sw.js') return sendText(res, 200, 'text/javascript; charset=utf-8', HUB_SW, { 'cache-control': 'no-cache' });

      if (p === '/') {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'use GET' });
        const q = url.searchParams.get('token');
        if (q !== null) {
          if (!same(q.trim(), token)) return sendText(res, 401, 'text/plain; charset=utf-8', 'Wrong hub token.');
          // Swap the token in the address for a session cookie, and drop it from the URL (and history).
          return sendText(res, 303, 'text/plain; charset=utf-8', 'Signed in.', { location: '/', 'set-cookie': cookieHeader(req), 'cache-control': 'no-store' });
        }
        if (!authOf(req)) return sendText(res, 401, 'text/html; charset=utf-8', '<!doctype html><meta name="viewport" content="width=device-width"><body style="background:#0b0d12;color:#e8ebf2;font-family:system-ui;padding:40px">This Hub needs its key: open it once with <b>?token=&lt;your hub token&gt;</b>.</body>');
        return sendText(res, 200, 'text/html; charset=utf-8', HUB_HTML, { 'cache-control': 'no-cache', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      }

      // v23: the optional native launcher, behind the same auth (a GET: no CSRF header needed).
      if (p === '/download/rufus.apk') {
        if (!authOf(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'use GET' });
        const file = path.join(opts.dir, HUB_APK_FILE);
        const info = await stat(file).catch(() => undefined);
        if (!info?.isFile() || info.size > MAX_APK_BYTES) return sendJson(res, 404, { ok: false, error: `No Android app here: put it at ${HUB_APK_FILE} in the workspace.` });
        const bytes = await readFile(file);
        res.writeHead(200, { 'content-type': APK_MIME, 'content-length': String(bytes.length), 'content-disposition': 'attachment; filename="rufus.apk"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return void res.end(method === 'HEAD' ? undefined : bytes);
      }

      if (!p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'not found' });
      const auth = authOf(req);
      if (!auth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      if (method !== 'GET' && auth === 'cookie' && req.headers['x-rufus-hub'] !== '1') return sendJson(res, 403, { ok: false, error: 'missing x-rufus-hub header' });

      if (p === '/api/health') {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'use GET' });
        const s = await opts.backend.state();
        return sendJson(res, 200, { ok: true, voice: { stt: !!transcriber, tts: !!synth }, pendingCount: s.pending.length, now: now().toISOString() });
      }
      if (p === '/api/state') {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'use GET' });
        const s = await opts.backend.state();
        return sendJson(res, 200, { ok: true, voice: { stt: !!transcriber, tts: !!synth }, ...s });
      }
      if (p === '/api/chat') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use POST' });
        const body = await readJson(req);
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_CHAT_CHARS) : '';
        if (!text) return sendJson(res, 400, { ok: false, error: 'text is required' });
        const reply = await opts.backend.chat(text);
        return sendJson(res, 200, { ok: true, reply: reply.text, ...(reply.bubbles ? { bubbles: reply.bubbles } : {}), ...(reply.queued?.length ? { queued: reply.queued } : {}) });
      }
      if (p === '/api/voice') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use POST' });
        return await voice(req, res);
      }
      if (p === '/api/trust/pause' || p === '/api/trust/resume' || p === '/api/trust/mode' || p === '/api/missions/cancel') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use POST' });
        const body = await readJson(req);
        const b = opts.backend;
        const answer = (d: HubDecision): void => sendJson(res, d.ok ? 200 : (d.code ?? 400), { ...d, ok: d.ok });
        const unsupported = (): void => sendJson(res, 501, { ok: false, error: 'not available on this Rufus' });
        if (p === '/api/trust/pause') {
          if (!b.pauseTrust) return unsupported();
          const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : undefined;
          return answer(await b.pauseTrust(reason));
        }
        if (p === '/api/trust/resume') {
          if (!b.resumeTrust) return unsupported();
          return answer(await b.resumeTrust());
        }
        if (p === '/api/trust/mode') {
          if (!b.setTrustMode) return unsupported();
          const action = typeof body.action === 'string' ? body.action.trim() : '';
          if (!/^[a-z0-9][a-z0-9_.:-]*$/i.test(action)) return sendJson(res, 400, { ok: false, error: 'action is required (e.g. chief.calendar.write)' });
          if (!isTrustMode(body.mode)) return sendJson(res, 400, { ok: false, error: `mode must be one of ${TRUST_MODES.join(', ')}` });
          // Changing how much Rufus may do on its own must be said in so many words, like approving a Verify item.
          if (body.confirm !== true) return sendJson(res, 400, { ok: false, error: 'To change a trust level, send {"confirm": true}.' });
          return answer(await b.setTrustMode(action, body.mode));
        }
        if (!b.cancelMission) return unsupported();
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) return sendJson(res, 400, { ok: false, error: 'id is required' });
        return answer(await b.cancelMission(id.slice(0, 40)));
      }
      const verify = /^\/api\/verify\/([^/]+)\/(approve|reject)$/.exec(p);
      if (verify) {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use POST' });
        const body = await readJson(req);
        const approve = verify[2] === 'approve';
        // Approving is the one thing that can let a side effect run: it must say so, in so many words.
        if (approve && body.confirm !== true) return sendJson(res, 400, { ok: false, error: 'To approve, send {"confirm": true}.' });
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : undefined;
        const d = await opts.backend.decide(decodeURIComponent(verify[1]!), approve ? 'accept' : 'reject', note);
        return sendJson(res, d.ok ? 200 : (d.code ?? 400), { ...d, ok: d.ok });
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (!res.headersSent) sendJson(res, status ?? 500, { ok: false, error: message(err) });
    }
  };
}

/** Starts the Hub on its own server (it also answers `/signal`). Resolves once it is listening. */
export async function startJarvisHub(opts: JarvisHubOptions): Promise<JarvisHub> {
  const server = createServer(createHubHandler(opts));
  return listen(server, opts.port ?? DEFAULT_WEBHOOK_PORT, opts.host ?? '127.0.0.1');
}
