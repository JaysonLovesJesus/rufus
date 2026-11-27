import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ModelProvider, Receipt, ToolManifest } from '../types';
import type { ToolRegistry } from '../scripts/registry';

export type BrainStateName = 'DECIDE' | 'INVESTIGATE' | 'PLAN' | 'CREATE' | 'VERIFY';

const DEFAULT_SKILLS: Record<BrainStateName, string> = {
  DECIDE: [
    '# Decide — Top-Down, One Move at a Time',
    '',
    'Start at the top of the Desk, never at the event.',
    '',
    '1. **Gap tree first.** Read what the owner wants true and what is true now. The event is new reality: which gap does it change? An owner message is a new desired state (name it as a new gap), new reality on an existing gap, or a sign that a closed gap is not done (reopen it).',
    "2. **Targets are the owner's outcome.** Write the target as what the owner wants true, in the owner's own words, with the context the owner gave: what, in what form, where, by when, why. A deliverable can be the target when that is what the owner wants; never swap in your own plan for the owner's outcome. Keep the owner's guesses and hints about how to get there (where it might be, which tool) out of the target: they are leads, not requirements.",
    "3. **Fastest move on the biggest gap.** Speed is a value. Never defer work: do now everything that doesn't need anyone else. If the owner is asleep or busy, only the owner's part waits (with a chase scheduled); everything else moves now, so the owner's part is as small and quick as possible when the owner is back. Quiet hours can hold back a ping; they never hold back the work. Small gaps are fine; they build trust.",
    '4. **Use the whole arsenal.** `brain.investigate` for missing facts, `brain.plan` to split a big gap, `brain.create` for written work, scripts, `t3.thread` for code, messages, email, calendar, `tools.create` when a tool is missing.',
    '5. **Blocked? Find another way.** If the owner is the blocker, chase: schedule the next nudge, and change the approach each time (a shorter ask, different wording or channel, a ready answer or default the owner can just approve).',
    "6. **Done means the target is true in reality.** Call `brain.verify` on the gap. The owner's own reaction is the strongest evidence. Once a message delivers what the owner asked for, the next move is `brain.verify`, not another message: never resend or re-explain what the owner already has.",
    "7. **The root gap is never done.** When nothing else can move, work the root right now: look around (projects, messages, calendar, email, your own recent actions) for what the owner wants true that isn't, and create those gaps. Don't schedule the look for later while you're awake now.",
    "8. **Before `sleep`:** check each unclosed gap's Next move on the tree. A gap with NONE gets a move now, or a `watch.set` serving it (a running `t3.thread` already counts). The root's next move is your next look for gaps.",
  ].join('\n'),
  INVESTIGATE: [
    '# Investigate — Read-Only Reality Finder',
    '',
    'Your ONLY job is to answer ONE specific question directly from reality (files, logs, git, calendar, email, messages, project tools, memory).',
    '',
    '- You are strictly read-only. Never guess, never patch, never speculate beyond what your tool Receipts show.',
    '- Look for root causes, not surface symptoms.',
    '- Separate **Facts** (directly observed in Receipts) from **Unknowns** (what could not be verified yet).',
    '- Stop as soon as the question is answered cleanly.',
  ].join('\n'),
  PLAN: [
    '# Plan — Top-Down Gap Breakdown & Tradeoffs',
    '',
    'Your ONLY job is to take ONE big Gap + verified reality and break it down from the top into concrete, verifiable Sub-Gaps.',
    '',
    '- Every Sub-Gap must directly shrink the parent Gap and have a clear Target that `Verify` can check against reality.',
    '- Surface real options, honest pros/cons, and one clear recommendation.',
    '- Never execute or pretend a step is done — hand back a tight, actionable plan.',
  ].join('\n'),
  CREATE: [
    '# Create — Focused Artifact Builder',
    '',
    'Your ONLY job is to produce ONE concrete, high-craft non-code work artifact (lesson, landing copy, script, spec, proposal) for a specific Sub-Gap.',
    '',
    '- Ground every factual claim strictly in the verified facts provided.',
    '- Never invent numbers, quotes, or claims — mark missing specifics `[TBD]`.',
    '- Keep writing crisp, direct, and ready to review or ship.',
  ].join('\n'),
  VERIFY: [
    '# Verify — Fresh Reality Check',
    '',
    'Your ONLY job is to check ONE Target (what the owner wants true) directly against reality using read-only tools.',
    '',
    '- Trust NOTHING except what you directly observe in Receipts right now.',
    '- You MUST run at least one real read-only check before concluding PASS.',
    '- Check the outcome the owner wants, including its form and context (e.g. "in chat", "a few thoughts", "by Friday"). Something close, or a different deliverable, is FAIL.',
    '- Hints about how or where to get it ("probably in a group chat") are leads, not requirements: if the owner has what they wanted, it does not matter which path found it.',
    '- If you are given the owner conversation since the gap opened, weigh it: if the owner said it is not what was wanted, that is FAIL.',
    "- Return `passed: true` ONLY when reality unmistakably meets the Target; otherwise return `passed: false` with exact observed evidence of what's still off.",
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

/** How much of a receipt's data a brain sees: the newest read whole (reads are capped at 24k by the registry), older ones shorter. */
export const BRAIN_LATEST_DATA_CHARS = 26_000;
export const BRAIN_OLDER_DATA_CHARS = 4_000;

/** Cuts receipt data to a budget and says so, so a brain never mistakes a partial read for the whole thing. */
export function clipData(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n  [TRUNCATED: showing ${budget} of ${text.length} chars. The rest was not shown; to see it, call the tool again for the next part (e.g. files.read with startLine), don't guess.]`;
}

function formatMiniReceipts(receipts: readonly Receipt[]): string {
  if (!receipts.length) return '(none yet)';
  return receipts
    .map((r, i) => {
      const budget = i === receipts.length - 1 ? BRAIN_LATEST_DATA_CHARS : BRAIN_OLDER_DATA_CHARS;
      return (
        `Step ${i + 1}: ${r.toolId} -> ${r.status}\n` +
        `  summary: ${r.summary}` +
        (r.data !== undefined ? `\n  data: ${clipData(typeof r.data === 'string' ? r.data : JSON.stringify(r.data), budget)}` : '') +
        (r.error ? `\n  error: ${r.error}` : '')
      );
    })
    .join('\n\n');
}

/** Tools a brain may call: read-only, and never another brain (brain.verify closes gaps; brains don't nest). */
export function brainTools(registry: ToolRegistry): ToolManifest[] {
  return registry.list().filter((t) => t.effect === 'read' && !t.id.startsWith('brain.'));
}

/** A brain returns what it has at this share of its tool timeout, rather than losing everything to the timeout. */
const DEADLINE_SHARE = 0.8;
/** Past this share of the timeout, the next step is the last one: write up the facts. */
const WRAP_UP_SHARE = 0.6;

const TIMED_OUT = Symbol('timed_out');
async function before<T>(p: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> {
  const left = deadline - Date.now();
  if (left <= 0) return TIMED_OUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), left)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The facts in the receipts collected so far, when a brain has to stop before writing them up itself. */
function partialFacts(receipts: readonly Receipt[]): string[] {
  return receipts
    .filter((r) => r.status === 'ok')
    .map((r) => {
      const data = r.data === undefined ? '' : typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      return `${r.toolId}: ${r.summary}${data ? ` | ${data.slice(0, 600)}${data.length > 600 ? ` [first 600 of ${data.length} chars]` : ''}` : ''}`;
    });
}

/**
 * Fresh-context read-only sub-loop used by BOTH `brain.investigate` and `brain.verify`.
 * Structurally CANNOT execute any write tool — only `effect === 'read'` tools exist in its world, and no other brain.
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
  /** The tool's own timeout: the brain wraps up and returns partial facts before it. */
  timeoutMs?: number;
}): Promise<{ done: Record<string, unknown>; receipts: Receipt[]; stoppedEarly?: string }> {
  const skill = await loadBrainSkill(opts.workspaceDir, opts.state);
  const readTools = brainTools(opts.registry);
  const maxSteps = Math.max(1, Math.min(8, opts.maxSteps ?? 5));
  const receipts: Receipt[] = [];
  const started = Date.now();
  const deadline = opts.timeoutMs ? started + opts.timeoutMs * DEADLINE_SHARE : Number.POSITIVE_INFINITY;
  const wrapUpAt = opts.timeoutMs ? started + opts.timeoutMs * WRAP_UP_SHARE : Number.POSITIVE_INFINITY;

  const doneSchema =
    opts.state === 'VERIFY'
      ? '{"done":true,"passed":true|false,"criteria":[{"element":"what|form|where|by when|why","criterion":"one part of the Target","receiptIndex":<the Step number whose receipt shows it>,"observed":"what that receipt shows","met":true|false}],"evidence":"exact observed proof","remaining":"what is still missing if failed"}'
      : '{"done":true,"facts":["observed fact 1",...],"unknowns":["what could not be verified",...],"summary":"1-2 line synthesis"}';

  const system = [
    skill,
    '',
    'On each step reply with ONLY ONE JSON object:',
    `- To inspect reality: {"toolId":"<read-only tool id>","input":{...}}`,
    `- When finished:      ${doneSchema}`,
    'Rules: You may ONLY call read-only tools from the list below. Never guess.',
  ].join('\n');

  let stoppedEarly: string | undefined;
  for (let step = 0; step < maxSteps; step++) {
    const last = step === maxSteps - 1 || Date.now() >= wrapUpAt;
    const prompt = [
      `Mission:\n${opts.mission}`,
      `Available Read-Only Tools:\n${formatReadTools(readTools)}`,
      `Receipts Collected So Far:\n${formatMiniReceipts(receipts)}`,
      last
        ? `Final step (${step + 1}/${maxSteps}${step < maxSteps - 1 ? ', time is nearly up' : ''}): reply ONLY with the {"done":true,...} JSON object based strictly on collected Receipts.`
        : `Step ${step + 1}/${maxSteps}. Reply with ONLY JSON.`,
    ].join('\n\n');

    const raw = await before(opts.provider.complete({ system, prompt, ...(opts.model ? { model: opts.model } : {}) }), deadline);
    if (raw === TIMED_OUT) {
      stoppedEarly = `ran out of time after ${receipts.length} step(s) (${Math.round((Date.now() - started) / 1000)}s)`;
      break;
    }
    const parsed = parseJsonObject(raw);
    if (!parsed) {
      stoppedEarly = `its reply at step ${step + 1} was not a JSON object`;
      break;
    }
    if (parsed.done === true || !parsed.toolId) {
      return { done: parsed, receipts };
    }
    if (last) break;

    const toolId = String(parsed.toolId).trim();
    const manifest = opts.registry.get(toolId)?.manifest;
    if (!manifest || manifest.effect !== 'read' || toolId.startsWith('brain.')) {
      receipts.push({
        toolId,
        effect: 'read',
        status: 'failed',
        durationMs: 0,
        summary: toolId.startsWith('brain.')
          ? `Refused: brains don't call other brains ("${toolId}"). Use a tool from Available Read-Only Tools.`
          : !manifest
            ? `Refused: there is no tool "${toolId}". Use an id from Available Read-Only Tools.`
            : `Refused: "${toolId}" changes things (${manifest.effect}), and you may only read. Use a tool from Available Read-Only Tools, or report it as an unknown.`,
        changes: [],
        error: 'read-only state cannot run non-read tools',
        at: opts.now.toISOString(),
      });
      continue;
    }
    const input = parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input) ? (parsed.input as Record<string, unknown>) : {};
    const receipt = await before(opts.registry.call(toolId, input, { workspaceDir: opts.workspaceDir, now: opts.now }), deadline);
    if (receipt === TIMED_OUT) {
      stoppedEarly = `ran out of time while ${toolId} was running, after ${receipts.length} step(s)`;
      break;
    }
    receipts.push(receipt);
  }

  const why = stoppedEarly ?? 'step limit reached before a write-up';
  return {
    done:
      opts.state === 'VERIFY'
        ? { done: true, passed: false, evidence: receipts.map((r) => r.summary).join(' | ') || 'No checks completed.', remaining: `Verification did not conclude PASS (${why}).` }
        : { done: true, facts: partialFacts(receipts), unknowns: [`Partial: ${why}; these facts are only what the receipts showed.`], summary: `Partial investigation (${why}).` },
    receipts,
    ...(stoppedEarly ? { stoppedEarly } : {}),
  };
}

export async function runInvestigateBrain(opts: {
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  registry: ToolRegistry;
  question: string;
  /** The gap the question serves (target, reality, work log, project card, the owner's words). */
  gapContext?: string;
  maxSteps?: number;
  timeoutMs?: number;
  now: Date;
}) {
  const { done, receipts, stoppedEarly } = await runReadOnlyBrain({
    state: 'INVESTIGATE',
    workspaceDir: opts.workspaceDir,
    provider: opts.provider,
    ...(opts.model ? { model: opts.model } : {}),
    registry: opts.registry,
    mission: `Question to investigate from reality:\n${opts.question}${opts.gapContext ? `\n\nThe gap this question serves:\n${opts.gapContext}` : ''}`,
    ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    now: opts.now,
  });
  const facts = Array.isArray(done.facts) ? done.facts.map(String) : [];
  const unknowns = Array.isArray(done.unknowns) ? done.unknowns.map(String) : [];
  const summary = typeof done.summary === 'string' && done.summary.trim() ? done.summary.trim() : `Investigated "${opts.question}" (${facts.length} fact(s), ${unknowns.length} unknown(s)).`;
  return {
    summary,
    facts,
    unknowns,
    steps: receipts.length,
    ...(stoppedEarly ? { partial: stoppedEarly } : {}),
    receipts: receipts.map((r) => ({ toolId: r.toolId, status: r.status, summary: r.summary })),
  };
}

export interface VerifiedCriterion {
  element: string;
  criterion: string;
  observed: string;
  met: boolean;
  receipt?: { step: number; toolId: string; status: string; summary: string };
}

/**
 * Code's reading of the verifier's criteria: a criterion counts as met only when it cites a step whose receipt succeeded.
 * Step 0 is the conversation code handed over (real logged messages), when there was one.
 */
export function checkCriteria(done: Record<string, unknown>, receipts: readonly Receipt[], opts: { hasContext: boolean; needsByWhen: boolean }): { criteria: VerifiedCriterion[]; problems: string[] } {
  const raw = Array.isArray(done.criteria) ? done.criteria : [];
  const problems: string[] = [];
  const criteria: VerifiedCriterion[] = raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => {
      const element = String(c.element ?? 'what').trim().toLowerCase();
      const criterion = String(c.criterion ?? '').trim() || element;
      const observed = String(c.observed ?? '').trim();
      const step = Number(c.receiptIndex ?? c.receipt ?? c.step);
      const r = Number.isInteger(step) && step >= 1 ? receipts[step - 1] : undefined;
      const fromContext = step === 0 && opts.hasContext;
      const cited = fromContext
        ? { step: 0, toolId: 'conversation', status: 'ok', summary: 'Owner <-> Rufus conversation from the event log' }
        : r
          ? { step, toolId: r.toolId, status: r.status, summary: r.summary.slice(0, 300) }
          : undefined;
      const backed = !!cited && cited.status === 'ok';
      if (!backed) problems.push(`"${criterion}" cites no successful receipt${cited ? ` (step ${cited.step} was ${cited.status})` : ''}`);
      else if (c.met === false) problems.push(`"${criterion}" not met: ${observed || 'see receipt'}`);
      return { element, criterion, observed, met: backed && c.met !== false, ...(cited ? { receipt: cited } : {}) };
    });
  if (!criteria.length) problems.push('the verifier listed no criteria with receipts');
  if (opts.needsByWhen && !criteria.some((c) => c.element.includes('when'))) problems.push('no "by when" criterion was checked against the due time');
  return { criteria, problems };
}

export async function runVerifyBrain(opts: {
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  registry: ToolRegistry;
  target: string;
  /** Extra observed reality to weigh (e.g. the owner conversation since the gap opened); citable as step 0. */
  context?: string;
  /** The rest of what is known about the gap (reality, work log, project card): leads, not proof. */
  gapContext?: string;
  /** The owner's by-when (ISO), when the gap has one. */
  due?: string;
  maxSteps?: number;
  timeoutMs?: number;
  now: Date;
}) {
  const byWhen = opts.due ? `\n\nBy when: the owner wants this true by ${opts.due} (it is now ${opts.now.toISOString()}). Check this as its own "by when" criterion.` : '';
  const { done, receipts } = await runReadOnlyBrain({
    state: 'VERIFY',
    workspaceDir: opts.workspaceDir,
    provider: opts.provider,
    ...(opts.model ? { model: opts.model } : {}),
    registry: opts.registry,
    mission: [
      `Target condition to verify against reality right now:\n${opts.target}${byWhen}`,
      'Split the Target into its parts (what, form, where, by when) and check each one. For each criterion, cite the Step number of the receipt that shows it (receiptIndex). A criterion with no successful receipt behind it fails.',
      ...(opts.context ? [`Step 0 (given, citable as receiptIndex 0):\n${opts.context}`] : []),
      ...(opts.gapContext ? [`What is known about this gap (leads, not proof):\n${opts.gapContext}`] : []),
    ].join('\n\n'),
    ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    now: opts.now,
  });
  // Cannot PASS from the AI's head: at least one real check ran, and every criterion cites a successful receipt.
  const ranRealCheck = receipts.some((r) => r.status === 'ok');
  const { criteria, problems } = checkCriteria(done, receipts, { hasContext: !!opts.context, needsByWhen: !!opts.due });
  const passed = done.passed === true && ranRealCheck && problems.length === 0;
  const evidence = typeof done.evidence === 'string' && done.evidence.trim() ? done.evidence.trim() : receipts.map((r) => r.summary).join(' | ');
  const said = typeof done.remaining === 'string' && done.remaining.trim() ? done.remaining.trim() : '';
  const codeSays = !ranRealCheck ? 'No real read-only check was executed.' : done.passed === true && problems.length ? `Code failed the PASS: ${problems.join('; ')}.` : '';
  const remaining = [said, codeSays].filter(Boolean).join(' ') || undefined;
  return {
    passed,
    evidence,
    ...(remaining ? { remaining } : {}),
    criteria,
    steps: receipts.length,
    receipts: receipts.map((r, i) => ({ step: i + 1, toolId: r.toolId, status: r.status, summary: r.summary.slice(0, 300) })),
  };
}

export async function runPlanBrain(opts: {
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  goal: string;
  verifiedFacts: string;
  constraints?: string;
  /** The gap being planned, in full (target, reality, work log, project card, the owner's words). */
  gapContext?: string;
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
    `Verified Reality:\n${opts.verifiedFacts || '(none given beyond the gap below)'}`,
    ...(opts.constraints ? [`Constraints:\n${opts.constraints}`] : []),
    ...(opts.gapContext ? [`The gap, as the board knows it:\n${opts.gapContext}`] : []),
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
  /** The gap the artifact serves, in full (target, reality, work log, project card, the owner's words). */
  gapContext?: string;
}) {
  const skill = await loadBrainSkill(opts.workspaceDir, 'CREATE');
  const system = [
    skill,
    '',
    'Write ONLY the finished artifact content in clean markdown (no meta-commentary).',
    `Then, on its own line, write ${CHAT_MARK} followed by a chat-length version of the same substance (plain text, at most ${CHAT_MAX_CHARS} characters) that could be sent as one message.`,
  ].join('\n');
  const prompt = [
    `Title: ${opts.title}`,
    `Brief:\n${opts.brief}`,
    `Verified Facts to Ground In:\n${opts.verifiedFacts || '(none given beyond the gap below)'}`,
    ...(opts.gapContext ? [`The gap this serves:\n${opts.gapContext}`] : []),
  ].join('\n\n');
  const raw = (await opts.provider.complete({ system, prompt, ...(opts.model ? { model: opts.model } : {}) })).trim();
  const { content, chat } = splitChat(raw);
  const slug = (opts.slug || opts.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'artifact';
  const dir = path.join(opts.workspaceDir, 'drafts');
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${slug}.md`);
  await fs.writeFile(outPath, `${content}\n`, 'utf8');
  // The full content comes back, so Decide and the Speaker never have to re-read (and half-read) a fresh draft.
  return { path: outPath, chars: content.length, content, chat };
}

const CHAT_MARK = '===CHAT===';
const CHAT_MAX_CHARS = 700;

/** Splits the artifact from its chat-length version; without one, the chat version is the opening paragraphs that fit. */
export function splitChat(raw: string): { content: string; chat: string } {
  const at = raw.indexOf(CHAT_MARK);
  const content = (at >= 0 ? raw.slice(0, at) : raw).trim();
  const given = at >= 0 ? raw.slice(at + CHAT_MARK.length).trim() : '';
  if (given) return { content, chat: given.slice(0, CHAT_MAX_CHARS * 2) };
  let chat = '';
  for (const para of content.split(/\n\s*\n/)) {
    const next = chat ? `${chat}\n\n${para.trim()}` : para.trim();
    if (next.length > CHAT_MAX_CHARS) break;
    chat = next;
  }
  return { content, chat: chat || `${content.slice(0, CHAT_MAX_CHARS - 1)}…` };
}
