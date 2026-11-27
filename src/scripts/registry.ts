import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLocalEmbedder, topKBySimilarity, type Embedder, type Vector } from '../embed';
import { loadWakes } from '../eval/flight-recorder';
import type { ActionStep, Receipt, ScriptContext, ScriptOutput, ToolManifest, TrustLevel } from '../types';
import { effectDefault, stricterOf, type ApprovalStore } from './approvals';
import { markForReport, passGate, resolveLevel, type GateDecision } from './gate';
import { touchesTrustFiles } from './protected';
import { executeScript, explainError, MANIFEST_FILE, readToolLessons, readToolStats, RUN_FILE, TEST_FILE, validateInput, validateManifest } from './standard';
import { toolEnv } from './sandbox';
import { archiveToolVersion, carryToolHistory } from './versions';

const execFileAsync = promisify(execFile);

/** Under launchd a tool can start with a thin PATH; make sure the usual program dirs (git, node, t3) are on it. */
const STANDARD_BIN_DIRS = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
export function ensureToolPath(env: NodeJS.ProcessEnv = process.env): void {
  const have = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const missing = STANDARD_BIN_DIRS.filter((d) => !have.includes(d));
  if (missing.length) env.PATH = [...have, ...missing].join(path.delimiter);
}

/** How many of a tool's recent real calls a repair replays, and how long each replay may take. */
const REPLAY_LIMIT = 6;
const REPLAY_TIMEOUT_MS = 20_000;
/** Where the staged test's calls to run() are counted, so "has a passing test" means the test really ran the tool. */
const REAL_RUN_FILE = '.run.real.mjs';

/** What a tool just built or repaired starts at: draft (ask the owner) with a passing test of the tool itself, else rehearse. */
export function startLevelFor(evidence: { testRanTool: boolean; replayWorked: number }): TrustLevel {
  return evidence.testRanTool || evidence.replayWorked > 0 ? 'draft' : 'rehearse';
}

/**
 * A packaged tool's manifest is written by the model, so it can't vouch for its own trust: a declared default rung only
 * counts when it is stricter than its effect's, and engine-only fields (actions, internal) are dropped.
 */
export function packagedManifest(m: ToolManifest): ToolManifest {
  const { actions: _actions, internal: _internal, defaultTrust, ...rest } = m;
  const def = effectDefault(m);
  return { ...rest, ...(defaultTrust && stricterOf(defaultTrust, def) === defaultTrust && defaultTrust !== def ? { defaultTrust } : {}) };
}

export interface RegisteredTool {
  manifest: ToolManifest;
  toolDir?: string;
  handler?: (input: Record<string, unknown>, ctx: ScriptContext) => Promise<ScriptOutput> | ScriptOutput;
  vector: Vector;
  alwaysVisible?: boolean;
}

export interface CallOptions {
  workspaceDir: string;
  now: Date;
  approved?: boolean;
  /** The rung this call runs at (set by the gate), so a receipt that changed something at act_and_report is reported. */
  level?: TrustLevel;
  /** The owner approved this exact input: lets a write touch protected files (trust files, manifests, gate code). */
  ownerApproved?: boolean;
  env?: Record<string, string | undefined>;
  wakeId?: string;
  gapId?: string;
}

const TRUST_WORDS: Record<TrustLevel | 'never', string> = {
  never: 'blocked',
  rehearse: 'rehearses',
  draft: 'asks',
  act_and_report: 'runs, report it',
  act_quietly: 'runs',
};

/**
 * Manages built-in + disk-packaged scripts (`tools/<id>/`), embeds their descriptions and
 * `whenToUse` conditions for fast top-K retrieval, and enforces the `test.mjs` gate on create/repair.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  /** Ids registered in code (the gate, sleep, verify, approvals...). Disk tools can never take these over. */
  private readonly builtinIds = new Set<string>();
  private readonly embedder: Embedder;
  readonly toolsDir: string;
  /** The trust ladder every action taken inside a tool (`ctx.act`) and by engine code goes through. */
  private approvals?: ApprovalStore;
  /** The calls running now, innermost last, each collecting the model spend made inside it. */
  private readonly running: Array<{ usd: number }> = [];

  constructor(opts: { toolsDir: string; embedder?: Embedder }) {
    this.toolsDir = opts.toolsDir;
    this.embedder = opts.embedder ?? createLocalEmbedder();
    ensureToolPath();
  }

  private async embedManifest(m: ToolManifest): Promise<Vector> {
    const text = [
      m.id,
      m.description,
      ...m.whenToUse,
      ...(m.notWhen?.length ? [`not when: ${m.notWhen.join('; ')}`] : []),
    ].join('\n');
    return await this.embedder.embed(text);
  }

  /** Attaches the trust ladder (trust.json + approvals.json) used for actions and for tools' starting rungs. */
  useTrust(approvals: ApprovalStore | undefined): void {
    if (approvals) this.approvals = approvals;
  }

  /** The ladder's decision for one action or tool call made by engine code (or a tool's step): run now, or what happened instead. */
  async gate(toolId: string, input: Record<string, unknown>, opts: { now: Date; gapId?: string; stepOf?: string }): Promise<GateDecision> {
    const manifest = this.tools.get(toolId)?.manifest;
    if (!manifest) {
      return {
        run: false,
        level: 'never',
        receipt: { toolId, effect: 'write', status: 'failed', durationMs: 0, summary: `Unknown action "${toolId}". Nothing ran.`, changes: [], error: 'unknown action', at: opts.now.toISOString() },
      };
    }
    return passGate({ manifest, input, ...(this.approvals ? { approvals: this.approvals } : {}), now: opts.now, ...(opts.gapId ? { gapId: opts.gapId } : {}), ...(opts.stepOf ? { stepOf: opts.stepOf } : {}) });
  }

  /** Gates one action and, if the ladder lets it run, runs it: the receipt is what really happened. */
  async runAction(toolId: string, input: Record<string, unknown>, opts: CallOptions & { stepOf?: string }): Promise<Receipt> {
    const decision = await this.gate(toolId, input, { now: opts.now, ...(opts.gapId ? { gapId: opts.gapId } : {}), ...(opts.stepOf ? { stepOf: opts.stepOf } : {}) });
    if (!decision.run) return decision.receipt;
    const { stepOf: _stepOf, ...callOpts } = opts;
    return this.call(toolId, input, { ...callOpts, approved: true, level: decision.level });
  }

  /** The rung a tool is on now (the Desk tag, the dashboard). */
  async levelOf(manifest: ToolManifest): Promise<TrustLevel | 'never'> {
    return resolveLevel(manifest, this.approvals);
  }

  /** A tool's explicit rungs now (for a version about to be archived). */
  async rungsOf(id: string): Promise<Record<string, TrustLevel> | undefined> {
    return this.approvals?.rungsOf(id);
  }

  /** Puts back the rungs a kept version had (a rollback); a version that recorded none keeps today's rungs. */
  async restoreRungs(id: string, rungs: Record<string, string> | undefined): Promise<boolean> {
    if (!this.approvals || !rungs) return false;
    const valid = Object.fromEntries(Object.entries(rungs).filter((e): e is [string, TrustLevel] => ['rehearse', 'draft', 'act_and_report', 'act_quietly'].includes(e[1])));
    await this.approvals.restoreRungs(id, valid);
    return true;
  }

  /** True for ids registered in code: no packaged tool may replace them. */
  isReserved(id: string): boolean {
    return this.builtinIds.has(id);
  }

  async registerInline(
    manifest: ToolManifest,
    handler: (input: Record<string, unknown>, ctx: ScriptContext) => Promise<ScriptOutput> | ScriptOutput,
    opts: { alwaysVisible?: boolean } = {},
  ): Promise<void> {
    const checked = validateManifest(manifest);
    if (checked.errors.length) throw new Error(`Invalid inline tool ${manifest.id}: ${checked.errors.join('; ')}`);
    const vector = await this.embedManifest(checked.manifest!);
    this.builtinIds.add(manifest.id);
    this.tools.set(manifest.id, { manifest: checked.manifest!, handler, vector, ...(opts.alwaysVisible ? { alwaysVisible: true } : {}) });
  }

  /** Scans `tools/<id>/` on disk and registers every valid packaged script. */
  async loadFromDisk(): Promise<{ loaded: string[]; errors: string[] }> {
    const loaded: string[] = [];
    const errors: string[] = [];
    let entries: string[];
    try {
      entries = (await fs.readdir(this.toolsDir)).filter((e) => !e.startsWith('.') && !e.startsWith('_')).sort();
    } catch {
      return { loaded, errors };
    }
    for (const entry of entries) {
      const toolDir = path.join(this.toolsDir, entry);
      const stat = await fs.stat(toolDir).catch(() => undefined);
      if (!stat?.isDirectory()) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(toolDir, MANIFEST_FILE), 'utf8')) as unknown;
        const checked = validateManifest(raw);
        if (checked.errors.length || !checked.manifest) {
          errors.push(`${entry}: ${checked.errors.join('; ')}`);
          continue;
        }
        if (this.isReserved(checked.manifest.id)) {
          errors.push(`${entry}: "${checked.manifest.id}" is a built-in tool id; the packaged copy was not loaded`);
          continue;
        }
        await fs.stat(path.join(toolDir, RUN_FILE));
        const manifest = packagedManifest(checked.manifest);
        const vector = await this.embedManifest(manifest);
        this.tools.set(manifest.id, { manifest, toolDir, vector });
        loaded.push(checked.manifest.id);
      } catch (err) {
        errors.push(`${entry}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { loaded, errors };
  }

  /** Re-reads one packaged tool from disk (after a rollback swapped its files). */
  async reloadPackaged(id: string): Promise<{ ok: boolean; error?: string }> {
    const toolDir = path.join(this.toolsDir, id);
    try {
      const checked = validateManifest(JSON.parse(await fs.readFile(path.join(toolDir, MANIFEST_FILE), 'utf8')) as unknown);
      if (!checked.manifest || checked.errors.length) return { ok: false, error: checked.errors.join('; ') };
      if (checked.manifest.id !== id || this.isReserved(id)) return { ok: false, error: `manifest id "${checked.manifest.id}" cannot be loaded as ${id}` };
      const manifest = packagedManifest(checked.manifest);
      this.tools.set(id, { manifest, toolDir, vector: await this.embedManifest(manifest) });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  get(id: string): RegisteredTool | undefined {
    return this.tools.get(id);
  }

  list(): ToolManifest[] {
    return [...this.tools.values()].map((t) => t.manifest).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Returns always-visible core tools + top-K semantically relevant tools for `query`. */
  async selectForPrompt(query: string, topK = 6): Promise<ToolManifest[]> {
    const always: ToolManifest[] = [];
    const candidates: Array<{ item: ToolManifest; vector: Vector }> = [];
    for (const t of this.tools.values()) {
      // Actions are steps other tools take through the ladder, not moves: they are not offered to Decide.
      if (t.manifest.internal) continue;
      if (t.alwaysVisible) always.push(t.manifest);
      else candidates.push({ item: t.manifest, vector: t.vector });
    }
    const qVec = await this.embedder.embed(query);
    const ranked = topKBySimilarity(qVec, candidates, topK).map((r) => r.item);
    // The core tools are the same every turn, so they come first; the picks for this turn sit last, nearest the receipts.
    return [...always, ...ranked];
  }

  /**
   * The Desk's tool list, complete and honest: a one-line index of every tool id, then each shown tool with what the
   * trust gate will really do with it, how its recent calls went, its last error, and the newest lessons from failures.
   */
  async formatForDesk(shown: readonly ToolManifest[], approvals?: ApprovalStore): Promise<string> {
    const callable = this.list().filter((m) => !m.internal);
    const shownIds = new Set(shown.map((m) => m.id));
    const brief = (desc: string) => {
      const first = desc.split(/(?<=[.!?])\s+/)[0] ?? desc;
      return first.length > 72 ? `${first.slice(0, 71).trimEnd()}…` : first;
    };
    const other = callable.filter((m) => !shownIds.has(m.id));
    const index =
      `Every tool id (${callable.length}; any of them can be called, not only those shown): ${callable.map((m) => m.id).join(', ')}` +
      (other.length ? `\nOther tools (1-line summary): ${other.map((m) => `${m.id} (${brief(m.description)})`).join(' | ')}` : '');
    const blocks: string[] = [];
    for (const t of shown) {
      const entry = this.tools.get(t.id);
      const level = await resolveLevel(t, approvals ?? this.approvals);
      const tags = [t.effect, TRUST_WORDS[level]];
      let health = '';
      let lessons = '';
      if (entry?.toolDir) {
        const stats = await readToolStats(entry.toolDir);
        const recent = stats.recent ?? [];
        if (recent.length) tags.push(`${recent.filter((x) => x === 1).length}/${recent.length} recent calls ok`);
        else if (stats.runs) tags.push(`${stats.successes}/${stats.runs} calls ok`);
        else tags.push('not used yet');
        if (stats.lastError) {
          // Older records hold the bare "spawn X ENOENT"; say what it meant.
          const lastError = /ENOENT$/.test(stats.lastError) ? await explainError(stats.lastError, {}) : stats.lastError;
          health = `\n  last error: ${lastError.slice(0, 240)}${stats.consecutiveFailures === 0 ? ' (it has worked since)' : ''}`;
        }
        const learned = await readToolLessons(entry.toolDir, 2);
        if (learned.length) {
          lessons = learned
            .map((l) => `\n  lesson${l.action ? ` (${l.action})` : ''}: failed with "${l.error.slice(0, 140)}"; worked with ${JSON.stringify(l.workingInput).slice(0, 240)}`)
            .join('');
        }
      }
      blocks.push(
        `- ${t.id} [${tags.join(' · ')}]: ${t.description}\n` +
          `  whenToUse: ${t.whenToUse.join('; ')}\n` +
          `  inputSchema: ${JSON.stringify(t.inputSchema)}` +
          health +
          lessons,
      );
    }
    return [index, ...blocks].join('\n');
  }

  /** Executes a registered tool and returns an immutable Receipt. */
  async call(toolId: string, input: Record<string, unknown>, opts: CallOptions): Promise<Receipt> {
    const entry = this.tools.get(toolId);
    if (!entry) {
      return {
        toolId,
        effect: 'meta',
        status: 'failed',
        durationMs: 0,
        summary: `Unknown tool "${toolId}". Nothing ran. Pick an id from the tool index on the Desk ("Every tool id"); tools.list_all describes them all.`,
        changes: [],
        error: `Unknown tool "${toolId}"`,
        at: opts.now.toISOString(),
      };
    }
    // Composed sub-calls are read-only and never inherit the owner's approval of the outer call.
    const subOpts: CallOptions = { workspaceDir: opts.workspaceDir, now: opts.now, ...(opts.env ? { env: opts.env } : {}), ...(opts.wakeId ? { wakeId: opts.wakeId } : {}), ...(opts.gapId ? { gapId: opts.gapId } : {}) };
    // Each action the tool takes as a step of its work goes through the ladder on its own rung, never the tool's.
    const steps: Array<{ receipt: Receipt; level: ActionStep['level'] }> = [];
    const act = async (actionId: string, actionInput: Record<string, unknown>): Promise<Receipt> => {
      const at = opts.now.toISOString();
      let receipt: Receipt;
      let level: ActionStep['level'];
      if (!entry.manifest.actions?.includes(actionId)) {
        level = 'never';
        receipt = { toolId: actionId, effect: 'write', status: 'failed', durationMs: 0, summary: `Refused: ${toolId} does not declare the action ${actionId}. Nothing ran.`, changes: [], error: 'undeclared action', at };
      } else {
        const decision = await this.gate(actionId, actionInput, { now: opts.now, ...(opts.gapId ? { gapId: opts.gapId } : {}), stepOf: toolId });
        level = decision.level;
        // An action runs because the ladder said so, not because the owner approved the outer call.
        receipt = decision.run ? await this.call(actionId, actionInput, { ...subOpts, approved: true, level: decision.level }) : decision.receipt;
      }
      steps.push({ receipt, level });
      return receipt;
    };
    const ctx: ScriptContext = {
      act,
      workspaceDir: opts.workspaceDir,
      now: opts.now,
      env: opts.env ?? process.env,
      ...(opts.wakeId ? { wakeId: opts.wakeId } : {}),
      ...(opts.gapId ? { gapId: opts.gapId } : {}),
      callTool: async (readOnlyId, args = {}) => {
        const sub = this.tools.get(readOnlyId);
        if (!sub) {
          return {
            toolId: readOnlyId,
            effect: 'read',
            status: 'failed',
            durationMs: 0,
            summary: `Sub-tool "${readOnlyId}" not found.`,
            changes: [],
            error: `Sub-tool "${readOnlyId}" not found.`,
            at: opts.now.toISOString(),
          };
        }
        if (sub.manifest.effect !== 'read') {
          return {
            toolId: readOnlyId,
            effect: sub.manifest.effect,
            status: 'failed',
            durationMs: 0,
            summary: `Composition refused: scripts may only call read-only sub-tools ("${readOnlyId}" is ${sub.manifest.effect}).`,
            changes: [],
            error: 'Only read-only sub-tools may be composed directly.',
            at: opts.now.toISOString(),
          };
        }
        // A read sub-tool still runs on its own rung: one that is blocked, rehearsed or asks first is not run inside another tool.
        const subLevel = await resolveLevel(sub.manifest, this.approvals, args);
        if (subLevel !== 'act_and_report' && subLevel !== 'act_quietly') {
          return {
            toolId: readOnlyId,
            effect: 'read',
            status: 'failed',
            durationMs: 0,
            summary: `Composition refused: "${readOnlyId}" is at "${subLevel}" on the trust ladder, so it only runs as its own move.`,
            changes: [],
            error: 'sub-tool not runnable on its trust rung',
            at: opts.now.toISOString(),
          };
        }
        return this.call(readOnlyId, args, subOpts);
      },
    };
    // Model spend made while this call runs is charged to it (the innermost running call), for the spend ledger.
    const frame = { usd: 0 };
    this.running.push(frame);
    let receipt: Receipt;
    try {
      receipt = await executeScript({
        manifest: entry.manifest,
        input,
        ctx,
        ...(entry.toolDir ? { toolDir: entry.toolDir } : {}),
        ...(entry.handler ? { handler: entry.handler } : {}),
        ...(opts.approved !== undefined ? { approved: opts.approved } : {}),
        ...(opts.ownerApproved ? { ownerApproved: true } : {}),
      });
    } finally {
      this.running.splice(this.running.lastIndexOf(frame), 1);
    }
    if (this.approvals) {
      await this.approvals.spend.record(toolId, { at: opts.now, ms: receipt.durationMs, usd: frame.usd }).catch(() => undefined);
      // The scope and rung it ran on, so the owner's later pushback can cost exactly that scope its rung.
      if (opts.level) receipt = { ...receipt, trust: { key: await this.approvals.keyFor(entry.manifest, input), level: opts.level } };
    }
    const done = withSteps(opts.level ? markForReport(opts.level, receipt) : receipt, steps);
    // Do-and-tell outside any wake (no digest is coming): queue it for the next wake's digest.
    if (!opts.wakeId && opts.level === 'act_and_report' && this.approvals && done.status === 'ok' && done.changes.length) {
      await this.approvals.reports.add({ toolId, summary: done.summary.slice(0, 300), changes: done.changes, at: done.at }).catch(() => undefined);
    }
    return done;
  }

  /** Charges model spend to the call running now (the daemon's model meter calls this); outside any call it is Decide's own. */
  chargeSpend(usd: number): void {
    const frame = this.running[this.running.length - 1];
    if (frame && Number.isFinite(usd) && usd > 0) frame.usd += usd;
  }

  /** The tool's recent real calls from `wakes.jsonl` (newest last, distinct inputs), with how each went. */
  async recentRealCalls(toolId: string, limit = REPLAY_LIMIT): Promise<Array<{ input: Record<string, unknown>; ok: boolean }>> {
    const wakes = await loadWakes(path.dirname(this.toolsDir), 400);
    const seen = new Map<string, { input: Record<string, unknown>; ok: boolean }>();
    for (const w of wakes) {
      for (const t of w.trace ?? []) {
        if (t.toolId !== toolId) continue;
        const st = t.receipt?.status;
        if (st !== 'ok' && st !== 'failed' && st !== 'timed_out') continue;
        if ((t.receipt.data as { rehearsed?: boolean } | undefined)?.rehearsed) continue;
        const key = JSON.stringify(t.input);
        seen.delete(key);
        seen.set(key, { input: t.input, ok: st === 'ok' });
      }
    }
    return [...seen.values()].slice(-limit);
  }

  /** Runs a packaged run.mjs on one input in a child process; true when it returns ok. */
  private async replayOnce(dir: string, input: Record<string, unknown>, timeoutMs: number, manifest?: ToolManifest): Promise<boolean> {
    const script = [
      `import { run } from './run.mjs';`,
      `const out = await run(JSON.parse(process.env.RUFUS_REPLAY_INPUT), { workspaceDir: process.env.RUFUS_REPLAY_WS, now: new Date(), env: process.env, callTool: async (id) => ({ toolId: id, effect: 'read', status: 'failed', durationMs: 0, summary: 'not available in replay', changes: [], at: new Date().toISOString() }) });`,
      `process.stdout.write(out && out.ok === true ? 'REPLAY_OK' : 'REPLAY_FAIL');`,
    ].join('\n');
    try {
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: dir,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        // Like a real call: only the base environment and the secrets the tool declares.
        env: toolEnv(manifest, process.env, { RUFUS_REPLAY_INPUT: JSON.stringify(input), RUFUS_REPLAY_WS: path.dirname(this.toolsDir) }),
      });
      return stdout.includes('REPLAY_OK');
    } catch {
      return false;
    }
  }

  /**
   * A repair is judged on the tool's real past calls, not only its own test: each recent input runs on the old and the
   * new version (read tools live; write tools only have their inputs re-checked against the new schema, since running
   * them would act). Anything that worked on the old version and fails on the new one blocks the repair.
   */
  private async replayGate(id: string, oldDir: string, stagingDir: string, manifest: ToolManifest): Promise<{ ok: boolean; report: string; worked: number }> {
    const calls = await this.recentRealCalls(id);
    if (!calls.length) return { ok: true, report: 'replay: no real past calls to check', worked: 0 };
    const regressions: string[] = [];
    let fixed = 0;
    let kept = 0;
    if (manifest.effect === 'read') {
      const timeoutMs = Math.min(manifest.timeoutMs ?? REPLAY_TIMEOUT_MS, REPLAY_TIMEOUT_MS);
      for (const c of calls) {
        const [before, after] = await Promise.all([this.replayOnce(oldDir, c.input, timeoutMs, this.tools.get(id)?.manifest), this.replayOnce(stagingDir, c.input, timeoutMs, manifest)]);
        if (before && !after) regressions.push(JSON.stringify(c.input).slice(0, 160));
        else if (!before && after) fixed++;
        else if (before && after) kept++;
      }
    } else {
      for (const c of calls) {
        const errs = validateInput(c.input, manifest.inputSchema);
        if (errs.length && c.ok) regressions.push(`${JSON.stringify(c.input).slice(0, 160)} (${errs.join('; ')})`);
        else if (!errs.length) kept++;
      }
    }
    const report = `replay of ${calls.length} real past call(s): ${kept} still work, ${fixed} fixed, ${regressions.length} broken`;
    // Only a live replay (read tools) shows the new version working; a write tool's inputs are only schema-checked.
    const worked = manifest.effect === 'read' ? kept + fixed : 0;
    return regressions.length ? { ok: false, report: `${report}. Broken by this version: ${regressions.join(' | ')}`, worked } : { ok: true, report, worked };
  }

  /**
   * Pioneer tool creation/repair gate:
   * 1. Validates tool.json manifest; built-in ids are reserved, and tool code may not touch the trust files.
   * 2. Stages tool.json, run.mjs, test.mjs in a temp directory and runs `node test.mjs`, then the engine's contract check.
   * 3. A repair also replays the tool's real past calls on old and new versions (see replayGate).
   * 4. Only then installs into `tools/<id>/`, keeping the old version (with its stats) in `.versions/`, and re-embeds.
   */
  async createOrRepair(pkg: {
    manifest: ToolManifest;
    runCode: string;
    testCode: string;
    tag?: { reason?: string; wakeId?: string; gapId?: string; now?: Date };
  }): Promise<{ ok: boolean; error?: string; testOutput?: string; replaced?: string; startLevel?: TrustLevel; evidence?: { testRanTool: boolean; replayWorked: number } }> {
    const validated = validateManifest(pkg.manifest);
    if (validated.errors.length || !validated.manifest) {
      return { ok: false, error: `Invalid manifest: ${validated.errors.join('; ')}` };
    }
    const checked = { manifest: packagedManifest(validated.manifest) };
    const id = checked.manifest.id;
    if (this.isReserved(id)) {
      return { ok: false, error: `"${id}" is a built-in tool; its code lives in the engine and cannot be created or repaired as a packaged tool.` };
    }
    if (touchesTrustFiles(pkg.runCode)) {
      return { ok: false, error: 'run.mjs refers to the trust gate\'s own files (trust.json, permissions.json, approvals.json); only the approval tools may change them.' };
    }
    const stagingDir = path.join(this.toolsDir, `.staging-${id}-${Date.now()}`);
    const finalDir = path.join(this.toolsDir, id);
    const existing = this.tools.get(id);
    const isRepair = !!existing?.toolDir && (await fs.stat(path.join(finalDir, RUN_FILE)).then(() => true, () => false));
    await fs.mkdir(stagingDir, { recursive: true });
    try {
      await fs.writeFile(path.join(stagingDir, MANIFEST_FILE), `${JSON.stringify(checked.manifest, null, 2)}\n`, 'utf8');
      await fs.writeFile(path.join(stagingDir, TEST_FILE), pkg.testCode, 'utf8');
      // While the test runs, run.mjs is a thin probe around the real code that notes each run() and whether it came back ok.
      const probe = path.join(stagingDir, '.test-probe');
      await fs.writeFile(path.join(stagingDir, REAL_RUN_FILE), pkg.runCode, 'utf8');
      await fs.writeFile(
        path.join(stagingDir, RUN_FILE),
        [
          `import { appendFileSync } from 'node:fs';`,
          `import * as real from './${REAL_RUN_FILE}';`,
          `export * from './${REAL_RUN_FILE}';`,
          `export async function run(input, ctx) {`,
          `  const out = await real.run(input, ctx);`,
          `  try { appendFileSync(process.env.RUFUS_TEST_PROBE, out && out.ok === true ? 'ok\\n' : 'fail\\n'); } catch {}`,
          `  return out;`,
          `}`,
        ].join('\n'),
        'utf8',
      );

      const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(stagingDir, TEST_FILE)], {
        cwd: stagingDir,
        timeout: 15_000,
        // The test sees what the tool will see when it runs: the base environment and its declared secrets.
        env: toolEnv(checked.manifest, process.env, { RUFUS_TEST_PROBE: probe }),
      });
      const testRanTool = (await fs.readFile(probe, 'utf8').catch(() => '')).split('\n').includes('ok');
      await fs.writeFile(path.join(stagingDir, RUN_FILE), pkg.runCode, 'utf8');
      await fs.rm(path.join(stagingDir, REAL_RUN_FILE), { force: true });
      await fs.rm(probe, { force: true });

      // Engine-enforced ScriptOutput contract check (never rely solely on the AI's test.mjs)
      const contractCheck = [
        `import { run } from './run.mjs';`,
        `if (typeof run !== 'function') throw new Error('run.mjs must export async function run(input, ctx)');`,
        ...(checked.manifest.effect === 'read' && (checked.manifest.exampleInput || !(checked.manifest.inputSchema.required?.length))
          ? [
              `const out = await run(${JSON.stringify(checked.manifest.exampleInput ?? {})}, { workspaceDir: ${JSON.stringify(path.dirname(this.toolsDir))}, now: new Date(), env: process.env, callTool: async () => ({ ok: false, summary: 'stub' }) });`,
              `if (!out || typeof out !== 'object' || typeof out.ok !== 'boolean' || typeof out.summary !== 'string') throw new Error('run() violated ScriptOutput contract: must return { ok: boolean, summary: string }');`,
            ]
          : []),
      ].join('\n');
      await execFileAsync(process.execPath, ['--input-type=module', '-e', contractCheck], {
        cwd: stagingDir,
        timeout: 15_000,
        env: toolEnv(checked.manifest),
      });

      let replay = '';
      let replayWorked = 0;
      if (isRepair) {
        const gate = await this.replayGate(id, finalDir, stagingDir, checked.manifest);
        replay = gate.report;
        replayWorked = gate.worked;
        if (!gate.ok) {
          await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
          return { ok: false, error: `Repair refused: ${gate.report}` };
        }
      }

      await fs.mkdir(this.toolsDir, { recursive: true });
      let replaced: string | undefined;
      if (isRepair) {
        const now = pkg.tag?.now ?? new Date();
        replaced = await archiveToolVersion(finalDir, {
          at: now,
          reason: pkg.tag?.reason ?? 'tools.repair',
          // The rungs the old code had earned go with it, so rolling back to it brings them back.
          ...(this.approvals ? { rungs: await this.approvals.rungsOf(id) } : {}),
          ...(pkg.tag?.wakeId ? { wakeId: pkg.tag.wakeId } : {}),
          ...(pkg.tag?.gapId ? { gapId: pkg.tag.gapId } : {}),
        });
        await carryToolHistory(finalDir, stagingDir);
      }
      await fs.rm(finalDir, { recursive: true, force: true });
      await fs.rename(stagingDir, finalDir);

      const vector = await this.embedManifest(checked.manifest);
      this.tools.set(id, { manifest: checked.manifest, toolDir: finalDir, vector });
      // A tool just built or changed starts low on the ladder, whatever rung it had: the owner raises it from there.
      const evidence = { testRanTool, replayWorked };
      const startLevel = startLevelFor(evidence);
      if (this.approvals) await this.approvals.setStartLevel(id, startLevel);
      const out = [`${stdout}${stderr}`.trim(), replay, replaced ? `previous version kept as .versions/${replaced}` : ''].filter(Boolean).join('\n');
      return { ok: true, testOutput: out, startLevel, evidence, ...(replaced ? { replaced } : {}) };
    } catch (err) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        error: `test.mjs failed: ${e.stderr?.trim() || e.stdout?.trim() || e.message || String(err)}`,
      };
    }
  }
}

/** Folds the actions a tool took into its receipt: what they changed (even inside a read tool), drafts, and the report hint. */
function withSteps(receipt: Receipt, steps: ReadonlyArray<{ receipt: Receipt; level: ActionStep['level'] }>): Receipt {
  if (!steps.length) return receipt;
  const actions: ActionStep[] = steps.map((s) => ({ toolId: s.receipt.toolId, level: s.level, status: s.receipt.status, summary: s.receipt.summary, changes: s.receipt.changes }));
  const changes = [...receipt.changes, ...steps.filter((s) => s.receipt.status === 'ok').flatMap((s) => s.receipt.changes)];
  const hints = [...new Set([...(receipt.nextHints ?? []), ...steps.flatMap((s) => s.receipt.nextHints ?? [])])];
  return { ...receipt, changes: [...new Set(changes)], ...(hints.length ? { nextHints: hints } : {}), actions };
}
