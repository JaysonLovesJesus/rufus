import { promises as fs } from 'node:fs';
import path from 'node:path';
import { localDate, protectedNow, toMinutes, type Anchor } from '../anchor/anchor';
import { loadChatHistory, KEEP_CHAT_TURNS, type ChatTurn } from '../chief/history';
import { clip } from '../corpus/types';
import { LOOP_RUNS_DIR, type LoopRun } from '../engine/loop';
import { TrustStore, type TrustRecord } from '../engine/trust';
import { DEFAULT_QUIET_HOURS, inQuietHours } from './heartbeat';

/**
 * v18, the Daily Self-Review Loop. Once a day, in the evening (after `after`, default 19:00, and before quiet hours; never
 * in an Anchor protected window such as a Sabbath), code looks back over the last 24 hours:
 *
 *   - `<workspace>/chat-history.jsonl`: proactive nudges sent, and how many were answered vs. ignored;
 *   - `<workspace>/loop-runs/`: Verify items accepted / edited / rejected / expired, rejections per action type, and
 *     failed or missing tool calls;
 *   - `<workspace>/trust.json`: actions that earned a promotion (`promotionSuggested`).
 *
 * It always appends one structured record to `<workspace>/self-review.jsonl`. Only when there is something actionable
 * (an action ready for Earned Trust promotion, repeated rejections of one kind of action, a tool failing again and again)
 * does it say ONE brief, natural evening note. Otherwise it stays silent. Code only, $0.
 */

export const SELF_REVIEW_FILE = 'self-review.jsonl';
export const DEFAULT_REVIEW_AFTER = '19:00';
/** A proactive message with no reply from the human within this long counts as ignored. */
export const DEFAULT_NUDGE_ANSWER_MS = 2 * 3_600_000;
/** Rejections of one action type in a day before it is worth mentioning. */
export const DEFAULT_REPEAT_REJECTIONS = 3;
/** Failures of one tool in a day before it is worth mentioning. */
export const DEFAULT_REPEAT_TOOL_FAILURES = 3;
const WINDOW_MS = 24 * 3_600_000;
/** Proactive bubbles this close together are one nudge. */
const BUBBLE_GAP_MS = 2 * 60_000;

export interface SelfReviewOptions {
  /** Local `HH:MM` after which the day's review may run. Default `19:00`. */
  after?: string;
  /** Never inside these hours (`HH:MM-HH:MM`). Default: the heartbeat's, else `22:00-07:00`. `false`: none. */
  quietHours?: string | false;
  answerWindowMs?: number;
  repeatRejections?: number;
  repeatToolFailures?: number;
}

/** What `rufus start` remembers about the review (inside `start-state.json`). */
export interface SelfReviewState {
  /** The local date (`YYYY-MM-DD`) of the last review. */
  lastDate?: string;
  /** Insight keys already said (a promotion is mentioned once, not every evening). */
  mentioned?: string[];
}

export type InsightKind = 'promotion' | 'rejections' | 'tool' | 'nudges';

export interface SelfReviewInsight {
  kind: InsightKind;
  /** Stable key, so the same promotion is never mentioned twice. */
  key: string;
  /** Worth one evening note. */
  actionable: boolean;
  text: string;
}

export interface SelfReviewRecord {
  version: 1;
  /** The local date reviewed. */
  date: string;
  at: string;
  /** Start of the 24-hour window. */
  since: string;
  nudges: { sent: number; answered: number; ignored: number; pending: number };
  verify: { accepted: number; edited: number; rejected: number; expired: number };
  /** Rejections per action type in the window (any stage), most first. */
  rejections: Array<{ actionType: string; count: number; notes: string[] }>;
  /** Actions that earned a promotion and still wait for your `rufus trust promote`. */
  promotions: Array<{ actionType: string; consecutiveClean: number; threshold: number }>;
  tools: { calls: number; failed: number; missing: number; byTool: Array<{ tool: string; failed: number; missing: number; lastError?: string }> };
  insights: SelfReviewInsight[];
  /** The one note said this evening, when there was one. */
  note?: string;
}

/** Why the review should not run now (`quiet hours`, `protected: <rule>`, `too early`, `done today`), or undefined. */
export function selfReviewSkipReason(opts: { now: Date; anchor: Pick<Anchor, 'boundaries' | 'schedule'>; state?: SelfReviewState; after?: string; quietHours?: string | false }): string | undefined {
  const { now } = opts;
  if (opts.state?.lastDate === localDate(now)) return 'done today';
  if (inQuietHours(now, opts.quietHours === undefined ? DEFAULT_QUIET_HOURS : opts.quietHours)) return 'quiet hours';
  const guard = protectedNow(opts.anchor, now);
  if (guard) return `protected: ${guard.rule}`;
  if (now.getHours() * 60 + now.getMinutes() < toMinutes(opts.after ?? DEFAULT_REVIEW_AFTER)) return 'too early';
  return undefined;
}

const ms = (t?: string): number | undefined => {
  const v = t ? Date.parse(t) : NaN;
  return Number.isNaN(v) ? undefined : v;
};

/** Every run in `<dir>/loop-runs/`. Unreadable files are skipped. */
export async function loadLoopRuns(dir: string): Promise<LoopRun[]> {
  let files: string[];
  try {
    files = await fs.readdir(path.join(dir, LOOP_RUNS_DIR));
  } catch {
    return [];
  }
  const runs = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          return JSON.parse(await fs.readFile(path.join(dir, LOOP_RUNS_DIR, f), 'utf8')) as LoopRun;
        } catch {
          return undefined;
        }
      }),
  );
  return runs.filter((r): r is LoopRun => !!r && typeof r === 'object' && typeof r.id === 'string');
}

/** Proactive nudges in the window: answered (the human said anything within `answerWindowMs`), ignored, or still pending. */
export function countNudges(turns: readonly ChatTurn[], now: Date, answerWindowMs = DEFAULT_NUDGE_ANSWER_MS): SelfReviewRecord['nudges'] {
  const nowMs = now.getTime();
  const since = nowMs - WINDOW_MS;
  const userAt = turns.filter((t) => t.role === 'user').map((t) => ms(t.at)).filter((x): x is number => x !== undefined);
  const out = { sent: 0, answered: 0, ignored: 0, pending: 0 };
  let last: number | undefined;
  for (const t of turns) {
    const at = ms(t.at);
    if (t.role !== 'assistant' || !t.proactive || at === undefined || at < since || at > nowMs) continue;
    const sameNudge = last !== undefined && at - last <= BUBBLE_GAP_MS;
    last = at;
    if (sameNudge) continue;
    out.sent++;
    if (userAt.some((u) => u > at && u - at <= answerWindowMs)) out.answered++;
    else if (nowMs - at < answerWindowMs) out.pending++;
    else out.ignored++;
  }
  return out;
}

const MISSING = /no such tool|is not configured|not registered|no "[^"]+" tool/i;

/** Builds the day's record from the workspace files. Writes nothing. */
export async function buildSelfReview(opts: { dir: string; now: Date; state?: SelfReviewState; options?: SelfReviewOptions; runs?: LoopRun[]; trust?: TrustRecord[]; turns?: ChatTurn[] }): Promise<SelfReviewRecord> {
  const { dir, now } = opts;
  const o = opts.options ?? {};
  const nowMs = now.getTime();
  const sinceMs = nowMs - WINDOW_MS;
  const inWindow = (t?: string): boolean => {
    const v = ms(t);
    return v !== undefined && v >= sinceMs && v <= nowMs;
  };
  const turns = opts.turns ?? (await loadChatHistory(dir, KEEP_CHAT_TURNS * 2).catch(() => []));
  const runs = opts.runs ?? (await loadLoopRuns(dir));
  const trust = opts.trust ?? (await new TrustStore(dir).all().catch(() => []));

  const nudges = countNudges(turns, now, o.answerWindowMs);

  const verify = { accepted: 0, edited: 0, rejected: 0, expired: 0 };
  const rejected = new Map<string, { count: number; notes: string[] }>();
  for (const r of runs) {
    const d = r.decision;
    if (d && inWindow(d.at)) {
      if (d.stage === 'verify') verify[d.verdict === 'accept' ? 'accepted' : d.verdict === 'edit' ? 'edited' : 'rejected']++;
      if (d.verdict === 'reject') {
        const key = r.actionType ?? r.handlerId;
        const e = rejected.get(key) ?? { count: 0, notes: [] };
        e.count++;
        if (d.note?.trim()) e.notes.push(clip(d.note, 160));
        rejected.set(key, e);
      }
    }
    if (r.status === 'expired' && inWindow(r.expiredAt)) verify.expired++;
  }
  const rejections = [...rejected.entries()].map(([actionType, e]) => ({ actionType, ...e })).sort((a, b) => b.count - a.count || a.actionType.localeCompare(b.actionType));

  const tools = { calls: 0, failed: 0, missing: 0, byTool: [] as SelfReviewRecord['tools']['byTool'] };
  const byTool = new Map<string, { failed: number; missing: number; lastError?: string }>();
  const fail = (tool: string, error: string | undefined): void => {
    const e = byTool.get(tool) ?? { failed: 0, missing: 0 };
    if (error && MISSING.test(error)) {
      e.missing++;
      tools.missing++;
    } else {
      e.failed++;
      tools.failed++;
    }
    if (error) e.lastError = clip(error, 160);
    byTool.set(tool, e);
  };
  for (const r of runs) {
    for (const c of r.toolCalls ?? []) {
      if (!inWindow(c.at)) continue;
      tools.calls++;
      if (!c.ok) fail(c.tool, c.error);
    }
    // "Approved, but no "beeper.send" tool is configured": the commit never got as far as a tool call.
    const missing = r.commitError ? /no "([^"]+)" tool is configured/.exec(r.commitError) : null;
    if (missing && inWindow(r.decision?.at ?? r.updatedAt)) fail(missing[1]!, r.commitError);
  }
  tools.byTool = [...byTool.entries()].map(([tool, e]) => ({ tool, ...e })).sort((a, b) => b.failed + b.missing - (a.failed + a.missing) || a.tool.localeCompare(b.tool));

  const promotions = trust
    .filter((t) => t.promotionSuggested && t.autonomy === 'check')
    .map((t) => ({ actionType: t.actionType, consecutiveClean: t.consecutiveClean, threshold: t.promotionThreshold }))
    .sort((a, b) => b.consecutiveClean - a.consecutiveClean || a.actionType.localeCompare(b.actionType));

  const mentioned = new Set(opts.state?.mentioned ?? []);
  const insights: SelfReviewInsight[] = [];
  const fresh = promotions.filter((p) => !mentioned.has(`promotion:${p.actionType}`));
  if (fresh.length) {
    const p = fresh[0]!;
    const more = fresh.length > 1 ? ` (${fresh.length - 1} more ${fresh.length === 2 ? 'is' : 'are'} ready too: rufus trust)` : '';
    insights.push({
      kind: 'promotion',
      key: `promotion:${p.actionType}`,
      actionable: true,
      text: `Quick one before tonight: you've OK'd my ${p.actionType} ${p.consecutiveClean} times in a row without a change. Want me to handle those on my own from now on? (rufus trust promote ${p.actionType})${more}`,
    });
  }
  const repeat = o.repeatRejections ?? DEFAULT_REPEAT_REJECTIONS;
  for (const r of rejections.filter((x) => x.count >= repeat)) {
    const note = r.notes[r.notes.length - 1];
    insights.push({
      kind: 'rejections',
      key: `rejections:${r.actionType}:${localDate(now)}`,
      actionable: true,
      text: `Something I noticed today: you turned down ${r.count} of my ${r.actionType} items${note ? ` (last time: "${clip(note, 80)}")` : ''}. Anything I should do differently there?`,
    });
  }
  const toolRepeat = o.repeatToolFailures ?? DEFAULT_REPEAT_TOOL_FAILURES;
  for (const t of tools.byTool.filter((x) => x.failed + x.missing >= toolRepeat)) {
    const why = t.missing >= t.failed ? `isn't set up, and I needed it ${t.failed + t.missing} times today` : `failed ${t.failed + t.missing} times today${t.lastError ? ` (${clip(t.lastError, 80)})` : ''}`;
    insights.push({ kind: 'tool', key: `tool:${t.tool}:${localDate(now)}`, actionable: true, text: `Heads up: ${t.tool} ${why}. Might be worth a look.` });
  }
  if (nudges.ignored >= 3 && nudges.answered === 0) {
    insights.push({ kind: 'nudges', key: `nudges:${localDate(now)}`, actionable: false, text: `${nudges.ignored} proactive messages went unanswered today; speaking up less.` });
  }

  return {
    version: 1,
    date: localDate(now),
    at: now.toISOString(),
    since: new Date(sinceMs).toISOString(),
    nudges,
    verify,
    rejections,
    promotions,
    tools,
    insights,
  };
}

/** The ONE evening note worth saying, or undefined (stay silent). */
export function selfReviewNote(record: Pick<SelfReviewRecord, 'insights'>): SelfReviewInsight | undefined {
  return record.insights.find((i) => i.actionable);
}

export async function appendSelfReview(dir: string, record: SelfReviewRecord): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, SELF_REVIEW_FILE), JSON.stringify(record) + '\n', 'utf8');
}

/** The saved records, oldest first. */
export async function loadSelfReviews(dir: string): Promise<SelfReviewRecord[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, SELF_REVIEW_FILE), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as SelfReviewRecord];
      } catch {
        return [];
      }
    });
}

/**
 * One review, if it is due: builds the record, picks at most one actionable note, appends the record (with the note), and
 * updates `state` (the date, and the promotion now mentioned). Returns undefined when skipped, with the reason.
 */
export async function runSelfReview(opts: { dir: string; now: Date; anchor: Pick<Anchor, 'boundaries' | 'schedule'>; state: SelfReviewState; options?: SelfReviewOptions; runs?: LoopRun[]; trust?: TrustRecord[]; turns?: ChatTurn[] }): Promise<{ skipped: string } | { record: SelfReviewRecord; note?: string }> {
  const o = opts.options ?? {};
  const skip = selfReviewSkipReason({ now: opts.now, anchor: opts.anchor, state: opts.state, ...(o.after ? { after: o.after } : {}), ...(o.quietHours !== undefined ? { quietHours: o.quietHours } : {}) });
  if (skip) return { skipped: skip };
  const record = await buildSelfReview(opts);
  const insight = selfReviewNote(record);
  if (insight) record.note = insight.text;
  await appendSelfReview(opts.dir, record);
  opts.state.lastDate = record.date;
  // A promotion is said once; once it is taken (or withdrawn) it may be said again when earned again.
  const still = new Set(record.promotions.map((p) => `promotion:${p.actionType}`));
  opts.state.mentioned = [...(opts.state.mentioned ?? []).filter((k) => still.has(k)), ...(insight?.kind === 'promotion' ? [insight.key] : [])];
  return { record, ...(insight ? { note: insight.text } : {}) };
}
