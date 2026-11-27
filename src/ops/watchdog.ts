/**
 * Dead-man watchdog: a separate small launchd job that tells the owner on Telegram when Rufus has been down,
 * stuck in one wake, or silent (senses stopped) for 30 minutes during the day. The daemon is his only line to
 * Rufus, so a crash loop is otherwise invisible to him.
 *
 * Self-contained on purpose (node: imports only, erasable TypeScript): launchd runs it with plain `node`,
 * no tsx and no node_modules, so a broken build can't take the watchdog down with the daemon.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface TelegramSettings {
  token?: string;
  chatId?: string;
  stt?: { command: string; args: string[] };
}

/**
 * The Telegram bot the daemon uses: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, else `<workspace>/config.json`, else (for the
 * owner's real workspace only) the legacy `~/.rufus/config.json`. A copied or test workspace never picks up his bot.
 */
export async function loadTelegramConfig(dir: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<TelegramSettings> {
  let token = env.TELEGRAM_BOT_TOKEN;
  let chatId = env.TELEGRAM_CHAT_ID;
  let stt: TelegramSettings['stt'];
  const isDefaultWorkspace = path.resolve(dir) === path.join(home, '.rufus-v2');
  const cfgPaths = [path.join(dir, 'config.json'), ...(isDefaultWorkspace ? [path.join(home, '.rufus', 'config.json')] : [])];
  for (const cfgPath of cfgPaths) {
    try {
      const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
        telegram?: { token?: string; chatId?: string | number; transcribe?: { command: string; args: string[] } };
        voice?: { stt?: { command: string; args: string[] } };
      };
      if ((!token || !chatId) && cfg.telegram?.token && cfg.telegram?.chatId) {
        token = cfg.telegram.token;
        chatId = String(cfg.telegram.chatId);
      }
      if (!stt) stt = cfg.voice?.stt ?? cfg.telegram?.transcribe;
    } catch {
      /* no config here */
    }
  }
  return { ...(token ? { token } : {}), ...(chatId ? { chatId } : {}), ...(stt ? { stt } : {}) };
}

export interface WatchdogProbe {
  healthOk: boolean;
  healthDetail: string;
  /** live.json: `awake` with the wake's start, or `asleep`. */
  liveStatus?: string;
  liveStartedAt?: string;
  /** When the senses last saved their state (every heartbeat while the daemon's loop runs). */
  sensesUpdatedAt?: string;
}

export interface WatchdogState {
  /** When the current bad stretch began. */
  badSince?: string;
  reason?: string;
  /** Set once the owner has been told about this stretch, so he hears about it once. */
  alertedAt?: string;
}

export interface WatchdogOptions {
  thresholdMs: number;
  /** The owner's day, in the Mac's local hours: [start, end). */
  dayStartHour: number;
  dayEndHour: number;
}

export const DEFAULT_WATCHDOG: WatchdogOptions = { thresholdMs: 30 * 60_000, dayStartHour: 8, dayEndHour: 22 };

const mins = (ms: number) => Math.round(ms / 60_000);

/** What is wrong right now, if anything. */
export function problemOf(p: WatchdogProbe, now: Date, o: WatchdogOptions): string | undefined {
  if (!p.healthOk) return `not answering its health check (${p.healthDetail})`;
  const started = p.liveStartedAt ? Date.parse(p.liveStartedAt) : NaN;
  if (p.liveStatus === 'awake' && Number.isFinite(started) && now.getTime() - started >= o.thresholdMs) return `stuck in one wake for ${mins(now.getTime() - started)} min`;
  const senses = p.sensesUpdatedAt ? Date.parse(p.sensesUpdatedAt) : NaN;
  if (Number.isFinite(senses) && now.getTime() - senses >= o.thresholdMs) return `running, but his senses have been silent for ${mins(now.getTime() - senses)} min`;
  return undefined;
}

/**
 * One check: carries the bad stretch forward, and says what to tell the owner. He hears once per stretch,
 * only after it has lasted the threshold and only during his day, plus one line when Rufus is back.
 */
export function assessWatchdog(p: WatchdogProbe, prev: WatchdogState, now: Date, o: WatchdogOptions = DEFAULT_WATCHDOG): { state: WatchdogState; alert?: string } {
  const problem = problemOf(p, now, o);
  if (!problem) {
    return prev.alertedAt ? { state: {}, alert: 'Rufus is back up and healthy.' } : { state: {} };
  }
  const badSince = prev.badSince ?? now.toISOString();
  const state: WatchdogState = { badSince, reason: problem, ...(prev.alertedAt ? { alertedAt: prev.alertedAt } : {}) };
  const lasted = now.getTime() - Date.parse(badSince);
  const hour = now.getHours();
  const daytime = hour >= o.dayStartHour && hour < o.dayEndHour;
  if (prev.alertedAt || lasted < o.thresholdMs || !daytime) return { state };
  return {
    state: { ...state, alertedAt: now.toISOString() },
    alert: `Rufus watchdog: Rufus has been ${problem} for about ${mins(lasted)} min, so he can't hear or answer you right now. Logs: ~/.rufus-v2/logs/daemon.log`,
  };
}

async function probe(dir: string, healthUrl: string): Promise<WatchdogProbe> {
  const out: WatchdogProbe = { healthOk: false, healthDetail: 'no answer' };
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    out.healthOk = res.ok && body.ok === true;
    out.healthDetail = out.healthOk ? 'ok' : `HTTP ${res.status}`;
  } catch (err) {
    out.healthDetail = (err as Error).message.slice(0, 120);
  }
  try {
    const live = JSON.parse(await fs.readFile(path.join(dir, 'live.json'), 'utf8')) as { status?: string; startedAt?: string };
    if (live.status) out.liveStatus = live.status;
    if (live.startedAt) out.liveStartedAt = live.startedAt;
  } catch {
    /* no live.json */
  }
  const senses = await fs.stat(path.join(dir, 'senses.json')).catch(() => undefined);
  if (senses) out.sensesUpdatedAt = senses.mtime.toISOString();
  return out;
}

async function sendTelegram(cfg: TelegramSettings, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage failed (${res.status})`);
}

/** One watchdog run (launchd calls it every few minutes). `send` defaults to the daemon's Telegram bot. */
export async function runWatchdog(opts: {
  workspaceDir: string;
  healthUrl?: string;
  now?: Date;
  options?: WatchdogOptions;
  send?: (text: string) => Promise<void>;
  probe?: () => Promise<WatchdogProbe>;
}): Promise<{ problem?: string; alerted?: string }> {
  const dir = opts.workspaceDir;
  const now = opts.now ?? new Date();
  const statePath = path.join(dir, 'logs', 'watchdog-state.json');
  const prev = JSON.parse(await fs.readFile(statePath, 'utf8').catch(() => '{}')) as WatchdogState;
  const p = await (opts.probe ?? (() => probe(dir, opts.healthUrl ?? `http://127.0.0.1:${Number(process.env.RUFUS_HTTP_PORT || 8787)}/health`)))();
  const { state, alert } = assessWatchdog(p, prev, now, opts.options ?? DEFAULT_WATCHDOG);
  let sentOk = true;
  if (alert) {
    const send =
      opts.send ??
      (async (text: string) => {
        const cfg = await loadTelegramConfig(dir);
        if (!cfg.token || !cfg.chatId) throw new Error('no Telegram bot configured');
        await sendTelegram(cfg, text);
      });
    await send(alert).catch((err: unknown) => {
      sentOk = false;
      console.error(`${now.toISOString()} watchdog could not alert: ${(err as Error).message}`);
    });
  }
  // An alert that didn't go out is tried again next run.
  let keep: WatchdogState = state;
  if (!sentOk) {
    const { alertedAt: _unsent, ...rest } = state;
    keep = state.badSince ? rest : prev;
  }
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(keep)}\n`, 'utf8');
  const problem = problemOf(p, now, opts.options ?? DEFAULT_WATCHDOG);
  if (problem || alert) console.log(`${now.toISOString()} watchdog: ${problem ?? 'healthy'}${alert && sentOk ? ' (owner told)' : ''}`);
  return { ...(problem ? { problem } : {}), ...(alert && sentOk ? { alerted: alert } : {}) };
}

function parseDay(v: string | undefined): Pick<WatchdogOptions, 'dayStartHour' | 'dayEndHour'> {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(v ?? '');
  return m ? { dayStartHour: Number(m[1]), dayEndHour: Number(m[2]) } : { dayStartHour: DEFAULT_WATCHDOG.dayStartHour, dayEndHour: DEFAULT_WATCHDOG.dayEndHour };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.env.RUFUS_DIR || path.join(os.homedir(), '.rufus-v2');
  runWatchdog({ workspaceDir: dir, options: { ...DEFAULT_WATCHDOG, ...parseDay(process.env.RUFUS_WATCHDOG_DAY) } }).catch((err: unknown) => {
    console.error(`watchdog failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
