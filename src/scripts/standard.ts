import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonSchema, Receipt, ScriptContext, ScriptOutput, ToolLesson, ToolManifest, ToolStats } from '../types';
import { withChildScope } from './deadline';
import { protectedTargets } from './protected';

export const MANIFEST_FILE = 'tool.json';
export const RUN_FILE = 'run.mjs';
export const TEST_FILE = 'test.mjs';
export const STATS_FILE = 'stats.json';
export const LESSONS_FILE = 'lessons.json';
/** How many recent outcomes stats keep for the success rate, and how many lessons a tool keeps. */
const RECENT_OUTCOMES = 20;
const MAX_LESSONS = 10;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_DATA_CHARS = 8_000;
export const BROKEN_FAILURE_THRESHOLD = 2;

/** Validates a tool.json manifest strictly. Returns array of error strings (empty = valid). */
export function validateManifest(raw: unknown): { manifest?: ToolManifest; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['manifest must be a JSON object'] };
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(o.id)) {
    errors.push('id must match /^[a-z0-9][a-z0-9._-]{1,63}$/i');
  }
  if (typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 1) {
    errors.push('version must be a positive integer');
  }
  if (typeof o.description !== 'string' || !o.description.trim()) {
    errors.push('description must be a non-empty string');
  }
  if (!Array.isArray(o.whenToUse) || !o.whenToUse.length || !o.whenToUse.every((x) => typeof x === 'string' && x.trim())) {
    errors.push('whenToUse must be a non-empty array of strings');
  }
  if (o.notWhen !== undefined && (!Array.isArray(o.notWhen) || !o.notWhen.every((x) => typeof x === 'string'))) {
    errors.push('notWhen must be an array of strings if provided');
  }
  if (o.effect !== 'read' && o.effect !== 'write' && o.effect !== 'meta') {
    errors.push("effect must be 'read', 'write', or 'meta'");
  }
  if (typeof o.requiresApproval !== 'boolean') {
    errors.push('requiresApproval must be a boolean');
  }
  if (!o.inputSchema || typeof o.inputSchema !== 'object' || (o.inputSchema as JsonSchema).type !== 'object') {
    errors.push('inputSchema must be a JSON schema object with type: "object"');
  }
  if (errors.length) return { errors };
  return { manifest: o as unknown as ToolManifest, errors: [] };
}

/** Validates an input object against a tool's JsonSchema. */
export function validateInput(input: unknown, schema: JsonSchema, at = 'input'): string[] {
  const errs: string[] = [];
  if (schema.type === 'object') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return [`${at} must be an object`];
    }
    const obj = input as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (obj[req] === undefined) errs.push(`${at}.${req} is required`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (!props[k]) {
        if (schema.additionalProperties === false) errs.push(`${at}.${k} is not an allowed property`);
        continue;
      }
      errs.push(...validateInput(v, props[k]!, `${at}.${k}`));
    }
    return errs;
  }
  if (schema.type === 'string' && typeof input !== 'string') errs.push(`${at} must be a string`);
  if (schema.type === 'number' && (typeof input !== 'number' || Number.isNaN(input))) errs.push(`${at} must be a number`);
  if (schema.type === 'boolean' && typeof input !== 'boolean') errs.push(`${at} must be a boolean`);
  if (schema.type === 'array') {
    if (!Array.isArray(input)) errs.push(`${at} must be an array`);
    else if (schema.items) input.forEach((item, i) => errs.push(...validateInput(item, schema.items!, `${at}[${i}]`)));
  }
  if (schema.enum && !schema.enum.includes(input)) errs.push(`${at} must be one of: ${schema.enum.join(', ')}`);
  return errs;
}

export function emptyStats(): ToolStats {
  return { runs: 0, successes: 0, failures: 0, consecutiveFailures: 0, avgMs: 0 };
}

export async function readToolStats(toolDir: string): Promise<ToolStats> {
  try {
    const raw = await fs.readFile(path.join(toolDir, STATS_FILE), 'utf8');
    return { ...emptyStats(), ...(JSON.parse(raw) as Partial<ToolStats>) };
  } catch {
    return emptyStats();
  }
}

export async function recordToolStats(
  toolDir: string,
  outcome: { ok: boolean; durationMs: number; error?: string; at: string },
): Promise<ToolStats> {
  const prev = await readToolStats(toolDir);
  const runs = prev.runs + 1;
  const successes = prev.successes + (outcome.ok ? 1 : 0);
  const failures = prev.failures + (outcome.ok ? 0 : 1);
  const consecutiveFailures = outcome.ok ? 0 : prev.consecutiveFailures + 1;
  const avgMs = Math.round(((prev.avgMs * prev.runs) + outcome.durationMs) / runs);
  const next: ToolStats = {
    runs,
    successes,
    failures,
    consecutiveFailures,
    avgMs,
    lastUsedAt: outcome.at,
    ...(outcome.error ? { lastError: outcome.error } : prev.lastError ? { lastError: prev.lastError } : {}),
    recent: [...(prev.recent ?? []), outcome.ok ? 1 : 0].slice(-RECENT_OUTCOMES),
  };
  await fs.writeFile(path.join(toolDir, STATS_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8').catch(() => undefined);
  return next;
}

interface LessonBook {
  /** The latest unresolved failure per action, waiting for a call that works. */
  open: Record<string, { input: Record<string, unknown>; error: string; at: string }>;
  lessons: ToolLesson[];
}

/** The action a call took (`input.action` for multi-action tools), so a lesson pairs a failure with a fix for the same thing. */
function actionKey(input: Record<string, unknown>): string {
  return typeof input.action === 'string' ? input.action : '';
}

function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  return out;
}

async function readLessonBook(toolDir: string): Promise<LessonBook> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(toolDir, LESSONS_FILE), 'utf8')) as Partial<LessonBook>;
    return { open: raw.open ?? {}, lessons: Array.isArray(raw.lessons) ? raw.lessons : [] };
  } catch {
    return { open: {}, lessons: [] };
  }
}

/** The newest lessons first. */
export async function readToolLessons(toolDir: string, limit = 3): Promise<ToolLesson[]> {
  return (await readLessonBook(toolDir)).lessons.slice(-limit).reverse();
}

/**
 * Learns from failures: a failed call is remembered per action; when a later call of the same action works,
 * the working input is saved next to the error as a lesson on the tool.
 */
export async function recordLessonOutcome(
  toolDir: string,
  outcome: { ok: boolean; input: Record<string, unknown>; error?: string; at: string },
): Promise<ToolLesson | undefined> {
  const book = await readLessonBook(toolDir);
  const key = actionKey(outcome.input);
  let learned: ToolLesson | undefined;
  if (!outcome.ok) {
    book.open[key] = { input: clipInput(outcome.input), error: (outcome.error ?? 'failed').slice(0, 400), at: outcome.at };
  } else {
    const failed = book.open[key];
    if (!failed) return undefined;
    delete book.open[key];
    if (JSON.stringify(failed.input) !== JSON.stringify(clipInput(outcome.input))) {
      learned = { ...(key ? { action: key } : {}), error: failed.error, failedInput: failed.input, workingInput: clipInput(outcome.input), at: outcome.at };
      book.lessons = [...book.lessons, learned].slice(-MAX_LESSONS);
    }
  }
  await fs.writeFile(path.join(toolDir, LESSONS_FILE), `${JSON.stringify(book, null, 2)}\n`, 'utf8').catch(() => undefined);
  return learned;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(process.env.HOME ?? '', p.slice(2)) : p;
}

/**
 * Says what was really missing behind a "spawn X ENOENT": node reports a missing working directory the same way as a
 * missing program, which once led Rufus to conclude git was not installed when the repo path was wrong.
 */
export async function explainError(error: string, input: Record<string, unknown>): Promise<string> {
  const m = /spawn (\S+) ENOENT/.exec(error);
  if (!m) return error;
  const missing: string[] = [];
  for (const v of Object.values(input)) {
    if (typeof v !== 'string' || !/^(\/|~\/)/.test(v.trim()) || v.includes('\n')) continue;
    const p = expandHome(v.trim());
    if (!(await fs.stat(p).then(() => true, () => false))) missing.push(p);
  }
  if (missing.length) return `${error} (the program is fine: ${missing.map((p) => `"${p}"`).join(', ')} does not exist, so the working directory or path is wrong)`;
  const bin = m[1]!;
  const onPath = path.isAbsolute(bin)
    ? await fs.stat(bin).then(() => true, () => false)
    : (
        await Promise.all(
          (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => fs.stat(path.join(d, bin)).then(() => true, () => false)),
        )
      ).some(Boolean);
  return onPath
    ? `${error} (${bin} is installed and on PATH, so a working directory or file the call used is missing)`
    : `${error} (${bin} was not found on PATH: ${process.env.PATH ?? '(empty)'})`;
}

/** Reads get a larger budget: what they return is the point of calling them (files.read returns up to 24k). */
export const MAX_READ_DATA_CHARS = 24_000;

/** Cuts receipt data to a budget and says so in the data, so a partial read is never mistaken for the whole thing. */
function clipData(data: unknown, budget = MAX_DATA_CHARS): { data: unknown; truncated: boolean } {
  if (data === undefined) return { data: undefined, truncated: false };
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  if (serialized.length <= budget) return { data, truncated: false };
  return {
    data: `${serialized.slice(0, budget)}… [TRUNCATED: showing ${budget} of ${serialized.length} chars; ask for the rest (e.g. files.read with startLine) rather than guessing]`,
    truncated: true,
  };
}

/** Runs a packaged tool's run.mjs (or an inline handler) and wraps the outcome into an immutable Receipt. */
export async function executeScript(opts: {
  manifest: ToolManifest;
  input: Record<string, unknown>;
  ctx: ScriptContext;
  toolDir?: string;
  handler?: (input: Record<string, unknown>, ctx: ScriptContext) => Promise<ScriptOutput> | ScriptOutput;
  approved?: boolean;
  /** The owner approved this exact input (approvals.approve): lets a write touch protected files. */
  ownerApproved?: boolean;
}): Promise<Receipt> {
  const { manifest, input, toolDir, handler, approved, ownerApproved } = opts;
  const started = Date.now();
  const at = opts.ctx.now.toISOString();
  const learn = (ok: boolean, error?: string) =>
    toolDir ? recordLessonOutcome(toolDir, { ok, input, ...(error ? { error } : {}), at }).catch(() => undefined) : undefined;

  // 1. Input schema validation
  const inputErrors = validateInput(input, manifest.inputSchema);
  if (inputErrors.length) {
    await learn(false, `invalid input: ${inputErrors.join('; ')}`);
    return {
      toolId: manifest.id,
      effect: manifest.effect,
      status: 'invalid_input',
      durationMs: Date.now() - started,
      summary: `Invalid input for ${manifest.id}: ${inputErrors.join('; ')}. Nothing ran. Fix the input to match its inputSchema.`,
      changes: [],
      error: inputErrors.join('; '),
      at,
    };
  }

  // 2. Approval gate (engine-enforced before any code runs)
  if (manifest.requiresApproval && !approved) {
    return {
      toolId: manifest.id,
      effect: manifest.effect,
      status: 'pending_approval',
      durationMs: Date.now() - started,
      summary: `${manifest.id} needs the owner's approval before it runs. Nothing was changed yet.`,
      changes: [],
      at,
    };
  }

  // 3. Protected targets: no write tool rewrites the trust files, tool manifests or gate code without the owner's yes to this exact change.
  if (manifest.effect === 'write' && !ownerApproved) {
    const hits = protectedTargets(input, { workspaceDir: opts.ctx.workspaceDir });
    if (hits.length) {
      return {
        toolId: manifest.id,
        effect: manifest.effect,
        status: 'pending_approval',
        durationMs: Date.now() - started,
        summary: `${manifest.id} would touch ${hits.join(', ')}, which only the owner can approve (this exact change). Nothing was changed yet.`,
        changes: [],
        error: `protected: ${hits.join(', ')}`,
        at,
      };
    }
  }

  // 4. Execute under a deadline: the script sees it (ctx.signal), and on timeout the child processes it started are killed.
  const timeoutMs = manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const ctx: ScriptContext = { ...opts.ctx, signal: controller.signal, deadline: started + timeoutMs };
  let timer: NodeJS.Timeout | undefined;
  let killChildren: () => number = () => 0;
  try {
    const fn = handler ?? (await loadRunFn(toolDir!));
    const scoped = withChildScope(() => Promise.resolve().then(() => fn(input, ctx)));
    killChildren = scoped.killChildren;
    const raw = await Promise.race([
      scoped.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMED_OUT:${timeoutMs}`)), timeoutMs);
        timer.unref?.();
      }),
    ]);

    const durationMs = Date.now() - started;
    if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean' || typeof raw.summary !== 'string') {
      throw new Error(`Script ${manifest.id} violated ScriptOutput contract (must return { ok: boolean, summary: string }).`);
    }

    const error = raw.error ? await explainError(String(raw.error), input) : undefined;
    const stats = toolDir ? await recordToolStats(toolDir, { ok: raw.ok, durationMs, ...(error ? { error } : {}), at }) : undefined;
    await learn(raw.ok, error);
    const clipped = clipData(raw.data, manifest.effect === 'read' ? MAX_READ_DATA_CHARS : MAX_DATA_CHARS);
    // Invariant: 'read' scripts can NEVER report changes.
    const changes = raw.ok && manifest.effect === 'write' && Array.isArray(raw.changes) ? raw.changes.map(String) : [];
    const asyncWork =
      raw.ok && raw.asyncWork && raw.asyncWork.kind === 't3_thread' && typeof raw.asyncWork.threadId === 'string' && raw.asyncWork.threadId.trim()
        ? { kind: raw.asyncWork.kind, threadId: raw.asyncWork.threadId.trim(), ...(raw.asyncWork.label ? { label: String(raw.asyncWork.label) } : {}) }
        : undefined;

    return {
      toolId: manifest.id,
      effect: manifest.effect,
      status: raw.ok ? 'ok' : 'failed',
      durationMs,
      summary: raw.summary,
      changes,
      ...(clipped.data !== undefined ? { data: clipped.data } : {}),
      ...(clipped.truncated ? { truncated: true } : {}),
      ...(error ? { error } : {}),
      ...(raw.nextHints?.length ? { nextHints: raw.nextHints } : {}),
      ...(asyncWork ? { asyncWork } : {}),
      ...(stats && stats.consecutiveFailures >= BROKEN_FAILURE_THRESHOLD
        ? { brokenWarning: `Script ${manifest.id} has failed ${stats.consecutiveFailures} times in a row. Consider running tools.repair.` }
        : {}),
      at,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = msg.startsWith('TIMED_OUT:');
    let error = timedOut ? `Timed out after ${timeoutMs}ms` : await explainError(msg, input);
    if (timedOut) {
      controller.abort(new Error(error));
      const killed = killChildren();
      if (killed) error += ` (stopped ${killed} child process${killed === 1 ? '' : 'es'} it started)`;
    }
    const stats = toolDir ? await recordToolStats(toolDir, { ok: false, durationMs, error, at }) : undefined;
    await learn(false, error);
    return {
      toolId: manifest.id,
      effect: manifest.effect,
      status: timedOut ? 'timed_out' : 'failed',
      durationMs,
      summary: `${manifest.id} failed: ${error}`,
      changes: [],
      error,
      ...(stats && stats.consecutiveFailures >= BROKEN_FAILURE_THRESHOLD
        ? { brokenWarning: `Script ${manifest.id} has failed ${stats.consecutiveFailures} times in a row. Consider running tools.repair.` }
        : {}),
      at,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadRunFn(toolDir: string): Promise<(input: Record<string, unknown>, ctx: ScriptContext) => Promise<ScriptOutput> | ScriptOutput> {
  const file = path.join(toolDir, RUN_FILE);
  const stat = await fs.stat(file);
  const url = `${pathToFileURL(file).href}?m=${Math.round(stat.mtimeMs * 1000)}-${stat.size}`;
  const mod = (await import(/* @vite-ignore */ url)) as { run?: unknown };
  if (typeof mod.run !== 'function') throw new Error(`${RUN_FILE} must export async function run(input, ctx).`);
  return mod.run as (input: Record<string, unknown>, ctx: ScriptContext) => Promise<ScriptOutput> | ScriptOutput;
}
