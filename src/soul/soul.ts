import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Anchor } from '../anchor/anchor';
import type { CorpusHit } from '../corpus';
import { clip } from '../corpus/types';

/**
 * `SOUL.md`: who you are and how Rufus should act for you, in your own words (voice, values, priorities, people,
 * "never do X"). Optional and free-form. When present it is injected, with a compact Anchor summary and the closest
 * corpus examples and facts, into every Chief of Staff chat and every Master Loop model call (plan, execute, verify).
 */

export const SOUL_FILE = 'SOUL.md';
/** A SOUL.md longer than this is clipped in prompts (the file itself is never changed). */
export const MAX_SOUL_CHARS = 4000;

export const soulFile = (dir: string): string => path.join(dir, SOUL_FILE);

/** Reads `<workspace>/SOUL.md`. `undefined` when it is missing or blank. */
export async function loadSoul(dir: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(soulFile(dir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  // HTML comments are notes to yourself (the template is all comments), never prompt text.
  const trimmed = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  return trimmed ? trimmed : undefined;
}

/** A starter SOUL.md: every line a comment, so it changes nothing until you write your own words. */
export const SOUL_TEMPLATE = `<!--
SOUL.md - who you are and how Rufus should act for you. Plain words. Everything outside these comment marks is
added to every Rufus prompt (chat, plan, execute, verify), so keep it short and true. For example:

# Me
I run a small team. Mornings are for deep work; I answer messages after lunch.

# Voice
Short, warm, direct. No exclamation marks. Sign off with my first name only with people I don't know well.

# Never
Never commit me to a meeting before 10:00. Never share my phone number.
-->
`;

/** Writes the template when there is no SOUL.md yet. Returns true when it created one. */
export async function initSoul(dir: string): Promise<boolean> {
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(soulFile(dir), SOUL_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

const PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** A compact, prompt-sized view of the Anchor: active goals, live projects, today's schedule, boundaries. */
export function anchorBrief(anchor: Anchor, opts: { maxGoals?: number; maxBlocks?: number } = {}): string {
  const lines: string[] = [];
  const goals = anchor.goals
    .filter((g) => g.active)
    .sort((a, b) => (PRIORITY[a.priority] ?? 3) - (PRIORITY[b.priority] ?? 3))
    .slice(0, opts.maxGoals ?? 5);
  if (goals.length) lines.push(`Goals: ${goals.map((g) => `[${g.priority}/${g.horizon}] ${g.title}`).join('; ')}`);
  const projects = anchor.projects.filter((p) => p.status === 'active').slice(0, 5);
  if (projects.length) lines.push(`Projects: ${projects.map((p) => `${p.name}${p.nextStep ? ` (next: ${p.nextStep})` : ''}`).join('; ')}`);
  const blocks = anchor.schedule.blocks.slice(0, opts.maxBlocks ?? 8);
  if (blocks.length) lines.push(`Today ${anchor.schedule.date}: ${blocks.map((b) => `${b.start}-${b.end} ${b.kind} ${b.title}`).join('; ')}`);
  const rules = anchor.boundaries.slice(0, 6).map((b) => b.rule);
  if (rules.length) lines.push(`Boundaries: ${rules.join(' ')}`);
  return lines.join('\n');
}

export interface PersonaInput {
  soul?: string;
  anchor?: Anchor;
  /** Past human verdicts, closest first. */
  examples?: CorpusHit[];
  /** Facts from the life corpus, closest first. */
  facts?: CorpusHit[];
}

/**
 * The context block appended to a system prompt: SOUL.md, the Anchor, then examples and facts. Empty when there is
 * nothing to add, so a workspace without any of these behaves exactly as before.
 */
export function buildPersona(input: PersonaInput): string {
  const parts: string[] = [];
  if (input.soul?.trim()) parts.push(`## Who you work for (SOUL.md)\n${clip(input.soul.trim(), MAX_SOUL_CHARS)}`);
  const brief = input.anchor ? anchorBrief(input.anchor) : '';
  if (brief) parts.push(`## The Anchor (what matters right now)\n${brief}`);
  const examples = (input.examples ?? []).slice(0, 3);
  if (examples.length) parts.push(`## Past decisions by the human (closest first)\n${examples.map((h) => `- ${clip(h.item.summary, 300)}`).join('\n')}`);
  const facts = (input.facts ?? []).slice(0, 3);
  if (facts.length) parts.push(`## Related facts from their life corpus\n${facts.map((h) => `- [${h.item.source}] ${clip(h.item.title ? `${h.item.title}: ${h.item.summary}` : h.item.summary, 240)}`).join('\n')}`);
  return parts.join('\n\n');
}

/** `base` plus the persona block, if any. */
export function withPersona(base: string, persona: string): string {
  return persona ? `${base}\n\n${persona}` : base;
}
