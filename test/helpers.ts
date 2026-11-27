import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import type { ModelRequest } from '../src';

const madeDirs: string[] = [];
// Registered once per test file that imports this module: the file's scratch workspaces go when it finishes.
afterAll(async () => {
  await Promise.all(madeDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A fresh scratch workspace in the OS temp dir, removed after the test file finishes. */
export async function tempDir(prefix = 'rufus-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

/** Polls until `cond` holds (or `timeoutMs` passes), instead of a fixed sleep that flakes on a busy machine. */
export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000, everyMs = 10): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await cond()) && Date.now() < until) await new Promise((r) => setTimeout(r, everyMs));
}

const isDecide = (req: ModelRequest) => req.system.includes('You are Decide');

function receiptsSection(prompt: string): string {
  return (prompt.split('Receipts This Wake')[1] ?? '').split(/\n\nTurn \d+ of \d+\./)[0] ?? '';
}

function lastReceipt(prompt: string): string {
  const section = receiptsSection(prompt);
  const starts = [...section.matchAll(/(^|\n)Turn \d+: /g)];
  const last = starts[starts.length - 1];
  return last?.index !== undefined ? section.slice(last.index) : '';
}

/**
 * Wraps a scripted Decide for tests that are about something other than gaps, so the script still follows the top-down rules:
 * - a scripted move that names no gap serves one test gap per wake (created inline on the first move);
 * - when `sleep` is refused because a gap has no next move, it schedules that gap's next move and retries `sleep`.
 * The wrapped script is only called for its own steps, so step counters in tests stay meaningful.
 */
export function topDown(script: (req: ModelRequest, idx: number) => string | Promise<string>) {
  let idx = 0;
  let settling = false;
  return async (req: ModelRequest): Promise<string> => {
    if (!isDecide(req)) return script(req, idx++);
    const last = lastReceipt(req.prompt);
    const stranded = /have no next move in motion: (gap_[a-z0-9]+)/.exec(last);
    if (stranded) {
      settling = true;
      return JSON.stringify({ gap: stranded[1], toolId: 'watch.set', input: { kind: 'timer', label: 'next move', fireAt: '2099-01-01T00:00:00Z' } });
    }
    if (settling && /watch\.set -> ok/.test(last)) {
      settling = false;
      return JSON.stringify({ toolId: 'sleep', input: { reason: 'every gap has a next move' } });
    }
    settling = false;
    const raw = await script(req, idx++);
    let action: Record<string, unknown>;
    try {
      action = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return raw;
    }
    if (action.toolId !== 'sleep' && action.gap === undefined) {
      const existing = /New gap (gap_[a-z0-9]+)/.exec(receiptsSection(req.prompt))?.[1];
      action.gap = existing ?? { title: 'Test request', target: 'The owner got what was asked for' };
    }
    return JSON.stringify(action);
  };
}
