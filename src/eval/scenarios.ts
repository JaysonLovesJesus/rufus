import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RufusCore, STARTUP_TEXT } from '../daemon';
import { genericEvent } from '../events/ingest';
import { servesGap } from '../events/watches';
import { isDone, type Gap } from '../gaps/store';
import type { LosslessEvent, MessageSink, ModelProvider } from '../types';

/**
 * Live replays: real owner messages from the event log, run through the real model and the real loop
 * against a COPY of the workspace as it was at `seedUntil`. Nothing reaches the owner: messages go to a capture sink,
 * and every write tool from the script library is set to `rehearse`.
 *
 * Scenarios live in `<workspace>/eval/scenarios/*.json` (private data, never in the repo).
 */
export interface Scenario {
  id: string;
  description: string;
  /** Copy events, wakes and drafts from before this moment. */
  seedUntil: string;
  /** Gap board to start from (the root is added automatically). */
  gaps?: Gap[];
  /** Owner messages by event id from the real log, or a restart. */
  steps: Array<{ eventId?: string; startup?: boolean; at?: string }>;
  /** Extra tool ids or prefixes (ending in '.') that read live feeds and must be cut off in this replay. */
  liveFeeds?: string[];
  /** Keep playing Rufus's own timers after the last step until this moment (they fire in order, like the real clock). */
  runUntil?: string;
  expect: {
    /** Rubric for a fresh judge model, written from the owner's point of view. */
    judge?: string;
    /** These gap ids must not be closed at the end. */
    gapsOpen?: string[];
    /** Every unclosed gap, root included, must have a scheduled next move at the end. */
    everyGapHasNextMove?: boolean;
  };
}

export interface ScenarioResult {
  id: string;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  sent: string[];
  moves: string[];
  gaps: Array<Pick<Gap, 'id' | 'title' | 'status' | 'target'>>;
  durationMs: number;
}

/** Built-ins that only write inside the scratch workspace or to the capture sink. */
const REPLAY_SAFE = new Set([
  'send_message',
  'edit_message',
  'react_message',
  'gaps.create',
  'gaps.update',
  'gaps.approve',
  'watch.set',
  'brain.investigate',
  'brain.plan',
  'brain.create',
  'brain.verify',
  'memory.search',
  'approvals.approve',
  'approvals.deny',
  'sleep',
  'system.startup_snapshot',
  'tools.list_all',
]);

/**
 * Read tools that show the world as it is NOW, not as it was at `seedUntil`. In a replay they would leak the
 * future (the owner's later messages, Rufus's later replies), so they answer "not available" instead.
 * Memory search still works: it reads the seeded event log, which stops at the right moment.
 */
const LIVE_FEEDS = [
  'beeper.',
  'gmail.',
  'instagram.',
  'browser.recent',
  'self.recent_activity',
  'morning.briefing',
  't3.thread',
  'calendar.today',
  'youtube.latest',
  'git.inspect',
  'mac.apps',
  'bwaf.snapshot',
  'deploy.',
  'business.earning_plan',
];

/** Any read that points at the live workspace (events, wakes, gaps as they are today) is a live feed too. */
const LIVE_PATHS = ['.rufus-v2', '.rufus/', `${os.homedir()}/.rufus`];

function isLiveFeed(toolId: string, input: Record<string, unknown>, extra: readonly string[]): boolean {
  if ([...LIVE_FEEDS, ...extra].some((p) => (p.endsWith('.') ? toolId.startsWith(p) : toolId === p))) return true;
  const text = JSON.stringify(input ?? {});
  return LIVE_PATHS.some((p) => text.includes(p));
}

/** The earliest timer watch due by `until` (marked fired), as the event the watch connector would emit. */
async function dueTimers(core: RufusCore, until: number): Promise<LosslessEvent[]> {
  const due = (await core.watches.active())
    .filter((w) => w.kind === 'timer' && w.fireAt && Date.parse(w.fireAt) <= until)
    .sort((a, b) => Date.parse(a.fireAt!) - Date.parse(b.fireAt!));
  const out: LosslessEvent[] = [];
  for (const w of due.slice(0, 1)) {
    await core.watches.markFired(w.id);
    out.push(
      genericEvent({
        id: `watch_fired_${w.id}`,
        source: 'watch',
        kind: 'timer_due',
        text: `Watch fired (${w.id}${w.gapId ? ` / ${w.gapId}` : ''}): ${w.label}`,
        timestamp: w.fireAt!,
        metadata: { watchId: w.id, ...(w.gapId ? { gapId: w.gapId } : {}), ...(w.resumeAttempt ? { resumeAttempt: w.resumeAttempt } : {}) },
      }),
    );
  }
  return out;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

async function copyIfExists(from: string, to: string): Promise<void> {
  // Dereference: `projects` is a symlink in the live workspace, and a copied link would read today's files.
  await fs.cp(from, to, { recursive: true, dereference: true }).catch(() => undefined);
}

export async function loadScenarios(workspaceDir: string): Promise<Scenario[]> {
  const dir = path.join(workspaceDir, 'eval', 'scenarios');
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  const out: Scenario[] = [];
  for (const f of files) {
    let s: Scenario;
    try {
      s = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as Scenario;
    } catch (err) {
      throw new Error(`Scenario ${path.join(dir, f)} is not valid JSON: ${(err as Error).message}`);
    }
    if (!s.id || !Array.isArray(s.steps) || !s.expect) throw new Error(`Scenario ${path.join(dir, f)} needs "id", "steps" and "expect"`);
    out.push(s);
  }
  return out;
}

async function seedWorkspace(liveDir: string, scenario: Scenario): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `rufus-replay-${scenario.id}-`));
  const cutoff = Date.parse(scenario.seedUntil);
  for (const name of ['skills', 'tools', 'projects', 'VOICE.md', 'trust.json', 'permissions.json', 'events.vectors.jsonl', 'TODOS.md']) {
    await copyIfExists(path.join(liveDir, name), path.join(dir, name));
  }
  const events = (await readJsonl<LosslessEvent>(path.join(liveDir, 'events.jsonl'))).filter((e) => Date.parse(e.timestamp) < cutoff);
  await fs.writeFile(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const wakes = (await readJsonl<{ at: string }>(path.join(liveDir, 'wakes.jsonl'))).filter((w) => Date.parse(w.at) < cutoff);
  await fs.writeFile(path.join(dir, 'wakes.jsonl'), wakes.map((w) => JSON.stringify(w)).join('\n') + (wakes.length ? '\n' : ''), 'utf8');
  await fs.mkdir(path.join(dir, 'drafts'), { recursive: true });
  for (const f of await fs.readdir(path.join(liveDir, 'drafts')).catch(() => [])) {
    const st = await fs.stat(path.join(liveDir, 'drafts', f));
    if (st.isFile() && st.mtimeMs < cutoff) await fs.copyFile(path.join(liveDir, 'drafts', f), path.join(dir, 'drafts', f));
  }
  await fs.writeFile(path.join(dir, 'gaps.json'), `${JSON.stringify(scenario.gaps ?? [], null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(dir, 'watches.json'), '[]\n', 'utf8');
  await fs.writeFile(path.join(dir, 'approvals.json'), '[]\n', 'utf8');
  return dir;
}

export async function runScenario(opts: {
  workspaceDir: string;
  scenario: Scenario;
  reasoningProvider: ModelProvider;
  speakerProvider: ModelProvider;
  judgeProvider: ModelProvider;
  pythonPath?: string;
  log?: (line: string) => void;
}): Promise<ScenarioResult> {
  const started = Date.now();
  const { scenario } = opts;
  const log = opts.log ?? (() => undefined);
  const dir = await seedWorkspace(opts.workspaceDir, scenario);
  const allEvents = await readJsonl<LosslessEvent>(path.join(opts.workspaceDir, 'events.jsonl'));

  const sent: string[] = [];
  const sink: MessageSink = {
    send: async (text) => {
      sent.push(text);
      log(`  [Rufus -> owner] ${text.replace(/\n/g, ' / ')}`);
      return { messageId: `replay_${sent.length}` };
    },
    edit: async (_id, text) => {
      sent.push(`(edited) ${text}`);
    },
    react: async (_id, emoji) => {
      sent.push(`(reacted ${emoji ?? 'none'})`);
    },
  };

  let clockAt = Date.parse(scenario.seedUntil);
  let clockReal = Date.now();
  const core = new RufusCore({
    workspaceDir: dir,
    reasoningProvider: opts.reasoningProvider,
    speakerProvider: opts.speakerProvider,
    sink,
    ...(opts.pythonPath ? { pythonPath: opts.pythonPath } : {}),
    now: () => new Date(clockAt + (Date.now() - clockReal)),
  });
  const moves: string[] = [];
  const ownerTexts: string[] = [];
  try {
    await core.init();
    // Nothing may act on the real world during a replay: every tool that isn't read-only is rehearsed,
    // except built-ins that only touch this scratch copy or the capture sink. (tools.create/repair run generated code, so they're rehearsed.)
    for (const t of core.registry.list()) {
      if (t.effect !== 'read' && !REPLAY_SAFE.has(t.id) && (await core.approvals.levelFor(t)) !== 'never') await core.approvals.setLevel(t.id, 'rehearse');
    }
    // Every caller (Decide, investigate, verify) goes through this one registry, so cutting live feeds here covers them all.
    const realCall = core.registry.call.bind(core.registry);
    core.registry.call = async (toolId, input, callOpts) => {
      if (!isLiveFeed(toolId, input, scenario.liveFeeds ?? [])) return realCall(toolId, input, callOpts);
      return {
        toolId,
        effect: 'read',
        status: 'failed',
        durationMs: 0,
        summary: `${toolId} is not available right now. Use memory.search: every message and event up to now is in memory.`,
        changes: [],
        error: 'live feed cut off in replay',
        at: callOpts.now.toISOString(),
      };
    };

    const simNow = () => clockAt + (Date.now() - clockReal);
    const play = async (ev: LosslessEvent, atMs: number) => {
      // The clock never runs backwards: a wake that ran long has already moved "now" past this moment.
      clockAt = Math.max(atMs, simNow());
      clockReal = Date.now();
      if (ev.source === 'watch') log(`  [timer] ${ev.text.slice(0, 160)}`);
      const res = await core.processEvent(ev);
      for (const t of res.wake?.trace ?? []) {
        const line = `${t.gapId ? `[${t.gapId}] ` : ''}${t.toolId} -> ${t.receipt.status}: ${t.receipt.summary.slice(0, 160)}`;
        moves.push(line);
        log(`    ${line}`);
      }
    };
    // Rufus's own timers fire between the owner's messages, just as they would have that night.
    const MAX_TIMER_WAKES = 12;
    let timerWakes = 0;
    const playTimersUntil = async (until: number) => {
      while (timerWakes < MAX_TIMER_WAKES) {
        const [next] = await dueTimers(core, until);
        if (!next) return;
        timerWakes += 1;
        await play(next, Date.parse(next.timestamp));
      }
    };

    for (const step of scenario.steps) {
      let ev: LosslessEvent;
      const atMs = step.at ? Date.parse(step.at) : step.startup ? simNow() : Date.parse(allEvents.find((e) => e.id === step.eventId)?.timestamp ?? '') || simNow();
      await playTimersUntil(atMs);
      if (step.startup) {
        ev = genericEvent({
          source: 'system',
          kind: 'startup',
          text: STARTUP_TEXT,
          timestamp: new Date(atMs).toISOString(),
        });
      } else {
        const real = allEvents.find((e) => e.id === step.eventId);
        if (!real) throw new Error(`scenario ${scenario.id}: event ${step.eventId} not found in the log`);
        ev = { ...real, kind: 'owner_direct' };
        ownerTexts.push(real.text);
        log(`  [owner] ${real.text}`);
      }
      await play(ev, atMs + 1000);
    }
    if (scenario.runUntil) await playTimersUntil(Date.parse(scenario.runUntil));

    const gaps = await core.gaps.list();
    const active = await core.watches.active();
    const checks: ScenarioResult['checks'] = [];
    for (const id of scenario.expect.gapsOpen ?? []) {
      const g = gaps.find((x) => x.id === id);
      checks.push({ name: `Gap ${id} is still open`, passed: !!g && !isDone(g), detail: g ? `[${g.status}] ${g.title}` : 'missing' });
    }
    if (scenario.expect.everyGapHasNextMove) {
      const stranded = gaps.filter((g) => !isDone(g) && !active.some((w) => servesGap(w, g.id)));
      checks.push({
        name: 'Every unclosed gap has a next move',
        passed: stranded.length === 0,
        detail: stranded.length ? `no next move: ${stranded.map((g) => g.id).join(', ')}` : `${gaps.filter((g) => !isDone(g)).length} gap(s) covered`,
      });
    }
    if (scenario.expect.judge) {
      const verdict = await judge(opts.judgeProvider, scenario.expect.judge, ownerTexts, sent, gaps, moves);
      checks.push({ name: "Judged from the owner's side", passed: verdict.passed, detail: verdict.reasons });
    }
    return {
      id: scenario.id,
      passed: checks.every((c) => c.passed),
      checks,
      sent,
      moves,
      gaps: gaps.map((g) => ({ id: g.id, title: g.title, status: g.status, target: g.target })),
      durationMs: Date.now() - started,
    };
  } finally {
    await core.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function judge(
  provider: ModelProvider,
  rubric: string,
  ownerTexts: string[],
  sent: string[],
  gaps: Gap[],
  moves: string[],
): Promise<{ passed: boolean; reasons: string }> {
  const system = [
    "You judge whether an AI chief of staff actually gave its owner what the owner wanted. Judge from the owner's side, strictly, using only the transcript.",
    'Reply with ONLY JSON: {"passed": true|false, "reasons": "2-4 short sentences citing what was or was not sent"}',
  ].join('\n');
  const prompt = [
    `Rubric:\n${rubric}`,
    `Owner messages, in order:\n${ownerTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
    `Messages Rufus sent the owner, in order:\n${sent.length ? sent.map((t, i) => `${i + 1}. ${t}`).join('\n\n') : '(none)'}`,
    `Gap tree at the end:\n${gaps.map((g) => `- [${g.id} | ${g.status}] ${g.title} — target: ${g.target}`).join('\n')}`,
    `Rufus's moves:\n${moves.join('\n')}`,
  ].join('\n\n');
  const raw = await provider.complete({ system, prompt });
  try {
    const m = /\{[\s\S]*\}/.exec(raw);
    const parsed = JSON.parse(m?.[0] ?? raw) as { passed?: boolean; reasons?: string };
    return { passed: parsed.passed === true, reasons: String(parsed.reasons ?? '').trim() || '(no reasons)' };
  } catch {
    return { passed: false, reasons: `judge reply unreadable: ${raw.slice(0, 200)}` };
  }
}
