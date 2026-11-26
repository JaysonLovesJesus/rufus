#!/usr/bin/env -S npx tsx
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bouncer } from './bouncer/bouncer';
import { RufusCore } from './daemon';
import { messageEvent } from './events/ingest';
import { ClaudeCliProvider } from './providers/claude';
import type { MessageSink } from './types';

function defaultWorkspace(): string {
  return process.env.RUFUS_DIR || path.join(os.homedir(), '.rufus-v2');
}

function defaultPython(dir: string): string | undefined {
  return process.env.RUFUS_PYTHON || path.join(dir, 'setfit-venv', 'bin', 'python');
}

async function main(argv: string[]): Promise<void> {
  const [cmd = 'help', ...rest] = argv;
  const dir = defaultWorkspace();
  const shadow = rest.includes('--shadow');
  const pythonPath = defaultPython(dir);
  const sink: MessageSink = { send: async (text) => console.log(`\n[Rufus]\n${text}\n`) };

  const makeCore = () =>
    new RufusCore({
      workspaceDir: dir,
      reasoningProvider: new ClaudeCliProvider({ model: process.env.RUFUS_REASONING_MODEL || 'claude-opus-4-5' }),
      speakerProvider: new ClaudeCliProvider({ model: process.env.RUFUS_SPEAKER_MODEL || 'claude-haiku-4-5' }),
      sink,
      ...(pythonPath ? { pythonPath } : {}),
      shadow,
    });

  if (cmd === 'init') {
    await fs.mkdir(path.join(dir, 'tools'), { recursive: true });
    await fs.mkdir(path.join(dir, 'training'), { recursive: true });
    console.log(`Initialized Rufus v2 workspace at ${dir}`);
    return;
  }

  if (cmd === 'tools') {
    const core = makeCore();
    await core.init();
    for (const t of core.registry.list()) {
      console.log(`- ${t.id} [${t.effect}${t.requiresApproval ? ', approval' : ''}]: ${t.description}`);
    }
    await core.close();
    return;
  }

  if (cmd === 'wake') {
    const text = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!text) throw new Error('Usage: rufus wake <message...>');
    const core = makeCore();
    try {
      const ev = messageEvent({ channel: 'cli', actor: 'owner', text, timestamp: new Date().toISOString() });
      ev.kind = 'owner_direct';
      const res = await core.processEvent(ev);
      console.log(`Done in ${res.wake?.turns ?? 0} turn(s), slept=${res.wake?.slept ?? false}.`);
    } finally {
      await core.close();
    }
    return;
  }

  if (cmd === 'startup') {
    const core = makeCore();
    try {
      const res = await core.announceStartup();
      console.log(`Startup complete (${res.wake?.turns ?? 0} turn(s), shadow=${shadow}).`);
    } finally {
      await core.close();
    }
    return;
  }

  if (cmd === 'bouncer') {
    const [sub = 'status', ...args] = rest;
    const bouncer = new Bouncer({ workspaceDir: dir, ...(pythonPath ? { pythonPath } : {}) });
    try {
      if (sub === 'status') {
        const counts = await bouncer.exampleCount();
        console.log(`Bouncer training examples: ${counts.total} (SLEEP=${counts.sleep}, WAKE=${counts.wake})`);
      } else if (sub === 'train') {
        const res = await bouncer.trainSetFit();
        console.log(JSON.stringify(res, null, 2));
        if (!res.ok) process.exitCode = 1;
      } else if (sub === 'test') {
        const text = args.join(' ').trim();
        const ev = messageEvent({ channel: 'test', actor: 'other', text, timestamp: new Date().toISOString() });
        const d = await bouncer.decide(ev);
        console.log(JSON.stringify(d, null, 2));
      } else {
        throw new Error('Usage: rufus bouncer [status | train | test <text...>]');
      }
    } finally {
      await bouncer.close();
    }
    return;
  }

  console.log(
    [
      'Rufus v2 Core — minimal CLI',
      '  rufus init                     Initialize workspace',
      '  rufus tools                    List packaged scripts',
      '  rufus wake <text...>           Wake the RPG loop with a direct message',
      '  rufus startup [--shadow]       Run startup snapshot -> Haiku speaker',
      '  rufus bouncer status|train|test  Manage the local SetFit bouncer',
    ].join('\n'),
  );
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
