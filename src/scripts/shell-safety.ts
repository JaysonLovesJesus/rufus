/**
 * Strict, conservative classifier for provably read-only shell commands.
 * Used by the Trust Gate so harmless read-only inspections (ffprobe, ls, git status, stat, wc, etc.)
 * run without nagging the owner for approval, while any write, redirect, subshell, or unknown command
 * stays strictly gated at `draft`.
 */

const FORBIDDEN_METACHARS = /[><`]|[$]\(|\$\{|;\s*\S|\beval\b|\bexec\b/;

const READ_ONLY_BINS = new Set([
  'ls',
  'stat',
  'file',
  'wc',
  'head',
  'tail',
  'cat',
  'rg',
  'grep',
  'du',
  'df',
  'mdls',
  'shasum',
  'md5',
  'ffprobe',
  'mediainfo',
  'which',
  'pwd',
  'date',
  'uname',
  'ps',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'sort',
  'uniq',
  'cut',
  'tr',
  'jq',
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'describe']);

const FIND_MUTATING_FLAGS = /\s-(?:delete|exec|execdir|ok|okdir|fprint|fls)\b/;
const SED_INPLACE_FLAG = /\s-(?:i|I)(?:\b|\S)/;

function splitSafeChain(cmd: string): string[] | null {
  // Split on top-level | or && (ignoring quoted strings); reject ||, ;, &, newlines.
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    const next = cmd[i + 1];
    if (quote) {
      if (ch === '\\' && quote === '"' && next) {
        cur += ch + next;
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') return null;
    if (ch === '|' && next === '|') return null;
    if (ch === '&' && next === '&') {
      segments.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    if (ch === '&') return null; // backgrounding
    if (ch === '|') {
      segments.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (quote) return null; // unclosed quote
  if (cur.trim()) segments.push(cur.trim());
  return segments.length ? segments : null;
}

function isSegmentReadOnly(seg: string): boolean {
  const trimmed = seg.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  const rawBin = tokens[0]!;
  // Strip safe path prefix like /usr/bin/ffprobe or /opt/homebrew/bin/ffprobe
  const bin = rawBin.includes('/') ? rawBin.slice(rawBin.lastIndexOf('/') + 1) : rawBin;
  if (READ_ONLY_BINS.has(bin)) return true;
  if (bin === 'find') return !FIND_MUTATING_FLAGS.test(trimmed);
  if (bin === 'sed') return !SED_INPLACE_FLAG.test(trimmed);
  if (bin === 'git') {
    // Skip optional `-C <dir>` or `--no-pager` flags to find the subcommand
    let idx = 1;
    while (idx < tokens.length) {
      const t = tokens[idx]!;
      if (t === '-C' || t === '--git-dir' || t === '--work-tree') {
        idx += 2;
        continue;
      }
      if (t.startsWith('-')) {
        idx += 1;
        continue;
      }
      return GIT_READ_ONLY_SUBCOMMANDS.has(t);
    }
    return false;
  }
  return false;
}

/** Returns true ONLY when the entire shell command is provably read-only with no redirects, subshells, or writes. */
export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 2000) return false;
  if (FORBIDDEN_METACHARS.test(trimmed)) return false;
  const segments = splitSafeChain(trimmed);
  if (!segments) return false;
  return segments.every(isSegmentReadOnly);
}
