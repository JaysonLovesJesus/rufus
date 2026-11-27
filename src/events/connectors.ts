import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { LosslessEvent } from '../types';
import { genericEvent, messageEvent } from './ingest';
import { watchConnector } from './watches';

const execFileAsync = promisify(execFile);

/** Any pluggable data input feeding the single continuous heartbeat -> Lossless Event Store -> SetFit Bouncer. */
export interface EventConnector {
  readonly id: string;
  readonly intervalMs: number;
  poll(): Promise<LosslessEvent[]>;
}

/**
 * Runs all registered data connectors inside ONE continuous heartbeat.
 * Each connector polls at its own natural cadence; only brand-new events are returned for the Bouncer.
 */
export class HeartbeatHub {
  private readonly connectors: EventConnector[] = [];
  private readonly lastPoll = new Map<string, number>();

  add(connector: EventConnector): void {
    this.connectors.push(connector);
  }

  list(): readonly EventConnector[] {
    return this.connectors;
  }

  /** Polls every connector whose interval has elapsed and returns all freshly sensed events. */
  async tick(nowMs = Date.now()): Promise<{ events: LosslessEvent[]; errors: string[] }> {
    const events: LosslessEvent[] = [];
    const errors: string[] = [];
    await Promise.all(
      this.connectors.map(async (c) => {
        const prev = this.lastPoll.get(c.id) ?? 0;
        if (prev && nowMs - prev < c.intervalMs) return;
        this.lastPoll.set(c.id, nowMs);
        try {
          const found = await c.poll();
          events.push(...found);
        } catch (err) {
          errors.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    return { events, errors };
  }
}

/** Local Beeper Desktop API connector (WhatsApp, iMessage, SMS, etc.). */
export function beeperConnector(opts: { baseUrl?: string; token: string; intervalMs?: number }): EventConnector {
  const base = (opts.baseUrl || 'http://localhost:23373').replace(/\/$/, '');
  return {
    id: 'beeper',
    intervalMs: opts.intervalMs ?? 30_000,
    async poll() {
      const res = await fetch(`${base}/v1/chats?limit=10`, { headers: { Authorization: `Bearer ${opts.token}` } });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        items?: Array<{
          id: string;
          title?: string;
          name?: string;
          network?: string;
          unreadCount?: number;
          lastActivity?: string;
          preview?: { id?: string; text?: string; senderName?: string; timestamp?: string; isDeleted?: boolean };
        }>;
      };
      const out: LosslessEvent[] = [];
      for (const c of data.items ?? []) {
        const text = c.preview?.text?.trim();
        if (!text || !(c.unreadCount && c.unreadCount > 0)) continue;
        const sender = c.preview?.senderName || c.title || c.name || 'unknown';
        if (/^rufus$/i.test(sender.trim())) continue; // never wake on Rufus's own echo
        const ts = c.preview?.timestamp || c.lastActivity || new Date().toISOString();
        out.push(
          messageEvent({
            id: `beeper_${c.id}_${c.preview?.id || ts}`,
            channel: c.network || 'beeper',
            actor: sender,
            text,
            timestamp: ts,
            threadId: c.id,
            ...(c.preview?.isDeleted ? { deleted: true } : {}),
            metadata: { chatTitle: c.title || c.name, unreadCount: c.unreadCount },
          }),
        );
      }
      return out;
    },
  };
}

/** Command-backed Gmail connector (polls recent emails via configured local reader). */
export function gmailConnector(opts: { command: string; args: string[]; intervalMs?: number }): EventConnector {
  return {
    id: 'gmail',
    intervalMs: opts.intervalMs ?? 3 * 60_000,
    async poll() {
      const args = opts.args.map((a) => a.replace(/\{query\}/g, 'newer_than:1d is:unread'));
      const { stdout } = await execFileAsync(opts.command, args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
      const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10);
      const out: LosslessEvent[] = [];
      for (const line of lines) {
        if (line.startsWith('No ') || line.startsWith('ID\t')) continue;
        out.push(
          genericEvent({
            source: 'email',
            kind: 'unread',
            text: line,
            timestamp: new Date().toISOString(),
          }),
        );
      }
      return out;
    },
  };
}

/** Local Calendar anchor connector (emits schedule updates + 20-minute upcoming block alerts). */
export function calendarConnector(opts: { anchorPath: string; intervalMs?: number }): EventConnector {
  let lastHash = '';
  const alerted = new Set<string>();
  return {
    id: 'calendar',
    intervalMs: opts.intervalMs ?? 3 * 60_000,
    async poll() {
      const raw = await fs.readFile(opts.anchorPath, 'utf8').catch(() => '');
      if (!raw) return [];
      const out: LosslessEvent[] = [];
      let data: { schedule?: { date?: string; blocks?: Array<{ title: string; start: string; end: string; status?: string }> } };
      try {
        data = JSON.parse(raw);
      } catch {
        return [];
      }
      const blocks = (data.schedule?.blocks ?? []).filter((b) => b.status !== 'skipped');

      if (raw !== lastHash) {
        const firstRun = !lastHash;
        lastHash = raw;
        if (!firstRun) {
          out.push(
            genericEvent({
              source: 'calendar',
              kind: 'schedule_updated',
              text: `Calendar updated (${data.schedule?.date ?? 'today'}): ${blocks.map((b) => `${b.title} ${b.start}-${b.end}`).join(', ')}`,
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }

      // Upcoming block alert (10-25 min before start)
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      if (!data.schedule?.date || data.schedule.date === todayStr) {
        const nowMins = now.getHours() * 60 + now.getMinutes();
        for (const b of blocks) {
          const m = /^(\d{1,2}):(\d{2})/.exec(b.start || '');
          if (!m) continue;
          const startMins = Number(m[1]) * 60 + Number(m[2]);
          const diff = startMins - nowMins;
          const key = `cal_upcoming_${todayStr}_${b.start}_${b.title.replace(/\W+/g, '_').slice(0, 24)}`;
          if (diff >= 10 && diff <= 25 && !alerted.has(key)) {
            alerted.add(key);
            out.push(
              genericEvent({
                id: key,
                source: 'calendar',
                kind: 'upcoming',
                text: `Upcoming in ~${diff} min: ${b.title} (${b.start}-${b.end})`,
                timestamp: now.toISOString(),
              }),
            );
          }
        }
      }
      return out;
    },
  };
}

/** Auto-discovers custom workspace connectors in `<workspace>/connectors/*.mjs` exporting `poll()` (and optional `intervalMs`). */
export async function loadCustomConnectors(workspaceDir: string): Promise<EventConnector[]> {
  const dir = path.join(workspaceDir, 'connectors');
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.mjs') && !f.startsWith('.')).sort();
  const out: EventConnector[] = [];
  for (const f of files) {
    try {
      const full = path.join(dir, f);
      const stat = await fs.stat(full);
      const mod = (await import(/* @vite-ignore */ `${pathToFileURL(full).href}?m=${Math.round(stat.mtimeMs)}`)) as {
        id?: string;
        intervalMs?: number;
        poll?: () => Promise<LosslessEvent[]>;
      };
      if (typeof mod.poll === 'function') {
        out.push({
          id: mod.id || f.replace(/\.mjs$/, ''),
          intervalMs: mod.intervalMs ?? 60_000,
          poll: mod.poll,
        });
      }
    } catch {
      /* skip broken connector */
    }
  }
  return out;
}

/** Convenience loader: builds all configured connectors from workspace + optional ~/.rufus/config.json. */
export async function buildDefaultConnectors(workspaceDir: string): Promise<EventConnector[]> {
  const out: EventConnector[] = [];
  let beeperCfg: { token?: string; baseUrl?: string; url?: string } | undefined;
  let gmailCmd: { command?: string; args?: string[] } | undefined;

  for (const cfgPath of [path.join(workspaceDir, 'config.json'), path.join(os.homedir(), '.rufus', 'config.json')]) {
    try {
      const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
        beeper?: { token?: string; baseUrl?: string; url?: string };
        tools?: { commands?: Record<string, { command?: string; args?: string[] }> };
      };
      if (!beeperCfg && cfg.beeper?.token) beeperCfg = cfg.beeper;
      if (!gmailCmd && cfg.tools?.commands?.['gmail.read']?.command) gmailCmd = cfg.tools.commands['gmail.read'];
    } catch {
      /* ignore */
    }
  }

  if (beeperCfg?.token) {
    out.push(beeperConnector({ token: beeperCfg.token, ...(beeperCfg.baseUrl || beeperCfg.url ? { baseUrl: (beeperCfg.baseUrl || beeperCfg.url)! } : {}) }));
  }
  if (gmailCmd?.command) {
    out.push(gmailConnector({ command: gmailCmd.command, args: gmailCmd.args ?? [] }));
  }
  const anchorPath = await fs
    .stat(path.join(workspaceDir, 'anchor.json'))
    .then(() => path.join(workspaceDir, 'anchor.json'))
    .catch(() => path.join(os.homedir(), '.rufus', 'anchor.json'));
  out.push(calendarConnector({ anchorPath }));
  out.push(watchConnector(workspaceDir));
  out.push(...(await loadCustomConnectors(workspaceDir)));
  return out;
}
