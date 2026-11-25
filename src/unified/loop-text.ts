import { clip } from '../corpus/types';
import type { LoopRun } from '../engine/loop';
import type { Verdict } from '../engine/trust';
import { CHIEF_ACTION_SURFACE } from '../chief/actions';

/**
 * Beeper-safe plain text for Master Loop items. Many chat apps (Beeper among them) do not render Telegram's inline
 * buttons, so every paused item is short text with a dead-simple reply:
 *
 *   Sam texted "can we move to 3?" — want me to reply "Sure, 3 works."? (1 to send, 2 to skip, or edit: your own version)
 *
 * No metadata tags like `(urgent)`: an urgent item simply starts with "Heads up:" and arrives right away.
 */

export type LoopReply =
  | { kind: 'decision'; ref?: number; verdict: Verdict; note?: string; edit?: string }
  | { kind: 'checkin' };

/**
 * v15, Ironclad Send Safety: only explicit, unambiguous commands are loop replies. Normal chat and voice notes NEVER are,
 * so they always reach the Chief of Staff and can never approve, edit or send anything.
 *
 *   accept   `1`, `send`, `approve`, `yes`, `y`
 *   reject   `2`, `skip`, `reject`, `no`, `n`             (with a short reason: `2 <reason>`, `skip <reason>`, `reject <reason>`)
 *   edit     `edit: <new text>`                          (only with the `edit:` keyword)
 *
 * Bare forms count only when exactly one item is open and the whole message is just the command. `#<n> ...` names the
 * item and always works: `#2 send`, `#2 skip wrong person`, `#2 edit: See you at 8`.
 */
const ACCEPT_WORDS = '1|send|approve|yes|y';
const REJECT_WORDS = '2|skip|reject|no|n';
const ACCEPT = new RegExp(`^(?:${ACCEPT_WORDS})[.!]*$`, 'i');
const REJECT = new RegExp(`^(?:${REJECT_WORDS})[.!]*$`, 'i');
/** `2 too formal`, `skip: not now`, `reject - wrong person`. Bare form: `no`/`n` never take a reason ("no worries ..." is chat). */
const REJECT_REASON_BARE = /^(?:2|skip|reject)(?:\s*[:,.\-–—)]\s*|\s+)(\S[\s\S]*)$/i;
/** With a number, every verdict may carry a reason: `#1 1 looks good`, `#2 no wrong person`. */
const ACCEPT_REASON_REF = new RegExp(`^(?:${ACCEPT_WORDS})(?:\\s*[:,.\\-–—)]\\s*|\\s+)(\\S[\\s\\S]*)$`, 'i');
const REJECT_REASON_REF = new RegExp(`^(?:${REJECT_WORDS})(?:\\s*[:,.\\-–—)]\\s*|\\s+)(\\S[\\s\\S]*)$`, 'i');
const EDIT = /^edit\s*:\s*(\S[\s\S]*)$/i;
const CHECKIN = /^(checkin|check in|check-in|now|what's waiting|whats waiting|batch)[?.!]*$/i;
const REF = /^#\s*(\d{1,4})\b[\s:,.\-–—]*/;
/** A reason is a short note, never a paragraph or a voice note. */
export const MAX_REASON_CHARS = 120;

const shortReason = (s: string): string | undefined => {
  const t = s.trim();
  return t && t.length <= MAX_REASON_CHARS && !/\n/.test(t) ? t : undefined;
};

/**
 * Reads a reply to a loop item, or `undefined` when the text is not one (it is chat, or an answer to a flow card).
 * `pendingCount`: how many loop items are open on the human's screen. Bare verdicts and a bare `edit:` count only when it
 * is exactly 1; `#<n>` forms always count. Anything else, including any free-form sentence, is `undefined`.
 */
export function parseLoopReply(text: string, pendingCount = 0): LoopReply | undefined {
  let body = text.trim();
  if (!body) return undefined;
  if (CHECKIN.test(body)) return { kind: 'checkin' };
  const r = REF.exec(body);
  if (r) {
    const ref = Number(r[1]);
    body = body.slice(r[0].length).trim();
    if (!body) return undefined;
    const edit = EDIT.exec(body);
    if (edit) return { kind: 'decision', ref, verdict: 'edit', edit: edit[1]!.trim() };
    if (ACCEPT.test(body)) return { kind: 'decision', ref, verdict: 'accept' };
    if (REJECT.test(body)) return { kind: 'decision', ref, verdict: 'reject' };
    const acc = ACCEPT_REASON_REF.exec(body);
    const accNote = acc ? shortReason(acc[1]!) : undefined;
    if (accNote) return { kind: 'decision', ref, verdict: 'accept', note: accNote };
    const rej = REJECT_REASON_REF.exec(body);
    const rejNote = rej ? shortReason(rej[1]!) : undefined;
    if (rejNote) return { kind: 'decision', ref, verdict: 'reject', note: rejNote };
    return undefined; // "#2 <free text>" is NOT an edit: edits need the `edit:` keyword
  }
  if (pendingCount !== 1) return undefined;
  const edit = EDIT.exec(body);
  if (edit) return { kind: 'decision', verdict: 'edit', edit: edit[1]!.trim() };
  if (ACCEPT.test(body)) return { kind: 'decision', verdict: 'accept' };
  if (REJECT.test(body)) return { kind: 'decision', verdict: 'reject' };
  const rej = REJECT_REASON_BARE.exec(body);
  const note = rej ? shortReason(rej[1]!) : undefined;
  if (note) return { kind: 'decision', verdict: 'reject', note };
  return undefined;
}

/**
 * True when the text is a bare verdict that WOULD count with exactly one item open (`1`, `send`, `2 too long`,
 * `edit: ...`), so the daemon can ask for the item's number when several are open instead of guessing.
 */
export function isBareVerdict(text: string): boolean {
  return parseLoopReply(text, 1)?.kind === 'decision' && !REF.test(text.trim());
}

/** `#<n> <something>` that is not a valid loop reply (`#1 see you at 8`): the daemon explains the exact forms. */
export function refOf(text: string): number | undefined {
  const r = REF.exec(text.trim());
  return r ? Number(r[1]) : undefined;
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
  if (run.status === 'awaiting_human_plan') return `(${p}1 to go ahead, ${p}2 to drop it, or ${p}edit: a better plan)`;
  if (run.status === 'awaiting_human_execute') return `(${p}1 when it's done, ${p}2 to skip)`;
  const send = draftOf(run.result) !== undefined;
  return `(${p}1 to ${send ? 'send' : 'go'}, ${p}2 to skip, or ${p}edit: your own version)`;
}

const VERB: Record<string, string> = { chat: 'texted', email: 'emailed', sms: 'texted', phone: 'sent' };

/** "Draft a concise reply" -> "draft a concise reply" (but "SMS Sam" stays). */
const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
const sentence = (s: string): string => (/[.!?…"]$/.test(s) ? s : `${s}.`);

/**
 * One paused run, written like a human assistant texting: who said what, what Rufus would do, and how to answer.
 *   `Sam texted "Can we move to 3?" — want me to reply "Sure, 3 works."? (1 to send, 2 to skip, or edit: your own version)`
 * With several open, each starts with its number (`#2 ...`) so the answer can too.
 */
/** What they said, for one line: a folded burst shows its newest messages, oldest first. */
export function quoteOf(text: string, max = 160): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const recent = lines.slice(-3);
  const shown = `${lines.length > recent.length ? '… ' : ''}${recent.join(' / ')}`;
  return shown.length > max ? `…${shown.slice(shown.length - max + 1)}` : shown;
}

const isTodo = (run: LoopRun): boolean => run.status === 'awaiting_human_execute' && (run.actionType ?? '').startsWith('todo.');

/**
 * v16, one item inside a check-in: two short lines, no instructions (the check-in says how to answer once).
 *   #1 Mom: "You okay today?"
 *   → "All good, you?"
 */
export function formatCheckinItem(run: LoopRun, n: number): string {
  const who = run.signal.actor ?? 'Someone';
  const own = run.signal.surface === CHIEF_ACTION_SURFACE;
  const said = run.signal.text && !own ? `${who}: "${quoteOf(run.signal.text)}"` : undefined;
  const lead = `#${n} ${run.urgency === 'urgent' ? 'Heads up: ' : ''}`;
  if (isTodo(run)) return `${lead}To do: ${clip(run.humanStep ?? run.goal ?? '', 160)}${said ? `\n(${said})` : ''}`;
  const draft = run.status === 'awaiting_human_verify' ? draftOf(run.result) : undefined;
  if (said && draft !== undefined && !own) return `${lead}${said}\n→ "${clip(draft, 500)}"`;
  return formatLoopItem(run, n, { multi: true, hint: false });
}

export function formatLoopItem(run: LoopRun, n: number, opts: { multi?: boolean; hint?: boolean } = {}): string {
  const lead = `${opts.multi ? `#${n} ` : ''}${run.urgency === 'urgent' ? 'Heads up: ' : ''}`;
  const who = run.signal.actor ?? 'Someone';
  const text = run.signal.text ? clip(run.signal.text, 160) : undefined;
  // Something you asked for in chat is not "someone said": it is your own request, so it reads as "ready to ...".
  const own = run.signal.surface === CHIEF_ACTION_SURFACE;
  const said = text && !own ? `${who} ${VERB[run.signal.surface] ?? 'said'} "${text}"` : undefined;
  const hint = opts.hint === false ? '' : replyHint(run, n, opts.multi);
  let body: string;
  if (isTodo(run)) {
    // A to-do someone handed you: the task first, who asked in brackets. Nothing is ever sent for it.
    body = `${clip(run.humanStep ?? run.goal ?? '', 200).replace(/[.]+$/, '')}${run.signal.text ? ` (${who}: "${quoteOf(run.signal.text)}")` : ''}`;
  } else if (run.status === 'awaiting_human_plan') {
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
  const lines = [`${lead}${body}${hint ? ` ${hint}` : ''}`];
  if (run.promotionHint) lines.push(run.promotionHint);
  return lines.join('\n');
}

/** Who a run's draft goes to: the result's recipient, the action's `to`, or whoever sent the message. */
export function recipientOf(run: Pick<LoopRun, 'result' | 'signal'>): string {
  const r = run.result && typeof run.result === 'object' ? (run.result as Record<string, unknown>) : {};
  const args = r.args && typeof r.args === 'object' ? (r.args as Record<string, unknown>) : {};
  const pick = [r.to, args.to, args.chatTitle, args.recipient, r.chatTitle, run.signal.actor, args.chatId, r.chatId].find((v): v is string => typeof v === 'string' && !!v.trim());
  return pick ?? 'them';
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
/**
 * v16: several items in one check-in, read like a person catching you up: urgent first, two short lines each, and how
 * to answer said once at the end (never repeated per item).
 */
export function formatCheckin(items: Array<{ run: LoopRun; n: number }>): string {
  if (!items.length) return 'All clear: nothing is waiting on you.';
  if (items.length === 1) return formatLoopItem(items[0]!.run, items[0]!.n);
  const ordered = [...items].sort((a, b) => Number(b.run.urgency === 'urgent') - Number(a.run.urgency === 'urgent') || a.n - b.n);
  const drafts = ordered.filter(({ run }) => run.status === 'awaiting_human_verify');
  const todos = ordered.filter(({ run }) => run.status !== 'awaiting_human_verify');
  const how: string[] = [];
  if (drafts.length) how.push(`Answer with the number: "#${drafts[0]!.n} send", "#${drafts[0]!.n} skip" or "#${drafts[0]!.n} edit: your version".`);
  if (todos.length) how.push(`"#${todos[0]!.n} 1" when ${todos.length === 1 ? 'that one is' : 'one is'} done, "#${todos[0]!.n} 2" to drop it.`);
  return [`Catching you up on ${items.length}:`, ...ordered.map(({ run, n }) => formatCheckinItem(run, n)), how.join(' ')].join('\n\n');
}
