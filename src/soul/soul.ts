import { promises as fs } from 'node:fs';
import path from 'node:path';
import { localDate, toMinutes, type Anchor, type ScheduleBlock } from '../anchor/anchor';
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

// ---------- time awareness ----------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

type BlockView = Pick<ScheduleBlock, 'start' | 'end' | 'kind' | 'title'>;

/** Exact local time facts, computed by code so the model never has to guess what day or hour it is. */
export interface TimeFacts {
  /** `YYYY-MM-DD`, local. */
  date: string;
  weekday: string;
  /** `HH:MM`, 24-hour, local. */
  time: string;
  /** IANA zone of this machine, when known. */
  timeZone?: string;
  /** The Anchor block happening right now (today's schedule only). */
  currentBlock?: BlockView;
  /** The next Anchor block today. */
  nextBlock?: BlockView;
}

const slim = (b: ScheduleBlock): BlockView => ({ start: b.start, end: b.end, kind: b.kind, title: b.title });

/** Today's current and next schedule blocks from the Anchor (none when the Anchor's schedule is for another day). */
export function scheduleNow(anchor: Anchor | undefined, now: Date): { current?: ScheduleBlock; next?: ScheduleBlock } {
  if (!anchor || anchor.schedule.date !== localDate(now)) return {};
  const mins = now.getHours() * 60 + now.getMinutes();
  const blocks = anchor.schedule.blocks.filter((b) => b.status !== 'skipped').sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  const current = blocks.find((b) => toMinutes(b.start) <= mins && mins < toMinutes(b.end));
  const next = blocks.find((b) => toMinutes(b.start) > mins);
  return { ...(current ? { current } : {}), ...(next ? { next } : {}) };
}

export function timeFacts(now: Date, anchor?: Anchor): TimeFacts {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    /* unknown */
  }
  const { current, next } = scheduleNow(anchor, now);
  return {
    date: localDate(now),
    weekday: WEEKDAYS[now.getDay()]!,
    time: hhmm(now),
    ...(timeZone ? { timeZone } : {}),
    ...(current ? { currentBlock: slim(current) } : {}),
    ...(next ? { nextBlock: slim(next) } : {}),
  };
}

/** "Wednesday 2026-11-25, 08:00 local time. Now: 07:30-09:00 focus Deep work. Next: 12:00-13:00 personal Gym." */
export function timeBrief(now: Date, anchor?: Anchor): string {
  const t = timeFacts(now, anchor);
  const block = (b: BlockView): string => `${b.start}-${b.end} ${b.kind} ${b.title}`;
  return [
    `${t.weekday} ${t.date}, ${t.time} local time${t.timeZone ? ` (${t.timeZone})` : ''}.`,
    t.currentBlock ? `Now: ${block(t.currentBlock)}.` : 'Nothing scheduled right now.',
    t.nextBlock ? `Next: ${block(t.nextBlock)}.` : 'Nothing else scheduled today.',
  ].join(' ');
}

// ---------- corpus relevance ----------

/** Below this score a corpus hit is noise (a stray word in common) and never reaches the model. */
export const MIN_FACT_SCORE = 0.35;

const SMALL_TALK = new Set([
  'hi', 'hey', 'hello', 'yo', 'sup', 'hiya', 'howdy', 'morning', 'good', 'gm', 'night', 'gn', 'evening', 'afternoon',
  'ok', 'okay', 'k', 'kk', 'thanks', 'thank', 'you', 'thx', 'ty', 'cool', 'nice', 'great', 'yes', 'yep', 'yeah', 'no', 'nope',
  'sure', 'lol', 'haha', 'got', 'it', 'sounds', 'perfect', 'awesome', 'done', 'np', 'there', 'rufus', 'whats', 'up', 'how', 'are',
  'u', 'r', 'doing', 'all', 'right', 'alright', 'fine', 'and', 'so', 'a', 'the', 'to', 'is', 'im', 'i', 'me', 'please', 'pls',
]);
/** Words that carry no topic, so they never count toward (or against) a keyword match. */
const FUNCTION_WORDS = new Set([
  'what', 'when', 'where', 'who', 'why', 'which', 'does', 'do', 'did', 'can', 'could', 'will', 'would', 'should', 'was', 'were',
  'be', 'been', 'an', 'of', 'in', 'on', 'for', 'with', 'my', 'at', 'by', 'or', 'this', 'that', 'these', 'those', 'we', 'our',
  'your', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'have', 'has', 'had', 'from', 'about', 'any', 'some', 'just', 'now',
  'today', 'tomorrow', 'need', 'want', 'get', 'let', 'lets', 'tell', 'know', 'think', 'still', 'too', 'also', 'if', 'then', 'than',
]);
const wordsOf = (s: string): string[] => s.toLowerCase().replace(/['’]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** "hi", "ok thanks", "good morning!" and the like: nothing worth a corpus lookup. */
export function isSmallTalk(text: string): boolean {
  const w = wordsOf(text);
  return w.length === 0 || w.every((x) => SMALL_TALK.has(x));
}

/**
 * Only the hits that clearly relate to `query`: a score of at least `minScore`, and either semantic similarity at that
 * level or keyword overlap with at least a third of the query's meaningful words. Small talk gets nothing at all.
 */
export function relevantHits(hits: CorpusHit[], query: string, opts: { minScore?: number } = {}): CorpusHit[] {
  if (isSmallTalk(query)) return [];
  const min = opts.minScore ?? MIN_FACT_SCORE;
  const content = new Set(wordsOf(query).filter((w) => !SMALL_TALK.has(w) && !FUNCTION_WORDS.has(w) && w.length > 1));
  return hits.filter((h) => {
    if (!(h.score >= min)) return false;
    if (h.similarity !== undefined && h.similarity >= min) return true;
    const share = content.size ? h.matched.filter((m) => content.has(m)).length / content.size : 0;
    return h.matched.length > 0 && share >= 1 / 3;
  });
}

export interface PersonaInput {
  /** The current time: adds a "Right now" section (date, weekday, local time, current and next Anchor block). */
  now?: Date;
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
  if (input.now) parts.push(`## Right now\n${timeBrief(input.now, input.anchor)}`);
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
