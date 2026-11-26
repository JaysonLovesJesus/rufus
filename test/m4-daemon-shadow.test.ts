import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeProvider, RufusCore } from '../src';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'rufus-v2-m4-'));
const NOW = new Date('2026-11-26T14:00:00Z');

describe('Milestone 4: Unified Startup Orientation & Shadow Mode', () => {
  it('runs startup orientation through system.startup_snapshot -> fresh Speaker and respects shadow mode', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, 'projects'), { recursive: true });
    await writeFile(path.join(dir, 'projects', 'alpha.md'), '# Alpha\n', 'utf8');
    await writeFile(path.join(dir, 'projects', 'beta.md'), '# Beta\n', 'utf8');

    const realSent: string[] = [];
    const reasoning = new FakeProvider((_req, idx) => {
      if (idx === 0) return JSON.stringify({ toolId: 'system.startup_snapshot', input: {} });
      if (idx === 1) return JSON.stringify({ toolId: 'send_message', input: { intent: 'Greet user with exact startup snapshot.' } });
      return JSON.stringify({ toolId: 'sleep', input: { reason: 'Startup announced' } });
    });
    const speaker = new FakeProvider(() => 'Online and ready. Active projects:\n1. alpha\n2. beta');

    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: reasoning,
      speakerProvider: speaker,
      sink: { send: async (t) => void realSent.push(t) },
      shadow: true,
      now: () => NOW,
    });

    const res = await core.announceStartup();
    expect(res.wake?.turns).toBe(3);
    expect(res.wake?.slept).toBe(true);
    expect(res.shadowLogged).toBe(true);
    // Shadow mode NEVER writes to the real sink
    expect(realSent).toEqual([]);

    const shadowLog = await readFile(path.join(dir, 'shadow.jsonl'), 'utf8');
    expect(shadowLog).toContain('Online and ready.');
    expect(shadowLog).toContain('1. alpha');
    await core.close();
  });
});
