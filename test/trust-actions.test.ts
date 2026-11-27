import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeProvider, RufusCore, ToolRegistry, messageEvent, type LosslessEvent, type ModelRequest, type RpgWakeReport, type ToolManifest } from '../src';
import { ApprovalStore } from '../src/scripts/approvals';
import { packagedManifest, startLevelFor } from '../src/scripts/registry';
import { tempDir } from './helpers';

const NOW = new Date('2026-11-27T03:20:00Z');
const isDecide = (req: ModelRequest) => req.system.includes('You are Decide');
const isVerify = (req: ModelRequest) => !isDecide(req) && /verif/i.test(req.system);

function owner(text: string): LosslessEvent {
  const ev = messageEvent({ channel: 'telegram', actor: 'owner', text, timestamp: NOW.toISOString() });
  ev.kind = 'owner_direct';
  return ev;
}

const LOOK: ToolManifest = {
  id: 'demo.look',
  version: 1,
  description: 'Looks at the synthetic page',
  whenToUse: ['testing'],
  effect: 'read',
  requiresApproval: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
};

/** A core whose verify brain looks once (demo.look) and then passes, citing that look. */
async function scratch(decide: (turn: number, req: ModelRequest) => unknown, opts: { maxTurns?: number; verifyPasses?: boolean } = {}) {
  const dir = await tempDir('rufus-trust-actions-');
  let turn = 0;
  const reasoning = new FakeProvider((req) => {
    if (isDecide(req)) {
      const out = decide(turn++, req);
      return typeof out === 'string' ? out : JSON.stringify(out);
    }
    if (isVerify(req)) {
      // Look once, then pass (or fail) citing that look.
      if (req.prompt.includes('Receipts Collected So Far:\n(none yet)')) return JSON.stringify({ toolId: 'demo.look', input: {} });
      const passed = opts.verifyPasses !== false;
      return JSON.stringify({ done: true, passed, evidence: 'The synthetic page is live', criteria: [{ element: 'what', criterion: 'page is live', receiptIndex: 1, observed: 'live', met: passed }] });
    }
    return JSON.stringify({ done: true, facts: [], unknowns: [], summary: 'none' });
  });
  const core = new RufusCore({ workspaceDir: dir, reasoningProvider: reasoning, speakerProvider: new FakeProvider(() => 'Noted.'), sink: { send: async () => undefined }, now: () => NOW, maxTurnsPerWake: opts.maxTurns ?? 4 });
  await core.init();
  await core.registry.registerInline(LOOK, async () => ({ ok: true, summary: 'The synthetic page is live.' }));
  const gap = await core.gaps.create({ title: 'Synthetic page is live', target: 'The synthetic page is live', reality: 'Not checked', source: 'owner', now: new Date(NOW.getTime() - 60_000) });
  return { dir, core, gapId: gap.id, cleanup: () => core.close() };
}

const SLEEP = { toolId: 'sleep', input: { reason: 'done' } };
const firstReceipt = (res: { wake?: RpgWakeReport }) => res.wake!.trace[0]!.receipt;

describe('closing a gap goes through the trust ladder', () => {
  it('by default (act_and_report) a passing check closes the gap and the receipt carries the report hint', async () => {
    let gapId = '';
    const s = await scratch((t) => (t === 0 ? { gap: gapId, toolId: 'brain.verify', input: {} } : SLEEP));
    gapId = s.gapId;
    try {
      const res = await s.core.processEvent(owner('Is the page live?'));
      const r = firstReceipt(res);
      expect((await s.core.gaps.get(gapId))?.status).toBe('closed');
      expect(r.effect).toBe('read');
      expect(r.changes).toContain(`gap_closed:${gapId}`);
      expect(r.nextHints).toContain('report_to_owner');
      expect(r.actions?.find((a) => a.toolId === 'gaps.close')?.level).toBe('act_and_report');
      expect(res.wake!.acted).toBe(true);
    } finally {
      await s.cleanup();
    }
  });

  it('at act_quietly it closes without a report hint', async () => {
    let gapId = '';
    const s = await scratch((t) => (t === 0 ? { gap: gapId, toolId: 'brain.verify', input: {} } : SLEEP));
    gapId = s.gapId;
    try {
      await s.core.approvals.setLevel('gaps.close', 'act_quietly');
      const r = firstReceipt(await s.core.processEvent(owner('Is the page live?')));
      expect((await s.core.gaps.get(gapId))?.status).toBe('closed');
      expect(r.nextHints ?? []).not.toContain('report_to_owner');
    } finally {
      await s.cleanup();
    }
  });

  it('at draft the gap stays open and the close waits for the owner; his yes closes it', async () => {
    let gapId = '';
    let approved = false;
    const s = await scratch((t, req) => {
      // The yes comes in its own wake, after the owner says it.
      if (/Yes, close it/.test(req.prompt.split('Incoming Event:')[1] ?? '') && !approved) {
        approved = true;
        return { gap: gapId, toolId: 'approvals.approve', input: {} };
      }
      return t === 0 ? { gap: gapId, toolId: 'brain.verify', input: {} } : SLEEP;
    });
    gapId = s.gapId;
    try {
      await s.core.approvals.setLevel('gaps.close', 'draft');
      const r = firstReceipt(await s.core.processEvent(owner('Is the page live?')));
      expect((await s.core.gaps.get(gapId))?.status).toBe('open');
      expect(r.actions?.find((a) => a.toolId === 'gaps.close')?.status).toBe('pending_approval');
      const pending = await s.core.approvals.listPending();
      expect(pending.map((p) => p.toolId)).toEqual(['gaps.close']);
      expect((await s.core.gaps.get(gapId))?.lastVerify?.passed).toBe(true);

      // The owner says yes: approvals.approve runs the drafted close.
      await s.core.processEvent(owner('Yes, close it.'));
      expect((await s.core.gaps.get(gapId))?.status).toBe('closed');
    } finally {
      await s.cleanup();
    }
  });

  it('a drafted close is refused once the gap changed after the check', async () => {
    const dir = await tempDir('rufus-trust-stale-');
    const core = new RufusCore({ workspaceDir: dir, reasoningProvider: new FakeProvider(() => JSON.stringify(SLEEP)), speakerProvider: new FakeProvider(() => 'ok'), sink: { send: async () => undefined }, now: () => NOW });
    await core.init();
    try {
      const g = await core.gaps.create({ title: 'Synthetic', target: 't', reality: 'r', source: 'owner', now: new Date(NOW.getTime() - 120_000) });
      const checkedAt = new Date(NOW.getTime() - 60_000);
      await core.gaps.annotate(g.id, { lastVerify: { id: 'verify_1', at: checkedAt.toISOString(), passed: true, criteria: [] } });
      await core.gaps.update(g.id, { status: 'open', reality: 'Owner says it is not done' }, NOW);
      const r = await core.registry.call('gaps.close', { gapId: g.id, verifyId: 'verify_1', evidence: 'x' }, { workspaceDir: dir, now: NOW, approved: true });
      expect(r.status).toBe('failed');
      expect(r.error).toBe('stale verification');
      expect((await core.gaps.get(g.id))?.status).toBe('open');
      const wrong = await core.registry.call('gaps.close', { gapId: g.id, verifyId: 'verify_other', evidence: 'x' }, { workspaceDir: dir, now: NOW, approved: true });
      expect(wrong.error).toBe('no passing verification');
    } finally {
      await core.close();
    }
  });

  it('blocked, a passing check never closes the gap', async () => {
    let gapId = '';
    const s = await scratch((t) => (t === 0 ? { gap: gapId, toolId: 'brain.verify', input: {} } : SLEEP));
    gapId = s.gapId;
    try {
      await fs.writeFile(path.join(s.dir, 'trust.json'), JSON.stringify({ levels: {}, neverAllow: ['gaps.close'] }), 'utf8');
      const r = firstReceipt(await s.core.processEvent(owner('Is the page live?')));
      expect((await s.core.gaps.get(gapId))?.status).toBe('open');
      expect(r.changes).not.toContain(`gap_closed:${gapId}`);
      expect(r.actions?.find((a) => a.toolId === 'gaps.close')?.level).toBe('never');
    } finally {
      await s.cleanup();
    }
  });

  it('Decide cannot take an action as a move of its own', async () => {
    let gapId = '';
    const s = await scratch((t) => (t === 0 ? { gap: gapId, toolId: 'gaps.close', input: { gapId, verifyId: 'v', evidence: 'trust me' } } : SLEEP));
    gapId = s.gapId;
    try {
      const r = firstReceipt(await s.core.processEvent(owner('Close it.')));
      expect(r.error).toBe('internal_action');
      expect((await s.core.gaps.get(gapId))?.status).toBe('open');
      const desk = await s.core.registry.formatForDesk([]);
      expect(desk).not.toMatch(/gaps\.close/);
    } finally {
      await s.cleanup();
    }
  });
});

describe("the engine's own writes go through the ladder", () => {
  it('sleep is resolved by the ladder, not hard-coded', async () => {
    const s = await scratch(() => SLEEP, { maxTurns: 2 });
    try {
      await s.core.watches.add({ kind: 'timer', label: 'next look', gapId: s.gapId, fireAt: '2099-01-01T00:00:00Z' }, NOW);
      await s.core.approvals.setLevel('sleep', 'rehearse');
      const res = await s.core.processEvent(owner('Night.'));
      expect(res.wake!.slept).toBe(false);
      expect(firstReceipt(res).data).toMatchObject({ rehearsed: true });
    } finally {
      await s.cleanup();
    }
  });

  it('a new gap named inline is saved only on gaps.create\'s rung, and the work log only on gaps.note\'s', async () => {
    const s = await scratch((t) => (t === 0 ? { gap: { title: 'INLINE_MARKER', target: 'x' }, toolId: 'demo.look', input: {} } : SLEEP), { maxTurns: 2 });
    try {
      await fs.writeFile(path.join(s.dir, 'trust.json'), JSON.stringify({ levels: {}, neverAllow: ['gaps.create', 'gaps.note'] }), 'utf8');
      const res = await s.core.processEvent(owner('Do a new thing.'));
      expect((await s.core.gaps.list()).some((g) => g.title === 'INLINE_MARKER')).toBe(false);
      expect(firstReceipt(res).error).toBe('neverAllow');
    } finally {
      await s.cleanup();
    }
    let gapId = '';
    const t = await scratch((n) => (n === 0 ? { gap: gapId, toolId: 'demo.look', input: {} } : SLEEP), { maxTurns: 2 });
    gapId = t.gapId;
    try {
      await t.core.approvals.setLevel('gaps.note', 'rehearse');
      await t.core.processEvent(owner('Look.'));
      expect((await t.core.gaps.get(gapId))?.log ?? []).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  it("a new target is its own action: at draft the target waits for the owner while the reality note goes in", async () => {
    let gapId = '';
    const s = await scratch((t) => (t === 0 ? { gap: gapId, toolId: 'gaps.update', input: { gapId, target: 'An easier target', reality: 'REALITY_MARKER' } } : SLEEP), { maxTurns: 2 });
    gapId = s.gapId;
    try {
      await s.core.approvals.setLevel('gaps.retarget', 'draft');
      await s.core.processEvent(owner('Update it.'));
      const g = await s.core.gaps.get(gapId);
      expect(g?.target).toBe('The synthetic page is live');
      expect(g?.reality).toBe('REALITY_MARKER');
      expect((await s.core.approvals.listPending()).map((p) => p.toolId)).toEqual(['gaps.retarget']);
    } finally {
      await s.cleanup();
    }
  });
});

describe('rungs a tool can and cannot reach', () => {
  it('self.upgrade starts at draft and trust.json cannot raise it past draft', async () => {
    const s = await scratch(() => SLEEP);
    try {
      const m = s.core.registry.get('self.upgrade')!.manifest;
      expect(await s.core.approvals.levelFor(m)).toBe('draft');
      await s.core.approvals.setLevel('self.upgrade', 'act_quietly');
      expect(await s.core.approvals.levelFor(m)).toBe('draft');
      await s.core.approvals.setLevel('self.upgrade', 'rehearse');
      expect(await s.core.approvals.levelFor(m)).toBe('rehearse');
    } finally {
      await s.cleanup();
    }
  });

  it('bookkeeping defaults to act_quietly, closing and retargeting to act_and_report, all movable in trust.json', async () => {
    const s = await scratch(() => SLEEP);
    try {
      const level = (id: string) => s.core.approvals.levelFor(s.core.registry.get(id)!.manifest);
      for (const id of ['gaps.note', 'gaps.create', 'gaps.update', 'watch.set', 'sleep', 'approvals.deny', 'memory.supersede']) expect(await level(id)).toBe('act_quietly');
      for (const id of ['gaps.close', 'gaps.retarget', 'tools.create', 'tools.repair']) expect(await level(id)).toBe('act_and_report');
      await s.core.approvals.setLevel('gaps.close', 'act_quietly');
      expect(await level('gaps.close')).toBe('act_quietly');
    } finally {
      await s.cleanup();
    }
  });

  it('a packaged manifest cannot vouch for its own trust', () => {
    const m = packagedManifest({ ...LOOK, id: 'x.write', effect: 'write', defaultTrust: 'act_quietly', actions: ['gaps.close'], internal: true });
    expect(m.defaultTrust).toBeUndefined();
    expect(m.actions).toBeUndefined();
    expect(m.internal).toBeUndefined();
    expect(packagedManifest({ ...LOOK, defaultTrust: 'draft' }).defaultTrust).toBe('draft');
  });
});

describe('a tool Rufus just built or repaired starts low on the ladder', () => {
  const manifest = (id: string): ToolManifest => ({ ...LOOK, id, inputSchema: { type: 'object', properties: {}, additionalProperties: false } });
  const runCode = `export async function run() { return { ok: true, summary: 'fine' }; }\n`;
  const realTest = `import { run } from './run.mjs';\nconst r = await run({});\nif (!r.ok) process.exit(1);\n`;
  const shapeTest = `import { run } from './run.mjs';\nif (typeof run !== 'function') process.exit(1);\n`;

  async function registry() {
    const dir = await tempDir('rufus-trust-start-');
    const reg = new ToolRegistry({ toolsDir: path.join(dir, 'tools') });
    const approvals = new ApprovalStore(dir);
    reg.useTrust(approvals);
    return { reg, approvals };
  }

  it('starts at draft when its test really runs it, at rehearse when the test only checks its shape', async () => {
    const { reg, approvals } = await registry();
    const tested = await reg.createOrRepair({ manifest: manifest('demo.tested'), runCode, testCode: realTest });
    expect(tested).toMatchObject({ ok: true, startLevel: 'draft', evidence: { testRanTool: true } });
    expect(await approvals.levelFor(reg.get('demo.tested')!.manifest)).toBe('draft');
    const untested = await reg.createOrRepair({ manifest: manifest('demo.untested'), runCode, testCode: shapeTest });
    expect(untested).toMatchObject({ ok: true, startLevel: 'rehearse' });
    expect(await approvals.levelFor(reg.get('demo.untested')!.manifest)).toBe('rehearse');
    // The installed tool is the real code, not the test probe.
    expect(await fs.readFile(path.join(reg.toolsDir, 'demo.tested', 'run.mjs'), 'utf8')).toBe(runCode);
  });

  it('a repair goes back down from a raised rung; a blocked tool stays blocked', async () => {
    const { reg, approvals } = await registry();
    await reg.createOrRepair({ manifest: manifest('demo.fixme'), runCode, testCode: realTest });
    await approvals.setLevel('demo.fixme', 'act_quietly');
    const repaired = await reg.createOrRepair({ manifest: { ...manifest('demo.fixme'), version: 2 }, runCode, testCode: shapeTest });
    expect(repaired.startLevel).toBe('rehearse');
    expect(await approvals.levelFor(reg.get('demo.fixme')!.manifest)).toBe('rehearse');
    await fs.writeFile(approvals.trustPath, JSON.stringify({ levels: {}, neverAllow: ['demo.fixme'] }), 'utf8');
    await reg.createOrRepair({ manifest: { ...manifest('demo.fixme'), version: 3 }, runCode, testCode: realTest });
    expect(await approvals.levelFor(reg.get('demo.fixme')!.manifest)).toBe('never');
  });

  it('real past calls that still work count as a passing test', () => {
    expect(startLevelFor({ testRanTool: false, replayWorked: 2 })).toBe('draft');
    expect(startLevelFor({ testRanTool: false, replayWorked: 0 })).toBe('rehearse');
  });

  it('a read tool that is not on an act rung does not run inside another tool', async () => {
    const { reg, approvals } = await registry();
    await reg.registerInline(LOOK, async () => ({ ok: true, summary: 'looked' }));
    await reg.registerInline({ ...LOOK, id: 'demo.outer' }, async (_i, ctx) => {
      const sub = await ctx.callTool('demo.look');
      return { ok: true, summary: sub.summary };
    });
    const opts = { workspaceDir: path.dirname(reg.toolsDir), now: NOW };
    expect((await reg.call('demo.outer', {}, opts)).summary).toBe('looked');
    await approvals.setLevel('demo.look', 'draft');
    expect((await reg.call('demo.outer', {}, opts)).summary).toMatch(/Composition refused.*draft/);
  });
});
