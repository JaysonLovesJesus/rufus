import { clip } from '../corpus/types';
import type { LoopRun } from '../engine/loop';
import type { Verdict } from '../engine/trust';

/**
 * Beeper-safe plain text for Master Loop items. Many chat apps (Beeper among them) do not render Telegram's inline
 * buttons, so every paused item is short text with a dead-simple reply:
 *
 *   [#1] Reply to Sam: "can we move to 3?"
 *   Draft: Sure, 3 works.
 *   Reply: 1 = accept, 2 = reject, or type your edit
 */

export type LoopReply =
  | { kind: 'decision'; ref?: number; verdict: Verdict; note?: string; edit?: string }
  | { kind: 'checkin' };

const ACCEPT = /^(1|y|ya|yes|yep|yeah|ok|okay|k|sure|approve|approved|accept|send|go|go ahead|👍|✅)[.!]*$/i;
const REJECT = /^(2|n|no|nope|nah|reject|skip|drop|cancel|❌|👎)[.!]*$/i;
const CHECKIN = /^(checkin|check in|check-in|now|what's waiting|whats waiting|batch)[?.!]*$/i;

/**
 * Reads a reply to a loop item, or `undefined` when the text is not one (it may be chat, or an answer to a flow card).
 *  - `1`, `y`, `yes`, `ok` ...        accept         `1 <note>`    accept with a note
 *  - `2`, `n`, `no` ...               reject         `2 <reason>`  reject with the reason (also `no: <reason>`)
 *  - `edit: <new text>`               edit (your version replaces the draft)
 *  - `#<n> ...`                       any of the above for item #n; `#<n> <text>` alone is an edit of #n
 *  - `checkin` / `now`                deliver everything batched right away
 */
export function parseLoopReply(text: string): LoopReply | undefined {
  let body = text.trim();
  if (!body) return undefined;
  if (CHECKIN.test(body)) return { kind: 'checkin' };
  let ref: number | undefined;
  const r = /^#\s*(\d{1,4})\b[\s:,.\-–—]*/.exec(body);
  if (r) {
    ref = Number(r[1]);
    body = body.slice(r[0].length).trim();
    if (!body) return undefined;
  }
  const withRef = <T extends object>(o: T): T & { ref?: number } => (ref !== undefined ? { ...o, ref } : o);
  const edit = /^edit\s*[:\-–—]?\s+([\s\S]+)$|^edit\s*:\s*([\s\S]+)$/i.exec(body);
  if (edit) {
    const t = (edit[1] ?? edit[2] ?? '').trim();
    return t ? withRef({ kind: 'decision' as const, verdict: 'edit' as const, edit: t }) : undefined;
  }
  if (ACCEPT.test(body)) return withRef({ kind: 'decision' as const, verdict: 'accept' as const });
  if (REJECT.test(body)) return withRef({ kind: 'decision' as const, verdict: 'reject' as const });
  const accept = /^1\s*[).:\-–—,]?\s+([\s\S]+)$/.exec(body);
  if (accept) return withRef({ kind: 'decision' as const, verdict: 'accept' as const, note: accept[1]!.trim() });
  const reject = /^(?:2\s*[).:\-–—,]?\s+|(?:no|reject|skip)\s*[:\-–—,]\s*)([\s\S]+)$/i.exec(body);
  if (reject) return withRef({ kind: 'decision' as const, verdict: 'reject' as const, note: reject[1]!.trim() });
  if (ref !== undefined) return { kind: 'decision', ref, verdict: 'edit', edit: body };
  return undefined;
}

const show = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** The draft inside a result, when it has one (`reply`, `text`, `draft`, `message`). */
export function draftOf(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  for (const k of ['reply', 'draft', 'text', 'message']) if (typeof r[k] === 'string' && (r[k] as string).trim()) return r[k] as string;
  return undefined;
}

/** What to type, for one stage. `multi`: several items are open, so each answer needs its number. */
export function replyHint(run: Pick<LoopRun, 'status'>, n: number, multi = false): string {
  const p = multi ? `#${n} ` : '';
  if (run.status === 'awaiting_human_plan') return `Reply: ${p}1 = go ahead, ${p}2 = drop it, or ${multi ? `#${n} ` : ''}type a better plan`;
  if (run.status === 'awaiting_human_execute') return `Reply: ${p}1 = done, ${p}2 = skip`;
  return `Reply: ${p}1 = accept, ${p}2 = reject, or ${multi ? `#${n} ` : ''}type your edit`;
}

/** One paused run as a few short plain-text lines. */
export function formatLoopItem(run: LoopRun, n: number, opts: { multi?: boolean } = {}): string {
  const urgent = run.urgency === 'urgent' ? '(urgent) ' : '';
  const who = run.signal.actor ?? run.signal.surface;
  const said = run.signal.text ? `${who}: "${clip(run.signal.text, 160)}"` : undefined;
  const lines: string[] = [];
  if (run.status === 'awaiting_human_plan') {
    lines.push(`[#${n}] ${urgent}Plan: ${clip(run.goal ?? run.actionType ?? run.handlerId, 160)}`);
    if (said) lines.push(said);
    if (run.question) lines.push(clip(run.question, 240));
  } else if (run.status === 'awaiting_human_execute') {
    lines.push(`[#${n}] ${urgent}Your step: ${clip(run.humanStep ?? run.goal ?? '', 200)}`);
    if (said && !(run.humanStep ?? '').includes(clip(run.signal.text ?? '', 40))) lines.push(said);
  } else {
    const draft = draftOf(run.result);
    lines.push(`[#${n}] ${urgent}${clip(said ?? run.goal ?? run.actionType ?? run.handlerId, 200)}`);
    if (draft !== undefined) lines.push(`Draft: ${clip(draft, 500)}`);
    else if (run.result !== undefined) lines.push(`Result: ${clip(show(run.result), 300)}`);
    else if (run.goal && said) lines.push(clip(run.goal, 200));
    if (run.verifyFailure) lines.push(`Check failed: ${clip(run.verifyFailure, 160)}`);
  }
  lines.push(replyHint(run, n, opts.multi));
  if (run.promotionHint) lines.push(run.promotionHint);
  return lines.join('\n');
}

/** Several items in one check-in message. */
export function formatCheckin(items: Array<{ run: LoopRun; n: number }>): string {
  if (!items.length) return 'All clear: nothing is waiting on you.';
  if (items.length === 1) return formatLoopItem(items[0]!.run, items[0]!.n);
  const head = `Check-in: ${items.length} waiting on you. Start each answer with its number, like "#${items[0]!.n} 1".`;
  return [head, ...items.map(({ run, n }) => formatLoopItem(run, n, { multi: true }))].join('\n\n');
}
