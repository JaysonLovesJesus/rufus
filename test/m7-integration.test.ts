import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendRotating, HeartbeatHub, loadWakes, TelegramChannel, type LosslessEvent } from '../src';
import { readTailLines } from '../src/eval/flight-recorder';
import { archiveToolVersion, listToolVersions, MAX_KEPT_VERSIONS, restoreToolVersion } from '../src/scripts/versions';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'rufus-int-'));

describe('where the night’s changes meet', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a refused Telegram poll throws (so the loop backs off) and is reported', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 409, text: async () => 'Conflict: terminated by other getUpdates request' }));
    const errors: string[] = [];
    const tg = new TelegramChannel({ token: 'test-token', chatId: '1', onPollError: (e) => errors.push(e) });
    await expect(tg.poll(0)).rejects.toThrow(/getUpdates failed \(409\)/);
    expect(errors).toHaveLength(1);
  });

  it('one slow sense never holds back the others, and is not polled twice at once', async () => {
    let release: () => void = () => undefined;
    let slowCalls = 0;
    const hub = new HeartbeatHub();
    hub.add({
      id: 'slow',
      intervalMs: 1,
      poll: () => {
        slowCalls++;
        return new Promise<LosslessEvent[]>((resolve) => (release = () => resolve([])));
      },
    });
    hub.add({ id: 'fast', intervalMs: 1, poll: async () => [] });
    const seen: string[] = [];
    const first = hub.tick(1000, (p) => void seen.push(p.id));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['fast']);
    // A second tick while the slow sense is still out polls only the fast one.
    await hub.tick(2000, (p) => void seen.push(p.id));
    expect(seen).toEqual(['fast', 'fast']);
    expect(slowCalls).toBe(1);
    release();
    await first;
    expect(seen).toEqual(['fast', 'fast', 'slow']);
  });

  it('a capped log rotates to .1 instead of growing forever, and concurrent appends lose nothing', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'decisions.jsonl');
    await Promise.all(Array.from({ length: 30 }, (_, i) => appendRotating(file, `${JSON.stringify({ i })}\n`, 100)));
    const main = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
    const old = (await fs.readFile(path.join(dir, 'decisions.1.jsonl'), 'utf8')).split('\n').filter(Boolean);
    expect((await fs.stat(file)).size).toBeLessThanOrEqual(100);
    // The newest line is always in the main file; the rotated file holds the lines just before it.
    expect(main.at(-1)).toBe('{"i":29}');
    expect(JSON.parse(old.at(-1)!).i).toBe(JSON.parse(main[0]!).i - 1);
  });

  it('loadWakes reads only the tail of wakes.jsonl', async () => {
    const dir = await tmp();
    const big = 'x'.repeat(5000);
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ wakeId: `w${i}`, pad: big }));
    await fs.writeFile(path.join(dir, 'wakes.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    const last = await loadWakes(dir, 5);
    expect(last.map((w) => w.wakeId)).toEqual(['w295', 'w296', 'w297', 'w298', 'w299']);
    expect((await readTailLines(path.join(dir, 'wakes.jsonl'), 1000)).length).toBe(300);
    expect(await loadWakes(path.join(dir, 'missing'))).toEqual([]);
  });

  it('a tool keeps only its newest versions, and a rollback to the oldest still works', async () => {
    const toolDir = path.join(await tmp(), 'demo.tool');
    await fs.mkdir(toolDir, { recursive: true });
    for (let v = 1; v <= MAX_KEPT_VERSIONS + 5; v++) {
      await fs.writeFile(path.join(toolDir, 'tool.json'), JSON.stringify({ id: 'demo.tool', version: v }), 'utf8');
      await fs.writeFile(path.join(toolDir, 'run.mjs'), `// v${v}\n`, 'utf8');
      await archiveToolVersion(toolDir, { at: new Date(Date.UTC(2026, 0, 1, 0, v)), reason: 'test' });
    }
    const kept = await listToolVersions(toolDir);
    expect(kept).toHaveLength(MAX_KEPT_VERSIONS);
    const oldest = kept.at(-1)!;
    const res = await restoreToolVersion(toolDir, { at: new Date(Date.UTC(2026, 0, 2)), reason: 'rollback' }, oldest.name);
    expect(res).toMatchObject({ restored: oldest.name });
    expect(await fs.readFile(path.join(toolDir, 'run.mjs'), 'utf8')).toBe('// v6\n');
  });
});
