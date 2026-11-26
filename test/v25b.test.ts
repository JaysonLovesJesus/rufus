import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE_DIR,
  buildStarterConfig,
  checkWorkspace,
  detectEnvironment,
  findCommand,
  listTemplateFiles,
  runSetup,
  type SetupEnvironment,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const read = (f: string): Promise<string> => readFile(f, 'utf8');
const noBeeper = (async () => {
  throw new Error('ECONNREFUSED');
}) as unknown as typeof fetch;

/** A temp bin dir with fake executables, as a PATH. */
async function fakeBin(names: string[]): Promise<string> {
  const bin = path.join(await tempDir(), 'bin');
  await mkdir(bin, { recursive: true });
  for (const n of names) {
    await writeFile(path.join(bin, n), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(bin, n), 0o755);
  }
  return bin;
}

function capture(): { io: { out: (l: string) => void; err: (l: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/** Runs the CLI with a fake PATH and no Beeper; restores process.exitCode. */
async function cli(argv: string[], PATH: string): Promise<{ out: string; err: string; exitCode: number }> {
  const c = capture();
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(argv, c.io, { env: { PATH }, fetch: noBeeper });
    return { out: c.out.join('\n'), err: c.err.join('\n'), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.exitCode = before;
  }
}

const TEMPLATE_FILES = [
  'MEMORY.md',
  'SOUL.md',
  'USER.md',
  'boundaries.mjs',
  'frameworks/decisions/FRAMEWORK.md',
  'frameworks/decisions/verify.mjs',
  'frameworks/operator/FRAMEWORK.md',
  'frameworks/operator/verify.mjs',
  'frameworks/research/FRAMEWORK.md',
  'frameworks/research/verify.mjs',
  'frameworks/triage/FRAMEWORK.md',
  'frameworks/voice/FRAMEWORK.md',
  'frameworks/voice/verify.mjs',
  'taste.mjs',
];

describe('v25b: environment detection and starter config', () => {
  it('finds provider CLIs and voice tools on PATH, and probes Beeper without failing when it is down', async () => {
    const PATH = await fakeBin(['claude', 'gemini', 'say', 'whisper-cli']);
    const env = await detectEnvironment({ env: { PATH }, fetch: noBeeper, platform: 'darwin' });
    expect(env).toEqual({ providers: ['claude', 'gemini'], voice: { say: true, ffmpeg: false, 'whisper-cli': true }, beeper: false, platform: 'darwin' });
    expect(findCommand('codex', { PATH })).toBeUndefined();

    const up = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
    expect((await detectEnvironment({ env: { PATH }, fetch: up })).beeper).toBe(true);
    expect((await detectEnvironment({ env: { PATH }, probeBeeper: false, fetch: up })).beeper).toBe(false);
  });

  it('always gives claude `--tools ""`, adds fast/smart tiers, and sets quiet hours', () => {
    const detected: SetupEnvironment = { providers: ['claude', 'codex'], voice: { say: true, ffmpeg: true, 'whisper-cli': false }, beeper: false, platform: 'darwin' };
    const config = buildStarterConfig(detected);
    expect(config.provider).toEqual({ type: 'command', command: 'claude', args: ['-p', '--tools', ''] });
    for (const p of [config.providers!.fast!, config.providers!.smart!, config.providers!.claude!]) {
      expect(p.type === 'command' && p.args).toEqual(expect.arrayContaining(['--tools', '']));
      const args = (p as { args: string[] }).args;
      expect(args[args.indexOf('--tools') + 1]).toBe('');
    }
    expect(config.providers!.codex).toEqual({ type: 'command', command: 'codex', args: ['exec', '--skip-git-repo-check', '-'] });
    expect(config.chief).toEqual({ provider: 'claude' });
    expect(config.quietHours).toEqual({ start: '22:00', end: '07:00' });
    expect(config.voice?.tts?.command).toBe('say');

    const codexOnly = buildStarterConfig({ ...detected, providers: ['codex'], platform: 'linux' });
    expect(codexOnly.provider).toEqual({ type: 'command', command: 'codex', args: ['exec', '--skip-git-repo-check', '-'] });
    expect(codexOnly.providers?.fast).toBeUndefined();
    expect(codexOnly.voice).toBeUndefined();
    expect(buildStarterConfig({ ...detected, providers: [] }).provider).toBeUndefined();
    expect(buildStarterConfig(detected, { provider: 'codex' }).provider).toMatchObject({ command: 'codex' });
  });

  it('ships exactly the starter Layer 3 in templates/layer3', async () => {
    expect(await listTemplateFiles(DEFAULT_TEMPLATE_DIR)).toEqual(TEMPLATE_FILES);
  });
});

describe('v25b: rufus setup', () => {
  it('--non-interactive bootstraps an empty directory: config.json with claude --tools "" and every template file', async () => {
    const dir = path.join(await tempDir(), 'fresh', 'workspace');
    const PATH = await fakeBin(['claude']);
    const r = await cli(['--dir', dir, 'setup', '--non-interactive'], PATH);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('Wrote config.json (provider: claude).');
    expect(r.out).toContain('Ready: run `rufus start`.');

    const config = JSON.parse(await read(path.join(dir, 'config.json')));
    expect(config.version).toBe(1);
    expect(config.provider).toEqual({ type: 'command', command: 'claude', args: ['-p', '--tools', ''] });
    expect(config.providers.smart.args).toEqual(['-p', '--model', 'sonnet', '--tools', '']);
    for (const f of TEMPLATE_FILES) expect(await read(path.join(dir, f))).toBe(await read(path.join(DEFAULT_TEMPLATE_DIR, f)));
  });

  it('re-running never overwrites config.json or user-modified SOUL.md, USER.md and taste.mjs, and restores deleted files', async () => {
    const dir = await tempDir();
    const PATH = await fakeBin(['claude']);
    await cli(['--dir', dir, 'setup', '--non-interactive'], PATH);

    const mine = {
      'config.json': JSON.stringify({ version: 1, provider: { type: 'command', command: 'claude', args: ['-p'] }, telegram: { token: 'secret-token' } }, null, 2),
      'SOUL.md': '# Me\nMy own words.\n',
      'USER.md': '# USER.md\n\n## People\n- A friend I always answer.\n',
      'taste.mjs': "export function verifyDraft(text) { return { ok: !/!/.test(text), problems: [] }; }\n",
    };
    for (const [f, text] of Object.entries(mine)) await writeFile(path.join(dir, f), text);
    await import('node:fs/promises').then((fs) => fs.rm(path.join(dir, 'frameworks', 'voice'), { recursive: true }));

    // A different machine (codex only) must not change the existing config either.
    const r = await cli(['--dir', dir, 'setup', '--non-interactive'], await fakeBin(['claude', 'codex']));
    expect(r.out).toContain('Kept your config.json (never overwritten).');
    for (const [f, text] of Object.entries(mine)) expect(await read(path.join(dir, f))).toBe(text);
    expect(r.out).toMatch(/Added 2 starter Layer 3 file\(s\): frameworks\/voice\/FRAMEWORK\.md, frameworks\/voice\/verify\.mjs/);
    expect(r.out).toMatch(/Kept 12 file\(s\) you already have/);
    // A config without --tools "" still runs, with a warning.
    expect(r.out).toContain('[!] provider: claude runs without `--tools ""`');

    const again = await runSetup({ dir, nonInteractive: true, env: { PATH }, fetch: noBeeper });
    expect(again.config.created).toBe(false);
    expect(again.copied).toEqual([]);
    expect(again.kept).toEqual(TEMPLATE_FILES);
  });

  it('interactive setup asks for the provider and quiet hours on a fresh workspace, and never in --non-interactive', async () => {
    const detected: SetupEnvironment = { providers: ['claude', 'gemini'], voice: { say: false, ffmpeg: false, 'whisper-cli': false }, beeper: false, platform: 'linux' };
    const questions: string[] = [];
    const answers = ['gemini', '23:00-06:30'];
    const dir = await tempDir();
    await runSetup({ dir, detected, env: { PATH: '' }, ask: async (q) => (questions.push(q), answers.shift()!) });
    expect(questions).toHaveLength(2);
    const config = JSON.parse(await read(path.join(dir, 'config.json')));
    expect(config.provider.command).toBe('gemini');
    expect(config.quietHours).toEqual({ start: '23:00', end: '06:30' });

    const asked: string[] = [];
    await runSetup({ dir: await tempDir(), detected, nonInteractive: true, env: { PATH: '' }, ask: async (q) => (asked.push(q), '') });
    expect(asked).toEqual([]);
  });

  it('--check passes on a bootstrapped workspace and catches a taste.mjs syntax error without writing anything', async () => {
    const dir = await tempDir();
    const PATH = await fakeBin(['claude']);
    await cli(['--dir', dir, 'setup', '--non-interactive'], PATH);

    const ok = await cli(['--dir', dir, 'setup', '--check'], PATH);
    expect(ok.exitCode).toBe(0);
    expect(ok.out).toContain('[ok] config.json: parses');
    expect(ok.out).toContain('[ok] provider: `claude` found');
    expect(ok.out).toContain('[ok] taste.mjs: imports and runs verifyDraft()');
    expect(ok.out).toContain('[ok] boundaries.mjs: imports and runs canActNow()');
    expect(ok.out).toContain('[ok] frameworks/decisions: FRAMEWORK.md + verify.mjs');
    expect(ok.out).toContain('[ok] frameworks/triage: FRAMEWORK.md');
    expect(ok.out).toContain('Ready: run `rufus start`.');

    await writeFile(path.join(dir, 'taste.mjs'), 'export function verifyDraft(text) {\n  return { ok: true \n');
    const broken = await cli(['--dir', dir, 'setup', '--check'], PATH);
    expect(broken.exitCode).toBe(1);
    expect(broken.out).toMatch(/\[x\] taste\.mjs: does not load: .+/);
    expect(broken.out).toContain('Not ready: 1 item to fix.');
    // --check wrote nothing: the broken file is still there.
    expect(await read(path.join(dir, 'taste.mjs'))).toContain('return { ok: true \n');
  });

  it('--check reports a missing workspace, a missing provider command, bad config and broken exports', async () => {
    const empty = await checkWorkspace(path.join(await tempDir(), 'nothing'), { env: { PATH: '' } });
    expect(empty.ok).toBe(false);
    expect(empty.items.find((i) => i.name === 'config.json')).toMatchObject({ ok: false, detail: expect.stringContaining('rufus setup') });

    const dir = await tempDir();
    await runSetup({ dir, nonInteractive: true, env: { PATH: await fakeBin(['claude']) }, fetch: noBeeper });
    const noClaude = await checkWorkspace(dir, { env: { PATH: '' } });
    expect(noClaude.items.find((i) => i.name === 'provider')).toMatchObject({ ok: false, detail: '`claude` not found on PATH' });

    await writeFile(path.join(dir, 'boundaries.mjs'), 'export const nothing = 1;\n');
    await writeFile(path.join(dir, 'frameworks', 'voice', 'verify.mjs'), 'export function verify() { return "yes"; }\n');
    await writeFile(path.join(dir, 'config.json'), '{ "version": 1, ');
    const bad = await checkWorkspace(dir, { env: { PATH: '' } });
    const by = (n: string) => bad.items.find((i) => i.name === n);
    expect(by('config.json')).toMatchObject({ ok: false, detail: expect.stringContaining('invalid JSON') });
    expect(by('boundaries.mjs')).toMatchObject({ ok: false, detail: expect.stringContaining('does not export canActNow()') });
    expect(by('frameworks/voice')).toMatchObject({ ok: false, detail: expect.stringContaining('must return { ok: boolean') });
  });
});

describe('v25b: starter Layer 3 code', () => {
  const load = async (rel: string): Promise<Record<string, any>> => import(pathToFileURL(path.join(DEFAULT_TEMPLATE_DIR, rel)).href);

  it('taste.mjs: bans sycophantic openers, leaked internal paths and punted lookups', async () => {
    const { verifyDraft } = await load('taste.mjs');
    expect(verifyDraft('Moved your 3pm to Thursday at 10.', {})).toEqual({ ok: true, problems: [] });
    expect(verifyDraft('Great question! It is Thursday.').ok).toBe(false);
    expect(verifyDraft("You're absolutely right, it moved.").reason).toMatch(/flattery/);
    expect(verifyDraft('I updated src/unified/daemon.ts for you.').problems.join(' ')).toMatch(/source path/);
    expect(verifyDraft('Saved it in config.json.').reason).toMatch(/\.json file/);
    expect(verifyDraft('Saved it in config.json.', { allowPaths: true }).ok).toBe(true);
    expect(verifyDraft('Not sure when it opens. Want me to look it up?').reason).toMatch(/look something up/);
    expect(verifyDraft('I can check if you like.').ok).toBe(false);
    expect(verifyDraft('I checked: it opens at 9.').ok).toBe(true);
    expect(verifyDraft('').ok).toBe(false);
  });

  it('boundaries.mjs: quiet hours and always-ask on money and login', async () => {
    const { canActNow, isQuietHours } = await load('boundaries.mjs');
    const noon = new Date(2026, 10, 25, 12, 0);
    const late = new Date(2026, 10, 25, 23, 30);
    expect(canActNow({ now: noon })).toEqual({ ok: true });
    expect(canActNow({ now: late, action: 'send' })).toMatchObject({ ok: false, ask: false, reason: expect.stringContaining('Quiet hours') });
    expect(canActNow({ now: late, urgent: true })).toEqual({ ok: true });
    expect(canActNow({ now: late, quietHours: null })).toEqual({ ok: true });
    expect(canActNow({ now: noon, sensitivity: ['money'], action: 'pay invoice' })).toMatchObject({ ok: false, ask: true, reason: expect.stringContaining('money') });
    expect(canActNow({ now: noon, sensitivity: ['external', 'login'] })).toMatchObject({ ok: false, ask: true });
    expect(canActNow({ now: noon, sensitivity: ['login'], approved: true })).toEqual({ ok: true });
    expect(canActNow({ now: noon, sensitivity: ['external'] })).toEqual({ ok: true });
    expect(isQuietHours(new Date(2026, 0, 1, 6, 59))).toBe(true);
    expect(isQuietHours(new Date(2026, 0, 1, 7, 0))).toBe(false);
  });

  it('frameworks/decisions/verify.mjs: blocks vague asks, passes a complete packet', async () => {
    const { verify } = await load('frameworks/decisions/verify.mjs');
    const packet = [
      'Decision: which venue for the offsite (book by Friday)',
      'Options:',
      'A) The lake house - quiet, 2h drive',
      'B) The city loft - walkable, pricier',
      'Tradeoffs: A saves $800 but costs a travel day; B is easier for everyone.',
      'Recommendation: A, the budget matters more this quarter.',
      'Next steps: reply A and I book it and send the invite.',
    ].join('\n');
    expect(verify(packet)).toEqual({ ok: true, problems: [] });
    const vague = verify('What do you want to do about the offsite?');
    expect(vague.ok).toBe(false);
    expect(vague.problems).toHaveLength(4);
    expect(verify(packet.replace('Recommendation: A, the budget matters more this quarter.', 'Recommendation: it depends on you.')).reason).toMatch(/hedges/);
    expect(verify(packet.replace(/^B\).*$/m, '')).reason).toMatch(/two concrete options \(found 1\)/);
  });

  it('frameworks/voice/verify.mjs: bans markdown, URLs, file paths and more than three sentences', async () => {
    const { verify } = await load('frameworks/voice/verify.mjs');
    expect(verify('Three meetings tomorrow. The first is at 9.30, e.g. standup. Want the rest?')).toEqual({ ok: true, problems: [] });
    expect(verify('**Tomorrow:** three meetings.').reason).toMatch(/markdown/);
    expect(verify('- one\n- two').reason).toMatch(/list/);
    expect(verify('It is at https://example.com/pricing.').reason).toMatch(/URL/);
    expect(verify('I saved it to notes/today.md.').reason).toMatch(/file path/);
    expect(verify('One. Two. Three. Four.').reason).toMatch(/4 sentences/);
    expect(verify('One. Two. Three. Four.', { maxSentences: 4 }).ok).toBe(true);
  });

  it('frameworks/research/verify.mjs: never punts, always cites', async () => {
    const { verify } = await load('frameworks/research/verify.mjs');
    expect(verify('It opens at 9am on weekdays.\nSources: https://example.com/hours')).toEqual({ ok: true, problems: [] });
    expect(verify('It opens at 9am.', { sources: ['https://example.com/hours'] }).ok).toBe(true);
    expect(verify("I can't browse the web, but you could search their site.").problems).toHaveLength(2);
    expect(verify('Not sure. Want me to look it up? https://example.com').reason).toMatch(/Punts/);
    expect(verify('It opens at 9am.').reason).toMatch(/No sources/);
  });

  it('frameworks/operator/verify.mjs: no ship report without passing code-gated checks', async () => {
    const { verify } = await load('frameworks/operator/verify.mjs');
    const report = 'Shipped: the pricing page is live.\nVerified: typecheck + 42 tests passed, /pricing returns 200.\nNext: nothing.';
    expect(verify(report, { checks: [{ name: 'tests', ok: true }, { name: 'GET /pricing', ok: true }] })).toEqual({ ok: true, problems: [] });
    expect(verify(report).reason).toMatch(/No code-gated checks ran/);
    expect(verify(report, { checks: [{ name: 'tests', ok: false }] }).reason).toMatch(/Claims done while tests failed/);
    expect(verify('All done!', { checks: [{ name: 'tests', ok: true }] }).problems).toHaveLength(2);
  });

  it('every template .mjs imports cleanly and exposes its function', async () => {
    const expected: Record<string, string> = {
      'taste.mjs': 'verifyDraft',
      'boundaries.mjs': 'canActNow',
      'frameworks/decisions/verify.mjs': 'verify',
      'frameworks/voice/verify.mjs': 'verify',
      'frameworks/research/verify.mjs': 'verify',
      'frameworks/operator/verify.mjs': 'verify',
    };
    const mjs = TEMPLATE_FILES.filter((f) => f.endsWith('.mjs'));
    expect(mjs.sort()).toEqual(Object.keys(expected).sort());
    for (const [file, name] of Object.entries(expected)) {
      const mod = await load(file);
      expect(typeof mod[name], file).toBe('function');
      expect(mod.default, file).toBe(mod[name]);
    }
  });
});
