import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileStore } from '../store';
import type { ToolDefinition } from '../tools/tools';

/**
 * v24b: portable skills. A skill is one folder with a `SKILL.md`: a little YAML frontmatter, then plain markdown
 * instructions.
 *
 *   <workspace>/skills/<name>/SKILL.md
 *
 *   ---
 *   name: trip-prep
 *   description: Prepare a short travel brief before a trip
 *   triggers: trip, flight, travel brief
 *   ---
 *   1. Check the calendar for the travel day ...
 *
 * Code picks the one or two skills that fit a message ($0 keyword and trigger matching) and only those go into the
 * Chief of Staff and mission prompts, so new workflows are a markdown file away instead of new TypeScript.
 */

export const SKILLS_DIR = 'skills';
export const SKILL_FILE = 'SKILL.md';
export const SKILL_LIST_TOOL = 'skill.list';
export const SKILL_READ_TOOL = 'skill.read';
export const DEFAULT_MAX_SKILLS = 2;
export const DEFAULT_SKILLS_PROMPT_CHARS = 4000;
/** A SKILL.md larger than this is read only up to here. */
const MAX_SKILL_BYTES = 64 * 1024;

export interface Skill {
  /** The folder name (a slug). */
  name: string;
  description: string;
  triggers: string[];
  /** The markdown instructions after the frontmatter. */
  body: string;
  file: string;
}

export interface SkillInput {
  name: string;
  description: string;
  triggers?: string[] | string;
  body: string;
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** True for a safe skill folder name: lowercase letters, digits, `-` and `_` (no dots, slashes or `..`). */
export const isSkillName = (name: string): boolean => SLUG.test(name);

/** A safe folder name from any title: "Trip Prep!" -> "trip-prep". Empty when nothing usable is left. */
export function skillSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64)
    .replace(/[-_]+$/g, '');
}

const unquote = (s: string): string => {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
};

/** "a, b" or "[a, b]" -> ["a", "b"]. */
const splitList = (v: string): string[] =>
  v
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(unquote)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Parses a SKILL.md: simple YAML frontmatter (`key: value`, `key: a, b`, `key: [a, b]`, or `key:` followed by `- item`
 * lines) and the markdown body. No frontmatter: the whole text is the body.
 */
export function parseSkillMarkdown(text: string): { meta: Record<string, string | string[]>; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { meta: {}, body: src.trim() };
  const meta: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const raw of m[1]!.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      const prev = meta[listKey];
      meta[listKey] = [...(Array.isArray(prev) ? prev : []), unquote(item[1]!)];
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    if (!value) {
      listKey = key;
      meta[key] = [];
      continue;
    }
    listKey = undefined;
    meta[key] = value.startsWith('[') ? splitList(value) : unquote(value);
  }
  return { meta, body: src.slice(m[0].length).trim() };
}

const asList = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? splitList(v) : []).map((x) => x.trim()).filter(Boolean);
const asText = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(', ') : (v ?? '')).replace(/\s+/g, ' ').trim();

/** A Skill from a SKILL.md text in the folder `name`. */
export function skillFromMarkdown(name: string, text: string, file = ''): Skill {
  const { meta, body } = parseSkillMarkdown(text);
  const firstLine = body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
  return {
    name,
    description: asText(meta.description) || firstLine.slice(0, 160),
    triggers: asList(meta.triggers ?? meta.trigger),
    body,
    file,
  };
}

const skillsRoot = (dir: string): string => path.resolve(dir, SKILLS_DIR);

/** The SKILL.md path for a skill name, or undefined when the name is unsafe (it could escape `skills/`). */
export function skillFile(dir: string, name: string): string | undefined {
  if (!isSkillName(name)) return undefined;
  const root = skillsRoot(dir);
  const file = path.resolve(root, name, SKILL_FILE);
  return file.startsWith(root + path.sep) ? file : undefined;
}

async function readSkill(dir: string, name: string): Promise<Skill | undefined> {
  const file = skillFile(dir, name);
  if (!file) return undefined;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const buf = Buffer.alloc(MAX_SKILL_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_SKILL_BYTES, 0);
    return skillFromMarkdown(name, buf.subarray(0, bytesRead).toString('utf8'), file);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw err;
  } finally {
    await handle?.close();
  }
}

/** Every skill in `<dir>/skills/`, by name. Folders with an unsafe name or no SKILL.md are skipped. */
export async function listSkills(dir: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(skillsRoot(dir));
  } catch {
    return [];
  }
  const skills = await Promise.all(entries.filter(isSkillName).sort().map((n) => readSkill(dir, n).catch(() => undefined)));
  return skills.filter((s): s is Skill => !!s);
}

/** One skill by name, or undefined (also for an unsafe name such as `../x`: nothing outside `skills/` is ever read). */
export async function loadSkill(dir: string, name: string): Promise<Skill | undefined> {
  return readSkill(dir, name.trim().toLowerCase());
}

const STOP = new Set(['about', 'after', 'again', 'also', 'before', 'could', 'from', 'have', 'into', 'just', 'like', 'more', 'need', 'please', 'should', 'some', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your', 'skill', 'help', 'make']);
const norm = (s: string): string => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const tokens = (s: string): string[] => norm(s).trim().split(' ').filter((w) => w.length >= 4 && !STOP.has(w));

/**
 * How well a skill fits a message, at $0: a trigger phrase in the message is worth 3, the skill's name 3, and each
 * distinct description word (4+ letters, not a stop word) 1, up to 2.
 */
export function scoreSkill(skill: Pick<Skill, 'name' | 'description' | 'triggers'>, query: string): number {
  const q = norm(query);
  if (!q.trim()) return 0;
  let score = 0;
  for (const t of skill.triggers) {
    const phrase = norm(t);
    if (phrase.trim() && q.includes(phrase)) score += 3;
  }
  const name = norm(skill.name.replace(/[-_]+/g, ' '));
  if (name.trim() && q.includes(name)) score += 3;
  const have = new Set(q.trim().split(' '));
  score += Math.min(2, new Set(tokens(skill.description).filter((w) => have.has(w))).size);
  return score;
}

/** The skills that fit a message best (score 2 or more), best first, at most `maxSkills`. */
export function matchSkills(skills: readonly Skill[], query: string, maxSkills = DEFAULT_MAX_SKILLS): Skill[] {
  return skills
    .map((s) => ({ s, score: scoreSkill(s, query) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, Math.max(0, maxSkills))
    .map((x) => x.s);
}

/** The matched skills as a prompt section, or '' when there are none. */
export function formatSkillsForPrompt(skills: readonly Skill[], maxChars = DEFAULT_SKILLS_PROMPT_CHARS): string {
  if (!skills.length) return '';
  const each = Math.max(200, Math.floor(maxChars / skills.length) - 80);
  const parts = skills.map((s) => {
    const body = s.body.length > each ? `${s.body.slice(0, each - 1).trimEnd()}…` : s.body;
    return `### ${s.name}${s.description ? ` — ${s.description}` : ''}\n${body}`;
  });
  return `## Skills that fit this request (skills/<name>/SKILL.md; follow them when they apply)\n${parts.join('\n\n')}`;
}

/** The prompt section for the skills in `dir` that fit `query`. Never throws: '' on any problem. */
export async function relevantSkillsSection(dir: string, query: string, maxSkills = DEFAULT_MAX_SKILLS): Promise<string> {
  try {
    if (!query.trim()) return '';
    return formatSkillsForPrompt(matchSkills(await listSkills(dir), query, maxSkills));
  } catch {
    return '';
  }
}

/** The text of a SKILL.md. */
export function renderSkill(input: { name: string; description: string; triggers: string[]; body: string }): string {
  const esc = (s: string): string => (/[:#\[\]{},"'&*!|>%@`]/.test(s) || s !== s.trim() ? JSON.stringify(s) : s);
  const triggers = input.triggers.length ? `triggers:\n${input.triggers.map((t) => `  - ${esc(t)}`).join('\n')}\n` : '';
  return `---\nname: ${input.name}\ndescription: ${esc(input.description)}\n${triggers}---\n\n${input.body.trim()}\n`;
}

/** Writes `<dir>/skills/<slug>/SKILL.md` atomically. The name is turned into a safe slug: no path traversal. */
export async function saveSkill(dir: string, input: SkillInput): Promise<Skill> {
  const name = skillSlug(input.name ?? '');
  if (!name || !isSkillName(name)) throw new Error(`"${input.name}" is not a usable skill name. Use letters, digits and dashes.`);
  const file = skillFile(dir, name);
  if (!file) throw new Error(`"${input.name}" is not a usable skill name.`);
  const description = (input.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!description) throw new Error('A skill needs a description.');
  const body = (input.body ?? '').trim();
  if (!body) throw new Error('A skill needs instructions (the body).');
  const triggers = [...new Set((Array.isArray(input.triggers) ? input.triggers : typeof input.triggers === 'string' ? splitList(input.triggers) : []).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 20);
  await new FileStore(dir).writeText(file, renderSkill({ name, description, triggers, body }));
  return { name, description, triggers, body, file };
}

/** `skill.list` and `skill.read`: read-only, so chat and missions can look at Rufus's own skills on demand. */
export function skillTools(): ToolDefinition<Record<string, unknown>, unknown>[] {
  return [
    {
      name: SKILL_LIST_TOOL,
      description: 'List your installed skills (skills/<name>/SKILL.md): name, description and triggers. args: {}',
      readOnly: true,
      async execute(_args, ctx) {
        return (await listSkills(ctx.dir)).map((s) => ({ name: s.name, description: s.description, triggers: s.triggers }));
      },
    },
    {
      name: SKILL_READ_TOOL,
      description: 'Read one installed skill\'s full instructions. args: {"name":"<skill name>"}',
      readOnly: true,
      async execute(args, ctx) {
        const name = typeof args.name === 'string' ? args.name : '';
        const skill = await loadSkill(ctx.dir, name);
        if (!skill) throw new Error(`No skill called "${name}".`);
        return { name: skill.name, description: skill.description, triggers: skill.triggers, body: skill.body };
      },
    },
  ];
}
