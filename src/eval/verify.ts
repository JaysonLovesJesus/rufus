import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Bouncer } from '../bouncer/bouncer';
import { createSemanticEmbedder } from '../embed';
import { buildDefaultConnectors } from '../events/connectors';
import { assessSenses, readSensesFile } from '../events/health';
import { genericEvent } from '../events/ingest';
import { EventStore, provenanceOf, supersededBy } from '../events/store';
import { WatchStore, servesGap } from '../events/watches';
import { GapStore } from '../gaps/store';
import type { BrainStateName } from '../brains/states';
import { OUTLINE_ITEMS, runOutlineChecks } from './outline';

const execFileAsync = promisify(execFile);

export interface ComponentCheck {
  /** Outline item (docs/OUTLINE.md) this check measures. */
  item: number;
  component: string;
  passed: boolean;
  detail: string;
  /** `live` = checked against the real workspace / running daemon; `loop` = the real wake loop driven in a scratch workspace. */
  where: 'live' | 'loop';
}

export { OUTLINE_ITEMS };

/**
 * Measures Rufus against docs/OUTLINE.md:
 * - `loop` checks drive the real wake loop in a scratch workspace (src/eval/outline.ts).
 * - `live` checks look at the real workspace and the running daemon.
 */
export async function verifyAllParts(opts: { workspaceDir: string; pythonPath?: string; httpPort?: number }): Promise<{ ok: boolean; checks: ComponentCheck[] }> {
  const checks: ComponentCheck[] = [];
  const dir = opts.workspaceDir;
  const live = async (item: number, component: string, fn: () => Promise<{ passed: boolean; detail: string }>) => {
    try {
      checks.push({ item, component, where: 'live', ...(await fn()) });
    } catch (err) {
      checks.push({ item, component, where: 'live', passed: false, detail: (err as Error).message });
    }
  };

  // 1. Senses
  await live(1, 'Pollers for every sense are wired', async () => {
    const ids = (await buildDefaultConnectors(dir)).map((c) => c.id);
    // Every poller OUTLINE item 1 names (Telegram polls through its channel in `rufus start`, checked by /health).
    const want = ['beeper', 'gmail', 'calendar', 'active-app', 'browser-history', 'downloads', 'watches'];
    const missing = want.filter((id) => !ids.includes(id));
    return { passed: missing.length === 0, detail: `${ids.join(', ')}${missing.length ? ` | missing: ${missing.join(', ')}` : ''}` };
  });
  await live(1, 'Every sense produced real output in the last 24h', async () => {
    const ids = (await buildDefaultConnectors(dir)).map((c) => c.id);
    return assessSenses(await readSensesFile(dir), ids);
  });
  await live(1, 'Daemon is running (/health)', async () => {
    const port = opts.httpPort ?? Number(process.env.RUFUS_HTTP_PORT || 8787);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { ok?: boolean };
    return { passed: res.ok && body.ok === true, detail: `${res.status} ${JSON.stringify(body)}` };
  });

  // 2. Memory
  await live(2, 'One event log with meaning-based search', async () => {
    const emb = createSemanticEmbedder({ ...(opts.pythonPath ? { pythonPath: opts.pythonPath } : {}) });
    const store = new EventStore({ workspaceDir: dir, embedder: emb });
    await store.load();
    const count = await store.count();
    const hits = count > 0 ? await store.search('calendar schedule meeting', 3) : [];
    // Any sidecar model counts; only the hash fallback is not meaning-based.
    const neural = !!emb.modelId && !emb.modelId.startsWith('hash-');
    const all = await store.recent(100_000);
    const own = all.filter((e) => provenanceOf(e) === 'rufus_claimed').length;
    const owner = all.filter((e) => provenanceOf(e) === 'owner_said').length;
    const superseded = all.filter((e) => supersededBy(e)).length;
    await store.close();
    return {
      passed: count > 0 && hits.length > 0 && neural && own > 0,
      detail: `${count} events via ${emb.modelId}: ${count - own - owner} observed, ${owner} owner-said, ${own} Rufus-claimed (${superseded} superseded)`,
    };
  });

  // 3. Bouncer
  await live(3, 'Local classifier sleeps on noise, wakes on real messages', async () => {
    const bouncer = new Bouncer({ workspaceDir: dir, ...(opts.pythonPath ? { pythonPath: opts.pythonPath } : {}) });
    try {
      const noise = await bouncer.decide(genericEvent({ source: 'screen', kind: 'focus', text: 'Switched active app to Finder: Finder' }));
      const real = await bouncer.decide(genericEvent({ source: 'message', kind: 'chat', text: 'Did you get the ticket confirmations in your email?' }));
      return {
        passed: noise.backend === 'setfit' && noise.label === 'SLEEP' && real.label === 'WAKE',
        detail: `noise->${noise.label} (${noise.backend}, ${noise.durationMs}ms) | message->${real.label} (${real.durationMs}ms)`,
      };
    } finally {
      await bouncer.close();
    }
  });

  await live(3, "Live model's held-out WAKE recall, and the last retrain didn't lower it", async () => {
    const bouncer = new Bouncer({ workspaceDir: dir, ...(opts.pythonPath ? { pythonPath: opts.pythonPath } : {}) });
    const { heldOut } = await bouncer.preparedSet();
    const now = await bouncer.evaluate(bouncer.modelDir, heldOut);
    const last = await Bouncer.readMetrics(dir);
    // The last promotion, if any, must not have lowered WAKE recall.
    const lastOk = !last || !last.promoted || !last.current || last.candidate.wake === 0 || (last.candidate.recall ?? 0) >= (last.current.recall ?? 0);
    return {
      passed: now.n > 0 && now.wake > 0 && lastOk,
      detail:
        `live model on ${now.n} held-out label(s), ${now.wake} WAKE: precision ${now.precision ?? '-'}, recall ${now.recall ?? '-'}` +
        (last ? ` | last retrain ${last.at.slice(0, 16)}: ${last.promoted ? 'promoted' : 'kept previous'} (${last.reason})` : ' | not retrained since the guard (this model may have trained on these labels)'),
    };
  });

  // 4. Gaps (live board)
  await live(4, 'Live board has the root gap', async () => {
    // Read the file itself: GapStore.list() would add a missing root in memory.
    const raw = await fs.readFile(path.join(dir, 'gaps.json'), 'utf8').catch(() => '[]');
    const gaps = JSON.parse(raw) as Array<{ id: string; title: string; status: string }>;
    const root = gaps.find((g) => g.id === 'gap_root');
    return { passed: !!root && root.status !== 'closed', detail: root ? `"${root.title}" [${root.status}], ${gaps.length - 1} other gap(s)` : `no root gap (${gaps.length} gap(s) on board)` };
  });

  // 9. Tools
  await live(9, 'Brain skills and VOICE.md present', async () => {
    const required: BrainStateName[] = ['DECIDE', 'INVESTIGATE', 'PLAN', 'CREATE', 'VERIFY'];
    const missing = required.filter((s) => !existsSync(path.join(dir, 'skills', `${s}.md`))).map((s) => `skills/${s}.md`);
    if (!existsSync(path.join(dir, 'VOICE.md'))) missing.push('VOICE.md');
    return { passed: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : 'all present' };
  });
  await live(9, 'Script library passes its own tests', async () => {
    const toolsDir = path.join(dir, 'tools');
    const entries = (await fs.readdir(toolsDir).catch(() => [])).sort();
    let passed = 0;
    const failed: string[] = [];
    for (const name of entries) {
      const tDir = path.join(toolsDir, name);
      if (!(await fs.stat(tDir).catch(() => null))?.isDirectory()) continue;
      try {
        await execFileAsync(process.execPath, [path.join(tDir, 'test.mjs')], { cwd: tDir, timeout: 25_000 });
        passed++;
      } catch {
        failed.push(name);
      }
    }
    return { passed: passed > 0 && failed.length === 0, detail: failed.length ? `${passed} passed, failed: ${failed.join(', ')}` : `${passed}/${passed} passing` };
  });
  await live(9, 'Toolset health: turns per wake and tool reliability', async () => {
    const raw = await fs.readFile(path.join(dir, 'wakes.jsonl'), 'utf8').catch(() => '');
    const wakes = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-200)
      .map((l) => {
        try {
          return JSON.parse(l) as { turns?: number; trace?: Array<{ toolId?: string; receipt?: { status?: string } }> };
        } catch {
          return null;
        }
      })
      .filter((w): w is NonNullable<typeof w> => !!w);
    const turns = wakes.map((w) => w.turns ?? w.trace?.length ?? 0).sort((a, b) => a - b);
    const p50 = turns.length ? turns[Math.floor(turns.length * 0.5)]! : 0;
    const p90 = turns.length ? turns[Math.floor(turns.length * 0.9)]! : 0;
    const counts = new Map<string, { ok: number; total: number }>();
    const bigrams = new Map<string, number>();
    for (const w of wakes) {
      const seq = (w.trace ?? []).map((t) => t.toolId).filter((id): id is string => !!id && id !== 'sleep');
      for (const t of w.trace ?? []) {
        if (!t.toolId) continue;
        const c = counts.get(t.toolId) ?? { ok: 0, total: 0 };
        c.total++;
        if (t.receipt?.status === 'ok') c.ok++;
        counts.set(t.toolId, c);
      }
      for (let i = 0; i + 1 < seq.length; i++) {
        const k = `${seq[i]}->${seq[i + 1]}`;
        bigrams.set(k, (bigrams.get(k) ?? 0) + 1);
      }
    }
    const topChain = [...bigrams.entries()].sort((a, b) => b[1] - a[1])[0];
    const flaky = [...counts.entries()].filter(([, c]) => c.total >= 3 && c.ok / c.total < 0.6).map(([id, c]) => `${id}(${c.ok}/${c.total})`);
    return {
      passed: wakes.length > 0 && p50 <= 3 && p90 <= 6,
      detail: `last ${wakes.length} wakes: median ${p50} turn(s), p90 ${p90}${topChain ? ` | top chain: ${topChain[0]} (${topChain[1]}x)` : ''}${flaky.length ? ` | flaky: ${flaky.join(', ')}` : ''}`,
    };
  });

  // 10. Sleep (live invariant)
  await live(10, 'Every live gap has a next move in motion', async () => {
    const gaps = await new GapStore(dir).unclosed();
    const active = await new WatchStore(dir).active();
    const stranded = gaps.filter((g) => !active.some((w) => servesGap(w, g.id)));
    return {
      passed: gaps.length > 0 && stranded.length === 0,
      detail: gaps.length === 0 ? 'no unclosed gaps (not even a root)' : stranded.length ? `no next move: ${stranded.map((g) => `${g.id} "${g.title}"`).join(', ')}` : `${gaps.length}/${gaps.length} gaps have a scheduled move`,
    };
  });

  for (const c of await runOutlineChecks()) {
    checks.push({ item: c.item, component: c.name, passed: c.passed, detail: c.detail, where: 'loop' });
  }
  checks.sort((a, b) => a.item - b.item);
  return { ok: checks.every((c) => c.passed), checks };
}
