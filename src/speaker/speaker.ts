import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ModelProvider, Receipt } from '../types';

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

/**
 * Fresh-context fast model (Haiku) speaker.
 * Receives ONLY the voice guide, the intended message, and the immutable Receipts from this wake.
 * Runs the $0 universal truth & formatting gate, with one automatic rewrite on violation.
 */
export async function renderWithSpeaker(opts: {
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  facts: readonly string[];
  receipts: readonly Receipt[];
  recentSent?: readonly string[];
}): Promise<{ text: string; violations: string[]; rewritten: boolean }> {
  const voice = await loadVoiceGuide(opts.workspaceDir);
  const factsBlock = opts.facts.map((f, i) => `${i + 1}. ${f}`).join('\n');

  const system = [
    'You are the Speaker. Your ONLY job is to phrase the exact Facts below in the Voice Guide.',
    'Hard Rules:',
    '- Phrase ONLY the Facts listed below. NEVER invent, add, or embellish any claim not in the Facts.',
    '- Keep it tight: 1-2 short, natural sentences (unless the Facts contain a 3+ item list, in which case use a clean numbered list, one item per line).',
    '- Never repeat information already covered in Recent Messages Below.',
    '- Always speak in first person ("I"). Never quote UTC times. Never open with "Done" unless a Fact explicitly says an action completed.',
    '- No em-dashes, no "Hi <name>", no generic closers ("Want me to...?"), no raw JSON.',
    '',
    'Voice Guide:',
    voice,
  ].join('\n');

  const recentBlock = opts.recentSent?.length
    ? `\n\nMessages you ALREADY sent recently (do not repeat these facts):\n${opts.recentSent.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
    : '';
  const prompt = `Exact Facts to voice (say ONLY these — nothing extra):\n${factsBlock}${recentBlock}\n\nWrite ONLY the final message.`;

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
