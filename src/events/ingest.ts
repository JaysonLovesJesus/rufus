import { createHash } from 'node:crypto';
import type { EventReaction, EventSource, LosslessEvent } from '../types';

function makeId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)}`;
}

export function messageEvent(opts: {
  id?: string;
  channel: string;
  actor: string;
  text: string;
  timestamp: string;
  threadId?: string;
  deleted?: boolean;
  reactions?: EventReaction[];
  replyTo?: string;
  metadata?: Record<string, unknown>;
}): LosslessEvent {
  return {
    id: opts.id ?? makeId('msg', opts.channel, opts.actor, opts.timestamp, opts.text),
    source: 'message',
    kind: 'chat',
    timestamp: opts.timestamp,
    actor: opts.actor,
    channel: opts.channel,
    text: opts.text,
    ...(opts.threadId ? { threadId: opts.threadId } : {}),
    ...(opts.deleted !== undefined ? { deleted: opts.deleted } : {}),
    ...(opts.reactions?.length ? { reactions: opts.reactions } : {}),
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
}

export function genericEvent(opts: {
  id?: string;
  source: EventSource;
  kind: string;
  text: string;
  timestamp?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
}): LosslessEvent {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  return {
    id: opts.id ?? makeId(opts.source, opts.kind, timestamp, opts.text),
    source: opts.source,
    kind: opts.kind,
    timestamp,
    text: opts.text,
    ...(opts.actor ? { actor: opts.actor } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
}
