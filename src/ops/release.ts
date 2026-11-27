import { execFile, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, mkdirSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordOpsFailure } from '../eval/ops-log';
import { RUFUS_REPO_DIR } from '../scripts/protected';

/**
 * Promoted builds. The daemon runs from `<releases>/current`, a symlink to a git worktree of one checked commit,
 * never from the working tree other agents edit. `promote` builds a commit's release, checks it (typecheck, tests,
 * `rufus verify`), switches the daemon to it, and rolls back to the previous release if /health doesn't come up.
 */

export const DAEMON_LABEL = 'com.rufus.daemon';

/** Where release checkouts live: outside the workspace, so workspace copies (replays) never carry node_modules. */
export function defaultReleasesDir(): string {
  return process.env.RUFUS_RELEASES_DIR || path.join(os.homedir(), '.rufus-releases');
}

/** The repo commits land in. A release is a worktree of it, so its own dir is not where self-upgrades should land. */
export function sourceRepoDir(): string {
  return process.env.RUFUS_SOURCE_DIR || RUFUS_REPO_DIR;
}

export function launchAgentPath(label: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

export function defaultHealthUrl(): string {
  return `http://127.0.0.1:${Number(process.env.RUFUS_HTTP_PORT || 8787)}/health`;
}

export interface ReleaseHistoryEntry {
  at: string;
  commit: string;
  result: 'promoted' | 'restarted' | 'rolled_back' | 'checks_failed' | 'prepared' | 'not_switched' | 'unhealthy';
  /** The release that ran before this one (what a rollback returns to). */
  from?: string;
  detail?: string;
  reason?: string;
}

export interface ReleaseState {
  current?: string;
  previous?: string;
  /** Commits whose release passed every check (a re-promote skips the checks). */
  checked: string[];
  history: ReleaseHistoryEntry[];
}

export interface DaemonHealth {
  ok: boolean;
  build?: string;
  pid?: number;
  startedAt?: string;
}

export type Runner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<{ ok: boolean; out: string }>;

const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: '0' } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}` }),
    );
  });

export interface ReleaseCheck {
  name: string;
  cmd: string;
  args: string[];
  timeoutMs?: number;
  /** Reads the output of a check that exited 0 (or not): undefined = pass, else why it failed. */
  judge?: (out: string, exitOk: boolean) => string | undefined;
}

/**
 * Judges `rufus verify --json`: every `loop` check (the code's behaviour, in a scratch workspace) must pass.
 * `live` checks measure the running daemon and the live data, which a build that isn't running yet can't fix, so they only warn.
 */
export function judgeVerify(out: string, exitOk: boolean): string | undefined {
  const line = out.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
  if (!line) return exitOk ? undefined : `rufus verify failed:\n${out.slice(-1500)}`;
  try {
    const res = JSON.parse(line) as { checks?: Array<{ item: number; component: string; passed: boolean; detail: string; where: string }> };
    const failing = (res.checks ?? []).filter((c) => !c.passed && c.where !== 'live');
    return failing.length ? `rufus verify: ${failing.length} failing: ${failing.map((c) => `${c.item}. ${c.component}`).join('; ')}` : undefined;
  } catch {
    return exitOk ? undefined : `rufus verify output was unreadable:\n${out.slice(-1500)}`;
  }
}

export function defaultChecks(): ReleaseCheck[] {
  return [
    { name: 'typecheck', cmd: 'node_modules/.bin/tsc', args: ['--noEmit'] },
    { name: 'tests', cmd: 'node_modules/.bin/vitest', args: ['run'], timeoutMs: 600_000 },
    { name: 'rufus verify', cmd: process.execPath, args: ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', 'verify', '--json'], timeoutMs: 300_000, judge: judgeVerify },
  ];
}

export interface PromoteDeps {
  sourceDir: string;
  releasesDir: string;
  workspaceDir: string;
  /** The daemon's launchd plist: promote only switches a daemon that runs from `<releases>/current`. */
  plistPath: string;
  run?: Runner;
  checks?: ReleaseCheck[];
  /** Installs dependencies in a fresh release checkout. */
  install?: (dir: string) => Promise<{ ok: boolean; out: string }>;
  restartDaemon?: () => Promise<void>;
  health?: () => Promise<DaemonHealth | undefined>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => Date;
  /** How long a restarted daemon has to report the new build on /health. */
  healthTimeoutMs?: number;
  /** It must still be up, as the same process, this long after (a crash loop answers once, then dies). */
  stableMs?: number;
  pollMs?: number;
  keepReleases?: number;
}

export interface PromoteResult {
  ok: boolean;
  commit?: string;
  switched: boolean;
  rolledBack?: boolean;
  summary: string;
}

const short = (sha: string) => sha.slice(0, 12);

export async function readReleaseState(releasesDir: string): Promise<ReleaseState> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(releasesDir, 'state.json'), 'utf8')) as Partial<ReleaseState>;
    return { ...raw, checked: Array.isArray(raw.checked) ? raw.checked : [], history: Array.isArray(raw.history) ? raw.history : [] };
  } catch {
    return { checked: [], history: [] };
  }
}

async function writeState(releasesDir: string, state: ReleaseState): Promise<void> {
  const file = path.join(releasesDir, 'state.json');
  const tmp = `${file}.${process.pid}.tmp`;
  const trimmed = { ...state, checked: state.checked.slice(-20), history: state.history.slice(-50) };
  await fs.writeFile(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

/** Does the launchd job run the daemon from `<releases>/current`? Until the cutover it runs the working tree. */
export function runsFromRelease(plistPath: string, releasesDir: string): boolean {
  try {
    return readFileSync(plistPath, 'utf8').includes(path.join(releasesDir, 'current'));
  } catch {
    return false;
  }
}

/** Swaps the `current` symlink in one rename, so a launchd restart never sees it missing. */
async function pointCurrent(releasesDir: string, dirName: string): Promise<void> {
  const link = path.join(releasesDir, 'current');
  const tmp = `${link}.${process.pid}.tmp`;
  await fs.rm(tmp, { force: true });
  await fs.symlink(dirName, tmp);
  await fs.rename(tmp, link);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function takeLock(releasesDir: string): Promise<(() => Promise<void>) | undefined> {
  const lock = path.join(releasesDir, 'promote.lock');
  for (let i = 0; i < 2; i++) {
    try {
      await fs.writeFile(lock, String(process.pid), { flag: 'wx' });
      return () => fs.rm(lock, { force: true });
    } catch {
      const holder = Number((await fs.readFile(lock, 'utf8').catch(() => '')).trim());
      if (holder && holder !== process.pid && pidAlive(holder)) return undefined;
      await fs.rm(lock, { force: true });
    }
  }
  return undefined;
}

export async function fetchHealth(url = defaultHealthUrl()): Promise<DaemonHealth | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as DaemonHealth;
    return { ...body, ok: res.ok && body.ok === true };
  } catch {
    return undefined;
  }
}

export function kickstartDaemon(label = DAEMON_LABEL): Promise<void> {
  const uid = process.getuid ? process.getuid() : 501;
  return new Promise((resolve, reject) =>
    execFile('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { timeout: 30_000 }, (err) => (err ? reject(err) : resolve())),
  );
}

/**
 * Builds, checks, switches and health-checks one commit (default: the source repo's HEAD).
 * - Already the running release: just restart it, with the same health check and rollback.
 * - `prepare`: before the cutover, build and check a release and point `current` at it without touching the daemon.
 */
export async function promote(deps: PromoteDeps, opts: { ref?: string; prepare?: boolean; reason?: string } = {}): Promise<PromoteResult> {
  const run = deps.run ?? defaultRunner;
  const log = deps.log ?? ((l: string) => console.log(l));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const health = deps.health ?? (() => fetchHealth());
  const restart = deps.restartDaemon ?? (() => kickstartDaemon());
  const { releasesDir, sourceDir } = deps;
  await fs.mkdir(releasesDir, { recursive: true });

  const unlock = await takeLock(releasesDir);
  if (!unlock) return { ok: false, switched: false, summary: 'Another promote is running; nothing changed.' };
  const history = async (entry: Omit<ReleaseHistoryEntry, 'at'>, patch: Partial<ReleaseState> = {}) => {
    const state = await readReleaseState(releasesDir);
    await writeState(releasesDir, { ...state, ...patch, history: [...state.history, { at: now().toISOString(), ...entry, ...(opts.reason ? { reason: opts.reason } : {}) }] });
  };
  const fail = async (commit: string, detail: string, result: ReleaseHistoryEntry['result'], extra: Partial<PromoteResult> = {}) => {
    await history({ commit, result, detail: detail.slice(0, 1500) });
    await recordOpsFailure(deps.workspaceDir, { kind: 'promote_failed', error: `${short(commit)}: ${detail}` });
    return { ok: false, commit, switched: false, summary: detail, ...extra };
  };

  try {
    const rev = await run('git', ['-C', sourceDir, 'rev-parse', '--verify', `${opts.ref || 'HEAD'}^{commit}`], { cwd: sourceDir, timeoutMs: 15_000 });
    const commit = rev.out.trim().split('\n')[0] ?? '';
    if (!rev.ok || !/^[0-9a-f]{40}$/.test(commit)) return { ok: false, switched: false, summary: `Unknown commit "${opts.ref || 'HEAD'}": ${rev.out.trim().slice(0, 200)}` };

    const state = await readReleaseState(releasesDir);
    const cutOver = runsFromRelease(deps.plistPath, releasesDir);
    const dir = path.join(releasesDir, short(commit));
    const sameAsRunning = state.current === commit && existsSync(dir);

    // 1. Build and check the release (skipped for a commit that already passed).
    if (!sameAsRunning || !state.checked.includes(commit)) {
      const head = existsSync(dir) ? (await run('git', ['-C', dir, 'rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 15_000 })).out.trim() : '';
      if (head !== commit) {
        if (existsSync(dir)) {
          await run('git', ['-C', sourceDir, 'worktree', 'remove', '--force', dir], { cwd: sourceDir });
          await fs.rm(dir, { recursive: true, force: true });
        }
        log(`Building release ${short(commit)} in ${dir}`);
        const add = await run('git', ['-C', sourceDir, 'worktree', 'add', '--detach', dir, commit], { cwd: sourceDir, timeoutMs: 60_000 });
        if (!add.ok) return await fail(commit, `could not check out the release: ${add.out.trim().slice(0, 500)}`, 'checks_failed');
      }
      if (!existsSync(path.join(dir, 'node_modules'))) {
        const installed = await (deps.install ?? ((d: string) => run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: d, timeoutMs: 300_000 })))(dir);
        if (!installed.ok) return await fail(commit, `dependency install failed: ${installed.out.trim().slice(-800)}`, 'checks_failed');
      }
      if (!state.checked.includes(commit)) {
        for (const check of deps.checks ?? defaultChecks()) {
          log(`Checking ${short(commit)}: ${check.name}`);
          const res = await run(check.cmd, check.args, { cwd: dir, ...(check.timeoutMs ? { timeoutMs: check.timeoutMs } : {}) });
          const why = check.judge ? check.judge(res.out, res.ok) : res.ok ? undefined : `${check.name} failed:\n${res.out.trim().slice(-1500)}`;
          if (why) return await fail(commit, `${short(commit)} not promoted, ${why}`, 'checks_failed');
        }
        const fresh = await readReleaseState(releasesDir);
        await writeState(releasesDir, { ...fresh, checked: [...fresh.checked.filter((c) => c !== commit), commit] });
      }
    }

    // 2. Before the cutover the daemon runs the working tree: never touch it.
    if (!cutOver) {
      if (opts.prepare) {
        await pointCurrent(releasesDir, short(commit));
        await history({ commit, result: 'prepared', ...(state.current ? { from: state.current } : {}) }, { current: commit, ...(state.current && state.current !== commit ? { previous: state.current } : {}) });
        return { ok: true, commit, switched: false, summary: `Release ${short(commit)} is checked and is now ${path.join(releasesDir, 'current')}. The daemon still runs the working tree until its plist points there.` };
      }
      await history({ commit, result: 'not_switched', detail: 'the daemon does not run from the release checkout yet' });
      return { ok: true, commit, switched: false, summary: `Release ${short(commit)} passed its checks, but the daemon does not run from ${path.join(releasesDir, 'current')} yet, so nothing was switched.` };
    }

    // 3. Switch and health-check; roll back to the previous release if it doesn't come up.
    const before = await health();
    const fallback = sameAsRunning ? state.previous : state.current;
    if (!sameAsRunning) await pointCurrent(releasesDir, short(commit));
    log(`${sameAsRunning ? 'Restarting' : 'Switching the daemon to'} ${short(commit)}`);
    await restart().catch((err: unknown) => log(`restart failed: ${(err as Error).message}`));
    const up = await waitHealthy(commit, before?.pid, { health, sleep, timeoutMs: deps.healthTimeoutMs ?? 120_000, stableMs: deps.stableMs ?? 20_000, pollMs: deps.pollMs ?? 2_000 });
    if (up.ok) {
      await history(
        { commit, result: sameAsRunning ? 'restarted' : 'promoted', ...(state.current && !sameAsRunning ? { from: state.current } : {}) },
        sameAsRunning ? {} : { current: commit, ...(state.current ? { previous: state.current } : {}) },
      );
      await prune(releasesDir, sourceDir, run, deps.keepReleases ?? 3);
      return { ok: true, commit, switched: !sameAsRunning, summary: `Daemon is running ${short(commit)} and healthy (pid ${up.pid}).` };
    }

    if (!fallback || fallback === commit || !existsSync(path.join(releasesDir, short(fallback)))) {
      return await fail(commit, `${short(commit)} did not come up healthy (${up.detail}) and there is no earlier release to roll back to.`, 'unhealthy', { switched: !sameAsRunning });
    }
    log(`${short(commit)} unhealthy (${up.detail}); rolling back to ${short(fallback)}`);
    await pointCurrent(releasesDir, short(fallback));
    const failedState = await readReleaseState(releasesDir);
    await writeState(releasesDir, {
      ...failedState,
      current: fallback,
      ...(sameAsRunning ? {} : state.previous ? { previous: state.previous } : {}),
      // A build that passed its checks but didn't boot is checked again next time.
      checked: failedState.checked.filter((c) => c !== commit),
    });
    const beforeBack = await health();
    await restart().catch((err: unknown) => log(`restart failed: ${(err as Error).message}`));
    const back = await waitHealthy(fallback, beforeBack?.pid, { health, sleep, timeoutMs: deps.healthTimeoutMs ?? 120_000, stableMs: deps.stableMs ?? 20_000, pollMs: deps.pollMs ?? 2_000 });
    const detail = `${short(commit)} did not come up healthy (${up.detail}); rolled back to ${short(fallback)}${back.ok ? ', which is healthy' : `, which is not healthy either (${back.detail})`}.`;
    return await fail(commit, detail, 'rolled_back', { rolledBack: true, switched: false });
  } finally {
    await unlock();
  }
}

/** Waits until /health reports `commit` from a new process, and that process is still up `stableMs` later. */
export async function waitHealthy(
  commit: string,
  oldPid: number | undefined,
  o: { health: () => Promise<DaemonHealth | undefined>; sleep: (ms: number) => Promise<void>; timeoutMs: number; stableMs: number; pollMs: number },
): Promise<{ ok: boolean; pid?: number; detail: string }> {
  const deadline = Date.now() + o.timeoutMs;
  let last = 'no answer on /health';
  while (Date.now() < deadline) {
    const h = await o.health();
    if (!h) last = 'no answer on /health';
    else if (!h.ok) last = '/health not ok';
    else if (h.build !== commit) last = `/health reports build ${h.build ? short(h.build) : 'unknown'}`;
    else if (oldPid !== undefined && h.pid === oldPid) last = 'the old process is still answering';
    else {
      await o.sleep(o.stableMs);
      const again = await o.health();
      if (again?.ok && again.build === commit && again.pid === h.pid) return { ok: true, ...(h.pid !== undefined ? { pid: h.pid } : {}), detail: 'healthy' };
      last = 'came up, then went down again';
    }
    await o.sleep(o.pollMs);
  }
  return { ok: false, detail: last };
}

/** Keeps the running and previous releases plus a few recent ones; removes the rest. */
async function prune(releasesDir: string, sourceDir: string, run: Runner, keep: number): Promise<void> {
  const state = await readReleaseState(releasesDir);
  const pinned = new Set([state.current, state.previous].filter((c): c is string => !!c).map(short));
  const entries = await fs.readdir(releasesDir, { withFileTypes: true }).catch(() => []);
  const dirs = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && /^[0-9a-f]{12}$/.test(e.name))
      .map(async (e) => ({ name: e.name, mtime: (await fs.stat(path.join(releasesDir, e.name))).mtimeMs })),
  );
  const recent = new Set(dirs.sort((a, b) => b.mtime - a.mtime).slice(0, keep).map((d) => d.name));
  for (const d of dirs) {
    if (pinned.has(d.name) || recent.has(d.name)) continue;
    const dir = path.join(releasesDir, d.name);
    await run('git', ['-C', sourceDir, 'worktree', 'remove', '--force', dir], { cwd: sourceDir });
    await fs.rm(dir, { recursive: true, force: true });
  }
  await run('git', ['-C', sourceDir, 'worktree', 'prune'], { cwd: sourceDir });
}

/**
 * What a running daemon calls to restart onto new code (self.restart, a landed self-upgrade): promote in a detached
 * process that outlives this one, logging to `logs/promote.log`. Before the cutover it falls back to a plain kickstart.
 */
export function requestPromote(opts: { workspaceDir: string; reason: string; ref?: string; releasesDir?: string; plistPath?: string; codeDir?: string }): { mode: 'promote' | 'kickstart' } {
  const releasesDir = opts.releasesDir ?? defaultReleasesDir();
  const plistPath = opts.plistPath ?? launchAgentPath(DAEMON_LABEL);
  if (!runsFromRelease(plistPath, releasesDir)) {
    const uid = process.getuid ? process.getuid() : 501;
    spawn('/bin/sh', ['-c', `sleep 2 && launchctl kickstart -k gui/${uid}/${DAEMON_LABEL}`], { detached: true, stdio: 'ignore' }).unref();
    return { mode: 'kickstart' };
  }
  const codeDir = opts.codeDir ?? RUFUS_REPO_DIR;
  const logs = path.join(opts.workspaceDir, 'logs');
  mkdirSync(logs, { recursive: true });
  const out = openSync(path.join(logs, 'promote.log'), 'a');
  const args = [path.join(codeDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(codeDir, 'src', 'cli.ts'), 'promote', ...(opts.ref ? [opts.ref] : []), '--reason', opts.reason];
  spawn(process.execPath, args, { cwd: opts.workspaceDir, detached: true, stdio: ['ignore', out, out], env: process.env }).unref();
  return { mode: 'promote' };
}
