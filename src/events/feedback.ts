import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadWakes } from '../eval/flight-recorder';
import type { LosslessEvent } from '../types';

export type FeedbackLabel = 'approval' | 'pushback';

export interface FeedbackDeps {
  workspaceDir: string;
  /** Rufus's own sent message (`assistant_sent`) with exactly this text, if it is in the log. */
  findSent: (text: string) => Promise<LosslessEvent | undefined>;
  /** `RufusCore.recordFeedback`: labels the wake's trigger for the Bouncer and, on pushback, supersedes the claim. */
  recordFeedback: (event: LosslessEvent, feedback: FeedbackLabel) => Promise<void>;
  now?: () => Date;
}

/**
 * The owner reacting to one of Rufus's messages: a Speaker label (`training/speaker.jsonl`) for the message,
 * and `recordFeedback` on the message itself, which labels the event that woke Rufus to send it.
 */
export async function recordReactionFeedback(opts: FeedbackDeps & { reaction: LosslessEvent }): Promise<{ label?: FeedbackLabel; sentId?: string }> {
  const sentiment = opts.reaction.metadata?.sentiment;
  const label: FeedbackLabel | undefined = sentiment === 'positive' ? 'approval' : sentiment === 'negative' ? 'pushback' : undefined;
  if (!label) return {};
  const sentText = typeof opts.reaction.metadata?.reactedToText === 'string' ? opts.reaction.metadata.reactedToText : undefined;
  const sent = sentText ? await opts.findSent(sentText) : undefined;
  await fs.mkdir(path.join(opts.workspaceDir, 'training'), { recursive: true });
  await fs.appendFile(
    path.join(opts.workspaceDir, 'training', 'speaker.jsonl'),
    `${JSON.stringify({ at: (opts.now ?? (() => new Date()))().toISOString(), label: label === 'approval' ? 'good' : 'bad', emoji: opts.reaction.metadata?.emoji, text: sentText ?? null, messageId: opts.reaction.metadata?.messageId, ...(sent ? { sentId: sent.id } : {}) })}\n`,
    'utf8',
  );
  if (!sent) return { label };
  await opts.recordFeedback(sent, label);
  return { label, sentId: sent.id };
}

/**
 * The owner editing a message Rufus already answered: what Rufus said in reply was built on words the owner has
 * since changed, so those replies no longer stand (pushback supersedes them). The edit itself wakes Rufus as new input.
 */
export async function recordEditFeedback(opts: FeedbackDeps & { edit: LosslessEvent }): Promise<{ superseded: string[] }> {
  const original = typeof opts.edit.metadata?.editOf === 'string' ? opts.edit.metadata.editOf : undefined;
  if (!original) return { superseded: [] };
  const wakes = (await loadWakes(opts.workspaceDir, 300)).filter((w) => w.trigger.id === original);
  const superseded: string[] = [];
  for (const text of wakes.flatMap((w) => w.sentMessages ?? [])) {
    const sent = await opts.findSent(text);
    if (!sent || superseded.includes(sent.id)) continue;
    await opts.recordFeedback(sent, 'pushback');
    superseded.push(sent.id);
  }
  return { superseded };
}
