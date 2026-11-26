import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MessageSink, ModelProvider, Receipt, ToolManifest } from '../types';
import { renderWithSpeaker } from '../speaker/speaker';
import type { ToolRegistry } from './registry';

export interface BuiltinDeps {
  registry: ToolRegistry;
  speakerProvider: ModelProvider;
  speakerModel?: string;
  sink: MessageSink;
  getWakeReceipts: () => readonly Receipt[];
  getRecentSent?: () => Promise<string[]>;
  onSent: (text: string) => void;
  onSleep: (reason: string) => void;
}

/** Registers the minimal core built-in scripts: send_message, tools.list_all, tools.create, tools.repair, sleep, system.startup_snapshot. */
export async function registerBuiltins(deps: BuiltinDeps): Promise<void> {
  const { registry } = deps;

  await registry.registerInline(
    {
      id: 'send_message',
      version: 1,
      description: 'Renders a natural message from exact wake receipts using the fast speaker model and sends it to the user.',
      whenToUse: ['You have a verified answer, update, or approval request to send to the user'],
      effect: 'write',
      requiresApproval: false,
      timeoutMs: 30_000,
      inputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'What factual information or question to communicate.' },
        },
        required: ['intent'],
        additionalProperties: false,
      },
      exampleInput: { intent: 'Share the 3 events on today’s calendar.' },
    },
    async (input, ctx) => {
      const intent = String(input.intent ?? '').trim();
      const recentSent = deps.getRecentSent ? await deps.getRecentSent().catch(() => []) : [];
      const rendered = await renderWithSpeaker({
        workspaceDir: ctx.workspaceDir,
        provider: deps.speakerProvider,
        ...(deps.speakerModel ? { model: deps.speakerModel } : {}),
        intent,
        receipts: deps.getWakeReceipts(),
        ...(recentSent.length ? { recentSent } : {}),
      });
      const sent = await deps.sink.send(rendered.text);
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
      description: 'Edits a previously sent message in place (instead of sending a duplicate correction message).',
      whenToUse: ['You noticed an omission or typo in a message you just sent and have its messageId from the receipt'],
      effect: 'write',
      requiresApproval: false,
      timeoutMs: 30_000,
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The messageId returned by send_message' },
          intent: { type: 'string', description: 'The complete corrected information to render into the edited message' },
        },
        required: ['messageId', 'intent'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.sink.edit) return { ok: false, summary: 'This channel does not support editing messages.', error: 'edit not supported' };
      const messageId = String(input.messageId).trim();
      const rendered = await renderWithSpeaker({
        workspaceDir: ctx.workspaceDir,
        provider: deps.speakerProvider,
        ...(deps.speakerModel ? { model: deps.speakerModel } : {}),
        intent: String(input.intent ?? '').trim(),
        receipts: deps.getWakeReceipts(),
      });
      await deps.sink.edit(messageId, rendered.text);
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
      const tools = registry.list();
      const projDir = path.join(ctx.workspaceDir, 'projects');
      const projects = await fs
        .readdir(projDir)
        .then((xs) => xs.filter((f) => f.endsWith('.md') && !f.startsWith('.')).map((f) => f.replace(/\.md$/, '')).sort())
        .catch(() => [] as string[]);
      return {
        ok: true,
        summary: `Startup snapshot ready: ${tools.length} tools, ${projects.length} projects.`,
        data: {
          startedAt: ctx.now.toISOString(),
          toolCount: tools.length,
          customTools: tools.filter((t) => t.effect !== 'meta' && t.id !== 'send_message').map((t) => t.id),
          projects,
        },
        nextHints: ['send_message'],
      };
    },
  );
}
