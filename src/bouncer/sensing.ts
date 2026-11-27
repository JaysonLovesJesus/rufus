import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Embedder } from '../embed';
import type { EventStore } from '../events/store';
import type { GapStore } from '../gaps/store';
import type { BouncerDecision, LosslessEvent } from '../types';
import type { Bouncer } from './bouncer';
import { featureText } from './training';
import { GapLens, withFeatures, type GapLook } from './gap-lens';
import { loadReplyPairs, ReplyProfile } from './reply-pairs';
import type { Triage } from './triage';

/** Slept events wait for a re-check until this many pile up... */
export const REVIEW_BATCH = 10;
/** ...or the oldest has waited this long, so a miss is caught while it still matters. */
export const REVIEW_MAX_WAIT_MS = 20 * 60_000;
/** One re-check call looks at no more than this many events. */
const REVIEW_MAX = 25;

const NO_LOOK: GapLook = { features: [], hints: [] };
const byRule = (e: LosslessEvent) => e.kind === 'owner_direct' || e.source === 'system' || e.source === 'watch';

/**
 * What happens between a sense and a wake: the event is given gap and reply-habit features, judged by the Bouncer
 * (with the cheap model's first call when it is unsure), and every confident SLEEP is queued for a later re-check.
 * Misses the re-check finds become WAKE labels and wake Rufus now; confirmations become SLEEP labels.
 */
export class SenseJudge {
  readonly lens: GapLens;
  private profile?: Promise<ReplyProfile>;
  private queue: Array<{ eventId: string; at: string }> = [];
  private backfilled = false;
  private reviewing = false;
  /** After a failed re-check, wait before trying again instead of calling the model on every heartbeat. */
  private failedAt = 0;
  private readonly statePath: string;

  constructor(
    private readonly opts: {
      workspaceDir: string;
      bouncer: Bouncer;
      gaps: GapStore;
      events: EventStore;
      embedder: Embedder;
      triage?: Triage;
      now?: () => Date;
    },
  ) {
    this.lens = new GapLens({ gaps: () => opts.gaps.list(), embedder: opts.embedder });
    this.statePath = path.join(opts.workspaceDir, 'sense-state', 'bouncer-review.json');
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  replyProfile(): Promise<ReplyProfile> {
    this.profile ??= loadReplyPairs(this.opts.workspaceDir).then((pairs) => new ReplyProfile(pairs));
    return this.profile;
  }

  /** Adds the gap and reply-habit features the Bouncer reads; events the rules always wake on are left as they are. */
  async prepare(event: LosslessEvent): Promise<{ event: LosslessEvent; look: GapLook }> {
    if (byRule(event)) return { event, look: NO_LOOK };
    const look = await this.lens.look(event).catch(() => NO_LOOK);
    const profile = await this.replyProfile();
    if (event.kind === 'owner_sent' && event.threadId) {
      // The owner answering a thread updates how he answers it.
      const last = (await this.opts.events.recent(2000))
        .filter((e) => e.threadId === event.threadId && e.kind !== 'owner_sent' && e.timestamp <= event.timestamp)
        .pop();
      if (last) profile.add(event.threadId, last.actor, Date.parse(event.timestamp) - Date.parse(last.timestamp));
    }
    const reply = profile.feature(event);
    return { event: withFeatures(event, [...look.features, ...(reply ? [reply] : [])]), look };
  }

  async judge(event: LosslessEvent, look: GapLook = NO_LOOK): Promise<BouncerDecision> {
    const d = await this.opts.bouncer.judge(event, { look, ...(this.opts.triage ? { triage: this.opts.triage } : {}) });
    if (d.backend === 'triage' && d.confidence >= 0.8) {
      // A sure cheap-model call teaches the local classifier, so it needs the cheap model less next time.
      await this.label(event, d.label).catch(() => undefined);
    } else if (d.label === 'SLEEP' && (d.backend === 'setfit' || d.backend === 'prototype')) {
      this.queue.push({ eventId: event.id, at: this.now().toISOString() });
    }
    return d;
  }

  private async label(event: LosslessEvent, label: 'WAKE' | 'SLEEP'): Promise<void> {
    await this.opts.bouncer.recordExample({ text: featureText(event), label, source: 'review', at: this.now().toISOString(), eventId: event.id });
  }

  private async loadCursor(): Promise<string | undefined> {
    try {
      return (JSON.parse(await fs.readFile(this.statePath, 'utf8')) as { reviewedUntil?: string }).reviewedUntil;
    } catch {
      return undefined;
    }
  }

  private async saveCursor(at: string): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ reviewedUntil: at }), 'utf8');
    await fs.rename(tmp, this.statePath);
  }

  /** Slept decisions logged since the last re-check, from before this process started. */
  private async backfill(): Promise<void> {
    if (this.backfilled) return;
    this.backfilled = true;
    const since = await this.loadCursor();
    if (!since) {
      // First run: start from now, so the first re-check is not a flood of old history.
      await this.saveCursor(this.now().toISOString()).catch(() => undefined);
      return;
    }
    const raw = await fs.readFile(path.join(this.opts.workspaceDir, 'decisions.jsonl'), 'utf8').catch(() => '');
    const seen = new Set(this.queue.map((q) => q.eventId));
    const old: Array<{ eventId: string; at: string }> = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line) as { at?: string; eventId?: string; label?: string; backend?: string };
        if (d.at && d.eventId && d.at > since && d.label === 'SLEEP' && (d.backend === 'setfit' || d.backend === 'prototype') && !seen.has(d.eventId)) old.push({ eventId: d.eventId, at: d.at });
      } catch {
        /* skip corrupt line */
      }
    }
    this.queue = [...old, ...this.queue];
  }

  /** True when a re-check is due: enough slept events, or one has waited too long. */
  async reviewDue(): Promise<boolean> {
    if (!this.opts.triage || this.reviewing) return false;
    if (this.now().getTime() - this.failedAt < REVIEW_MAX_WAIT_MS) return false;
    await this.backfill();
    if (!this.queue.length) return false;
    return this.queue.length >= REVIEW_BATCH || this.now().getTime() - Date.parse(this.queue[0]!.at) >= REVIEW_MAX_WAIT_MS;
  }

  /**
   * Re-checks one batch of slept events with the cheap model against the gap tree.
   * Returns the misses (to wake on now), each already labelled WAKE; the rest are labelled SLEEP.
   */
  async reviewSlept(opts: { force?: boolean } = {}): Promise<Array<{ event: LosslessEvent; decision: BouncerDecision }>> {
    if (!this.opts.triage || this.reviewing) return [];
    if (!opts.force && !(await this.reviewDue())) return [];
    await this.backfill();
    this.reviewing = true;
    const batch = this.queue.slice(0, REVIEW_MAX);
    try {
      const events = (await Promise.all(batch.map((b) => this.opts.events.get(b.eventId)))).filter((e): e is LosslessEvent => !!e);
      const verdicts = await this.opts.triage.review(events);
      const misses: Array<{ event: LosslessEvent; decision: BouncerDecision }> = [];
      for (const v of verdicts) {
        const event = events.find((e) => e.id === v.eventId);
        if (!event) continue;
        await this.label(event, v.label).catch(() => undefined);
        if (v.label === 'WAKE') {
          misses.push({ event, decision: { label: 'WAKE', confidence: 0.8, backend: 'review', reason: `re-check: ${v.reason || 'slept on something that mattered'}`, durationMs: 0, ...(v.gapId ? { gapIds: [v.gapId] } : {}) } });
        }
      }
      this.queue = this.queue.slice(batch.length);
      await this.saveCursor(batch[batch.length - 1]!.at).catch(() => undefined);
      return misses;
    } catch (err) {
      this.failedAt = this.now().getTime();
      throw err;
    } finally {
      this.reviewing = false;
    }
  }
}
