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
      const ok = toolOk && gapOk;
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
