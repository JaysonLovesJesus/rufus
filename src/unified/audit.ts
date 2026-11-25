import { promises as fs } from 'node:fs';
import path from 'node:path';
import { newId } from '../store';
import { clip } from '../corpus/types';
import type { TrustMode } from '../engine/trust';

/**
 * v21 Action Audit Ledger: `<workspace>/audit.jsonl`, append-only, one line per write or external action Rufus actually
 * executed, whoever said yes (you, or Earned Trust on its own). "what did you do today?" and `rufus audit` read it back
 * as a short summary, in plain code ($0). Nothing here ever runs a tool.
 */

export const AUDIT_FILE = 'audit.jsonl';

/** Who let it run: you (a per-run yes), or an earned rung. */
export type AuditApproval = 'human' | 'auto_notify' | 'autonomous';

export interface AuditEntry {
  id: string;
  /** ISO time it ran. */
  at: string;
  /** The action type (`reply.chat`, `chief.beeper.react`, ...). */
  action: string;
  /** The tool that did it, when one did. */
  tool?: string;
  /** What happened, in plain words. */
  summary: string;
  /** A short, clipped look at the tool's arguments. */
  argsPreview?: string;
  /** The rung the action was on when it ran. */
  trustMode: TrustMode;
  approval: AuditApproval;
  ok: boolean;
  error?: string;
  /** True when it can be taken back (a reaction can be removed; a sent message cannot). */
  reversible?: boolean;
  /** The loop run it belongs to. */
  runId?: string;
}

export type AuditInput = Omit<AuditEntry, 'id' | 'at'> & Partial<Pick<AuditEntry, 'id' | 'at'>>;

export const auditFile = (dir: string): string => path.join(dir, AUDIT_FILE);

/** Appends one entry and returns it (with its id and time). */
export async function appendAudit(dir: string, entry: AuditInput, now: Date = new Date()): Promise<AuditEntry> {
  if (!entry || typeof entry.action !== 'string' || !entry.action.trim()) throw new Error('An audit entry needs an action.');
  const full: AuditEntry = {
    id: entry.id ?? newId('audit'),
    at: entry.at ?? now.toISOString(),
    action: entry.action.trim(),
    ...(entry.tool ? { tool: entry.tool } : {}),
    summary: clip(entry.summary?.trim() || entry.action, 300),
    ...(entry.argsPreview ? { argsPreview: clip(entry.argsPreview, 200) } : {}),
    trustMode: entry.trustMode,
    approval: entry.approval,
    ok: entry.ok === true,
    ...(entry.error ? { error: clip(entry.error, 300) } : {}),
    ...(entry.reversible !== undefined ? { reversible: entry.reversible } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(auditFile(dir), `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

/**
 * The ledger, oldest first. `sinceMs`: only entries at or after this epoch time (ms). `limit`: only the newest N.
 * A missing file is an empty ledger; a broken line is skipped.
 */
export async function loadAudit(dir: string, opts: { sinceMs?: number; limit?: number } = {}): Promise<AuditEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(auditFile(dir), 'utf8');
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (!e || typeof e.action !== 'string' || typeof e.at !== 'string') continue;
      if (opts.sinceMs !== undefined && !(Date.parse(e.at) >= opts.sinceMs)) continue;
      out.push(e);
    } catch {
      /* a torn line: skip it */
    }
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return opts.limit !== undefined && opts.limit >= 0 ? out.slice(out.length - Math.min(out.length, Math.floor(opts.limit))) : out;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A tool's arguments as one short line (`chatId=c1 emoji=😂`). */
export function previewArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? clip(v, 60) : clip(JSON.stringify(v), 60)}`);
  return parts.length ? clip(parts.join(' '), 200) : undefined;
}

/** "reacted 😂 to Mom", "sent "on my way" to Sam", or the generic summary. Lower-case, past tense. */
export function describeDone(tool: string | undefined, args: Record<string, unknown> = {}, fallback = 'did it'): string {
  const to = str(args.to) ?? str(args.chatTitle) ?? str(args.recipient) ?? str(args.chatId) ?? str(args.chatID);
  const toPart = to ? ` to ${to}` : '';
  if (tool === 'beeper.react') {
    const emoji = str(args.emoji) ?? str(args.reaction) ?? str(args.reactionKey) ?? 'a reaction';
    return `reacted ${emoji}${toPart}`;
  }
  if (tool === 'beeper.send') {
    const text = str(args.text) ?? str(args.message);
    return `sent ${text ? `"${clip(text, 80)}"` : 'a message'}${toPart}`;
  }
  return fallback;
}

/** "Just reacted 😂 to Mom — reply 'undo' or 'demote' if you want me to ask first again." */
export function formatAutoNotice(entry: Pick<AuditEntry, 'summary' | 'action' | 'ok' | 'error'>): string {
  const what = entry.summary.replace(/[.\s]+$/, '');
  if (!entry.ok) return `I tried something on my own (${entry.action}: ${what}), but it failed: ${clip(entry.error ?? 'unknown error', 160)}. Reply 'demote' if you want me to ask first again.`;
  return `Just ${what} — reply 'undo' or 'demote' if you want me to ask first again.`;
}

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '--:--';
};

/**
 * A concise, human-readable summary: one count line, then the newest entries (up to `max`, default 8), one line each.
 * `hours` only names the window in the first line; filter with `loadAudit(..., { sinceMs })`.
 */
export function formatAuditSummary(entries: AuditEntry[], opts: { hours?: number; max?: number } = {}): string {
  const window = opts.hours !== undefined ? (opts.hours === 24 ? 'today (last 24h)' : `in the last ${opts.hours}h`) : 'so far';
  if (!entries.length) return `Nothing ${window}: I haven't sent, changed or reacted to anything.`;
  const own = entries.filter((e) => e.approval !== 'human').length;
  const failed = entries.filter((e) => !e.ok).length;
  const head = `${entries.length} action${entries.length === 1 ? '' : 's'} ${window}: ${entries.length - own} you approved, ${own} on my own${failed ? `, ${failed} failed` : ''}.`;
  const max = Math.max(1, opts.max ?? 8);
  const shown = entries.slice(-max).reverse();
  const lines = shown.map((e) => {
    const who = e.approval === 'human' ? 'you OK’d' : e.approval === 'auto_notify' ? 'on my own, told you' : 'on my own';
    return `- ${hhmm(e.at)} ${clip(e.summary, 120)} (${who})${e.ok ? '' : ` FAILED: ${clip(e.error ?? 'unknown', 80)}`}`;
  });
  const more = entries.length > shown.length ? [`…and ${entries.length - shown.length} earlier.`] : [];
  return [head, ...lines, ...more].join('\n');
}

/** Asks for the ledger in chat: "what did you do today?", "audit log", "what have you done?". */
export const AUDIT_REQUEST = /^(?:what\s+(?:did|have)\s+you\s+(?:do|done)(?:\s+(?:today|on your own|so far))?|audit(?:\s+log)?|show\s+(?:me\s+)?(?:the\s+)?audit(?:\s+log)?)\s*[?.!]*$/i;

/** The ledger for the last `hours` (default 24), summarized. */
export async function auditSummary(dir: string, opts: { hours?: number; now?: Date } = {}): Promise<string> {
  const hours = opts.hours ?? 24;
  const now = opts.now ?? new Date();
  return formatAuditSummary(await loadAudit(dir, { sinceMs: now.getTime() - hours * 3_600_000 }), { hours });
}
