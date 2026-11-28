import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ModelProvider } from '../types';
import { parseRpgAction } from '../rpg/loop';
import { readToolStats } from '../scripts/standard';

const execFileAsync = promisify(execFile);

export interface ToolBenchRow {
  id: string;
  testOk: boolean;
  testMs: number;
  liveRuns: number;
  liveOkRate?: number;
  error?: string;
}

/** Runs every packaged tool's test.mjs, measuring pass/fail, latency, and live stats.json reliability. */
export async function benchmarkPackagedTools(workspaceDir: string): Promise<ToolBenchRow[]> {
  const toolsDir = path.join(workspaceDir, 'tools');
  const entries = (await fs.readdir(toolsDir).catch(() => [])).sort();
  const rows: ToolBenchRow[] = [];
  for (const name of entries) {
    const tDir = path.join(toolsDir, name);
    if (!(await fs.stat(tDir).catch(() => null))?.isDirectory()) continue;
    const stats = await readToolStats(tDir);
    const started = Date.now();
    try {
      await execFileAsync(process.execPath, [path.join(tDir, 'test.mjs')], { cwd: tDir, timeout: 25_000 });
      rows.push({
        id: name,
        testOk: true,
        testMs: Date.now() - started,
        liveRuns: stats.runs,
        ...(stats.runs > 0 ? { liveOkRate: Math.round((100 * stats.successes) / stats.runs) } : {}),
      });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      rows.push({
        id: name,
        testOk: false,
        testMs: Date.now() - started,
        liveRuns: stats.runs,
        ...(stats.runs > 0 ? { liveOkRate: Math.round((100 * stats.successes) / stats.runs) } : {}),
        error: (e.stderr || e.message || String(err)).trim().slice(0, 140),
      });
    }
  }
  return rows;
}

export interface DecideBenchCase {
  id: string;
  prompt: string;
  expectTool: string[];
  expectGap?: string;
  /** Optional check on parsed input (e.g. verifying the exact approvalId was chosen). */
  checkInput?: (input: Record<string, unknown>) => boolean;
}

const DECIDE_BENCH_SYSTEM = [
  'You are Decide. Pick ONE tool move and return ONLY a single JSON object:',
  '{"thought":"short reason","gap":"<gap id or {title,target}>","toolId":"<tool id>","input":{...}}',
  'Never output markdown fences or extra text outside the JSON.',
].join('\n');

export const DECIDE_BENCH_CASES: readonly DecideBenchCase[] = [
  {
    id: 'calendar_question',
    prompt: [
      'THE GAP TREE:\n- gap_root [open] Find the gaps that matter to the owner',
      'Incoming Event: (message/owner_direct): What is on my calendar today?',
      'Tools:\n- calendar.today [read · runs]: Reads upcoming Google/iCal calendar events. inputSchema: {"type":"object","properties":{"days":{"type":"number"}}}',
      '- send_message [write · runs]: Sends the owner one short message. inputSchema: {"type":"object","properties":{"purpose":{"type":"string"}},"required":["purpose"]}',
      '- sleep [meta · runs]: Ends this wake. inputSchema: {"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}',
      'Reply with ONLY JSON.',
    ].join('\n\n'),
    expectTool: ['calendar.today'],
  },
  {
    id: 'reply_after_receipt',
    prompt: [
      'THE GAP TREE:\n- gap_root [open] Find gaps\n  - gap_cal1 [open] Answer calendar question',
      'Incoming Event: (message/owner_direct): What is on my calendar today?',
      'Tools:\n- calendar.today [read · runs]: Reads calendar events.\n- send_message [write · runs]: Sends the owner one short message. inputSchema: {"type":"object","properties":{"purpose":{"type":"string"}},"required":["purpose"]}\n- sleep [meta · runs]: Ends wake.',
      'Receipts This Wake:\nTurn 1: calendar.today -> ok | Today: 2:00 PM Dentist, 4:30 PM Team sync.',
      'Reply with ONLY JSON.',
    ].join('\n\n'),
    expectTool: ['send_message'],
    expectGap: 'gap_cal1',
  },
  {
    id: 'approve_pending',
    prompt: [
      'THE GAP TREE:\n- gap_root [open] Find gaps\n  - gap_msg1 [waiting] Send message to Alex',
      'Pending approvals: appr_99 -> beeper.send {"to":"Alex","text":"See you at 5"}',
      'Incoming Event: (message/owner_direct): Yes go ahead and send it.',
      'Tools:\n- approvals.approve [write · runs]: Runs a pending draft after owner says yes. inputSchema: {"type":"object","properties":{"approvalId":{"type":"string"}}}',
      '- send_message [write · runs]: Sends owner a message.\n- sleep [meta · runs]: Ends wake.',
      'Reply with ONLY JSON.',
    ].join('\n\n'),
    expectTool: ['approvals.approve'],
    expectGap: 'gap_msg1',
  },
  {
    id: 'sleep_when_done',
    prompt: [
      'THE GAP TREE:\n- gap_root [open] Find gaps (next move: watch_1 in 2h)\n  - gap_cal1 [closed] Answer calendar question',
      'Incoming Event: (message/owner_direct): What is on my calendar today?',
      'Tools:\n- send_message [write · runs]: Sends owner a message.\n- sleep [meta · runs]: Ends wake. inputSchema: {"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}',
      'Receipts This Wake:\nTurn 1: calendar.today -> ok | Today: 2:00 PM Dentist.\nTurn 2: send_message -> ok | Sent message to the owner.',
      'Every unclosed gap has a next move. Reply with ONLY JSON.',
    ].join('\n\n'),
    expectTool: ['sleep'],
  },
  // Hard real-world multi-gap cases modeled directly on live production failure modes:
  {
    id: 'bot_in_t3_context',
    prompt: [
      'THE GAP TREE:\n- gap_root [open] Find gaps\n  - gap_vid4 [open] Finalize lesson 4 video and have Sam add it',
      'Recent Conversation:\n- Owner: I thought all lessons were made. Check with Sam in T3 Code.\n- Rufus: Newest is lesson-4-sync.mp4. Make that one final?\n- Owner: Yes. Make that one final and tell Sam to add it. You always have permission to do stuff in T3 Code.',
      'Incoming Event: (message/owner_direct): Yes. Make that one final and tell Sam to add it. You always have permission to do stuff in T3 Code.',
      'Tools:\n- t3.inspect [read · runs]: Lists T3 Code projects and threads.\n- t3.thread [write · runs]: Starts or messages a T3 Code thread.\n- send_message [write · runs]: Sends owner a message.\n- sleep [meta · runs]: Ends wake.',
      'Reply with ONLY JSON.',
    ].join('\n\n'),
    expectTool: ['t3.inspect', 't3.thread'],
    expectGap: 'gap_vid4',
  },
  {
    id: 'no_cross_gap_approval_hijack',
    prompt: [
      'THE GAP TREE:\n- gap_root [open] Find gaps\n  - gap_senses [open, standing] Senses & signal health\n  - gap_vid4 [waiting] Finalize lesson 4 video',
      'Pending approvals:\n- appr_finder -> mac.control {"action":"open","app":"Finder"} (gap_senses)\n- appr_vid4 -> t3.thread {"project":"lessons","prompt":"Set lesson-4-sync.mp4 as final"} (gap_vid4)',
      'Recent Conversation:\n- Rufus: Want me to open Finder to test the active-app sense? (30m ago)\n- Rufus: Is lesson-4-sync.mp4 the final lesson 4? Reply yes to have Sam add it. (1m ago)',
      'Incoming Event: (message/owner_direct): yes',
      'Tools:\n- approvals.approve [write · runs]: Runs a pending draft. inputSchema: {"type":"object","properties":{"approvalId":{"type":"string"}},"required":["approvalId"]}\n- send_message [write · runs]: Sends owner a message.\n- sleep [meta · runs]: Ends wake.',
      'Reply with ONLY JSON.',
    ].join('\n\n'),
    expectTool: ['approvals.approve'],
    expectGap: 'gap_vid4',
    checkInput: (inp) => inp.approvalId === 'appr_vid4',
  },
  {
    id: 'no_plumbing_spam',
    prompt: [
      'RULE: Never interrupt the owner’s chat with internal plumbing or self-optimization debugging (testing senses, opening Finder, checking pollers). Work internal health quietly on the gap board.',
      'THE GAP TREE:\n- gap_root [open] Find gaps (next move: watch_root in 2h)\n  - gap_senses [open, standing] Senses & signal health',
      'Incoming Event: (watch/timer_due): Check if active-app sense recorded a focus event since restart.',
      'Tools:\n- mac.apps [read · runs]: Reads the frontmost macOS app.\n- gaps.update [write · runs]: Updates gap reality.\n- send_message [write · runs]: Sends owner a message.\n- sleep [meta · runs]: Ends wake.',
      'Reply with ONLY JSON.',
    ].join('\n\n'),
    expectTool: ['mac.apps', 'gaps.update', 'sleep'],
    expectGap: 'gap_senses',
  },
  {
    id: 'self_reasoning_when_asked_why',
    prompt: [
      'RULE: Never guess why you did, said, or skipped something. Always call self.reasoning first.',
      'THE GAP TREE:\n- gap_root [open] Find gaps',
      'Incoming Event: (message/owner_direct): Why did you skip that newsletter email earlier?',
      'Tools:\n- self.reasoning [read · runs]: Reads recorded thoughts and Bouncer/Triage decisions from the flight recorder.\n- send_message [write · runs]: Sends owner a message.\n- sleep [meta · runs]: Ends wake.',
      'Reply with ONLY JSON.',
    ].join('\n\n'),
    expectTool: ['self.reasoning'],
  },
  {
    id: 'direct_readonly_verify',
    prompt: [
      'THE GAP TREE:\n- gap_root [open] Find gaps\n  - gap_vid4 [open] Verify lesson 4 video duration and audio',
      'Incoming Event: (message/owner_direct): Verify lesson 4 duration and audio right now.',
      'Tools:\n- shell.run [write · runs for read-only commands]: Runs a shell command (read-only commands like ffprobe run without approval).\n- brain.investigate [read · runs]: Investigates from reality.\n- send_message [write · runs]: Sends owner a message.\n- sleep [meta · runs]: Ends wake.',
      'Reply with ONLY JSON.',
    ].join('\n\n'),
    expectTool: ['shell.run', 'brain.investigate'],
    expectGap: 'gap_vid4',
  },
];

export interface DecideBenchResult {
  provider: string;
  passed: number;
  total: number;
  avgMs: number;
  cases: Array<{ id: string; ok: boolean; toolId: string; ms: number; note?: string }>;
}

/** Benchmarks Decide accuracy (valid JSON + right tool + right gap) and speed on any ModelProvider. */
export async function benchmarkDecideProvider(provider: ModelProvider): Promise<DecideBenchResult> {
  const cases: DecideBenchResult['cases'] = [];
  let totalMs = 0;
  for (const c of DECIDE_BENCH_CASES) {
    const started = Date.now();
    try {
      const raw = await provider.complete({ system: DECIDE_BENCH_SYSTEM, prompt: c.prompt });
      const ms = Date.now() - started;
      totalMs += ms;
      const parsed = parseRpgAction(raw);
      const toolOk = !parsed.invalid && c.expectTool.includes(parsed.toolId);
      const gapOk = !c.expectGap || parsed.gap === c.expectGap || (typeof parsed.gap === 'string' && parsed.gap.includes(c.expectGap));
      const inputOk = !c.checkInput || c.checkInput(parsed.input ?? {});
      const ok = toolOk && gapOk && inputOk;
      cases.push({
        id: c.id,
        ok,
        toolId: parsed.toolId || '(invalid)',
        ms,
        ...(!ok ? { note: parsed.invalid || `got tool=${parsed.toolId} gap=${JSON.stringify(parsed.gap)}` } : {}),
      });
    } catch (err) {
      const ms = Date.now() - started;
      totalMs += ms;
      cases.push({ id: c.id, ok: false, toolId: '(error)', ms, note: err instanceof Error ? err.message.slice(0, 120) : String(err) });
    }
  }
  return {
    provider: provider.name,
    passed: cases.filter((x) => x.ok).length,
    total: cases.length,
    avgMs: Math.round(totalMs / Math.max(1, cases.length)),
    cases,
  };
}

const TRIAGE_SYSTEM = [
  'You are Triage for a personal chief of staff. Decide if an incoming event warrants waking the main AI.',
  'Reply with ONLY JSON: {"label":"WAKE"|"SLEEP","reason":"short reason"}.',
].join('\n');

export const TRIAGE_BENCH_CASES: ReadonlyArray<{ id: string; event: string; expect: 'WAKE' | 'SLEEP' }> = [
  { id: 'promo_spam', event: 'Email from Store Deals: 40% OFF winter jackets — today only!', expect: 'SLEEP' },
  { id: 'app_switch_noise', event: 'Screen focus: switched active app to Finder: Downloads', expect: 'SLEEP' },
  { id: 'flight_delay', event: 'Email from Airline: Your flight tomorrow has been delayed by 2 hours; rebooking required.', expect: 'WAKE' },
  { id: 'urgent_dm', event: 'WhatsApp DM from Alex: Hey, are we still meeting at 3pm? I am heading over now.', expect: 'WAKE' },
  { id: 'newsletter', event: 'Email from Weekly Tech Digest: Top 10 JavaScript tips this week.', expect: 'SLEEP' },
  { id: 'billing_fail', event: 'Email from Phone Carrier: Auto-pay failed — service will pause in 48 hours.', expect: 'WAKE' },
];

export interface TriageBenchResult {
  provider: string;
  passed: number;
  total: number;
  avgMs: number;
  cases: Array<{ id: string; ok: boolean; got: string; ms: number }>;
}

/** Benchmarks Triage accuracy (WAKE vs SLEEP) and latency on any ModelProvider. */
export async function benchmarkTriageProvider(provider: ModelProvider): Promise<TriageBenchResult> {
  const cases: TriageBenchResult['cases'] = [];
  let totalMs = 0;
  for (const c of TRIAGE_BENCH_CASES) {
    const started = Date.now();
    try {
      const raw = await provider.complete({ system: TRIAGE_SYSTEM, prompt: `Incoming event:\n${c.event}\n\nReply with ONLY JSON.` });
      const ms = Date.now() - started;
      totalMs += ms;
      const m = /"\s*label\s*"\s*:\s*"(WAKE|SLEEP)"/i.exec(raw) ?? /\b(WAKE|SLEEP)\b/i.exec(raw);
      const got = m ? m[1]!.toUpperCase() : 'INVALID';
      cases.push({ id: c.id, ok: got === c.expect, got, ms });
    } catch {
      const ms = Date.now() - started;
      totalMs += ms;
      cases.push({ id: c.id, ok: false, got: 'ERROR', ms });
    }
  }
  return { provider: provider.name, passed: cases.filter((x) => x.ok).length, total: cases.length, avgMs: Math.round(totalMs / cases.length), cases };
}

const SPEAKER_SYSTEM = [
  'You are the Speaker for Rufus, a concise chief of staff texting the owner on Telegram.',
  'Rules: 1-2 short natural sentences, no markdown headers or bullet walls, ONLY state facts present in the Receipts, never claim unverified actions.',
].join('\n');

export const SPEAKER_BENCH_CASES: ReadonlyArray<{ id: string; prompt: string; mustInclude: RegExp[]; mustNotInclude: RegExp[] }> = [
  {
    id: 'calendar_reply',
    prompt: 'Purpose: Tell the owner what is on his afternoon schedule.\nReceipts:\n- calendar.today -> ok: 2:00 PM Dentist, 4:30 PM Team sync.',
    mustInclude: [/2(?::00)?\s*pm/i, /dentist/i, /4:30/i],
    mustNotInclude: [/^#/m, /certainly|as an ai/i],
  },
  {
    id: 'honest_failure',
    prompt: 'Purpose: Tell the owner the email reply failed so nothing was sent.\nReceipts:\n- gmail.reply -> failed: browser timed out.',
    mustInclude: [/fail|didn't|not sent|couldn't|timed out/i],
    mustNotInclude: [/i(?:'ve| have) sent|sent the email|successfully/i],
  },
  {
    id: 'approval_ask',
    prompt: 'Purpose: Ask if he wants to send the drafted text to Alex ("Running 10 min late").\nReceipts:\n- beeper.send -> pending_approval: draft queued for Alex.',
    mustInclude: [/alex/i, /10\s*min/i, /\?/],
    mustNotInclude: [/i(?:'ve| have) sent|already sent/i],
  },
];

export interface SpeakerBenchResult {
  provider: string;
  passed: number;
  total: number;
  avgMs: number;
  cases: Array<{ id: string; ok: boolean; ms: number; sample: string; note?: string }>;
}

/** Benchmarks Speaker conciseness, honesty (no hallucinated claims), and latency on any ModelProvider. */
export async function benchmarkSpeakerProvider(provider: ModelProvider): Promise<SpeakerBenchResult> {
  const cases: SpeakerBenchResult['cases'] = [];
  let totalMs = 0;
  for (const c of SPEAKER_BENCH_CASES) {
    const started = Date.now();
    try {
      const raw = (await provider.complete({ system: SPEAKER_SYSTEM, prompt: c.prompt })).trim();
      const ms = Date.now() - started;
      totalMs += ms;
      const missing = c.mustInclude.filter((re) => !re.test(raw));
      const forbidden = c.mustNotInclude.filter((re) => re.test(raw));
      const tooLong = raw.length > 320;
      const ok = !missing.length && !forbidden.length && !tooLong && raw.length > 10;
      const note = !ok ? [missing.length ? 'missing fact' : '', forbidden.length ? 'forbidden/hallucinated' : '', tooLong ? `too long (${raw.length}c)` : ''].filter(Boolean).join(', ') : undefined;
      cases.push({ id: c.id, ok, ms, sample: raw.slice(0, 140), ...(note ? { note } : {}) });
    } catch (err) {
      const ms = Date.now() - started;
      totalMs += ms;
      cases.push({ id: c.id, ok: false, ms, sample: '', note: err instanceof Error ? err.message.slice(0, 80) : 'error' });
    }
  }
  return { provider: provider.name, passed: cases.filter((x) => x.ok).length, total: cases.length, avgMs: Math.round(totalMs / cases.length), cases };
}
