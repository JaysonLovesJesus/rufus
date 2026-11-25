import type { LoopRun, MasterLoop } from './loop';
import { AWAITING } from './loop';
import type { BeeperMessage } from '../tools/beeper-api';
import type { ToolContext } from '../tools/tools';
import { assignNumbers, loadStartState, saveStartState, type StartState } from '../unified/state';

/**
 * v24a Bidirectional Code <-> AI Cross-Verification.
 *
 *  - Code Verifies (after the AI works): `detectUnbackedActionClaims` reads a model's reply and flags every sentence where
 *    it says it DID something (cleared, sent, scheduled, reacted, started a mission, saved a note...) when no matching
 *    tool actually ran and succeeded in that turn. "I've cleared them" with no `pending.clear` call is a hallucination,
 *    and code catches it before the human ever reads it.
 *  - Code Prepares (before the AI works): `isMessageAlreadyHandled` / `pruneHandledPendingItems` check live Beeper
 *    messages, so a Verify item the human already answered (a text reply or an emoji reaction) is dismissed at $0
 *    instead of becoming a stale nudge.
 */

// ---------- Code Verifies: unbacked action claims ----------

/** A tool call made in one chat turn. `ok` is true only when it actually ran and succeeded (a queued call is `false`). */
export interface VerifiedToolCall {
  name: string;
  ok: boolean;
}

/** What kind of state change a reply claims it made. */
export type ActionClaimKind = 'clear' | 'send' | 'react' | 'schedule' | 'autonomy' | 'mission' | 'remember';

/** `claimed_<kind>_without_tool`, e.g. `claimed_clear_without_tool`. */
export type ActionClaimViolation = `claimed_${ActionClaimKind}_without_tool`;

interface ClaimRule {
  kind: ActionClaimKind;
  /** Past-tense verb phrases that claim the action happened (matched after a first-person or passive subject). */
  verbs: string;
  /** Allow the passive form ("they're cleared", "it's sent")? Off where it reads like a fact ("it's scheduled for 3"). */
  passive: boolean;
  /** A successful call to one of these tools backs the claim. */
  backedBy: (tool: string) => boolean;
}

const CLAIM_RULES: readonly ClaimRule[] = [
  {
    kind: 'clear',
    verbs:
      "cleared|dismissed|closed (?:them|those|these|it|that|all|everything)(?: \\w+)? out|marked (?:them|those|these|it|that|all(?: of them)?|everything|#?\\d+(?:\\s*[-–]\\s*#?\\d+)?)(?: \\w+)? (?:as )?(?:done|handled|complete|completed|resolved|read)|removed (?:them|those|these|it|that|all of them|everything) from (?:the|your|my) (?:list|queue|pending|inbox)|wiped (?:them|those|the list)|took (?:them|those|it) off (?:the|your) list",
    passive: true,
    backedBy: (t) => t === 'pending.clear',
  },
  {
    kind: 'send',
    verbs: 'sent|replied|responded|texted|messaged|emailed|forwarded|shot (?:them|him|her) a (?:text|message|note)|let (?:them|him|her) know|told (?:them|him|her)',
    passive: true,
    backedBy: (t) => /(?:^|\.)(?:send|reply|forward)\b|\.send$|^gmail\.(?:send|draft)$/.test(t),
  },
  {
    kind: 'react',
    verbs: 'reacted|added (?:a|an|the) (?:reaction|emoji)|liked (?:it|that|the message|their message)|hearted|thumbs[- ]upped',
    passive: false,
    backedBy: (t) => /react/.test(t),
  },
  {
    kind: 'schedule',
    verbs:
      "scheduled|rescheduled|booked|moved (?:it|that|this|them|the \\w+|your \\w+|\\w+ to)|blocked (?:off|out)|put (?:it|that|this|them) on (?:the|your) (?:calendar|schedule)|added (?:it|that|this|them|an? \\w+(?: \\w+)?) to (?:the|your) (?:calendar|schedule)|deleted (?:it|that|the (?:event|meeting|block))|cancel(?:l)?ed (?:it|that|the (?:event|meeting|block|call))|removed (?:it|that|the \\w+(?: \\w+)? block|the (?:event|meeting)) from (?:the|your) (?:calendar|schedule)|removed (?:the )?\\w+ block",
    passive: false,
    backedBy: (t) => t === 'anchor.update' || (/^calendar\./.test(t) && !/\.(?:read|list|search)$/.test(t)),
  },
  {
    kind: 'autonomy',
    verbs: 'paused (?:everything|autonomy|all|it|myself|auto)|resumed (?:everything|autonomy|auto|normal)|turned (?:off|on) (?:autonomy|auto|the kill switch)|hit the kill switch|demoted|promoted',
    passive: false,
    backedBy: (t) => /autonomy|trust|kill/.test(t),
  },
  {
    kind: 'mission',
    verbs:
      'started (?:a|the|your|that) (?:background )?(?:mission|research|deep dive)|kicked off (?:a|the)? ?(?:background )?(?:mission|research)|started (?:researching|digging|looking into)|launched (?:a|the) (?:mission|research)|cancel(?:l)?ed (?:the|that) mission|stopped (?:the|that) mission',
    passive: false,
    backedBy: (t) => /^mission\.(?:start|cancel)$/.test(t),
  },
  {
    kind: 'remember',
    verbs: "saved (?:that|it|this|your)|noted (?:that|it|this)|made a note|remembered (?:that|it)|stored (?:that|it)|added (?:that|it|this) to (?:my|your) (?:notes|memory)",
    passive: false,
    backedBy: (t) => t === 'remember',
  },
];

/** A sentence that only offers, asks, hedges or denies is not a claim ("want me to clear them?", "I haven't sent it"). */
const NOT_A_CLAIM =
  /\b(?:not|never|no longer|haven'?t|hasn'?t|didn'?t|don'?t|can'?t|cannot|couldn'?t|won'?t|wasn'?t|weren'?t|isn'?t|aren'?t|unable|if|once|unless|want me|should i|shall i|would you like|do you want|reply 1|say 1|say yes|your (?:yes|ok|approval)|ready for|ready to|waiting (?:for|on)|queued|draft(?:ed)?|pending your|after you|when you|can i|could i|i can|i could|i'?ll|i will|i'?d|i would|i'?m going to|let me)\b/i;
const FIRST_PERSON = "\\b(?:i|we)(?:'ve|'d| have| had)?(?:\\s+(?:just|already|now|also|quickly|gone ahead and|went ahead and|have|all|both))*\\s+";
const PASSIVE_SUBJECT =
  "\\b(?:it|they|that|those|these|all|everything|both|each|all of them|all \\d+|the items?|the messages?|the reply|the text|the message|your reply)(?:'s|'re| is| are| has been| have been| was| were| got)?(?:\\s+(?:now|all|been|already|both|officially))*\\s+";
const LEAD_IN = "^(?:(?:ok(?:ay)?|done|sure|got it|all set|perfect|great|yep|yes|my bad|no problem|sorry|alright|right)[,!.:;\\s—–-]*)*";

const compiled = CLAIM_RULES.map((r) => ({
  ...r,
  first: new RegExp(`${FIRST_PERSON}(?:${r.verbs})\\b`, 'i'),
  passiveRe: r.passive ? new RegExp(`${PASSIVE_SUBJECT}(?:${r.verbs})\\b`, 'i') : undefined,
  lead: new RegExp(`${LEAD_IN}(?:${r.verbs})\\b`, 'i'),
}));

/** A reply split into clauses: sentences, and the parts of a sentence joined by "so", "and", ";", a dash or a bullet. */
function clausesOf(reply: string): string[] {
  return reply
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .split(/(?<=[.!?])\s+|\n+|\s+-{3,}\s+|;\s*|\s+[—–]\s+|,\s+(?:(?:so|and|then)\s+)?|\s+so\s+(?=i\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The kinds of action a reply claims it performed this turn (in order, each once), ignoring questions, offers and denials. */
export function detectActionClaims(reply: string): ActionClaimKind[] {
  const out: ActionClaimKind[] = [];
  for (const clause of clausesOf(reply)) {
    if (/\?\s*$/.test(clause) || NOT_A_CLAIM.test(clause)) continue;
    for (const r of compiled) {
      if (out.includes(r.kind)) continue;
      if (r.first.test(clause) || r.passiveRe?.test(clause) || r.lead.test(clause)) out.push(r.kind);
    }
  }
  return out;
}

/**
 * Every action a reply says it just did, with no successful matching tool call in `toolCalls` (this turn's calls).
 * Returns `claimed_<kind>_without_tool` reasons, e.g. `["claimed_clear_without_tool"]`. Empty: the reply is backed.
 */
export function detectUnbackedActionClaims(reply: string, toolCalls: ReadonlyArray<VerifiedToolCall>): ActionClaimViolation[] {
  const ran = toolCalls.filter((c) => c.ok).map((c) => c.name);
  const out: ActionClaimViolation[] = [];
  for (const kind of detectActionClaims(reply)) {
    const rule = CLAIM_RULES.find((r) => r.kind === kind)!;
    if (!ran.some((t) => rule.backedBy(t))) out.push(`claimed_${kind}_without_tool`);
  }
  return out;
}

/** The corrective instruction for one retry after the verifier rejected a draft. */
export const VERIFIER_RETRY_PROMPT =
  "CODE VERIFIER REJECTED YOUR DRAFT: you claimed you performed an action without calling a tool. Either call the appropriate tool now, or state honestly that you haven't done it yet.";

const HONEST: Record<ActionClaimKind, string> = {
  clear: "I haven't actually cleared anything yet",
  send: "nothing has actually been sent yet",
  react: "I haven't actually reacted to anything",
  schedule: "your schedule hasn't actually changed",
  autonomy: "autonomy settings haven't actually changed (say \"pause\" or \"resume\" to do it)",
  mission: "no background mission is actually running yet",
  remember: "I haven't actually saved that yet",
};

/** A plain correction appended by code when the reply still claims an action no tool performed. */
export function honestCorrection(violations: readonly string[]): string {
  const kinds = violations.map((v) => /^claimed_(\w+)_without_tool$/.exec(v)?.[1]).filter((k): k is ActionClaimKind => !!k && k in HONEST);
  if (!kinds.length) return '';
  const parts = kinds.map((k) => HONEST[k]);
  const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Correction: ${joined}. No tool ran for that, so tell me again if you want it done.`;
}

// ---------- Code Prepares: live Beeper staleness ----------

/** The minimal shape of a Beeper message this check reads. */
export type StalenessMessage = Pick<BeeperMessage, 'text'> & Partial<Pick<BeeperMessage, 'id' | 'isSender' | 'isDeleted' | 'timestamp' | 'reactions'>>;

const ms = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * True when the human already handled an incoming message: they sent a text reply in that chat AFTER it arrived, or
 * reacted (an `isMe` reaction) to it, or to a later message from the other side in the same chat. `messages` are
 * recent messages of that one chat (as `beeper.read` returns them).
 */
export function isMessageAlreadyHandled(messages: ReadonlyArray<StalenessMessage>, incomingTimestamp: string, incomingMessageId?: string): boolean {
  const at = ms(incomingTimestamp);
  for (const m of messages) {
    if (!m || m.isDeleted) continue;
    const t = ms(m.timestamp);
    if (m.isSender) {
      if (Number.isFinite(at) && Number.isFinite(t) && t > at && (m.text ?? '').trim()) return true;
      continue;
    }
    const mine = (m.reactions ?? []).some((r) => r?.isMe === true);
    if (!mine) continue;
    if (incomingMessageId !== undefined && m.id === incomingMessageId) return true;
    if (Number.isFinite(at) && Number.isFinite(t) && t >= at) return true;
  }
  return false;
}

/** The tools `pruneHandledPendingItems` needs: just `has` and `call` (a ToolRegistry fits). */
export interface PruneTools {
  has(name: string): boolean;
  call<R = unknown>(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<R>;
}

export interface PruneReport {
  /** Run ids dismissed because the human already answered or reacted in Beeper. */
  pruned: string[];
  /** Chats read. */
  checked: number;
  /** True when `beeper.read` is not available, so nothing was checked. */
  skipped?: boolean;
  /** Chats that could not be read (Beeper offline...). Never fatal. */
  errors: string[];
}

/** Why a pending item was dismissed by code. */
export const ALREADY_HANDLED_REASON = 'already handled: you replied or reacted in that chat yourself';

/** The incoming message a waiting chat item is about: its chat, latest timestamp and message id. */
export function incomingOf(run: Pick<LoopRun, 'signal'>): { chatId: string; timestamp: string; messageId?: string } | undefined {
  const s = run.signal;
  const chatId = typeof s.data?.chatId === 'string' && s.data.chatId ? s.data.chatId : undefined;
  if (s.surface !== 'chat' || !chatId) return undefined;
  const folded = Array.isArray(s.data?.messages) ? (s.data!.messages as Array<{ at?: unknown }>) : [];
  const lastAt = folded.map((m) => (typeof m?.at === 'string' ? m.at : '')).filter(Boolean).sort().pop();
  const timestamp = lastAt && (!s.timestamp || lastAt > s.timestamp) ? lastAt : s.timestamp;
  if (!timestamp) return undefined;
  const messageId = typeof s.data?.messageId === 'string' ? s.data.messageId : undefined;
  return { chatId, timestamp, ...(messageId ? { messageId } : {}) };
}

const withTimeout = <T>(p: Promise<T>, msTimeout: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${msTimeout} ms`)), msTimeout);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

/**
 * Code Prepares, at $0: checks every pending Beeper reply item against the live chat (`beeper.read`) and dismisses the
 * ones the human already answered or reacted to, so Rufus never nudges about a handled message. Dismissed items are
 * marked `expired` with `dismissed: true` (nothing is sent, Earned Trust is untouched) and lose their short number.
 *
 * `state`: the live start state to update in place; omitted, `start-state.json` in `dir` is loaded and saved.
 * Beeper offline or `beeper.read` missing: nothing changes.
 */
export async function pruneHandledPendingItems(
  dir: string,
  loop: Pick<MasterLoop, 'pending' | 'dismissRun'>,
  tools: PruneTools,
  state?: StartState,
  opts: { now?: Date; limit?: number; timeoutMs?: number } = {},
): Promise<PruneReport> {
  const report: PruneReport = { pruned: [], checked: 0, errors: [] };
  if (!tools.has('beeper.read')) return { ...report, skipped: true };
  const now = opts.now ?? new Date();
  const pending = await loop.pending();
  const byChat = new Map<string, Array<{ run: LoopRun; incoming: NonNullable<ReturnType<typeof incomingOf>> }>>();
  for (const run of pending) {
    const incoming = incomingOf(run);
    if (!incoming) continue;
    byChat.set(incoming.chatId, [...(byChat.get(incoming.chatId) ?? []), { run, incoming }]);
  }
  if (!byChat.size) return report;
  for (const [chatId, items] of byChat) {
    let messages: unknown;
    try {
      messages = await withTimeout(tools.call<unknown>('beeper.read', { chatId, limit: opts.limit ?? 30 }, { dir, now, stage: 'execute' }), opts.timeoutMs ?? 8_000);
    } catch (err) {
      report.errors.push(`${chatId}: ${(err as Error).message}`);
      continue;
    }
    report.checked++;
    if (!Array.isArray(messages)) continue;
    const msgs = messages.filter((m): m is StalenessMessage => !!m && typeof m === 'object' && typeof (m as StalenessMessage).text === 'string');
    for (const { run, incoming } of items) {
      if (!isMessageAlreadyHandled(msgs, incoming.timestamp, incoming.messageId)) continue;
      const after = await loop.dismissRun(run.id, ALREADY_HANDLED_REASON);
      if (!AWAITING.includes(after.status)) report.pruned.push(run.id);
    }
  }
  if (report.pruned.length) {
    const live = state ?? (await loadStartState(dir));
    assignNumbers(live, await loop.pending());
    if (!state) await saveStartState(dir, live);
  }
  return report;
}
