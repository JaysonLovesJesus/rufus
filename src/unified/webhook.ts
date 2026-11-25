import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendSignal } from '../engine/loop-builtins';
import type { LoopSignal } from '../engine/loop';

/**
 * A tiny, token-protected local webhook so a phone automation app (MacroDroid, Tasker, Shortcuts) can push context
 * straight into the Master Loop: `POST /signal` with `Authorization: Bearer <token>` and a JSON body like
 * `{"kind":"phone.unlocked"}` or `{"kind":"app.opened","text":"Maps"}`. Each valid signal is appended to `inbox.jsonl`.
 * Node's built-in `node:http` only; no dependencies. It refuses to start without a token.
 */

export interface SignalWebhookOptions {
  /** The workspace (where `inbox.jsonl` lives). */
  dir: string;
  /** Required. Compared in constant time. */
  token: string;
  /** Default 8787. 0 picks a free port (tests). */
  port?: number;
  /** Default `127.0.0.1`. Use `0.0.0.0` to accept your phone on the same network (keep the token secret). */
  host?: string;
  now?: () => Date;
  /** Called for each signal accepted. */
  onSignal?: (signal: LoopSignal) => void;
}

export interface SignalWebhook {
  server: Server;
  /** `http://host:port`. */
  url: string;
  port: number;
  close(): Promise<void>;
}

export const DEFAULT_WEBHOOK_PORT = 8787;
export const MIN_WEBHOOK_TOKEN_LENGTH = 16;
const MAX_BODY = 16 * 1024;
const KIND = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const SURFACE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

/** A raw POST body -> the signal to append, or an error message. */
export function validateWebhookSignal(raw: unknown): { ok: true; signal: Omit<LoopSignal, 'id'> & { id?: string } } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'body must be a JSON object' };
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const kind = str(r.kind, 64);
  if (!kind || !KIND.test(kind)) return { ok: false, error: 'kind is required: letters, digits and dots, like "phone.unlocked"' };
  const surface = str(r.surface, 32) ?? 'phone';
  if (!SURFACE.test(surface)) return { ok: false, error: 'surface must be letters, digits and dots' };
  if (r.data !== undefined && (typeof r.data !== 'object' || r.data === null || Array.isArray(r.data))) return { ok: false, error: 'data must be a JSON object' };
  if (r.urgency !== undefined && r.urgency !== 'urgent' && r.urgency !== 'normal') return { ok: false, error: 'urgency must be "urgent" or "normal"' };
  const id = str(r.id, 120);
  const text = str(r.text, 2000);
  const actor = str(r.actor, 120);
  return {
    ok: true,
    signal: {
      surface,
      kind,
      ...(id ? { id } : {}),
      ...(text ? { text } : {}),
      ...(actor ? { actor } : {}),
      ...(r.urgency ? { urgency: r.urgency as 'urgent' | 'normal' } : {}),
      ...(r.data ? { data: r.data as Record<string, unknown> } : {}),
    },
  };
}

export function authorized(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const send = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Too large: keep draining (so the 413 reaches the client), but cut off anything absurd.
      if (size > MAX_BODY * 64) req.destroy();
      else if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('body too large'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/** The token rule, checked when a server starts. Returns the trimmed token. */
export function requireWebhookToken(token: string | undefined, what = 'The signal webhook'): string {
  const t = token?.trim() ?? '';
  if (t.length < MIN_WEBHOOK_TOKEN_LENGTH) throw new Error(`${what} needs a token of at least ${MIN_WEBHOOK_TOKEN_LENGTH} characters (config.start.webhook.token or RUFUS_WEBHOOK_TOKEN).`);
  return t;
}

/**
 * Handles one `/signal` request (any method; only an authorized JSON POST is accepted). Shared by the plain webhook and
 * the v20 Jarvis Hub, so both answer exactly the same way.
 */
export async function handleSignalRequest(req: IncomingMessage, res: ServerResponse, opts: { dir: string; token: string; now?: () => Date; onSignal?: (signal: LoopSignal) => void }): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return send(res, 405, { ok: false, error: 'use POST' });
  }
  if (!authorized(req.headers.authorization, opts.token)) return send(res, 401, { ok: false, error: 'unauthorized' });
  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch (err) {
    const status = (err as { status?: number }).status;
    return send(res, status ?? 400, { ok: false, error: status === 413 ? 'body too large' : 'body must be JSON' });
  }
  const v = validateWebhookSignal(raw);
  if (!v.ok) return send(res, 400, { ok: false, error: v.error });
  const signal = await appendSignal(opts.dir, v.signal, (opts.now ?? (() => new Date()))());
  opts.onSignal?.(signal);
  return send(res, 202, { ok: true, id: signal.id });
}

/** Starts the webhook. Resolves once it is listening. */
export async function startSignalWebhook(opts: SignalWebhookOptions): Promise<SignalWebhook> {
  const token = requireWebhookToken(opts.token);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/signal') return send(res, 404, { ok: false, error: 'not found' });
      return await handleSignalRequest(req, res, { dir: opts.dir, token, ...(opts.now ? { now: opts.now } : {}), ...(opts.onSignal ? { onSignal: opts.onSignal } : {}) });
    } catch (err) {
      if (!res.headersSent) send(res, 500, { ok: false, error: (err as Error).message });
    }
  });
  return listen(server, opts.port ?? DEFAULT_WEBHOOK_PORT, opts.host ?? '127.0.0.1');
}

/** Listens and resolves with the bound address. */
export async function listen(server: Server, port: number, host: string): Promise<SignalWebhook> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const shown = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  return {
    server,
    port: addr.port,
    url: `http://${shown}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      }),
  };
}
