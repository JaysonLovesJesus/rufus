import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLocalEmbedder, topKBySimilarity, type Embedder, type Vector } from '../embed';
import type { Receipt, ScriptContext, ScriptOutput, ToolManifest } from '../types';
import { executeScript, MANIFEST_FILE, RUN_FILE, TEST_FILE, validateManifest } from './standard';

const execFileAsync = promisify(execFile);

export interface RegisteredTool {
  manifest: ToolManifest;
  toolDir?: string;
  handler?: (input: Record<string, unknown>, ctx: ScriptContext) => Promise<ScriptOutput> | ScriptOutput;
  vector: Vector;
  alwaysVisible?: boolean;
}

/**
 * Manages built-in + disk-packaged scripts (`tools/<id>/`), embeds their descriptions and
 * `whenToUse` conditions for fast top-K retrieval, and enforces the `test.mjs` gate on create/repair.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly embedder: Embedder;
  readonly toolsDir: string;

  constructor(opts: { toolsDir: string; embedder?: Embedder }) {
    this.toolsDir = opts.toolsDir;
    this.embedder = opts.embedder ?? createLocalEmbedder();
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

  async registerInline(
    manifest: ToolManifest,
    handler: (input: Record<string, unknown>, ctx: ScriptContext) => Promise<ScriptOutput> | ScriptOutput,
    opts: { alwaysVisible?: boolean } = {},
  ): Promise<void> {
    const checked = validateManifest(manifest);
    if (checked.errors.length) throw new Error(`Invalid inline tool ${manifest.id}: ${checked.errors.join('; ')}`);
    const vector = await this.embedManifest(checked.manifest!);
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
    return [...ranked, ...always];
  }

  /** Executes a registered tool and returns an immutable Receipt. */
  async call(
    toolId: string,
    input: Record<string, unknown>,
    opts: { workspaceDir: string; now: Date; approved?: boolean; env?: Record<string, string | undefined> },
  ): Promise<Receipt> {
    const entry = this.tools.get(toolId);
    if (!entry) {
      return {
        toolId,
        effect: 'meta',
        status: 'failed',
        durationMs: 0,
        summary: `Unknown tool "${toolId}". Call tools.list_all to see available tools.`,
        changes: [],
        error: `Unknown tool "${toolId}"`,
        at: opts.now.toISOString(),
      };
    }
    const ctx: ScriptContext = {
      workspaceDir: opts.workspaceDir,
      now: opts.now,
      env: opts.env ?? process.env,
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
        return this.call(readOnlyId, args, opts);
      },
    };
    return executeScript({
      manifest: entry.manifest,
      input,
      ctx,
      ...(entry.toolDir ? { toolDir: entry.toolDir } : {}),
      ...(entry.handler ? { handler: entry.handler } : {}),
      ...(opts.approved !== undefined ? { approved: opts.approved } : {}),
    });
  }

  /**
   * Pioneer tool creation/repair gate:
   * 1. Validates tool.json manifest.
   * 2. Stages tool.json, run.mjs, test.mjs in a temp directory and runs `node test.mjs`.
   * 3. Only if test.mjs exits 0 does it atomically install into `tools/<id>/` and re-embed.
   */
  async createOrRepair(pkg: {
    manifest: ToolManifest;
    runCode: string;
    testCode: string;
  }): Promise<{ ok: boolean; error?: string; testOutput?: string }> {
    const checked = validateManifest(pkg.manifest);
    if (checked.errors.length || !checked.manifest) {
      return { ok: false, error: `Invalid manifest: ${checked.errors.join('; ')}` };
    }
    const id = checked.manifest.id;
    const stagingDir = path.join(this.toolsDir, `.staging-${id}-${Date.now()}`);
    const finalDir = path.join(this.toolsDir, id);
    await fs.mkdir(stagingDir, { recursive: true });
    try {
      await fs.writeFile(path.join(stagingDir, MANIFEST_FILE), `${JSON.stringify(checked.manifest, null, 2)}\n`, 'utf8');
      await fs.writeFile(path.join(stagingDir, RUN_FILE), pkg.runCode, 'utf8');
      await fs.writeFile(path.join(stagingDir, TEST_FILE), pkg.testCode, 'utf8');

      const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(stagingDir, TEST_FILE)], {
        cwd: stagingDir,
        timeout: 15_000,
      });

      await fs.mkdir(this.toolsDir, { recursive: true });
      await fs.rm(finalDir, { recursive: true, force: true });
      await fs.rename(stagingDir, finalDir);

      const vector = await this.embedManifest(checked.manifest);
      this.tools.set(id, { manifest: checked.manifest, toolDir: finalDir, vector });
      return { ok: true, testOutput: `${stdout}${stderr}`.trim() };
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
