import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChiefOfStaff,
  Engine,
  FakeProvider,
  LAYER3_RETRY_PREFIX,
  Layer3PathError,
  MasterLoop,
  ToolRegistry,
  UnifiedDaemon,
  beeperTools,
  checkLayer3Boundary,
  discoverLayer3,
  listLayer3Units,
  loadAudit,
  loadLayer3Module,
  matchLayer3Units,
  normalizeViolations,
  relevantProjectsSection,
  relevantSkillsSection,
  resolveLayer3File,
  runLayer3Prepare,
  runLayer3Verify,
  setTrustMode,
  think,
  thinkTools,
  type AiRequest,
  type IncomingMessage,
  type LiveChannel,
  type LoopSignal,
  type SignalHandler,
  type ToolDefinition,
} from '../src';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 14, 0);
/** Inside the protected window the test boundaries.mjs defines (Saturday). */
const SATURDAY = new Date(2026, 10, 28, 10, 0);

// ---------- workspace helpers ----------

async function put(dir: string, rel: string, text: string): Promise<string> {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

/** Rewrites a file and pushes its mtime forward, as an editor save would. */
async function edit(dir: string, rel: string, text: string, bumpSec = 5): Promise<void> {
  const file = await put(dir, rel, text);
  const t = new Date(Date.now() + bumpSec * 1000);
  await utimes(file, t, t);
}

/** A taste.mjs that rejects em-dashes, code/file jargon and punting read-only work back to the human. */
const TASTE = `
export function verifyDraft(text, ctx) {
  const out = [];
  if (/[\\u2014\\u2013]/.test(text)) out.push('no em-dashes');
  if (/\\b(?:src|test)\\/[\\w./-]+\\.(?:ts|js|mjs)\\b/.test(text)) out.push('leaked code/file jargon');
  if (/want me to (?:look|check|run|search)/i.test(text)) out.push('punted read-only work back to user');
  return out;
}
`;

/** A decision framework: ground truth from the calendar before, tradeoffs required after. */
const FRAMEWORK_MD = `---
name: decide
description: Weigh a decision between options
triggers: should i, decide between
---
1. Name each option. 2. Give the tradeoffs. 3. Make a pick.
`;
const FRAMEWORK_PREPARE = `
export async function prepare(ctx) {
  const cal = await ctx.callReadOnlyTool('calendar.read', {});
  return { context: 'Calendar for ' + ctx.channel + ': ' + JSON.stringify(cal) + ' (query: ' + ctx.query + ')' };
}
`;
const FRAMEWORK_VERIFY = `
export function verify(text, ctx) {
  return /tradeoff|trade-off|downside|upside/i.test(text) ? [] : ['missing decision tradeoffs'];
}
`;
/** Blocks anything proactive or autonomous on Saturdays. */
const BOUNDARIES = `
export function canActNow(ctx) {
  if (ctx.now.getDay() === 6) return { allow: false, reason: 'Saturday is protected (' + ctx.action + ')' };
  return { allow: true };
}
`;

const calendarRead = (calls: string[] = []): ToolDefinition => ({
  name: 'calendar.read',
  description: 'Read the calendar',
  readOnly: true,
  execute: () => {
    calls.push('calendar.read');
    return [{ start: '15:00', title: 'Dentist' }];
  },
});
const webSearch = (calls: unknown[] = []): ToolDefinition => ({
  name: 'web.search',
  description: 'Search the web. args: {"query":"..."}',
  readOnly: true,
  execute: (args) => {
    calls.push(args);
    return [{ title: 'Trail runners compared', snippet: 'Model A: 280g, $140. Model B: 310g, $120.' }];
  },
});
const beeperSend = (sent: unknown[]): ToolDefinition => ({
  name: 'beeper.send',
  description: 'Send a chat message',
  sensitivity: ['external'],
  execute: (args) => void sent.push(args),
});

async function decideWorkspace(): Promise<string> {
  const dir = await tempDir();
  await put(dir, 'taste.mjs', TASTE);
  await put(dir, 'frameworks/decide/FRAMEWORK.md', FRAMEWORK_MD);
  await put(dir, 'frameworks/decide/prepare.mjs', FRAMEWORK_PREPARE);
  await put(dir, 'frameworks/decide/verify.mjs', FRAMEWORK_VERIFY);
  return dir;
}

// ---------- 1. the loader: mtime reloads, workspace-only paths ----------

describe('v25a loadLayer3Module: local .mjs, reloaded on every edit, never outside the workspace', () => {
  it('editing taste.mjs, boundaries.mjs, prepare.mjs and verify.mjs takes effect on the next call without a restart', async () => {
    const dir = await tempDir();
    await put(dir, 'taste.mjs', `export const verifyDraft = () => ['v1'];`);
    await put(dir, 'boundaries.mjs', `export const canActNow = () => ({ allow: true });`);
    await put(dir, 'frameworks/decide/FRAMEWORK.md', FRAMEWORK_MD);
    await put(dir, 'frameworks/decide/prepare.mjs', `export const prepare = () => 'prep v1';`);
    await put(dir, 'frameworks/decide/verify.mjs', `export const verify = () => 'fw v1';`);
    const units = await matchLayer3Units(dir, 'should i take the job?');
    expect(units.map((u) => [u.name, u.kind])).toEqual([['decide', 'framework']]);

    expect((await runLayer3Verify({ dir, skills: units, text: 'hi', now: NOW })).reasons).toEqual(['v1', 'fw v1']);
    expect((await runLayer3Prepare({ dir, skills: units, query: 'q', now: NOW })).context).toContain('prep v1');
    expect(await checkLayer3Boundary({ dir, now: NOW, action: 'proactive.message' })).toEqual({ allow: true });

    await edit(dir, 'taste.mjs', `export const verifyDraft = () => ['v2'];`);
    await edit(dir, 'boundaries.mjs', `export const canActNow = () => ({ allow: false, reason: 'edited' });`);
    await edit(dir, 'frameworks/decide/prepare.mjs', `export const prepare = () => 'prep v2';`);
    await edit(dir, 'frameworks/decide/verify.mjs', `export function verifyDraft() { return 'fw v2'; }`);

    expect((await runLayer3Verify({ dir, skills: units, text: 'hi', now: NOW })).reasons).toEqual(['v2', 'fw v2']);
    expect((await runLayer3Prepare({ dir, skills: units, query: 'q', now: NOW })).context).toContain('prep v2');
    expect(await checkLayer3Boundary({ dir, now: NOW, action: 'proactive.message' })).toEqual({ allow: false, reason: 'edited' });

    const mod = await loadLayer3Module('taste.mjs', dir);
    expect(typeof mod?.verifyDraft).toBe('function');
    expect(await loadLayer3Module('missing.mjs', dir)).toBeUndefined();
  });

  it('refuses .. traversal, absolute paths elsewhere, symlinks that leave the workspace, and non-.mjs files', async () => {
    const outside = await tempDir();
    const evil = await put(outside, 'evil.mjs', `globalThis.__rufusEvil = true; export const verifyDraft = () => ['pwned'];`);
    const dir = await tempDir();
    await expect(resolveLayer3File(dir, '../evil.mjs')).rejects.toBeInstanceOf(Layer3PathError);
    await expect(resolveLayer3File(dir, path.relative(dir, evil))).rejects.toThrow(/outside the workspace/);
    await expect(loadLayer3Module(evil, dir)).rejects.toThrow(/outside the workspace/);
    await expect(resolveLayer3File(dir, 'notes.js')).rejects.toThrow(/only \.mjs/);
    await symlink(evil, path.join(dir, 'taste.mjs'));
    await expect(resolveLayer3File(dir, 'taste.mjs')).rejects.toThrow(/links outside the workspace/);
    // The runner treats a refused taste.mjs as an error, never as code to run.
    const r = await runLayer3Verify({ dir, text: 'hello', now: NOW });
    expect(r).toMatchObject({ ok: true, reasons: [] });
    expect(r.errors.join(' ')).toMatch(/links outside the workspace/);
    expect((globalThis as { __rufusEvil?: boolean }).__rufusEvil).toBeUndefined();
    // Unit names are slugs: a skill folder can never point the runner outside skills/ or frameworks/.
    expect(await runLayer3Prepare({ dir, skills: [{ name: '../../x', description: '', triggers: [], body: '', file: '' }], query: 'q', now: NOW })).toEqual({ context: '', notes: [] });
  });

  it('discovers skills/ and frameworks/ together (same frontmatter and matching) plus workspace hooks', async () => {
    const dir = await decideWorkspace();
    await put(dir, 'boundaries.mjs', BOUNDARIES);
    await put(dir, 'skills/trip-prep/SKILL.md', '---\nname: trip-prep\ndescription: Prepare a travel brief\ntriggers: trip, flight\n---\nCheck the calendar.');
    await put(dir, 'skills/trip-prep/run.mjs', 'export const run = () => 1;');
    expect((await listLayer3Units(dir)).map((u) => `${u.kind ?? 'skill'}:${u.name}`)).toEqual(['skill:trip-prep', 'framework:decide']);
    const inv = await discoverLayer3(dir);
    expect(inv.taste).toMatch(/taste\.mjs$/);
    expect(inv.boundaries).toMatch(/boundaries\.mjs$/);
    expect(inv.units).toEqual([
      { name: 'trip-prep', kind: 'skill', run: expect.stringMatching(/run\.mjs$/) },
      { name: 'decide', kind: 'framework', prepare: expect.stringMatching(/prepare\.mjs$/), verify: expect.stringMatching(/verify\.mjs$/) },
    ]);
    const section = await relevantSkillsSection(dir, 'should i book the flight or drive?');
    expect(section).toContain('### decide (framework)');
    expect(section).toContain('### trip-prep');
  });
});

// ---------- 2. prepare / verify / boundaries, one by one ----------

describe('v25a runLayer3Prepare / runLayer3Verify / checkLayer3Boundary', () => {
  it('prepare.mjs gathers ground truth through read-only tools only; a throwing or hanging hook becomes a note', async () => {
    const dir = await decideWorkspace();
    const sent: unknown[] = [];
    const tools = new ToolRegistry({ tools: [calendarRead(), beeperSend(sent)] });
    const units = await matchLayer3Units(dir, 'should i move the dentist?');
    const ok = await runLayer3Prepare({ dir, skills: units, query: 'should i move the dentist?', channel: 'chat', now: NOW, tools });
    expect(ok.notes).toEqual([]);
    expect(ok.context).toContain('Ground truth gathered by Layer 3 code');
    expect(ok.context).toContain('Calendar for chat: [{"start":"15:00","title":"Dentist"}]');

    await edit(dir, 'frameworks/decide/prepare.mjs', `export const prepare = (ctx) => ctx.callReadOnlyTool('beeper.send', { text: 'hi' });`);
    const write = await runLayer3Prepare({ dir, skills: units, query: 'q', now: NOW, tools });
    expect(write.context).toBe('');
    expect(write.notes[0]).toMatch(/frameworks\/decide\/prepare\.mjs failed: beeper\.send is not read-only/);
    expect(sent).toEqual([]);

    await edit(dir, 'frameworks/decide/prepare.mjs', `export const prepare = () => { throw new Error('boom'); };`, 10);
    expect((await runLayer3Prepare({ dir, skills: units, query: 'q', now: NOW })).notes[0]).toMatch(/failed: boom/);

    await edit(dir, 'frameworks/decide/prepare.mjs', `export const prepare = () => new Promise(() => {});`, 15);
    expect((await runLayer3Prepare({ dir, skills: units, query: 'q', now: NOW, timeoutMs: 30 })).notes[0]).toMatch(/timed out after 30ms/);

    await edit(dir, 'frameworks/decide/prepare.mjs', `export const prepare = ( => broken syntax`, 20);
    expect((await runLayer3Prepare({ dir, skills: units, query: 'q', now: NOW })).notes[0]).toMatch(/prepare\.mjs failed/);
  });

  it('taste.mjs + verify.mjs violations are aggregated; a throwing verifier is reported but never blocks (fail open)', async () => {
    const dir = await decideWorkspace();
    const units = await matchLayer3Units(dir, 'should i take it?');
    const bad = await runLayer3Verify({ dir, skills: units, text: 'Take it — the fix is in src/engine/trust.ts. Want me to look it up?', toolCalls: [], channel: 'chat', now: NOW });
    expect(bad).toEqual({ ok: false, reasons: ['no em-dashes', 'leaked code/file jargon', 'punted read-only work back to user', 'missing decision tradeoffs'], errors: [] });
    expect((await runLayer3Verify({ dir, skills: units, text: 'Take it. The upside is pay, the downside is the commute.', now: NOW })).ok).toBe(true);
    // Matching from the query when no units are given.
    expect((await runLayer3Verify({ dir, text: 'Just take it.', query: 'should i take it?', now: NOW })).reasons).toEqual(['missing decision tradeoffs']);

    await edit(dir, 'taste.mjs', `export function verifyDraft() { throw new Error('taste bug'); }`);
    const broken = await runLayer3Verify({ dir, text: 'fine', now: NOW });
    expect(broken).toEqual({ ok: true, reasons: [], errors: ['taste.mjs failed: taste bug'] });
    expect(await runLayer3Verify({ dir: await tempDir(), text: 'no hooks at all', now: NOW })).toEqual({ ok: true, reasons: [], errors: [] });
    expect(normalizeViolations({ ok: false })).toEqual(['failed verification']);
    expect(normalizeViolations({ violations: ['a', '', 3] })).toEqual(['a']);
  });

  it('boundaries.mjs hard-blocks proactive and autonomous actions in a protected window; a broken one fails closed', async () => {
    const dir = await tempDir();
    expect(await checkLayer3Boundary({ dir, now: SATURDAY, action: 'proactive.message' })).toBeUndefined();
    await put(dir, 'boundaries.mjs', BOUNDARIES);
    expect(await checkLayer3Boundary({ dir, now: NOW, action: 'proactive.message' })).toEqual({ allow: true });
    expect(await checkLayer3Boundary({ dir, now: SATURDAY, action: 'proactive.message' })).toEqual({ allow: false, reason: 'Saturday is protected (proactive.message)' });
    await edit(dir, 'boundaries.mjs', `export function canActNow() { throw new Error('oops'); }`);
    expect(await checkLayer3Boundary({ dir, now: NOW, action: 'chat.react' })).toEqual({ allow: false, reason: 'boundaries.mjs failed: oops' });
  });

  it('the Master Loop: an auto_notify action waits for a yes when boundaries.mjs says not now, and nothing is sent', async () => {
    const dir = await tempDir();
    await put(dir, 'boundaries.mjs', BOUNDARIES);
    const posts: unknown[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') posts.push(String(input));
      return Response.json({ ok: true, items: [] });
    }) as typeof fetch;
    const signal: LoopSignal = { id: '1', surface: 'chat', kind: 'react.request', text: 'haha', actor: 'Robin', data: { chatId: 'c-1', messageId: 'm1' } };
    const handler: SignalHandler = {
      id: 'react',
      match: { kind: 'react.request' },
      plan: () => ({ goal: 'React to the message', actionType: 'chat.react', route: 'code', uses: ['beeper.react'] }),
      execute: (_p, s) => ({ chatId: s.data!.chatId, messageId: s.data!.messageId, emoji: '😂' }),
      async commit(out, _p, _s, c) {
        await c.tools.call('beeper.react', out as Record<string, unknown>);
      },
    };
    await setTrustMode(dir, 'chat.react', 'auto_notify');
    const loop = new MasterLoop({ dir, sensors: [{ id: 't', surface: 'chat', poll: (cursor) => (cursor ? { signals: [] } : { signals: [signal], nextCursor: 'x' }) }], handlers: [handler], tools: new ToolRegistry({ tools: beeperTools({ fetch: fetchImpl }) }), now: () => SATURDAY });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run.status).toBe('awaiting_human_verify');
    expect(run.approvals).toContain('boundaries.mjs: Saturday is protected (chat.react)');
    expect(run.autoNotified).toBeUndefined();
    expect(posts).toEqual([]);
    expect(await loadAudit(dir)).toEqual([]);
  });
});

// ---------- 3. the Chief of Staff: prepare before, verify after, one clean rewrite ----------

describe('v25a ChiefOfStaff runs Code-in-Layer-3 around every chat turn', () => {
  it('prepare.mjs runs before the AI; taste.mjs + verify.mjs reject the draft; one retry returns the clean rewrite', async () => {
    const dir = await decideWorkspace();
    const calendarCalls: string[] = [];
    const DRAFT = "Honestly I'd keep it — the logic lives in src/engine/trust.ts anyway. Want me to look it up?";
    const CLEAN = "I'd keep the dentist at 3pm. Upside: it's done today. Downside: you lose the afternoon focus block.";
    const provider = new FakeProvider((_req, n) => (n === 0 ? DRAFT : CLEAN));
    const engine = new Engine({ store: dir, provider, flows: [] });
    const chief = new ChiefOfStaff({ engine, dir, tools: new ToolRegistry({ tools: [calendarRead(calendarCalls)] }), historyTurns: 0, now: () => NOW });
    const reply = await chief.handle('should i move the dentist appointment?');

    expect(calendarCalls).toEqual(['calendar.read']); // prepare.mjs ran through the read-only tool
    const first = String(provider.calls[0]!.messages[0]!.content);
    expect(first).toContain('Ground truth gathered by Layer 3 code');
    expect(first).toContain('Calendar for chat: [{"start":"15:00","title":"Dentist"}]');
    expect(first.indexOf('Ground truth')).toBeLessThan(first.indexOf('Their message:'));
    expect(provider.calls[0]!.system).toContain('### decide (framework)');

    expect(provider.calls).toHaveLength(2);
    const retry = provider.calls[1]!.messages;
    expect(retry.at(-2)).toEqual({ role: 'assistant', content: DRAFT });
    expect(String(retry.at(-1)!.content)).toBe(
      `${LAYER3_RETRY_PREFIX} no em-dashes; leaked code/file jargon; punted read-only work back to user; missing decision tradeoffs. Rewrite cleanly fixing every issue.`,
    );
    expect(reply.text).toBe(CLEAN);
    expect(reply.layer3).toEqual({ prepared: ['decide'], violations: ['no em-dashes', 'leaked code/file jargon', 'punted read-only work back to user', 'missing decision tradeoffs'], retried: true });
    expect(reply.verifier).toBeUndefined();
  });

  it('spoken turns verify on the voice channel; only one retry, and what still fails is reported', async () => {
    const dir = await tempDir();
    await put(dir, 'taste.mjs', `export const verifyDraft = (text, ctx) => (ctx.channel === 'voice' && /—/.test(text) ? ['no em-dashes on a call'] : []);`);
    const provider = new FakeProvider(() => 'Sure — 3pm works.');
    const chief = new ChiefOfStaff({ engine: new Engine({ store: dir, provider, flows: [] }), dir, historyTurns: 0, now: () => NOW });
    const typed = await chief.handle('does 3 work?');
    expect(typed.layer3).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
    const spoken = await chief.reply('does 3 work?', { spoken: true });
    expect(provider.calls).toHaveLength(3); // one draft + one rewrite, never more
    expect(spoken.layer3).toEqual({ violations: ['no em-dashes on a call'], retried: true, remaining: ['no em-dashes on a call'] });
  });

  it('a throwing taste.mjs or prepare.mjs never breaks the turn; reactions and NO_REPLY are not verified', async () => {
    const dir = await decideWorkspace();
    await edit(dir, 'taste.mjs', `export function verifyDraft() { throw new Error('taste bug'); }`);
    await edit(dir, 'frameworks/decide/prepare.mjs', `export function prepare() { throw new Error('prep bug'); }`);
    await edit(dir, 'frameworks/decide/verify.mjs', `export const verify = () => ['always wrong'];`);
    const provider = new FakeProvider((_req, n) => (n === 0 ? 'Go for it, the upside is clear.' : n === 1 ? 'Go for it. Upside: more time.' : 'REACT: 👍'));
    const chief = new ChiefOfStaff({ engine: new Engine({ store: dir, provider, flows: [] }), dir, historyTurns: 0, now: () => NOW });
    const r = await chief.handle('should i go?');
    expect(r.unavailable).toBeUndefined();
    expect(r.text).toBe('Go for it. Upside: more time.');
    expect(r.layer3?.notes).toEqual(expect.arrayContaining(['frameworks/decide/prepare.mjs failed: prep bug', 'taste.mjs failed: taste bug']));
    expect(r.layer3?.remaining).toEqual(['always wrong']);
    const react = await chief.handle('should i go? thanks');
    expect(react.react).toBe('👍');
    expect(provider.calls).toHaveLength(3);
  });

  it('active projects/*.md that fit the message are injected (bounded); nothing when projects/ is missing or the project is done', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(() => 'ok');
    const chief = new ChiefOfStaff({ engine: new Engine({ store: dir, provider, flows: [] }), dir, historyTurns: 0, now: () => NOW });
    expect(await chief.memoryAndSkills('how is the garden shed going?')).toBe('');
    await put(dir, 'projects/garden-shed.md', `---\nstatus: active\ntriggers: shed\n---\n# Garden shed\nNext: order the cedar boards. ${'x'.repeat(5000)}`);
    await put(dir, 'projects/old-site.md', `---\nstatus: done\ntriggers: shed, website\n---\nShipped.`);
    const section = await chief.memoryAndSkills('how is the garden shed going?');
    expect(section).toContain('## Active projects that fit this (projects/*.md)');
    expect(section).toContain('Next: order the cedar boards.');
    expect(section).not.toContain('Shipped.');
    expect(section.length).toBeLessThan(2200);
    expect(await relevantProjectsSection(dir, 'what is for dinner?')).toBe('');
  });
});

// ---------- 4. the action-first think-beat ----------

describe('v25a action-first think-beat', () => {
  it('calls web.search (read-only) during the beat and sends the finished answer, not an offer to look', async () => {
    const dir = await tempDir();
    const searches: unknown[] = [];
    const sent: unknown[] = [];
    const tools = new ToolRegistry({ tools: [webSearch(searches), beeperSend(sent)] });
    expect(thinkTools(tools)).toEqual(['web.search']);
    const provider = new FakeProvider((_req, n) =>
      n === 0 ? 'TOOL_CALL: {"tool":"web.search","args":{"query":"trail runner A vs B"}}' : "Found it: Model A is lighter (280g) but $20 more than B. I'd get A for the long runs.",
    );
    const loop = new MasterLoop({ dir, tools, now: () => NOW });
    const r = await think({ provider, dir, loop, now: NOW, tools, glance: [] });
    expect(searches).toEqual([{ query: 'trail runner A vs B' }]);
    expect(r.toolsUsed).toEqual(['web.search']);
    expect(r.bubbles).toEqual(["Found it: Model A is lighter (280g) but $20 more than B. I'd get A for the long runs."]);
    const prompt = String(provider.calls[0]!.messages[0]!.content);
    expect(prompt).toContain('ACTION FIRST');
    expect(prompt).toContain('- web.search:');
    expect(prompt).not.toContain('- beeper.send');
    expect(String(provider.calls[1]!.messages.at(-1)!.content)).toContain('TOOL_RESULT web.search');
    expect(sent).toEqual([]);
  });

  it('a write tool (beeper.send) during a beat is hard-blocked: nothing is sent, the beat stays honest', async () => {
    const dir = await tempDir();
    const sent: unknown[] = [];
    const tools = new ToolRegistry({ tools: [webSearch(), beeperSend(sent)], trusted: ['beeper.send'] });
    const provider = new FakeProvider((_req, n) => (n === 0 ? 'TOOL_CALL: {"tool":"beeper.send","args":{"chatId":"c-1","text":"hi"}}' : 'SILENT'));
    const r = await think({ provider, dir, loop: new MasterLoop({ dir, tools, now: () => NOW }), now: NOW, tools, glance: [] });
    expect(sent).toEqual([]);
    expect(r.blocked).toEqual(['beeper.send']);
    expect(r.bubbles).toBeUndefined();
    expect(String(provider.calls[1]!.messages.at(-1)!.content)).toMatch(/BLOCKED: beeper\.send is not read-only/);
  });

  it('at most 3 read-only lookups per beat, then silence rather than a half answer', async () => {
    const dir = await tempDir();
    const searches: unknown[] = [];
    const tools = new ToolRegistry({ tools: [webSearch(searches)] });
    const provider = new FakeProvider(() => 'TOOL_CALL: {"tool":"web.search","args":{"query":"again"}}');
    const r = await think({ provider, dir, loop: new MasterLoop({ dir, tools, now: () => NOW }), now: NOW, tools, glance: [] });
    expect(searches).toHaveLength(3);
    expect(r.bubbles).toBeUndefined();
    expect(provider.calls).toHaveLength(4);
  });

  it('taste.mjs checks the proactive message: one rewrite, and silence if it still breaks the rules', async () => {
    const dir = await tempDir();
    await put(dir, 'taste.mjs', TASTE);
    const fixed = new FakeProvider((_req, n) => (n === 0 ? 'Still owe you that lookup — want me to run it?' : 'Model A is the better pick for long runs.'));
    const loop = new MasterLoop({ dir, now: () => NOW });
    const ok = await think({ provider: fixed, dir, loop, now: NOW, glance: [] });
    expect(ok.bubbles).toEqual(['Model A is the better pick for long runs.']);
    expect(ok.layer3).toEqual({ violations: ['no em-dashes', 'punted read-only work back to user'], retried: true });
    expect(String(fixed.calls[1]!.messages.at(-1)!.content)).toContain(LAYER3_RETRY_PREFIX);

    const stubborn = new FakeProvider(() => 'Want me to look it up?');
    const quiet = await think({ provider: stubborn, dir, loop, now: NOW, glance: [] });
    expect(quiet.bubbles).toBeUndefined();
    expect(quiet.layer3?.remaining).toEqual(['punted read-only work back to user']);
  });

  it('the daemon: boundaries.mjs blocks the beat in a protected window before any model call', async () => {
    const dir = await tempDir();
    await put(dir, 'boundaries.mjs', BOUNDARIES);
    let t = new Date(2026, 10, 28, 9, 0); // Saturday
    const thinkCalls: AiRequest[] = [];
    const engine = new Engine({
      store: dir,
      provider: new FakeProvider((req) => {
        if (req.meta?.flowId === 'think') thinkCalls.push(req);
        return 'Hey, quick thought!';
      }),
    });
    const sent: string[] = [];
    const channel: LiveChannel = {
      async send(text: string) {
        sent.push(text);
      },
      async poll(): Promise<IncomingMessage[]> {
        return [];
      },
    } as LiveChannel;
    const loop = new MasterLoop({ dir, now: () => t });
    const daemon = new UnifiedDaemon({ loop, engine, channel, chief: false, heartbeat: false, calendarSync: false, bubblePauseMs: 0, think: { everyMs: 45 * 60_000, quietHours: false }, now: () => t });
    await daemon.tick();
    t = new Date(t.getTime() + 50 * 60_000);
    const r = await daemon.tick();
    expect(r.thought).toBe('skipped: boundaries.mjs: Saturday is protected (proactive.message)');
    expect(thinkCalls).toHaveLength(0);
    expect(sent).toEqual([]);
  });
});
