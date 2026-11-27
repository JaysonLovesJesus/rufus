import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLocalEmbedder, topKBySimilarity, type Embedder, type Vector } from '../embed';
import { loadWakes } from '../eval/flight-recorder';
import type { Receipt, ScriptContext, ScriptOutput, ToolManifest } from '../types';
import type { ApprovalStore, TrustLevel } from './approvals';
import { touchesTrustFiles } from './protected';
import { executeScript, explainError, MANIFEST_FILE, readToolLessons, readToolStats, RUN_FILE, TEST_FILE, validateInput, validateManifest } from './standard';
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
        const vector = await this.embedManifest(checked.manifest);
        this.tools.set(checked.manifest.id, { manifest: checked.manifest, toolDir, vector });
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
      this.tools.set(id, { manifest: checked.manifest, toolDir, vector: await this.embedManifest(checked.manifest) });
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
    const index = `Every tool id (${this.tools.size}; any of them can be called, not only those shown): ${this.list().map((m) => m.id).join(', ')}`;
    const blocks: string[] = [];
    for (const t of shown) {
      const entry = this.tools.get(t.id);
      const level = approvals ? await approvals.levelFor(t) : t.effect === 'write' && t.requiresApproval ? 'draft' : 'act_quietly';
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
    const ctx: ScriptContext = {
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
        return this.call(readOnlyId, args, subOpts);
      },
    };
    return executeScript({
      manifest: entry.manifest,
      input,
      ctx,
      ...(entry.toolDir ? { toolDir: entry.toolDir } : {}),
      ...(entry.handler ? { handler: entry.handler } : {}),
      ...(opts.approved !== undefined ? { approved: opts.approved } : {}),
      ...(opts.ownerApproved ? { ownerApproved: true } : {}),
    });
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
  private async replayOnce(dir: string, input: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
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
        env: { ...process.env, RUFUS_REPLAY_INPUT: JSON.stringify(input), RUFUS_REPLAY_WS: path.dirname(this.toolsDir) },
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
  private async replayGate(id: string, oldDir: string, stagingDir: string, manifest: ToolManifest): Promise<{ ok: boolean; report: string }> {
    const calls = await this.recentRealCalls(id);
    if (!calls.length) return { ok: true, report: 'replay: no real past calls to check' };
    const regressions: string[] = [];
    let fixed = 0;
    let kept = 0;
    if (manifest.effect === 'read') {
      const timeoutMs = Math.min(manifest.timeoutMs ?? REPLAY_TIMEOUT_MS, REPLAY_TIMEOUT_MS);
      for (const c of calls) {
        const [before, after] = await Promise.all([this.replayOnce(oldDir, c.input, timeoutMs), this.replayOnce(stagingDir, c.input, timeoutMs)]);
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
    return regressions.length ? { ok: false, report: `${report}. Broken by this version: ${regressions.join(' | ')}` } : { ok: true, report };
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
  }): Promise<{ ok: boolean; error?: string; testOutput?: string; replaced?: string }> {
    const checked = validateManifest(pkg.manifest);
    if (checked.errors.length || !checked.manifest) {
      return { ok: false, error: `Invalid manifest: ${checked.errors.join('; ')}` };
    }
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
      await fs.writeFile(path.join(stagingDir, RUN_FILE), pkg.runCode, 'utf8');
      await fs.writeFile(path.join(stagingDir, TEST_FILE), pkg.testCode, 'utf8');

      const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(stagingDir, TEST_FILE)], {
        cwd: stagingDir,
        timeout: 15_000,
      });

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
      });

      let replay = '';
      if (isRepair) {
        const gate = await this.replayGate(id, finalDir, stagingDir, checked.manifest);
        replay = gate.report;
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
          ...(pkg.tag?.wakeId ? { wakeId: pkg.tag.wakeId } : {}),
          ...(pkg.tag?.gapId ? { gapId: pkg.tag.gapId } : {}),
        });
        await carryToolHistory(finalDir, stagingDir);
      }
      await fs.rm(finalDir, { recursive: true, force: true });
      await fs.rename(stagingDir, finalDir);

      const vector = await this.embedManifest(checked.manifest);
      this.tools.set(id, { manifest: checked.manifest, toolDir: finalDir, vector });
      const out = [`${stdout}${stderr}`.trim(), replay, replaced ? `previous version kept as .versions/${replaced}` : ''].filter(Boolean).join('\n');
      return { ok: true, testOutput: out, ...(replaced ? { replaced } : {}) };
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
