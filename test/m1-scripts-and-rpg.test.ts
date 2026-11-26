import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EventStore,
  FakeProvider,
  ToolRegistry,
  registerBuiltins,
  readToolStats,
  runRpgWake,
  verifySpokenReply,
  messageEvent,
  type Receipt,
} from '../src';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'rufus-v2-m1-'));
const NOW = new Date('2026-11-26T14:00:00Z');

describe('Milestone 1: Packaged Script Standard & Text-Based RPG Loop', () => {
  it('enforces inputSchema, requiresApproval, read-only composition, and stats.json brokenWarning', async () => {
    const dir = await tempDir();
    const reg = new ToolRegistry({ toolsDir: path.join(dir, 'tools') });

    await reg.registerInline(
      {
        id: 'notes.read',
        version: 1,
        description: 'Reads a note by name.',
        whenToUse: ['User asks to read a note'],
        effect: 'read',
        requiresApproval: false,
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      },
      async (input) => ({ ok: true, summary: `Read ${input.name}`, changes: ['should-be-stripped'], data: { text: 'hello' } }),
    );

    await reg.registerInline(
      {
        id: 'notes.delete',
        version: 1,
        description: 'Deletes a note.',
        whenToUse: ['User explicitly wants to delete a note'],
        effect: 'write',
        requiresApproval: true,
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      },
      async (input) => ({ ok: true, summary: `Deleted ${input.name}`, changes: [`deleted:${input.name}`] }),
    );

    // Invalid input rejected before running
    const bad = await reg.call('notes.read', {}, { workspaceDir: dir, now: NOW });
    expect(bad.status).toBe('invalid_input');

    // Read-only tool can NEVER emit changes
    const readRes = await reg.call('notes.read', { name: 'a' }, { workspaceDir: dir, now: NOW });
    expect(readRes.status).toBe('ok');
    expect(readRes.changes).toEqual([]);

    // requiresApproval blocks execution until approved
    const pending = await reg.call('notes.delete', { name: 'a' }, { workspaceDir: dir, now: NOW });
    expect(pending.status).toBe('pending_approval');
    expect(pending.changes).toEqual([]);

    // Pioneer tools.create rejects failing test.mjs and activates passing test.mjs
    const badCreate = await reg.createOrRepair({
      manifest: {
        id: 'demo.flaky',
        version: 1,
        description: 'Demo flaky script',
        whenToUse: ['testing failures'],
        effect: 'read',
        requiresApproval: false,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      runCode: `export async function run() { return { ok: true, summary: 'hi' }; }\n`,
      testCode: `process.exit(1);\n`,
    });
    expect(badCreate.ok).toBe(false);
    expect(reg.get('demo.flaky')).toBeUndefined();

    const okCreate = await reg.createOrRepair({
      manifest: {
        id: 'demo.failer',
        version: 1,
        description: 'Fails on demand to test stats.json telemetry',
        whenToUse: ['testing consecutive failures'],
        effect: 'read',
        requiresApproval: false,
        inputSchema: { type: 'object', properties: { fail: { type: 'boolean' } }, additionalProperties: false },
      },
      runCode: `export async function run(input) { if (input.fail) return { ok: false, summary: 'boom', error: 'API 500' }; return { ok: true, summary: 'ok' }; }\n`,
      testCode: `import { run } from './run.mjs'; const r = await run({}); if (!r.ok) process.exit(1);\n`,
    });
    expect(okCreate.ok).toBe(true);

    // Two consecutive failures trigger brokenWarning in Receipt and stats.json
    const f1 = await reg.call('demo.failer', { fail: true }, { workspaceDir: dir, now: NOW });
    expect(f1.brokenWarning).toBeUndefined();
    const f2 = await reg.call('demo.failer', { fail: true }, { workspaceDir: dir, now: NOW });
    expect(f2.brokenWarning).toContain('tools.repair');
    const stats = await readToolStats(path.join(dir, 'tools', 'demo.failer'));
    expect(stats.consecutiveFailures).toBe(2);
    expect(stats.failures).toBe(2);
  });

  it('RPG loop ping-pongs fresh context -> tool -> immutable Receipt -> Haiku speaker ($0 truth gate) -> sleep', async () => {
    const dir = await tempDir();
    const reg = new ToolRegistry({ toolsDir: path.join(dir, 'tools') });
    const events = new EventStore({ workspaceDir: dir });
    const sent: string[] = [];
    const receipts: Receipt[] = [];

    // Speaker tries to lie on attempt 1 ("I deleted the 3 files"), truth gate catches it, attempt 2 is honest with clean numbered list
    const speaker = new FakeProvider((_req, idx) =>
      idx === 0
        ? 'Done! I deleted the 3 files. Remaining: 1. Alpha 2. Beta'
        : 'Those 3 files are still on disk and waiting on your approval.\n\nCurrent list:\n1. Alpha\n2. Beta\n3. Gamma',
    );

    await registerBuiltins({
      registry: reg,
      speakerProvider: speaker,
      sink: { send: async (t) => void sent.push(t) },
      getWakeReceipts: () => receipts,
      onSent: () => undefined,
      onSleep: () => undefined,
    });

    await reg.registerInline(
      {
        id: 'files.archive',
        version: 1,
        description: 'Archives files on disk.',
        whenToUse: ['User wants to archive or remove files'],
        effect: 'write',
        requiresApproval: true,
        inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] },
      },
      async () => ({ ok: true, summary: 'archived', changes: ['archived'] }),
    );

    const reasoning = new FakeProvider((_req, idx) => {
      if (idx === 0) return JSON.stringify({ thought: 'Archive the files', toolId: 'files.archive', input: { names: ['a', 'b', 'c'] } });
      if (idx === 1) return JSON.stringify({ thought: 'Tell user it needs approval', toolId: 'send_message', input: { intent: 'Tell user archiving requires approval.' } });
      return JSON.stringify({ thought: 'Done', toolId: 'sleep', input: { reason: 'Waiting on approval' } });
    });

    const trigger = messageEvent({ channel: 'cli', actor: 'owner', text: 'Archive those 3 files', timestamp: NOW.toISOString() });
    trigger.kind = 'owner_direct';

    const report = await runRpgWake({
      workspaceDir: dir,
      trigger,
      reasoningProvider: reasoning,
      registry: reg,
      events,
      now: () => NOW,
      onReceipt: (r) => receipts.push(r),
    });

    expect(report.turns).toBe(3);
    expect(report.slept).toBe(true);
    expect(report.pendingApprovals).toHaveLength(1);
    expect(speaker.calls).toHaveLength(2); // Attempt 1 rejected by $0 truth gate + inline list check!
    expect(sent[0]).toContain('1. Alpha\n2. Beta\n3. Gamma');
    expect(verifySpokenReply(sent[0]!, receipts)).toEqual([]);
  });
});
