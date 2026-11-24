#!/usr/bin/env -S npx tsx
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatCardAsText, parseTextReply } from './channels/text';
import { Engine } from './engine/engine';
import { isFlow } from './engine/flow';
import { createProvider } from './engine/providers';
import { Scheduler, type TickResult } from './scheduler/scheduler';
import { parseDuration } from './scheduler/triggers';
import { FileStore } from './store';
import type { Flow, RunResult } from './types';
import { demoInput, demoProvider, triageDraft } from '../examples/triage-draft.flow';

const USAGE = `rufus - AI + Code + Human chief-of-staff engine

Usage: rufus [--dir <workspace>] <command>

  init                         create the workspace (default ~/.rufus, or $RUFUS_HOME)
  flows                        list available flows
  run <flowId> [inputJson]     start a flow
  pending                      show cards waiting for you ("Your Turn")
  answer <cardId> <reply...>   answer a card: a number, an option name, or your own words
  lessons                      show saved lessons and which are ready to become code
  demo [--reply <text>]        run the example flow (add --reply to answer it right away)
  tick                         one scheduler pass: start flows whose trigger is due (for cron/launchd)
  watch [--interval <30s>]     keep ticking in the foreground (default every 60s)
  emit <event> [payloadJson]   fire flows with an onEvent(<event>) trigger
  replay <flowId> [--limit N]  re-run saved human-reviewed cases against today's flow and verify checks
`;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };

/** Workspace flows: any `flows/*.flow.{ts,js,mjs}` exporting a `defineFlow(...)` result. */
async function loadWorkspaceFlows(store: FileStore): Promise<Flow[]> {
  let files: string[];
  try {
    files = await fs.readdir(store.flowsDir);
  } catch {
    return [];
  }
  const flows: Flow[] = [];
  for (const f of files.filter((f) => /\.flow\.(ts|js|mjs)$/.test(f))) {
    const mod = (await import(pathToFileURL(path.join(store.flowsDir, f)).href)) as Record<string, unknown>;
    flows.push(...Object.values(mod).filter(isFlow));
  }
  return flows;
}

function describeTick(r: TickResult, io: Io): void {
  if (r.status === 'ran' && r.run) {
    const run = r.run;
    const tail =
      run.status === 'waiting_human' ? `waiting for you (rufus answer ${run.card.id} <reply>)` : run.status === 'failed' ? `failed: ${run.error}` : 'done';
    io.out(`ran ${r.flowId}: ${tail}`);
  } else if (r.status === 'error') {
    io.err(`error ${r.flowId}: ${r.error}`);
  } else {
    io.out(`skipped ${r.flowId}: ${r.status.replace('-', ' ')}`);
  }
}

function describe(result: RunResult, io: Io): void {
  if (result.status === 'completed') {
    io.out(`Done (${result.runId}).`);
    io.out(JSON.stringify(result.output, null, 2));
  } else if (result.status === 'failed') {
    io.err(`Run ${result.runId} failed: ${result.error}`);
    process.exitCode = 1;
  } else {
    io.out(`Paused (${result.runId}), waiting for you:\n`);
    io.out(formatCardAsText(result.card));
    io.out(`\nAnswer with: rufus answer ${result.card.id} <reply>`);
  }
}

export async function main(argv: string[], io: Io = consoleIo): Promise<void> {
  const args = [...argv];
  let dir = process.env.RUFUS_HOME ?? path.join(os.homedir(), '.rufus');
  const flags: Record<string, string | undefined> = {};
  for (const flag of ['--dir', '--reply', '--limit', '--interval']) {
    const i = args.indexOf(flag);
    if (i === -1) continue;
    const value = args[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    args.splice(i, 2);
    flags[flag] = value;
  }
  if (flags['--dir']) dir = path.resolve(flags['--dir']);
  const reply = flags['--reply'];

  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help') return io.out(USAGE);

  const store = new FileStore(dir);
  await store.init();
  const config = await store.loadConfig();
  const engine = new Engine({
    store,
    provider: cmd === 'demo' ? demoProvider() : createProvider(config.provider),
    flows: [triageDraft, ...(await loadWorkspaceFlows(store))],
  });

  switch (cmd) {
    case 'init':
      io.out(`Workspace ready at ${dir}`);
      io.out(`Put your flows in ${store.flowsDir} as *.flow.ts, and set "provider" in config.json.`);
      return;

    case 'flows':
      for (const { meta } of engine.listFlows()) io.out(`${meta.id}  -  ${meta.description}`);
      return;

    case 'run': {
      const [flowId, inputJson] = rest;
      if (!flowId) throw new Error('Usage: rufus run <flowId> [inputJson]');
      return describe(await engine.start(flowId, inputJson ? JSON.parse(inputJson) : undefined), io);
    }

    case 'pending': {
      const cards = await engine.pending();
      if (!cards.length) return io.out('Nothing waiting on you.');
      io.out(`Your Turn (${cards.length}):\n`);
      for (const card of cards) io.out(`${formatCardAsText(card)}\n`);
      return;
    }

    case 'answer': {
      const [cardRef, ...words] = rest;
      if (!cardRef || !words.length) throw new Error('Usage: rufus answer <cardId> <reply>');
      const run = await store.findRunByCard(cardRef);
      const card = (await engine.pending()).find((c) => c.id === run.pendingCardId)!;
      const parsed = parseTextReply(words.join(' '), card);
      if (!parsed) throw new Error(`Could not read that as an answer. This card only takes: ${card.options.map((o, i) => `${i + 1} (${o.label})`).join(', ')}.`);
      return describe(await engine.answer(card.id, parsed), io);
    }

    case 'lessons': {
      const lessons = await engine.lessons.all();
      if (!lessons.length) return io.out('No lessons yet. Reply to a card with a "Lesson: <rule>" line to add one.');
      const ready = new Set((await engine.lessons.candidatesForCode()).map((l) => l.id));
      for (const l of lessons) {
        const tag = l.hardened ? ' [in code]' : ready.has(l.id) ? ' [ready to harden into code]' : '';
        io.out(`${l.id}  x${l.count}  ${l.scope}  ${l.rule}${tag}`);
      }
      return;
    }

    case 'demo': {
      io.out('Demo: code -> ai (with verify retry) -> human pause -> resume -> code\n');
      const first = await engine.start('triage-draft', demoInput);
      if (first.status !== 'waiting_human') return describe(first, io);
      const run = await store.getRun(first.runId);
      const attempts = run.steps['ai:draft-reply']?.attempts;
      io.out(`The AI draft failed the code check once and was retried (attempts: ${attempts}).\n`);
      if (reply === undefined) return describe(first, io);
      io.out(formatCardAsText(first.card));
      io.out(`\n> ${reply}\n`);
      const parsed = parseTextReply(reply, first.card);
      if (!parsed) throw new Error('Could not read that reply.');
      return describe(await engine.answer(first.card.id, parsed), io);
    }

    case 'tick': {
      const results = await new Scheduler(engine).tick();
      if (!results.length) return io.out('No flows have an at()/every() trigger.');
      const acted = results.filter((r) => r.status !== 'not-due');
      if (!acted.length) return io.out('Nothing due.');
      acted.forEach((r) => describeTick(r, io));
      if (acted.some((r) => r.status === 'error')) process.exitCode = 1;
      return;
    }

    case 'emit': {
      const [event, payloadJson] = rest;
      if (!event) throw new Error('Usage: rufus emit <event> [payloadJson]');
      const results = await new Scheduler(engine).emit(event, payloadJson ? JSON.parse(payloadJson) : undefined);
      if (!results.length) return io.out(`No flow listens for "${event}".`);
      results.forEach((r) => describeTick(r, io));
      if (results.some((r) => r.status === 'error')) process.exitCode = 1;
      return;
    }

    case 'watch': {
      const intervalMs = parseDuration(flags['--interval'] ?? '60s');
      io.out(`Watching every ${flags['--interval'] ?? '60s'}. Ctrl+C to stop.`);
      const loop = new Scheduler(engine).startLoop({
        intervalMs,
        // Only report what happened; "not due", "quiet" and "gate closed" ticks stay silent.
        onTick: (results) => results.filter((r) => r.status === 'ran' || r.status === 'error').forEach((r) => describeTick(r, io)),
        onError: (err) => io.err(`tick failed: ${err.message}`),
      });
      await new Promise<void>((resolve) => process.once('SIGINT', resolve).once('SIGTERM', resolve));
      return loop.stop();
    }

    case 'replay': {
      const [flowId] = rest;
      if (!flowId) throw new Error('Usage: rufus replay <flowId> [--limit N]');
      const limit = flags['--limit'] ? Number(flags['--limit']) : undefined;
      if (limit !== undefined && !(limit > 0)) throw new Error('--limit needs a positive number.');
      const report = await engine.replay(flowId, { limit });
      if (!report.total) return io.out(`No saved cases for "${flowId}" yet. They are saved when a human answers a card.`);
      io.out(`Replayed ${report.total} case(s) for "${flowId}": ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped.`);
      io.out(`Against what the AI drafted back then: ${report.improved} improved, ${report.regressed} regressed, ${report.unchanged} unchanged.`);
      for (const r of report.results) {
        if (r.status !== 'passed') io.out(`  ${r.status.toUpperCase()} ${r.caseId} (${r.stepName}): ${r.reason}`);
      }
      if (report.failed) process.exitCode = 1;
      return;
    }

    default:
      io.err(`Unknown command "${cmd}".\n`);
      io.err(USAGE);
      process.exitCode = 1;
  }
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).catch((err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  });
}
