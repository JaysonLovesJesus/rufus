import path from 'node:path';
import { loadAnchor, type Anchor } from '../anchor/anchor';
import { CorpusStore } from '../corpus/store';
import type { CorpusItem } from '../corpus/types';
import type { AiProvider } from '../types';
import { speakableTitle } from './heartbeat';

/**
 * v17, the Curated Research / Break Digest. Instead of a feed, a break gets 2-3 crisp bullets: pages from recent browsing
 * that are worth revisiting or following up on, ranked by how they tie into active goals and projects and how often you
 * came back to them. Login, search, inbox and feed pages are filtered out by code first. Read-only: it never writes.
 */

export const DEFAULT_DIGEST_LOOKBACK_HOURS = 72;
export const DEFAULT_DIGEST_MAX = 3;
const AI_CANDIDATES = 8;

export interface DigestTopic {
  title: string;
  domain?: string;
  url?: string;
  visits: number;
  /** Goals or projects it ties into. */
  ties: string[];
  score: number;
  timestamp: string;
}

export interface BreakDigest {
  /** The 0-3 bullets, without the leading "• ". */
  bullets: string[];
  topics: DigestTopic[];
  /** Ready to send. */
  text: string;
  via: 'ai' | 'code' | 'empty';
}

export interface DigestOptions {
  dir: string;
  anchor?: Anchor;
  now: Date;
  ai?: AiProvider;
  /** How far back browsing counts. Default 72h. */
  lookbackHours?: number;
  /** Most bullets. Default 3. */
  max?: number;
  /** Use these corpus items instead of reading `<dir>/corpus/items.jsonl`. */
  items?: CorpusItem[];
}

const SEARCH_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|search\.brave\.com|kagi\.com|ecosia\.org|yandex\.[a-z]+|baidu\.com)$/;
const UTILITY_HOSTS = /^(accounts\.google\.com|login\.[^/]+|auth\.[^/]+|sso\.[^/]+|signin\.[^/]+|id\.[^/]+|mail\.google\.com|outlook\.(live|office|office365)\.com|calendar\.google\.com|meet\.google\.com|zoom\.us|[\w-]+\.zoom\.us|app\.slack\.com|web\.whatsapp\.com|messenger\.com|localhost)$/;
/** Feeds built for endless scrolling: never "worth revisiting". */
const FEED_HOSTS = /(^|\.)(instagram\.com|tiktok\.com|facebook\.com|threads\.net)$/;
/** Sites whose home or feed is noise, but whose specific pages (a thread, a video, a post) may be worth it. */
const FEED_HOME_HOSTS = /(^|\.)(x\.com|twitter\.com|reddit\.com|youtube\.com|linkedin\.com|news\.ycombinator\.com|bsky\.app)$/;
const FEED_PATHS = /^\/?(home|feed|explore|notifications|for-you|foryou|trending|popular|r\/all|r\/popular|watch\/?later|feed\/subscriptions)?\/?$/i;
const NOISE_PATH = /(^|\/)(login|log-in|logout|signin|sign-in|signup|sign-up|register|oauth\d?|auth|sso|session|callback|checkout|cart|password|reset|verify|2fa|mfa|consent|unsubscribe|settings|account|inbox|search|results)(\/|$|\?|\.)/i;
const NOISE_TITLE = /^(sign in|sign-in|log ?in|login|sign up|create account|new tab|untitled|inbox|home|redirecting|loading|just a moment|access denied|attention required|404|page not found|error|not found|checkout|cart)\b|google search$| - search$|\bsign in to\b|\blog in to\b/i;

const urlOf = (item: CorpusItem): string | undefined => {
  const u = item.metadata?.url;
  return typeof u === 'string' && u ? u : undefined;
};

/** Login, search, inbox, settings and feed pages: never worth a break. */
export function isNoisePage(item: Pick<CorpusItem, 'title' | 'domain' | 'metadata' | 'summary'>): boolean {
  const raw = urlOf(item as CorpusItem);
  let host = item.domain ?? '';
  let pathname = '';
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
      host = u.hostname.toLowerCase().replace(/^www\./, '');
      pathname = u.pathname;
    } catch {
      /* keep the domain */
    }
  }
  if (!host || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost') return true;
  if (SEARCH_HOSTS.test(host) && (pathname === '' || pathname === '/' || /^\/(search|webhp|url)/.test(pathname))) return true;
  if (UTILITY_HOSTS.test(host) || FEED_HOSTS.test(host)) return true;
  if (FEED_HOME_HOSTS.test(host) && FEED_PATHS.test(pathname)) return true;
  if (NOISE_PATH.test(pathname)) return true;
  const title = (item.title ?? '').trim();
  if (!title || NOISE_TITLE.test(title)) return true;
  return false;
}

const STOP = new Set(['about', 'after', 'again', 'also', 'from', 'have', 'into', 'just', 'more', 'next', 'over', 'some', 'than', 'that', 'their', 'them', 'then', 'there', 'they', 'this', 'what', 'when', 'with', 'your', 'will', 'work', 'week', 'today', 'month', 'make', 'done', 'finish', 'start', 'ship', 'write', 'plan', 'review']);
const words = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4 && !STOP.has(w));

/** Active goals and projects, each with the words that tie a page to it. */
function interests(anchor: Anchor): Array<{ name: string; words: string[] }> {
  const goals = anchor.goals.filter((g) => g.active).map((g) => ({ name: g.title, words: words(`${g.title} ${g.notes ?? ''}`) }));
  const projects = anchor.projects.filter((p) => p.status === 'active').map((p) => ({ name: p.name, words: words(`${p.name} ${p.nextStep ?? ''}`) }));
  return [...goals, ...projects].filter((i) => i.words.length);
}

/** Recent, non-noise browser pages ranked by ties to goals/projects, revisits and recency. A lone, unrelated visit is dropped. */
export function digestCandidates(items: CorpusItem[], anchor: Anchor, now: Date, opts: { lookbackHours?: number } = {}): DigestTopic[] {
  const lookMs = (opts.lookbackHours ?? DEFAULT_DIGEST_LOOKBACK_HOURS) * 3_600_000;
  const cares = interests(anchor);
  const seen = new Set<string>();
  const out: DigestTopic[] = [];
  for (const item of items) {
    if (item.source !== 'browser') continue;
    const age = now.getTime() - Date.parse(item.timestamp);
    if (!(age >= -60_000 && age <= lookMs)) continue;
    if (isNoisePage(item)) continue;
    const title = speakableTitle(item.title ?? '', 80);
    const key = `${item.domain ?? ''}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hay = new Set(words(`${item.title ?? ''} ${urlOf(item) ?? ''} ${item.summary}`));
    const ties = cares.filter((c) => c.words.some((w) => hay.has(w))).map((c) => c.name);
    const visits = Number(item.metadata?.visitCount ?? 1) || 1;
    if (!ties.length && visits < 2) continue;
    const score = ties.length * 3 + Math.log2(1 + visits) + Math.max(0, 1 - age / lookMs);
    const url = urlOf(item);
    out.push({ title, ...(item.domain ? { domain: item.domain } : {}), ...(url ? { url } : {}), visits, ties, score, timestamp: item.timestamp });
  }
  return out.sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp));
}

/** One bullet by code: "Title (site) — ties into Goal" or "— you came back to it 4 times". */
export function codeBullet(t: DigestTopic): string {
  const why = t.ties.length ? `ties into ${speakableTitle(t.ties[0]!, 40)}` : `you came back to it ${t.visits} times`;
  return `${t.title}${t.domain ? ` (${t.domain})` : ''} — ${why}`;
}

export const EMPTY_DIGEST = "Nothing from recent browsing is worth circling back to — good moment to step away from the screen for a bit.";

export function formatDigest(bullets: string[]): string {
  return bullets.length ? `Worth a look on your break:\n${bullets.map((b) => `• ${b}`).join('\n')}` : EMPTY_DIGEST;
}

function digestPrompt(topics: DigestTopic[], anchor: Anchor, max: number): string {
  const cares = interests(anchor).map((i) => i.name);
  return [
    `Their active goals and projects: ${cares.length ? cares.join('; ') : 'none named'}.`,
    'Pages from their recent browsing (already filtered, best first):',
    ...topics.map((t, i) => `${i + 1}. ${t.title}${t.domain ? ` (${t.domain})` : ''}, ${t.visits} visit${t.visits === 1 ? '' : 's'}${t.ties.length ? `, ties into: ${t.ties.join(', ')}` : ''}`),
    `Pick the ${Math.min(max, topics.length) > 1 ? `2-${Math.min(max, topics.length)}` : '1'} most worth revisiting or following up on during a short break. Nothing that's just a feed.`,
    'One line each, starting with "• ", under 20 words: the page, then a crisp reason it matters to them now. No links, no intro, no sign-off.',
  ].join('\n');
}

/** Model bullets, if they look right: 1..max lines starting with a bullet, each short. Otherwise undefined. */
function acceptBullets(raw: string, max: number, need: number): string[] | undefined {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets = lines.filter((l) => /^[•\-*]\s+/.test(l)).map((l) => l.replace(/^[•\-*]\s+/, '').trim());
  if (bullets.length < need || bullets.length > max || bullets.length !== lines.length) return undefined;
  if (bullets.some((b) => !b || b.length > 200 || /https?:\/\//.test(b))) return undefined;
  return bullets;
}

/**
 * A short curated digest for a break: 2-3 bullets from recent browsing worth revisiting. Code filters and ranks; with
 * `ai`, one call words the bullets (the code bullets are used if it fails or rambles). Empty history gives a kind
 * "nothing to see" line, never an error.
 */
export async function buildBreakDigest(opts: DigestOptions): Promise<BreakDigest> {
  const max = Math.max(1, Math.min(5, opts.max ?? DEFAULT_DIGEST_MAX));
  const anchor = opts.anchor ?? (await loadAnchor(opts.dir, opts.now));
  const items = opts.items ?? (await new CorpusStore(path.join(opts.dir, 'corpus', 'items.jsonl')).load().catch(() => []));
  const topics = digestCandidates(items, anchor, opts.now, opts.lookbackHours !== undefined ? { lookbackHours: opts.lookbackHours } : {});
  if (!topics.length) return { bullets: [], topics: [], text: EMPTY_DIGEST, via: 'empty' };
  const top = topics.slice(0, max);
  if (opts.ai) {
    try {
      const raw = await opts.ai.complete({
        system: 'You are Rufus, a crisp chief of staff. You curate, you never feed a doomscroll.',
        messages: [{ role: 'user', content: digestPrompt(topics.slice(0, AI_CANDIDATES), anchor, max) }],
        meta: { runId: 'digest', flowId: 'digest', step: 'digest', attempt: 1 },
      });
      const bullets = acceptBullets(raw, max, Math.min(2, topics.length));
      if (bullets) return { bullets, topics: top, text: formatDigest(bullets), via: 'ai' };
    } catch {
      /* code bullets */
    }
  }
  const bullets = top.map(codeBullet);
  return { bullets, topics: top, text: formatDigest(bullets), via: 'code' };
}

/** "break digest", "what's interesting?", "anything worth reading on my break?" */
export const DIGEST_REQUEST = /^(?:hey\s+)?(?:(?:give me|show me|send me|can i get)\s+)?(?:a\s+|my\s+|the\s+)?(?:break digest|digest|research digest)\b[\s\S]{0,20}$|^(?:so\s+)?(?:what'?s|whats|what is|anything) (?:interesting|worth (?:reading|a look|revisiting))\b[\s\S]{0,30}$/i;
