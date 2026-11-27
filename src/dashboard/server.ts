import { watch as fsWatch, promises as fs, type FSWatcher } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardData } from './data';

/**
 * The local Rufus dashboard: a read-only window into the workspace, served on 127.0.0.1 only.
 * - Static page from `public/` (no build step, no external requests).
 * - JSON: /api/snapshot, /api/wake/:id, /api/timeline?hours=24.
 * - Server-Sent Events on /api/stream whenever a watched workspace file changes (fs.watch plus a 1 s mtime poll),
 *   including senses.json (sense health).
 * It never writes to the workspace.
 */

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const WATCHED = ['live.json', 'gaps.json', 'watches.json', 'approvals.json', 'wakes.jsonl', 'decisions.jsonl', 'events.jsonl', 'trust.json', 'permissions.json', 'senses.json', 'credits.json', 'config.json'];
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface DashboardOptions {
  workspaceDir: string;
  port?: number;
  host?: string;
  /** Daemon HTTP port for its /health check. */
  daemonPort?: number;
  /** Poll interval for the mtime fallback (ms). */
  pollMs?: number;
  /** Override the daemon health check (tests). */
  healthCheck?: () => Promise<boolean>;
}

export interface DashboardServer {
  url: string;
  port: number;
  data: DashboardData;
  close: () => Promise<void>;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export async function startDashboard(opts: DashboardOptions): Promise<DashboardServer> {
  const host = opts.host ?? '127.0.0.1';
  if (!isLoopback(host)) throw new Error(`The dashboard only binds to 127.0.0.1 (the data is private); got ${host}.`);
  const port = opts.port ?? 4747;
  const data = new DashboardData({
    workspaceDir: opts.workspaceDir,
    ...(opts.daemonPort ? { daemonPort: opts.daemonPort } : {}),
    ...(opts.healthCheck ? { healthCheck: opts.healthCheck } : {}),
  });

  // ---- change detection: fs.watch on the workspace dir, plus a 1 s mtime poll fallback ----
  const clients = new Set<http.ServerResponse>();
  let rev = 0;
  let pending = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;
  const stamps = new Map<string, string>();

  const broadcast = () => {
    flushTimer = undefined;
    if (!pending.size) return;
    rev++;
    const payload = `event: change\ndata: ${JSON.stringify({ rev, files: [...pending] })}\n\n`;
    pending = new Set();
    for (const res of clients) res.write(payload);
  };
  const changed = (file: string) => {
    pending.add(file);
    flushTimer ??= setTimeout(broadcast, 120);
  };

  const stampOf = async (file: string) => {
    try {
      const s = await fs.stat(path.join(opts.workspaceDir, file));
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return 'missing';
    }
  };
  for (const f of WATCHED) stamps.set(f, await stampOf(f));
  const poll = async () => {
    for (const f of WATCHED) {
      const s = await stampOf(f);
      if (stamps.get(f) !== s) {
        stamps.set(f, s);
        changed(f);
      }
    }
  };
  const pollTimer = setInterval(() => void poll().catch(() => undefined), opts.pollMs ?? 1000);
  pollTimer.unref?.();
  let watcher: FSWatcher | undefined;
  try {
    watcher = fsWatch(opts.workspaceDir, { persistent: false }, (_type, name) => {
      const f = name ? String(name) : '';
      if (WATCHED.includes(f)) void stampOf(f).then((s) => {
        if (stamps.get(f) !== s) {
          stamps.set(f, s);
          changed(f);
        }
      });
    });
    watcher.on('error', () => undefined);
  } catch {
    watcher = undefined; // the poll still covers it
  }
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(`: keepalive\n\n`);
  }, 15_000);
  heartbeat.unref?.();

  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      // Only answer requests addressed to this machine by name (blocks DNS-rebinding pages from reading private data).
      const hostHeader = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!isLoopback(hostHeader)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET' });
        res.end();
        return;
      }
      const url = new URL(req.url || '/', `http://${host}`);
      const p = url.pathname;

      if (p === '/api/snapshot') return sendJson(res, 200, await data.snapshot());
      if (p === '/api/timeline') return sendJson(res, 200, await data.timeline(Number(url.searchParams.get('hours') ?? 24)));
      if (p.startsWith('/api/wake/')) {
        const id = decodeURIComponent(p.slice('/api/wake/'.length));
        if (!/^[\w.-]{1,80}$/.test(id)) return sendJson(res, 400, { error: 'bad wake id' });
        const w = await data.wake(id);
        return w ? sendJson(res, 200, w) : sendJson(res, 404, { error: 'wake not found' });
      }
      if (p === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
        res.write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ rev })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Static files
      const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await fs.readFile(file).catch(() => undefined);
      if (!body) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    url: `http://${host === '::1' ? '[::1]' : host}:${actualPort}`,
    port: actualPort,
    data,
    close: async () => {
      clearInterval(pollTimer);
      clearInterval(heartbeat);
      if (flushTimer) clearTimeout(flushTimer);
      watcher?.close();
      for (const res of clients) res.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
