import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { computeScorecard, formatScorecard, modelCallRole } from '../src/eval/flight-recorder';
import { clip } from '../src/eval/outline';
import { loadScenarios } from '../src/eval/scenarios';
import { tempDir } from './helpers';

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'src', 'cli.ts');

/** Runs the CLI against a scratch workspace and returns its exit code and output. */
async function cli(args: string[], dir: string): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: REPO,
      env: { ...process.env, RUFUS_DIR: dir, RUFUS_PYTHON: path.join(dir, 'no-python') },
      timeout: 30_000,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === 'number' ? x.code : 1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

describe('rufus CLI', () => {
  it('lists every command on help, and fails loudly on an unknown command or bad input', async () => {
    const dir = await tempDir('rufus-cli-');
    const [help, unknown, emptyTest, badPort, noCases, train] = await Promise.all([
      cli(['help'], dir),
      cli(['statz'], dir),
      cli(['bouncer', 'test'], dir),
      cli(['dashboard', '--port', 'abc'], dir),
      cli(['eval'], dir),
      cli(['bouncer', 'train'], dir),
    ]);
    expect(help.code).toBe(0);
    for (const c of ['start', 'wake', 'stats', 'verify', 'verify --live', 'eval', 'bouncer train', 'dashboard']) expect(help.out).toContain(`rufus ${c}`);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('Unknown command: statz');
    expect(emptyTest.code).toBe(1);
    expect(emptyTest.err).toContain('Usage: rufus bouncer test');
    expect(badPort.code).toBe(1);
    expect(badPort.err).toContain('--port needs a port number');
    expect(noCases.code).toBe(1);
    expect(noCases.err).toContain('No judgment cases at');
    expect(train.code).toBe(1);
    expect(train.err).toContain('No SetFit python at');
  }, 60_000);
});

describe('rufus stats', () => {
  it('says n/a for rates over nothing, and says when only the last 500 wakes are scored', async () => {
    const empty = await tempDir('rufus-stats-');
    const lines = formatScorecard(await computeScorecard(empty)).join('\n');
    expect(lines).toContain('Tool success rate: n/a (0/0)');
    expect(lines).toContain('(n/a approval)');
    expect(lines).not.toContain('100%');

    const dir = await tempDir('rufus-stats-');
    const wake = (i: number) => JSON.stringify({ wakeId: `w${i}`, at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), trigger: { id: `e${i}`, source: 'email', kind: 'unread', text: 'x' }, decision: { label: 'WAKE', confidence: 1, backend: 'rule', durationMs: 0 }, turns: 1, durationMs: 2500, acted: false, slept: true, sentMessages: [], trace: [] });
    await writeFile(path.join(dir, 'wakes.jsonl'), `${Array.from({ length: 502 }, (_, i) => wake(i)).join('\n')}\n`, 'utf8');
    const sc = await computeScorecard(dir);
    expect(sc.totalWakes).toBe(500);
    expect(sc.wakesOnFile).toBe(502);
    const out = formatScorecard(sc);
    expect(out[0]).toContain('last 500 of 502 wakes');
    expect(out.join('\n')).toContain('(2.5s avg)');
  });

  it('names the brain behind each model call', () => {
    expect(modelCallRole('You are Decide. Pick one move.')).toBe('decide');
    expect(modelCallRole('You are the Speaker for Rufus.')).toBe('speaker');
    expect(modelCallRole('# Investigate\nRead-only detective.')).toBe('investigate');
    expect(modelCallRole('plain prompt')).toBe('other');
  });
});

describe('verify and live replays', () => {
  it('clips a detail at a word boundary and marks the cut', () => {
    expect(clip('short')).toBe('short');
    const long = `refused: "sleep" is a built-in tool; its code lives in the engine and cannot be created or repaired as a packaged tool`;
    const c = clip(long, 80);
    expect(c.endsWith('…')).toBe(true);
    expect(c.length).toBeLessThanOrEqual(81);
    expect(long.startsWith(c.slice(0, -1))).toBe(true);
    expect(long[c.length - 1]).toMatch(/[\s,;:(]/);
  });

  it('names the scenario file that is broken', async () => {
    const dir = await tempDir('rufus-scen-');
    await mkdir(path.join(dir, 'eval', 'scenarios'), { recursive: true });
    expect(await loadScenarios(dir)).toEqual([]);
    await writeFile(path.join(dir, 'eval', 'scenarios', 'ok.json'), JSON.stringify({ id: 'ok', description: 'd', seedUntil: '2026-11-01T00:00:00Z', steps: [], expect: {} }), 'utf8');
    expect((await loadScenarios(dir)).map((s) => s.id)).toEqual(['ok']);
    await writeFile(path.join(dir, 'eval', 'scenarios', 'broken.json'), '{ "id": "broken", ', 'utf8');
    await expect(loadScenarios(dir)).rejects.toThrow(/broken\.json is not valid JSON/);
    await writeFile(path.join(dir, 'eval', 'scenarios', 'broken.json'), '{ "id": "broken" }', 'utf8');
    await expect(loadScenarios(dir)).rejects.toThrow(/broken\.json needs "id", "steps" and "expect"/);
  });
});
