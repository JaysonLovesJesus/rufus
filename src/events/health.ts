import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LosslessEvent } from '../types';
import { genericEvent } from './ingest';

/** One connector poll, as the heartbeat saw it. */
export interface SensePoll {
  id: string;
  intervalMs: number;
  at: string;
  ok: boolean;
  ms: number;
  events: LosslessEvent[];
  parseFailures: number;
  error?: string;
}

interface HourBucket {
  hour: number;
  polls: number;
  failures: number;
  events: number;
  duplicates: number;
  repeats: number;
  parseFailures: number;
  latencyMs: number;
}

export interface SenseHealthEntry {
  id: string;
  intervalMs: number;
  status: 'ok' | 'quiet' | 'broken';
  /** Why the status is not ok. */
  problem?: string;
  lastPollAt?: string;
  lastSuccessAt?: string;
  lastEventAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  consecutiveFailures: number;
  eventsLastHour: number;
  events24h: number;
  polls24h: number;
  failures24h: number;
  /** New ids whose content repeats one already sensed in the last 24h (a broken id scheme). */
  duplicates24h: number;
  /** The same id sensed again (harmless: the store already has it). */
  repeats24h: number;
  parseFailures24h: number;
  avgLatencyMs: number;
  buckets: HourBucket[];
}

export interface SensesFile {
  updatedAt: string;
  senses: Record<string, SenseHealthEntry>;
}

export const SENSES_FILE = 'senses.json';
const HOUR_MS = 3_600_000;
/** A sense is broken after this many failed polls in a row. */
const BROKEN_AFTER_FAILURES = 3;

const emptyBucket = (hour: number): HourBucket => ({ hour, polls: 0, failures: 0, events: 0, duplicates: 0, repeats: 0, parseFailures: 0, latencyMs: 0 });

/**
 * Health of every sense: last success, events per hour, duplicate and parse failures, latency.
 * Kept in `<workspace>/senses.json` so the dashboard and `rufus verify` can read it without the daemon.
 */
export class SenseHealth {
  readonly filePath: string;
  private data: SensesFile = { updatedAt: new Date(0).toISOString(), senses: {} };
  private readonly recentContent = new Map<string, Map<string, number>>();
  private readonly brokenNow = new Set<string>();
  private loaded = false;

  constructor(workspaceDir: string, private readonly now: () => Date = () => new Date()) {
    this.filePath = path.join(workspaceDir, SENSES_FILE);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const prev = await readSensesFile(path.dirname(this.filePath));
    if (prev) this.data = prev;
    for (const [id, e] of Object.entries(this.data.senses)) if (e.status === 'broken') this.brokenNow.add(id);
  }

  private entry(id: string, intervalMs: number): SenseHealthEntry {
    const hit = this.data.senses[id];
    if (hit) {
      hit.intervalMs = intervalMs || hit.intervalMs;
      return hit;
    }
    const created: SenseHealthEntry = {
      id,
      intervalMs,
      status: 'quiet',
      consecutiveFailures: 0,
      eventsLastHour: 0,
      events24h: 0,
      polls24h: 0,
      failures24h: 0,
      duplicates24h: 0,
      repeats24h: 0,
      parseFailures24h: 0,
      avgLatencyMs: 0,
      buckets: [],
    };
    this.data.senses[id] = created;
    return created;
  }

  private bucket(e: SenseHealthEntry): HourBucket {
    const hour = Math.floor(this.now().getTime() / HOUR_MS);
    let b = e.buckets[e.buckets.length - 1];
    if (!b || b.hour !== hour) {
      b = emptyBucket(hour);
      e.buckets.push(b);
    }
    e.buckets = e.buckets.filter((x) => x.hour > hour - 24);
    return b;
  }

  recordPoll(p: SensePoll): void {
    const e = this.entry(p.id, p.intervalMs);
    const b = this.bucket(e);
    b.polls++;
    b.latencyMs += p.ms;
    b.parseFailures += p.parseFailures;
    e.lastPollAt = p.at;
    if (p.ok) {
      e.lastSuccessAt = p.at;
      e.consecutiveFailures = 0;
    } else {
      b.failures++;
      e.consecutiveFailures++;
      e.lastErrorAt = p.at;
      if (p.error) e.lastError = p.error.slice(0, 300);
    }
    if (p.parseFailures && !p.error) {
      e.lastError = `${p.parseFailures} item(s) could not be parsed`;
      e.lastErrorAt = p.at;
    }
    this.summarize(e);
  }

  /** Records what the store made of one sensed event: new, the same id again, or new id with repeated content. */
  recordIngest(id: string, ev: LosslessEvent, fresh: boolean): void {
    const e = this.entry(id, 0);
    const b = this.bucket(e);
    if (!fresh) {
      b.repeats++;
    } else {
      const nowMs = this.now().getTime();
      const seen = this.recentContent.get(id) ?? new Map<string, number>();
      this.recentContent.set(id, seen);
      for (const [k, t] of seen) if (nowMs - t > 24 * HOUR_MS) seen.delete(k);
      const key = createHash('sha1').update(`${ev.source}\0${ev.kind}\0${ev.actor ?? ''}\0${ev.threadId ?? ''}\0${ev.text}`).digest('hex');
      if (seen.has(key)) b.duplicates++;
      seen.set(key, nowMs);
      b.events++;
      e.lastEventAt = ev.timestamp;
    }
    this.summarize(e);
  }

  private summarize(e: SenseHealthEntry): void {
    const hour = Math.floor(this.now().getTime() / HOUR_MS);
    const live = e.buckets.filter((x) => x.hour > hour - 24);
    const sum = (k: keyof HourBucket) => live.reduce((n, x) => n + (x[k] as number), 0);
    e.events24h = sum('events');
    e.eventsLastHour = live.filter((x) => x.hour === hour).reduce((n, x) => n + x.events, 0);
    e.polls24h = sum('polls');
    e.failures24h = sum('failures');
    e.duplicates24h = sum('duplicates');
    e.repeats24h = sum('repeats');
    e.parseFailures24h = sum('parseFailures');
    e.avgLatencyMs = e.polls24h ? Math.round(sum('latencyMs') / e.polls24h) : 0;
    const problem =
      e.consecutiveFailures >= BROKEN_AFTER_FAILURES
        ? `${e.consecutiveFailures} failed polls in a row${e.lastError ? ` (${e.lastError})` : ''}`
        : e.parseFailures24h >= 3 && e.parseFailures24h >= e.events24h
          ? `${e.parseFailures24h} unparseable item(s) in 24h`
          : e.events24h >= 5 && e.duplicates24h * 2 > e.events24h
            ? `${e.duplicates24h} of ${e.events24h} events in 24h repeat earlier content under new ids`
            : undefined;
    e.status = problem ? 'broken' : e.events24h > 0 ? 'ok' : 'quiet';
    if (problem) e.problem = problem;
    else delete e.problem;
  }

  /** Events for senses that just broke or recovered: a broken sense is new reality like any other. */
  transitions(): LosslessEvent[] {
    const out: LosslessEvent[] = [];
    const at = this.now().toISOString();
    for (const e of Object.values(this.data.senses)) {
      const broken = e.status === 'broken';
      if (broken === this.brokenNow.has(e.id)) continue;
      if (broken) this.brokenNow.add(e.id);
      else this.brokenNow.delete(e.id);
      out.push(
        genericEvent({
          source: 'system',
          kind: broken ? 'sense_broken' : 'sense_recovered',
          text: broken ? `The ${e.id} sense is broken: ${e.problem}. Rufus is not seeing this part of the world until it is fixed.` : `The ${e.id} sense is working again.`,
          timestamp: at,
          metadata: { sense: e.id, ...(e.problem ? { problem: e.problem } : {}) },
        }),
      );
    }
    return out;
  }

  snapshot(): SensesFile {
    return { ...this.data, updatedAt: this.now().toISOString() };
  }

  private saving: Promise<void> = Promise.resolve();

  /** Saves are serialized: overlapping heartbeat ticks share one temp file. */
  save(): Promise<void> {
    const write = async () => {
      this.data.updatedAt = this.now().toISOString();
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(tmp, `${JSON.stringify(this.data, null, 1)}\n`, 'utf8');
      await fs.rename(tmp, this.filePath);
    };
    const next = this.saving.then(write, write);
    this.saving = next.catch(() => undefined);
    return next;
  }
}

export async function readSensesFile(workspaceDir: string): Promise<SensesFile | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(workspaceDir, SENSES_FILE), 'utf8')) as SensesFile;
    return raw && typeof raw.senses === 'object' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Judges real sense output over the last 24 hours: every wired sense must have polled successfully,
 * none may be broken (failing, unparseable, or repeating content under new ids), and the senses together must have sensed something.
 */
export function assessSenses(file: SensesFile | undefined, wired: readonly string[], now = new Date()): { passed: boolean; detail: string } {
  if (!file) return { passed: false, detail: `no ${SENSES_FILE} yet: the running daemon predates sense health (restart it on this code)` };
  const dayAgo = now.getTime() - 24 * HOUR_MS;
  const problems: string[] = [];
  const parts: string[] = [];
  let total = 0;
  for (const id of wired) {
    const e = file.senses[id];
    if (!e) {
      problems.push(`${id}: never polled`);
      continue;
    }
    total += e.events24h;
    parts.push(`${id} ${e.events24h}/24h`);
    if (!e.lastSuccessAt || Date.parse(e.lastSuccessAt) < dayAgo) problems.push(`${id}: no successful poll in 24h${e.lastError ? ` (${e.lastError})` : ''}`);
    else if (e.status === 'broken') problems.push(`${id}: ${e.problem}`);
  }
  if (!problems.length && total === 0) problems.push('no sense produced a single event in 24h');
  return { passed: problems.length === 0, detail: `${parts.join(', ')}${problems.length ? ` | ${problems.join('; ')}` : ''}` };
}
