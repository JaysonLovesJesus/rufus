import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MessageSink, ModelProvider, Receipt, ScriptOutput, ToolManifest } from '../types';
import { recordOpsFailure } from '../eval/ops-log';
import { runCreateBrain, runInvestigateBrain, runPlanBrain, runVerifyBrain, type BrainStateName } from '../brains/states';
import { servesGap, type WatchStore } from '../events/watches';
import { gapBrief, gapText, hashSimilarity, loadProjectCards, matchProjectCard, raisingEvent, type Similarity } from '../gaps/context';
import { ROOT_GAP_ID, ownerSpoke, parseDue, resolveGapSource, type Gap, type GapStore } from '../gaps/store';
import { renderWithSpeaker, type SpeakerWakeContext } from '../speaker/speaker';
import type { ApprovalStore, TrustLevel } from './approvals';
import { protectedTargets, RUFUS_REPO_DIR } from './protected';
import type { ToolRegistry } from './registry';
import { registerRollbackTool } from './rollback';
import { registerSelfUpgrade } from './self-upgrade';
import { archiveSkill } from './versions';

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
  /** Logs what Rufus sent, with the channel's messageId so later edits and the Desk can point at it. */
  onSent: (text: string, messageId?: string) => void | Promise<void>;
  /** Updates the logged message after a successful edit, so the log shows what the owner now sees. */
  onEdited?: (messageId: string, text: string) => Promise<void>;
  /** Who wrote a logged message, by its channel messageId (only Rufus's own messages can be edited). */
  messageAuthor?: (messageId: string) => Promise<'rufus' | 'owner' | undefined>;
  /** Scores texts against a query by meaning (the event store's embedder); falls back to a local hash embedder. */
  similarity?: Similarity;
  onApprovalDecision?: (decision: 'approved' | 'denied', toolId: string, approvalId?: string) => Promise<void>;
  searchMemory?: (query: string, opts?: { source?: string; limit?: number }) => Promise<Array<{ event: { id: string; timestamp: string; source: string; kind: string; actor?: string; text: string; deleted?: boolean; reactions?: Array<{ emoji: string; actor?: string }>; provenance?: string; metadata?: Record<string, unknown> }; score: number }>>;
  onSleep: (reason: string) => void;
  /** The owner <-> Rufus conversation since a time (owner messages and what Rufus sent), oldest first. */
  getConversationSince?: (iso: string) => Promise<string[]>;
  /** How often send_message refreshes the channel typing indicator while the Speaker writes (default 4000ms). */
  typingRefreshMs?: number;
}

/** The failed receipt for a draft the truth gate still rejects after its rewrite: nothing was sent. */
function gateRefusal(rendered: { text: string; violations: string[]; blocked: string[] }): ScriptOutput {
  return {
    ok: false,
    summary: `Not sent: the draft still failed the truth gate after a rewrite (${rendered.blocked.join('; ')}). Make the real change first, or ask for a message that says plainly what has not happened yet.`,
    error: 'truth_gate',
    data: { draft: rendered.text, violations: rendered.violations },
  };
}

/** approvals.approve / deny with no draft to act on: the id is wrong, or the draft was already handled. */
const NO_PENDING_APPROVAL =
  'No matching pending approval. Nothing ran. Use an id from "Pending approvals" on the Desk; if none is listed, the draft was already approved or cancelled, so check its receipt or redo the move.';

/** brain.investigate and brain.verify: the brain itself wraps up at ~80% of this and returns what it has. */
const READ_BRAIN_TIMEOUT_MS = 120_000;

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

/** Registers the engine's built-in tools: talking, the tool library, memory search, skills, the four brains, gaps, watches, approvals, sleep, startup, rollback and self-upgrade. */
export async function registerBuiltins(deps: BuiltinDeps): Promise<void> {
  const { registry } = deps;
  const similarity = deps.similarity ?? hashSimilarity;

  /** Everything the board knows about a gap, handed to a brain so Decide never has to retype it. */
  const gapContextFor = async (gapId: unknown, workspaceDir: string, now: Date, opts: { withOwnerWords?: boolean } = {}): Promise<{ gap?: Gap; brief?: string }> => {
    const id = typeof gapId === 'string' ? gapId.trim() : '';
    const gap = id && deps.gaps ? await deps.gaps.get(id) : undefined;
    if (!gap) return {};
    const card = gap.id === ROOT_GAP_ID ? undefined : await matchProjectCard(await loadProjectCards(workspaceDir), gapText(gap), similarity);
    const ownerWords =
      opts.withOwnerWords !== false && deps.getConversationSince ? (await deps.getConversationSince(gap.createdAt)).filter((l) => /\] Owner:/.test(l)) : [];
    return { gap, brief: gapBrief({ gap, ...(card ? { card } : {}), ownerWords, now }) };
  };

  /** A gap that is closed or dropped needs no next move: its watches go in the same step. */
  const retireWatchesFor = async (gapId: string): Promise<number> => {
    if (!deps.watches) return 0;
    const retired = await deps.watches.reconcile((w) => {
      if (!servesGap(w, gapId)) return w;
      const others = (w.gapIds ?? []).filter((x) => x !== gapId);
      // A quick return shared with other stranded gaps keeps serving them.
      return others.length ? { ...w, gapId: w.gapId === gapId ? others[0]! : w.gapId, gapIds: others } : null;
    });
    return retired.length;
  };

  await registry.registerInline(
    {
      id: 'send_message',
      version: 1,
      description: "Sends the owner ONE short message for ONE purpose. The Speaker writes it from your purpose and this wake's receipts; a claim no receipt backs is rewritten or blocked, so do the work before saying it is done. Two topics are two messages, on separate turns.",
      whenToUse: ['You have one focused thing to tell or ask the owner (never cram unrelated topics into one message; use separate turns)'],
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
      exampleInput: { purpose: 'Tell the owner I restarted and share the latest update.' },
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
          ...(activeSink.channel ? { channel: activeSink.channel } : {}),
          now: ctx.now,
        });
        // A draft that still fails the truth gate after its rewrite is never sent: Decide gets the violations and re-plans.
        if (rendered.blocked.length) return gateRefusal(rendered);
        sent = await activeSink.send(rendered.text).catch(async (err: unknown) => {
          await recordOpsFailure(ctx.workspaceDir, { kind: 'send_failed', channel: activeSink.channel, error: err });
          throw err;
        });
      } finally {
        stopTyping();
      }
      const messageId = sent && typeof sent === 'object' ? sent.messageId : undefined;
      // In the log before the next move runs, so an edit right after (or the channel's echo) finds it. The message is out either way.
      await Promise.resolve(deps.onSent(rendered.text, messageId)).catch((err: unknown) =>
        console.error(`logging a sent message failed: ${err instanceof Error ? err.message : String(err)}`),
      );
      return {
        ok: true,
        summary: `Sent message to the owner (${rendered.text.length} chars${messageId ? `, messageId=${messageId}` : ''}${rendered.rewritten ? ', rewritten by truth gate' : ''}).`,
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
      if (!activeSink.edit) return { ok: false, summary: 'Not edited: this channel does not support editing messages. Send the correction as a new short message (send_message) instead.', error: 'edit not supported' };
      const messageId = String(input.messageId).trim();
      // Only Rufus's own messages can be edited; the owner's ids sit next to Rufus's on the Desk.
      if ((await deps.messageAuthor?.(messageId)) === 'owner') {
        return { ok: false, summary: `Refused: message ${messageId} is the owner's, not one Rufus sent. Use the messageId of your own message (marked "You (Rufus)" on the Desk, or in the send_message receipt).`, error: 'not_own_message' };
      }
      const purpose = String(input.purpose ?? '').trim();
      const wakeContext = deps.getWakeContext?.();
      const rendered = await renderWithSpeaker({
        workspaceDir: ctx.workspaceDir,
        provider: deps.speakerProvider,
        ...(deps.speakerModel ? { model: deps.speakerModel } : {}),
        purpose,
        receipts: deps.getWakeReceipts(),
        ...(wakeContext ? { wakeContext } : {}),
        ...(activeSink.channel ? { channel: activeSink.channel } : {}),
        now: ctx.now,
      });
      if (rendered.blocked.length) return gateRefusal(rendered);
      await activeSink.edit(messageId, rendered.text).catch(async (err: unknown) => {
        await recordOpsFailure(ctx.workspaceDir, { kind: 'edit_failed', channel: activeSink.channel, error: err });
        throw err;
      });
      await deps.onEdited?.(messageId, rendered.text).catch(() => undefined);
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
      description: "Reacts to one of the owner's messages with a single emoji (e.g. 👍, 🔥, 🫡, 🤔, ⚡) instead of or alongside texting.",
      whenToUse: ['The owner said something brief like "ok", "thanks", "cool" where an emoji reaction is cleaner than a text reply'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: "The owner's messageId, shown on the Desk next to the incoming event and each owner message" },
          emoji: { type: 'string', description: 'A standard Telegram reaction emoji (e.g. 👍, 🔥, ❤️, 🫡, 🤔, ⚡, 🎉)' },
        },
        required: ['messageId', 'emoji'],
        additionalProperties: false,
      },
    },
    async (input) => {
      // The channel this wake talks on, like send_message and edit_message (a voice wake has no message to react to).
      const activeSink = deps.getActiveSink ? deps.getActiveSink() : deps.sink;
      if (!activeSink.react) return { ok: false, summary: 'Not reacted: this channel does not support emoji reactions. Reply with a short send_message if a reply is needed, or skip it.', error: 'react not supported' };
      const messageId = String(input.messageId).trim();
      const emoji = String(input.emoji).trim();
      await activeSink.react(messageId, emoji);
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
      description: 'Lists every registered tool with its effect, approval requirement and description (the Desk shows every id, but only some in full).',
      whenToUse: ['A tool in the Desk\'s tool index might fit, but its description is not shown in full on the Desk'],
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
    async (input, ctx) => {
      const res = await registry.createOrRepair({
        manifest: input.manifest as ToolManifest,
        runCode: String(input.runCode),
        testCode: String(input.testCode),
        tag: { reason: 'tools.create', now: ctx.now, ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}), ...(ctx.gapId ? { gapId: ctx.gapId } : {}) },
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
    async (input, ctx) => {
      const res = await registry.createOrRepair({
        manifest: input.manifest as ToolManifest,
        runCode: String(input.runCode),
        testCode: String(input.testCode),
        tag: { reason: 'tools.repair', now: ctx.now, ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}), ...(ctx.gapId ? { gapId: ctx.gapId } : {}) },
      });
      if (!res.ok) return { ok: false, summary: `Tool repair failed: ${res.error}`, error: res.error };
      const id = (input.manifest as ToolManifest).id;
      return {
        ok: true,
        summary: `Repaired, tested, and reactivated packaged script "${id}".${res.replaced ? ` Previous version kept (${res.replaced}); tools.rollback restores it.` : ''}`,
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
      // The event that woke Rufus (and anything that arrived mid-wake) is already on the Desk; recall should find something new.
      const wake = deps.getWakeContext?.();
      const onDesk = new Set([wake?.trigger?.id, ...(wake?.arrivals ?? []).map((a) => a.id)].filter(Boolean));
      const hits = (await deps.searchMemory(query, { ...(source ? { source } : {}), limit: limit + onDesk.size })).filter((h) => !onDesk.has(h.event.id)).slice(0, limit);
      const rows = hits.map((h) => ({
        id: h.event.id,
        timestamp: h.event.timestamp,
        source: h.event.source,
        kind: h.event.kind,
        ...(h.event.actor ? { actor: h.event.actor } : {}),
        // Whose word it is: a Rufus claim is not proof, and a superseded one was contradicted.
        ...(h.event.provenance ? { provenance: h.event.provenance } : {}),
        ...(typeof h.event.metadata?.supersededBy === 'string' ? { supersededBy: h.event.metadata.supersededBy } : {}),
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
      description: 'Replaces one brain skill (DECIDE, INVESTIGATE, PLAN, CREATE, VERIFY) in skills/<STATE>.md with `content`. It overwrites the whole file, so send the full skill with your change in it, not just the new part. The old version is kept for tools.rollback.',
      whenToUse: ['Refining how a specific brain state operates (never spawn one-off micro-skill files)'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['DECIDE', 'INVESTIGATE', 'PLAN', 'CREATE', 'VERIFY'], description: 'Which brain-state skill to update' },
          content: { type: 'string', description: 'The complete new skill in markdown (it replaces the whole file)' },
        },
        required: ['state', 'content'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const state = String(input.state).toUpperCase() as BrainStateName;
      const dir = path.join(ctx.workspaceDir, 'skills');
      await fs.mkdir(dir, { recursive: true });
      const kept = await archiveSkill(dir, state, { at: ctx.now, reason: 'skills.save', ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}), ...(ctx.gapId ? { gapId: ctx.gapId } : {}) });
      await fs.writeFile(path.join(dir, `${state}.md`), `${String(input.content).trim()}\n`, 'utf8');
      return {
        ok: true,
        summary: `Replaced brain skill skills/${state}.md.${kept ? ` Previous version kept as skills/.history/${kept}.md (tools.rollback restores it).` : ''}`,
        changes: [`skill_saved:${state}`],
      };
    },
    { alwaysVisible: true },
  );

  // --- 4 Fresh-Context Narrow Brain-State AI Tools (Investigate, Plan, Create, Verify) ---

  await registry.registerInline(
    {
      id: 'brain.investigate',
      version: 1,
      description: 'Fresh-context READ-ONLY detective: inspects real files, logs, tools, or memory to answer ONE specific question and return verified facts + unknowns (never writes or guesses).',
      whenToUse: ['You do not yet have verified facts or the root cause for a gap or an owner request'],
      effect: 'read',
      requiresApproval: false,
      timeoutMs: READ_BRAIN_TIMEOUT_MS,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The exact question to investigate from reality' },
          gapId: { type: 'string', description: "The gap it serves (filled in from the move's gap): the brain gets its target, reality, work log, project card and the owner's words, and its facts are saved on the gap" },
          maxSteps: { type: 'number', description: 'Max read-only steps (default 5, max 8)' },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const { gap, brief } = await gapContextFor(input.gapId, ctx.workspaceDir, ctx.now);
      const res = await runInvestigateBrain({
        workspaceDir: ctx.workspaceDir,
        provider,
        ...(deps.brainModel ? { model: deps.brainModel } : {}),
        registry,
        question: String(input.question ?? '').trim(),
        ...(brief ? { gapContext: brief } : {}),
        ...(input.maxSteps ? { maxSteps: Number(input.maxSteps) } : {}),
        timeoutMs: READ_BRAIN_TIMEOUT_MS,
        now: ctx.now,
      });
      // What was found belongs to the gap, so the next wake (and the next brain) starts from it.
      if (gap && deps.gaps && res.facts.length) await deps.gaps.annotate(gap.id, { addFindings: res.facts.map((f) => f.slice(0, 400)) });
      return { ok: true, summary: `${res.partial ? '[PARTIAL] ' : ''}${res.summary}`, data: res };
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
          verifiedFacts: { type: 'string', description: "Observed facts from Investigate / Receipts (the gap's saved facts are added automatically)" },
          constraints: { type: 'string', description: 'Optional constraints (budget, trust, timeline)' },
          gapId: { type: 'string', description: "The gap being planned (filled in from the move's gap): the planner gets everything the board knows about it" },
        },
        required: ['goal'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const { gap, brief } = await gapContextFor(input.gapId, ctx.workspaceDir, ctx.now);
      const plan = await runPlanBrain({
        workspaceDir: ctx.workspaceDir,
        provider,
        ...(deps.brainModel ? { model: deps.brainModel } : {}),
        goal: String(input.goal ?? '').trim(),
        verifiedFacts: String(input.verifiedFacts ?? '').trim(),
        ...(typeof input.constraints === 'string' && input.constraints.trim() ? { constraints: input.constraints.trim() } : {}),
        ...(brief ? { gapContext: brief } : {}),
      });
      if (gap && deps.gaps && plan.recommendation) await deps.gaps.annotate(gap.id, { addFindings: [`Plan: ${String(plan.recommendation).slice(0, 300)}`] });
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
          verifiedFacts: { type: 'string', description: "Verified facts to ground the artifact in (the gap's saved facts are added automatically)" },
          slug: { type: 'string', description: 'Optional filename slug' },
          gapId: { type: 'string', description: "The gap it serves (filled in from the move's gap): the builder gets the target, reality, work log, project card and the owner's words" },
        },
        required: ['title', 'brief'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const { gap, brief } = await gapContextFor(input.gapId, ctx.workspaceDir, ctx.now);
      const res = await runCreateBrain({
        workspaceDir: ctx.workspaceDir,
        provider,
        ...(deps.brainModel ? { model: deps.brainModel } : {}),
        title: String(input.title ?? '').trim(),
        brief: String(input.brief ?? '').trim(),
        verifiedFacts: String(input.verifiedFacts ?? '').trim(),
        ...(typeof input.slug === 'string' ? { slug: input.slug } : {}),
        ...(brief ? { gapContext: brief } : {}),
      });
      if (gap && deps.gaps) await deps.gaps.annotate(gap.id, { addFindings: [`Draft written: ${res.path} (${res.chars} chars)`] });
      return {
        ok: true,
        summary: `Created artifact ${res.path} (${res.chars} chars). The full content and a chat-length version are in data.content and data.chat.`,
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
      description: "Fresh-context reality checker: checks a gap's own Target (what the owner wants true) directly against reality using read-only tools, and returns PASS/FAIL + proof. The ONLY tool that can close a gap. The verifier also sees the owner conversation since the gap opened.",
      whenToUse: ['You think a gap is closed and want it checked against reality'],
      effect: 'read',
      requiresApproval: false,
      timeoutMs: READ_BRAIN_TIMEOUT_MS,
      inputSchema: {
        type: 'object',
        properties: {
          gapId: { type: 'string', description: "Gap to verify (filled in from the move's gap). Its stored Target is what gets checked; it is closed by code ONLY if verification PASSES." },
          target: { type: 'string', description: 'Only when verifying something that is not a gap: the exact end-state to check' },
          maxSteps: { type: 'number', description: 'Max read-only check steps (default 5, max 8)' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const gapId = typeof input.gapId === 'string' && input.gapId.trim() ? input.gapId.trim() : undefined;
      const gap = gapId && deps.gaps ? await deps.gaps.get(gapId) : undefined;
      // A gap is checked against its OWN stored target, never an easier claim written in the moment.
      const target = gap ? gap.target : String(input.target ?? '').trim();
      if (!target) return { ok: false, summary: 'Nothing to verify: name a gap (or give a target).', error: 'no target' };
      const conversation = gap && deps.getConversationSince ? await deps.getConversationSince(gap.createdAt) : [];
      // The conversation is already step 0, so the rest of the brief leaves the owner's words out.
      const { brief } = gap ? await gapContextFor(gap.id, ctx.workspaceDir, ctx.now, { withOwnerWords: false }) : {};
      const res = await runVerifyBrain({
        workspaceDir: ctx.workspaceDir,
        provider,
        ...(deps.brainModel ? { model: deps.brainModel } : {}),
        registry,
        target,
        ...(conversation.length
          ? { context: `Owner <-> Rufus conversation, from the owner message that opened this gap to now (the owner's own words are the strongest evidence of what they want and whether it is met):\n${conversation.join('\n')}` }
          : {}),
        ...(brief ? { gapContext: brief } : {}),
        ...(gap?.due ? { due: gap.due } : {}),
        ...(input.maxSteps ? { maxSteps: Number(input.maxSteps) } : {}),
        timeoutMs: READ_BRAIN_TIMEOUT_MS,
        now: ctx.now,
      });
      let closedGap = false;
      let retired = 0;
      if (gap && deps.gaps) {
        // What was checked, and the receipt behind each criterion, stays on the gap.
        const verifyId = `verify_${ctx.now.getTime()}`;
        await deps.gaps.annotate(gap.id, {
          lastVerify: { at: ctx.now.toISOString(), passed: res.passed, criteria: res.criteria, ...(res.remaining ? { remaining: res.remaining } : {}) },
          addEvidence: [verifyId],
        });
        if (res.passed) {
          // The root gap never closes; a passing check only refreshes its reality.
          await deps.gaps.closeVerified(gap.id, res.evidence, verifyId, ctx.now);
          closedGap = gap.id !== ROOT_GAP_ID;
          if (closedGap) retired = await retireWatchesFor(gap.id);
        }
      }
      return {
        ok: true,
        summary: `Verify ${res.passed ? 'PASS' : 'FAIL'}${gap ? ` for ${gap.id}` : ''}: ${res.evidence}${!res.passed && res.remaining ? ` | still off: ${res.remaining}` : ''}${closedGap ? ` (closed ${gapId}${retired ? `, retired ${retired} watch(es)` : ''})` : ''}`,
        changes: closedGap && gapId ? [`gap_closed:${gapId}`] : [],
        data: { ...res, ...(gapId ? { gapId, closedGap } : {}) },
      };
    },
    { alwaysVisible: true },
  );

  // --- Gap tree tools ---

  await registry.registerInline(
    {
      id: 'gaps.create',
      version: 1,
      description: "Adds a gap to the tree under parentId (filled in from the move's gap; top-level gaps hang off the root). Gaps the owner states start `open`; new gaps Rufus spots start `proposed` until the owner says yes; splitting an approved gap starts `open`.",
      whenToUse: ['A desired state of the owner needs its own gap', 'A gap is too big and needs splitting into smaller gaps'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short concrete gap title' },
          target: { type: 'string', description: "What the owner wants true, in the owner's own words and context; brain.verify checks exactly this" },
          reality: { type: 'string', description: 'What is true now (from Receipts / Investigate)' },
          source: { type: 'string', enum: ['owner', 'observed'], description: 'owner (the owner asked for it) or observed (spotted by Rufus)' },
          parentId: { type: 'string', description: "Parent gap (filled in from the move's gap)" },
          due: { type: 'string', description: "ISO time the owner wants it true by, only when the owner's words give a by-when (e.g. \"by Friday\" -> that Friday's end in the owner's time zone)" },
        },
        required: ['title', 'target'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'The gap tree is not configured.', error: 'no gap store' };
      const wake = deps.getWakeContext?.();
      const trigger = wake?.trigger;
      const source = resolveGapSource(input.source, ownerSpoke(trigger, wake?.arrivals));
      // The gap points at the message that raised it, which may have arrived mid-wake rather than being the trigger.
      const raisedBy = await raisingEvent({ spec: { title: String(input.title), target: String(input.target) }, ...(trigger ? { trigger } : {}), arrivals: wake?.arrivals ?? [], similarity });
      const gap = await deps.gaps.create({
        title: String(input.title),
        target: String(input.target),
        reality: typeof input.reality === 'string' ? input.reality : 'Not measured yet.',
        source,
        ...(typeof input.parentId === 'string' && input.parentId.trim() ? { parentId: input.parentId.trim() } : {}),
        ...(raisedBy?.id ? { evidenceIds: [raisedBy.id] } : {}),
        ...(parseDue(input.due) ? { due: parseDue(input.due)! } : {}),
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
      whenToUse: ['The owner said yes to a proposed gap on the gap tree'],
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
      if (!deps.gaps) return { ok: false, summary: 'The gap tree is not configured.', error: 'no gap store' };
      const wake = deps.getWakeContext?.();
      if (!ownerSpoke(wake?.trigger, wake?.arrivals)) {
        return { ok: false, summary: 'Refused: only the owner can approve a proposed Gap.', error: 'owner_direct required' };
      }
      const g = await deps.gaps.approve(String(input.gapId).trim(), ctx.now);
      if (!g) return { ok: false, summary: `Gap ${input.gapId} not found. Nothing changed. Use a gap id from the gap tree on the Desk.`, error: 'not found' };
      return { ok: true, summary: `Gap ${g.id} is now open: ${g.title}`, changes: [`gap_opened:${g.id}`], data: g };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'gaps.update',
      version: 1,
      description: "Updates a gap's reality or target, reopens a closed gap (status=open), marks it waiting on someone (status=waiting + waitingOn; it still needs a scheduled next move), or drops it when the owner says it's not wanted (status=dropped). Cannot close a gap; only a passing brain.verify can. A proposed gap opens only through gaps.approve.",
      whenToUse: ['New reality on a gap', "The owner's words show a closed gap is not done: reopen it with status=open", 'A gap is blocked on someone: status=waiting + waitingOn, then schedule the chase', 'The owner declined a gap or said it no longer matters: status=dropped'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          gapId: { type: 'string' },
          reality: { type: 'string' },
          target: { type: 'string' },
          status: { type: 'string', enum: ['open', 'waiting', 'dropped'] },
          waitingOn: { type: 'string', description: 'What this Gap is waiting on (empty string clears it)' },
          due: { type: 'string', description: "ISO time the owner wants it true by, from the owner's words (empty string clears it)" },
        },
        required: ['gapId'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'The gap tree is not configured.', error: 'no gap store' };
      const current = await deps.gaps.get(String(input.gapId).trim());
      if (current?.status === 'proposed' && (input.status === 'open' || input.status === 'waiting')) {
        return { ok: false, summary: `Refused: ${current.id} is proposed; it opens only when the owner says yes (gaps.approve).`, error: 'needs owner approval' };
      }
      if (input.status === 'dropped') {
        const wake = deps.getWakeContext?.();
        if (!ownerSpoke(wake?.trigger, wake?.arrivals)) {
          return { ok: false, summary: 'Refused: only the owner can drop a gap. If it no longer seems needed, ask the owner.', error: 'owner_direct required' };
        }
      }
      const g = await deps.gaps.update(
        String(input.gapId).trim(),
        {
          ...(typeof input.reality === 'string' ? { reality: input.reality } : {}),
          ...(typeof input.target === 'string' ? { target: input.target } : {}),
          ...(input.status === 'open' || input.status === 'waiting' || input.status === 'dropped' ? { status: input.status } : {}),
          ...(typeof input.waitingOn === 'string' ? { waitingOn: input.waitingOn.trim() || null } : {}),
          ...(typeof input.due === 'string' ? { due: input.due.trim() ? input.due : null } : {}),
        },
        ctx.now,
      );
      if (!g) return { ok: false, summary: `Gap ${input.gapId} not found. Nothing changed. Use a gap id from the gap tree on the Desk.`, error: 'not found' };
      const retired = g.status === 'dropped' ? await retireWatchesFor(g.id) : 0;
      return { ok: true, summary: `Updated Gap ${g.id} [${g.status}]${retired ? `; retired ${retired} watch(es) that served it` : ''}.`, changes: [`gap_updated:${g.id}`], data: g };
    },
    { alwaysVisible: true },
  );

  // --- Productivity Watch / Alarm Tool ---

  await registry.registerInline(
    {
      id: 'watch.set',
      version: 1,
      description: "Schedules a gap's next move: a timer (minutesFromNow or fireAt ISO), or a wake when a running T3 Code thread finishes, needs input or is blocked (t3.thread start/send sets this one by itself). Tied to the gap the move serves; code wakes Rufus when it is due.",
      whenToUse: ['A gap needs its next move scheduled: a follow-up, a chase to the owner, a re-check, the next look for gaps, or waiting on a running T3 thread'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['timer', 't3_thread'] },
          label: { type: 'string', description: 'What to check when this watch fires' },
          gapId: { type: 'string', description: "Gap this is the next move for (filled in from the move's gap)" },
          minutesFromNow: { type: 'number', description: 'For kind=timer: minutes from now (default 15 when neither this nor fireAt is given)' },
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
      const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : '';
      if (kind === 't3_thread' && !threadId) return { ok: false, summary: 'Refused: a t3_thread watch needs the threadId of a running thread.', error: 'missing threadId' };
      let fireAt: string | undefined;
      if (kind === 'timer') {
        // A next move that can never fire is not a next move: the time must be real.
        if (typeof input.fireAt === 'string' && input.fireAt.trim()) {
          const at = Date.parse(input.fireAt.trim());
          if (Number.isNaN(at)) return { ok: false, summary: `Refused: fireAt "${input.fireAt}" is not an ISO time. Use minutesFromNow or an ISO timestamp.`, error: 'bad fireAt' };
          fireAt = new Date(at).toISOString();
        } else {
          const mins = input.minutesFromNow === undefined ? 15 : Number(input.minutesFromNow);
          if (!Number.isFinite(mins) || mins <= 0) return { ok: false, summary: `Refused: minutesFromNow must be a positive number.`, error: 'bad minutesFromNow' };
          fireAt = new Date(ctx.now.getTime() + mins * 60_000).toISOString();
        }
      }
      const w = await deps.watches.add(
        {
          kind,
          label: String(input.label).trim(),
          ...(typeof input.gapId === 'string' && input.gapId.trim() ? { gapId: input.gapId.trim() } : {}),
          ...(fireAt ? { fireAt } : {}),
          ...(threadId ? { threadId } : {}),
        },
        ctx.now,
      );
      const mins = w.fireAt ? Math.max(1, Math.round((Date.parse(w.fireAt) - ctx.now.getTime()) / 60_000)) : 0;
      const when = w.fireAt ? ` (fires ${w.fireAt}, in ${mins < 90 ? `${mins} min` : `${(mins / 60).toFixed(1)} h`})` : w.threadId ? ` (wakes you when thread ${w.threadId} finishes, needs input or is blocked)` : '';
      return { ok: true, summary: `Set ${kind} watch ${w.id}${when}: ${w.label}`, changes: [`watch_set:${w.id}`], data: w };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'approvals.approve',
      version: 2,
      description: "Runs a draft waiting for approval (Pending approvals on the Desk) after the owner says yes. Code checks it: it only works in a wake where the owner himself spoke (his direct message or voice).",
      whenToUse: ['There is a pending approval on the Desk and the owner directly said yes to it'],
      effect: 'write',
      requiresApproval: false,
      timeoutMs: 120_000,
      inputSchema: {
        type: 'object',
        properties: {
          approvalId: { type: 'string', description: 'Optional pending approval id (defaults to the most recent pending approval)' },
          alwaysAllow: { type: 'boolean', description: 'Legacy alias: promotes tool to act_and_report' },
          promoteTo: { type: 'string', enum: ['act_and_report', 'act_quietly'], description: 'Set ONLY if the owner explicitly asked to raise trust for this tool' },
        },
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.approvals) return { ok: false, summary: 'Approval store not configured.', error: 'no approval store' };
      const wake = deps.getWakeContext?.();
      if (!ownerSpoke(wake?.trigger, wake?.arrivals)) {
        return {
          ok: false,
          summary: 'Refused: only the owner can approve, in his own direct message or voice (never an external message or email). Nothing ran. Ask the owner, and schedule a chase for this gap.',
          error: 'owner_direct required',
        };
      }
      const id = typeof input.approvalId === 'string' && input.approvalId.trim() ? input.approvalId.trim() : undefined;
      const queued = await deps.approvals.listPending();
      const peek = id ? queued.find((a) => a.id === id) : queued[queued.length - 1];
      if (peek && registry.get(peek.toolId)?.manifest.effect === 'write') {
        // A change to the trust files, tool manifests or gate code needs an owner message that came after the draft:
        // a message that predates the draft cannot have approved it.
        const hits = protectedTargets(peek.input, { workspaceDir: ctx.workspaceDir });
        const createdAt = Date.parse(peek.createdAt);
        const ownerSaidSince = [wake?.trigger, ...(wake?.arrivals ?? [])].some((e) => e?.kind === 'owner_direct' && Date.parse(e.timestamp) > createdAt);
        if (hits.length && !ownerSaidSince) {
          return {
            ok: false,
            summary: `Refused: ${peek.id} would change ${hits.join(', ')}. Show the owner this exact change and wait for his yes to it; a message from before the draft does not approve it.`,
            error: 'protected change needs a fresh owner yes',
          };
        }
      }
      const pending = await deps.approvals.take(id);
      if (!pending) return { ok: false, summary: NO_PENDING_APPROVAL, error: 'no pending approval' };
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
        ownerApproved: true,
        ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}),
        ...(pending.gapId ? { gapId: pending.gapId } : {}),
      });
      await deps.onApprovalDecision?.('approved', pending.toolId, pending.id);
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
      description: 'Cancels a draft waiting for approval when the owner says no / skip / cancel (and drops trust if needed).',
      whenToUse: ['There is a pending approval on the Desk and the owner declined or cancelled it'],
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
      if (!pending) return { ok: false, summary: NO_PENDING_APPROVAL, error: 'no pending approval' };
      // Only the owner's "no" is a denial that costs trust and teaches the bouncer; Rufus withdrawing his own draft is neither.
      const wake = deps.getWakeContext?.();
      if (!ownerSpoke(wake?.trigger, wake?.arrivals)) {
        return { ok: true, summary: `Withdrew pending approval ${pending.id} (${pending.toolId}). Trust unchanged.` };
      }
      await deps.approvals.demote(pending.toolId);
      await deps.onApprovalDecision?.('denied', pending.toolId, pending.id);
      return { ok: true, summary: `Cancelled pending approval ${pending.id} (${pending.toolId}).` };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'sleep',
      version: 1,
      description: 'Ends this wake. Only accepted when every unclosed gap, root included, has a next move in motion (a watch tied to it, or a running thread).',
      whenToUse: ['Every unclosed gap, root included, already has its next move in motion'],
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
      exampleInput: { reason: "Answered the owner's question; every gap has a next move." },
    },
    async (input) => {
      const reason = String(input.reason ?? 'done').trim();
      if (deps.gaps && deps.watches) {
        const active = await deps.watches.active();
        const stranded = (await deps.gaps.unclosed()).filter((g) => !active.some((w) => servesGap(w, g.id)));
        if (stranded.length) {
          return {
            ok: false,
            summary: `Not yet: ${stranded.length} gap(s) have no next move in motion: ${stranded.map((g) => `${g.id} "${g.title}"`).join(', ')}. For each one, make a move now, or schedule its next move (watch.set serving that gap). If the owner is the blocker, schedule a chase, a different way than last time.`,
            error: 'gaps_without_next_move',
            nextHints: ['watch.set'],
          };
        }
      }
      deps.onSleep(reason);
      return { ok: true, summary: `Sleeping: ${reason}` };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'system.startup_snapshot',
      version: 1,
      description: 'Collects exact $0 startup state (when Rufus started, and the latest code update he restarted on) for a startup message.',
      whenToUse: ['Rufus just booted or restarted and needs to orient the owner'],
      effect: 'read',
      requiresApproval: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async (_input, ctx) => {
      const git = (args: string[]) =>
        // The repo this code runs from, whatever directory the daemon was started in.
        execFileAsync('git', args, { cwd: RUFUS_REPO_DIR, timeout: 1500 })
          .then((r) => r.stdout.trim())
          .catch(() => undefined);
      const [subject, committedIso] = (await git(['log', '-1', `--before=${ctx.now.toISOString()}`, '--pretty=%s%x00%cI']))?.split('\0') ?? [];
      const lastChange = subject || undefined;
      const committed = committedIso ? new Date(committedIso) : undefined;
      // The live daemon runs the working tree, so uncommitted edits are part of what just started, and the last commit may be old news.
      const uncommitted = (await git(['status', '--porcelain']))?.split('\n').filter(Boolean).length ?? 0;
      return {
        ok: true,
        summary: `Restarted.${lastChange ? ` Latest commit: ${lastChange}` : ''}${uncommitted ? ` Also running ${uncommitted} uncommitted file change(s).` : ''}`,
        data: {
          startedAt: ctx.now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          ...(lastChange ? { latestUpdate: lastChange } : {}),
          ...(committed && !Number.isNaN(committed.getTime()) ? { latestUpdateAt: committed.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } : {}),
          ...(uncommitted ? { uncommittedFiles: uncommitted } : {}),
        },
        nextHints: ['send_message'],
      };
    },
  );

  // Self-change tools live in the engine (reserved ids), so they can't be repaired around their own safeguards.
  await registerRollbackTool(registry);
  await registerSelfUpgrade(registry);
}
