import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ModelProvider, Receipt, ToolManifest } from '../types';
import type { ToolRegistry } from '../scripts/registry';

export type BrainStateName = 'DECIDE' | 'INVESTIGATE' | 'PLAN' | 'CREATE' | 'VERIFY';

const DEFAULT_SKILLS: Record<BrainStateName, string> = {
  DECIDE: [
    '# Decide (Executive — One Move at a Time)',
    'Your ONLY job is to pick the single best next tool call from The Desk.',
    '- Think Top-Down from the Gap Board. Every non-chat move serves an open Gap (or creates/qualifies a Gap).',
    '- If there are no open Gaps yet, discovering real Goals/Gaps IS your top Gap.',
    '- Never guess root causes or facts — call `brain.investigate` first.',
    '- Never break down a big, fuzzy Gap in your head — call `brain.plan` first.',
    '- Never claim a Gap is closed without calling `brain.verify` to prove it against reality.',
    '- Call `sleep` once all open Gaps are either closed or genuinely waiting.',
  ].join('\n'),
  INVESTIGATE: [
    '# Investigate (Read-Only Fact Finder)',
    'Your ONLY job is to answer ONE question from real files, tools, logs, or memory.',
    '- You have ONLY read-only tools. You never write, patch, or guess.',
    '- Separate what you directly OBSERVED in tool Receipts from what is still UNKNOWN.',
    '- Stop as soon as you have verified facts (or hit a real unknown) and return a crisp JSON summary.',
  ].join('\n'),
  PLAN: [
    '# Plan (Top-Down Breakdown & Tradeoffs)',
    'Your ONLY job is to take one big Gap + verified facts and break it into concrete, verifiable Sub-Gaps, options, and tradeoffs.',
    '- Every Sub-Gap must have a concrete Target that Verify can check against reality.',
    '- Name risks, tradeoffs, and the single highest-leverage first move. Do not execute anything.',
  ].join('\n'),
  CREATE: [
    '# Create (Real Work Artifact Builder)',
    'Your ONLY job is to produce one concrete, high-craft work artifact (lesson, copy, script, spec, draft) for a specific Sub-Gap.',
    '- Ground every factual claim strictly in the verified facts given to you; mark any missing detail as [TBD] instead of inventing it.',
  ].join('\n'),
  VERIFY: [
    '# Verify (Fresh Reality Check)',
    'Your ONLY job is to check ONE Target claim directly against reality using read-only tools.',
    '- You have no history of any prior attempt — trust ONLY what you directly observe in Receipts right now.',
    '- Return PASS only if reality clearly satisfies the Target; otherwise return FAIL with exact observed evidence.',
  ].join('\n'),
};

/** Loads `<workspace>/skills/<STATE>.md` (falling back to built-in default skill). */
export async function loadBrainSkill(workspaceDir: string, state: BrainStateName): Promise<string> {
  const candidates = [
    path.join(workspaceDir, 'skills', `${state}.md`),
    path.join(workspaceDir, 'skills', `${state.toLowerCase()}.md`),
  ];
  for (const p of candidates) {
    try {
      const raw = (await fs.readFile(p, 'utf8')).replace(/^---[\s\S]*?---\s*/m, '').trim();
      if (raw) return raw;
    } catch {
      /* try next */
    }
  }
  return DEFAULT_SKILLS[state];
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const clean = (raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = clean.indexOf('{');
  const b = clean.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try {
    return JSON.parse(clean.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function formatReadTools(tools: readonly ToolManifest[]): string {
  return tools
    .map((t) => `- ${t.id}: ${t.description} | inputSchema: ${JSON.stringify(t.inputSchema)}`)
    .join('\n');
}

function formatMiniReceipts(receipts: readonly Receipt[]): string {
  if (!receipts.length) return '(none yet)';
  return receipts
    .map(
      (r, i) =>
        `Step ${i + 1}: ${r.toolId} -> ${r.status}\n` +
        `  summary: ${r.summary}` +
        (r.data !== undefined ? `\n  data: ${(typeof r.data === 'string' ? r.data : JSON.stringify(r.data)).slice(0, 4000)}` : '') +
        (r.error ? `\n  error: ${r.error}` : ''),
    )
    .join('\n\n');
}

/**
 * Fresh-context read-only sub-loop used by BOTH `brain.investigate` and `brain.verify`.
 * Structurally CANNOT execute any write tool — only `effect === 'read'` tools exist in its world.
 */
async function runReadOnlyBrain(opts: {
  state: 'INVESTIGATE' | 'VERIFY';
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  registry: ToolRegistry;
  mission: string;
  maxSteps?: number;
  now: Date;
}): Promise<{ done: Record<string, unknown>; receipts: Receipt[] }> {
  const skill = await loadBrainSkill(opts.workspaceDir, opts.state);
  const readTools = opts.registry.list().filter((t) => t.effect === 'read');
  const maxSteps = Math.max(1, Math.min(8, opts.maxSteps ?? 5));
  const receipts: Receipt[] = [];

  const doneSchema =
    opts.state === 'VERIFY'
      ? '{"done":true,"passed":true|false,"evidence":"exact observed proof","remaining":"what is still missing if failed"}'
      : '{"done":true,"facts":["observed fact 1",...],"unknowns":["what could not be verified",...],"summary":"1-2 line synthesis"}';

  const system = [
    skill,
    '',
    'On each step reply with ONLY ONE JSON object:',
    `- To inspect reality: {"toolId":"<read-only tool id>","input":{...}}`,
    `- When finished:      ${doneSchema}`,
    'Rules: You may ONLY call read-only tools from the list below. Never guess.',
  ].join('\n');

  for (let step = 0; step < maxSteps; step++) {
    const prompt = [
      `Mission:\n${opts.mission}`,
      `Available Read-Only Tools:\n${formatReadTools(readTools)}`,
      `Receipts Collected So Far:\n${formatMiniReceipts(receipts)}`,
      step === maxSteps - 1
        ? `Final step (${step + 1}/${maxSteps}): reply ONLY with the {"done":true,...} JSON object based strictly on collected Receipts.`
        : `Step ${step + 1}/${maxSteps}. Reply with ONLY JSON.`,
    ].join('\n\n');

    const raw = await opts.provider.complete({ system, prompt, ...(opts.model ? { model: opts.model } : {}) });
    const parsed = parseJsonObject(raw);
    if (!parsed) break;
    if (parsed.done === true || !parsed.toolId) {
      return { done: parsed, receipts };
    }

    const toolId = String(parsed.toolId).trim();
    const manifest = opts.registry.get(toolId)?.manifest;
    if (!manifest || manifest.effect !== 'read') {
      receipts.push({
        toolId,
        effect: 'read',
        status: 'failed',
        durationMs: 0,
        summary: `Refused: "${toolId}" is not a read-only tool.`,
        changes: [],
        error: 'read-only state cannot run non-read tools',
        at: opts.now.toISOString(),
      });
      continue;
    }
    const input = parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input) ? (parsed.input as Record<string, unknown>) : {};
    const receipt = await opts.registry.call(toolId, input, { workspaceDir: opts.workspaceDir, now: opts.now });
    receipts.push(receipt);
  }

  return {
    done:
      opts.state === 'VERIFY'
        ? { done: true, passed: false, evidence: receipts.map((r) => r.summary).join(' | ') || 'No checks completed.', remaining: 'Verification did not conclude PASS.' }
        : { done: true, facts: receipts.filter((r) => r.status === 'ok').map((r) => r.summary), unknowns: ['Step limit reached before full synthesis.'], summary: 'Collected partial read-only Receipts.' },
    receipts,
  };
}

export async function runInvestigateBrain(opts: {
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  registry: ToolRegistry;
  question: string;
  maxSteps?: number;
  now: Date;
}) {
  const { done, receipts } = await runReadOnlyBrain({
    state: 'INVESTIGATE',
    workspaceDir: opts.workspaceDir,
    provider: opts.provider,
    ...(opts.model ? { model: opts.model } : {}),
    registry: opts.registry,
    mission: `Question to investigate from reality:\n${opts.question}`,
    ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
    now: opts.now,
  });
  const facts = Array.isArray(done.facts) ? done.facts.map(String) : [];
  const unknowns = Array.isArray(done.unknowns) ? done.unknowns.map(String) : [];
  const summary = typeof done.summary === 'string' && done.summary.trim() ? done.summary.trim() : `Investigated "${opts.question}" (${facts.length} fact(s), ${unknowns.length} unknown(s)).`;
  return { summary, facts, unknowns, steps: receipts.length, receipts: receipts.map((r) => ({ toolId: r.toolId, status: r.status, summary: r.summary })) };
}

export async function runVerifyBrain(opts: {
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  registry: ToolRegistry;
  target: string;
  maxSteps?: number;
  now: Date;
}) {
  const { done, receipts } = await runReadOnlyBrain({
    state: 'VERIFY',
    workspaceDir: opts.workspaceDir,
    provider: opts.provider,
    ...(opts.model ? { model: opts.model } : {}),
    registry: opts.registry,
    mission: `Target condition to verify against reality right now:\n${opts.target}`,
    ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
    now: opts.now,
  });
  // Require at least 1 successful read Receipt to pass verification — cannot PASS purely from the AI's head!
  const ranRealCheck = receipts.some((r) => r.status === 'ok');
  const passed = done.passed === true && ranRealCheck;
  const evidence = typeof done.evidence === 'string' && done.evidence.trim() ? done.evidence.trim() : receipts.map((r) => r.summary).join(' | ');
  const remaining = typeof done.remaining === 'string' && done.remaining.trim() ? done.remaining.trim() : (!ranRealCheck ? 'No real read-only check was executed.' : undefined);
  return { passed, evidence, ...(remaining ? { remaining } : {}), steps: receipts.length };
}

export async function runPlanBrain(opts: {
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  goal: string;
  verifiedFacts: string;
  constraints?: string;
}) {
  const skill = await loadBrainSkill(opts.workspaceDir, 'PLAN');
  const system = [
    skill,
    '',
    'Reply with ONLY a JSON object:',
    '{"recommendation":"clear 1-2 line recommendation","subGaps":[{"title":"...","target":"verifiable end state","firstMove":"..."}],"options":[{"name":"...","pros":"...","cons":"..."}],"openQuestions":["..."]}',
  ].join('\n');
  const prompt = [
    `Gap / Goal to plan:\n${opts.goal}`,
    `Verified Reality:\n${opts.verifiedFacts}`,
    ...(opts.constraints ? [`Constraints:\n${opts.constraints}`] : []),
  ].join('\n\n');
  const raw = await opts.provider.complete({ system, prompt, ...(opts.model ? { model: opts.model } : {}) });
  const parsed = parseJsonObject(raw) ?? { recommendation: raw.trim().slice(0, 600), subGaps: [], options: [], openQuestions: [] };
  return parsed;
}

export async function runCreateBrain(opts: {
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  title: string;
  brief: string;
  verifiedFacts: string;
  slug?: string;
}) {
  const skill = await loadBrainSkill(opts.workspaceDir, 'CREATE');
  const system = [skill, '', 'Write ONLY the finished artifact content in clean markdown (no meta-commentary).'].join('\n');
  const prompt = [`Title: ${opts.title}`, `Brief:\n${opts.brief}`, `Verified Facts to Ground In:\n${opts.verifiedFacts}`].join('\n\n');
  const content = (await opts.provider.complete({ system, prompt, ...(opts.model ? { model: opts.model } : {}) })).trim();
  const slug = (opts.slug || opts.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'artifact';
  const dir = path.join(opts.workspaceDir, 'drafts');
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${slug}.md`);
  await fs.writeFile(outPath, `${content}\n`, 'utf8');
  return { path: outPath, chars: content.length, preview: content.slice(0, 400) };
}
