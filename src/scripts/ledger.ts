import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The trust gate's records, kept next to trust.json: what each tool spends, each scope's track record, and the
 * do-and-tell reports that still have to reach the owner. Code writes them; tools may not (see protected.ts).
 */
export const SPEND_FILE = 'spend.json';
export const RECORD_FILE = 'trust-record.json';
export const REPORTS_FILE = 'reports-pending.json';

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

/** One writer per file in this process, so two calls finishing together never lose an update. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(file) ?? Promise.resolve()).then(fn, fn);
  queues.set(file, next.catch(() => undefined));
  return next;
}

// ---------------- Spend ----------------

/**
 * The runaway guard. The owner's budget is "spend freely", so this never rations normal work: it only catches a loop.
 * 300 calls of one tool in an hour is one every 12 seconds around the clock (a busy wake makes ~25 moves), and
 * $30 of model spend inside one tool in an hour is dozens of Opus brain calls back to back.
 */
export const RUNAWAY_CALLS_PER_HOUR = 300;
export const RUNAWAY_USD_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
const KEEP_DAYS = 14;

export interface DaySpend {
  calls: number;
  usd: number;
  ms: number;
}

interface SpendFile {
  days: Record<string, Record<string, DaySpend>>;
  /** Each tool's calls in the last hour: [epoch ms, usd]. */
  hour: Record<string, Array<[number, number]>>;
}

export interface Runaway {
  calls: number;
  usd: number;
  todayUsd: number;
  reason: string;
}

export class SpendLedger {
  readonly file: string;
  constructor(workspaceDir: string) {
    this.file = path.join(workspaceDir, SPEND_FILE);
  }

  private read(): Promise<SpendFile> {
    return readJson<SpendFile>(this.file, { days: {}, hour: {} });
  }

  /** Records one call that ran: its time and the model spend made inside it. */
  record(toolId: string, call: { at: Date; ms: number; usd: number }): Promise<void> {
    return serial(this.file, async () => {
      const f = await this.read();
      f.days ??= {};
      f.hour ??= {};
      const day = call.at.toISOString().slice(0, 10);
      const today = (f.days[day] ??= {});
      const row = (today[toolId] ??= { calls: 0, usd: 0, ms: 0 });
      row.calls += 1;
      row.usd = Number((row.usd + call.usd).toFixed(4));
      row.ms += Math.max(0, Math.round(call.ms));
      const t = call.at.getTime();
      f.hour[toolId] = [...(f.hour[toolId] ?? []).filter(([at]) => t - at < HOUR_MS), [t, Number(call.usd.toFixed(4))]];
      for (const d of Object.keys(f.days).sort().slice(0, -KEEP_DAYS)) delete f.days[d];
      for (const [id, calls] of Object.entries(f.hour)) {
        const live = calls.filter(([at]) => t - at < HOUR_MS);
        if (live.length) f.hour[id] = live;
        else delete f.hour[id];
      }
      await writeJson(this.file, f);
    });
  }

  /** A tool's spend so far today. */
  async today(toolId: string, now: Date): Promise<DaySpend> {
    return (await this.read()).days?.[now.toISOString().slice(0, 10)]?.[toolId] ?? { calls: 0, usd: 0, ms: 0 };
  }

  /** Every tool's spend on one day. */
  async day(now: Date): Promise<Record<string, DaySpend>> {
    return (await this.read()).days?.[now.toISOString().slice(0, 10)] ?? {};
  }

  /** Set when a tool's last hour looks like a loop rather than work. */
  async runaway(toolId: string, now: Date): Promise<Runaway | undefined> {
    const f = await this.read();
    const t = now.getTime();
    const recent = (f.hour?.[toolId] ?? []).filter(([at]) => t - at < HOUR_MS);
    const calls = recent.length;
    const usd = recent.reduce((s, [, u]) => s + u, 0);
    if (calls < RUNAWAY_CALLS_PER_HOUR && usd < RUNAWAY_USD_PER_HOUR) return undefined;
    const todayUsd = f.days?.[now.toISOString().slice(0, 10)]?.[toolId]?.usd ?? 0;
    const reason =
      calls >= RUNAWAY_CALLS_PER_HOUR
        ? `${calls} calls in the last hour (the runaway guard trips at ${RUNAWAY_CALLS_PER_HOUR})`
        : `$${usd.toFixed(2)} of model spend in the last hour (the runaway guard trips at $${RUNAWAY_USD_PER_HOUR})`;
    return { calls, usd: Number(usd.toFixed(4)), todayUsd, reason };
  }
}

// ---------------- Track record ----------------

/**
 * Clean drafts in a row before Rufus offers the owner one promotion. If the owner would really deny 30% of a scope's
 * drafts, 5 straight yeses happen by luck only 17% of the time (3% at 50%), so a streak of 5 is real evidence without
 * making him tap dozens of times. The offer is still his tap, and one miss or denial takes the rung back down.
 */
export const PROMOTION_STREAK = 5;

export interface ScopeRecord {
  approved: number;
  denied: number;
  misses: number;
  /** Clean outcomes since the last denial, miss or offer. */
  streak: number;
  /** The pending approval that offers this scope its promotion, while the owner hasn't answered it. */
  offer?: string;
  lastAt?: string;
}

export class TrackRecord {
  readonly file: string;
  constructor(workspaceDir: string) {
    this.file = path.join(workspaceDir, RECORD_FILE);
  }

  async all(): Promise<Record<string, ScopeRecord>> {
    return readJson<Record<string, ScopeRecord>>(this.file, {});
  }

  async get(key: string): Promise<ScopeRecord> {
    return (await this.all())[key] ?? { approved: 0, denied: 0, misses: 0, streak: 0 };
  }

  private update(key: string, at: Date, fn: (r: ScopeRecord) => void): Promise<ScopeRecord> {
    return serial(this.file, async () => {
      const all = await this.all();
      const r = all[key] ?? { approved: 0, denied: 0, misses: 0, streak: 0 };
      fn(r);
      r.lastAt = at.toISOString();
      all[key] = r;
      await writeJson(this.file, all);
      return r;
    });
  }

  /** The owner said yes to a draft as it was. */
  approved(key: string, at: Date): Promise<ScopeRecord> {
    return this.update(key, at, (r) => {
      r.approved += 1;
      r.streak += 1;
    });
  }

  /** The owner said no to a draft. */
  denied(key: string, at: Date): Promise<ScopeRecord> {
    return this.update(key, at, (r) => {
      r.denied += 1;
      r.streak = 0;
    });
  }

  /** Something it did on its own was pushed back on by the owner. */
  missed(key: string, at: Date): Promise<ScopeRecord> {
    return this.update(key, at, (r) => {
      r.misses += 1;
      r.streak = 0;
    });
  }

  /** A promotion offer is out (or was answered): the streak starts over either way, so he is never asked twice in a row. */
  offered(key: string, at: Date, approvalId?: string): Promise<ScopeRecord> {
    return this.update(key, at, (r) => {
      r.streak = 0;
      if (approvalId) r.offer = approvalId;
      else delete r.offer;
    });
  }
}

// ---------------- Do-and-tell reports ----------------

/** One act_and_report change that has to reach the owner. */
export interface PendingReport {
  toolId: string;
  summary: string;
  changes: string[];
  at: string;
}

/** Reports from calls that ran outside any wake (a bouncer retrain): the next wake's digest carries them. */
export class ReportQueue {
  readonly file: string;
  constructor(workspaceDir: string) {
    this.file = path.join(workspaceDir, REPORTS_FILE);
  }

  add(report: PendingReport): Promise<void> {
    return serial(this.file, async () => {
      const list = await readJson<PendingReport[]>(this.file, []);
      await writeJson(this.file, [...(Array.isArray(list) ? list : []), report].slice(-50));
    });
  }

  async list(): Promise<PendingReport[]> {
    const list = await readJson<PendingReport[]>(this.file, []);
    return Array.isArray(list) ? list : [];
  }

  /** Drops the oldest `count` reports, once the digest that carried them went out (newer ones wait for the next). */
  drop(count: number): Promise<void> {
    return serial(this.file, async () => {
      const list = await readJson<PendingReport[]>(this.file, []);
      if (Array.isArray(list) && list.length && count > 0) await writeJson(this.file, list.slice(count));
    });
  }
}
