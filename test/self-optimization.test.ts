import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { GapStore, ROOT_GAP_ID, needsNextMove } from '../src/gaps/store';
import { SELF_OPT_SPECS, ensureStarterVoice, seedSelfOptimizationGaps } from '../src/gaps/self-opt';
import { scanForPrivacyLeaks, upgradeInWorktree } from '../src/scripts/self-upgrade';
import { tempDir } from './helpers';

const execFileAsync = promisify(execFile);
const NOW = new Date('2026-11-27T12:00:00Z');

describe('Built-in standing self-optimization gaps', () => {
  it('seeds the parent and 5 standing self-optimization gaps idempotently without stranding sleep', async () => {
    const dir = await tempDir('rufus-self-opt-');
    const store = new GapStore(dir);
    const first = await seedSelfOptimizationGaps(store, NOW);
    expect(first.added).toHaveLength(SELF_OPT_SPECS.length);
    const second = await seedSelfOptimizationGaps(store, NOW);
    expect(second.added).toHaveLength(0);

    const all = await store.list();
    expect(all.find((g) => g.id === ROOT_GAP_ID)).toBeDefined();
    const standing = all.filter((g) => g.standing);
    expect(standing).toHaveLength(SELF_OPT_SPECS.length);
    // Standing gaps without a time window never strand sleep.
    expect(standing.some((g) => needsNextMove(g))).toBe(false);

    // Starter VOICE.md is created once and never overwritten.
    expect(await ensureStarterVoice(dir)).toBe(true);
    expect(await ensureStarterVoice(dir)).toBe(false);
    expect(await readFile(path.join(dir, 'VOICE.md'), 'utf8')).toContain('# Voice');
  });
});

describe('Upstream PR mode in self.upgrade', () => {
  it('scans for personal paths and tokens before opening an upstream PR', () => {
    expect(scanForPrivacyLeaks('const x = "/Users/alice/secret";')).toContain('absolute macOS/Linux user home path');
    expect(scanForPrivacyLeaks('const k = "ghp_12345678901234567890123456";')).toContain('GitHub personal access token');
    expect(scanForPrivacyLeaks('export const clean = 42;')).toEqual([]);
  });

  it('opens a PR from a checked worktree branch while leaving the live tree untouched, and blocks leaky diffs', async () => {
    const repo = await tempDir('rufus-pr-repo-');
    const git = (args: string[]) => execFileAsync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t.invalid' } });
    await git(['init', '-b', 'main']);
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'src', 'demo.ts'), 'export const VERSION = 1;\n', 'utf8');
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);

    // Leaky diff is blocked before even creating a worktree.
    const blocked = await upgradeInWorktree(
      { relativePath: 'src/demo.ts', find: 'VERSION = 1', replace: 'VERSION = "/Users/alice/private"', openPr: true },
      { repoDir: repo, checks: [] },
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe('privacy_scan_failed');

    // Clean diff passes checks and calls createPr without mutating the live tree.
    const prs: Array<{ branch: string; title: string }> = [];
    const res = await upgradeInWorktree(
      { relativePath: 'src/demo.ts', find: 'VERSION = 1', replace: 'VERSION = 2', commitMessage: 'feat: bump version', openPr: true, prTitle: 'Bump version to 2' },
      {
        repoDir: repo,
        checks: [],
        createPr: async ({ branch, title }) => {
          prs.push({ branch, title });
          return { url: 'https://github.com/example/rufus/pull/42' };
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(res.prUrl).toBe('https://github.com/example/rufus/pull/42');
    expect(prs).toHaveLength(1);
    expect(prs[0]?.title).toBe('Bump version to 2');
    // Live working tree was not mutated directly (change lives on the PR branch).
    expect(await readFile(path.join(repo, 'src', 'demo.ts'), 'utf8')).toBe('export const VERSION = 1;\n');
  });
});
