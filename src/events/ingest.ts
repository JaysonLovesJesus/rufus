import { createHash } from 'node:crypto';
import type { EventReaction, EventSource, LosslessEvent, MessageAudience } from '../types';

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
  audience?: MessageAudience;
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
    ...(opts.audience ? { audience: opts.audience } : {}),
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

/** The audience a message event carries, or the one its kind implies (the owner's chat with Rufus). */
export function audienceOf(e: LosslessEvent): MessageAudience | undefined {
  if (e.audience) return e.audience;
  if (e.source !== 'message') return undefined;
  const network = e.channel ? e.channel.charAt(0).toUpperCase() + e.channel.slice(1) : 'chat';
  if (e.kind === 'owner_direct') return { from: 'owner', to: 'rufus', direction: 'incoming', network, chatType: 'dm' };
  if (e.kind === 'assistant_sent') return { from: 'rufus', to: 'owner', direction: 'outgoing', network, chatType: 'dm' };
  return undefined;
}

const who = (name: string) => (/^owner$/i.test(name) ? 'the owner' : /^rufus$/i.test(name) ? 'you (Rufus)' : name);

/**
 * One line saying who wrote a message to whom, e.g. "Mom → the owner (WhatsApp DM)".
 * On the Desk "you" is Rufus, so a message written to the owner always says "the owner".
 */
export function describeAudience(a: MessageAudience): string {
  const from = who(a.from);
  if (a.chatType === 'group' || a.to === 'group') {
    return `${from} → group${a.chatTitle ? ` "${a.chatTitle}"` : ''} (${a.network} group)`;
  }
  const to = a.to === 'rufus' ? 'you (Rufus)' : a.to === 'contact' || (a.direction === 'outgoing' && a.from === 'owner') ? (a.chatTitle ?? 'someone') : 'the owner';
  const title = a.chatTitle && a.chatTitle !== a.from && a.chatTitle !== to ? ` "${a.chatTitle}"` : '';
  return `${from} → ${to} (${a.network} DM${title})`;
}

/** " / <who → whom>" for a message, " / <actor>" otherwise: the party part of a Desk event line. */
export function formatParty(e: LosslessEvent): string {
  const a = audienceOf(e);
  if (a) return ` / ${describeAudience(a)}`;
  return e.actor ? ` / ${e.actor}` : '';
}

/** True when a transcript holds no speech: empty, or only sound tags like "(keyboard clicking)" or "[music]". */
export function isNonSpeech(text: string): boolean {
  const rest = text
    .replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*/g, ' ')
    .replace(/[\s.,!?…-]+/g, '');
  return rest.length === 0;
}
