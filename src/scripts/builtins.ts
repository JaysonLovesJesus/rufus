import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MessageSink, ModelProvider, Receipt, ToolManifest } from '../types';
import { runCreateBrain, runInvestigateBrain, runPlanBrain, runVerifyBrain, type BrainStateName } from '../brains/states';
import type { WatchStore } from '../events/watches';
import type { GapStore } from '../gaps/store';
import { renderWithSpeaker, type SpeakerWakeContext } from '../speaker/speaker';
import type { ApprovalStore, TrustLevel } from './approvals';
import type { ToolRegistry } from './registry';

const execFileAsync = promisify(execFile);

export interface BuiltinDeps {
  registry: ToolRegistry;
  approvals?: ApprovalStore;
  gaps?: GapStore;
  watches?: WatchStore;
  brainProvider?: ModelProvider;
  brainModel?: string;
  speakerProvider: ModelProvider;
  speakerModel?: string;
  sink: MessageSink;
  getActiveSink?: () => MessageSink;
  getWakeReceipts: () => readonly Receipt[];
  getWakeContext?: () => SpeakerWakeContext | undefined;
  getRecentSent?: () => Promise<string[]>;
  onSent: (text: string) => void;
  onApprovalDecision?: (decision: 'approved' | 'denied', toolId: string) => Promise<void>;
  searchMemory?: (query: string, opts?: { source?: string; limit?: number }) => Promise<Array<{ event: { id: string; timestamp: string; source: string; kind: string; actor?: string; text: string; deleted?: boolean; reactions?: Array<{ emoji: string; actor?: string }> }; score: number }>>;
  onSleep: (reason: string) => void;
  /** How often send_message refreshes the channel typing indicator while the Speaker writes (default 4000ms). */
  typingRefreshMs?: number;
}

/** Starts a best-effort typing indicator on the sink, refreshed on an interval. Returns a stop function. */
function startTyping(sink: MessageSink, refreshMs: number): () => void {
  if (!sink.sendTyping) return () => undefined;
  const ping = () => {
    Promise.resolve()
      .then(() => sink.sendTyping!())
      .catch((err) => console.error(`typing indicator failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  ping();
  const timer = setInterval(ping, refreshMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Registers the minimal core built-in scripts: send_message, tools.list_all, tools.create, tools.repair, sleep, system.startup_snapshot. */
export async function registerBuiltins(deps: BuiltinDeps): Promise<void> {
  const { registry } = deps;

  await registry.registerInline(
    {
      id: 'send_message',
      version: 1,
      description: 'Sends ONE concise natural message for ONE single purpose/intent, voiced by the fast Speaker from verified Code Receipts. If you have two separate topics or updates, send two separate messages across turns.',
      whenToUse: ['You have ONE focused purpose/update to send to the user (never cram multiple unrelated topics into one message — use separate turns)'],
      effect: 'write',
      requiresApproval: false,
      timeoutMs: 30_000,
      inputSchema: {
        type: 'object',
        properties: {
          purpose: { type: 'string', description: 'Short factual reason for this message (e.g. "announce restart", "answer ticket confirmation question").' },
        },
        required: ['purpose'],
        additionalProperties: false,
      },
      exampleInput: { purpose: 'Notify user I restarted and share the latest update.' },
    },
    async (input, ctx) => {
      const purpose = String(input.purpose ?? '').trim();
      const wakeContext = deps.getWakeContext?.();
      const activeSink = deps.getActiveSink ? deps.getActiveSink() : deps.sink;
      const stopTyping = startTyping(activeSink, deps.typingRefreshMs ?? 4000);
      let rendered: Awaited<ReturnType<typeof renderWithSpeaker>>;
      let sent: Awaited<ReturnType<MessageSink['send']>>;
      try {
        rendered = await renderWithSpeaker({
          workspaceDir: ctx.workspaceDir,
          provider: deps.speakerProvider,
          ...(deps.speakerModel ? { model: deps.speakerModel } : {}),
          purpose,
          receipts: deps.getWakeReceipts(),
          ...(wakeContext ? { wakeContext } : {}),
        });
        sent = await activeSink.send(rendered.text);
      } finally {
        stopTyping();
      }
      const messageId = sent && typeof sent === 'object' ? sent.messageId : undefined;
      deps.onSent(rendered.text);
      return {
        ok: true,
        summary: `Sent message to user (${rendered.text.length} chars${messageId ? `, messageId=${messageId}` : ''}${rendered.rewritten ? ', rewritten by truth gate' : ''}).`,
        changes: ['sent_message_to_user'],
        data: { ...(messageId ? { messageId } : {}), text: rendered.text, rewritten: rendered.rewritten, remainingViolations: rendered.violations },
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'edit_message',
      version: 1,
      description: 'Edits a previously sent message in place using a Purpose + the current wake context and Receipts.',
      whenToUse: ['You noticed an omission or typo in a message you just sent and have its messageId from the receipt'],
      effect: 'write',
      requiresApproval: false,
      timeoutMs: 30_000,
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The messageId returned by send_message' },
          purpose: { type: 'string', description: 'The corrected purpose for this message' },
        },
        required: ['messageId', 'purpose'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const activeSink = deps.getActiveSink ? deps.getActiveSink() : deps.sink;
      if (!activeSink.edit) return { ok: false, summary: 'This channel does not support editing messages.', error: 'edit not supported' };
      const messageId = String(input.messageId).trim();
      const purpose = String(input.purpose ?? '').trim();
      const wakeContext = deps.getWakeContext?.();
      const rendered = await renderWithSpeaker({
        workspaceDir: ctx.workspaceDir,
        provider: deps.speakerProvider,
        ...(deps.speakerModel ? { model: deps.speakerModel } : {}),
        purpose,
        receipts: deps.getWakeReceipts(),
        ...(wakeContext ? { wakeContext } : {}),
      });
      await activeSink.edit(messageId, rendered.text);
      return {
        ok: true,
        summary: `Edited message ${messageId} in place.`,
        changes: [`edited_message:${messageId}`],
        data: { messageId, text: rendered.text },
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'react_message',
      version: 1,
      description: 'Reacts to a user message with a single emoji (e.g. 👍, 🔥, 🫡, 🤔, ⚡) instead of or alongside texting.',
      whenToUse: ['User said something brief like "ok", "thanks", "cool" where an emoji reaction is cleaner than a text reply'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The messageId from the trigger event metadata' },
          emoji: { type: 'string', description: 'A standard Telegram reaction emoji (e.g. 👍, 🔥, ❤️, 🫡, 🤔, ⚡, 🎉)' },
        },
        required: ['messageId', 'emoji'],
        additionalProperties: false,
      },
    },
    async (input) => {
      if (!deps.sink.react) return { ok: false, summary: 'This channel does not support emoji reactions.', error: 'react not supported' };
      const messageId = String(input.messageId).trim();
      const emoji = String(input.emoji).trim();
      await deps.sink.react(messageId, emoji);
      return {
        ok: true,
        summary: `Reacted with ${emoji} on message ${messageId}.`,
        changes: [`reacted:${messageId}:${emoji}`],
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'tools.list_all',
      version: 1,
      description: 'Lists every registered packaged script (id, effect, approval requirement, description).',
      whenToUse: ['None of the top embedded tools fit what you need and you want to see the full catalog'],
      effect: 'meta',
      requiresApproval: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const list = registry.list().map((m) => ({
        id: m.id,
        effect: m.effect,
        requiresApproval: m.requiresApproval,
        description: m.description,
        inputs: Object.keys(m.inputSchema.properties ?? {}),
        required: m.inputSchema.required ?? [],
      }));
      return {
        ok: true,
        summary: `Listed ${list.length} registered tool(s).`,
        data: list,
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'tools.create',
      version: 1,
      description: 'Pioneer tool: creates a new packaged script (tool.json + run.mjs + test.mjs), runs test.mjs, and activates it if tests pass.',
      whenToUse: ['You need a repeatable deterministic capability that no existing tool provides'],
      effect: 'meta',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          manifest: { type: 'object', description: 'Valid tool.json object' },
          runCode: { type: 'string', description: 'ESM source for run.mjs exporting async function run(input, ctx)' },
          testCode: { type: 'string', description: 'ESM test script for test.mjs (exits 0 on pass)' },
        },
        required: ['manifest', 'runCode', 'testCode'],
        additionalProperties: false,
      },
    },
    async (input) => {
      const res = await registry.createOrRepair({
        manifest: input.manifest as ToolManifest,
        runCode: String(input.runCode),
        testCode: String(input.testCode),
      });
      if (!res.ok) return { ok: false, summary: `Tool creation failed: ${res.error}`, error: res.error };
      const id = (input.manifest as ToolManifest).id;
      return {
        ok: true,
        summary: `Created, tested, and embedded new packaged script "${id}".`,
        data: { id, testOutput: res.testOutput },
        nextHints: [id],
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'tools.repair',
      version: 1,
      description: 'Repairs a broken packaged script, re-runs test.mjs, and reactivates it if tests pass.',
      whenToUse: ['A script returned a brokenWarning or failed due to a bug or API change'],
      effect: 'meta',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          manifest: { type: 'object', description: 'Updated tool.json object' },
          runCode: { type: 'string', description: 'Fixed ESM source for run.mjs' },
          testCode: { type: 'string', description: 'Updated test.mjs' },
        },
        required: ['manifest', 'runCode', 'testCode'],
        additionalProperties: false,
      },
    },
    async (input) => {
      const res = await registry.createOrRepair({
        manifest: input.manifest as ToolManifest,
        runCode: String(input.runCode),
        testCode: String(input.testCode),
      });
      if (!res.ok) return { ok: false, summary: `Tool repair failed: ${res.error}`, error: res.error };
      const id = (input.manifest as ToolManifest).id;
      return {
        ok: true,
        summary: `Repaired, tested, and reactivated packaged script "${id}".`,
        data: { id, testOutput: res.testOutput },
        nextHints: [id],
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'memory.search',
      version: 1,
      description: 'Semantically searches Rufus\'s automatic real-world event memory (past messages, emails, calendar, screen/browser activity, and actions). Read-only — memory is recorded automatically by code.',
      whenToUse: ['You want to recall something from earlier conversations, messages, emails, or activity that is not already in the top wake context'],
      effect: 'read',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query (semantic meaning, not just exact keywords)' },
          source: { type: 'string', description: 'Optional source filter (e.g. "message", "email", "calendar", "screen", "browser", "download", "webhook")' },
          limit: { type: 'number', description: 'Max events to return (default 8, max 20)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      exampleInput: { query: 'Alex chat handle', limit: 6 },
    },
    async (input) => {
      if (!deps.searchMemory) return { ok: false, summary: 'Memory search is not configured.', error: 'searchMemory missing' };
      const query = String(input.query ?? '').trim();
      const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : undefined;
      const limit = Math.max(1, Math.min(20, Number(input.limit ?? 8) || 8));
      const hits = await deps.searchMemory(query, { ...(source ? { source } : {}), limit });
      const rows = hits.map((h) => ({
        timestamp: h.event.timestamp,
        source: h.event.source,
        kind: h.event.kind,
        ...(h.event.actor ? { actor: h.event.actor } : {}),
        text: h.event.text,
        ...(h.event.deleted ? { deleted: true } : {}),
        score: Number(h.score.toFixed(3)),
      }));
      return {
        ok: true,
        summary: `Found ${rows.length} memory event(s) matching "${query}".`,
        data: rows,
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'skills.save',
      version: 2,
      description: 'Updates one of the narrow Brain-State skills (DECIDE, INVESTIGATE, PLAN, CREATE, VERIFY) in skills/<STATE>.md.',
      whenToUse: ['Refining how a specific brain state operates (never spawn one-off micro-skill files)'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['DECIDE', 'INVESTIGATE', 'PLAN', 'CREATE', 'VERIFY'], description: 'Which brain-state skill to update' },
          content: { type: 'string', description: 'Clean markdown instructions for this brain state' },
        },
        required: ['state', 'content'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const state = String(input.state).toUpperCase() as BrainStateName;
      const dir = path.join(ctx.workspaceDir, 'skills');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${state}.md`), `${String(input.content).trim()}\n`, 'utf8');
      return { ok: true, summary: `Updated brain-state skill skills/${state}.md.`, changes: [`skill_saved:${state}`] };
    },
    { alwaysVisible: true },
  );

  // --- 4 Fresh-Context Narrow Brain-State AI Tools (Investigate, Plan, Create, Verify) ---

  await registry.registerInline(
    {
      id: 'brain.investigate',
      version: 1,
      description: 'Fresh-context READ-ONLY detective: inspects real files, logs, tools, or memory to answer ONE specific question and return verified facts + unknowns (never writes or guesses).',
      whenToUse: ['You do not yet have verified facts or root cause for a Gap or user request'],
      effect: 'read',
      requiresApproval: false,
      timeoutMs: 120_000,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The exact question to investigate from reality' },
          maxSteps: { type: 'number', description: 'Max read-only steps (default 5, max 8)' },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const res = await runInvestigateBrain({
        workspaceDir: ctx.workspaceDir,
        provider,
        ...(deps.brainModel ? { model: deps.brainModel } : {}),
        registry,
        question: String(input.question ?? '').trim(),
        ...(input.maxSteps ? { maxSteps: Number(input.maxSteps) } : {}),
        now: ctx.now,
      });
      return { ok: true, summary: res.summary, data: res };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'brain.plan',
      version: 1,
      description: 'Fresh-context strategist: breaks a big Gap + verified facts into concrete, verifiable Sub-Gaps, options, and tradeoffs (does not execute anything).',
      whenToUse: ['A Gap is too big or fuzzy for one action and needs concrete Sub-Gaps, options, or a plan'],
      effect: 'meta',
      requiresApproval: false,
      timeoutMs: 90_000,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The Gap/goal to break down' },
          verifiedFacts: { type: 'string', description: 'Observed facts from Investigate / Receipts' },
          constraints: { type: 'string', description: 'Optional constraints (budget, trust, timeline)' },
        },
        required: ['goal', 'verifiedFacts'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const plan = await runPlanBrain({
        workspaceDir: ctx.workspaceDir,
        provider,
        ...(deps.brainModel ? { model: deps.brainModel } : {}),
        goal: String(input.goal ?? '').trim(),
        verifiedFacts: String(input.verifiedFacts ?? '').trim(),
        ...(typeof input.constraints === 'string' && input.constraints.trim() ? { constraints: input.constraints.trim() } : {}),
      });
      return {
        ok: true,
        summary: String(plan.recommendation || 'Produced top-down plan and Sub-Gaps.'),
        data: plan,
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'brain.create',
      version: 1,
      description: 'Fresh-context builder: produces one concrete non-code work artifact (lesson, copy, script, spec, draft) saved to drafts/<slug>.md.',
      whenToUse: ['A Sub-Gap requires creating a real written artifact grounded in verified facts'],
      effect: 'write',
      requiresApproval: false,
      timeoutMs: 90_000,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Artifact title' },
          brief: { type: 'string', description: 'Exact requirements for what to create' },
          verifiedFacts: { type: 'string', description: 'Verified facts to ground the artifact in' },
          slug: { type: 'string', description: 'Optional filename slug' },
        },
        required: ['title', 'brief', 'verifiedFacts'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const res = await runCreateBrain({
        workspaceDir: ctx.workspaceDir,
        provider,
        ...(deps.brainModel ? { model: deps.brainModel } : {}),
        title: String(input.title ?? '').trim(),
        brief: String(input.brief ?? '').trim(),
        verifiedFacts: String(input.verifiedFacts ?? '').trim(),
        ...(typeof input.slug === 'string' ? { slug: input.slug } : {}),
      });
      return {
        ok: true,
        summary: `Created artifact ${res.path} (${res.chars} chars).`,
        changes: [`created_draft:${res.path}`],
        data: res,
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'brain.verify',
      version: 1,
      description: 'Fresh-context reality checker: checks ONE Target directly against reality using read-only tools and returns PASS/FAIL + proof. The ONLY tool that can close a Gap on the Gap Board.',
      whenToUse: ['After taking an action or when checking if a Gap/Target is genuinely closed in reality'],
      effect: 'read',
      requiresApproval: false,
      timeoutMs: 120_000,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Exact desired end-state to check against reality (no bias or hints from prior attempts)' },
          gapId: { type: 'string', description: 'Optional Gap ID on the Gap Board — automatically closed by code ONLY if verification PASSES' },
          maxSteps: { type: 'number', description: 'Max read-only check steps (default 5, max 8)' },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const target = String(input.target ?? '').trim();
      const gapId = typeof input.gapId === 'string' && input.gapId.trim() ? input.gapId.trim() : undefined;
      const res = await runVerifyBrain({
        workspaceDir: ctx.workspaceDir,
        provider,
        ...(deps.brainModel ? { model: deps.brainModel } : {}),
        registry,
        target,
        ...(input.maxSteps ? { maxSteps: Number(input.maxSteps) } : {}),
        now: ctx.now,
      });
      let closedGap = false;
      if (res.passed && gapId && deps.gaps) {
        const closed = await deps.gaps.closeVerified(gapId, res.evidence, `verify_${ctx.now.getTime()}`, ctx.now);
        closedGap = !!closed;
      }
      return {
        ok: true,
        summary: `Verify ${res.passed ? 'PASS' : 'FAIL'}: ${res.evidence}${closedGap ? ` (closed ${gapId})` : ''}`,
        changes: closedGap && gapId ? [`gap_closed:${gapId}`] : [],
        data: { ...res, ...(gapId ? { gapId, closedGap } : {}) },
      };
    },
    { alwaysVisible: true },
  );

  // --- Gap Board Tools ---

  await registry.registerInline(
    {
      id: 'gaps.create',
      version: 1,
      description: 'Adds a qualified Gap (or Sub-Gap under parentId) to the Gap Board. Top-level observed gaps start `proposed` (need owner approval); owner-instructed gaps or sub-gaps under an open parent start `open`.',
      whenToUse: ['You have verified current reality + a concrete verifiable Target for a new Gap or Sub-Gap'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short concrete Gap title' },
          target: { type: 'string', description: 'Verifiable end-state that brain.verify can check' },
          reality: { type: 'string', description: 'Verified current reality from Investigate / Receipts' },
          source: { type: 'string', enum: ['owner', 'observed'], description: 'owner (instructed by user) or observed (spotted by Rufus)' },
          parentId: { type: 'string', description: 'Optional parent Gap ID when breaking a big Gap into a Sub-Gap' },
        },
        required: ['title', 'target', 'reality', 'source'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'Gap Board not configured.', error: 'no gap store' };
      const trigger = deps.getWakeContext?.()?.trigger;
      const requestedSource = input.source === 'owner' ? 'owner' : 'observed';
      // Only a direct owner message can create an unapproved top-level `owner` gap
      const source = requestedSource === 'owner' && trigger?.kind === 'owner_direct' ? 'owner' : 'observed';
      const gap = await deps.gaps.create({
        title: String(input.title),
        target: String(input.target),
        reality: String(input.reality),
        source,
        ...(typeof input.parentId === 'string' && input.parentId.trim() ? { parentId: input.parentId.trim() } : {}),
        ...(trigger?.id ? { evidenceIds: [trigger.id] } : {}),
        now: ctx.now,
      });
      return {
        ok: true,
        summary: `Added Gap ${gap.id} [${gap.status}]: ${gap.title}`,
        changes: [`gap_created:${gap.id}`],
        data: gap,
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'gaps.approve',
      version: 1,
      description: 'Promotes a `proposed` observed Gap to `open` after the owner approves it directly.',
      whenToUse: ['User approved a proposed Gap on the Gap Board'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: { gapId: { type: 'string', description: 'Gap ID to promote to open' } },
        required: ['gapId'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'Gap Board not configured.', error: 'no gap store' };
      const trigger = deps.getWakeContext?.()?.trigger;
      if (!trigger || trigger.kind !== 'owner_direct') {
        return { ok: false, summary: 'Refused: only the owner can approve a proposed Gap.', error: 'owner_direct required' };
      }
      const g = await deps.gaps.approve(String(input.gapId).trim(), ctx.now);
      if (!g) return { ok: false, summary: `Gap ${input.gapId} not found.`, error: 'not found' };
      return { ok: true, summary: `Gap ${g.id} is now open: ${g.title}`, changes: [`gap_opened:${g.id}`], data: g };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'gaps.update',
      version: 1,
      description: 'Updates a Gap\'s verified reality, target, or waiting status (`open` | `waiting`). Cannot close a Gap — only `brain.verify` passing can close a Gap.',
      whenToUse: ['Updating verified reality on a Gap or marking a Gap `waiting` on a T3 thread / user reply'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          gapId: { type: 'string' },
          reality: { type: 'string' },
          target: { type: 'string' },
          status: { type: 'string', enum: ['open', 'waiting'] },
          waitingOn: { type: 'string', description: 'What this Gap is waiting on (empty string clears it)' },
        },
        required: ['gapId'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'Gap Board not configured.', error: 'no gap store' };
      const g = await deps.gaps.update(
        String(input.gapId).trim(),
        {
          ...(typeof input.reality === 'string' ? { reality: input.reality } : {}),
          ...(typeof input.target === 'string' ? { target: input.target } : {}),
          ...(input.status === 'open' || input.status === 'waiting' ? { status: input.status } : {}),
          ...(typeof input.waitingOn === 'string' ? { waitingOn: input.waitingOn.trim() || null } : {}),
        },
        ctx.now,
      );
      if (!g) return { ok: false, summary: `Gap ${input.gapId} not found.`, error: 'not found' };
      return { ok: true, summary: `Updated Gap ${g.id} [${g.status}].`, changes: [`gap_updated:${g.id}`], data: g };
    },
    { alwaysVisible: true },
  );

  // --- Productivity Watch / Alarm Tool ---

  await registry.registerInline(
    {
      id: 'watch.set',
      version: 1,
      description: 'Sets a real alarm/timer (minutesFromNow or fireAt ISO) or watches a running T3 Code threadId so deterministic code wakes Rufus automatically when due/finished.',
      whenToUse: ['You launched a T3 Code thread or want to follow up on a waiting Gap at a specific time'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['timer', 't3_thread'] },
          label: { type: 'string', description: 'What to check when this watch fires' },
          gapId: { type: 'string', description: 'Optional Gap ID this watch belongs to' },
          minutesFromNow: { type: 'number', description: 'For kind=timer: minutes from now' },
          fireAt: { type: 'string', description: 'For kind=timer: explicit ISO timestamp' },
          threadId: { type: 'string', description: 'For kind=t3_thread: exact T3 Code thread id' },
        },
        required: ['kind', 'label'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.watches) return { ok: false, summary: 'Watch store not configured.', error: 'no watch store' };
      const kind = input.kind === 't3_thread' ? 't3_thread' : 'timer';
      const fireAt =
        kind === 'timer'
          ? typeof input.fireAt === 'string' && input.fireAt.trim()
            ? input.fireAt.trim()
            : new Date(ctx.now.getTime() + Math.max(1, Number(input.minutesFromNow ?? 15)) * 60_000).toISOString()
          : undefined;
      const w = await deps.watches.add(
        {
          kind,
          label: String(input.label).trim(),
          ...(typeof input.gapId === 'string' && input.gapId.trim() ? { gapId: input.gapId.trim() } : {}),
          ...(fireAt ? { fireAt } : {}),
          ...(typeof input.threadId === 'string' && input.threadId.trim() ? { threadId: input.threadId.trim() } : {}),
        },
        ctx.now,
      );
      return { ok: true, summary: `Set ${kind} watch ${w.id}: ${w.label}`, changes: [`watch_set:${w.id}`], data: w };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'approvals.approve',
      version: 2,
      description: 'Executes a pending `draft` Trust-Gate action after the user verbally/directly says yes. Code-verified: only works on direct owner messages/voice.',
      whenToUse: ['There is a pending approval on The Desk and the user directly confirmed or approved it'],
      effect: 'write',
      requiresApproval: false,
      timeoutMs: 120_000,
      inputSchema: {
        type: 'object',
        properties: {
          approvalId: { type: 'string', description: 'Optional pending approval id (defaults to the most recent pending approval)' },
          alwaysAllow: { type: 'boolean', description: 'Legacy alias: promotes tool to act_and_report' },
          promoteTo: { type: 'string', enum: ['act_and_report', 'act_quietly'], description: 'Set ONLY if the user explicitly asked to raise trust for this tool' },
        },
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.approvals) return { ok: false, summary: 'Approval store not configured.', error: 'no approval store' };
      const trigger = deps.getWakeContext?.()?.trigger;
      if (!trigger || trigger.kind !== 'owner_direct') {
        return {
          ok: false,
          summary: 'Refused: approvals can only be granted directly by the owner (never by external messages or emails).',
          error: 'owner_direct required',
        };
      }
      const id = typeof input.approvalId === 'string' && input.approvalId.trim() ? input.approvalId.trim() : undefined;
      const pending = await deps.approvals.take(id);
      if (!pending) return { ok: false, summary: 'No matching pending approval found.', error: 'no pending approval' };
      const promote: TrustLevel | undefined =
        input.promoteTo === 'act_quietly' || input.promoteTo === 'act_and_report'
          ? input.promoteTo
          : input.alwaysAllow === true
            ? 'act_and_report'
            : undefined;
      if (promote) {
        await deps.approvals.setLevel(pending.toolId, promote);
      }
      const execReceipt = await registry.call(pending.toolId, pending.input, {
        workspaceDir: ctx.workspaceDir,
        now: ctx.now,
        approved: true,
      });
      await deps.onApprovalDecision?.('approved', pending.toolId);
      return {
        ok: execReceipt.status === 'ok',
        summary: `Approved & ran ${pending.toolId}: ${execReceipt.summary}${promote ? ` (trust raised to ${promote})` : ''}`,
        changes: [...execReceipt.changes, ...(promote ? [`trust_promoted:${pending.toolId}:${promote}`] : [])],
        data: execReceipt.data,
        ...(execReceipt.error ? { error: execReceipt.error } : {}),
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'approvals.deny',
      version: 2,
      description: 'Cancels a pending approval-gated action when the user says no / skip / cancel (and drops trust if needed).',
      whenToUse: ['There is a pending approval on The Desk and the user declined or cancelled it'],
      effect: 'meta',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          approvalId: { type: 'string', description: 'Optional pending approval id (defaults to the most recent pending approval)' },
        },
        additionalProperties: false,
      },
    },
    async (input) => {
      if (!deps.approvals) return { ok: false, summary: 'Approval store not configured.', error: 'no approval store' };
      const id = typeof input.approvalId === 'string' && input.approvalId.trim() ? input.approvalId.trim() : undefined;
      const pending = await deps.approvals.take(id);
      if (!pending) return { ok: false, summary: 'No matching pending approval found.', error: 'no pending approval' };
      await deps.approvals.demote(pending.toolId);
      await deps.onApprovalDecision?.('denied', pending.toolId);
      return { ok: true, summary: `Cancelled pending approval ${pending.id} (${pending.toolId}).` };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'sleep',
      version: 1,
      description: 'Ends this wake and returns the system to $0 Waiting Mode.',
      whenToUse: ['You finished responding or determined nothing needs action right now'],
      effect: 'meta',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short factual reason for going back to sleep.' },
        },
        required: ['reason'],
        additionalProperties: false,
      },
      exampleInput: { reason: 'Answered user question.' },
    },
    async (input) => {
      const reason = String(input.reason ?? 'done').trim();
      deps.onSleep(reason);
      return { ok: true, summary: `Sleeping: ${reason}` };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'system.startup_snapshot',
      version: 1,
      description: 'Collects exact $0 startup state (loaded tools, workspace files, recent event count) for a personalized startup message.',
      whenToUse: ['System just booted or restarted and needs to orient the user'],
      effect: 'read',
      requiresApproval: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async (_input, ctx) => {
      const lastChange = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: process.cwd(), timeout: 1500 })
        .then((r) => r.stdout.trim())
        .catch(() => undefined);
      return {
        ok: true,
        summary: `Restarted.${lastChange ? ` Latest update: ${lastChange}` : ''}`,
        data: {
          startedAt: ctx.now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          ...(lastChange ? { latestUpdate: lastChange } : {}),
        },
        nextHints: ['send_message'],
      };
    },
  );
}
