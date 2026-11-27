import type { ModelCallStats, ModelProvider, ModelRequest } from '../types';
import { CreditTracker, isRateLimitError } from './credits';

/**
 * Ordered provider chain (e.g. Claude -> Gemini -> Local llama-cli).
 * - Automatically skips any provider currently parked on a rate limit until its reset time.
 * - When a provider throws a rate-limit or unavailable error, records the reset time in CreditTracker
 *   and seamlessly falls through to the next provider in the chain.
 */
export class FallbackProvider implements ModelProvider {
  readonly name: string;
  private readonly chain: ModelProvider[];
  private readonly credits?: CreditTracker;
  private readonly now: () => Date;
  private lastActive: string;

  constructor(opts: { chain: ModelProvider[]; credits?: CreditTracker; now?: () => Date }) {
    if (!opts.chain.length) throw new Error('FallbackProvider requires at least one provider');
    this.chain = opts.chain;
    if (opts.credits) this.credits = opts.credits;
    this.now = opts.now ?? (() => new Date());
    this.name = `fallback(${opts.chain.map((p) => p.name).join('->')})`;
    this.lastActive = opts.chain[0]!.name;
  }

  /** Name of the provider that last answered (or primary if none ran yet). */
  activeProviderName(): string {
    return this.lastActive;
  }

  /** Primary provider name (first in the chain). */
  primaryProviderName(): string {
    return this.chain[0]!.name;
  }

  /** Backup provider names ready after the active one. */
  backupNames(): string[] {
    return this.chain.slice(1).map((p) => p.name);
  }

  async complete(req: ModelRequest): Promise<string> {
    const { text } = await this.completeWithStats(req);
    return text;
  }

  async completeWithStats(req: ModelRequest): Promise<{ text: string; stats: ModelCallStats }> {
    const errors: string[] = [];
    for (const provider of this.chain) {
      const parked = this.credits ? await this.credits.activeLimit(provider.name, this.now()) : undefined;
      if (parked) {
        errors.push(`${provider.name}: parked until ${parked.resetLabel ?? parked.resetsAt}`);
        continue;
      }
      try {
        const res = provider.completeWithStats
          ? await provider.completeWithStats(req)
          : { text: await provider.complete(req), stats: { model: provider.name, durationMs: 0, ok: true } };
        this.lastActive = provider.name;
        const tokens = (res.stats.inputTokens ?? 0) + (res.stats.outputTokens ?? 0);
        await this.credits?.recordUsage(provider.name, res.stats.costUsd ?? 0, tokens, this.now());
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${provider.name}: ${msg}`);
        if (this.credits && isRateLimitError(msg)) {
          await this.credits.recordLimit(provider.name, msg, this.now());
        }
      }
    }
    throw new Error(`All providers failed (${errors.join(' | ')})`);
  }

  close(): void {
    for (const p of this.chain) {
      (p as { close?: () => void }).close?.();
    }
  }
}
