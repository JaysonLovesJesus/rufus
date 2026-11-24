import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli';
import { FileStore, type RunRecord } from '../src';
import { tempDir } from './helpers';

function capture() {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) } };
}

describe('FileStore', () => {
  it('lays out a readable workspace and writes atomically (no temp files left)', async () => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    await store.init();
    expect((await readdir(dir)).sort()).toEqual(['config.json', 'flows', 'lessons.json', 'runs']);
    const run: RunRecord = {
      id: 'run_x', flowId: 'f', status: 'running', input: null, steps: {}, createdAt: 'a', updatedAt: 'a',
    };
    await store.saveRun(run);
    expect(await readdir(path.join(dir, 'runs'))).toEqual(['run_x.json']);
    expect(JSON.parse(await readFile(path.join(dir, 'runs', 'run_x.json'), 'utf8')).id).toBe('run_x');
    await expect(store.getRun('nope')).rejects.toThrow(/No run/);
  });
});

describe('cli', () => {
  it('demo: code -> ai retry -> human pause -> pending -> answer -> finish', async () => {
    const dir = await tempDir();
    const c = capture();
    await main(['--dir', dir, 'demo'], c.io);
    const text = c.lines.join('\n');
    expect(text).toContain('attempts: 2');
    expect(text).toContain('YOUR TURN: Reply to Sam Rivera?');
    const ref = /\(ref (c_[0-9a-f]+)\)/.exec(text)![1]!;

    const p = capture();
    await main(['--dir', dir, 'pending'], p.io);
    expect(p.lines.join('\n')).toContain(ref);

    const a = capture();
    await main(['--dir', dir, 'answer', ref, '1'], a.io);
    expect(a.lines.join('\n')).toContain('"action": "send"');

    const empty = capture();
    await main(['--dir', dir, 'pending'], empty.io);
    expect(empty.lines).toEqual(['Nothing waiting on you.']);
  });

  it('demo --reply answers immediately, and a Lesson line shows up in `lessons`', async () => {
    const dir = await tempDir();
    const c = capture();
    await main(['--dir', dir, 'demo', '--reply', 'Sounds good, see you Friday.\nLesson: Always confirm the time.'], c.io);
    expect(c.lines.join('\n')).toContain('"reply": "Sounds good, see you Friday."');
    const l = capture();
    await main(['--dir', dir, 'lessons'], l.io);
    expect(l.lines[0]).toMatch(/x1 {2}flow:triage-draft {2}Always confirm the time\.$/);
  });

  it('init creates the workspace; flows lists the example', async () => {
    const dir = await tempDir();
    const c = capture();
    await main(['--dir', dir, 'init'], c.io);
    await main(['--dir', dir, 'flows'], c.io);
    expect(c.lines.join('\n')).toContain('triage-draft');
  });
});
