import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo this code runs from: gate code is protected here, not in other projects that happen to share a file name. */
export const RUFUS_REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const B = `(?:^|[\\s/'"\`=:(<>])`;
/** The trust gate's own state. No tool has a reason to touch these except through the approval tools. */
const TRUST_FILES = new RegExp(`${B}(trust|permissions|approvals)\\.json\\b`);
/** A tool's manifest sets its own effect and approval, so editing one is editing the gate. */
const TOOL_MANIFEST = new RegExp(`${B}tool\\.json\\b`);
/** Gate code: the trust ladder, the registry and script runner, the built-ins (sleep, verify, approvals), and the wake loop. */
const GATE_FILES = '(approvals|registry|standard|protected|deadline|builtins|self-upgrade|versions|loop)';
const GATE_CODE = new RegExp(`${B}(?:src/)?(?:scripts|rpg)/${GATE_FILES}\\.ts\\b`);
const GATE_BASENAME = new RegExp(`${B}${GATE_FILES}\\.ts\\b`);

/** Input fields that name a file or directory, and those that hold a shell command, by the usual names tools give them. */
const PATH_KEYS = /^(path|paths|file|files|filepath|relativepath|dir|directory|dest|destination|to|from|src)$/i;
const COMMAND_KEYS = /^(command|cmd|script)$/i;

function expand(p: string, baseDir: string): string {
  const home = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  return path.isAbsolute(home) ? path.resolve(home) : path.resolve(baseDir, home);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Names the protected things a write tool's input would touch: the trust files, tool manifests, and gate code.
 * Such a write runs only when the owner approved that exact input. Best-effort for shell commands, which can
 * always hide a path; the point is that no ordinary write tool can quietly rewrite its own gate.
 */
export function protectedTargets(input: Record<string, unknown>, opts: { workspaceDir: string; repoDir?: string }): string[] {
  const repoDir = path.resolve(opts.repoDir ?? RUFUS_REPO_DIR);
  const ws = path.resolve(opts.workspaceDir);
  const hits = new Set<string>();
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? expand(input.cwd.trim(), ws) : undefined;

  const checkPath = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    const abs = expand(v, ws);
    const relative = !v.startsWith('/') && !v.startsWith('~');
    const t = TRUST_FILES.exec(`/${path.basename(abs)}`);
    if (t && isInside(abs, ws)) hits.add(`${t[1]}.json`);
    if (TOOL_MANIFEST.test(`/${path.basename(abs)}`) && isInside(abs, path.join(ws, 'tools'))) hits.add('a tool manifest (tool.json)');
    // Gate code: a path into this repo, or a repo-relative src/ path (self.upgrade names files that way).
    const g = GATE_CODE.exec(v);
    if (g && (isInside(abs, repoDir) || (relative && v.replace(/^\.\//, '').startsWith('src/')))) hits.add(`gate code (${g[1]}.ts)`);
  };

  const checkCommand = (v: string) => {
    const aboutWorkspace = v.includes(ws) || /\.rufus/.test(v) || (cwd ? isInside(cwd, ws) : false);
    const aboutRepo = v.includes(repoDir) || v.includes(`${path.basename(repoDir)}/src`) || (cwd ? isInside(cwd, repoDir) : false);
    const t = TRUST_FILES.exec(v);
    if (t && aboutWorkspace) hits.add(`${t[1]}.json`);
    if (TOOL_MANIFEST.test(v) && aboutWorkspace) hits.add('a tool manifest (tool.json)');
    const g = GATE_CODE.exec(v) ?? GATE_BASENAME.exec(v);
    if (g && aboutRepo) hits.add(`gate code (${g[1]}.ts)`);
  };

  const visit = (key: string, v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) visit(key, x);
    } else if (typeof v === 'string') {
      if (PATH_KEYS.test(key)) checkPath(v);
      else if (COMMAND_KEYS.test(key)) checkCommand(v);
    }
  };
  for (const [k, v] of Object.entries(input)) visit(k, v);
  return [...hits];
}

/** Does tool source code reach for the trust gate's own state files? */
export function touchesTrustFiles(code: string): boolean {
  return TRUST_FILES.test(code);
}
