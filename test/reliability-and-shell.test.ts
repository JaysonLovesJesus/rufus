import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bouncer } from '../src/bouncer/bouncer';
import { genericEvent } from '../src/events/ingest';
import { WatchStore } from '../src/events/watches';
import { ApprovalStore } from '../src/scripts/approvals';
import { registerBuiltins } from '../src/scripts/builtins';
import { passGate } from '../src/scripts/gate';
import { ToolRegistry } from '../src/scripts/registry';
import { isReadOnlyShellCommand } from '../src/scripts/shell-safety';
import type { ToolManifest } from '../src/types';

const SHELL_MANIFEST: ToolManifest = {
  id: 'shell.run',
  version: 1,
  description: 'Runs a shell command',
  whenToUse: ['Inspect or run a command'],
  effect: 'write',
  requiresApproval: true,
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' }, cwd: { type: 'string' } },
    required: ['command'],
  },
};

describe('Read-only shell safety & Trust Gate', () => {
  it('allows provably read-only commands and strictly rejects writes, redirects, and subshells', () => {
    const allowed = [
      'ls -la /tmp',
      'ffprobe -v error -show_entries format=duration video.mp4',
      'git status',
      'git -C /repo log -5 --oneline',
      'cat notes.md | head -n 20',
      'rg "pattern" src/ | wc -l',
      'stat file.mp4 && file file.mp4',
      'find src -name "*.ts" | sort',
    ];
    for (const cmd of allowed) {
      expect(isReadOnlyShellCommand(cmd), `expected read-only: ${cmd}`).toBe(true);
    }

    const blocked = [
      'rm -rf /tmp/foo',
      'echo hi > out.txt',
      'cat a >> b',
      'ls $(whoami)',
      'ls `id`',
      'ls; rm foo',
      'find . -name "*.tmp" -delete',
      'sed -i "" "s/a/b/" file.txt',
      'git push origin main',
      'osascript -e "tell application \\"Finder\\" to activate"',
      'env',
      'curl -X POST https://example.com',
      'ls || rm foo',
      'ls &',
    ];
    for (const cmd of blocked) {
      expect(isReadOnlyShellCommand(cmd), `expected blocked: ${cmd}`).toBe(false);
    }
  });

  it('auto-runs read-only shell.run at act_quietly while keeping mutating shell.run at draft (and respecting neverAllow)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rufus-shell-gate-'));
    try {
      const approvals = new ApprovalStore(dir);
      const now = new Date('2026-11-27T20:00:00Z');

      const ro = await passGate({ manifest: SHELL_MANIFEST, input: { command: 'ffprobe -v error clip.mp4' }, approvals, now });
      expect(ro.run).toBe(true);
      if (ro.run) expect(ro.level).toBe('act_quietly');

      const rw = await passGate({ manifest: SHELL_MANIFEST, input: { command: 'rm clip.mp4' }, approvals, now });
      expect(rw.run).toBe(false);
      if (!rw.run) expect(rw.receipt.status).toBe('pending_approval');

      await fs.writeFile(path.join(dir, 'trust.json'), JSON.stringify({ levels: {}, neverAllow: ['shell.run'] }), 'utf8');
      const blocked = await passGate({ manifest: SHELL_MANIFEST, input: { command: 'ls -la' }, approvals, now });
      expect(blocked.run).toBe(false);
      if (!blocked.run) expect(blocked.level).toBe('never');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Approval hijacking guard, ambient screen/focus rule, and watch deduplication', () => {
  it('blocks ambiguous or cross-gap approvals.approve and allows matching gap + explicit approvalId', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rufus-appr-guard-'));
    try {
      const now = new Date('2026-11-27T20:00:00Z');
      const approvals = new ApprovalStore(dir);
      const registry = new ToolRegistry({ toolsDir: path.join(dir, 'tools') });
      const ran: string[] = [];

      await registry.registerInline(
        {
          id: 'demo.act',
          version: 1,
          description: 'Demo action',
          whenToUse: ['test'],
          effect: 'write',
          requiresApproval: true,
          inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
        },
        async (inp) => {
          ran.push(String(inp.tag));
          return { ok: true, summary: `ran ${inp.tag}`, changes: [`ran:${inp.tag}`] };
        },
      );

      await registerBuiltins({
        registry,
        approvals,
        speakerProvider: { name: 'fake', complete: async () => 'ok' },
        sink: { send: async () => undefined },
        getWakeReceipts: () => [],
        getWakeContext: () => ({
          trigger: genericEvent({ id: 'ev_yes', source: 'message', kind: 'owner_direct', actor: 'owner', text: 'yes', timestamp: now.toISOString() }),
        }),
        onSent: () => undefined,
        onSleep: () => undefined,
      });

      const aFinder = await approvals.enqueue('demo.act', { tag: 'finder' }, now, 'gap_senses');
      const aLesson = await approvals.enqueue('demo.act', { tag: 'lesson4' }, now, 'gap_lessons');

      // 1. Omitting approvalId when >1 approvals are pending must be refused
      const ambig = await registry.call('approvals.approve', {}, { workspaceDir: dir, now, gapId: 'gap_lessons' });
      expect(ambig.status).toBe('failed');
      expect(ambig.error).toBe('ambiguous pending approval');
      expect(ran).toEqual([]);

      // 2. Approving aFinder while serving gap_lessons must be refused
      const cross = await registry.call('approvals.approve', { approvalId: aFinder.id }, { workspaceDir: dir, now, gapId: 'gap_lessons' });
      expect(cross.status).toBe('failed');
      expect(cross.error).toBe('approval gap mismatch');
      expect(ran).toEqual([]);

      // 3. Matching gap + explicit approvalId succeeds
      const ok = await registry.call('approvals.approve', { approvalId: aLesson.id }, { workspaceDir: dir, now, gapId: 'gap_lessons' });
      expect(ok.status).toBe('ok');
      expect(ran).toEqual(['lesson4']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('sleeps on ambient screen/focus at $0 via rule and deduplicates per-gap timers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rufus-noise-guard-'));
    try {
      const bouncer = new Bouncer({ workspaceDir: dir });
      const dec = await bouncer.decide(genericEvent({ source: 'screen', kind: 'focus', text: 'Switched active app to Finder' }));
      expect(dec.label).toBe('SLEEP');
      expect(dec.backend).toBe('rule');

      const watches = new WatchStore(dir);
      const now = new Date('2026-11-27T20:00:00Z');
      await watches.add({ kind: 'timer', label: 'chase 1', gapId: 'gap_a', fireAt: '2026-11-27T21:00:00Z' }, now);
      await watches.add({ kind: 'timer', label: 'chase 2', gapId: 'gap_a', fireAt: '2026-11-27T22:00:00Z' }, now);
      await watches.add({ kind: 'timer', label: 'other gap', gapId: 'gap_b', fireAt: '2026-11-27T21:30:00Z' }, now);

      const active = await watches.active();
      expect(active.map((w) => w.label)).toEqual(['chase 2', 'other gap']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
