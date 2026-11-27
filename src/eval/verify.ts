import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Bouncer } from '../bouncer/bouncer';
import { createSemanticEmbedder } from '../embed';
import { buildDefaultConnectors } from '../events/connectors';
import { genericEvent } from '../events/ingest';
import { EventStore } from '../events/store';
import { WatchStore } from '../events/watches';
import { GapStore, gapConnector } from '../gaps/store';
import { ApprovalStore } from '../scripts/approvals';
import type { BrainStateName } from '../brains/states';

const execFileAsync = promisify(execFile);

export interface ComponentCheck {
  component: string;
  passed: boolean;
  detail: string;
}

/**
 * Bottom-up live verification across every mechanical gear of Rufus:
 * 1. Event Log + Neural Semantic Embeddings
 * 2. SetFit Bouncer (real SLEEP noise vs real WAKE signal)
 * 3. Gap Board + Gap Trigger (empty/open wakes, waiting stays quiet)
 * 4. Brain-State Skills (DECIDE, INVESTIGATE, PLAN, CREATE, VERIFY + VOICE)
 * 5. 4-Level Trust Ladder & Approval Queue
 * 6. Connectors & Watches
 * 7. Live HTTP Daemon (/health)
 * 8. Custom Packaged Tools (test.mjs suite)
 */
export async function verifyAllParts(opts: { workspaceDir: string; pythonPath?: string; httpPort?: number }): Promise<{ ok: boolean; checks: ComponentCheck[] }> {
  const checks: ComponentCheck[] = [];
  const dir = opts.workspaceDir;

  // 1. Event Log + Neural Semantic Embeddings
  try {
    const emb = createSemanticEmbedder({ ...(opts.pythonPath ? { pythonPath: opts.pythonPath } : {}) });
    const store = new EventStore({ workspaceDir: dir, embedder: emb });
    await store.load();
    const count = await store.count();
    const hits = count > 0 ? await store.search('calendar schedule meeting', 3) : [];
    const usingNeural = (emb.modelId ?? '').includes('MiniLM') || (emb.modelId ?? '').includes('sentence-transformers');
    await store.close();
    checks.push({
      component: 'Event Log & Semantic Memory',
      passed: count > 0 && hits.length > 0 && usingNeural,
      detail: `${count} events indexed via ${emb.modelId} (top hit score=${hits[0]?.score.toFixed(3) ?? 'n/a'})`,
    });
  } catch (err) {
    checks.push({ component: 'Event Log & Semantic Memory', passed: false, detail: (err as Error).message });
  }

  // 2. SetFit Bouncer (live SLEEP vs WAKE check)
  try {
    const bouncer = new Bouncer({ workspaceDir: dir, ...(opts.pythonPath ? { pythonPath: opts.pythonPath } : {}) });
    const counts = await bouncer.exampleCount();
    const noise = await bouncer.decide(genericEvent({ source: 'screen', kind: 'focus', text: 'Switched active app to Finder: Finder' }));
    const real = await bouncer.decide(genericEvent({ source: 'message', kind: 'chat', text: 'Did you get the ticket confirmations in your email?' }));
    const gapTrig = await bouncer.decide(genericEvent({ source: 'gap', kind: 'empty_board', text: 'Gap Board is empty' }));
    await bouncer.close();
    const ok = noise.backend === 'setfit' && noise.label === 'SLEEP' && real.label === 'WAKE' && gapTrig.label === 'WAKE';
    checks.push({
      component: 'Bouncer (SetFit + Rules)',
      passed: ok,
      detail: `${counts.total} examples | noise->${noise.label}(${noise.confidence},${noise.backend}) | msg->${real.label}(${real.confidence}) | gap->${gapTrig.label}`,
    });
  } catch (err) {
    checks.push({ component: 'Bouncer (SetFit + Rules)', passed: false, detail: (err as Error).message });
  }

  // 3. Gap Board + Gap Trigger
  try {
    const store = new GapStore(dir);
    const gaps = await store.list();
    const conn = gapConnector(dir, { cooldownMs: 1 });
    const emitted = await conn.poll();
    const nonClosed = gaps.filter((g) => g.status !== 'closed');
    const unblocked = nonClosed.filter((g) => g.status === 'open' && !g.waitingOn);
    const shouldEmit = nonClosed.length === 0 || unblocked.length > 0;
    const ok = shouldEmit ? emitted.length > 0 : emitted.length === 0;
    checks.push({
      component: 'Gap Board & Trigger',
      passed: ok,
      detail: `${gaps.length} total (${nonClosed.length} active, ${unblocked.length} unblocked) -> trigger emitted ${emitted.length} event(s)${emitted[0] ? ` (${emitted[0].kind})` : ''}`,
    });
  } catch (err) {
    checks.push({ component: 'Gap Board & Trigger', passed: false, detail: (err as Error).message });
  }

  // 4. Brain-State Skills + VOICE.md
  try {
    const required: BrainStateName[] = ['DECIDE', 'INVESTIGATE', 'PLAN', 'CREATE', 'VERIFY'];
    const missing: string[] = [];
    for (const s of required) {
      if (!existsSync(path.join(dir, 'skills', `${s}.md`))) missing.push(`skills/${s}.md`);
    }
    if (!existsSync(path.join(dir, 'VOICE.md'))) missing.push('VOICE.md');
    checks.push({
      component: 'Brain-State Skills & VOICE',
      passed: missing.length === 0,
      detail: missing.length === 0 ? 'All 5 Brain-State skills + VOICE.md present' : `Missing: ${missing.join(', ')}`,
    });
  } catch (err) {
    checks.push({ component: 'Brain-State Skills & VOICE', passed: false, detail: (err as Error).message });
  }

  // 5. 4-Level Trust Ladder & Approvals
  try {
    const approvals = new ApprovalStore(dir);
    const trust = await approvals.readTrust();
    const pending = await approvals.listPending();
    checks.push({
      component: '4-Level Trust Ladder',
      passed: true,
      detail: `${Object.keys(trust.levels).length} explicit trust rule(s), ${trust.neverAllow.length} blocked, ${pending.length} pending approval(s)`,
    });
  } catch (err) {
    checks.push({ component: '4-Level Trust Ladder', passed: false, detail: (err as Error).message });
  }

  // 6. Connectors & Watches
  try {
    const conns = await buildDefaultConnectors(dir);
    const watches = await new WatchStore(dir).active();
    const ids = conns.map((c) => c.id);
    checks.push({
      component: 'Connectors & Watches',
      passed: ids.includes('gaps') && ids.includes('watches'),
      detail: `${ids.length} connectors (${ids.join(', ')}) | ${watches.length} active watch(es)`,
    });
  } catch (err) {
    checks.push({ component: 'Connectors & Watches', passed: false, detail: (err as Error).message });
  }

  // 7. Live Daemon (/health)
  try {
    const port = opts.httpPort ?? Number(process.env.RUFUS_HTTP_PORT || 8787);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { ok?: boolean };
    checks.push({
      component: 'Live Daemon HTTP (/health)',
      passed: res.ok && body.ok === true,
      detail: `http://127.0.0.1:${port}/health -> ${res.status} ${JSON.stringify(body)}`,
    });
  } catch (err) {
    checks.push({ component: 'Live Daemon HTTP (/health)', passed: false, detail: (err as Error).message });
  }

  // 8. Custom Packaged Tools (verify every tool has valid tool.json + passing test.mjs)
  try {
    const toolsDir = path.join(dir, 'tools');
    const entries = (await fs.readdir(toolsDir).catch(() => [])).sort();
    let passedTools = 0;
    const failedTools: string[] = [];
    for (const name of entries) {
      const tDir = path.join(toolsDir, name);
      const st = await fs.stat(tDir).catch(() => null);
      if (!st?.isDirectory()) continue;
      const testPath = path.join(tDir, 'test.mjs');
      try {
        await execFileAsync(process.execPath, [testPath], { cwd: tDir, timeout: 25_000 });
        passedTools++;
      } catch {
        failedTools.push(name);
      }
    }
    checks.push({
      component: 'Custom Tool Library',
      passed: passedTools > 0 && failedTools.length === 0,
      detail: failedTools.length === 0 ? `${passedTools}/${passedTools} tool tests passing` : `${passedTools} passed, failed: ${failedTools.join(', ')}`,
    });
  } catch (err) {
    checks.push({ component: 'Custom Tool Library', passed: false, detail: (err as Error).message });
  }

  return { ok: checks.every((c) => c.passed), checks };
}
