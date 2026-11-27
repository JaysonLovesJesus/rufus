import { execFile } from 'node:child_process';
import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolRegistry } from './registry';

/**
 * One general way to find things on this Mac: by file name and by content, in any folder (a git repo or not),
 * inside a time budget. Without it Rufus walked candidate stores one file at a time (the sermon-notes replay took
 * ~19 moves): `git grep` only works inside a repo, and a naive grep over a big tree times out with nothing.
 *
 * Order matters more than speed: names match first (no reads), then shallow and recently changed folders are read
 * before deep and old ones, small text files before big ones. When the budget runs out, what was found so far comes
 * back with the folders not yet searched, so the next call can narrow instead of starting over.
 */

export interface LocalHit {
  path: string;
  /** name: the file or folder name matches; content: its text does; index: Spotlight says so. */
  match: 'name' | 'content' | 'index';
  terms: string[];
  line?: number;
  snippet?: string;
  modifiedAt?: string;
  score: number;
}

export interface LocalSearchResult {
  hits: LocalHit[];
  filesRead: number;
  dirsSeen: number;
  stoppedEarly: boolean;
  /** Folders still queued when the budget ran out (the next places to look). */
  unsearched: string[];
  /** Large text files skipped for time, newest first. */
  skippedLarge: string[];
  elapsedMs: number;
}

/** Folders that are never where the owner's things are: dependencies, build output, caches, VCS internals. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.nuxt', '.turbo', '.cache', 'Caches', '.Trash',
  '__pycache__', '.venv', 'venv', '.npm', '.pnpm-store', '.yarn', '.cargo', '.rustup', '.gradle', 'DerivedData',
  'Pods', '.DS_Store', 'coverage', '.pytest_cache', '.mypy_cache', 'site-packages', 'checkpoints',
]);
/** Rufus's own workspace is searched through memory.search, which stops at the right moment in a replay. */
const OWN_WORKSPACE = /^\.rufus/;
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.ico', '.icns', '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.dmg', '.pkg', '.app', '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.opus', '.mp4', '.mov', '.m4v', '.avi', '.mkv',
  '.woff', '.woff2', '.ttf', '.otf', '.so', '.dylib', '.o', '.a', '.node', '.wasm', '.class', '.jar', '.pyc', '.sqlite',
  '.db', '.sqlite3', '.ldb', '.bin', '.dat', '.safetensors', '.onnx', '.pt', '.npy', '.psd', '.sketch', '.key', '.numbers', '.pages',
]);
const STOP = new Set('the a an and or of to in on at for with from my your is are was were it this that notes note file files find where'.split(' '));

/** Small files are read whole; bigger text files only if time is left at the end. */
const SMALL_FILE_BYTES = 512 * 1024;
const LARGE_FILE_BYTES = 8 * 1024 * 1024;
const READ_CONCURRENCY = 16;

export function searchTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= 2);
  const kept = words.filter((w) => !STOP.has(w));
  return [...new Set(kept.length ? kept : words)];
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function nameTerms(name: string, terms: readonly string[]): string[] {
  const n = name.toLowerCase();
  return terms.filter((t) => n.includes(t));
}

function isProbablyText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

/** The best line in a text for these terms: the one with the most of them, with its 1-based number. */
function bestLine(text: string, terms: readonly string[]): { line: number; snippet: string; found: string[] } | undefined {
  const lower = text.toLowerCase();
  const found = terms.filter((t) => lower.includes(t));
  if (!found.length) return undefined;
  const lines = text.split('\n');
  let best = { line: 0, count: -1 };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.toLowerCase();
    let c = 0;
    for (const t of found) if (l.includes(t)) c++;
    if (c > best.count) best = { line: i, count: c };
    if (c === found.length) break;
  }
  const raw = lines[best.line]!.trim();
  const at = Math.max(0, raw.toLowerCase().indexOf(found[0]!) - 60);
  return { line: best.line + 1, snippet: raw.slice(at, at + 180), found };
}

function scoreOf(match: LocalHit['match'], found: number, total: number, mtimeMs: number | undefined, now: number, phrase: boolean): number {
  const coverage = total ? found / total : 0;
  const base = match === 'name' ? 60 : match === 'content' ? 40 : 30;
  // Recency breaks ties: something touched this week outranks something from last year.
  const ageDays = mtimeMs ? Math.max(0, (now - mtimeMs) / 86_400_000) : 365;
  return base * coverage + (phrase ? 25 : 0) + 10 / (1 + ageDays / 7);
}

/** App internals and hidden folders hold the owner's things less often than his own folders, so they are searched after them. */
function isBackstage(name: string, parent: string): boolean {
  return name.startsWith('.') || (name === 'Library' && parent === os.homedir());
}

async function spotlight(root: string, query: string, timeoutMs: number): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  return new Promise((resolve) => {
    execFile('mdfind', ['-onlyin', root, query], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      resolve(String(stdout).split('\n').filter(Boolean).slice(0, 200));
    });
  });
}

export async function searchLocal(opts: {
  query: string;
  roots?: string[];
  budgetMs?: number;
  maxResults?: number;
  /** Also ask Spotlight (macOS) for indexed matches; off in tests. */
  spotlight?: boolean;
  now?: Date;
}): Promise<LocalSearchResult> {
  const started = Date.now();
  const deadline = started + Math.max(1, opts.budgetMs ?? 8000);
  const now = (opts.now ?? new Date()).getTime();
  const terms = searchTerms(opts.query);
  const phrase = opts.query.trim().toLowerCase();
  const roots = (opts.roots?.length ? opts.roots : ['~']).map((r) => path.resolve(expandHome(r.trim())));
  const hits = new Map<string, LocalHit>();
  const skippedLarge: Array<{ path: string; mtimeMs: number }> = [];
  let filesRead = 0;
  let dirsSeen = 0;
  // A file whose name and text both match is the likeliest answer: the scores add up.
  const add = (h: LocalHit) => {
    const prev = hits.get(h.path);
    if (!prev) return void hits.set(h.path, h);
    if (prev.match === h.match) {
      if (h.score > prev.score) hits.set(h.path, h);
      return;
    }
    const [text, name] = h.match === 'name' ? [prev, h] : [h, prev];
    const terms = [...new Set([...prev.terms, ...h.terms])];
    hits.set(h.path, {
      ...text,
      match: name.terms.length > text.terms.length ? 'name' : text.match,
      terms,
      score: Math.max(text.score, name.score) + 0.5 * Math.min(text.score, name.score),
    });
  };

  const indexed = opts.spotlight !== false && terms.length ? Promise.all(roots.map((r) => spotlight(r, opts.query, Math.max(500, Math.min(3000, deadline - Date.now()))))) : Promise.resolve([] as string[][]);

  const readOne = async (file: string, size: number, mtimeMs: number, maxBytes: number) => {
    let buf: Buffer;
    try {
      const fh = await fs.open(file, 'r');
      try {
        const len = Math.min(size, maxBytes);
        buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, 0);
      } finally {
        await fh.close();
      }
    } catch {
      return;
    }
    filesRead++;
    if (!isProbablyText(buf)) return;
    const text = buf.toString('utf8');
    const best = bestLine(text, terms);
    if (!best) return;
    const hasPhrase = terms.length > 1 && text.toLowerCase().includes(phrase);
    // Terms in the opening lines (a title, a header) mean the file is about them, not just mentioning them.
    const head = text.split('\n', 6).join('\n').toLowerCase();
    const about = terms.some((t) => head.includes(t)) ? 15 : 0;
    const big = size > SMALL_FILE_BYTES ? 10 : 0;
    add({ path: file, match: 'content', terms: best.found, line: best.line, snippet: best.snippet, modifiedAt: new Date(mtimeMs).toISOString(), score: scoreOf('content', best.found.length, terms.length, mtimeMs, now, hasPhrase) + about - big });
  };

  // Spotlight answers in well under a second; its candidates are read (and scored on their text) before any walking.
  for (const list of await indexed) {
    for (const p of list) {
      if (Date.now() >= deadline) break;
      if (p.split(path.sep).some((seg) => OWN_WORKSPACE.test(seg) || SKIP_DIRS.has(seg))) continue;
      const st = await fs.stat(p).catch(() => undefined);
      if (!st?.isFile()) continue;
      const named = nameTerms(path.basename(p), terms);
      if (named.length) add({ path: p, match: 'name', terms: named, modifiedAt: st.mtime.toISOString(), score: scoreOf('name', named.length, terms.length, st.mtimeMs, now, false) });
      if (!BINARY_EXT.has(path.extname(p).toLowerCase()) && st.size <= LARGE_FILE_BYTES) await readOne(p, st.size, st.mtimeMs, SMALL_FILE_BYTES);
      if (!hits.has(p)) add({ path: p, match: 'index', terms: named, modifiedAt: st.mtime.toISOString(), score: scoreOf('index', Math.max(1, named.length), terms.length, st.mtimeMs, now, false) });
    }
  }
  const readByIndex = new Set(hits.keys());

  // Breadth-first: shallow folders before deep ones, so a budget cut leaves the likeliest places searched.
  // The owner's own folders go first; hidden folders and ~/Library only after them.
  const backstage: string[] = [];
  let queue: string[] = [];
  for (const r of roots) {
    const st = await fs.stat(r).catch(() => undefined);
    if (st?.isDirectory()) queue.push(r);
    else if (st?.isFile()) await readOne(r, st.size, st.mtimeMs, LARGE_FILE_BYTES);
  }
  let stoppedEarly = false;
  while (queue.length) {
    if (Date.now() >= deadline) {
      stoppedEarly = true;
      break;
    }
    const next: Array<{ dir: string; rank: number }> = [];
    for (let qi = 0; qi < queue.length; qi++) {
      if (Date.now() >= deadline) {
        stoppedEarly = true;
        queue = queue.slice(qi);
        break;
      }
      const dir = queue[qi]!;
      dirsSeen++;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const files: Array<{ file: string; size: number; mtimeMs: number }> = [];
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name) || OWN_WORKSPACE.test(e.name)) continue;
        const full = path.join(dir, e.name);
        const named = nameTerms(e.name, terms);
        if (e.isDirectory()) {
          if (named.length) add({ path: `${full}/`, match: 'name', terms: named, score: scoreOf('name', named.length, terms.length, undefined, now, false) });
          // A folder whose name matches is searched first at its depth.
          if (isBackstage(e.name, dir) && !named.length) backstage.push(full);
          else next.push({ dir: full, rank: named.length });
          continue;
        }
        if (!e.isFile()) continue;
        const st = await fs.stat(full).catch(() => undefined);
        if (!st) continue;
        if (named.length) add({ path: full, match: 'name', terms: named, modifiedAt: st.mtime.toISOString(), score: scoreOf('name', named.length, terms.length, st.mtimeMs, now, e.name.toLowerCase().includes(phrase.replace(/\s+/g, '-'))) });
        if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
        if (st.size > LARGE_FILE_BYTES) continue;
        if (readByIndex.has(full)) continue;
        if (st.size > SMALL_FILE_BYTES) skippedLarge.push({ path: full, mtimeMs: st.mtimeMs });
        else files.push({ file: full, size: st.size, mtimeMs: st.mtimeMs });
      }
      // Newest first inside a folder.
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
        if (Date.now() >= deadline) break;
        await Promise.all(files.slice(i, i + READ_CONCURRENCY).map((f) => readOne(f.file, f.size, f.mtimeMs, SMALL_FILE_BYTES)));
      }
    }
    if (stoppedEarly) {
      queue = [...queue, ...next.map((n) => n.dir), ...backstage];
      break;
    }
    queue = next.sort((a, b) => b.rank - a.rank).map((n) => n.dir);
    if (!queue.length) queue = backstage.splice(0);
  }

  // Big text files (logs, transcripts) last, newest first, while time is left.
  skippedLarge.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const stillLarge: string[] = [];
  for (const f of skippedLarge) {
    if (Date.now() >= deadline) {
      stillLarge.push(f.path);
      continue;
    }
    const st = await fs.stat(f.path).catch(() => undefined);
    if (st) await readOne(f.path, st.size, st.mtimeMs, LARGE_FILE_BYTES);
  }
  if (stillLarge.length) stoppedEarly = true;

  const ranked = [...hits.values()].sort((a, b) => b.score - a.score || (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  return {
    hits: ranked.slice(0, opts.maxResults ?? 30),
    filesRead,
    dirsSeen,
    stoppedEarly,
    unsearched: queue.slice(0, 12),
    skippedLarge: stillLarge.slice(0, 8),
    elapsedMs: Date.now() - started,
  };
}

const home = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

/** `files.find`: the general search, as a read tool every brain can use. */
export async function registerLocalSearch(registry: ToolRegistry, opts: { spotlight?: boolean } = {}): Promise<void> {
  await registry.registerInline(
    {
      id: 'files.find',
      version: 1,
      description:
        'Finds files and folders on this Mac by name AND by content, in any folder (a git repo or not; default: the home folder), within a time budget. Ranked: name matches, then text matches, newest first, with the matching line. Stops at the budget with what it found and the folders not yet searched.',
      whenToUse: [
        "You don't know where something is: notes, a document, a conversation, a config, a project",
        'Before listing or reading folders one by one',
      ],
      effect: 'read',
      requiresApproval: false,
      timeoutMs: 40_000,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to look for in names and text (e.g. "sabbath sermon")' },
          in: { type: 'array', items: { type: 'string' }, description: 'Folders to search (absolute or ~/...). Default: the home folder' },
          seconds: { type: 'number', description: 'Time budget in seconds (default 10, max 30)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      exampleInput: { query: 'sabbath sermon', in: ['~/Life'] },
    },
    async (input, ctx) => {
      const query = String(input.query ?? '').trim();
      if (!searchTerms(query).length) return { ok: false, summary: 'Give at least one word to look for.', error: 'empty query' };
      const roots = Array.isArray(input.in) ? input.in.map(String).filter((s) => s.trim()) : [];
      const missing: string[] = [];
      for (const r of roots) if (!(await fs.stat(path.resolve(expandHome(r.trim()))).catch(() => undefined))) missing.push(r);
      if (roots.length && missing.length === roots.length) return { ok: false, summary: `Nothing to search: ${missing.join(', ')} does not exist. Leave "in" out to search the home folder.`, error: 'no such folder' };
      const budgetMs = Math.round(Math.min(30, Math.max(1, Number(input.seconds) || 10)) * 1000);
      const left = ctx.deadline ? Math.max(1000, ctx.deadline - Date.now() - 1500) : budgetMs;
      const res = await searchLocal({ query, roots: roots.filter((r) => !missing.includes(r)), budgetMs: Math.min(budgetMs, left), ...(opts.spotlight === false ? { spotlight: false } : {}), now: ctx.now });
      const lines = res.hits.map((h) => `${home(h.path)}${h.line ? `:${h.line}` : ''} [${h.match}${h.terms.length ? `: ${h.terms.join(', ')}` : ''}${h.modifiedAt ? ` · ${h.modifiedAt.slice(0, 10)}` : ''}]${h.snippet ? ` ${h.snippet}` : ''}`);
      const where = roots.length ? roots.join(', ') : '~';
      const cut = res.stoppedEarly
        ? ` Stopped at the ${Math.round(budgetMs / 1000)}s budget${res.unsearched.length ? `; not yet searched: ${res.unsearched.map(home).join(', ')}` : ''}${res.skippedLarge.length ? `; big files not read: ${res.skippedLarge.map(home).join(', ')}` : ''}. Search one of those next ("in"), not the same folders again.`
        : '';
      return {
        ok: true,
        summary: `Found ${res.hits.length} match(es) for "${query}" in ${where} (read ${res.filesRead} file(s) in ${res.dirsSeen} folder(s), ${(res.elapsedMs / 1000).toFixed(1)}s).${missing.length ? ` Skipped missing: ${missing.join(', ')}.` : ''}${cut}`,
        data: lines,
      };
    },
    { alwaysVisible: true },
  );
}
