import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runLayer3Prepare, runLayer3Verify, type Layer3Channel } from '../skills/runner';
import { buildPersona, loadSoul, withPersona } from '../soul/soul';
import type { AiProvider } from '../types';

export const EVALS_FILE = path.join('evals', 'cases.json');

export interface Layer3EvalCase {
  id: string;
  input: string;
  badReply: string;
  whyItFailed?: string;
  idealReply: string;
  channel?: Layer3Channel;
}

export interface Layer3EvalCaseResult {
  id: string;
  input: string;
  badCaught: boolean;
  badReasons: string[];
  idealPassed: boolean;
  idealReasons: string[];
  liveReply?: string;
  livePassed?: boolean;
  liveReasons?: string[];
  error?: string;
}

export interface Layer3EvalReport {
  total: number;
  badCaught: number;
  idealPassed: number;
  liveRun: number;
  livePassed: number;
  ok: boolean;
  results: Layer3EvalCaseResult[];
}

export async function loadLayer3EvalCases(dir: string): Promise<Layer3EvalCase[]> {
  try {
    const raw = await fs.readFile(path.join(dir, EVALS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is Layer3EvalCase =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as Layer3EvalCase).id === 'string' &&
        typeof (c as Layer3EvalCase).input === 'string' &&
        typeof (c as Layer3EvalCase).badReply === 'string' &&
        typeof (c as Layer3EvalCase).idealReply === 'string',
    );
  } catch {
    return [];
  }
}

export async function runLayer3Eval(opts: {
  dir: string;
  cases?: readonly Layer3EvalCase[];
  provider?: AiProvider;
  live?: boolean;
  now?: Date;
}): Promise<Layer3EvalReport> {
  const now = opts.now ?? new Date();
  const cases = opts.cases ?? (await loadLayer3EvalCases(opts.dir));
  const results: Layer3EvalCaseResult[] = [];
  const soul = opts.live && opts.provider ? await loadSoul(opts.dir).catch(() => undefined) : undefined;

  for (const c of cases) {
    const channel = c.channel ?? 'chat';
    const bad = await runLayer3Verify({ dir: opts.dir, text: c.badReply, query: c.input, channel, now });
    const ideal = await runLayer3Verify({ dir: opts.dir, text: c.idealReply, query: c.input, channel, now });
    const row: Layer3EvalCaseResult = {
      id: c.id,
      input: c.input,
      badCaught: !bad.ok,
      badReasons: bad.reasons,
      idealPassed: ideal.ok,
      idealReasons: ideal.reasons,
    };
    if (opts.live && opts.provider) {
      try {
        const prepared = await runLayer3Prepare({ dir: opts.dir, query: c.input, channel, now });
        const persona = buildPersona({ now, ...(soul ? { soul } : {}) });
        const system = withPersona('Reply concisely and naturally as Rufus. No JSON wrapper needed.', persona);
        const prompt = [prepared.context, `User: ${c.input}`].filter(Boolean).join('\n\n');
        const reply = (await opts.provider.complete({ system, messages: [{ role: 'user', content: prompt }], meta: { runId: 'eval', flowId: 'eval', step: c.id, attempt: 1 } })).trim();
        const check = await runLayer3Verify({ dir: opts.dir, text: reply, query: c.input, channel, now });
        row.liveReply = reply;
        row.livePassed = check.ok;
        row.liveReasons = check.reasons;
      } catch (err) {
        row.livePassed = false;
        row.error = err instanceof Error ? err.message : String(err);
      }
    }
    results.push(row);
  }

  const badCaught = results.filter((r) => r.badCaught).length;
  const idealPassed = results.filter((r) => r.idealPassed).length;
  const liveRun = results.filter((r) => r.liveReply !== undefined || r.error !== undefined).length;
  const livePassed = results.filter((r) => r.livePassed === true).length;
  const ok = badCaught === results.length && idealPassed === results.length && (!liveRun || livePassed === liveRun);
  return { total: results.length, badCaught, idealPassed, liveRun, livePassed, ok, results };
}

export function formatLayer3EvalReport(report: Layer3EvalReport): string[] {
  if (!report.total) return ['No Layer 3 eval cases found (add evals/cases.json in your workspace).'];
  const lines = [
    `Layer 3 Eval: caught ${report.badCaught}/${report.total} bad replies, passed ${report.idealPassed}/${report.total} ideal replies${report.liveRun ? `, live ${report.livePassed}/${report.liveRun}` : ''}.`,
  ];
  for (const r of report.results) {
    const ok = r.badCaught && r.idealPassed && (r.livePassed === undefined || r.livePassed);
    lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${r.id}`);
    if (!r.badCaught) lines.push(`       bad reply was NOT caught by taste.mjs/verify.mjs`);
    if (!r.idealPassed) lines.push(`       ideal reply was falsely rejected: ${r.idealReasons.join('; ')}`);
    if (r.livePassed === false) lines.push(`       live reply failed: ${r.error ?? (r.liveReasons?.join('; ') || 'unknown')}`);
  }
  return lines;
}
