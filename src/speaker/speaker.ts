import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LosslessEvent, ModelProvider, Receipt } from '../types';

/**
 * Universal $0 truth & formatting gate.
 * Checks a rendered reply against the immutable `Receipt[]` from this wake:
 * - If zero write receipts succeeded (`changes.length === 0`), blocks any generic completion claim.
 * - Preserves clean line breaks on numbered lists and bans em-dashes / sycophancy / plumbing excuses.
 */
const COMPLETION_CLAIM =
  /\b(?:i(?:'ve| have)?\s+(?:just\s+)?(?:updated|removed|deleted|archived|moved|created|renamed|fixed|sent|replied|booked|scheduled|cleared|dropped|changed)|(?:it(?:'s| is)|they(?:'re| are)|that(?:'s| is))\s+(?:done|updated|removed|deleted|archived|sent|cleared|scheduled|booked)|down to (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:projects?|items?|files?))\b/i;

const HEDGE_OR_QUESTION =
  /\b(?:not|never|haven'?t|hasn'?t|didn'?t|don'?t|can'?t|cannot|won'?t|waiting|queued|approval|approve|pending|say yes|want me|should i|i'?ll|i will)\b|\?\s*$/i;

const EMPTY_FUTURE_PROMISE =
  /\b(?:i(?:'ll| will)\s+(?:stop|start|always|never|remember to|make sure to|drop|skip)|from now on\s+i(?:'ll| will))\b/i;

export function verifySpokenReply(text: string, receipts: readonly Receipt[]): string[] {
  const s = text.trim();
  if (!s) return ['reply is empty'];
  const fails: string[] = [];

  // 1. Universal $0 truth check against actual Receipt.changes
  const actualChanges = receipts.flatMap((r) => (r.status === 'ok' && r.effect === 'write' ? r.changes : []));
  const anyFailed = receipts.some((r) => r.status === 'failed' || r.status === 'timed_out' || r.status === 'invalid_input');
  if (actualChanges.length === 0) {
    if (/^done\b/i.test(s) && anyFailed) {
      fails.push('opened with "Done" even though a tool failed and 0 writes succeeded');
    }
    if (EMPTY_FUTURE_PROMISE.test(s)) {
      fails.push('empty future promise ("I\'ll stop/start/always..."): persist the rule via skills.save first before promising it');
    }
    const clauses = s.split(/(?<=[.!?])\s+|\n+/).map((c) => c.trim()).filter(Boolean);
    for (const clause of clauses) {
      if (HEDGE_OR_QUESTION.test(clause)) continue;
      if (COMPLETION_CLAIM.test(clause)) {
        fails.push(`unbacked completion claim ("${clause.slice(0, 80)}"): 0 real writes succeeded in receipts`);
        break;
      }
    }
  }

  // 2. Clean formatting, local time, conciseness & voice invariants
  if (/\b\d{1,2}:\d{2}\s*UTC\b/i.test(s)) fails.push('quoted UTC time instead of the user’s local time');
  const hasList = /^\s*1\.\s+/m.test(s);
  if (!hasList && s.length > 380) fails.push('message is too long/wordy (keep non-list replies under ~350 chars, 1-3 crisp sentences)');
  if (/—/.test(s)) fails.push('no em-dashes (use a comma, period, or plain hyphen)');
  if (/^(?:great question|awesome question|sure thing|absolutely!|happy to help|certainly!|hi\s+\w+[.!,\s])/i.test(s)) {
    fails.push('sycophantic or generic chatbot opener (lead straight with the answer)');
  }
  if (/\b(?:want me to (?:check anything|pull something up|look into anything|do anything)|let me know if you need anything|how can i help)\b/i.test(s)) {
    fails.push('generic assistant closing filler ("Want me to...?") — drop it and end cleanly');
  }
  if (/\b1\.[ \t]+\S+[^\n]*[ \t]+2\.[ \t]+\S+/.test(s)) {
    fails.push('numbered list is cramped on one line — put each numbered item on its own line');
  }
  if (/\b(?:my notes cut off|got cut off in my read|so i can't tell you more)\b/i.test(s)) {
    fails.push('plumbing excuse instead of clear factual status');
  }

  return fails;
}

/** Preserves newlines cleanly while capping length. */
export function normalizeMultiline(text: string, maxChars = 2000): string {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1).trimEnd()}…` : clean;
}

async function loadVoiceGuide(workspaceDir: string): Promise<string> {
  try {
    return (await fs.readFile(path.join(workspaceDir, 'VOICE.md'), 'utf8')).trim();
  } catch {
    try {
      return (await fs.readFile(path.join(workspaceDir, 'SOUL.md'), 'utf8')).trim();
    } catch {
      return 'Calm, poised, concise, human. Use clean numbered lists (one item per line) for 3+ items. Never claim an action succeeded unless it appears in the receipts.';
    }
  }
}

export function selectReceiptsForSpeaker(receipts: readonly Receipt[], receiptTurns?: readonly number[]): Receipt[] {
  if (receiptTurns?.length) {
    const picked = receiptTurns
      .map((n) => receipts[n - 1])
      .filter((r): r is Receipt => !!r && r.toolId !== 'send_message' && r.toolId !== 'edit_message' && r.toolId !== 'sleep');
    if (picked.length) return picked;
  }
  const meaningful = receipts.filter((r) => r.toolId !== 'send_message' && r.toolId !== 'edit_message' && r.toolId !== 'sleep');
  const okOnes = meaningful.filter((r) => r.status === 'ok' || r.status === 'pending_approval');
  if (okOnes.length) return okOnes;
  return meaningful.length ? [meaningful[meaningful.length - 1]!] : [];
}

/**
 * Pure fresh-context fast model (Haiku) speaker.
 * Code owns the Facts (clean, final Receipts — never failed retries or stale old messages).
 * Opus owns the Purpose (1 short line: why to send this message).
 * Haiku owns the Voice (VOICE.md) + $0 universal truth & formatting gate.
 */
export async function renderWithSpeaker(opts: {
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  purpose: string;
  receipts: readonly Receipt[];
  receiptTurns?: readonly number[];
  trigger?: LosslessEvent;
}): Promise<{ text: string; violations: string[]; rewritten: boolean }> {
  const voice = await loadVoiceGuide(opts.workspaceDir);
  const selected = selectReceiptsForSpeaker(opts.receipts, opts.receiptTurns);
  const receiptBlock = selected.length
    ? selected
        .map(
          (r, i) =>
            `${i + 1}. [${r.toolId} | ${r.status}] ${r.summary}` +
            (r.changes.length ? ` | changes: ${r.changes.join('; ')}` : '') +
            (r.data !== undefined ? ` | data: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}` : '') +
            (r.error ? ` | error: ${r.error}` : ''),
        )
        .join('\n')
    : '(none — no tools ran before this message)';

  const triggerFact = opts.trigger
    ? `0. [trigger | ${opts.trigger.source}/${opts.trigger.kind}${opts.trigger.actor ? ` | ${opts.trigger.actor}` : ''}] ${opts.trigger.text.slice(0, 260)}`
    : '';
  const allFacts = [triggerFact, ...(selected.length ? [receiptBlock] : [])].filter(Boolean).join('\n') || '(none)';

  const system = [
    'You are the Speaker. Voice the Purpose below using ONLY the verified Facts from Code.',
    'Hard Rules:',
    '- Honor the Purpose directly (never drop the main point, e.g., that you restarted or answered the question).',
    '- Use ONLY the Facts below — never invent or claim any change not in `changes`.',
    '- Keep it tight: 1-2 short, natural sentences (unless listing 3+ items, in which case use a clean numbered list, one item per line).',
    '- First person only ("I"). Never quote UTC times. Never open with "Done" unless a write succeeded.',
    '- No em-dashes, no "Hi <name>", no generic closers ("Want me to...?"), no raw JSON.',
    '',
    'Voice Guide:',
    voice,
  ].join('\n');

  const prompt = `Purpose of this message:\n${opts.purpose}\n\nVerified Facts from Code:\n${allFacts}\n\nWrite ONLY the final message.`;

  let text = normalizeMultiline(await opts.provider.complete({ system, prompt, ...(opts.model ? { model: opts.model } : {}) }));
  let violations = verifySpokenReply(text, opts.receipts);
  let rewritten = false;

  if (violations.length) {
    rewritten = true;
    const fixPrompt = `${prompt}\n\nYour draft was:\n${text}\n\nRejected by truth/formatting gate: ${violations.join('; ')}.\nRewrite cleanly fixing every issue.`;
    text = normalizeMultiline(await opts.provider.complete({ system, prompt: fixPrompt, ...(opts.model ? { model: opts.model } : {}) }));
    violations = verifySpokenReply(text, opts.receipts);
    if (violations.some((v) => v.startsWith('unbacked completion claim'))) {
      text = `${text}\n\n(Note: no files or external state were actually changed yet.)`;
    }
  }

  return { text, violations, rewritten };
}
