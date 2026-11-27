import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Receipt, ScriptContext, ScriptOutput, ToolManifest } from '../types';

/**
 * Packaged tools run out of process. A tool's run.mjs is code Rufus (or a model) wrote, so it gets its own node process
 * with a scrubbed environment plus only the secrets its manifest declares, it can't exit or hang the daemon, and at its
 * deadline its whole process group is killed. ctx.callTool and ctx.act still work: they are relayed to the daemon, so
 * every sub-call still goes through the trust ladder there.
 */

/** What any program needs to run on this Mac (where things are, who is running it, the locale), and nothing secret. */
export const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'RUFUS_DIR'];
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The environment a packaged tool (or its test) gets: the base keys, the secrets it declares, and any extras the engine adds. */
export function toolEnv(manifest: Pick<ToolManifest, 'secrets'> | undefined, from: Record<string, string | undefined> = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [...BASE_ENV_KEYS, ...(manifest?.secrets ?? []).filter((s) => SECRET_NAME.test(s))]) {
    const v = from[k];
    if (typeof v === 'string') env[k] = v;
  }
  return { ...env, ...extra };
}

/** The child's side: import run.mjs, run it once with a relayed ctx, send the output back. */
const RUNNER = String.raw`
const pending = new Map();
let seq = 0;
const controller = new AbortController();
const rpc = (method, args) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); process.send({ type: 'rpc', id, method, args }); });
process.on('disconnect', () => process.exit(1));
process.on('message', async (m) => {
  if (m.type === 'reply') { const r = pending.get(m.id); pending.delete(m.id); r?.(m.result); return; }
  if (m.type !== 'run') return;
  const finish = (msg) => process.send(msg, () => process.exit(0));
  try {
    const mod = await import(m.url);
    if (typeof mod.run !== 'function') throw new Error('run.mjs must export async function run(input, ctx).');
    const c = m.ctx;
    const ctx = {
      workspaceDir: c.workspaceDir, now: new Date(c.now), env: process.env, signal: controller.signal, deadline: c.deadline,
      ...(c.wakeId ? { wakeId: c.wakeId } : {}), ...(c.gapId ? { gapId: c.gapId } : {}),
      callTool: (id, input = {}) => rpc('callTool', [id, input]),
      act: (id, input = {}) => rpc('act', [id, input]),
    };
    const out = await mod.run(m.input, ctx);
    let safe;
    try { safe = out === undefined ? null : JSON.parse(JSON.stringify(out)); } catch (e) { throw new Error('run() returned something that is not plain data: ' + e.message); }
    finish({ type: 'done', out: safe });
  } catch (err) {
    finish({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
});
`;

export interface OutOfProcessRun {
  promise: Promise<ScriptOutput>;
  /** Kills the tool's process and everything it started; returns how many groups it signalled (0 if it was done). */
  kill: () => number;
}

/** Runs one packaged tool call in its own process. */
export function runPackaged(opts: { toolDir: string; manifest: ToolManifest; input: Record<string, unknown>; ctx: ScriptContext }): OutOfProcessRun {
  const { ctx } = opts;
  const child = spawn(process.execPath, ['--input-type=module', '-e', RUNNER], {
    cwd: opts.toolDir,
    env: toolEnv(opts.manifest, ctx.env),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    // Its own process group, so the deadline kills what it started too.
    detached: true,
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  let settled = false;
  const promise = new Promise<ScriptOutput>((resolve, reject) => {
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.on('message', (raw) => {
      const m = raw as { type: string; id?: number; method?: string; args?: [string, Record<string, unknown>]; out?: ScriptOutput; message?: string };
      if (m.type === 'rpc' && m.id !== undefined) {
        const [id, input] = m.args ?? ['', {}];
        const refuse = (why: string): Receipt => ({ toolId: id, effect: 'meta', status: 'failed', durationMs: 0, summary: why, changes: [], error: why, at: new Date().toISOString() });
        const call = m.method === 'callTool' ? ctx.callTool(id, input) : m.method === 'act' && ctx.act ? ctx.act(id, input) : Promise.resolve(refuse(`${m.method} is not available here.`));
        void call
          .catch((err: unknown) => refuse(err instanceof Error ? err.message : String(err)))
          .then((result) => {
            if (child.connected) child.send({ type: 'reply', id: m.id, result });
          });
        return;
      }
      if (m.type === 'done') done(() => resolve(m.out as ScriptOutput));
      if (m.type === 'error') done(() => reject(new Error(m.message ?? 'tool failed')));
    });
    child.on('error', (err) => done(() => reject(err)));
    child.on('exit', (code, signal) =>
      done(() => reject(new Error(`the tool's process exited (${signal ?? `code ${code}`}) before returning${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ''}`))),
    );
  });
  child.send({
    type: 'run',
    url: pathToFileURL(path.join(opts.toolDir, 'run.mjs')).href,
    input: opts.input,
    ctx: { workspaceDir: ctx.workspaceDir, now: ctx.now.toISOString(), deadline: ctx.deadline, ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}), ...(ctx.gapId ? { gapId: ctx.gapId } : {}) },
  });
  return {
    promise,
    kill: () => {
      if (settled && child.exitCode !== null) return 0;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        return 1;
      } catch {
        child.kill('SIGKILL');
        return 1;
      }
    },
  };
}
