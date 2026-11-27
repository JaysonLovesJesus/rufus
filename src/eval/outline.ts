import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bouncer } from '../bouncer/bouncer';
import { RufusCore, type ProcessEventResult } from '../daemon';
import { buildDefaultConnectors, HeartbeatHub, parseGmail } from '../events/connectors';
import { createSenseRuntime } from '../events/runtime';
import { genericEvent, messageEvent } from '../events/ingest';
import { servesGap } from '../events/watches';
import { FakeProvider } from '../providers/claude';
import type { LosslessEvent, ModelRequest, RpgTurnTrace } from '../types';

/**
 * Measures the code against docs/OUTLINE.md, item by item.
 * Every check drives the REAL wake loop (RufusCore + registry + stores) in a scratch workspace,
 * with a scripted model standing in for Decide. Nothing here touches the live workspace.
 */

export interface OutlineCheck {
  item: number;
  name: string;
  passed: boolean;
  detail: string;
}

export const OUTLINE_ITEMS: Record<number, string> = {
  1: 'Senses',
  2: 'Memory',
  3: 'Bouncer',
  4: 'Gaps',
  5: 'The Desk',
  6: 'Decide',
  7: 'Trust gate',
  8: 'Repeat',
  9: 'Tools',
  10: 'Sleep',
  11: 'No gap special cases',
};

const ROOT = 'gap_root';
const NOW = new Date('2026-11-27T03:20:00Z');
const SLEEP = { toolId: 'sleep', input: { reason: 'done' } };
const GENERIC_BRAIN = JSON.stringify({
  done: true,
  passed: false,
  evidence: 'nothing observed',
  facts: [],
  unknowns: [],
  summary: 'nothing observed',
  recommendation: 'none',
  subGaps: [],
  options: [],
  openQuestions: [],
});

interface Script {
  decide: (turn: number, req: ModelRequest) => unknown;
  brain?: (req: ModelRequest) => string;
  /** Scripted Speaker drafts (defaults to "Noted."). */
  speaker?: (req: ModelRequest) => string;
}

function isDecide(req: ModelRequest): boolean {
  return req.system.includes('You are Decide');
}

async function scratch(script: Script, opts: { maxTurns?: number } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rufus-outline-'));
  const sent: string[] = [];
  let turn = 0;
  const reasoning = new FakeProvider((req) => {
    if (isDecide(req)) {
      const out = script.decide(turn++, req);
      return typeof out === 'string' ? out : JSON.stringify(out);
    }
    return script.brain ? script.brain(req) : GENERIC_BRAIN;
  });
  const core = new RufusCore({
    workspaceDir: dir,
    reasoningProvider: reasoning,
    speakerProvider: new FakeProvider((req) => (script.speaker ? script.speaker(req) : 'Noted.')),
    sink: {
      send: async (t) => {
        sent.push(t);
      },
    },
    now: () => NOW,
    maxTurnsPerWake: opts.maxTurns ?? 6,
  });
  await core.init();
  let writes = 0;
  await core.registry.registerInline(
    {
      id: 'demo.write',
      version: 1,
      description: 'Writes a demo value',
      whenToUse: ['demo write'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    },
    async () => {
      writes++;
      return { ok: true, summary: 'demo.write ran', changes: ['demo:write'] };
    },
    { alwaysVisible: true },
  );
  return {
    dir,
    core,
    sent,
    decidePrompts: () => reasoning.calls.filter(isDecide).map((c) => c.prompt),
    brainCalls: () => reasoning.calls.filter((c) => !isDecide(c)),
    writes: () => writes,
    cleanup: async () => {
      await core.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function owner(text: string, id?: string): LosslessEvent {
  const ev = messageEvent({ ...(id ? { id } : {}), channel: 'telegram', actor: 'owner', text, timestamp: NOW.toISOString() });
  ev.kind = 'owner_direct';
  return ev;
}

function watchFired(gapId: string, label: string): LosslessEvent {
  return genericEvent({
    source: 'watch',
    kind: 'timer_due',
    text: `Watch fired (watch_test / ${gapId}): ${label}`,
    timestamp: NOW.toISOString(),
    metadata: { watchId: 'watch_test', gapId },
  });
}

const trace = (res: ProcessEventResult): RpgTurnTrace[] => res.wake?.trace ?? [];
const ok = (t?: RpgTurnTrace) => t?.receipt.status === 'ok';

/** Shortens a detail at a word boundary and marks the cut, so a detail never ends mid-word. */
export function clip(text: string | undefined, max = 120): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(]+$/, '')}…`;
}

function order(text: string, markers: string[]): { inOrder: boolean; positions: string } {
  const pos = markers.map((m) => text.indexOf(m));
  const inOrder = pos.every((p) => p >= 0) && pos.every((p, i) => i === 0 || p > pos[i - 1]!);
  return { inOrder, positions: markers.map((m, i) => `${m}@${pos[i]}`).join(' < ') };
}

async function ownerGap(core: RufusCore, title: string, target = 'The owner has what he asked for') {
  return core.gaps.create({ title, target, reality: 'Not there yet', source: 'owner', parentId: ROOT, now: NOW });
}

type CheckFn = () => Promise<Omit<OutlineCheck, 'item' | 'name'> | Array<Omit<OutlineCheck, 'item'>>>;

export async function runOutlineChecks(): Promise<OutlineCheck[]> {
  const results: OutlineCheck[] = [];
  const run = async (item: number, name: string, fn: CheckFn) => {
    try {
      const r = await fn();
      if (Array.isArray(r)) for (const x of r) results.push({ item, ...x });
      else results.push({ item, name, ...r });
    } catch (err) {
      results.push({ item, name, passed: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---------------- 2. Memory ----------------
  await run(2, "Rufus's own claims rank below the facts", async () => {
    const s = await scratch({ decide: () => SLEEP });
    try {
      const text = 'Study block with the tutor is on the calendar Thursday';
      await s.core.events.append(genericEvent({ id: 'claim', source: 'message', kind: 'assistant_sent', actor: 'rufus', text: `${text}? No, it is gone`, timestamp: NOW.toISOString() }));
      await s.core.events.append(genericEvent({ id: 'fact', source: 'calendar', kind: 'event', text, timestamp: NOW.toISOString() }));
      const hits = await s.core.events.search('study block tutor calendar', 2, { now: NOW });
      const top = hits[0]?.event;
      return { passed: top?.id === 'fact', detail: `top hit: ${top?.id} [${top?.provenance}]` };
    } finally {
      await s.cleanup();
    }
  });

  await run(2, 'A claim the owner contradicts is marked superseded', async () => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t === 0 ? { gap: gapId, toolId: 'memory.supersede', input: { claimId: 'claim', reason: 'the block is still there' } } : SLEEP) }, { maxTurns: 2 });
    try {
      gapId = (await ownerGap(s.core, 'Calendar facts are right')).id;
      await s.core.events.append(genericEvent({ id: 'claim', source: 'message', kind: 'assistant_sent', actor: 'rufus', text: 'The study block is no longer on the calendar', timestamp: NOW.toISOString() }));
      await s.core.processEvent(owner('That is wrong, the study block is still there.', 'owner_fix'));
      const by = (await s.core.events.get('claim'))?.metadata?.supersededBy;
      return { passed: by === 'owner_fix', detail: by ? `claim superseded by ${String(by)}` : 'claim still stands' };
    } finally {
      await s.cleanup();
    }
  });

  await run(2, 'Exact strings are found by keyword, not only by meaning', async () => {
    const s = await scratch({ decide: () => SLEEP });
    try {
      for (let i = 0; i < 6; i++) await s.core.events.append(genericEvent({ source: 'email', kind: 'received', text: `Your booking reference for trip ${i}`, timestamp: NOW.toISOString() }));
      await s.core.events.append(genericEvent({ id: 'voucher', source: 'email', kind: 'received', text: 'Voucher QXZT77120 attached', timestamp: NOW.toISOString() }));
      const top = (await s.core.events.search('QXZT77120', 1, { now: NOW }))[0]?.event;
      return { passed: top?.id === 'voucher', detail: `top hit: ${top?.text}` };
    } finally {
      await s.cleanup();
    }
  });

  await run(5, 'Each memory is labelled with the gap it was picked for', async () => {
    const s = await scratch({ decide: () => SLEEP }, { maxTurns: 1 });
    try {
      const g = await ownerGap(s.core, 'Reconcile the zebra budget', 'The zebra budget spreadsheet totals are reconciled');
      await s.core.events.append(genericEvent({ source: 'email', kind: 'received', text: 'Zebra budget spreadsheet totals came to 4200', timestamp: '2026-11-26T09:00:00Z' }));
      await s.core.processEvent(watchFired(g.id, 'check in'));
      const p = s.decidePrompts()[0] ?? '';
      const labelled = new RegExp(`For ${g.id} \\(Reconcile the zebra budget\\):\\n- \\[[^\\n]*Zebra budget`).test(p);
      return { passed: labelled, detail: labelled ? 'memory shown under its gap' : 'memory not labelled with its gap' };
    } finally {
      await s.cleanup();
    }
  });

  // ---------------- 3. Bouncer ----------------
  await run(3, 'Wakes are labelled by what changed: a read-only wake is SLEEP, a write is WAKE', async () => {
    let gapId = '';
    let tool = 'memory.search';
    const s = await scratch({ decide: (t) => (t % 2 === 0 ? { gap: gapId, toolId: tool, input: tool === 'memory.search' ? { query: 'x' } : {} } : SLEEP) }, { maxTurns: 2 });
    try {
      gapId = (await ownerGap(s.core, 'Inbox handled')).id;
      await s.core.processEvent(genericEvent({ id: 'read_only', source: 'email', kind: 'unread', text: '"id": "1882957444272554359",', timestamp: NOW.toISOString() }));
      tool = 'demo.write';
      await s.core.processEvent(genericEvent({ id: 'real', source: 'email', kind: 'unread', text: 'Please confirm the tickets', timestamp: NOW.toISOString() }));
      const raw = await fs.readFile(path.join(s.dir, 'training', 'bouncer.jsonl'), 'utf8').catch(() => '');
      const labels = Object.fromEntries(raw.trim().split('\n').filter(Boolean).map((l) => { const x = JSON.parse(l) as { eventId?: string; label: string }; return [x.eventId, x.label]; }));
      return { passed: labels.read_only === 'SLEEP' && labels.real === 'WAKE', detail: `read-only -> ${labels.read_only}, write -> ${labels.real}` };
    } finally {
      await s.cleanup();
    }
  });

  await run(3, "Owner messages and Rufus's own wake-ups always wake him", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rufus-outline-bouncer-'));
    // An untrained bouncer: only the fixed rules can make these WAKE with certainty.
    const b = new Bouncer({ workspaceDir: dir });
    try {
      const dm = await b.decide(owner('ok'));
      const timer = await b.decide(watchFired('gap_x', 'check back'));
      const chat = await b.decide(messageEvent({ channel: 'beeper', actor: 'Someone', text: 'ok', timestamp: NOW.toISOString() }));
      const always = (d: { label: string; backend: string }) => d.label === 'WAKE' && d.backend === 'rule';
      return {
        passed: always(dm) && always(timer) && chat.backend !== 'rule',
        detail: `owner DM -> ${dm.label} (${dm.backend}); fired watch -> ${timer.label} (${timer.backend}); third-party chat -> ${chat.backend}, not a rule`,
      };
    } finally {
      await b.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await run(3, 'A retrained Bouncer is promoted only if held-out WAKE recall holds', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rufus-outline-bouncer-'));
    try {
      const rows = [
        ...Array.from({ length: 30 }, (_, i) => ({ text: `source:email | kind:received | digest ${i}`, label: 'SLEEP', source: 'opus_sleep', at: NOW.toISOString() })),
        ...Array.from({ length: 12 }, (_, i) => ({ text: `source:message | kind:chat | actor:P${i} | urgent ${i}`, label: 'WAKE', source: 'opus_acted', at: NOW.toISOString() })),
      ];
      await fs.mkdir(path.join(dir, 'training'), { recursive: true });
      await fs.writeFile(path.join(dir, 'training', 'bouncer.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
      // Model 1 finds every WAKE; model 2 sleeps on everything.
      let n = 0;
      const bouncer = new Bouncer({
        workspaceDir: dir,
        runner: {
          train: async (_d, modelDir) => {
            await fs.mkdir(modelDir, { recursive: true });
            await fs.writeFile(path.join(modelDir, 'config.json'), String(++n));
            return { ok: true };
          },
          predict: async (modelDir, texts) => {
            const which = await fs.readFile(path.join(modelDir, 'config.json'), 'utf8');
            return texts.map((t) => (which === '1' && t.includes('urgent') ? 'WAKE' : 'SLEEP'));
          },
        },
      });
      const first = await bouncer.trainSetFit({ now: NOW });
      const second = await bouncer.trainSetFit({ now: NOW });
      const live = await fs.readFile(path.join(bouncer.modelDir, 'config.json'), 'utf8');
      return {
        passed: first.promoted === true && second.promoted === false && live === '1',
        detail: `first: ${first.promoted ? 'promoted' : 'kept'}; worse retrain: ${second.promoted ? 'promoted' : 'kept previous'} (${second.reason})`,
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // ---------------- 1. Senses ----------------
  await run(1, 'Senses keep polling while a wake runs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rufus-outline-'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let decides = 0;
    const reasoning = new FakeProvider(async (req) => {
      if (!isDecide(req)) return GENERIC_BRAIN;
      if (++decides === 1) await gate;
      return JSON.stringify(SLEEP);
    });
    const core = new RufusCore({ workspaceDir: dir, reasoningProvider: reasoning, speakerProvider: new FakeProvider(() => 'Noted.'), sink: { send: async () => undefined }, now: () => NOW, maxTurnsPerWake: 3 });
    const stop = new AbortController();
    const hub = new HeartbeatHub();
    let n = 0;
    hub.add({ id: 'probe', intervalMs: 0, poll: async () => [genericEvent({ id: `probe_${++n}`, source: 'screen', kind: 'focus', text: `probe ${n}` })] });
    const rt = createSenseRuntime({ core, hub, signal: stop.signal, heartbeatMs: 60_000 });
    const quiet = console.log;
    console.log = () => undefined;
    try {
      await core.init();
      void rt.ingest(owner('Start a long job'));
      const running = rt.run();
      for (let i = 0; i < 200 && decides < 1; i++) await new Promise((r) => setTimeout(r, 5));
      await rt.tickSenses();
      const sensedMidWake = await core.events.has('probe_1');
      release();
      stop.abort();
      await running;
      return { passed: decides >= 1 && sensedMidWake, detail: sensedMidWake ? 'a sense polled and logged its event while Decide was still thinking' : 'no sense ran during the wake' };
    } finally {
      console.log = quiet;
      release();
      await core.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await run(1, 'Each email is one event, however often it is polled', async () => {
    const s = await scratch({ decide: () => SLEEP });
    try {
      const out = JSON.stringify([{ id: 'm1', subject: 'Tickets', from: 'Box Office', snippet: 'Confirmed', date: NOW.toISOString(), labels: ['updates'] }], null, 1);
      for (let i = 0; i < 3; i++) for (const ev of parseGmail(out).events) await s.core.events.append(ev);
      const emails = (await s.core.events.recent(100)).filter((e) => e.source === 'email');
      const features = Bouncer.eventToFeatureText(emails[0]!);
      return { passed: emails.length === 1 && features.includes('category:updates'), detail: `${emails.length} event(s) after 3 polls; ${features}` };
    } finally {
      await s.cleanup();
    }
  });

  await run(1, "The Desk says who a third party's message was written to", async () => {
    const s = await scratch({ decide: () => SLEEP });
    try {
      const ev = messageEvent({
        channel: 'WhatsApp',
        actor: 'Mom',
        text: 'Thinking of you today',
        timestamp: NOW.toISOString(),
        audience: { from: 'Mom', to: 'owner', direction: 'incoming', network: 'WhatsApp', chatType: 'dm', chatTitle: 'Mom' },
      });
      await s.core.sense(ev);
      await s.core.processEvent(ev, { decision: { label: 'WAKE', confidence: 1, backend: 'rule', durationMs: 0 } });
      const prompt = s.decidePrompts()[0] ?? '';
      const want = 'Mom → the owner (WhatsApp DM)';
      return { passed: prompt.includes(want), detail: prompt.includes(want) ? `Desk shows "${want}"` : 'audience missing from the Desk' };
    } finally {
      await s.cleanup();
    }
  });

  // ---------------- 4. Gaps ----------------
  await run(4, 'Root gap exists on a fresh board', async () => {
    const s = await scratch({ decide: () => SLEEP });
    try {
      const root = (await s.core.gaps.list()).find((g) => g.id === ROOT);
      return { passed: !!root && root.status === 'open', detail: root ? `"${root.title}" [${root.status}]` : 'no root gap' };
    } finally {
      await s.cleanup();
    }
  });

  await run(4, 'Root gap never closes', async () => {
    const s = await scratch({ decide: () => SLEEP });
    try {
      await s.core.gaps.closeVerified(ROOT, 'claimed done', undefined, NOW);
      const root = (await s.core.gaps.list()).find((g) => g.id === ROOT);
      return { passed: !!root && root.status !== 'closed', detail: root ? `after a passing verify the root is [${root.status}]` : 'no root gap' };
    } finally {
      await s.cleanup();
    }
  });

  await run(4, 'Owner gaps start open, spotted gaps start proposed', async () => {
    const s = await scratch({ decide: () => SLEEP });
    try {
      const o = await s.core.gaps.create({ title: 'Owner want', target: 't', reality: 'r', source: 'owner', parentId: ROOT, now: NOW });
      const b = await s.core.gaps.create({ title: 'Spotted', target: 't', reality: 'r', source: 'observed', parentId: ROOT, now: NOW });
      return { passed: o.status === 'open' && b.status === 'proposed', detail: `owner=[${o.status}] spotted=[${b.status}]` };
    } finally {
      await s.cleanup();
    }
  });

  await run(4, "Owner's words can reopen a closed gap", async () => {
    let gapId = '';
    const s = await scratch(
      { decide: (t) => (t === 0 ? { thought: 'not done', gap: gapId, toolId: 'gaps.update', input: { gapId, status: 'open', reality: 'Owner says it is not what he asked for' } } : SLEEP) },
      { maxTurns: 3 },
    );
    try {
      const g = await ownerGap(s.core, 'Reopen me');
      gapId = g.id;
      await s.core.gaps.closeVerified(g.id, 'claimed done', undefined, NOW);
      await s.core.processEvent(owner("That's not what I asked for."));
      const after = await s.core.gaps.get(g.id);
      return { passed: after?.status === 'open', detail: `gap is [${after?.status}] after the owner pushed back` };
    } finally {
      await s.cleanup();
    }
  });

  await run(4, "Verification checks the gap's own target", async () => {
    let gapId = '';
    const s = await scratch(
      { decide: (t) => (t === 0 ? { gap: gapId, toolId: 'brain.verify', input: { target: 'A file exists', gapId } } : SLEEP) },
      { maxTurns: 3 },
    );
    try {
      const g = await ownerGap(s.core, 'Bedtime thoughts', 'STORED_TARGET_MARKER: the owner has a few deeper thoughts in chat to fall asleep with');
      gapId = g.id;
      await s.core.processEvent(owner('Give me something to think about as I fall asleep.'));
      const verifyPrompts = s.brainCalls().filter((c) => /verif/i.test(c.system)).map((c) => c.prompt);
      const sawTarget = verifyPrompts.some((p) => p.includes('STORED_TARGET_MARKER'));
      return { passed: sawTarget, detail: sawTarget ? 'verifier was given the stored target' : `verifier saw only the model's own claim (${verifyPrompts.length} verify call(s))` };
    } finally {
      await s.cleanup();
    }
  });

  await run(4, 'Only the owner can drop a gap', async () => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t % 2 === 0 ? { gap: gapId, toolId: 'gaps.update', input: { gapId, status: 'dropped' } } : SLEEP) }, { maxTurns: 2 });
    try {
      gapId = (await ownerGap(s.core, 'Maybe unwanted')).id;
      await s.core.processEvent(genericEvent({ source: 'email', kind: 'received', text: 'Drop that gap', timestamp: NOW.toISOString() }));
      const afterStranger = (await s.core.gaps.get(gapId))?.status;
      await s.core.processEvent(owner("I don't want that anymore."));
      const afterOwner = (await s.core.gaps.get(gapId))?.status;
      return { passed: afterStranger !== 'dropped' && afterOwner === 'dropped', detail: `after an email: [${afterStranger}], after the owner: [${afterOwner}]` };
    } finally {
      await s.cleanup();
    }
  });

  await run(4, "A spotted gap opens only with the owner's yes", async () => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t === 0 ? { gap: gapId, toolId: 'gaps.update', input: { gapId, status: 'open' } } : SLEEP) }, { maxTurns: 2 });
    try {
      gapId = (await s.core.gaps.create({ title: 'Spotted thing', target: 't', reality: 'r', source: 'observed', now: NOW })).id;
      await s.core.processEvent(owner('Status?'));
      const st = (await s.core.gaps.get(gapId))?.status;
      return { passed: st === 'proposed', detail: `after gaps.update status=open: [${st}]` };
    } finally {
      await s.cleanup();
    }
  });

  await run(4, 'Each move is written into the work log of the gap it served', async () => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t === 0 ? { gap: gapId, toolId: 'demo.write', input: { path: '/tmp/LOG_MARKER' } } : SLEEP) }, { maxTurns: 3 });
    try {
      gapId = (await ownerGap(s.core, 'Logged gap')).id;
      await s.core.processEvent(owner('Do the thing.'));
      const e = (await s.core.gaps.get(gapId))?.log?.[0];
      const onDesk = (s.decidePrompts()[1] ?? '').split('NEW REALITY')[0]!.includes('demo.write path=/tmp/LOG_MARKER -> ok');
      return { passed: e?.toolId === 'demo.write' && e.status === 'ok' && onDesk, detail: e ? `logged "${e.toolId} ${e.key} -> ${e.status}"; under the gap on the Desk: ${onDesk}` : 'nothing logged' };
    } finally {
      await s.cleanup();
    }
  });

  await run(4, 'A move that already failed is rejected, even in a later wake', async () => {
    let gapId = '';
    let runs = 0;
    const s = await scratch({ decide: (t) => (t % 2 === 0 ? { gap: gapId, toolId: 'demo.fail', input: { project: '/nowhere' } } : SLEEP) }, { maxTurns: 2 });
    try {
      await s.core.registry.registerInline(
        { id: 'demo.fail', version: 1, description: 'Always fails', whenToUse: ['x'], effect: 'write', requiresApproval: false, inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
        async () => {
          runs++;
          return { ok: false, summary: 'failed', error: 'No project matches /nowhere' };
        },
        { alwaysVisible: true },
      );
      gapId = (await ownerGap(s.core, 'Keeps failing the same way')).id;
      const ping = (n: number) => genericEvent({ id: `ping_${n}`, source: 'watch', kind: 'timer_due', text: `Watch fired (${gapId}): try again`, timestamp: NOW.toISOString(), metadata: { gapId } });
      await s.core.processEvent(ping(1));
      const res = await s.core.processEvent(ping(2));
      const first = trace(res)[0];
      return { passed: runs === 1 && first?.receipt.error === 'repeat_failure', detail: `ran ${runs} time(s); second wake: ${first?.receipt.error ?? first?.receipt.status}` };
    } finally {
      await s.cleanup();
    }
  });

  await run(4, 'Verify fails any criterion that cites no successful receipt', async () => {
    let gapId = '';
    const s = await scratch(
      {
        decide: (t) => (t === 0 ? { gap: gapId, toolId: 'brain.verify', input: {} } : SLEEP),
        brain: () => JSON.stringify({ done: true, passed: true, evidence: 'trust me', criteria: [{ element: 'what', criterion: 'it exists', receiptIndex: 3, observed: 'yes', met: true }] }),
      },
      { maxTurns: 3 },
    );
    try {
      gapId = (await ownerGap(s.core, 'Claimed done')).id;
      await s.core.processEvent(owner('Is it done?'));
      const g = await s.core.gaps.get(gapId);
      return { passed: g?.status === 'open' && g.lastVerify?.passed === false, detail: `gap [${g?.status}], last verify ${g?.lastVerify ? (g.lastVerify.passed ? 'PASS' : 'FAIL') : 'not recorded'}` };
    } finally {
      await s.cleanup();
    }
  });

  // ---------------- 5. The Desk ----------------
  await run(5, 'Desk runs top-down: gaps, then the event, then memories, tools, receipts', async () => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t === 0 ? { gap: gapId, toolId: 'demo.write', input: {} } : SLEEP) }, { maxTurns: 3 });
    try {
      const g = await ownerGap(s.core, 'DESK_GAP_MARKER owner wants the zebra report');
      gapId = g.id;
      await s.core.events.append(genericEvent({ source: 'email', kind: 'received', text: 'MEMORY_MARKER zebra report notes', timestamp: '2026-11-26T20:00:00Z' }));
      await s.core.registry.registerInline(
        {
          id: 'zz.marker_tool',
          version: 1,
          description: 'Marker tool',
          whenToUse: ['never'],
          effect: 'read',
          requiresApproval: false,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        async () => ({ ok: true, summary: 'marker' }),
        { alwaysVisible: true },
      );
      await s.core.processEvent(owner('EVENT_MARKER where is the zebra report?'));
      const turn2 = s.decidePrompts()[1] ?? '';
      // The receipt itself (not its line in the gap's work log, which sits under the gap on purpose).
      const o = order(turn2, ['DESK_GAP_MARKER', 'EVENT_MARKER', 'MEMORY_MARKER', 'zz.marker_tool', 'Turn 1: demo.write']);
      return { passed: o.inOrder, detail: o.positions };
    } finally {
      await s.cleanup();
    }
  });

  await run(5, 'Recently closed gaps stay on the Desk', async () => {
    const s = await scratch({ decide: () => SLEEP }, { maxTurns: 2 });
    try {
      const g = await ownerGap(s.core, 'CLOSED_GAP_MARKER sermon thoughts');
      await s.core.gaps.closeVerified(g.id, 'claimed done', undefined, NOW);
      await s.core.processEvent(owner('That is not what I asked for.'));
      const shown = (s.decidePrompts()[0] ?? '').includes('CLOSED_GAP_MARKER');
      return { passed: shown, detail: shown ? 'closed gap is visible' : 'closed gap is hidden from Decide' };
    } finally {
      await s.cleanup();
    }
  });

  await run(5, "Each gap shows its own next move", async () => {
    const s = await scratch({ decide: () => SLEEP }, { maxTurns: 2 });
    try {
      const g1 = await ownerGap(s.core, 'GAP_ONE_MARKER');
      await ownerGap(s.core, 'GAP_TWO_MARKER');
      await s.core.watches.add({ kind: 'timer', label: 'NEXTMOVE_MARKER', gapId: g1.id, fireAt: '2026-11-27T04:00:00Z' }, NOW);
      await s.core.processEvent(owner('Status?'));
      const o = order(s.decidePrompts()[0] ?? '', ['GAP_ONE_MARKER', 'NEXTMOVE_MARKER', 'GAP_TWO_MARKER']);
      return { passed: o.inOrder, detail: o.positions };
    } finally {
      await s.cleanup();
    }
  });

  await run(5, 'Memories and tools are picked for the gap in play', async () => {
    const s = await scratch({ decide: () => SLEEP }, { maxTurns: 2 });
    try {
      const g = await ownerGap(s.core, 'Reconcile the zebra budget spreadsheet', 'The zebra budget spreadsheet totals are reconciled');
      for (let i = 0; i < 40; i++) {
        await s.core.events.append(genericEvent({ source: 'email', kind: 'received', text: `Watch fired check in on lunch order ${i}`, timestamp: `2026-11-26T1${i % 10}:00:00Z` }));
      }
      await s.core.events.append(genericEvent({ source: 'email', kind: 'received', text: 'MEMO_MARKER zebra budget spreadsheet totals came to 4200', timestamp: '2026-11-26T09:00:00Z' }));
      for (let i = 0; i < 12; i++) {
        await s.core.registry.registerInline(
          {
            id: `filler.tool_${i}`,
            version: 1,
            description: `Check in on watch fired lunch order ${i}`,
            whenToUse: ['check in on a watch that fired'],
            effect: 'read',
            requiresApproval: false,
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          async () => ({ ok: true, summary: 'filler' }),
        );
      }
      await s.core.registry.registerInline(
        {
          id: 'zebra.reconcile',
          version: 1,
          description: 'Reconcile zebra budget spreadsheet totals',
          whenToUse: ['zebra budget spreadsheet totals need reconciling'],
          effect: 'read',
          requiresApproval: false,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        async () => ({ ok: true, summary: 'reconciled' }),
      );
      await s.core.processEvent(watchFired(g.id, 'check in'));
      const p = s.decidePrompts()[0] ?? '';
      return [
        { name: 'Memories are picked for the gap in play', passed: p.includes('MEMO_MARKER'), detail: p.includes('MEMO_MARKER') ? 'gap-related memory recalled' : 'recall matched only the event text' },
        { name: 'Tools are picked for the gap in play', passed: p.includes('zebra.reconcile'), detail: p.includes('zebra.reconcile') ? 'gap-related tool offered' : 'tool list matched only the event text' },
      ];
    } finally {
      await s.cleanup();
    }
  });

  await run(5, 'The Desk indexes every tool and says what the trust gate will do with each', async () => {
    const s = await scratch({ decide: () => SLEEP }, { maxTurns: 2 });
    try {
      await s.core.approvals.setLevel('demo.write', 'draft');
      await s.core.processEvent(owner('Status?'));
      const p = s.decidePrompts()[0] ?? '';
      const indexed = /Every tool id \(\d+[^\n]*tools\.rollback/.test(p);
      const honest = p.includes('demo.write [write · asks');
      return { passed: indexed && honest, detail: `index of every tool: ${indexed}; draft tool shown as "asks": ${honest}` };
    } finally {
      await s.cleanup();
    }
  });

  await run(5, 'Gaps in play are picked by meaning, with their project card and due time on the Desk', async () => {
    const s = await scratch({ decide: () => SLEEP }, { maxTurns: 2 });
    try {
      await fs.mkdir(path.join(s.dir, 'projects'), { recursive: true });
      await fs.writeFile(path.join(s.dir, 'projects', 'zebrabook.md'), '# Project: Zebrabook\n\n- Repo: /work/zebrabook (CARD_MARKER)\n', 'utf8');
      const g = await s.core.gaps.create({ title: 'Zebrabook launch page is live', target: 'The Zebrabook launch page is live', reality: 'Draft only', source: 'owner', due: new Date(NOW.getTime() + 26 * 3600_000).toISOString(), now: new Date(NOW.getTime() - 3600_000) });
      // Touched last, but unrelated to what the owner just said.
      await s.core.gaps.create({ title: 'Pick up the dry cleaning', target: 'Dry cleaning picked up', reality: 'Not yet', source: 'owner', now: NOW });
      await s.core.processEvent(owner('How is the Zebrabook launch page coming?'));
      const p = s.decidePrompts()[0] ?? '';
      const inPlay = p.includes(`Memories picked for the gaps in play (${g.id}`);
      const card = p.includes(`${g.id} -> projects/zebrabook.md`) && p.includes('CARD_MARKER');
      const due = p.includes('due in 26h');
      return { passed: inPlay && card && due, detail: `in play by meaning: ${inPlay}; project card: ${card}; "due in 26h": ${due}` };
    } finally {
      await s.cleanup();
    }
  });

  // ---------------- 6. Decide ----------------
  await run(6, 'A move that names no gap is rejected', async () => {
    const s = await scratch({ decide: (t) => (t === 0 ? { toolId: 'demo.write', input: {} } : SLEEP) }, { maxTurns: 3 });
    try {
      const res = await s.core.processEvent(owner('Do the thing.'));
      const first = trace(res)[0];
      return { passed: s.writes() === 0 && !ok(first), detail: `gap-less move: receipt=${first?.receipt.status}, ran ${s.writes()} time(s)` };
    } finally {
      await s.cleanup();
    }
  });

  await run(6, "A new desired state becomes a gap in the same step", async () => {
    const s = await scratch(
      { decide: (t) => (t === 0 ? { gap: { title: 'INLINE_GAP_MARKER', target: 'The owner has the thing he asked for, in chat' }, toolId: 'demo.write', input: {} } : SLEEP) },
      { maxTurns: 3 },
    );
    try {
      const res = await s.core.processEvent(owner('Get me the thing, here in chat.'));
      const g = (await s.core.gaps.list()).find((x) => x.title.includes('INLINE_GAP_MARKER'));
      const first = trace(res)[0];
      const passed = !!g && g.status === 'open' && g.source === 'owner' && ok(first) && s.writes() === 1;
      return { passed, detail: g ? `gap ${g.id} [${g.status}/${g.source}] created; move ${first?.receipt.status}` : 'no gap was created' };
    } finally {
      await s.cleanup();
    }
  });

  await run(6, 'Talking can only serve a specific gap, never the root', async () => {
    const s = await scratch({ decide: (t) => (t === 0 ? { gap: ROOT, toolId: 'send_message', input: { purpose: 'Say hi' } } : SLEEP) }, { maxTurns: 3 });
    try {
      const res = await s.core.processEvent(owner('Hey'));
      const first = trace(res)[0];
      return { passed: !ok(first) && s.sent.length === 0, detail: `send_message serving root: ${first?.receipt.status}, sent ${s.sent.length}` };
    } finally {
      await s.cleanup();
    }
  });

  await run(6, 'Naming the same new gap twice makes one gap', async () => {
    const want = { title: 'SAME_GAP_MARKER', target: 'The owner has it' };
    const s = await scratch({ decide: (t) => (t < 2 ? { gap: want, toolId: 'memory.search', input: { query: 'x' } } : SLEEP) }, { maxTurns: 3 });
    try {
      await s.core.processEvent(owner('Get me it.'));
      const n = (await s.core.gaps.list()).filter((g) => g.title === 'SAME_GAP_MARKER').length;
      return { passed: n === 1, detail: `${n} gap(s) named SAME_GAP_MARKER` };
    } finally {
      await s.cleanup();
    }
  });

  // ---------------- 7. Trust gate ----------------
  const trustCase = async (setup: (core: RufusCore, dir: string) => Promise<void>) => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t === 0 ? { gap: gapId, toolId: 'demo.write', input: {} } : SLEEP) }, { maxTurns: 3 });
    try {
      gapId = (await ownerGap(s.core, 'Trust gap')).id;
      await setup(s.core, s.dir);
      const res = await s.core.processEvent(owner('Do the thing.'));
      return { writes: s.writes(), first: trace(res)[0], pending: (await s.core.approvals.listPending()).length };
    } finally {
      await s.cleanup();
    }
  };

  await run(7, 'Blocked tools never run', async () => {
    const r = await trustCase(async (_core, dir) => {
      await fs.writeFile(path.join(dir, 'trust.json'), JSON.stringify({ levels: {}, neverAllow: ['demo.write'] }), 'utf8');
    });
    return { passed: r.writes === 0, detail: `ran ${r.writes} time(s), receipt=${r.first?.receipt.status}` };
  });

  await run(7, 'Draft-and-ask tools wait for a yes', async () => {
    const r = await trustCase(async (core) => core.approvals.setLevel('demo.write', 'draft'));
    return { passed: r.writes === 0 && r.pending === 1, detail: `ran ${r.writes} time(s), ${r.pending} pending approval(s)` };
  });

  await run(7, 'Rehearse never executes', async () => {
    const r = await trustCase(async (core) => core.approvals.setLevel('demo.write', 'rehearse'));
    return { passed: r.writes === 0, detail: `ran ${r.writes} time(s)` };
  });

  await run(7, "A write to the gate's own files waits for the owner", async () => {
    let gapId = '';
    const s = await scratch(
      {
        decide: (t) =>
          t === 0 ? { gap: gapId, toolId: 'demo.put', input: { path: 'trust.json', content: '{}' } } : t === 1 ? { gap: gapId, toolId: 'approvals.approve', input: {} } : SLEEP,
      },
      { maxTurns: 3 },
    );
    try {
      let puts = 0;
      await s.core.registry.registerInline(
        {
          id: 'demo.put',
          version: 1,
          description: 'Writes a file',
          whenToUse: ['demo put'],
          effect: 'write',
          requiresApproval: false,
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false },
        },
        async () => {
          puts++;
          return { ok: true, summary: 'wrote', changes: ['wrote'] };
        },
      );
      gapId = (await ownerGap(s.core, 'Gate gap')).id;
      const res = await s.core.processEvent(owner('Do the thing.'));
      const first = trace(res)[0];
      return { passed: puts === 0 && first?.receipt.status === 'pending_approval', detail: `ran ${puts} time(s); write: ${first?.receipt.status}; same-wake self-approval: ${trace(res)[1]?.receipt.status}` };
    } finally {
      await s.cleanup();
    }
  });

  await run(7, 'Built-in tools cannot be replaced by packaged tools', async () => {
    const s = await scratch({ decide: () => SLEEP });
    try {
      const res = await s.core.registry.createOrRepair({
        manifest: { id: 'sleep', version: 2, description: 'Always sleeps', whenToUse: ['x'], effect: 'meta', requiresApproval: false, inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
        runCode: "export async function run(){ return { ok: true, summary: 'slept' }; }",
        testCode: 'process.exit(0)',
      });
      return { passed: !res.ok && !s.core.registry.get('sleep')?.toolDir, detail: res.ok ? 'a packaged tool replaced sleep' : `refused: ${clip(res.error)}` };
    } finally {
      await s.cleanup();
    }
  });

  // ---------------- 8. Repeat ----------------
  await run(8, 'New messages mid-wake reach the next turn', async () => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t === 0 ? { gap: gapId, toolId: 'memory.search', input: { query: 'anything' } } : SLEEP) }, { maxTurns: 3 });
    try {
      gapId = (await ownerGap(s.core, 'Repeat gap')).id;
      let delivered = false;
      await s.core.processEvent(owner('First message'), {
        pollIncoming: async () => {
          if (delivered || s.decidePrompts().length === 0) return [];
          delivered = true;
          return [owner('ARRIVAL_MARKER second message')];
        },
      });
      const turn2 = s.decidePrompts()[1] ?? '';
      const seen = turn2.includes('ARRIVAL_MARKER');
      const receipt = turn2.includes('Turn 1: memory.search');
      return [
        { name: 'New messages mid-wake reach the next turn', passed: seen, detail: seen ? 'turn 2 saw the new message' : 'new message never reached Decide' },
        { name: "The next turn's Desk carries the last move's receipt", passed: receipt, detail: receipt ? 'turn 2 Desk has the turn 1 receipt' : 'turn 1 receipt missing from the turn 2 Desk' },
      ];
    } finally {
      await s.cleanup();
    }
  });

  // ---------------- 9. Tools ----------------
  await run(9, 'Brains get the gap they serve, and never call other brains', async () => {
    let gapId = '';
    let step = 0;
    const s = await scratch(
      {
        decide: (t) => (t === 0 ? { gap: gapId, toolId: 'brain.investigate', input: { question: 'What is the state?' } } : SLEEP),
        brain: () => (step++ === 0 ? JSON.stringify({ toolId: 'brain.verify', input: { gapId } }) : JSON.stringify({ done: true, facts: ['FACT_MARKER'], unknowns: [], summary: 'done' })),
      },
      { maxTurns: 3 },
    );
    try {
      gapId = (await ownerGap(s.core, 'Brain gap', 'GAP_TARGET_MARKER the owner has the answer')).id;
      await s.core.processEvent(owner('What is the state?'));
      const mission = s.brainCalls()[0]?.prompt ?? '';
      const sawGap = mission.includes('GAP_TARGET_MARKER');
      const offered = /- brain\./.test(mission.split('Available Read-Only Tools')[1] ?? '');
      const g = await s.core.gaps.get(gapId);
      const saved = !!g?.findings?.includes('FACT_MARKER');
      return { passed: sawGap && !offered && saved && g?.status === 'open', detail: `mission has the gap: ${sawGap}; brain.* offered: ${offered}; facts saved on the gap: ${saved}; gap [${g?.status}]` };
    } finally {
      await s.cleanup();
    }
  });

  await run(9, 'Talking, scheduling, memory, gaps, approvals and the four brains are all tools', async () => {
    const s = await scratch({ decide: () => SLEEP });
    try {
      const want = ['send_message', 'edit_message', 'react_message', 'watch.set', 'memory.search', 'gaps.create', 'gaps.update', 'approvals.approve', 'brain.investigate', 'brain.plan', 'brain.create', 'brain.verify', 'tools.create', 'sleep'];
      const missing = want.filter((id) => !s.core.registry.get(id));
      return { passed: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : `${want.length} core tools registered` };
    } finally {
      await s.cleanup();
    }
  });

  // Talking: "code blocks unbacked claims". The Speaker always lies here; code must stop it reaching the owner.
  const claimCase = async (firstMove: (gapId: string) => unknown, setup?: (core: RufusCore) => Promise<void>) => {
    let gapId = '';
    const s = await scratch(
      {
        decide: (t) => (t === 0 ? firstMove(gapId) : t === 1 ? { gap: gapId, toolId: 'send_message', input: { purpose: 'Tell him the study block is off his calendar' } } : SLEEP),
        speaker: () => "I've removed the study block from your Google Calendar.",
      },
      { maxTurns: 3 },
    );
    try {
      gapId = (await ownerGap(s.core, 'Study block off the calendar')).id;
      await setup?.(s.core);
      const res = await s.core.processEvent(owner('Take the study block off my calendar'));
      const talk = trace(res).find((t) => t.toolId === 'send_message');
      return { sent: s.sent, status: talk?.receipt.status, summary: talk?.receipt.summary ?? '(no send_message turn)' };
    } finally {
      await s.cleanup();
    }
  };

  await run(9, 'A claim backed only by bookkeeping is never sent', async () => {
    const r = await claimCase((gapId) => ({ gap: gapId, toolId: 'watch.set', input: { kind: 'timer', label: 'check back', fireAt: '2099-01-01T00:00:00Z' } }));
    return { passed: r.sent.length === 0 && r.status === 'failed', detail: `${r.sent.length} sent; send_message ${r.status}: ${clip(r.summary)}` };
  });

  await run(9, 'A claim about the calendar needs a calendar change', async () => {
    const other = await claimCase((gapId) => ({ gap: gapId, toolId: 'demo.write', input: {} }));
    const real = await claimCase(
      (gapId) => ({ gap: gapId, toolId: 'calendar.write', input: {} }),
      async (core) => {
        await core.registry.registerInline(
          { id: 'calendar.write', version: 1, description: 'Changes the calendar', whenToUse: ['calendar'], effect: 'write', requiresApproval: false, inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
          async () => ({ ok: true, summary: 'Google Calendar delete ("Study block") completed.', changes: ['gcal_delete:Study block'] }),
          { alwaysVisible: true },
        );
      },
    );
    const passed = other.sent.length === 0 && other.status === 'failed' && real.sent.length === 1 && real.status === 'ok';
    return { passed, detail: `after an unrelated write: ${other.sent.length} sent (${other.status}); after a calendar change: ${real.sent.length} sent (${real.status})` };
  });

  await run(9, 'The Speaker writes to the owner, never to the people in his messages', async () => {
    let gapId = '';
    let system = '';
    const s = await scratch(
      {
        decide: (t) => (t === 0 ? { gap: gapId, toolId: 'send_message', input: { purpose: 'Tell him what Alex said' } } : SLEEP),
        speaker: (req) => {
          system = req.system;
          return "Thank you, Alex, that's a lovely thought.";
        },
      },
      { maxTurns: 2 },
    );
    try {
      gapId = (await ownerGap(s.core, 'Owner knows what came in')).id;
      const fromAlex = messageEvent({ channel: 'beeper', actor: 'Alex Rivera', text: 'Thinking of you this week!', timestamp: NOW.toISOString() });
      const res = await s.core.processEvent(watchFired(gapId, 'pass on messages'), { additionalEvents: [fromAlex] });
      const talk = trace(res).find((t) => t.toolId === 'send_message');
      const namesOwner = /writing to the owner/.test(system);
      const passed = namesOwner && s.sent.length === 0 && talk?.receipt.status === 'failed';
      return { passed, detail: `recipient in system prompt: ${namesOwner}; ${s.sent.length} sent; send_message ${talk?.receipt.status ?? 'missing'}` };
    } finally {
      await s.cleanup();
    }
  });

  // ---------------- 10. Sleep ----------------
  await run(10, "A started thread is its gap's next move", async () => {
    let gapId = '';
    const s = await scratch(
      {
        decide: (t) =>
          t === 0
            ? { gap: gapId, toolId: 'demo.thread', input: {} }
            : t === 1
              ? { gap: ROOT, toolId: 'watch.set', input: { kind: 'timer', label: 'look around for gaps', minutesFromNow: 30 } }
              : SLEEP,
      },
      { maxTurns: 4 },
    );
    try {
      await s.core.registry.registerInline(
        { id: 'demo.thread', version: 1, description: 'Starts a coding thread', whenToUse: ['demo thread'], effect: 'write', requiresApproval: false, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        async () => ({ ok: true, summary: 'started', changes: ['started'], asyncWork: { kind: 't3_thread', threadId: 'thread_outline', label: 'demo work' } }),
      );
      gapId = (await ownerGap(s.core, 'Delegated work')).id;
      const res = await s.core.processEvent(owner('Get a coding agent on it.'));
      const w = (await s.core.watches.active()).find((x) => x.kind === 't3_thread');
      return { passed: w?.gapId === gapId && res.wake?.slept === true, detail: w ? `thread watch tied to ${w.gapId}; slept: ${res.wake?.slept}` : 'no watch on the started thread' };
    } finally {
      await s.cleanup();
    }
  });

  await run(10, 'Sleep is refused while a gap has no next move', async () => {
    let gapId = '';
    const s = await scratch(
      {
        decide: (t) =>
          t === 0
            ? SLEEP
            : t === 1
              ? { gap: gapId, toolId: 'watch.set', input: { kind: 'timer', label: 'chase the owner', minutesFromNow: 5, gapId } }
              : t === 2
                ? { gap: ROOT, toolId: 'watch.set', input: { kind: 'timer', label: 'look around for gaps', minutesFromNow: 30, gapId: ROOT } }
                : SLEEP,
      },
      { maxTurns: 6 },
    );
    try {
      gapId = (await ownerGap(s.core, 'Needs a move')).id;
      const res = await s.core.processEvent(owner('Do the thing.'));
      const first = trace(res)[0];
      const passed = !ok(first) && res.wake?.slept === true;
      return { passed, detail: `first sleep: ${first?.receipt.status}; slept after scheduling: ${res.wake?.slept}` };
    } finally {
      await s.cleanup();
    }
  });

  await run(10, 'A wake that ends without sleep leaves every gap a next move', async () => {
    let gapId = '';
    const s = await scratch({ decide: () => ({ gap: gapId, toolId: 'memory.search', input: { query: 'anything' } }) }, { maxTurns: 2 });
    try {
      gapId = (await ownerGap(s.core, 'Cut off mid-wake')).id;
      await s.core.processEvent(owner('Do the thing.'));
      const active = await s.core.watches.active();
      const covered = [gapId, ROOT].filter((id) => active.some((w) => servesGap(w, id)));
      return { passed: covered.length === 2, detail: `${covered.length}/2 gaps (incl. root) got a scheduled return` };
    } finally {
      await s.cleanup();
    }
  });

  await run(10, 'Scheduling ties itself to the gap the move serves', async () => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t === 0 ? { gap: gapId, toolId: 'watch.set', input: { kind: 'timer', label: 'TIE_MARKER', minutesFromNow: 5 } } : SLEEP) }, { maxTurns: 3 });
    try {
      gapId = (await ownerGap(s.core, 'Tie me')).id;
      await s.core.processEvent(owner('Remind me.'));
      const w = (await s.core.watches.list()).find((x) => x.label === 'TIE_MARKER');
      return { passed: w?.gapId === gapId, detail: w ? `watch tied to ${w.gapId ?? 'nothing'}` : 'no watch was set' };
    } finally {
      await s.cleanup();
    }
  });

  await run(10, "Unreadable model output doesn't end the wake", async () => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t === 0 ? 'not json at all' : t === 1 ? { gap: gapId, toolId: 'demo.write', input: {} } : SLEEP) }, { maxTurns: 4 });
    try {
      gapId = (await ownerGap(s.core, 'Keep going')).id;
      await s.core.processEvent(owner('Do the thing.'));
      return { passed: s.writes() === 1, detail: s.writes() === 1 ? 'kept working after a garbled turn' : 'garbled turn ended the wake' };
    } finally {
      await s.cleanup();
    }
  });

  await run(10, 'A wake that crashes still leaves every gap a next move', async () => {
    let gapId = '';
    const s = await scratch({
      decide: () => {
        throw new Error('model timed out');
      },
    });
    try {
      gapId = (await ownerGap(s.core, 'Crash gap')).id;
      const err = await s.core.processEvent(owner('Do the thing.')).then(() => undefined, (e: Error) => e.message);
      const active = await s.core.watches.active();
      const covered = [gapId, ROOT].filter((id) => active.some((w) => servesGap(w, id)));
      return { passed: covered.length === 2, detail: `wake ${err ? `threw (${err})` : 'did not throw'}; ${covered.length}/2 gaps got a scheduled return` };
    } finally {
      await s.cleanup();
    }
  });

  await run(10, 'A timer that can never fire is refused', async () => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t === 0 ? { gap: gapId, toolId: 'watch.set', input: { kind: 'timer', label: 'BAD_TIME_MARKER', fireAt: 'tomorrow 9am' } } : SLEEP) }, { maxTurns: 2 });
    try {
      gapId = (await ownerGap(s.core, 'Bad timer')).id;
      const res = await s.core.processEvent(owner('Remind me.'));
      const w = (await s.core.watches.list()).find((x) => x.label === 'BAD_TIME_MARKER');
      return { passed: !w && !ok(trace(res)[0]), detail: w ? `stored an unfireable watch (fireAt=${w.fireAt})` : `refused: ${clip(trace(res)[0]?.receipt.summary)}` };
    } finally {
      await s.cleanup();
    }
  });

  await run(10, 'One quick return covers every stranded gap and says why the wake ended', async () => {
    let gapId = '';
    const s = await scratch({ decide: () => ({ gap: gapId, toolId: 'memory.search', input: { query: 'anything' } }) }, { maxTurns: 2 });
    try {
      gapId = (await ownerGap(s.core, 'Cut off again')).id;
      await s.core.processEvent(owner('Do the thing.'));
      const resumes = (await s.core.watches.active()).filter((w) => w.label.startsWith('Resume'));
      const w = resumes[0];
      const both = !!w && servesGap(w, gapId) && servesGap(w, ROOT);
      const why = !!w && w.label.includes('turn cap') && w.label.includes('memory.search');
      return { passed: resumes.length === 1 && both && why, detail: `${resumes.length} quick return(s); covers both: ${both}; says why: ${why}` };
    } finally {
      await s.cleanup();
    }
  });

  await run(10, "Closing or dropping a gap retires its watches", async () => {
    let gapId = '';
    const s = await scratch({ decide: (t) => (t === 0 ? { gap: gapId, toolId: 'gaps.update', input: { status: 'dropped' } } : SLEEP) }, { maxTurns: 2 });
    try {
      gapId = (await ownerGap(s.core, 'Not wanted anymore')).id;
      await s.core.watches.add({ kind: 'timer', label: 'chase it', gapId, fireAt: '2099-01-01T00:00:00Z' }, NOW);
      await s.core.processEvent(owner("I don't want that anymore."));
      const left = (await s.core.watches.active()).filter((w) => servesGap(w, gapId)).length;
      return { passed: left === 0, detail: `${left} watch(es) still armed for the dropped gap` };
    } finally {
      await s.cleanup();
    }
  });

  await run(10, 'Quick returns back off when a gap keeps coming back', async () => {
    let gapId = '';
    const s = await scratch({ decide: () => 'garbled' }, { maxTurns: 10 });
    try {
      gapId = (await ownerGap(s.core, 'Keeps failing')).id;
      // The quick return that fired covered both stranded gaps (the gap and the root), on its 3rd try.
      const fired = genericEvent({ source: 'watch', kind: 'timer_due', text: `Watch fired (watch_r / ${gapId}): Resume`, timestamp: NOW.toISOString(), metadata: { watchId: 'watch_r', gapId, gapIds: [gapId, ROOT], resumeAttempt: 3 } });
      const res = await s.core.processEvent(fired);
      const w = (await s.core.watches.active()).find((x) => servesGap(x, gapId));
      const mins = w?.fireAt ? Math.round((Date.parse(w.fireAt) - NOW.getTime()) / 60_000) : 0;
      return { passed: mins > 5 && (res.wake?.turns ?? 99) < 10, detail: `wake stopped after ${res.wake?.turns} garbled turn(s); next return in ${mins} min (attempt ${w?.resumeAttempt ?? '?'})` };
    } finally {
      await s.cleanup();
    }
  });

  // ---------------- 11. No gap special cases ----------------
  await run(11, 'No separate gap poller', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rufus-outline-'));
    try {
      const ids = (await buildDefaultConnectors(dir)).map((c) => c.id);
      return { passed: !ids.includes('gaps'), detail: `connectors: ${ids.join(', ')}` };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await run(11, 'No special bouncer rule for gaps', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rufus-outline-'));
    const b = new Bouncer({ workspaceDir: dir });
    try {
      const d = await b.decide(genericEvent({ source: 'gap', kind: 'empty_board', text: 'Gap Board is empty' }));
      return { passed: d.backend !== 'rule', detail: `gap event -> ${d.label} via ${d.backend}${d.reason ? ` (${d.reason})` : ''}` };
    } finally {
      await b.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await run(11, 'No gap poller, cooldown or empty-board event left in the code', async () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const pattern = new RegExp(['gap' + 'Connector', 'empty' + '_board', 'open' + '_work', 'cooldown' + 'Ms'].join('|'));
    const hits: string[] = [];
    const walk = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'eval') await walk(p);
        } else if (e.name.endsWith('.ts')) {
          const lines = (await fs.readFile(p, 'utf8')).split('\n');
          lines.forEach((l, i) => {
            if (pattern.test(l)) hits.push(`${path.relative(srcDir, p)}:${i + 1}`);
          });
        }
      }
    };
    await walk(srcDir);
    return { passed: hits.length === 0, detail: hits.length ? `found in ${hits.slice(0, 6).join(', ')}${hits.length > 6 ? ` +${hits.length - 6}` : ''}` : 'none found' };
  });

  return results;
}
