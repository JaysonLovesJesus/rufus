import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ScriptContext, ScriptOutput } from '../types';
import { RUFUS_REPO_DIR } from './protected';
import type { ToolRegistry } from './registry';

const execFileAsync = promisify(execFile);

/** Self-commits share one neutral author; the trailers say which wake and gap made them. */
const NEUTRAL_AUTHOR = {
  GIT_AUTHOR_NAME: 'Rufus Contributors',
  GIT_AUTHOR_EMAIL: 'noreply@rufus.invalid',
  GIT_COMMITTER_NAME: 'Rufus Contributors',
  GIT_COMMITTER_EMAIL: 'noreply@rufus.invalid',
};
const DEFAULT_CHECKS = [
  ['node_modules/.bin/tsc', '--noEmit'],
  ['node_modules/.bin/vitest', 'run'],
];
const CHECK_TIMEOUT_MS = 120_000;

export interface SelfUpgradeOptions {
  /** The repo to upgrade (default: the repo this code runs from). */
  repoDir?: string;
  /** Commands that must pass in the worktree before the change can land (default: typecheck, then tests). */
  checks?: string[][];
  /** Schedules a daemon restart once a change has landed. */
  restart?: () => void;
  /** Opens a pull request from a pushed branch (default: `git push` + `gh pr create`). Injectable for tests. */
  createPr?: (opts: { cwd: string; branch: string; title: string; body: string }) => Promise<{ url: string }>;
}

const PRIVACY_LEAK_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'absolute macOS/Linux user home path', re: /\/(?:Users|home)\/[a-zA-Z0-9._-]+\// },
  { label: 'OpenAI/Anthropic/Stripe secret key', re: /\b(?:sk-[a-zA-Z0-9_-]{16,}|rk_live_[a-zA-Z0-9]{16,})\b/ },
  { label: 'GitHub personal access token', re: /\bgh[pousr]_[a-zA-Z0-9]{20,}\b/ },
  { label: 'Slack/Telegram bot token', re: /\b(?:xox[baprs]-[a-zA-Z0-9-]{10,}|\d{8,12}:[a-zA-Z0-9_-]{30,})\b/ },
  { label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** Scans added diff/replacement text before pushing an upstream PR to block personal paths or secrets. */
export function scanForPrivacyLeaks(text: string): string[] {
  const hits: string[] = [];
  for (const p of PRIVACY_LEAK_PATTERNS) {
    if (p.re.test(text)) hits.push(p.label);
  }
  return hits;
}

async function defaultCreatePr(opts: { cwd: string; branch: string; title: string; body: string }): Promise<{ url: string }> {
  await git(opts.cwd, ['push', '-u', 'origin', opts.branch]);
  const { stdout } = await execFileAsync('gh', ['pr', 'create', '--head', opts.branch, '--title', opts.title, '--body', opts.body], {
    cwd: opts.cwd,
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { url: stdout.trim().split('\n').pop()?.trim() || opts.branch };
}

function defaultRestart(): void {
  const uid = process.getuid ? process.getuid() : 501;
  const child = spawn('/bin/sh', ['-c', `sleep 3 && launchctl kickstart -k gui/${uid}/com.rufus.daemon`], { detached: true, stdio: 'ignore' });
  child.unref();
}

/** Replaces the first exact occurrence (no `$` patterns, unlike String.replace). */
function replaceOnce(text: string, find: string, replace: string): string | undefined {
  const i = text.indexOf(find);
  return i < 0 ? undefined : `${text.slice(0, i)}${replace}${text.slice(i + find.length)}`;
}

async function git(cwd: string, args: string[], extra: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...(extra.env ? { env: extra.env } : {}), ...(extra.signal ? { signal: extra.signal } : {}) });
  return stdout.trim();
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr?.trim() || e.stdout?.trim() || e.message || String(err)).slice(0, 1500);
}

/**
 * Applies an engine edit in its own git worktree and branch, runs the checks there, and commits with
 * `Rufus-Wake:` / `Rufus-Gap:` trailers. The commit lands on the live tree only when the target file has no
 * uncommitted changes from anyone else (and fast-forwards cleanly); otherwise the branch is handed back.
 * The live working tree is never written to directly, so nobody's work in progress can be committed or wiped.
 */
export async function upgradeInWorktree(
  req: {
    relativePath: string;
    find: string;
    replace: string;
    commitMessage?: string;
    wakeId?: string;
    gapId?: string;
    openPr?: boolean;
    prTitle?: string;
    prBody?: string;
  },
  opts: SelfUpgradeOptions & { signal?: AbortSignal } = {},
): Promise<ScriptOutput & { landed?: boolean; branch?: string; prUrl?: string }> {
  const repo = opts.repoDir ?? RUFUS_REPO_DIR;
  const rel = path.posix.normalize(req.relativePath.trim().replace(/\\/g, '/'));
  if (!rel.startsWith('src/') || rel.includes('..')) {
    return { ok: false, summary: 'Engine edits are restricted to src/ files.', error: 'invalid relativePath' };
  }
  if (req.openPr) {
    const leaks = scanForPrivacyLeaks(`${req.replace}\n${req.commitMessage ?? ''}\n${req.prTitle ?? ''}\n${req.prBody ?? ''}`);
    if (leaks.length) {
      return {
        ok: false,
        summary: `Blocked upstream PR for ${rel}: privacy scan flagged ${leaks.join(', ')}. Keep personal paths and secrets out of the repo.`,
        error: 'privacy_scan_failed',
      };
    }
  }
  const signal = opts.signal;
  const stampId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const branch = `rufus/self-upgrade-${stampId}-${Math.random().toString(36).slice(2, 6)}`;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rufus-upgrade-'));
  const wt = path.join(tmp, 'wt');
  let worktreeAdded = false;
  let keepBranch = false;
  try {
    const base = await git(repo, ['rev-parse', 'HEAD'], { ...(signal ? { signal } : {}) });
    const dirtyBefore = await git(repo, ['status', '--porcelain', '--', rel]);
    await git(repo, ['worktree', 'add', '-b', branch, wt, base]);
    worktreeAdded = true;
    const nodeModules = path.join(repo, 'node_modules');
    if (await fs.stat(nodeModules).then(() => true, () => false)) await fs.symlink(nodeModules, path.join(wt, 'node_modules'), 'dir');

    const file = path.join(wt, rel);
    const prev = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (prev === undefined) return { ok: false, summary: `${rel} does not exist in the committed code.`, error: 'file not found' };
    const next = replaceOnce(prev, req.find, req.replace);
    if (next === undefined) return { ok: false, summary: `Could not find the target snippet in the committed ${rel}.`, error: 'find text not matched' };
    await fs.writeFile(file, next, 'utf8');

    for (const cmd of opts.checks ?? DEFAULT_CHECKS) {
      try {
        await execFileAsync(cmd[0]!, cmd.slice(1), { cwd: wt, timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) });
      } catch (err) {
        return { ok: false, summary: `Upgrade to ${rel} failed \`${cmd.join(' ')}\` in its worktree; nothing changed in the live code.`, error: errText(err) };
      }
    }

    const subject = String(req.commitMessage || `chore(self): update ${rel}`).split('\n')[0]!.slice(0, 120);
    const trailers = `Rufus-Wake: ${req.wakeId ?? 'none'}\nRufus-Gap: ${req.gapId ?? 'none'}`;
    await git(wt, ['add', '--', rel]);
    await git(wt, ['commit', '-m', subject, '-m', trailers], { env: { ...process.env, ...NEUTRAL_AUTHOR } });

    if (req.openPr) {
      keepBranch = true;
      const prTitle = (req.prTitle?.trim() || subject).slice(0, 120);
      const prBody = (req.prBody?.trim() || `Automated self-upgrade to \`${rel}\`.\n\n${trailers}`).slice(0, 4000);
      const pr = await (opts.createPr ?? defaultCreatePr)({ cwd: wt, branch, title: prTitle, body: prBody });
      return {
        ok: true,
        summary: `Opened upstream PR for ${rel} (${pr.url}) from branch ${branch}; passed checks and privacy scan.`,
        changes: [`pr:${pr.url}`, `branch:${branch}`],
        data: { branch, prUrl: pr.url, landed: false },
        landed: false,
        branch,
        prUrl: pr.url,
      };
    }

    // Land only onto a target file nobody else has uncommitted work in.
    const dirtyNow = await git(repo, ['status', '--porcelain', '--', rel]);
    if (dirtyBefore || dirtyNow) {
      keepBranch = true;
      return {
        ok: true,
        summary: `Upgrade to ${rel} passed its checks and is committed on branch ${branch}, but not landed: ${rel} has uncommitted changes from someone else in the live tree. The branch is handed back for the owner to merge.`,
        changes: [`branch:${branch}`],
        data: { branch, landed: false },
        landed: false,
        branch,
      };
    }
    try {
      await git(repo, ['merge', '--ff-only', branch]);
    } catch (err) {
      keepBranch = true;
      return {
        ok: true,
        summary: `Upgrade to ${rel} passed its checks and is committed on branch ${branch}, but could not fast-forward the live tree (${errText(err).slice(0, 200)}). The branch is handed back.`,
        changes: [`branch:${branch}`],
        data: { branch, landed: false },
        landed: false,
        branch,
      };
    }
    const commit = await git(repo, ['rev-parse', '--short', 'HEAD']);
    return {
      ok: true,
      summary: `Upgraded ${rel}: passed typecheck + tests in its own worktree and landed as ${commit}.`,
      changes: [`upgraded:${rel}`, `commit:${commit}`],
      data: { commit, landed: true },
      landed: true,
    };
  } catch (err) {
    return { ok: false, summary: `Upgrade to ${rel} failed; nothing changed in the live code.`, error: errText(err) };
  } finally {
    if (worktreeAdded) await git(repo, ['worktree', 'remove', '--force', wt]).catch(() => undefined);
    if (worktreeAdded && !keepBranch) await git(repo, ['branch', '-D', branch]).catch(() => undefined);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `self.upgrade`: edits VOICE.md directly, or Rufus's own engine code through the worktree path above. */
export async function registerSelfUpgrade(registry: ToolRegistry, opts: SelfUpgradeOptions = {}): Promise<void> {
  await registry.registerInline(
    {
      id: 'self.upgrade',
      version: 3,
      description:
        "Edits Rufus's own private VOICE.md (target=voice), or his engine code under src/ (target=engine) with an exact find/replace. Engine edits run in their own git worktree and branch, must pass typecheck + tests there, and land on the live code only when nobody else has uncommitted changes in that file; otherwise the branch is handed back. Every self-upgrade waits for the owner's yes to that exact change.",
      whenToUse: ['The owner asks Rufus to change his own voice, personality, or core engine behavior'],
      effect: 'write',
      requiresApproval: false,
      // Rufus changing himself never lands without the owner's tap, however well its checks and replays pass:
      // it starts at draft and trust.json can't raise it past draft.
      defaultTrust: 'draft',
      maxTrust: 'draft',
      timeoutMs: 300_000,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['voice', 'engine'] },
          relativePath: { type: 'string', description: 'For engine: path inside src/ (e.g. src/speaker/speaker.ts). Ignored for voice.' },
          find: { type: 'string', description: 'Exact text to replace (engine: required, matched in the committed file; voice: empty overwrites VOICE.md)' },
          replace: { type: 'string', description: 'Replacement text' },
          commitMessage: { type: 'string', description: 'Short commit message for engine upgrades' },
          restart: { type: 'boolean', description: 'Restart the daemon after the change lands (default false)' },
          openPr: { type: 'boolean', description: 'If true, push the checked worktree branch and open an upstream GitHub PR (privacy-scanned) instead of merging directly into the local tree' },
          prTitle: { type: 'string', description: 'Optional PR title when openPr=true' },
          prBody: { type: 'string', description: 'Optional PR description when openPr=true' },
        },
        required: ['target', 'replace'],
        additionalProperties: false,
      },
    },
    async (input, ctx: ScriptContext) => {
      if (input.target === 'voice') {
        const voicePath = path.join(ctx.workspaceDir, 'VOICE.md');
        const prev = await fs.readFile(voicePath, 'utf8').catch(() => '');
        const next = typeof input.find === 'string' && input.find ? replaceOnce(prev, input.find, String(input.replace)) : String(input.replace);
        if (next === undefined) return { ok: false, summary: 'Could not find target text in VOICE.md.', error: 'find text not matched' };
        await fs.writeFile(voicePath, next, 'utf8');
        return { ok: true, summary: 'Updated VOICE.md (takes effect on the next message).', changes: ['updated:VOICE.md'] };
      }
      if (typeof input.find !== 'string' || !input.find) return { ok: false, summary: 'Engine edits need the exact text to replace (find).', error: 'missing find' };
      const res = await upgradeInWorktree(
        {
          relativePath: String(input.relativePath ?? ''),
          find: input.find,
          replace: String(input.replace),
          ...(typeof input.commitMessage === 'string' ? { commitMessage: input.commitMessage } : {}),
          ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}),
          ...(ctx.gapId ? { gapId: ctx.gapId } : {}),
          ...(input.openPr === true ? { openPr: true } : {}),
          ...(typeof input.prTitle === 'string' ? { prTitle: input.prTitle } : {}),
          ...(typeof input.prBody === 'string' ? { prBody: input.prBody } : {}),
        },
        { ...opts, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      );
      if (res.landed && input.restart === true) {
        (opts.restart ?? defaultRestart)();
        res.summary += ' Restarting in 3s.';
      }
      const { landed: _landed, branch: _branch, ...out } = res;
      return out;
    },
  );
}
