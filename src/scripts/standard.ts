import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonSchema, Receipt, ScriptContext, ScriptOutput, ToolManifest, ToolStats } from '../types';

export const MANIFEST_FILE = 'tool.json';
export const RUN_FILE = 'run.mjs';
export const TEST_FILE = 'test.mjs';
export const STATS_FILE = 'stats.json';
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
  };
  await fs.writeFile(path.join(toolDir, STATS_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8').catch(() => undefined);
  return next;
}

function clipData(data: unknown): { data: unknown; truncated: boolean } {
  if (data === undefined) return { data: undefined, truncated: false };
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  if (serialized.length <= MAX_DATA_CHARS) return { data, truncated: false };
  return { data: `${serialized.slice(0, MAX_DATA_CHARS)}…`, truncated: true };
}

/** Runs a packaged tool's run.mjs (or an inline handler) and wraps the outcome into an immutable Receipt. */
export async function executeScript(opts: {
  manifest: ToolManifest;
  input: Record<string, unknown>;
  ctx: ScriptContext;
  toolDir?: string;
  handler?: (input: Record<string, unknown>, ctx: ScriptContext) => Promise<ScriptOutput> | ScriptOutput;
  approved?: boolean;
}): Promise<Receipt> {
  const { manifest, input, ctx, toolDir, handler, approved } = opts;
  const started = Date.now();
  const at = ctx.now.toISOString();

  // 1. Input schema validation
  const inputErrors = validateInput(input, manifest.inputSchema);
  if (inputErrors.length) {
    return {
      toolId: manifest.id,
      effect: manifest.effect,
      status: 'invalid_input',
      durationMs: Date.now() - started,
      summary: `Invalid input for ${manifest.id}: ${inputErrors.join('; ')}`,
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
      summary: `${manifest.id} requires user approval before running. Nothing was changed yet.`,
      changes: [],
      at,
    };
  }

  // 3. Execute with strict timeout
  const timeoutMs = manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const fn = handler ?? (await loadRunFn(toolDir!));
    const raw = await Promise.race([
      Promise.resolve().then(() => fn(input, ctx)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMED_OUT:${timeoutMs}`)), timeoutMs);
        timer.unref?.();
      }),
    ]);

    const durationMs = Date.now() - started;
    if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean' || typeof raw.summary !== 'string') {
      throw new Error(`Script ${manifest.id} violated ScriptOutput contract (must return { ok: boolean, summary: string }).`);
    }

    const stats = toolDir ? await recordToolStats(toolDir, { ok: raw.ok, durationMs, ...(raw.error ? { error: raw.error } : {}), at }) : undefined;
    const clipped = clipData(raw.data);
    // Invariant: 'read' scripts can NEVER report changes.
    const changes = raw.ok && manifest.effect === 'write' && Array.isArray(raw.changes) ? raw.changes.map(String) : [];

    return {
      toolId: manifest.id,
      effect: manifest.effect,
      status: raw.ok ? 'ok' : 'failed',
      durationMs,
      summary: raw.summary,
      changes,
      ...(clipped.data !== undefined ? { data: clipped.data } : {}),
      ...(clipped.truncated ? { truncated: true } : {}),
      ...(raw.error ? { error: raw.error } : {}),
      ...(raw.nextHints?.length ? { nextHints: raw.nextHints } : {}),
      ...(stats && stats.consecutiveFailures >= BROKEN_FAILURE_THRESHOLD
        ? { brokenWarning: `Script ${manifest.id} has failed ${stats.consecutiveFailures} times in a row. Consider running tools.repair.` }
        : {}),
      at,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = msg.startsWith('TIMED_OUT:');
    const error = timedOut ? `Timed out after ${timeoutMs}ms` : msg;
    const stats = toolDir ? await recordToolStats(toolDir, { ok: false, durationMs, error, at }) : undefined;
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
