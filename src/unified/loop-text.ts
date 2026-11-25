import { clip } from '../corpus/types';
import type { LoopRun } from '../engine/loop';
import type { Verdict } from '../engine/trust';
import { CHIEF_ACTION_SURFACE } from '../chief/actions';

/**
 * Beeper-safe plain text for Master Loop items. Many chat apps (Beeper among them) do not render Telegram's inline
 * buttons, so every paused item is short text with a dead-simple reply:
 *
 *   Sam texted "can we move to 3?" — want me to reply "Sure, 3 works."? (1 to send, 2 to skip, or type your own version)
 *
 * No metadata tags like `(urgent)`: an urgent item simply starts with "Heads up:" and arrives right away.
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

/** What to type, for one stage, as a short parenthetical. `multi`: several items are open, so each answer needs its number. */
export function replyHint(run: Pick<LoopRun, 'status'> & { result?: unknown }, n: number, multi = false): string {
  const p = multi ? `#${n} ` : '';
  if (run.status === 'awaiting_human_plan') return `(${p}1 to go ahead, ${p}2 to drop it, or ${multi ? `#${n} + ` : 'type '}a better plan)`;
  if (run.status === 'awaiting_human_execute') return `(${p}1 when it's done, ${p}2 to skip)`;
  const send = draftOf(run.result) !== undefined;
  return `(${p}1 to ${send ? 'send' : 'go'}, ${p}2 to skip, or ${multi ? `#${n} + your` : 'type your'} own version)`;
}

const VERB: Record<string, string> = { chat: 'texted', email: 'emailed', sms: 'texted', phone: 'sent' };

/** "Draft a concise reply" -> "draft a concise reply" (but "SMS Sam" stays). */
const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
const sentence = (s: string): string => (/[.!?…"]$/.test(s) ? s : `${s}.`);

/**
 * One paused run, written like a human assistant texting: who said what, what Rufus would do, and how to answer.
 *   `Sam texted "Can we move to 3?" — want me to reply "Sure, 3 works."? (1 to send, 2 to skip, or type your own version)`
 * With several open, each starts with its number (`#2 ...`) so the answer can too.
 */
export function formatLoopItem(run: LoopRun, n: number, opts: { multi?: boolean } = {}): string {
  const lead = `${opts.multi ? `#${n} ` : ''}${run.urgency === 'urgent' ? 'Heads up: ' : ''}`;
  const who = run.signal.actor ?? 'Someone';
  const text = run.signal.text ? clip(run.signal.text, 160) : undefined;
  // Something you asked for in chat is not "someone said": it is your own request, so it reads as "ready to ...".
  const own = run.signal.surface === CHIEF_ACTION_SURFACE;
  const said = text && !own ? `${who} ${VERB[run.signal.surface] ?? 'said'} "${text}"` : undefined;
  const hint = replyHint(run, n, opts.multi);
  let body: string;
  if (run.status === 'awaiting_human_plan') {
    const goal = clip(run.goal ?? run.actionType ?? run.handlerId, 160);
    body = `${said ? `${said}. ` : ''}Want me to ${lowerFirst(goal).replace(/[.?!]+$/, '')}?${run.question ? ` ${clip(run.question, 240)}` : ''}`;
  } else if (run.status === 'awaiting_human_execute') {
    const step = clip(run.humanStep ?? run.goal ?? '', 200).replace(/[.]+$/, '');
    const showSaid = said && !(run.humanStep ?? '').includes(clip(run.signal.text ?? '', 40));
    body = `Your turn: ${step}${showSaid ? ` (${said})` : ''}.`;
  } else {
    const draft = draftOf(run.result);
    const goal = clip(run.goal ?? run.actionType ?? run.handlerId, 200);
    const action = own ? actionOf(run.result) : undefined;
    if (action) body = `Ready to ${action.tool}${action.to ? ` to ${action.to}` : ''}${draft !== undefined ? `: "${clip(draft, 500)}"` : ''} — good to go?`;
    else if (draft !== undefined) body = said ? `${said} — want me to reply "${clip(draft, 500)}"?` : `${goal.replace(/[.?!]+$/, '')}: "${clip(draft, 500)}" — good to go?`;
    else if (run.result !== undefined) body = `${said ? `${said}. ` : ''}${sentence(goal)} Here's what I've got: ${clip(show(run.result), 300)} — look right?`;
    else body = said ? `${said}. ${sentence(goal)} OK?` : `${sentence(goal)} OK?`;
    if (run.verifyFailure) body += ` (My own check flagged it: ${clip(run.verifyFailure, 160)}.)`;
  }
  // "Heads up: your turn ..." reads better than "Heads up: Your turn ...". Names stay capitalized.
  if (run.urgency === 'urgent' && /^(Your|Want|Ready) /.test(body)) body = body[0]!.toLowerCase() + body.slice(1);
  const lines = [`${lead}${body} ${hint}`];
  if (run.promotionHint) lines.push(run.promotionHint);
  return lines.join('\n');
}

/** The tool and recipient of a chat-requested action's result (`{ tool, args }`). */
function actionOf(result: unknown): { tool: string; to?: string } | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as { tool?: unknown; args?: Record<string, unknown> };
  if (typeof r.tool !== 'string') return undefined;
  const to = ['to', 'chatTitle', 'recipient', 'chatId', 'command'].map((k) => r.args?.[k]).find((v): v is string => typeof v === 'string' && !!v.trim());
  return { tool: r.tool, ...(to ? { to } : {}) };
}

/** Several items in one check-in message. */
export function formatCheckin(items: Array<{ run: LoopRun; n: number }>): string {
  if (!items.length) return 'All clear: nothing is waiting on you.';
  if (items.length === 1) return formatLoopItem(items[0]!.run, items[0]!.n);
  const head = `${items.length} things waiting on you. Start each answer with its number, like "#${items[0]!.n} 1".`;
  return [head, ...items.map(({ run, n }) => formatLoopItem(run, n, { multi: true }))].join('\n\n');
}
