// Files / notes adapter: index a folder of markdown, text, CSV and JSON files by title, headings, modified time and a
// short snippet. Never reads more than the first 16 KB of a file, never indexes binaries, never follows symlinks.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readHead } from '../fsutil';
import { clip, limitNewest, stableId, type CollectOptions, type CorpusItem, type SourceAdapter } from '../types';

export interface FilesOptions extends CollectOptions {
  /** More folders to scan besides `path`. */
  roots?: string[];
  /** Extra file or folder names to skip, on top of the defaults. */
  ignore?: string[];
  /** Extensions to index (with the dot). Default: markdown, text, CSV/TSV, JSON/JSONL. */
  extensions?: string[];
  /** Hard cap on files indexed per run (default 20000), as a safety net on huge trees. */
  maxFiles?: number;
  /** How deep to descend (default 12). */
  maxDepth?: number;
}

export const DEFAULT_IGNORE = ['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '.venv', 'venv', '__pycache__', 'target', 'vendor', '.DS_Store'];
export const DEFAULT_EXTENSIONS = ['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.jsonl'];
const HEAD_BYTES = 16 * 1024;

const KIND: Record<string, string> = { '.md': 'note', '.markdown': 'note', '.txt': 'note', '.csv': 'table', '.tsv': 'table', '.json': 'data', '.jsonl': 'data' };

/** Strip the lightest markdown so a snippet reads as prose. */
const plain = (s: string): string =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_>~]|^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

interface FrontMatter {
  title?: string;
  tags: string[];
  body: string;
}

function frontMatter(text: string): FrontMatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { tags: [], body: text };
  const block = m[1]!;
  const title = /^title:\s*["']?(.+?)["']?\s*$/im.exec(block)?.[1];
  const tags: string[] = [];
  const inline = /^tags:\s*\[(.*)\]\s*$/im.exec(block)?.[1];
  if (inline) tags.push(...inline.split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')));
  else {
    const list = /^tags:\s*\r?\n((?:\s*-\s*.+\r?\n?)+)/im.exec(block)?.[1];
    if (list) tags.push(...list.split(/\r?\n/).map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '')));
    else {
      const bare = /^tags:\s*(.+)$/im.exec(block)?.[1];
      if (bare) tags.push(...bare.split(/[,\s]+/));
    }
  }
  return { title, tags: tags.filter(Boolean), body: text.slice(m[0].length) };
}

async function describeFile(file: string, ext: string, size: number, mtime: Date): Promise<CorpusItem | undefined> {
  const head = await readHead(file, Math.min(size, HEAD_BYTES));
  if (head.includes(0)) return undefined; // binary pretending to be text
  const text = head.toString('utf8');
  const complete = size <= HEAD_BYTES;
  const base = path.basename(file, path.extname(file));
  const kind = KIND[ext] ?? 'note';
  let title = base;
  let summary = '';
  let headings: string[] = [];
  const tags = new Set<string>([ext.slice(1)]);
  const meta: Record<string, unknown> = { bytes: size, ext: ext.slice(1) };

  if (kind === 'note') {
    const fm = frontMatter(text);
    headings = [...fm.body.matchAll(/^#{1,6}[ \t]+(.+?)\s*#*\s*$/gm)].map((h) => plain(h[1]!)).filter(Boolean).slice(0, 12);
    const h1 = /^#[ \t]+(.+?)\s*#*\s*$/m.exec(fm.body)?.[1];
    title = fm.title ?? (h1 ? plain(h1) : base);
    const prose = fm.body.split(/\r?\n/).filter((l) => !/^\s*#{1,6}\s/.test(l) && l.trim()).join(' ');
    summary = clip(plain(prose), 300);
    for (const t of fm.tags) tags.add(t.replace(/^#/, '').toLowerCase());
    for (const m of fm.body.matchAll(/(?:^|\s)#([a-z][\w-]{1,30})\b/gi)) tags.add(m[1]!.toLowerCase());
  } else if (kind === 'table') {
    const first = text.split(/\r?\n/, 1)[0] ?? '';
    const cols = first.split(ext === '.tsv' ? '\t' : ',').map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean).slice(0, 20);
    headings = cols;
    const rows = complete ? Math.max(0, text.split(/\r?\n/).filter((l) => l.trim()).length - 1) : undefined;
    if (rows !== undefined) meta.rows = rows;
    summary = `Table${rows !== undefined ? ` of ${rows} row${rows === 1 ? '' : 's'}` : ''} with columns: ${cols.join(', ')}`;
  } else {
    if (ext === '.jsonl') {
      const keys = (() => {
        try {
          return Object.keys(JSON.parse(text.split(/\r?\n/, 1)[0] ?? '') as object).slice(0, 20);
        } catch {
          return [];
        }
      })();
      headings = keys;
      summary = keys.length ? `JSON lines with fields: ${keys.join(', ')}` : 'JSON lines data';
    } else {
      let parsed: unknown;
      if (complete) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      if (Array.isArray(parsed)) {
        const first = parsed[0];
        headings = first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first).slice(0, 20) : [];
        meta.rows = parsed.length;
        summary = `JSON list of ${parsed.length} item${parsed.length === 1 ? '' : 's'}${headings.length ? ` with fields: ${headings.join(', ')}` : ''}`;
      } else if (parsed && typeof parsed === 'object') {
        headings = Object.keys(parsed).slice(0, 20);
        summary = `JSON object with keys: ${headings.join(', ')}`;
      } else summary = `JSON data (${Math.max(1, Math.round(size / 1024))} KB)`;
    }
  }
  if (headings.length) meta.headings = headings;
  if (!summary) summary = title;
  const abs = path.resolve(file);
  return {
    id: stableId('file', abs),
    source: 'file',
    kind,
    title: clip(title, 200),
    summary,
    path: abs,
    timestamp: mtime.toISOString(),
    tags: [...tags].slice(0, 16),
    metadata: meta,
  };
}

export const filesAdapter: SourceAdapter<FilesOptions> = {
  id: 'files',
  source: 'file',
  async collect(options: FilesOptions): Promise<CorpusItem[]> {
    const ignore = new Set([...DEFAULT_IGNORE, ...(options.ignore ?? [])]);
    const exts = new Set((options.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()));
    const maxFiles = options.maxFiles ?? 20000;
    const maxDepth = options.maxDepth ?? 12;
    const items = new Map<string, CorpusItem>();

    const index = async (file: string): Promise<void> => {
      const st = await fs.stat(file);
      const item = await describeFile(file, path.extname(file).toLowerCase(), st.size, st.mtime);
      if (item) items.set(item.id, item);
    };

    for (const root of [options.path, ...(options.roots ?? [])]) {
      const abs = path.resolve(root);
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        throw new Error(`Path not found: ${root}`);
      }
      if (st.isFile()) {
        await index(abs);
        continue;
      }
      const stack: Array<[string, number]> = [[abs, 0]];
      while (stack.length && items.size < maxFiles) {
        const [dir, depth] = stack.pop()!;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue; // unreadable folder: skip it, keep going
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          if (ignore.has(e.name) || e.name.startsWith('.') || e.isSymbolicLink()) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (depth < maxDepth) stack.push([full, depth + 1]);
          } else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase()) && items.size < maxFiles) {
            try {
              await index(full);
            } catch {
              // vanished or unreadable between listing and reading: skip
            }
          }
        }
      }
    }
    return limitNewest([...items.values()], options.limit);
  },
};
