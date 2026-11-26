import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProviderConfig, RufusConfig, VoiceConfig } from '../types';

/**
 * v25b: friend-ready self-onboarding. `rufus setup` turns an empty directory into a working Rufus workspace:
 *   - detects what this machine already has (Claude / Codex / Gemini CLIs, local voice tools, Beeper Desktop),
 *   - writes `config.json` when there is none (never touches an existing one),
 *   - copies the starter Layer 3 from `templates/layer3/` (SOUL.md, USER.md, MEMORY.md, taste.mjs, boundaries.mjs,
 *     frameworks/*) without ever overwriting a file you already have,
 *   - and `--check` validates the workspace end to end (config parses, the provider command exists, taste.mjs and
 *     boundaries.mjs import and run, frameworks load) as a readiness checklist.
 */

export const PROVIDER_CLIS = ['claude', 'codex', 'gemini'] as const;
export type ProviderCli = (typeof PROVIDER_CLIS)[number];
export const VOICE_TOOLS = ['say', 'ffmpeg', 'whisper-cli'] as const;
export type VoiceTool = (typeof VOICE_TOOLS)[number];
export const BEEPER_API_URL = 'http://127.0.0.1:23373';
export const SETUP_QUIET_HOURS = { start: '22:00', end: '07:00' } as const;

/** The starter Layer 3 shipped with Rufus (`<repo>/templates/layer3`). */
export const DEFAULT_TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'layer3');

/** What `detectEnvironment()` found on this machine. */
export interface SetupEnvironment {
  /** Provider CLIs on PATH, in preference order (claude, codex, gemini). */
  providers: ProviderCli[];
  /** Local voice tools on PATH. */
  voice: Record<VoiceTool, boolean>;
  /** Beeper Desktop's local API answered on 127.0.0.1:23373. */
  beeper: boolean;
  platform: NodeJS.Platform;
}

export type SetupEnv = Record<string, string | undefined>;

export interface DetectOptions {
  /** Environment variables (PATH is what matters). Default `process.env`. */
  env?: SetupEnv;
  /** Injectable for tests: the fetch used to probe Beeper Desktop. */
  fetch?: typeof fetch;
  /** Skip the Beeper probe (no network at all). */
  probeBeeper?: boolean;
  /** Default 800ms. */
  beeperTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** The full path of `name` on `env.PATH` (or `name` itself when it is a path to an executable), else `undefined`. */
export function findCommand(name: string, env: SetupEnv = process.env): string | undefined {
  const isExec = (file: string): boolean => {
    try {
      if (!statSync(file).isFile()) return false;
      accessSync(file, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (!name) return undefined;
  if (name.includes('/') || name.includes(path.sep)) return isExec(path.resolve(name)) ? path.resolve(name) : undefined;
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').concat('') : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (isExec(file)) return file;
    }
  }
  return undefined;
}

/** Is Beeper Desktop's local API answering? Any HTTP response counts (it may say 401 without a token). */
export async function probeBeeper(fetchFn: typeof fetch = fetch, timeoutMs = 800, url = BEEPER_API_URL): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchFn(url, { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** What this machine has: provider CLIs, voice tools, Beeper Desktop. Nothing is installed or changed. */
export async function detectEnvironment(opts: DetectOptions = {}): Promise<SetupEnvironment> {
  const env = opts.env ?? process.env;
  const providers = PROVIDER_CLIS.filter((c) => findCommand(c, env));
  const voice = Object.fromEntries(VOICE_TOOLS.map((t) => [t, !!findCommand(t, env)])) as Record<VoiceTool, boolean>;
  const beeper = opts.probeBeeper === false ? false : await probeBeeper(opts.fetch ?? fetch, opts.beeperTimeoutMs ?? 800);
  return { providers, voice, beeper, platform: opts.platform ?? process.platform };
}

/**
 * The `command` provider for a CLI. Claude always gets `--tools ""`: Rufus owns the tools (Verify, Earned Trust, audit),
 * so the Claude CLI must never run its own tools or stop on its own permission prompts.
 */
export function providerConfigFor(cli: ProviderCli, model?: string): ProviderConfig {
  switch (cli) {
    case 'claude':
      return { type: 'command', command: 'claude', args: ['-p', ...(model ? ['--model', model] : []), '--tools', ''] };
    case 'codex':
      return { type: 'command', command: 'codex', args: ['exec', '--skip-git-repo-check', '-'] };
    case 'gemini':
      return { type: 'command', command: 'gemini', args: ['-p', 'Answer the conversation above.', ...(model ? ['--model', model] : [])] };
  }
}

export interface StarterConfigOptions {
  /** Which detected CLI is the default provider. Default: the first detected (claude, codex, gemini). */
  provider?: ProviderCli;
  quietHours?: { start: string; end: string };
}

/** The `config.json` setup writes for a fresh workspace, from what was detected. */
export function buildStarterConfig(detected: SetupEnvironment, opts: StarterConfigOptions = {}): RufusConfig {
  const config: RufusConfig = { version: 1 };
  const main = opts.provider && detected.providers.includes(opts.provider) ? opts.provider : detected.providers[0];
  if (main) {
    config.provider = providerConfigFor(main);
    const providers: Record<string, ProviderConfig> = {};
    if (main === 'claude') {
      providers.fast = providerConfigFor('claude', 'haiku');
      providers.smart = providerConfigFor('claude', 'sonnet');
    }
    for (const cli of detected.providers) providers[cli] = providerConfigFor(cli);
    config.providers = providers;
    config.chief = { provider: main };
  }
  config.quietHours = { ...(opts.quietHours ?? SETUP_QUIET_HOURS) };
  if (detected.voice.say && detected.platform === 'darwin') {
    const voice: VoiceConfig = { tts: { command: 'say', args: ['-o', '{out}', '--data-format=LEI16@22050', '-f', '-'], outputFormat: 'wav' } };
    config.voice = voice;
  }
  return config;
}

/** Every file under `dir`, as sorted relative POSIX paths. */
export async function listTemplateFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name === '.DS_Store') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  await walk('');
  return out.sort();
}

// ---------- check ----------

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
  /** Not a failure, but worth a look (e.g. a missing optional file). */
  warn?: boolean;
}

export interface CheckReport {
  ok: boolean;
  items: CheckItem[];
}

export interface CheckOptions {
  env?: SetupEnv;
  /** Per-module timeout for the import checks. Default 15000ms. */
  timeoutMs?: number;
}

/** One sample call per Layer 3 module kind, so a check proves the code runs, not just that it parses. */
const PROBE_SCRIPT = `
const [url, exportName, kind] = process.argv.slice(1);
const out = (o) => { process.stdout.write(JSON.stringify(o)); };
try {
  const mod = await import(url);
  const fn = mod[exportName] ?? mod.default;
  if (typeof fn !== 'function') { out({ ok: false, error: 'does not export ' + exportName + '()' }); process.exit(0); }
  const samples = {
    taste: () => fn('The meeting moved to 3pm.', {}),
    boundaries: () => fn({ now: new Date(2026, 0, 7, 12, 0), sensitivity: [] }),
    verify: () => fn('Sample text.', {}),
  };
  const result = await (samples[kind] ?? samples.verify)();
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') { out({ ok: false, error: exportName + '() must return { ok: boolean, ... }' }); process.exit(0); }
  out({ ok: true });
} catch (err) {
  out({ ok: false, error: String((err && err.message) || err).split('\\n')[0] });
}
`;

/**
 * Imports a Layer 3 module in a fresh Node process (no module cache, and your code cannot touch Rufus's own process),
 * then calls its export once with a sample input.
 */
export function probeModule(file: string, exportName: string, kind: 'taste' | 'boundaries' | 'verify', timeoutMs = 15000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', PROBE_SCRIPT, pathToFileURL(file).href, exportName, kind],
      { timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(String(stdout).trim()) as { ok: boolean; error?: string };
          return resolve(parsed);
        } catch {
          const msg = String(stderr || err?.message || 'failed to load').trim().split('\n').find((l) => /Error|error/.test(l)) ?? String(stderr).trim().split('\n')[0];
          resolve({ ok: false, error: msg || 'failed to load' });
        }
      },
    );
  });
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

const exists = async (file: string): Promise<boolean> => (await readIfExists(file).catch(() => '')) !== undefined;

/** Validates a workspace end to end. Never writes anything. */
export async function checkWorkspace(dir: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const env = opts.env ?? process.env;
  const items: CheckItem[] = [];
  const add = (name: string, ok: boolean, detail: string, warn = false): void => {
    items.push({ name, ok, detail, ...(warn ? { warn } : {}) });
  };

  // config.json parses, and its providers can run.
  const configFile = path.join(dir, 'config.json');
  const raw = await readIfExists(configFile);
  let config: RufusConfig | undefined;
  if (raw === undefined) add('config.json', false, 'missing: run `rufus setup`');
  else {
    try {
      config = JSON.parse(raw) as RufusConfig;
      if (!config || typeof config !== 'object' || config.version !== 1) {
        add('config.json', false, 'parses, but needs "version": 1');
        config = undefined;
      } else add('config.json', true, 'parses');
    } catch (err) {
      add('config.json', false, `invalid JSON: ${(err as Error).message}`);
    }
  }
  if (config) {
    const named: Array<[string, ProviderConfig]> = [
      ...(config.provider ? [['provider', config.provider] as [string, ProviderConfig]] : []),
      ...Object.entries(config.providers ?? {}),
    ];
    if (!named.length) add('provider', false, 'no provider configured: install claude, codex or gemini and run `rufus setup` again, or set "provider" in config.json');
    const seen = new Set<string>();
    for (const [name, p] of named) {
      const label = name === 'provider' ? 'provider' : `providers.${name}`;
      if (p.type === 'command') {
        if (seen.has(p.command)) continue;
        seen.add(p.command);
        const found = findCommand(p.command, env);
        add(label, !!found, found ? `\`${p.command}\` found` : `\`${p.command}\` not found on PATH`);
        if (found && p.command === 'claude' && !hasEmptyTools(p.args ?? [])) add(label, true, 'claude runs without `--tools ""`: it may use its own tools and permission prompts', true);
      } else if (p.type === 'gemini') {
        const keyEnv = p.apiKeyEnv ?? 'GEMINI_API_KEY';
        add(label, !!(p.apiKey || env[keyEnv]), p.apiKey || env[keyEnv] ? 'Gemini API key set' : `Gemini API key missing: set ${keyEnv}`);
      } else if (p.type === 'openai-compatible') {
        add(label, !!p.baseUrl && !!p.model, p.baseUrl && p.model ? `${p.model} at ${p.baseUrl}` : 'needs baseUrl and model');
      } else {
        add(label, false, `unknown provider type "${(p as { type?: string }).type}"`);
      }
    }
  }

  // The words: optional, but worth having.
  for (const f of ['SOUL.md', 'USER.md', 'MEMORY.md']) {
    const ok = await exists(path.join(dir, f));
    add(f, true, ok ? 'present' : 'missing: run `rufus setup` to add the starter', !ok);
  }

  // Executable Layer 3: must import and run.
  for (const [file, exp, kind] of [
    ['taste.mjs', 'verifyDraft', 'taste'],
    ['boundaries.mjs', 'canActNow', 'boundaries'],
  ] as const) {
    const full = path.join(dir, file);
    if (!(await exists(full))) {
      add(file, false, 'missing: run `rufus setup` to add the starter');
      continue;
    }
    const r = await probeModule(full, exp, kind, opts.timeoutMs);
    add(file, r.ok, r.ok ? `imports and runs ${exp}()` : `does not load: ${r.error}`);
  }

  // Frameworks: each folder has a FRAMEWORK.md with content; a verify.mjs, when present, imports and runs.
  const fwDir = path.join(dir, 'frameworks');
  let names: string[] = [];
  try {
    names = (await fs.readdir(fwDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    /* no frameworks */
  }
  if (!names.length) add('frameworks', true, 'none: run `rufus setup` to add the starter frameworks', true);
  for (const name of names) {
    const label = `frameworks/${name}`;
    const md = await readIfExists(path.join(fwDir, name, 'FRAMEWORK.md'));
    if (md === undefined || !md.replace(/<!--[\s\S]*?-->/g, '').trim()) {
      add(label, false, 'FRAMEWORK.md missing or empty');
      continue;
    }
    const verifyFile = path.join(fwDir, name, 'verify.mjs');
    if (!(await exists(verifyFile))) {
      add(label, true, 'FRAMEWORK.md');
      continue;
    }
    const r = await probeModule(verifyFile, 'verify', 'verify', opts.timeoutMs);
    add(label, r.ok, r.ok ? 'FRAMEWORK.md + verify.mjs' : `verify.mjs does not load: ${r.error}`);
  }

  return { ok: items.every((i) => i.ok), items };
}

const hasEmptyTools = (args: string[]): boolean => args.some((a, i) => a === '--tools' && args[i + 1] === '');

/** The readiness checklist, one line per item. */
export function formatCheck(report: CheckReport): string[] {
  const lines = report.items.map((i) => `${!i.ok ? '[x]' : i.warn ? '[!]' : '[ok]'} ${i.name}: ${i.detail}`);
  const failed = report.items.filter((i) => !i.ok).length;
  lines.push(report.ok ? 'Ready: run `rufus start`.' : `Not ready: ${failed} item${failed === 1 ? '' : 's'} to fix.`);
  return lines;
}

// ---------- setup ----------

export interface SetupOptions {
  /** The workspace directory. */
  dir: string;
  /** Never ask questions (also the behavior when no `ask` is given). */
  nonInteractive?: boolean;
  /** Only validate; write nothing. */
  checkOnly?: boolean;
  /** Where the starter Layer 3 lives. Default `templates/layer3` in this repo. */
  templateDir?: string;
  /** Environment variables used for detection and checks (PATH). Default `process.env`. */
  env?: SetupEnv;
  /** Injectable for tests: the fetch used to probe Beeper Desktop. */
  fetch?: typeof fetch;
  /** Skip detection and use this instead. */
  detected?: SetupEnvironment;
  /** Interactive mode: asks a question, returns the answer (blank = default). */
  ask?: (question: string) => Promise<string>;
}

export interface SetupReport {
  dir: string;
  /** `undefined` with `checkOnly`. */
  detected?: SetupEnvironment;
  config: { file: string; created: boolean; provider?: string };
  /** Template files copied into the workspace (relative paths). */
  copied: string[];
  /** Template files you already had, left untouched. */
  kept: string[];
  check: CheckReport;
}

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

async function writeNew(file: string, text: string | Buffer): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, text, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Bootstraps (or, with `checkOnly`, validates) a workspace. Safe to run any number of times: an existing `config.json`
 * and every Layer 3 file you already have are never overwritten.
 */
export async function runSetup(opts: SetupOptions): Promise<SetupReport> {
  const dir = path.resolve(opts.dir);
  const configFile = path.join(dir, 'config.json');
  if (opts.checkOnly) {
    return { dir, config: { file: configFile, created: false }, copied: [], kept: [], check: await checkWorkspace(dir, { env: opts.env }) };
  }

  const detected = opts.detected ?? (await detectEnvironment({ env: opts.env, fetch: opts.fetch }));
  const ask = opts.nonInteractive ? undefined : opts.ask;
  await fs.mkdir(dir, { recursive: true });

  // config.json: only when missing. Secrets and your edits stay yours.
  let created = false;
  let provider: string | undefined;
  if (!(await exists(configFile))) {
    const starter: StarterConfigOptions = {};
    if (ask && detected.providers.length > 1) {
      const a = (await ask(`Default AI provider? ${detected.providers.join(' / ')} [${detected.providers[0]}]: `)).trim().toLowerCase();
      if ((detected.providers as string[]).includes(a)) starter.provider = a as ProviderCli;
    }
    if (ask) {
      const a = (await ask(`Quiet hours (HH:MM-HH:MM) [${SETUP_QUIET_HOURS.start}-${SETUP_QUIET_HOURS.end}]: `)).trim();
      const [s, e] = a.split('-').map((x) => x.trim());
      if (s && e && HHMM.test(s) && HHMM.test(e)) starter.quietHours = { start: s, end: e };
    }
    const config = buildStarterConfig(detected, starter);
    created = await writeNew(configFile, JSON.stringify(config, null, 2) + '\n');
    if (config.provider?.type === 'command') provider = config.provider.command;
  }

  // The starter Layer 3: copy what is missing, keep what is there.
  const templateDir = opts.templateDir ?? DEFAULT_TEMPLATE_DIR;
  const copied: string[] = [];
  const kept: string[] = [];
  for (const rel of await listTemplateFiles(templateDir)) {
    const data = await fs.readFile(path.join(templateDir, ...rel.split('/')));
    (await writeNew(path.join(dir, ...rel.split('/')), data) ? copied : kept).push(rel);
  }

  return { dir, detected, config: { file: configFile, created, ...(provider ? { provider } : {}) }, copied, kept, check: await checkWorkspace(dir, { env: opts.env }) };
}

/** What setup found and did, then the checklist. */
export function formatSetupReport(r: SetupReport): string[] {
  const lines: string[] = [];
  if (r.detected) {
    const d = r.detected;
    const voice = VOICE_TOOLS.filter((t) => d.voice[t]);
    lines.push(`Workspace: ${r.dir}`);
    lines.push(`Found: AI ${d.providers.length ? d.providers.join(', ') : 'none (install claude, codex or gemini)'}; voice ${voice.length ? voice.join(', ') : 'none'}; Beeper Desktop ${d.beeper ? 'reachable' : 'not running'}`);
    lines.push(r.config.created ? `Wrote config.json${r.config.provider ? ` (provider: ${r.config.provider})` : ''}.` : 'Kept your config.json (never overwritten).');
    if (r.copied.length) lines.push(`Added ${r.copied.length} starter Layer 3 file(s): ${r.copied.join(', ')}`);
    if (r.kept.length) lines.push(`Kept ${r.kept.length} file(s) you already have: ${r.kept.join(', ')}`);
    if (d.beeper) lines.push('Beeper Desktop is running: set RUFUS_BEEPER_TOKEN (and "beeper": { "chatId": ... }) to talk to Rufus there.');
    if (d.voice['whisper-cli']) lines.push('whisper-cli found: point "voice.stt" / "telegram.transcribe" at it to talk to Rufus by voice (see the README).');
    lines.push('');
  }
  lines.push(...formatCheck(r.check));
  return lines;
}
