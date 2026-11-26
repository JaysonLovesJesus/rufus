import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MessageSink, ModelProvider, Receipt, ToolManifest } from '../types';
import { renderWithSpeaker, type SpeakerWakeContext } from '../speaker/speaker';
import type { ApprovalStore } from './approvals';
import type { ToolRegistry } from './registry';

const execFileAsync = promisify(execFile);

export interface BuiltinDeps {
  registry: ToolRegistry;
  approvals?: ApprovalStore;
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
      const rendered = await renderWithSpeaker({
        workspaceDir: ctx.workspaceDir,
        provider: deps.speakerProvider,
        ...(deps.speakerModel ? { model: deps.speakerModel } : {}),
        purpose,
        receipts: deps.getWakeReceipts(),
        ...(wakeContext ? { wakeContext } : {}),
      });
      const activeSink = deps.getActiveSink ? deps.getActiveSink() : deps.sink;
      const sent = await activeSink.send(rendered.text);
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
      version: 1,
      description: 'Saves or updates a modular behavioral rule/skill in skills/<id>.md (keep VOICE.md strictly for tone/voice).',
      whenToUse: ['User gives a behavioral preference, rule, or habit ("stop doing X", "always do Y") that must persist permanently'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short slug (e.g. "concise-checkins")' },
          triggers: { type: 'string', description: 'Comma-separated trigger keywords for embedding retrieval' },
          title: { type: 'string', description: 'Short skill title' },
          rule: { type: 'string', description: 'Concise behavioral instruction (1-4 lines)' },
        },
        required: ['id', 'triggers', 'title', 'rule'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const id = String(input.id).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const dir = path.join(ctx.workspaceDir, 'skills');
      await fs.mkdir(dir, { recursive: true });
      const content = `---\ntriggers: ${String(input.triggers).trim()}\n---\n# ${String(input.title).trim()}\n${String(input.rule).trim()}\n`;
      await fs.writeFile(path.join(dir, `${id}.md`), content, 'utf8');
      return { ok: true, summary: `Saved skill skills/${id}.md.`, changes: [`skill_saved:${id}`] };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'approvals.approve',
      version: 1,
      description: 'Executes a pending approval-gated action after the user verbally/directly says yes (e.g. "yes", "go ahead", "do it"). Code-verified: only works on direct owner messages/voice.',
      whenToUse: ['There is a pending approval in Live Context and the user directly confirmed or approved it'],
      effect: 'write',
      requiresApproval: false,
      timeoutMs: 120_000,
      inputSchema: {
        type: 'object',
        properties: {
          approvalId: { type: 'string', description: 'Optional pending approval id (defaults to the most recent pending approval)' },
          alwaysAllow: { type: 'boolean', description: 'Set true ONLY if the user asked to always allow this tool in the future' },
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
      if (input.alwaysAllow === true) {
        await deps.approvals.allowAlways(pending.toolId);
      }
      const execReceipt = await registry.call(pending.toolId, pending.input, {
        workspaceDir: ctx.workspaceDir,
        now: ctx.now,
        approved: true,
      });
      await deps.onApprovalDecision?.('approved', pending.toolId);
      return {
        ok: execReceipt.status === 'ok',
        summary: `Approved & ran ${pending.toolId}: ${execReceipt.summary}${input.alwaysAllow ? ' (saved to alwaysAllow)' : ''}`,
        changes: [...execReceipt.changes, ...(input.alwaysAllow ? [`always_allow:${pending.toolId}`] : [])],
        data: execReceipt.data,
        ...(execReceipt.error ? { error: execReceipt.error } : {}),
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'approvals.deny',
      version: 1,
      description: 'Cancels a pending approval-gated action when the user says no / skip / cancel.',
      whenToUse: ['There is a pending approval in Live Context and the user declined or cancelled it'],
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
