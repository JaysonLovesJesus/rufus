import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { genericEvent } from './ingest';
import type { LosslessEvent } from '../types';

export interface WebhookOptions {
  port: number;
  /** Defaults to 127.0.0.1, so only this Mac can reach the server unless the owner opts in. */
  host?: string;
  /** When set, required on /voice*, /event and /webhook (Bearer header, `?token=`, or the cookie set by opening /voice?token=). */
  token?: string;
  onEvent: (event: LosslessEvent) => void | Promise<void>;
  /** Optional extra HTTP handler (e.g. Live Voice Call UI on /voice*) sharing the same server & port. */
  extraHandler?: (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => Promise<boolean>;
}

const TOKEN_COOKIE = 'rufus_token';

function isLoopback(addr: string | undefined): boolean {
  return !!addr && (addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.'));
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The token a request carries: `Authorization: Bearer`, `?token=`, or the voice page's cookie. */
function requestToken(req: http.IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const q = url.searchParams.get('token');
  if (q) return q;
  const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${TOKEN_COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(TOKEN_COOKIE.length + 1)) : undefined;
}

/**
 * Who may speak through this server. Anything on /voice* or /event can act on Rufus (voice turns count as the owner),
 * so: with a token configured, every such request must carry it; without one, only this Mac (loopback) is allowed.
 */
export function isAuthorized(req: http.IncomingMessage, url: URL, token: string | undefined): boolean {
  // A browser page from another site must not post turns through the owner's own browser (cross-site request).
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (origin === 'null' || new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  if (!token) return isLoopback(req.socket.remoteAddress);
  const given = requestToken(req, url);
  return !!given && sameSecret(given, token);
}

/** Webhook payloads are third-party input: they can never pose as the owner, Rufus, or Rufus's own internal events. */
const RESERVED_SOURCES = new Set(['message', 'system', 'watch', 'gap', 'self', 'voice']);
const RESERVED_KINDS = new Set(['owner_direct', 'assistant_sent']);
const RESERVED_ACTORS = /^(?:owner|rufus|me)$/i;

export function webhookEventFields(payload: Record<string, unknown>, pathSource: string | undefined): { source: string; kind: string; actor?: string } {
  const claimedSource = String(payload.source || pathSource || 'webhook');
  const claimedKind = String(payload.kind || payload.type || payload.event || 'incoming');
  const source = RESERVED_SOURCES.has(claimedSource.toLowerCase()) ? 'webhook' : claimedSource;
  const kind = RESERVED_KINDS.has(claimedKind.toLowerCase()) ? 'incoming' : claimedKind;
  const actor = typeof payload.actor === 'string' && payload.actor.trim() && !RESERVED_ACTORS.test(payload.actor.trim()) ? payload.actor.trim() : undefined;
  return { source, kind, ...(actor ? { actor } : {}) };
}

/**
 * Tiny zero-dependency HTTP webhook receiver (`POST /event` or `POST /webhook/:source`).
 * Accepts ANY standard JSON webhook payload (Stripe, GitHub, Supabase, Vercel, Shortcuts, etc.)
 * with zero custom format required from the sending app.
 */
export async function startEventWebhook(opts: WebhookOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}`);
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const guarded = pathname.startsWith('/voice') || pathname.startsWith('/event') || pathname.startsWith('/webhook');
    if (guarded && !isAuthorized(req, url, opts.token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: opts.token ? 'unauthorized: send the token (Bearer header, ?token=, or open /voice?token=... once)' : 'unauthorized: only this Mac may connect unless RUFUS_WEBHOOK_TOKEN is set' }));
      return;
    }
    // Opening /voice?token=... once stores the token as a cookie, so the page's own requests (turns, events, audio) carry it.
    if (opts.token && req.method === 'GET' && pathname === '/voice' && url.searchParams.get('token')) {
      res.setHeader('set-cookie', `${TOKEN_COOKIE}=${encodeURIComponent(opts.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
    }
    if (opts.extraHandler) {
      const handled = await opts.extraHandler(req, res, pathname).catch(() => false);
      if (handled) return;
    }
    if (req.method !== 'POST' || (!pathname.startsWith('/event') && !pathname.startsWith('/webhook'))) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= 256 * 1024) chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      let payload: Record<string, unknown> = {};
      try {
        payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        payload = { text: raw };
      }
      const pathParts = pathname.split('/').filter(Boolean);
      const { source, kind, actor } = webhookEventFields(payload, pathParts[0] === 'webhook' ? pathParts[1] : undefined);
      const text =
        typeof payload.text === 'string' && payload.text.trim()
          ? payload.text.trim()
          : `${source} (${kind}): ${JSON.stringify(payload).slice(0, 500)}`;

      const ev = genericEvent({
        source,
        kind,
        text,
        ...(actor ? { actor } : {}),
        metadata: payload,
      });

      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, eventId: ev.id }));
      void Promise.resolve(opts.onEvent(ev)).catch(() => undefined);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    url: `http://${host}:${actualPort}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
