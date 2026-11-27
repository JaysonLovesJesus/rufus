import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ProviderLimitState {
  /** ISO timestamp when the provider's rate limit resets. */
  resetsAt: string;
  /** Human-readable reset label from the provider error (e.g. "12:40pm"). */
  resetLabel?: string;
  /** Which window tripped ("5h", "weekly", or "rate_limit"). */
  window: '5h' | 'weekly' | 'rate_limit';
  /** Raw error snippet that tripped it. */
  reason: string;
  recordedAt: string;
}

export interface CreditState {
  limits: Record<string, ProviderLimitState>;
  /** Rolling usage samples (last 7 days) used only to estimate remaining % before a limit hits. */
  usage: Array<{ at: string; provider: string; costUsd: number; tokens: number }>;
  /** Calibrated 5h and 7d budget ceilings (updated automatically when a real limit trips). */
  calibrated5hUsd?: number;
  calibrated7dUsd?: number;
}

const RATE_LIMIT_RE = /(?:5-hour limit|weekly limit|rate[ -]?limit|quota|too many requests|429|credit balance|out of credits|usage limit|limit reached)/i;

/** Returns true when a provider error indicates a rate limit, credit exhaustion, or quota wall. */
export function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_RE.test(message);
}

/**
 * Parses a reset timestamp from provider limit errors like:
 * - "You've hit your 5-hour limit · resets 12:40pm (America/New_York)"
 * - "resets in 45m" / "resets in 2h 10m"
 * Defaults to 30 minutes from `now` if no explicit time is present.
 */
export function parseResetTime(message: string, now = new Date()): { resetsAt: string; resetLabel?: string; window: '5h' | 'weekly' | 'rate_limit' } {
  const window: '5h' | 'weekly' | 'rate_limit' = /weekly/i.test(message) ? 'weekly' : /5-hour|5h/i.test(message) ? '5h' : 'rate_limit';

  // "resets in 2h 15m" or "try again in 30 minutes"
  const rel = /(?:resets?|try again)\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(message);
  if (rel && (rel[1] || rel[2])) {
    const ms = (Number(rel[1] || 0) * 60 + Number(rel[2] || 0)) * 60_000;
    if (ms > 0) {
      const target = new Date(now.getTime() + ms);
      return { resetsAt: target.toISOString(), resetLabel: `${rel[1] ? `${rel[1]}h` : ''}${rel[2] ? `${rel[2]}m` : ''}`, window };
    }
  }

  // "resets 12:40pm" or "resets 3pm"
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(message);
  if (clock) {
    let h = Number(clock[1]);
    const m = Number(clock[2] || 0);
    const ap = clock[3]!.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return { resetsAt: target.toISOString(), resetLabel: `${clock[1]}${clock[2] ? `:${clock[2]}` : ''}${ap}`, window };
  }

  const fallback = new Date(now.getTime() + 30 * 60_000);
  return { resetsAt: fallback.toISOString(), window };
}

/** Tracks provider rate-limit reset times and estimated remaining % for The Desk. */
export class CreditTracker {
  readonly filePath: string;
  private cache?: CreditState;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, 'credits.json');
  }

  async load(): Promise<CreditState> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<CreditState>;
      this.cache = {
        limits: raw.limits && typeof raw.limits === 'object' ? raw.limits : {},
        usage: Array.isArray(raw.usage) ? raw.usage : [],
        ...(typeof raw.calibrated5hUsd === 'number' ? { calibrated5hUsd: raw.calibrated5hUsd } : {}),
        ...(typeof raw.calibrated7dUsd === 'number' ? { calibrated7dUsd: raw.calibrated7dUsd } : {}),
      };
    } catch {
      this.cache = { limits: {}, usage: [] };
    }
    return this.cache;
  }

  private async save(state: CreditState): Promise<void> {
    this.cache = state;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  /** Returns the active limit for a provider if its reset time is still in the future. */
  async activeLimit(provider: string, now = new Date()): Promise<ProviderLimitState | undefined> {
    const state = await this.load();
    const hit = state.limits[provider];
    if (!hit) return undefined;
    if (Date.parse(hit.resetsAt) <= now.getTime()) {
      delete state.limits[provider];
      await this.save(state);
      return undefined;
    }
    return hit;
  }

  /** Records a real rate-limit trip, calibrates the 5h/7d ceiling, and parks the provider until reset. */
  async recordLimit(provider: string, errorMessage: string, now = new Date()): Promise<ProviderLimitState> {
    const state = await this.load();
    const parsed = parseResetTime(errorMessage, now);
    const entry: ProviderLimitState = {
      resetsAt: parsed.resetsAt,
      ...(parsed.resetLabel ? { resetLabel: parsed.resetLabel } : {}),
      window: parsed.window,
      reason: errorMessage.slice(0, 240),
      recordedAt: now.toISOString(),
    };
    state.limits[provider] = entry;
    // Self-calibrate our remaining-% estimate when a real 5h or weekly limit trips.
    const spent5h = this.sumWindow(state, provider, 5 * 3600_000, now);
    const spent7d = this.sumWindow(state, provider, 7 * 24 * 3600_000, now);
    if (parsed.window === '5h' && spent5h > 0.5) state.calibrated5hUsd = spent5h;
    if (parsed.window === 'weekly' && spent7d > 2) state.calibrated7dUsd = spent7d;
    await this.save(state);
    return entry;
  }

  /** Records one successful model call's usage (kept only for 7 days to estimate remaining %). */
  async recordUsage(provider: string, costUsd = 0, tokens = 0, now = new Date()): Promise<void> {
    const state = await this.load();
    const cutoff = now.getTime() - 7 * 24 * 3600_000;
    state.usage = state.usage.filter((u) => Date.parse(u.at) >= cutoff);
    state.usage.push({ at: now.toISOString(), provider, costUsd, tokens });
    if (state.usage.length > 2000) state.usage = state.usage.slice(-2000);
    await this.save(state);
  }

  private sumWindow(state: CreditState, provider: string, windowMs: number, now: Date): number {
    const cutoff = now.getTime() - windowMs;
    return state.usage
      .filter((u) => u.provider === provider && Date.parse(u.at) >= cutoff)
      .reduce((s, u) => s + (u.costUsd || 0), 0);
  }

  /**
   * Formats ONE concise line for The Desk showing ONLY what Decide needs:
   * active provider, estimated % remaining + reset time, and ready backups.
   */
  async formatForDesk(opts: { activeProvider: string; primaryProvider?: string; backups?: string[]; now?: Date }): Promise<string> {
    const now = opts.now ?? new Date();
    const state = await this.load();
    const primary = opts.primaryProvider ?? opts.activeProvider;
    const limit = await this.activeLimit(primary, now);
    const parts: string[] = [`active=${opts.activeProvider}`];

    if (limit) {
      const when = limit.resetLabel || new Date(limit.resetsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      parts.push(`${primary} ${limit.window} 0% left (resets ${when})`);
    } else {
      const cap5h = state.calibrated5hUsd ?? 15;
      const cap7d = state.calibrated7dUsd ?? 100;
      const used5h = this.sumWindow(state, primary, 5 * 3600_000, now);
      const used7d = this.sumWindow(state, primary, 7 * 24 * 3600_000, now);
      const left5h = Math.max(0, Math.min(100, Math.round((1 - used5h / cap5h) * 100)));
      const left7d = Math.max(0, Math.min(100, Math.round((1 - used7d / cap7d) * 100)));
      parts.push(`5h ~${left5h}% left`, `7d ~${left7d}% left`);
    }
    if (opts.backups?.length) parts.push(`backups: ${opts.backups.join(', ')}`);
    return `Credits: ${parts.join(' | ')}`;
  }
}
