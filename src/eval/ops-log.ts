import { promises as fs } from 'node:fs';
import path from 'node:path';

/** A channel failure that would otherwise be swallowed: a poll that errored, a send or edit that threw. */
export interface OpsFailure {
  at: string;
  kind: 'poll_failed' | 'send_failed' | 'edit_failed';
  channel?: string;
  error: string;
  /** How many identical failures were folded into this line since the previous one was written. */
  repeatsSinceLast?: number;
}

const opsFile = (workspaceDir: string) => path.join(workspaceDir, 'logs', 'ops.jsonl');

/** A failing poll retries in a tight loop; the same failure is written at most once a minute, with a count of the repeats. */
const REPEAT_WINDOW_MS = 60_000;
const lastSeen = new Map<string, { at: number; repeats: number }>();

/** Appends one failure to `<workspace>/logs/ops.jsonl` and the daemon log. Never throws. */
export async function recordOpsFailure(
  workspaceDir: string,
  f: { kind: OpsFailure['kind']; channel?: string | undefined; error: unknown; at?: Date },
): Promise<void> {
  const at = f.at ?? new Date();
  const error = (f.error instanceof Error ? f.error.message : String(f.error)).slice(0, 400);
  const key = `${workspaceDir}|${f.kind}|${f.channel ?? ''}|${error}`;
  const prev = lastSeen.get(key);
  if (prev && at.getTime() - prev.at < REPEAT_WINDOW_MS) {
    prev.repeats++;
    return;
  }
  lastSeen.set(key, { at: at.getTime(), repeats: 0 });
  const rec: OpsFailure = {
    at: at.toISOString(),
    kind: f.kind,
    ...(f.channel ? { channel: f.channel } : {}),
    error,
    ...(prev?.repeats ? { repeatsSinceLast: prev.repeats } : {}),
  };
  // The daemon log stamps every line already (stampConsole), so this line carries no time of its own.
  console.error(`${rec.kind}${rec.channel ? ` (${rec.channel})` : ''}: ${rec.error}${rec.repeatsSinceLast ? ` (+${rec.repeatsSinceLast} repeats since the last line)` : ''}`);
  try {
    await fs.mkdir(path.dirname(opsFile(workspaceDir)), { recursive: true });
    await appendRotating(opsFile(workspaceDir), `${JSON.stringify(rec)}\n`, OPS_LOG_MAX_BYTES);
  } catch {
    /* logging must never break a wake */
  }
}

/** Past this size `ops.jsonl` moves to `ops.1.jsonl`, so the log never grows forever. */
const OPS_LOG_MAX_BYTES = 5 * 1024 * 1024;
const appendQueues = new Map<string, Promise<void>>();

/**
 * Appends one line to a JSONL log. Once the file would pass `maxBytes`, it first moves to `<name>.1.jsonl`
 * (replacing the older one), so the newest lines are always in the main file and the log never grows forever.
 * Appends to the same file run one at a time, so a rotation can never race another append.
 */
export function appendRotating(file: string, line: string, maxBytes: number): Promise<void> {
  const write = async () => {
    const size = await fs.stat(file).then((s) => s.size, () => 0);
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
      const ext = path.extname(file);
      await fs.rename(file, `${ext ? file.slice(0, -ext.length) : file}.1${ext}`).catch(() => undefined);
    }
    await fs.appendFile(file, line, 'utf8');
  };
  const next = (appendQueues.get(file) ?? Promise.resolve()).then(write, write);
  const settled = next.catch(() => undefined);
  appendQueues.set(file, settled);
  // The queue entry goes once it is the last one, so the map holds only files with appends in flight.
  void settled.then(() => {
    if (appendQueues.get(file) === settled) appendQueues.delete(file);
  });
  return next;
}

export async function loadOpsFailures(workspaceDir: string): Promise<OpsFailure[]> {
  try {
    const raw = await fs.readFile(opsFile(workspaceDir), 'utf8');
    const out: OpsFailure[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as OpsFailure);
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}
