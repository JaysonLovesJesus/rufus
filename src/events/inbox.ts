import type { BouncerDecision, LosslessEvent, MessageSink } from '../types';
import { WATCH_MERGE_MS } from './watches';

/** One thing waiting for a wake: an owner message from any channel, or a sensed event the Bouncer let through. */
export interface InboxItem {
  event: LosslessEvent;
  decision?: BouncerDecision;
  /** Where replies go. Owner input only joins a wake that replies the same way (a voice call joins a voice wake). */
  route?: string;
  sink?: MessageSink;
  /** Called once the wake that handled this item has finished. */
  done?: () => void;
}

export interface WakeBatch {
  first: InboxItem;
  extras: InboxItem[];
  route: string;
}

export const DEFAULT_ROUTE = 'default';
const routeOf = (i: InboxItem) => i.route ?? DEFAULT_ROUTE;

export function isOwnerInput(e: LosslessEvent): boolean {
  return e.kind === 'owner_direct';
}

/**
 * The single wake queue every channel and sense feeds.
 * - Owner input runs ahead of queued sensor events, and queued owner messages on one route run as one wake.
 * - Watch timers due within a few minutes of each other run as one wake.
 * - A running wake drains new owner input on its route (`drainOwner`), so the owner can steer it mid-wake.
 */
export class WakeInbox {
  private items: InboxItem[] = [];
  private waiters: Array<() => void> = [];
  private joined: InboxItem[] = [];

  push(item: InboxItem): void {
    if (this.items.some((i) => i.event.id === item.event.id)) return;
    this.items.push(item);
    for (const w of this.waiters.splice(0)) w();
  }

  get size(): number {
    return this.items.length;
  }

  /** The next wake's batch, or undefined when nothing is waiting. */
  takeNow(): WakeBatch | undefined {
    if (!this.items.length) return undefined;
    const ownerIdx = this.items.findIndex((i) => isOwnerInput(i.event));
    const first = this.items[ownerIdx >= 0 ? ownerIdx : 0]!;
    const route = routeOf(first);
    let extras: InboxItem[];
    if (isOwnerInput(first.event)) {
      extras = this.items.filter((i) => i !== first && isOwnerInput(i.event) && routeOf(i) === route);
    } else if (first.event.source === 'watch') {
      const t0 = Date.parse(first.event.timestamp);
      extras = this.items.filter((i) => i !== first && i.event.source === 'watch' && Math.abs(Date.parse(i.event.timestamp) - t0) <= WATCH_MERGE_MS);
    } else {
      extras = [];
    }
    const taken = new Set([first, ...extras]);
    this.items = this.items.filter((i) => !taken.has(i));
    this.joined = [];
    return { first, extras, route };
  }

  /** Waits for the next batch; resolves undefined when the signal aborts. */
  async take(signal?: AbortSignal): Promise<WakeBatch | undefined> {
    for (;;) {
      if (signal?.aborted) return undefined;
      const batch = this.takeNow();
      if (batch) return batch;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  }

  /** Owner input on `route` that arrived while a wake runs: it joins that wake instead of waiting for its own. */
  drainOwner(route = DEFAULT_ROUTE): LosslessEvent[] {
    const hit = this.items.filter((i) => isOwnerInput(i.event) && routeOf(i) === route);
    if (!hit.length) return [];
    this.items = this.items.filter((i) => !hit.includes(i));
    this.joined.push(...hit);
    return hit.map((i) => i.event);
  }

  /** Items that joined the running wake through `drainOwner` (their `done` runs when it ends). */
  joinedItems(): InboxItem[] {
    return [...this.joined];
  }
}

/**
 * Runs wakes from the inbox one at a time until aborted. Senses keep polling while a wake runs, because they only push here.
 * A wake that throws is caught: the loop goes on, and `onError` can tell the owner.
 */
export async function runWakeLoop(opts: {
  inbox: WakeInbox;
  signal: AbortSignal;
  wake: (batch: WakeBatch, pollIncoming: () => Promise<LosslessEvent[]>) => Promise<void>;
  onError?: (batch: WakeBatch, err: Error) => Promise<void> | void;
}): Promise<void> {
  for (;;) {
    const batch = await opts.inbox.take(opts.signal);
    if (!batch) return;
    try {
      await opts.wake(batch, async () => opts.inbox.drainOwner(batch.route));
    } catch (err) {
      await Promise.resolve(opts.onError?.(batch, err instanceof Error ? err : new Error(String(err)))).catch(() => undefined);
    } finally {
      for (const i of [batch.first, ...batch.extras, ...opts.inbox.joinedItems()]) i.done?.();
    }
  }
}
