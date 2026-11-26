import http from 'node:http';
import { genericEvent } from './ingest';
import type { LosslessEvent } from '../types';

export interface WebhookOptions {
  port: number;
  host?: string;
  token?: string;
  onEvent: (event: LosslessEvent) => void | Promise<void>;
  /** Optional extra HTTP handler (e.g. Live Voice Call UI on /voice*) sharing the same server & port. */
  extraHandler?: (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => Promise<boolean>;
}

/**
 * Tiny zero-dependency HTTP webhook receiver (`POST /event` or `POST /webhook/:source`).
 * Accepts ANY standard JSON webhook payload (Stripe, GitHub, Supabase, Vercel, Shortcuts, etc.)
 * with zero custom format required from the sending app.
 */
export async function startEventWebhook(opts: WebhookOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', `http://${host}`).pathname;
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
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
    if (opts.token) {
      const auth = req.headers.authorization ?? '';
      const qToken = new URL(req.url, `http://${host}`).searchParams.get('token');
      if (auth !== `Bearer ${opts.token}` && qToken !== opts.token) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
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
      const pathParts = new URL(req.url!, `http://${host}`).pathname.split('/').filter(Boolean);
      const source = String(payload.source || (pathParts[0] === 'webhook' && pathParts[1]) || 'webhook');
      const kind = String(payload.kind || payload.type || payload.event || 'incoming');
      const text =
        typeof payload.text === 'string' && payload.text.trim()
          ? payload.text.trim()
          : `${source} (${kind}): ${JSON.stringify(payload).slice(0, 500)}`;

      const ev = genericEvent({
        source,
        kind,
        text,
        ...(typeof payload.actor === 'string' ? { actor: payload.actor } : {}),
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
