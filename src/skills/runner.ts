import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isExternalWriteTool, type ToolRegistry } from '../tools/tools';
import { listLayer3Units, layer3UnitDir, matchSkills, parseSkillMarkdown, scoreSkill, type Skill } from './skills';

/**
 * v25a: Executable Code-in-Layer-3. Next to a skill's or framework's markdown, a workspace may keep small `.mjs` hooks
 * that code runs at exact moments, so taste and judgement rules become checks instead of hopes:
 *
 *   <workspace>/taste.mjs                         verifyDraft(text, ctx) -> violations, on every reply
 *   <workspace>/boundaries.mjs                    canActNow(ctx) -> { allow, reason }, before anything proactive/autonomous
 *   <workspace>/skills/<name>/prepare.mjs         prepare(ctx) -> ground truth, gathered BEFORE the AI thinks
 *   <workspace>/skills/<name>/verify.mjs          verify(text, ctx) -> violations, AFTER the AI drafts
 *   <workspace>/frameworks/<name>/{prepare,verify}.mjs   the same, for frameworks
 *   (run.mjs sits beside them for flows that want an explicit code step; it is discovered but never run implicitly.)
 *
 * Safety: only files inside the workspace are ever loaded (real paths are checked, so `..` and symlinks out are
 * refused), only `.mjs`, each hook gets a tight timeout, and a hook that throws or hangs never takes the daemon down:
 * the failure is reported in `notes`/`errors` and the turn carries on (verify fails open, boundaries fail closed).
 * Each load is keyed by the file's mtime, so an edited hook takes effect on the next turn without a restart.
 */

export const TASTE_FILE = 'taste.mjs';
export const BOUNDARIES_FILE = 'boundaries.mjs';
export const PREPARE_FILE = 'prepare.mjs';
export const RUN_FILE = 'run.mjs';
export const VERIFY_FILE = 'verify.mjs';
export const PROJECTS_DIR = 'projects';
export const DEFAULT_LAYER3_TIMEOUT_MS = 5000;
export const DEFAULT_PREPARE_CHARS = 3000;
export const DEFAULT_PROJECTS_CHARS = 2000;
export const LAYER3_RETRY_PREFIX = 'LAYER 3 VERIFIER REJECTED YOUR DRAFT:';

/** The corrective retry prompt for Layer 3 violations. */
export const layer3RetryPrompt = (reasons: readonly string[]): string => `${LAYER3_RETRY_PREFIX} ${reasons.join('; ')}. Rewrite cleanly fixing every issue.`;

export type Layer3Channel = 'chat' | 'voice' | 'proactive' | (string & {});

/** A Layer 3 path problem: the file is outside the workspace or not an `.mjs`. Nothing was loaded. */
export class Layer3PathError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`Layer 3 file refused (${reason}): ${file}`);
    this.name = 'Layer3PathError';
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const oneLine = (s: string, max = 200): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

async function realOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

const inside = (root: string, file: string): boolean => file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * The absolute real path of a Layer 3 `.mjs` file inside `dir`, or undefined when it does not exist. Throws
 * `Layer3PathError` for anything outside the workspace (`..`, an absolute path elsewhere, a symlink out) or not `.mjs`.
 */
export async function resolveLayer3File(dir: string, file: string): Promise<string | undefined> {
  if (path.extname(file) !== '.mjs') throw new Layer3PathError(file, 'only .mjs files run as Layer 3 code');
  const given = path.resolve(dir);
  const lexical = path.resolve(given, file);
  if (!inside(given, lexical)) throw new Layer3PathError(file, 'outside the workspace');
  const real = await realOrUndefined(lexical);
  if (!real) return undefined;
  // Real paths on both sides: a symlink inside the workspace that points out of it is refused too.
  const root = (await realOrUndefined(given)) ?? given;
  if (!inside(root, real)) throw new Layer3PathError(file, 'it links outside the workspace');
  return real;
}

/**
 * Imports a local Layer 3 `.mjs` module, keyed by its mtime and size (`?m=<mtimeMs>-<size>`), so an edit takes effect on
 * the next call without restarting the daemon. With `dir`, the file must be inside that workspace (see
 * `resolveLayer3File`). Undefined when the file does not exist; throws on a refused path or a module that fails to load.
 */
export async function loadLayer3Module(filePath: string, dir?: string): Promise<Record<string, unknown> | undefined> {
  let file: string | undefined;
  if (dir !== undefined) file = await resolveLayer3File(dir, filePath);
  else {
    if (path.extname(filePath) !== '.mjs') throw new Layer3PathError(filePath, 'only .mjs files run as Layer 3 code');
    file = await realOrUndefined(path.resolve(filePath));
  }
  if (!file) return undefined;
  let stat: { mtimeMs: number; size: number; isFile(): boolean };
  try {
    stat = await fs.stat(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const url = `${pathToFileURL(file).href}?m=${Math.round(stat.mtimeMs * 1000)}-${stat.size}`;
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
}

/** Runs `fn` with a timeout. A hook that hangs is abandoned (its promise is left to settle on its own). */
async function withTimeout<T>(work: () => T | Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A loaded module's function export, by the first of `names` that is a function. */
function hook(mod: Record<string, unknown> | undefined, names: readonly string[]): ((...args: unknown[]) => unknown) | undefined {
  if (!mod) return undefined;
  const def = mod.default && typeof mod.default === 'object' ? (mod.default as Record<string, unknown>) : undefined;
  for (const n of names) {
    const f = mod[n] ?? def?.[n];
    if (typeof f === 'function') return f as (...args: unknown[]) => unknown;
  }
  return undefined;
}

/** A verify hook's answer as violation strings: `string[]`, a string, `false`, or `{ ok, reasons | violations }`. */
export function normalizeViolations(out: unknown): string[] {
  if (out === undefined || out === null || out === true) return [];
  if (out === false) return ['failed verification'];
  if (typeof out === 'string') return out.trim() ? [oneLine(out)] : [];
  if (Array.isArray(out)) return out.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => oneLine(x));
  if (typeof out === 'object') {
    const o = out as { ok?: unknown; reasons?: unknown; violations?: unknown };
    const o2 = o as { ok?: unknown; reasons?: unknown; violations?: unknown; problems?: unknown; reason?: unknown };
    const list = normalizeViolations(
      Array.isArray(o2.reasons) ? o2.reasons
        : Array.isArray(o2.violations) ? o2.violations
        : Array.isArray(o2.problems) ? o2.problems
        : typeof o2.reasons === 'string' ? o2.reasons
        : typeof o2.reason === 'string' ? o2.reason
        : undefined,
    );
    if (!list.length && o2.ok === false) return ['failed verification'];
    return list;
  }
  return [];
}

const unitLabel = (s: Pick<Skill, 'name' | 'kind'>): string => `${s.kind === 'framework' ? 'frameworks' : 'skills'}/${s.name}`;

/** The skills and frameworks that fit `query` (the same $0 matching as the SKILL.md prompt section). Never throws. */
export async function matchLayer3Units(dir: string, query: string): Promise<Skill[]> {
  try {
    return query.trim() ? matchSkills(await listLayer3Units(dir), query) : [];
  } catch {
    return [];
  }
}

/** A unit's hook file, relative to the workspace, or undefined for an unsafe name. */
function unitHookPath(dir: string, unit: Pick<Skill, 'name' | 'kind'>, file: string): string | undefined {
  const folder = layer3UnitDir(dir, unit.kind ?? 'skill', unit.name);
  return folder ? path.join(folder, file) : undefined;
}

/** Which Layer 3 hooks a workspace has: workspace-level files and each unit's `prepare`/`run`/`verify`. */
export interface Layer3Inventory {
  taste?: string;
  boundaries?: string;
  units: Array<{ name: string; kind: 'skill' | 'framework'; prepare?: string; run?: string; verify?: string }>;
}

/** v25a: discovers every Layer 3 `.mjs` hook in the workspace (no code is run). Never throws. */
export async function discoverLayer3(dir: string): Promise<Layer3Inventory> {
  const exists = async (rel: string): Promise<string | undefined> => {
    try {
      return await resolveLayer3File(dir, rel);
    } catch {
      return undefined;
    }
  };
  const units = await listLayer3Units(dir).catch(() => [] as Skill[]);
  const [taste, boundaries] = await Promise.all([exists(TASTE_FILE), exists(BOUNDARIES_FILE)]);
  const out: Layer3Inventory = { ...(taste ? { taste } : {}), ...(boundaries ? { boundaries } : {}), units: [] };
  for (const u of units) {
    const found: Layer3Inventory['units'][number] = { name: u.name, kind: u.kind ?? 'skill' };
    for (const [key, file] of [['prepare', PREPARE_FILE], ['run', RUN_FILE], ['verify', VERIFY_FILE]] as const) {
      const rel = unitHookPath(dir, u, file);
      const real = rel ? await exists(rel) : undefined;
      if (real) found[key] = real;
    }
    out.units.push(found);
  }
  return out;
}

// ---------- prepare: ground truth before the AI thinks ----------

export interface Layer3PrepareContext {
  dir: string;
  query: string;
  channel: Layer3Channel;
  now: Date;
  /** The skill or framework whose prepare.mjs is running. */
  unit: { name: string; kind: 'skill' | 'framework' };
  /** Runs a registered read-only tool (anything else is refused). */
  callReadOnlyTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface Layer3PrepareOptions {
  dir: string;
  /** The matched skills/frameworks. Default: matched from `query`. */
  skills?: readonly Skill[];
  query: string;
  channel?: Layer3Channel;
  now: Date;
  tools?: ToolRegistry;
  timeoutMs?: number;
  /** Prompt budget for all gathered context. Default 3000 characters. */
  maxChars?: number;
}

/** A read-only tool call for Layer 3 code: refuses write and external tools outright, then goes through the registry gates. */
export function readOnlyToolCaller(tools: ToolRegistry | undefined, dir: string, now: Date): (name: string, args?: Record<string, unknown>) => Promise<unknown> {
  return async (name, args = {}) => {
    const tool = tools?.get(name);
    if (!tool) throw new Error(`No tool called "${name}".`);
    if (!tool.readOnly || isExternalWriteTool(name)) throw new Error(`${name} is not read-only, so Layer 3 code may not call it.`);
    return tools!.call(name, args, { dir, now, stage: 'execute' });
  };
}

const asContext = (out: unknown): string => {
  if (out === undefined || out === null || out === '') return '';
  if (typeof out === 'string') return out.trim();
  if (typeof out === 'object' && out && 'context' in out) return asContext((out as { context: unknown }).context);
  try {
    return JSON.stringify(out, null, 2);
  } catch {
    return String(out);
  }
};

/**
 * v25a: runs `prepare(ctx)` from each matched skill's/framework's `prepare.mjs` (5s each by default) and returns the
 * ground truth to inject into the prompt BEFORE the AI thinks. Failures become `notes`; it never throws.
 */
export async function runLayer3Prepare(opts: Layer3PrepareOptions): Promise<{ context: string; notes: string[] }> {
  const notes: string[] = [];
  const parts: string[] = [];
  const units = opts.skills ?? (await matchLayer3Units(opts.dir, opts.query));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LAYER3_TIMEOUT_MS;
  for (const unit of units) {
    const rel = unitHookPath(opts.dir, unit, PREPARE_FILE);
    if (!rel) continue;
    try {
      const fn = hook(await loadLayer3Module(rel, opts.dir), ['prepare']);
      if (!fn) continue;
      const ctx: Layer3PrepareContext = {
        dir: opts.dir,
        query: opts.query,
        channel: opts.channel ?? 'chat',
        now: opts.now,
        unit: { name: unit.name, kind: unit.kind ?? 'skill' },
        callReadOnlyTool: readOnlyToolCaller(opts.tools, opts.dir, opts.now),
      };
      const text = asContext(await withTimeout(() => fn(ctx), timeoutMs, `${unitLabel(unit)}/${PREPARE_FILE}`));
      if (text) parts.push(`### ${unit.name}${unit.kind === 'framework' ? ' (framework)' : ''}\n${text}`);
    } catch (err) {
      notes.push(`${unitLabel(unit)}/${PREPARE_FILE} failed: ${oneLine(message(err))}`);
    }
  }
  if (!parts.length) return { context: '', notes };
  const max = opts.maxChars ?? DEFAULT_PREPARE_CHARS;
  let body = parts.join('\n\n');
  if (body.length > max) body = `${body.slice(0, max - 1).trimEnd()}…`;
  return { context: `## Ground truth gathered by Layer 3 code (prepare.mjs; exact, use it)\n${body}`, notes };
}

// ---------- verify: taste and framework checks after the AI drafts ----------

export interface Layer3VerifyContext {
  dir: string;
  channel: Layer3Channel;
  now: Date;
  /** Every tool call this turn: `{ name, ok }`. */
  toolCalls: ReadonlyArray<{ name: string; ok: boolean }>;
  /** Set for a unit's verify.mjs. */
  unit?: { name: string; kind: 'skill' | 'framework' };
  query?: string;
}

export interface Layer3VerifyOptions {
  dir: string;
  skills?: readonly Skill[];
  text: string;
  toolCalls?: ReadonlyArray<{ name: string; ok: boolean }>;
  channel?: Layer3Channel;
  now: Date;
  /** The human's message, used to match skills when `skills` is not given. */
  query?: string;
  timeoutMs?: number;
}

export interface Layer3VerifyResult {
  ok: boolean;
  reasons: string[];
  /** Hooks that threw or timed out. They do not block the draft (verify fails open). */
  errors: string[];
}

/**
 * v25a: runs `<workspace>/taste.mjs` (`verifyDraft(text, ctx)`) and each matched unit's `verify.mjs`
 * (`verify(text, ctx)` or `verifyDraft(text, ctx)`) and aggregates their violation strings. Never throws.
 */
export async function runLayer3Verify(opts: Layer3VerifyOptions): Promise<Layer3VerifyResult> {
  const reasons: string[] = [];
  const errors: string[] = [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LAYER3_TIMEOUT_MS;
  const base: Layer3VerifyContext = { dir: opts.dir, channel: opts.channel ?? 'chat', now: opts.now, toolCalls: opts.toolCalls ?? [], ...(opts.query ? { query: opts.query } : {}) };
  const run = async (rel: string, label: string, names: readonly string[], ctx: Layer3VerifyContext): Promise<void> => {
    try {
      const fn = hook(await loadLayer3Module(rel, opts.dir), names);
      if (!fn) return;
      reasons.push(...normalizeViolations(await withTimeout(() => fn(opts.text, ctx), timeoutMs, label)));
    } catch (err) {
      errors.push(`${label} failed: ${oneLine(message(err))}`);
    }
  };
  await run(TASTE_FILE, TASTE_FILE, ['verifyDraft', 'verify'], base);
  const units = opts.skills ?? (opts.query ? await matchLayer3Units(opts.dir, opts.query) : []);
  for (const unit of units) {
    const rel = unitHookPath(opts.dir, unit, VERIFY_FILE);
    if (rel) await run(rel, `${unitLabel(unit)}/${VERIFY_FILE}`, ['verify', 'verifyDraft'], { ...base, unit: { name: unit.name, kind: unit.kind ?? 'skill' } });
  }
  const unique = [...new Set(reasons)];
  return { ok: unique.length === 0, reasons: unique, errors };
}

// ---------- boundaries: may Rufus act on its own right now? ----------

export interface Layer3BoundaryContext {
  dir: string;
  now: Date;
  /** What is about to happen on its own: `proactive.message`, `chat.reply`, `beeper.react`... */
  action: string;
  sensitivity: readonly string[];
  /** The Earned Trust rung it would act at (`auto_notify`, `autonomous`...), when known. */
  trust?: string;
}

export interface Layer3BoundaryOptions {
  dir: string;
  now: Date;
  action: string;
  sensitivity?: readonly string[];
  trust?: string;
  timeoutMs?: number;
}

/**
 * v25a: asks `<workspace>/boundaries.mjs` `canActNow(ctx)` whether an autonomous or proactive action may happen now.
 * Undefined when there is no such hook (nothing changes). A hook that throws or times out blocks (fail closed): when in
 * doubt, Rufus does not act on its own. Never throws.
 */
export async function checkLayer3Boundary(opts: Layer3BoundaryOptions): Promise<{ allow: boolean; reason?: string } | undefined> {
  let fn: ((...args: unknown[]) => unknown) | undefined;
  try {
    fn = hook(await loadLayer3Module(BOUNDARIES_FILE, opts.dir), ['canActNow']);
  } catch (err) {
    return { allow: false, reason: `${BOUNDARIES_FILE} failed to load: ${oneLine(message(err))}` };
  }
  if (!fn) return undefined;
  const ctx: Layer3BoundaryContext = { dir: opts.dir, now: opts.now, action: opts.action, sensitivity: opts.sensitivity ?? [], ...(opts.trust ? { trust: opts.trust } : {}) };
  try {
    const out = await withTimeout(() => fn!(ctx), opts.timeoutMs ?? DEFAULT_LAYER3_TIMEOUT_MS, BOUNDARIES_FILE);
    if (out === undefined || out === null || out === true) return { allow: true };
    if (out === false) return { allow: false, reason: `${BOUNDARIES_FILE} said not now` };
    if (typeof out === 'object') {
      const o = out as { allow?: unknown; reason?: unknown };
      if (o.allow === false) return { allow: false, reason: typeof o.reason === 'string' && o.reason.trim() ? oneLine(o.reason) : `${BOUNDARIES_FILE} said not now` };
      return { allow: true, ...(typeof o.reason === 'string' && o.reason.trim() ? { reason: oneLine(o.reason) } : {}) };
    }
    return { allow: true };
  } catch (err) {
    return { allow: false, reason: `${BOUNDARIES_FILE} failed: ${oneLine(message(err))}` };
  }
}

// ---------- projects/*.md: the active projects that fit a message ----------

const CLOSED_STATUS = /^(done|archived|closed|complete|completed|paused|dropped|inactive)$/i;

/**
 * v25a: short summaries of the active `<workspace>/projects/*.md` files that fit `query` (same $0 scoring as skills:
 * name, `triggers`, description words), within `maxChars`. '' when there is no `projects/` folder or nothing fits.
 * Never throws.
 */
export async function relevantProjectsSection(dir: string, query: string, maxChars = DEFAULT_PROJECTS_CHARS): Promise<string> {
  try {
    if (!query.trim()) return '';
    const root = path.resolve(dir, PROJECTS_DIR);
    let entries: string[];
    try {
      entries = (await fs.readdir(root)).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort();
    } catch {
      return '';
    }
    const found: Array<{ name: string; score: number; summary: string }> = [];
    for (const f of entries.slice(0, 200)) {
      const file = path.join(root, f);
      if (!inside(root, file)) continue;
      let text: string;
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) continue;
        const handle = await fs.open(file, 'r');
        try {
          const buf = Buffer.alloc(16 * 1024);
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
          text = buf.subarray(0, bytesRead).toString('utf8');
        } finally {
          await handle.close();
        }
      } catch {
        continue;
      }
      const { meta, body } = parseSkillMarkdown(text);
      const status = typeof meta.status === 'string' ? meta.status : '';
      if (CLOSED_STATUS.test(status.trim())) continue;
      const name = (typeof meta.name === 'string' && meta.name) || (typeof meta.title === 'string' && meta.title) || f.replace(/\.md$/, '');
      const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
      const firstLine = body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
      const description = (typeof meta.description === 'string' && meta.description) || firstLine;
      const triggers = Array.isArray(meta.triggers) ? meta.triggers : typeof meta.triggers === 'string' ? meta.triggers.split(',').map((t) => t.trim()) : [];
      const score = Math.max(scoreSkill({ name, description, triggers }, query), heading ? scoreSkill({ name: heading, description: '', triggers: [] }, query) : 0);
      if (score < 2) continue;
      const summary = body.replace(/^#.*$/gm, '').replace(/\n{2,}/g, '\n').trim();
      found.push({ name, score, summary });
    }
    if (!found.length) return '';
    found.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const top = found.slice(0, 3);
    const each = Math.max(200, Math.floor(maxChars / top.length) - 60);
    const parts = top.map((p) => `### ${p.name}\n${p.summary.length > each ? `${p.summary.slice(0, each - 1).trimEnd()}…` : p.summary}`);
    return `## Active projects that fit this (projects/*.md)\n${parts.join('\n\n')}`;
  } catch {
    return '';
  }
}
