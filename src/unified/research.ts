import type { Anchor } from '../anchor/anchor';
import { clip } from '../corpus/types';
import { anchorBrief, MAX_SOUL_CHARS } from '../soul/soul';
import type { AiProvider } from '../types';

/**
 * Research-backed decision cards (v19). After Rufus looks something up (`web.search`, `web.fetch`), this turns the
 * results plus your own constraints (SOUL.md and the Anchor's goals and boundaries) into one short, chat-safe
 * recommendation:
 *
 *   Flights to Denver
 *   A: United nonstop, $320, lands 2pm (united.com)
 *   B: Frontier 1 stop, $180, lands 7pm (flyfrontier.com)
 *   Pick: A. Lands before your 4pm meeting.
 *   Next: Want me to hold the United fare?
 *
 * Plain lines only: no tables, headings, bold or bullets, so it reads the same in iMessage, WhatsApp, Telegram or Beeper.
 * With a model it reasons over the sources; without one (or when the model's reply is unusable) code builds a card from
 * the top two results so there is always something honest to send.
 */

/** One thing found while researching: a search result, optionally with the fetched page text. */
export interface ResearchSource {
  title: string;
  url: string;
  snippet?: string;
  /** Page text from `web.fetch`, when it was read. */
  text?: string;
}

export interface DecisionOption {
  name: string;
  /** One line: what it is and the facts that matter (price, time, spec). */
  summary: string;
  /** Where it came from, when known. */
  url?: string;
}

export interface DecisionCard {
  question: string;
  options: DecisionOption[];
  /** `A` or `B`, when there are options. */
  pick?: 'A' | 'B';
  why: string;
  next: string;
  /** The card as chat text, ready to send. */
  text: string;
  /** `ai` when a model wrote it, `code` for the fallback. */
  by: 'ai' | 'code';
}

export interface DecisionCardInput {
  question: string;
  results: ResearchSource[];
  ai?: AiProvider;
  /** SOUL.md text: who you are and what you care about. */
  soul?: string;
  /** The Anchor (`anchor.json`): goals and boundaries the pick must respect. */
  anchor?: Anchor;
  /** Extra constraints in plain words ("under $400", "must land before 4pm"). */
  constraints?: string[];
}

const MAX_SOURCES = 6;
const SNIPPET_CHARS = 300;
const PAGE_CHARS = 1500;
const LINE_CHARS = 160;
export const MAX_CARD_CHARS = 700;

const DECISION_PROMPT = [
  'You turn web research into ONE decision card for a busy person reading it in a chat app.',
  'Use only facts from the sources. Never invent prices, times or specs; if a fact is missing, say so briefly.',
  'Pick the two best real options (Option A and Option B), choose one, and fit the choice to their goals, boundaries and constraints.',
  'Reply with ONLY a JSON object, no prose:',
  '{"a":{"name":"...","summary":"one short line of the facts that matter","source":1},"b":{"name":"...","summary":"...","source":2},"pick":"A","why":"one short line","next":"one short next step"}',
  '`source` is the number of the source it came from. Keep every field under 140 characters. Zero fluff.',
].join('\n');

/** Strips anything that renders badly in chat apps: markdown tables, headings, bold, bullets, code fences, extra spaces. */
export function chatSafe(s: string, max = LINE_CHARS): string {
  const t = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[|]/g, ' ')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(t, max);
}

const domain = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
};

/** The card as plain chat lines. */
export function formatDecisionCard(card: Pick<DecisionCard, 'question' | 'options' | 'pick' | 'why' | 'next'>): string {
  const lines = [chatSafe(card.question, 120)];
  card.options.slice(0, 2).forEach((o, i) => {
    const site = domain(o.url);
    const label = i === 0 ? 'A' : 'B';
    lines.push(`${label}: ${chatSafe(o.name, 70)}${o.summary ? `, ${chatSafe(o.summary, 140)}` : ''}${site ? ` (${site})` : ''}`);
  });
  if (card.pick) lines.push(`Pick: ${card.pick}. ${chatSafe(card.why, 160)}`.trim());
  else if (card.why) lines.push(chatSafe(card.why, 160));
  if (card.next) lines.push(`Next: ${chatSafe(card.next, 140)}`);
  const text = lines.filter(Boolean).join('\n');
  return text.length > MAX_CARD_CHARS ? `${text.slice(0, MAX_CARD_CHARS - 1).trimEnd()}…` : text;
}

/** The constraints the pick must respect, as prompt lines: SOUL.md, the Anchor's goals and boundaries, extra ones. */
export function constraintsBrief(input: Pick<DecisionCardInput, 'soul' | 'anchor' | 'constraints'>): string {
  const parts: string[] = [];
  if (input.soul?.trim()) parts.push(`Who they are (SOUL.md):\n${clip(input.soul.trim(), Math.min(MAX_SOUL_CHARS, 1500))}`);
  const brief = input.anchor ? anchorBrief(input.anchor, { maxBlocks: 6 }) : '';
  if (brief) parts.push(`Their Anchor:\n${brief}`);
  const extra = (input.constraints ?? []).map((c) => c.trim()).filter(Boolean);
  if (extra.length) parts.push(`Constraints: ${extra.join('; ')}`);
  return parts.join('\n\n');
}

function sourcesBrief(sources: ResearchSource[]): string {
  return sources
    .map((s, i) => {
      const body = [s.snippet ? clip(s.snippet, SNIPPET_CHARS) : '', s.text ? `Page: ${clip(s.text, PAGE_CHARS)}` : ''].filter(Boolean).join('\n');
      return `[${i + 1}] ${clip(s.title, 140)} (${s.url})${body ? `\n${body}` : ''}`;
    })
    .join('\n\n');
}

/** The first JSON object in a model reply (fences and chatter around it ignored). */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const t = raw.replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const o = JSON.parse(t.slice(start, end + 1)) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function optionFrom(raw: unknown, sources: ResearchSource[]): DecisionOption | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const name = text(o.name) || text(o.title);
  if (!name) return undefined;
  const n = typeof o.source === 'number' ? o.source : Number(text(o.source));
  const src = Number.isInteger(n) && n >= 1 && n <= sources.length ? sources[n - 1] : undefined;
  const url = src?.url ?? (/^https?:\/\//.test(text(o.url)) ? text(o.url) : undefined);
  return { name, summary: text(o.summary), ...(url ? { url } : {}) };
}

/** A card from code alone: the top two results, the first one picked. Honest about not having weighed them. */
function codeCard(question: string, sources: ResearchSource[]): DecisionCard {
  const options = sources.slice(0, 2).map((s) => ({ name: s.title, summary: s.snippet ?? '', url: s.url }));
  const base = !options.length
    ? { question, options, why: "Couldn't find anything solid on that yet.", next: 'Want me to try a different search?' }
    : options.length === 1
      ? { question, options, pick: 'A' as const, why: 'The only solid result I found.', next: `Open ${options[0]!.url} to check it fits.` }
      : { question, options, pick: 'A' as const, why: 'Top match for what you asked; I have not compared the details yet.', next: `Open ${options[0]!.url} to confirm, or ask me to dig into B.` };
  return { ...base, text: formatDecisionCard(base), by: 'code' };
}

/**
 * Builds a decision card from research results and your constraints. With `ai`, one model call weighs the sources;
 * without it (or if the reply is unusable or the call fails) code builds a simpler card from the top two results.
 */
export async function buildDecisionCard(input: DecisionCardInput): Promise<DecisionCard> {
  const question = input.question.trim();
  const sources = input.results.filter((r) => r && text(r.title) && text(r.url)).slice(0, MAX_SOURCES);
  if (!input.ai || !sources.length) return codeCard(question, sources);
  const constraints = constraintsBrief(input);
  let raw: string;
  try {
    raw = await input.ai.complete({
      system: DECISION_PROMPT,
      messages: [{ role: 'user', content: [`Question: ${question}`, constraints, `Sources:\n${sourcesBrief(sources)}`].filter(Boolean).join('\n\n') }],
      json: true,
      meta: { runId: 'research', flowId: 'research', step: 'decision-card', attempt: 1 },
    });
  } catch {
    return codeCard(question, sources);
  }
  const o = parseJsonObject(raw);
  const a = optionFrom(o?.a ?? o?.optionA, sources);
  if (!o || !a) return codeCard(question, sources);
  const b = optionFrom(o.b ?? o.optionB, sources);
  const options = b ? [a, b] : [a];
  const pickRaw = text(o.pick).toUpperCase();
  const pick: 'A' | 'B' = pickRaw.startsWith('B') && b ? 'B' : 'A';
  const card = { question, options, pick, why: text(o.why), next: text(o.next) || 'Want me to look closer?' };
  return { ...card, text: formatDecisionCard(card), by: 'ai' };
}
