#!/usr/bin/env -S npx tsx
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectChannel } from './channels/select';
import { CardBridge, type LiveChannel, type TickReport } from './channels/bridge';
import { formatCardAsText, parseTextReply } from './channels/text';
import { ChiefOfStaff } from './chief/chief';
import { Engine } from './engine/engine';
import { isFlow } from './engine/flow';
import { createProviders } from './engine/providers';
import { formatCompare } from './learning/compare';
import { bucketsFromConfig, defaultMineProvider, formatMine, mineHistory } from './history/mine';
import { formatSeed, seedHistory } from './history/seed';
import { suggestLayer } from './learning/layers';
import type { ScopedReplayReport } from './learning/replay';
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
  bridge [--once] [--interval <sec>] [--channel telegram|beeper]
                               text new cards to your chat and apply your replies
  lessons [--prune [--older-than <days>] [--max-unused <n>]]
                               show saved lessons (with the layer each belongs in), or prune stale ones
  propose <scope> <rule...> [--layer code|context|principle] [--sample N] [--force]
                               replay the scope with the rule on trial; save it only if nothing regresses
  demo [--reply <text>]        run the example flow (add --reply to answer it right away)
  tick                         one scheduler pass: start flows whose trigger is due (for cron/launchd)
  watch [--interval <30s>]     keep ticking in the foreground (default every 60s)
  emit <event> [payloadJson]   fire flows with an onEvent(<event>) trigger
  seed <file> --flow <flowId> [--step <aiStep>] [--limit N] [--dry-run]
                               Day 1: load real past (incoming -> reply) pairs from a JSON/JSONL file as replay cases
  mine [--ai] [--provider <name>] [--limit N] [--scope <scope>] [--json] [--save]
                               what your history says: voice, rules, recurring intents (free, offline);
                               --ai adds workflow blueprints and lessons from a provider
  replay <flowId> [--limit N] [--provider <name>]
                               re-run saved human-reviewed cases against today's flow and verify checks
  replay --scope <flow:id|role:name|global> [--sample N]
                               replay a scope; global replays a small golden sample of every flow
  compare <flowId> [--limit N] [--provider <name>]
                               plain AI vs. code-assisted AI on your saved cases, same verify
  chat <message...>            talk to your chief of staff: status, flows, lessons, run <flow> [json],
                               learn <scope>: <rule>, or ask anything in your own words
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

function summarizeScoped(r: ScopedReplayReport): string {
  return `Replayed ${r.total} case(s) across ${r.flows.length} flow(s) in "${r.scope}": ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped; ${r.improved} improved, ${r.regressed} regressed.`;
}

export interface MainOptions {
  /** Override the channel used by `bridge` (default: Telegram or Beeper, whichever is configured). */
  channel?: LiveChannel;
}

function describeBridgeTick(r: TickReport): string[] {
  const lines = r.delivered.map((id) => `sent card ${id}`);
  lines.push(...r.answered.map((id) => `answered card ${id}`));
  return lines;
}

export async function main(argv: string[], io: Io = consoleIo, options: MainOptions = {}): Promise<void> {
  const args = [...argv];
  const once = args.includes('--once');
  if (once) args.splice(args.indexOf('--once'), 1);
  const bool = (flag: string): boolean => {
    const i = args.indexOf(flag);
    if (i !== -1) args.splice(i, 1);
    return i !== -1;
  };
  const prune = bool('--prune');
  const force = bool('--force');
  const dryRun = bool('--dry-run');
  const useAi = bool('--ai');
  const asJson = bool('--json');
  const save = bool('--save');
  let dir = process.env.RUFUS_HOME ?? path.join(os.homedir(), '.rufus');
  const flags: Record<string, string | undefined> = {};
  for (const flag of ['--dir', '--reply', '--limit', '--interval', '--scope', '--sample', '--layer', '--older-than', '--max-unused', '--channel', '--flow', '--step', '--provider']) {
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
  const built = cmd === 'demo' ? { provider: demoProvider(), providers: {} } : createProviders(config);
  const engine = new Engine({
    store,
    provider: built.provider,
    providers: built.providers,
    flows: [triageDraft, ...(await loadWorkspaceFlows(store))],
    learning: config.learning,
  });
  const positive = (flag: string): number | undefined => {
    const v = flags[flag];
    if (v === undefined) return undefined;
    if (!(Number(v) > 0)) throw new Error(`${flag} needs a positive number.`);
    return Number(v);
  };

  /** `--provider <name>`: fail on an unknown name now, instead of reporting it as a model failure per case. */
  const providerFlag = (): string | undefined => {
    const name = flags['--provider'];
    if (name !== undefined) engine.providerFor(name);
    return name;
  };

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
      const intervalSec = flags['--interval'] ? Number(flags['--interval']) : 5;
      if (!(intervalSec > 0)) throw new Error('--interval needs a number of seconds above 0.');
      const channel = options.channel ?? selectChannel(config, { channel: flags['--channel'], workspaceDir: dir }).channel;
      const bridge = new CardBridge({ engine, channel, chief: new ChiefOfStaff({ engine, provider: config.chief?.provider }) });
      let lastError: string | undefined;
      const report = (r: TickReport): void => {
        for (const line of describeBridgeTick(r)) io.out(line);
        if (r.error && r.error !== lastError) io.err(`Channel problem (will keep retrying): ${r.error}`);
        if (!r.error && lastError) io.out('Channel is back.');
        lastError = r.error;
      };
      if (once) {
        const r = await bridge.tick();
        report(r);
        if (r.error) process.exitCode = 1;
        else if (!describeBridgeTick(r).length) io.out('Nothing new.');
        return;
      }
      io.out(`Bridge running (every ${intervalSec}s). Ctrl+C to stop.`);
      const stop = new AbortController();
      process.once('SIGINT', () => stop.abort());
      process.once('SIGTERM', () => stop.abort());
      return bridge.run({ intervalMs: intervalSec * 1000, signal: stop.signal, onTick: report });
    }

    case 'lessons': {
      if (prune) {
        const num = (flag: string): number | undefined => (flags[flag] === undefined ? undefined : Number(flags[flag]));
        const removed = await engine.lessons.prune({ olderThanDays: num('--older-than'), maxUnused: num('--max-unused') });
        if (!removed.length) return io.out('Nothing to prune.');
        io.out(`Pruned ${removed.length} stale lesson(s):`);
        for (const l of removed) io.out(`  ${l.id}  x${l.count}  ${l.scope}  ${l.rule}`);
        return;
      }
      const lessons = await engine.lessons.all();
      if (!lessons.length) return io.out('No lessons yet. Reply to a card with a "Lesson: <rule>" line to add one.');
      const ready = new Set((await engine.lessons.candidatesForCode()).map((l) => l.id));
      const cap = engine.lessons.maxLessonsPerScope;
      const activeByScope = new Map<string, number>();
      for (const l of lessons) if (!l.hardened) activeByScope.set(l.scope, (activeByScope.get(l.scope) ?? 0) + 1);
      for (const l of lessons) {
        const tag = l.hardened ? ' [in code]' : ready.has(l.id) ? ' [ready to harden into code]' : '';
        const layer = l.layer === 'principle' ? '' : `  [${l.layer}]`;
        io.out(`${l.id}  x${l.count}  ${l.scope}${layer}  ${l.rule}${tag}`);
        if (!l.hardened) {
          const s = suggestLayer(l.rule);
          if (s.layer !== l.layer && s.layer !== 'principle') io.out(`    suggested layer: ${s.layer}. ${s.reason}`);
        }
      }
      for (const [scope, n] of activeByScope) if (n >= cap) io.out(`Scope ${scope} is at its cap (${n}/${cap}): consolidate or harden before adding more.`);
      return;
    }

    case 'propose': {
      const [scope, ...words] = rest;
      if (!scope || !words.length) throw new Error('Usage: rufus propose <scope> <rule...> [--layer code|context|principle] [--sample N] [--force]');
      const layer = flags['--layer'];
      if (layer !== undefined && !['code', 'context', 'principle'].includes(layer)) throw new Error('--layer must be code, context or principle.');
      const result = await engine.proposeLesson(
        { scope, rule: words.join(' '), layer: layer as 'code' | 'context' | 'principle' | undefined },
        { force, samplePerFlow: positive('--sample') },
      );
      const { report } = result;
      io.out(report.total ? summarizeScoped(report) : `No saved cases in ${scope}, so nothing was checked.`);
      if (!result.accepted) {
        io.err(result.reason);
        process.exitCode = 1;
        return;
      }
      io.out(`Saved lesson ${result.lesson.id}${report.regressed ? ' (forced past regressions)' : ''}.`);
      if (result.suggestedLayer.layer !== 'principle') io.out(`Tip: this looks like a ${result.suggestedLayer.layer} rule. ${result.suggestedLayer.reason}`);
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
      const limit = positive('--limit');
      const scope = flags['--scope'];
      if (scope !== undefined) {
        const report = await engine.replayScope(scope, { limit, samplePerFlow: positive('--sample') });
        if (!report.total) return io.out(`No saved cases for "${scope}" yet. They are saved when a human answers a card.`);
        io.out(summarizeScoped(report));
        for (const f of report.flows) {
          io.out(`  ${f.flowId}: ${f.total} case(s), ${f.passed} passed, ${f.failed} failed, ${f.skipped} skipped, ${f.regressed} regressed`);
          for (const r of f.results) if (r.status !== 'passed') io.out(`    ${r.status.toUpperCase()} ${r.caseId} (${r.stepName}): ${r.reason}`);
        }
        if (report.failed) process.exitCode = 1;
        return;
      }
      const [flowId] = rest;
      if (!flowId) throw new Error('Usage: rufus replay <flowId> [--limit N]  or  rufus replay --scope <scope> [--sample N]');
      const report = await engine.replay(flowId, { limit, provider: providerFlag() });
      if (!report.total) return io.out(`No saved cases for "${flowId}" yet. They are saved when a human answers a card.`);
      io.out(`Replayed ${report.total} case(s) for "${flowId}": ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped.`);
      io.out(`Against what the AI drafted back then: ${report.improved} improved, ${report.regressed} regressed, ${report.unchanged} unchanged.`);
      for (const r of report.results) {
        if (r.status !== 'passed') io.out(`  ${r.status.toUpperCase()} ${r.caseId} (${r.stepName}): ${r.reason}`);
      }
      if (report.failed) process.exitCode = 1;
      return;
    }

    case 'compare': {
      const [flowId] = rest;
      if (!flowId) throw new Error('Usage: rufus compare <flowId> [--limit N]');
      const report = await engine.compare(flowId, { limit: positive('--limit'), provider: providerFlag() });
      for (const line of formatCompare(report)) io.out(line);
      if (report.errored) process.exitCode = 1;
      return;
    }

    case 'seed': {
      const [file] = rest;
      const flowId = flags['--flow'];
      if (!file || !flowId) throw new Error('Usage: rufus seed <file.json|file.jsonl> --flow <flowId> [--step <aiStep>] [--limit N] [--dry-run]');
      const report = await seedHistory(engine, path.resolve(file), { flowId, step: flags['--step'], limit: positive('--limit'), dryRun });
      for (const line of formatSeed(report)) io.out(line);
      return;
    }

    case 'mine': {
      const provider = useAi ? (flags['--provider'] !== undefined ? providerFlag() : defaultMineProvider(config)) : undefined;
      if (!useAi && flags['--provider'] !== undefined) throw new Error('--provider only applies with --ai.');
      const report = await mineHistory(engine, {
        ai: useAi,
        provider,
        limit: positive('--limit'),
        buckets: bucketsFromConfig(config.mine),
        minPairs: config.mine?.minPairs,
        minShare: config.mine?.minShare,
      });
      if (save && report.pairsAnalyzed) await store.writeJson(store.mineReportFile, report);
      if (asJson) io.out(JSON.stringify(report, null, 2));
      else {
        for (const line of formatMine(report, { scope: flags['--scope'] })) io.out(line);
        if (!useAi && report.pairsAnalyzed) io.out('Add --ai for workflow blueprints and lessons from a provider.');
      }
      if (save && report.pairsAnalyzed && !asJson) io.out(`Saved ${store.mineReportFile}`);
      return;
    }

    case 'chat': {
      if (!rest.length) throw new Error('Usage: rufus chat <message...>');
      io.out(await new ChiefOfStaff({ engine, provider: config.chief?.provider }).handleMessage(rest.join(' ')));
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
