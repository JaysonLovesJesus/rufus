#!/usr/bin/env -S npx tsx
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bouncer } from './bouncer/bouncer';
import { formatTrainingMetrics } from './bouncer/training';
import { TelegramChannel } from './channels/telegram';
import { RufusCore } from './daemon';
import { computeScorecard, formatScorecard } from './eval/flight-recorder';
import { recordOpsFailure } from './eval/ops-log';
import { loadScenarios, runScenario } from './eval/scenarios';
import { OUTLINE_ITEMS, verifyAllParts } from './eval/verify';
import { buildDefaultConnectors, HeartbeatHub } from './events/connectors';
import { messageEvent } from './events/ingest';
import { createSenseRuntime, stampConsole } from './events/runtime';
import { startEventWebhook } from './events/webhook';
import { ensureStarterVoice, seedSelfOptimizationGaps } from './gaps/self-opt';
import { GapStore } from './gaps/store';
import { DAEMON_LABEL, defaultReleasesDir, launchAgentPath, promote, sourceRepoDir } from './ops/release';
import { ClaudeCliProvider } from './providers/claude';
import type { MessageSink } from './types';
import { KokoroTts } from './voice/kokoro';
import { findParakeetModel } from './voice/parakeet';
import { createVoiceHttpHandler } from './voice/server';

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
      reasoningProvider: new ClaudeCliProvider({ model: process.env.RUFUS_REASONING_MODEL || 'opus', cwd: dir }),
      speakerProvider: new ClaudeCliProvider({ model: process.env.RUFUS_SPEAKER_MODEL || 'haiku', cwd: dir }),
      sink,
      ...(pythonPath ? { pythonPath } : {}),
      shadow,
    });

  if (cmd === 'init') {
    await Promise.all(
      ['tools', 'training', 'skills', 'projects', 'drafts'].map((sub) => fs.mkdir(path.join(dir, sub), { recursive: true })),
    );
    const createdVoice = await ensureStarterVoice(dir);
    const seeded = await seedSelfOptimizationGaps(new GapStore(dir));
    const parakeet = findParakeetModel();
    console.log(`Initialized Rufus workspace at ${dir}`);
    console.log(`- Gap board: root gap + ${seeded.added.length} standing self-optimization gap(s) seeded (${seeded.total} total)`);
    console.log(`- VOICE.md: ${createdVoice ? 'created starter' : 'kept existing'}`);
    console.log(`- Local Parakeet STT: ${parakeet ? `detected (${path.basename(parakeet)})` : 'not found (optional)'}`);
    console.log(`Next: run \`pnpm rufus wake "Help me get set up"\` or \`pnpm rufus start\`.`);
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
      console.log(`Startup complete (${res?.wake?.turns ?? 0} turn(s), shadow=${shadow}).`);
    } finally {
      await core.close();
    }
    return;
  }

  if (cmd === 'start') {
    const intervalMs = Number(process.env.RUFUS_HEARTBEAT_MS || 5000);
    let tgToken = process.env.TELEGRAM_BOT_TOKEN;
    let tgChatId = process.env.TELEGRAM_CHAT_ID;
    let stt: { command: string; args: string[] } | undefined;
    // The legacy ~/.rufus config belongs to the owner's real workspace: a copied or test workspace must never pick up his bot.
    const isDefaultWorkspace = path.resolve(dir) === path.join(os.homedir(), '.rufus-v2');
    const telegramOff = /^(0|off|false|no)$/i.test(process.env.RUFUS_TELEGRAM ?? '');
    // Prefer local Parakeet (.gguf) over legacy Whisper when a Parakeet model is already on disk.
    const parakeetModel = findParakeetModel();
    const parakeetScript = fileURLToPath(new URL('./voice/parakeet.ts', import.meta.url));
    const cfgPaths = [path.join(dir, 'config.json'), ...(isDefaultWorkspace ? [path.join(os.homedir(), '.rufus', 'config.json')] : [])];
    for (let i = 0; i < cfgPaths.length; i++) {
      const cfgPath = cfgPaths[i]!;
      try {
        const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
          telegram?: { token?: string; chatId?: string | number; transcribe?: { command: string; args: string[] } };
          voice?: { stt?: { command: string; args: string[] } };
        };
        if ((!tgToken || !tgChatId) && cfg.telegram?.token && cfg.telegram?.chatId) {
          tgToken = cfg.telegram.token;
          tgChatId = String(cfg.telegram.chatId);
        }
        if (!stt && i === 0) stt = cfg.voice?.stt ?? cfg.telegram?.transcribe;
        if (!stt && parakeetModel) stt = { command: process.execPath, args: ['--import', 'tsx', parakeetScript, '{file}'] };
        if (!stt) stt = cfg.voice?.stt ?? cfg.telegram?.transcribe;
      } catch {
        /* ignore */
      }
    }
    if (!stt && parakeetModel) stt = { command: process.execPath, args: ['--import', 'tsx', parakeetScript, '{file}'] };
    const onPollError = (error: string) => void recordOpsFailure(dir, { kind: 'poll_failed', channel: 'telegram', error });
    stampConsole();
    const offsetPath = path.join(dir, 'sense-state', 'telegram-offset');
    const tg = !telegramOff && tgToken && tgChatId ? new TelegramChannel({ token: tgToken, chatId: tgChatId, ...(stt ? { stt } : {}), onPollError, offsetPath }) : undefined;
    const core = new RufusCore({
      workspaceDir: dir,
      reasoningProvider: new ClaudeCliProvider({ model: process.env.RUFUS_REASONING_MODEL || 'opus', cwd: dir }),
      speakerProvider: new ClaudeCliProvider({ model: process.env.RUFUS_SPEAKER_MODEL || 'haiku', cwd: dir }),
      sink: tg ?? sink,
      ...(pythonPath ? { pythonPath } : {}),
      shadow,
      // Its own process, so its calls never evict the Speaker's warm one.
      triageProvider: new ClaudeCliProvider({ model: process.env.RUFUS_TRIAGE_MODEL || 'haiku', cwd: dir, timeoutMs: 60_000 }),
    });
    const initInfo = await core.init();
    const hub = new HeartbeatHub();
    const recentSent = async () => (await core.events.recent(400)).filter((e) => e.kind === 'assistant_sent').map((e) => e.text);
    for (const c of await buildDefaultConnectors(dir, { recentSent })) hub.add(c);
    const stop = new AbortController();
    const runtime = createSenseRuntime({ core, hub, signal: stop.signal, heartbeatMs: intervalMs, ...(tg ? { tg } : {}) });
    const tts = new KokoroTts({ workspaceDir: dir });
    const httpPort = Number(process.env.RUFUS_HTTP_PORT || 8787);
    // This Mac only by default; set RUFUS_WEBHOOK_HOST (e.g. 0.0.0.0 or a tailnet IP) plus RUFUS_WEBHOOK_TOKEN to reach it from the phone.
    const httpHost = process.env.RUFUS_WEBHOOK_HOST || process.env.RUFUS_HTTP_HOST || '127.0.0.1';
    const voiceHandler = createVoiceHttpHandler({
      tts,
      ...(stt ? { stt } : {}),
      onVoiceTurn: async (ev, voiceSink) => {
        // Through the shared inbox: an utterance during a voice wake joins it.
        await runtime.ingest(ev, { route: 'voice', sink: voiceSink, sense: 'voice', waitForWake: true });
      },
    });
    const httpServer = await startEventWebhook({
      port: httpPort,
      host: httpHost,
      ...(process.env.RUFUS_WEBHOOK_TOKEN ? { token: process.env.RUFUS_WEBHOOK_TOKEN } : {}),
      extraHandler: voiceHandler,
      onEvent: async (ev) => {
        await runtime.ingest(ev, { sense: 'webhook' });
      },
    }).catch((err) => {
      console.error(`HTTP server warning: ${(err as Error).message}`);
      return undefined;
    });
    console.log(
      `Rufus v2 Core running (heartbeat ${intervalMs}ms, shadow=${shadow}, tools=${core.registry.list().length}, custom=${initInfo.loadedTools.length}, sources=${hub.list().map((c) => c.id).join(',') || 'none'}${httpServer ? `, http=${httpServer.url}, voice=${httpServer.url}/voice (${tts.voice})` : ''}). Ctrl+C to stop.`,
    );
    process.once('SIGINT', () => stop.abort());
    process.once('SIGTERM', () => stop.abort());

    // Senses, channels and wakes run apart: senses keep polling during a long wake, and wakes come from one inbox.
    try {
      await runtime.run();
    } finally {
      await httpServer?.close();
      tts.close();
      await core.close();
    }
    return;
  }

  if (cmd === 'dashboard') {
    // Read-only local window into the workspace (127.0.0.1 only). Loaded lazily so it can never affect `start`.
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const workspaceDir = path.resolve(flag('--workspace') ?? dir);
    const portArg = flag('--port') ?? process.env.RUFUS_DASHBOARD_PORT ?? '4747';
    const port = Number(portArg);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port needs a port number from 0 to 65535 (got "${portArg}")`);
    const { startDashboard } = await import('./dashboard/server');
    const dash = await startDashboard({ workspaceDir, port });
    console.log(`Rufus dashboard: ${dash.url}  (workspace ${workspaceDir}, read-only). Ctrl+C to stop.`);
    if (rest.includes('--open')) {
      const { execFile } = await import('node:child_process');
      execFile('open', [dash.url], () => undefined);
    }
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
    await dash.close();
    return;
  }

  if (cmd === 'stats') {
    const sc = await computeScorecard(dir);
    for (const line of formatScorecard(sc)) console.log(line);
    console.log('\nLocal bouncer:');
    for (const line of formatTrainingMetrics(await Bouncer.readMetrics(dir))) console.log(line);
    return;
  }

  if (cmd === 'verify' && rest.includes('--live')) {
    // Live replays of real owner messages, through the real model, against a copy of the workspace (nothing is sent).
    const only = rest.filter((a) => !a.startsWith('--'));
    const all = await loadScenarios(dir);
    if (!all.length) throw new Error(`No scenarios found in ${path.join(dir, 'eval', 'scenarios')}`);
    const unknown = only.filter((id) => !all.some((s) => s.id === id));
    if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(', ')}. Available: ${all.map((s) => s.id).join(', ')}`);
    const scenarios = all.filter((s) => !only.length || only.includes(s.id));
    let passedCount = 0;
    for (const scenario of scenarios) {
      console.log(`\n=== ${scenario.id}: ${scenario.description}`);
      const reasoning = new ClaudeCliProvider({ model: process.env.RUFUS_REASONING_MODEL || 'opus', timeoutMs: 180_000, cwd: dir });
      const speaker = new ClaudeCliProvider({ model: process.env.RUFUS_SPEAKER_MODEL || 'haiku', cwd: dir });
      const judgeProvider = new ClaudeCliProvider({ model: 'opus', timeoutMs: 180_000, cwd: dir });
      try {
        const r = await runScenario({
          workspaceDir: dir,
          scenario,
          reasoningProvider: reasoning,
          speakerProvider: speaker,
          judgeProvider,
          ...(pythonPath ? { pythonPath } : {}),
          log: (line) => console.log(line),
        });
        if (r.passed) passedCount++;
        console.log(`--- ${r.passed ? 'PASS' : 'FAIL'} ${r.id} (${Math.round(r.durationMs / 1000)}s)`);
        for (const c of r.checks) console.log(`   ${c.passed ? 'PASS' : 'FAIL'} ${c.name} — ${c.detail}`);
        for (const g of r.gaps) console.log(`   gap ${g.id} [${g.status}] ${g.title}`);
      } catch (err) {
        // One broken scenario must not hide the others.
        console.log(`--- FAIL ${scenario.id} (crashed: ${(err as Error).message})`);
      } finally {
        reasoning.close?.();
        speaker.close?.();
        judgeProvider.close?.();
      }
    }
    console.log(`\nLive replays: ${passedCount}/${scenarios.length} pass`);
    if (passedCount !== scenarios.length) process.exitCode = 1;
    return;
  }

  if (cmd === 'verify') {
    console.log(`Measuring Rufus against docs/OUTLINE.md (workspace ${dir}, about 30s, sends nothing)...\n`);
    const res = await verifyAllParts({ workspaceDir: dir, ...(pythonPath ? { pythonPath } : {}) });
    const passed = res.checks.filter((c) => c.passed).length;
    console.log(`Rufus vs docs/OUTLINE.md: ${passed}/${res.checks.length} checks pass (${res.checks.length ? Math.round((100 * passed) / res.checks.length) : 0}%)\n`);
    for (const item of [...new Set(res.checks.map((c) => c.item))]) {
      const group = res.checks.filter((c) => c.item === item);
      console.log(`${item}. ${OUTLINE_ITEMS[item] ?? 'Other'} — ${group.filter((c) => c.passed).length}/${group.length}`);
      for (const c of group) console.log(`   ${c.passed ? 'PASS' : 'FAIL'} [${c.where}] ${c.component} — ${c.detail}`);
    }
    const failing = res.checks.filter((c) => !c.passed);
    if (failing.length) {
      console.log(`\n${failing.length} failing:`);
      for (const c of failing) console.log(`   ${c.item}. ${c.component} — ${c.detail}`);
    }
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'promote') {
    const prepare = rest.includes('--prepare');
    const reasonIdx = rest.indexOf('--reason');
    const reason = reasonIdx >= 0 ? rest[reasonIdx + 1] : undefined;
    const ref = rest.find((a, i) => !a.startsWith('--') && (reasonIdx < 0 || i !== reasonIdx + 1));
    const res = await promote(
      { workspaceDir: dir, releasesDir: defaultReleasesDir(), sourceDir: sourceRepoDir(), plistPath: launchAgentPath(DAEMON_LABEL) },
      { ...(ref ? { ref } : {}), prepare, ...(reason ? { reason } : {}) },
    );
    console.log(res.summary);
    if (!res.ok) process.exitCode = 1;
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
        if (!pythonPath || !existsSync(pythonPath)) {
          throw new Error(`No SetFit python at ${pythonPath ?? '(none)'}. Create the venv (see README) or set RUFUS_PYTHON.`);
        }
        const res = await bouncer.trainSetFit();
        if (!res.ok) {
          console.error(`Bouncer training failed: ${res.error ?? 'unknown error'}`);
          process.exitCode = 1;
        } else {
          console.log(`Trained on ${res.examples ?? 0} example(s)${res.seconds !== undefined ? ` in ${Math.round(res.seconds)}s` : ''}: ${res.promoted ? 'promoted' : 'kept the previous model'} (${res.reason ?? 'no reason given'})`);
          for (const line of formatTrainingMetrics(await Bouncer.readMetrics(dir))) console.log(line);
        }
      } else if (sub === 'test') {
        const text = args.join(' ').trim();
        if (!text) throw new Error('Usage: rufus bouncer test <text...>');
        const ev = messageEvent({ channel: 'test', actor: 'other', text, timestamp: new Date().toISOString() });
        const d = await bouncer.decide(ev);
        console.log(`${d.label} (${d.backend}, confidence ${d.confidence}, ${Math.round(d.durationMs)}ms)${d.reason ? `: ${d.reason}` : ''}`);
      } else {
        throw new Error('Usage: rufus bouncer [status | train | test <text...>]');
      }
    } finally {
      await bouncer.close();
    }
    return;
  }

  const help = [
    `Rufus (workspace ${dir}; set RUFUS_DIR to change it)`,
    '',
    '  rufus start [--shadow]               Run the daemon: senses, Telegram, voice and webhook (--shadow logs instead of sending)',
    '  rufus wake <text...>                 Wake Rufus once with a message from the owner',
    '  rufus startup [--shadow]             Run the startup orientation once',
    '  rufus init                           Create the workspace folders',
    '  rufus tools                          List every tool Rufus can call',
    '  rufus stats                          Scorecard: wakes, tool success, owner outcomes, model cost, channel failures',
    '  rufus verify                         Measure the code against docs/OUTLINE.md (about 30s, sends nothing)',
    '  rufus verify --live [scenario...]    Replay real owner messages through the real model on a copy of the workspace',
    '  rufus promote [ref] [--prepare]      Build, check, and switch the daemon to a checked release',
    '  rufus bouncer status                 Count the bouncer training examples',
    '  rufus bouncer train                  Retrain the local SetFit bouncer (kept only if held-out WAKE recall holds)',
    '  rufus bouncer test <text...>         Show what the bouncer decides for a message',
    '  rufus dashboard [--port N] [--workspace DIR] [--open]  Read-only dashboard on 127.0.0.1 (default port 4747)',
  ].join('\n');
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(help);
    return;
  }
  console.error(`Unknown command: ${cmd}\n`);
  console.error(help);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
