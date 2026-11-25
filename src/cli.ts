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
import { formatSpectrum, spectrumOf, spectrumTotal } from './engine/spectrum';
import { describeTension } from './learning/lessons';
import { formatCompare } from './learning/compare';
import { bucketsFromConfig, defaultMineProvider, formatMine, mineHistory } from './history/mine';
import { backtest, formatBacktest } from './history/backtest';
import { formatSeed, loadPairs, seedHistory } from './history/seed';
import { CorpusStore, EmbeddingCache, buildCorpusSummary, collectInto, corpusEmbedItems, corpusItemsFromPairs, createEmbeddingProvider, formatCorpusSummary, formatHits, getAdapter, pairEmbedItems, queryCorpus, type EmbedItem, type EmbeddingProvider } from './corpus';
import type { EmbeddingConfig } from './types';
import { suggestLayer } from './learning/layers';
import type { ScopedReplayReport } from './learning/replay';
import { Scheduler, type TickResult } from './scheduler/scheduler';
import { parseDuration } from './scheduler/triggers';
import { FileStore } from './store';
import type { Flow, RunResult } from './types';
import {
  BLOCK_KINDS,
  formatAnchorSummary,
  initAnchor,
  loadAnchor,
  parseTimeRange,
  saveAnchor,
  upsertGoal,
  upsertScheduleBlock,
  type BlockKind,
  type GoalHorizon,
  type GoalPriority,
} from './anchor/anchor';
import { formatTrust, TrustStore } from './engine/trust';
import { formatLoopReport, formatLoopRun, MasterLoop, type Sensor, type SignalHandler } from './engine/loop';
import { appendSignal, inboxSensor, scheduleBlockHandler } from './engine/loop-builtins';
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
                               show saved lessons (layer, and any in tension with your latest replies), or prune stale ones
  propose <scope> <rule...> [--layer code|context|principle] [--sample N] [--force]
                               replay the scope with the rule on trial; save it only if nothing regresses
  demo [--reply <text>]        run the example flow (add --reply to answer it right away)
  tick                         one scheduler pass: start flows whose trigger is due (for cron/launchd)
  watch [--interval <30s>]     keep ticking in the foreground (default every 60s)
  emit <event> [payloadJson]   fire flows with an onEvent(<event>) trigger
  seed <file> --flow <flowId> [--step <aiStep>] [--limit N] [--dry-run] [--include-noise]
                               Day 1: load real past (incoming -> reply) pairs from a JSON/JSONL file as replay cases
  mine [--ai] [--provider <name>] [--limit N] [--scope <scope>] [--half-life <days>] [--json] [--save]
                               what your history says: voice, rules, recurring intents, drift from saved lessons (free, offline);
                               --ai adds workflow blueprints and lessons from a provider
  replay <flowId> [--limit N] [--provider <name>]
                               re-run saved human-reviewed cases against today's flow and verify checks
  replay --scope <flow:id|role:name|global> [--sample N]
                               replay a scope; global replays a small golden sample of every flow
  compare <flowId> [--limit N] [--provider <name>]
                               plain AI vs. code-assisted AI on your saved cases, same verify
  backtest [--count N] [--channel <name>] [--mode offline|ai] [--provider fast|smart|<name>] [--latest] [--limit N] [--json]
                               time-travel check: pick N real past moments, rewind to just before each (ONLY earlier pairs and
                               corpus items are visible), predict your reply from the closest and newest real examples, and
                               compare with what you actually did. Offline (default) is free; --provider runs a live AI.
  collect <source> <path...> [--limit N] [--dry-run] [--ignore a,b] [--me addr,addr]
                               add local activity to your life corpus. <source> is files (notes/markdown/CSV/JSON
                               folders), calendar (.ics or JSON), browser (history JSON/JSONL or a Chrome/Arc/Safari
                               history database), email (.mbox, .eml, or JSONL) or ai-prompts (JSON/JSONL AI chat
                               transcripts; ONLY your own messages are kept, never the assistant's). Deduplicated; --dry-run writes nothing
  embed [--provider local|ollama|gemini|http] [--model <name>]
                               cache vectors for your corpus, chats and past replies (incremental: only new or changed
                               items are embedded). Runs by itself on collect. Default local: offline, $0
  context [query] [--source a,b] [--since <days>] [--limit N] [--half-life <days>] [--json]
                               your Life Context Snapshot (recency-weighted), or a $0 keyword lookup across chats, email,
                               browsing, files and calendar
  chat <message...>            talk to your chief of staff: status, flows, lessons, run <flow> [json],
                               learn <scope>: <rule>, or ask anything in your own words

The Master Loop (Sense -> Plan -> Execute -> Verify -> Record):
  anchor                       show your Anchor: goals, projects, boundaries and today's schedule
  anchor init                  create anchor.json with the default boundaries (external, money, logins need your yes)
  anchor goal <title...> [--priority high|medium|low] [--horizon today|week|month] [--notes <text>]
  anchor block <HH:MM-HH:MM> <kind> <title...> [--date YYYY-MM-DD] [--allow-overlap]
                               kind: focus, meeting, break, scroll, personal, protected (overlaps are refused)
  trust                        Earned Trust per action type: check (you verify) or autonomous
  trust promote|demote <actionType>
  signal <surface> <kind> [text...] [--data <json>]
                               drop a signal into inbox.jsonl for the loop to pick up
  loop --once                  one pass: sense new signals, plan, execute, verify, record. No signals: idle, $0
  loop [--interval <60s>]      keep passing in the foreground
  loop status                  runs waiting for you
  decide <runId> accept|edit|reject [note...] [--output <your version>]
                               your verdict: updates Earned Trust and becomes an example Rufus learns from
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

/** Workspace loop modules: any `flows/*.loop.{ts,js,mjs}` exporting sensors and signal handlers (or arrays of them). */
async function loadWorkspaceLoopParts(store: FileStore): Promise<{ sensors: Sensor[]; handlers: SignalHandler<any, any>[] }> {
  let files: string[];
  try {
    files = await fs.readdir(store.flowsDir);
  } catch {
    return { sensors: [], handlers: [] };
  }
  const sensors: Sensor[] = [];
  const handlers: SignalHandler<any, any>[] = [];
  for (const f of files.filter((f) => /\.loop\.(ts|js|mjs)$/.test(f)).sort()) {
    const mod = (await import(pathToFileURL(path.join(store.flowsDir, f)).href)) as Record<string, unknown>;
    for (const v of Object.values(mod).flatMap((x) => (Array.isArray(x) ? x : [x]))) {
      const o = v as Record<string, unknown> | null;
      if (!o || typeof o !== 'object' || typeof o.id !== 'string') continue;
      if (typeof o.poll === 'function') sensors.push(o as unknown as Sensor);
      else if (typeof o.plan === 'function' && typeof o.execute === 'function' && o.match) handlers.push(o as unknown as SignalHandler<any, any>);
    }
  }
  return { sensors, handlers };
}

async function describe(result: RunResult, io: Io, store: FileStore): Promise<void> {
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
  // Which rung of the spectrum (code -> fast -> smart -> human) did the work.
  const run = await store.getRun(result.runId).catch(() => undefined);
  if (run && spectrumTotal(spectrumOf(run)) > 0) io.out(`Handled by: ${formatSpectrum(spectrumOf(run))}`);
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
  const includeNoise = bool('--include-noise');
  const useAi = bool('--ai');
  const asJson = bool('--json');
  const save = bool('--save');
  const latest = bool('--latest');
  const allowOverlap = bool('--allow-overlap');
  let dir = process.env.RUFUS_HOME ?? path.join(os.homedir(), '.rufus');
  const flags: Record<string, string | undefined> = {};
  for (const flag of ['--dir', '--reply', '--limit', '--interval', '--scope', '--sample', '--layer', '--older-than', '--max-unused', '--channel', '--flow', '--step', '--provider', '--me', '--ignore', '--source', '--since', '--half-life', '--model', '--count', '--mode', '--priority', '--horizon', '--notes', '--date', '--output', '--data']) {
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

  /** `--half-life <days>`: 0 turns recency weighting off. */
  const halfLife = ((): number | undefined => {
    const v = flags['--half-life'];
    if (v === undefined) return undefined;
    if (!(Number(v) >= 0)) throw new Error('--half-life needs a number of days (0 turns weighting off).');
    return Number(v);
  })();
  /** The embedding provider: `--provider`/`--model` for `embed`, else `config.embeddings`, else local (offline, $0). */
  const embeddingProvider = (override = false): EmbeddingProvider => {
    const cfg: EmbeddingConfig = { ...config.embeddings };
    if (override && flags['--provider'] !== undefined) {
      const type = flags['--provider'] as EmbeddingConfig['type'];
      if (!['local', 'ollama', 'gemini', 'http'].includes(type!)) throw new Error('--provider for embed must be local, ollama, gemini or http.');
      if (type !== cfg.type) for (const k of ['model', 'baseUrl', 'dimensions'] as const) delete cfg[k]; // those belong to the configured provider
      cfg.type = type;
    }
    if (override && flags['--model'] !== undefined) cfg.model = flags['--model'];
    return createEmbeddingProvider(cfg);
  };
  const list = (v: string | undefined): string[] | undefined => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

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
      return describe(await engine.start(flowId, inputJson ? JSON.parse(inputJson) : undefined), io, store);
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
      return describe(await engine.answer(card.id, parsed), io, store);
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
      // Lessons are living beliefs: check them against your reply history (if any) so one list shows the lessons and which are in tension.
      await engine.reviewLessons();
      const lessons = await engine.lessons.all();
      if (!lessons.length) return io.out('No lessons yet. Reply to a card with a "Lesson: <rule>" line to add one.');
      const ready = new Set((await engine.lessons.candidatesForCode()).map((l) => l.id));
      const cap = engine.lessons.maxLessonsPerScope;
      const activeByScope = new Map<string, number>();
      for (const l of lessons) if (!l.hardened) activeByScope.set(l.scope, (activeByScope.get(l.scope) ?? 0) + 1);
      for (const l of lessons) {
        const tag = l.hardened ? ' [in code]' : ready.has(l.id) ? ' [ready to harden into code]' : '';
        const layer = l.layer === 'principle' ? '' : `  [${l.layer}]`;
        const tension = l.evidence?.status === 'tension' ? ' [in tension]' : '';
        io.out(`${l.id}  x${l.count}  ${l.scope}${layer}  ${l.rule}${tag}${tension}`);
        const question = describeTension(l);
        if (question) io.out(`    ${question}`);
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
      if (first.status !== 'waiting_human') return describe(first, io, store);
      const run = await store.getRun(first.runId);
      const attempts = run.steps['ai:draft-reply']?.attempts;
      io.out(`The AI draft failed the code check once and was retried (attempts: ${attempts}).\n`);
      if (reply === undefined) return describe(first, io, store);
      io.out(formatCardAsText(first.card));
      io.out(`\n> ${reply}\n`);
      const parsed = parseTextReply(reply, first.card);
      if (!parsed) throw new Error('Could not read that reply.');
      return describe(await engine.answer(first.card.id, parsed), io, store);
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
      if (!file || !flowId) throw new Error('Usage: rufus seed <file.json|file.jsonl> --flow <flowId> [--step <aiStep>] [--limit N] [--dry-run] [--include-noise]');
      const report = await seedHistory(engine, path.resolve(file), { flowId, step: flags['--step'], limit: positive('--limit'), dryRun, includeNoise });
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
        invariantMinShare: config.mine?.invariantMinShare,
        minExceptions: config.mine?.minExceptions,
        minLift: config.mine?.minLift,
        minSlicePairs: config.mine?.minSlicePairs,
        minDistinctContacts: config.mine?.minDistinctContacts,
        maxTopContactShare: config.mine?.maxTopContactShare,
        halfLifeDays: halfLife ?? config.mine?.halfLifeDays,
        halfLifeObservations: config.mine?.halfLifeObservations,
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

    case 'backtest': {
      const mode = flags['--mode'] ?? (flags['--provider'] !== undefined ? 'ai' : 'offline');
      if (mode !== 'offline' && mode !== 'ai') throw new Error('--mode must be offline or ai.');
      if (mode === 'offline' && flags['--provider'] !== undefined) throw new Error('--provider needs --mode ai (offline mode never calls a model).');
      const pairs = await loadPairs(store);
      if (!pairs.length) return io.out('No history yet. Seed it first: rufus seed <file> --flow <flowId>.');
      let providerName = flags['--provider'];
      if (mode === 'ai' && providerName === undefined && config.providers?.smart) providerName = 'smart';
      const provider = mode === 'ai' ? engine.providerFor(providerName) : undefined;
      // Hybrid retrieval when vectors are cached; only the moment's own incoming text is embedded, and a provider that is down only costs the semantic part.
      const embedder = embeddingProvider();
      const cache = new EmbeddingCache(store.embeddingsFile);
      const report = await backtest({
        pairs,
        corpus: await new CorpusStore(store.corpusFile).load(),
        count: positive('--count') ?? 20,
        channel: flags['--channel'],
        mode,
        provider,
        providerName: providerName ?? 'default',
        pick: latest ? 'latest' : 'spread',
        embeddings: (text) => cache.lookup(embedder, text),
      });
      if (asJson) io.out(JSON.stringify(report, null, 2));
      else for (const line of formatBacktest(report, { diffs: positive('--limit') })) io.out(line);
      return;
    }

    case 'collect': {
      const [source, ...paths] = rest;
      if (!source || !paths.length) throw new Error('Usage: rufus collect <files|browser|calendar|email|ai-prompts> <path> [--limit N] [--dry-run]');
      const adapter = getAdapter(source);
      if (adapter.id !== 'files' && adapter.id !== 'ai-prompts' && paths.length > 1) throw new Error(`rufus collect ${adapter.id} takes one path (a file or a folder of exports).`);
      const options = {
        path: paths[0]!,
        limit: positive('--limit'),
        ...(adapter.id === 'files' ? { roots: paths.slice(1), ignore: list(flags['--ignore']) } : {}),
        ...(adapter.id === 'ai-prompts' ? { extraPaths: paths.slice(1) } : {}),
        ...(adapter.id === 'email' ? { me: list(flags['--me']) } : {}),
      };
      const { items, report } = await collectInto(new CorpusStore(store.corpusFile), adapter, options, { dryRun });
      io.out(`Read ${items.length} item(s) from ${adapter.id} ${paths.join(', ')}.`);
      if (dryRun) {
        io.out(`Dry run (nothing written): would add ${report.added}, update ${report.updated}, leave ${report.unchanged} unchanged; the corpus would hold ${report.total}.`);
        for (const i of items.slice(0, 5)) io.out(`  [${i.source}/${i.kind}] ${i.timestamp.slice(0, 10)}  ${i.title ?? i.summary}`);
        if (items.length > 5) io.out(`  ... and ${items.length - 5} more`);
      } else {
        io.out(`Added ${report.added}, updated ${report.updated}, unchanged ${report.unchanged}. The corpus now holds ${report.total} item(s) (${store.corpusFile}).`);
        // Incremental, in real time: only what is new or changed gets a vector. A failure never loses the collected items.
        try {
          const provider = embeddingProvider();
          const synced = await new EmbeddingCache(store.embeddingsFile).sync(corpusEmbedItems(items), provider);
          io.out(`Embedded ${synced.embedded} new or changed item(s), ${synced.cached} already cached (${provider.id}).`);
        } catch (err) {
          io.err(`Items were collected, but embedding was skipped: ${(err as Error).message} Run rufus embed to retry.`);
        }
      }
      if (report.rejected.length) io.err(`${report.rejected.length} item(s) were not valid and were skipped (first: ${report.rejected[0]!.reason}).`);
      return;
    }

    case 'embed': {
      const provider = embeddingProvider(true);
      const pairs = await loadPairs(store);
      // Corpus items, your answered chats as corpus items (for `context`), and each past incoming message (for example retrieval).
      const all: EmbedItem[] = [...corpusEmbedItems([...(await new CorpusStore(store.corpusFile).load()), ...corpusItemsFromPairs(pairs)]), ...pairEmbedItems(pairs)];
      if (!all.length) return io.out('Nothing to embed yet. Collect something first (rufus collect ...) or seed your history (rufus seed ...).');
      const r = await new EmbeddingCache(store.embeddingsFile).sync(all, provider, { prune: true });
      io.out(`Embedded ${r.embedded} new or changed item(s); ${r.cached} already cached; ${r.total} total (${provider.id}, ${store.embeddingsFile}).`);
      return;
    }

    case 'context': {
      const sources = list(flags['--source']);
      const since = positive('--since');
      const limit = positive('--limit');
      const query = rest.join(' ').trim();
      let items = [...(await new CorpusStore(store.corpusFile).load()), ...corpusItemsFromPairs(await loadPairs(store))];
      if (!query) {
        // A snapshot over the chosen sources and period.
        if (sources) items = items.filter((i) => sources.includes(i.source === 'file' ? 'files' : i.source) || sources.includes(i.source));
        if (since !== undefined) items = items.filter((i) => Date.parse(i.timestamp) >= Date.now() - since * 86400000);
        const summary = buildCorpusSummary(items, { halfLifeDays: halfLife, topN: limit });
        if (asJson) io.out(JSON.stringify(summary, null, 2));
        else for (const line of formatCorpusSummary(summary)) io.out(line);
        return;
      }
      // Hybrid when vectors are cached; a provider that is down only costs the semantic part.
      let embeddings;
      try {
        embeddings = await new EmbeddingCache(store.embeddingsFile).lookup(embeddingProvider(), query);
      } catch (err) {
        io.err(`Vector search skipped (keywords only): ${(err as Error).message}`);
      }
      const hits = queryCorpus(items, { query, sources, sinceDays: since, limit, halfLifeDays: halfLife, embeddings });
      if (asJson) io.out(JSON.stringify(hits, null, 2));
      else for (const line of formatHits(hits, query)) io.out(line);
      return;
    }

    case 'anchor': {
      const [sub, ...words] = rest;
      if (!sub) {
        const anchor = await loadAnchor(dir);
        for (const line of formatAnchorSummary(anchor)) io.out(line);
        return;
      }
      if (sub === 'init') {
        const { created } = await initAnchor(dir);
        io.out(created ? `Anchor created at ${path.join(dir, 'anchor.json')} (external sends, money and logins always need your yes).` : `Anchor already exists at ${path.join(dir, 'anchor.json')}; left as is.`);
        return;
      }
      if (sub === 'goal') {
        const title = words.join(' ').trim();
        if (!title) throw new Error('Usage: rufus anchor goal <title...> [--priority high|medium|low] [--horizon today|week|month]');
        const r = upsertGoal(await loadAnchor(dir), {
          title,
          priority: flags['--priority'] as GoalPriority | undefined,
          horizon: flags['--horizon'] as GoalHorizon | undefined,
          notes: flags['--notes'],
        });
        await saveAnchor(dir, r.anchor);
        io.out(`${r.created ? 'Added' : 'Updated'} goal ${r.goal.id}: [${r.goal.priority}] ${r.goal.title} (${r.goal.horizon}).`);
        return;
      }
      if (sub === 'block') {
        const [range, kind, ...titleWords] = words;
        if (!range || !kind || !titleWords.length) throw new Error(`Usage: rufus anchor block <HH:MM-HH:MM> <${BLOCK_KINDS.join('|')}> <title...> [--date YYYY-MM-DD] [--allow-overlap]`);
        if (!(BLOCK_KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${BLOCK_KINDS.join(', ')}.`);
        const r = upsertScheduleBlock(
          await loadAnchor(dir),
          { ...parseTimeRange(range), kind: kind as BlockKind, title: titleWords.join(' '), source: 'manual' },
          { date: flags['--date'], allowOverlap },
        );
        await saveAnchor(dir, r.anchor);
        io.out(`${r.created ? 'Added' : 'Updated'} ${r.block.start}-${r.block.end} ${r.block.kind} "${r.block.title}" on ${r.anchor.schedule.date}.`);
        if (r.overlaps.length) io.out(`Note: overlaps ${r.overlaps.map((b) => `${b.start}-${b.end} "${b.title}"`).join(', ')} (allowed with --allow-overlap).`);
        return;
      }
      throw new Error('Usage: rufus anchor [init | goal <title...> | block <HH:MM-HH:MM> <kind> <title...>]');
    }

    case 'trust': {
      const [sub, actionType] = rest;
      const trust = new TrustStore(dir);
      if (!sub) {
        for (const line of formatTrust(await trust.all())) io.out(line);
        return;
      }
      if ((sub === 'promote' || sub === 'demote') && actionType) {
        const r = sub === 'promote' ? await trust.promote(actionType) : await trust.demote(actionType);
        io.out(
          r.autonomy === 'autonomous'
            ? `${r.actionType} is now autonomous: verified results complete without asking (external sends, money and logins still ask).`
            : `${r.actionType} is back to check: you verify every result.`,
        );
        return;
      }
      throw new Error('Usage: rufus trust [promote|demote <actionType>]');
    }

    case 'signal': {
      const [surface, kind, ...words] = rest;
      if (!surface || !kind) throw new Error('Usage: rufus signal <surface> <kind> [text...] [--data <json>]');
      const data = flags['--data'] !== undefined ? (JSON.parse(flags['--data']) as unknown) : undefined;
      if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) throw new Error('--data must be a JSON object.');
      const text = words.join(' ').trim();
      const s = await appendSignal(dir, { surface, kind, ...(text ? { text } : {}), ...(data ? { data: data as Record<string, unknown> } : {}) });
      io.out(`Queued signal ${s.id} (${surface}/${kind}). Run rufus loop --once to handle it.`);
      return;
    }

    case 'loop':
    case 'decide': {
      const parts = await loadWorkspaceLoopParts(store);
      const loop = new MasterLoop({
        dir,
        providers: {
          ...(built.provider ? { default: built.provider } : {}),
          ...(built.providers.fast ? { fast: built.providers.fast } : {}),
          ...(built.providers.smart ? { smart: built.providers.smart } : {}),
        },
      });
      for (const s of parts.sensors) loop.addSensor(s);
      if (!parts.sensors.some((s) => s.id === 'inbox')) loop.addSensor(inboxSensor(dir));
      for (const h of parts.handlers) loop.addHandler(h);
      if (!parts.handlers.some((h) => h.id === scheduleBlockHandler.id)) loop.addHandler(scheduleBlockHandler);

      if (cmd === 'decide') {
        const [runId, verdict, ...words] = rest;
        if (!runId || !verdict || !['accept', 'edit', 'reject'].includes(verdict)) throw new Error('Usage: rufus decide <runId> accept|edit|reject [note...] [--output <your version>]');
        const output = flags['--output'];
        const editedOutput = output === undefined ? undefined : (() => {
          try {
            return JSON.parse(output) as unknown;
          } catch {
            return output;
          }
        })();
        const note = words.join(' ').trim();
        const r = await loop.resolveHumanDecision(runId, { verdict: verdict as 'accept' | 'edit' | 'reject', ...(editedOutput !== undefined ? { editedOutput } : {}), ...(note ? { note } : {}) });
        io.out(`Recorded ${verdict} on ${runId}: now ${r.run.status}${r.run.committed ? ' (applied)' : ''}.`);
        if (r.run.commitError) io.err(`Not applied: ${r.run.commitError}`);
        if (r.trust) io.out(`Trust for ${r.trust.record.actionType}: ${r.trust.record.autonomy}, clean streak ${r.trust.record.consecutiveClean}/${r.trust.record.promotionThreshold}${r.trust.demoted ? ' (demoted back to check)' : ''}.`);
        if (r.promotionHint) io.out(r.promotionHint);
        if (r.run.status !== 'accepted' && r.run.status !== 'edited' && r.run.status !== 'rejected') for (const line of formatLoopRun(r.run)) io.out(line);
        io.out(`Saved as an example (${r.example.id}).`);
        return;
      }

      if (rest[0] === 'status') {
        const waiting = await loop.pending();
        if (!waiting.length) return io.out('No loop runs waiting on you.');
        io.out(`Waiting on you (${waiting.length}):`);
        for (const run of waiting) for (const line of formatLoopRun(run)) io.out(line);
        return;
      }
      if (once) {
        const report = await loop.runOnce();
        for (const line of formatLoopReport(report)) io.out(line);
        if (report.errors.length) process.exitCode = 1;
        return;
      }
      const intervalMs = parseDuration(flags['--interval'] ?? '60s');
      io.out(`Master Loop running every ${flags['--interval'] ?? '60s'}. Ctrl+C to stop.`);
      const stop = new AbortController();
      process.once('SIGINT', () => stop.abort());
      process.once('SIGTERM', () => stop.abort());
      while (!stop.signal.aborted) {
        try {
          const report = await loop.runOnce();
          if (report.status !== 'idle' || report.errors.length) for (const line of formatLoopReport(report)) io.out(line);
        } catch (err) {
          io.err(`loop pass failed: ${(err as Error).message}`);
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, intervalMs);
          stop.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
        });
      }
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
