#!/usr/bin/env -S npx tsx
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBeeperChannel } from './channels/beeper';
import { CardBridge, type LiveChannel, type TickReport } from './channels/bridge';
import { formatCardAsText, parseTextReply } from './channels/text';
import { Engine } from './engine/engine';
import { isFlow } from './engine/flow';
import { createProvider } from './engine/providers';
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
  bridge [--once] [--interval <sec>]
                               text new cards to your chat (Beeper) and apply your replies
  lessons                      show saved lessons and which are ready to become code
  demo [--reply <text>]        run the example flow (add --reply to answer it right away)
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

export interface MainOptions {
  /** Override the channel used by `bridge` (default: Beeper, from config.json / RUFUS_BEEPER_* env). */
  channel?: LiveChannel;
}

function describeTick(r: TickReport): string[] {
  const lines = r.delivered.map((id) => `sent card ${id}`);
  lines.push(...r.answered.map((id) => `answered card ${id}`));
  return lines;
}

export async function main(argv: string[], io: Io = consoleIo, options: MainOptions = {}): Promise<void> {
  const args = [...argv];
  const once = args.includes('--once');
  if (once) args.splice(args.indexOf('--once'), 1);
  let dir = process.env.RUFUS_HOME ?? path.join(os.homedir(), '.rufus');
  let reply: string | undefined;
  let intervalSec = 5;
  for (const flag of ['--dir', '--reply', '--interval']) {
    const i = args.indexOf(flag);
    if (i === -1) continue;
    const value = args[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    args.splice(i, 2);
    if (flag === '--dir') dir = path.resolve(value);
    else if (flag === '--interval') intervalSec = Number(value);
    else reply = value;
  }

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

    case 'bridge': {
      if (!(intervalSec > 0)) throw new Error('--interval needs a number of seconds above 0.');
      const channel = options.channel ?? createBeeperChannel(config.beeper);
      const bridge = new CardBridge({ engine, channel });
      let lastError: string | undefined;
      const report = (r: TickReport): void => {
        for (const line of describeTick(r)) io.out(line);
        if (r.error && r.error !== lastError) io.err(`Channel problem (will keep retrying): ${r.error}`);
        if (!r.error && lastError) io.out('Channel is back.');
        lastError = r.error;
      };
      if (once) {
        const r = await bridge.tick();
        report(r);
        if (r.error) process.exitCode = 1;
        else if (!describeTick(r).length) io.out('Nothing new.');
        return;
      }
      io.out(`Bridge running (every ${intervalSec}s). Ctrl+C to stop.`);
      const stop = new AbortController();
      process.once('SIGINT', () => stop.abort());
      process.once('SIGTERM', () => stop.abort());
      return bridge.run({ intervalMs: intervalSec * 1000, signal: stop.signal, onTick: report });
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
