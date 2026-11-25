import { execFile } from 'node:child_process';
import { SENSITIVITIES, type Sensitivity } from '../anchor/anchor';
import type { BeeperConfig, CommandToolConfig, RufusConfig } from '../types';
import { BeeperApi, beeperApiOptions, type BeeperApiOptions } from './beeper-api';
import { webTools, type HostLookup } from './web-tools';

/**
 * Real Tool Hands: the things Rufus can actually do in your apps (read a chat, send a message, read a calendar, draft an
 * email, run a local command). Every tool is plain code. Two guardrails are enforced by the registry itself, never by
 * the caller's good manners:
 *
 *  1. Only read-only tools run while planning, executing or verifying. Anything with a side effect waits for `commit`.
 *  2. A tool marked with a sensitivity (`external`, `money`, `login`) only runs once a human approved the run, unless
 *     you trusted that tool by name (`config.tools.trusted`).
 */

export interface ToolContext {
  /** The workspace directory. */
  dir: string;
  now: Date;
  runId?: string;
  /** Which Master Loop stage is calling. Outside the loop, `commit`. */
  stage?: 'plan' | 'execute' | 'verify' | 'commit';
  /** True when a human said yes to this run (accept or edit on Verify). */
  approved?: boolean;
}

export interface ToolDefinition<A = Record<string, unknown>, R = unknown> {
  /** `beeper.send`, `calendar.read`, ... */
  name: string;
  description: string;
  /** What it touches. `external`, `money` and `login` always need a human's yes (or an explicit trust). */
  sensitivity?: Sensitivity[];
  /** True when it only reads. Default: false for safety, so it waits for `commit`. */
  readOnly?: boolean;
  /**
   * True when its only side effect is on your private local workspace (e.g. `anchor.update` editing your schedule).
   * Chat may run it right away when you ask for it explicitly; it never needs a Verify item. Ignored if it has a sensitivity.
   */
  local?: boolean;
  execute(args: A, ctx: ToolContext): R | Promise<R>;
}

/** A tool call that the guardrails stopped. Nothing was run. */
export class ToolGatedError extends Error {
  constructor(readonly tool: string, readonly reason: string) {
    super(`Tool ${tool} was not run: ${reason}`);
    this.name = 'ToolGatedError';
  }
}

/** A tool ran and failed (non-zero exit, timeout, API error). The message says what to fix. */
export class ToolError extends Error {
  constructor(readonly tool: string, detail: string) {
    super(`Tool ${tool} failed: ${detail}`);
    this.name = 'ToolError';
  }
}

const TOOL_NAME = /^[a-z0-9][a-z0-9_.:-]*$/i;

/** Why a call may not run right now, or undefined when it may. */
export function gateReason(tool: Pick<ToolDefinition, 'name' | 'sensitivity' | 'readOnly'>, ctx: Pick<ToolContext, 'stage' | 'approved'>, trusted = false): string | undefined {
  const stage = ctx.stage ?? 'commit';
  if (!tool.readOnly && stage !== 'commit') return `it has side effects, so it only runs in commit (after Verify), not during ${stage}`;
  const sensitive = (tool.sensitivity ?? []).filter((s) => SENSITIVITIES.includes(s));
  if (sensitive.length && !ctx.approved && !trusted) {
    return `it is ${sensitive.join(' + ')}, so it needs your approval first (or add "${tool.name}" to config.tools.trusted)`;
  }
  return undefined;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any, any>>();
  private readonly trusted: Set<string>;

  /** `trusted`: tool names that may run their sensitive action without a per-run yes. Empty by default. */
  constructor(opts: { tools?: ToolDefinition<any, any>[]; trusted?: string[] } = {}) {
    this.trusted = new Set(opts.trusted ?? []);
    for (const t of opts.tools ?? []) this.register(t);
  }

  register(tool: ToolDefinition<any, any>): this {
    if (!tool || typeof tool.execute !== 'function' || !TOOL_NAME.test(tool.name ?? '')) throw new Error('A tool needs a name (letters, digits, dots) and an execute() function.');
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is registered twice.`);
    this.tools.set(tool.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  isTrusted(name: string): boolean {
    return this.trusted.has(name);
  }

  /** Every tool, sorted by name. */
  list(): ToolDefinition<any, any>[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The sensitivities of the named tools (unknown names are ignored), for the Anchor's boundary check. */
  sensitivityOf(names: readonly string[]): Sensitivity[] {
    const out = new Set<Sensitivity>();
    for (const n of names) for (const s of this.tools.get(n)?.sensitivity ?? []) out.add(s);
    return [...out];
  }

  /** Runs a tool through both guardrails. Throws `ToolGatedError` (nothing ran) or the tool's own error. */
  async call<R = unknown>(name: string, args: Record<string, unknown> = {}, ctx: ToolContext): Promise<R> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolGatedError(name, `no such tool. Available: ${this.list().map((t) => t.name).join(', ') || 'none (configure tools in config.json)'}`);
    const reason = gateReason(tool, ctx, this.trusted.has(name));
    if (reason) throw new ToolGatedError(name, reason);
    return (await tool.execute(args, ctx)) as R;
  }
}

// ---------- running local commands ----------

export interface RunCommandOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Written to stdin (e.g. the tool's args as JSON). */
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs a command with no shell, returns stdout. Clear errors for a missing command, a timeout or a non-zero exit. */
export type CommandRunner = (command: string, args: string[], opts: RunCommandOptions) => Promise<string>;

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export const runCommand: CommandRunner = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, cwd: opts.cwd, env: opts.env ?? process.env, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: unknown };
        if (e.code === 'ENOENT') return reject(new Error(`command not found: ${command} (is it installed and on PATH?)`));
        if (e.killed || e.signal === 'SIGTERM') return reject(new Error(`timed out after ${timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`}: ${command}`));
        const detail = String(stderr || stdout || e.message).trim().slice(0, 300);
        reject(new Error(`${command} exited with code ${typeof e.code === 'number' ? e.code : '?'}${detail ? `: ${detail}` : ''}`));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });

/** `{{key}}` placeholders in each arg become `String(args[key] ?? '')`. */
export function fillArgs(template: readonly string[], args: Record<string, unknown>): string[] {
  return template.map((a) =>
    a.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k: string) => {
      const v = args[k];
      return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    }),
  );
}

/** Parses JSON output when it is JSON, else returns the trimmed text. */
export function parseOutput(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) return '';
  if (/^[[{"]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      /* not JSON after all */
    }
  }
  return t;
}

/** Defaults for the well-known command tool names. All of it can be overridden in config. */
export const KNOWN_COMMAND_TOOLS: Record<string, { description: string; readOnly: boolean; sensitivity?: Sensitivity[] }> = {
  'calendar.read': { description: 'Read calendar events (JSON).', readOnly: true },
  'calendar.write': { description: 'Create or change a calendar event.', readOnly: false },
  'gmail.read': { description: 'Read email threads (JSON).', readOnly: true },
  'gmail.draft': { description: 'Save an email draft (never sends).', readOnly: false },
  'shell.run': { description: 'Run a configured local command.', readOnly: false, sensitivity: ['external'] },
};

/**
 * Wraps a local CLI as a tool. The tool's args go to stdin as JSON and fill `{{key}}` placeholders in `args`.
 * Output is parsed as JSON when possible.
 */
export function commandTool(name: string, cfg: CommandToolConfig, run: CommandRunner = runCommand): ToolDefinition<Record<string, unknown>, unknown> {
  if (!cfg?.command?.trim()) throw new Error(`Tool "${name}" needs a "command" in config.tools.commands.`);
  const known = KNOWN_COMMAND_TOOLS[name];
  const readOnly = cfg.readOnly ?? known?.readOnly ?? /\.(read|list|get|search)$/.test(name);
  const sensitivity = cfg.sensitivity ?? known?.sensitivity;
  return {
    name,
    description: cfg.description ?? known?.description ?? `Runs ${cfg.command}.`,
    readOnly,
    ...(sensitivity?.length ? { sensitivity } : {}),
    async execute(args, ctx) {
      try {
        const stdout = await run(cfg.command, fillArgs(cfg.args ?? [], args), {
          timeoutMs: cfg.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          cwd: cfg.cwd ?? ctx.dir,
          input: JSON.stringify(args),
        });
        return parseOutput(stdout);
      } catch (err) {
        throw new ToolError(name, (err as Error).message);
      }
    },
  };
}

/** `beeper.read` (messages of one chat) and `beeper.send` (external: always gated). */
export function beeperTools(api: BeeperApi | BeeperApiOptions = {}): ToolDefinition<Record<string, unknown>, unknown>[] {
  const client = api instanceof BeeperApi ? api : new BeeperApi(api);
  const chatIdOf = (args: Record<string, unknown>, tool: string): string => {
    const id = args.chatId ?? args.chatID;
    if (typeof id !== 'string' || !id.trim()) throw new ToolError(tool, 'needs a chatId.');
    return id;
  };
  return [
    {
      name: 'beeper.read',
      description: 'Read the latest messages of one Beeper chat.',
      readOnly: true,
      async execute(args) {
        const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 20;
        try {
          return (await client.listMessages(chatIdOf(args, 'beeper.read'), { limit })).slice(-limit);
        } catch (err) {
          if (err instanceof ToolError) throw err;
          throw new ToolError('beeper.read', (err as Error).message);
        }
      },
    },
    {
      name: 'beeper.send',
      description: 'Send a text message to a Beeper chat. External: needs your yes.',
      readOnly: false,
      sensitivity: ['external'],
      async execute(args) {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) throw new ToolError('beeper.send', 'needs a non-empty text.');
        try {
          const id = await client.sendMessage(chatIdOf(args, 'beeper.send'), text);
          return { sent: true, ...(id ? { pendingMessageId: id } : {}) };
        } catch (err) {
          if (err instanceof ToolError) throw err;
          throw new ToolError('beeper.send', (err as Error).message);
        }
      },
    },
  ];
}

/** True when Beeper is set up enough to be used as a tool or sensor. */
export const beeperConfigured = (beeper: BeeperConfig | undefined, env: NodeJS.ProcessEnv = process.env): boolean => !!(beeper || env.RUFUS_BEEPER_TOKEN);

export interface BuildToolsOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  run?: CommandRunner;
  /** DNS for `web.fetch`'s private-address check (tests). Default: the system resolver. */
  lookup?: HostLookup;
}

/**
 * The registry from `config.json`: the read-only web tools (`web.search`, `web.fetch`; off with `tools.web: false`),
 * Beeper tools when Beeper is configured, plus each `config.tools.commands` entry.
 */
export function buildTools(config: RufusConfig, opts: BuildToolsOptions = {}): ToolRegistry {
  const env = opts.env ?? process.env;
  const registry = new ToolRegistry({ trusted: config.tools?.trusted ?? [] });
  if (beeperConfigured(config.beeper, env) && config.tools?.beeper !== false) {
    for (const t of beeperTools({ ...beeperApiOptions(config.beeper, env), ...(opts.fetch ? { fetch: opts.fetch } : {}) })) registry.register(t);
  }
  if (config.tools?.web !== false) for (const t of webTools({ ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.lookup ? { lookup: opts.lookup } : {}) })) registry.register(t);
  for (const [name, cfg] of Object.entries(config.tools?.commands ?? {})) registry.register(commandTool(name, cfg, opts.run));
  return registry;
}

/** One line per tool, for `rufus now` and docs. */
export function formatTools(registry: ToolRegistry): string[] {
  return registry.list().map((t) => {
    const flags = [t.readOnly ? 'read-only' : 'acts', ...(t.sensitivity ?? []), ...(registry.isTrusted(t.name) ? ['trusted'] : [])];
    return `${t.name} (${flags.join(', ')}): ${t.description}`;
  });
}
