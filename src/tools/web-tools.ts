import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ToolError, type ToolDefinition } from './tools';

/**
 * Built-in read-only web research (v19), with no API key: `web.search` asks DuckDuckGo's plain HTML page and parses the
 * top results; `web.fetch` reads one public page as plain text. Both are read-only, so the Master Loop may call them while
 * planning or executing, and chat runs them right away: Rufus can look things up (flights, gear, docs) before it answers.
 *
 * `web.fetch` only reaches the public internet. Loopback, private, link-local (cloud metadata at 169.254.169.254),
 * carrier-grade NAT, multicast and reserved addresses are refused, both as literal IPs and after DNS, and every redirect
 * hop is checked again.
 */

export const WEB_SEARCH_TOOL = 'web.search';
export const WEB_FETCH_TOOL = 'web.fetch';
export const DEFAULT_WEB_TIMEOUT_MS = 10_000;
export const DEFAULT_SEARCH_RESULTS = 6;
export const MAX_SEARCH_RESULTS = 8;
export const DEFAULT_FETCH_CHARS = 6000;
export const DUCKDUCKGO_HTML_URL = 'https://html.duckduckgo.com/html/';
/** Bytes read from a page before giving up on the rest. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** A plain browser User-Agent: the HTML endpoint serves an empty page to unknown clients. Nothing about you is in it. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebPage {
  /** The URL asked for. */
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  title?: string;
  text: string;
  /** True when the text was cut at `maxChars`. */
  truncated: boolean;
}

/** Resolves a host name to its addresses. Injectable so tests never touch DNS. */
export type HostLookup = (host: string) => Promise<string[]>;

export interface WebToolsOptions {
  fetch?: typeof fetch;
  /** Per request. Default 10s. */
  timeoutMs?: number;
  /** Default: the system resolver. */
  lookup?: HostLookup;
  /** Text kept from a fetched page. Default 6000. */
  maxChars?: number;
  /** The search page. Default DuckDuckGo's HTML endpoint. */
  searchUrl?: string;
}

const systemLookup: HostLookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

// ---------- SSRF guard ----------

function ipv4Blocked(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 address to 8 hextets (with any embedded IPv4 tail converted), or undefined when malformed. */
function ipv6Hextets(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1]!.split('.').map(Number);
    s = `${s.slice(0, v4.index)}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tail];
  if (parts.length !== 8) return undefined;
  const nums = parts.map((h) => parseInt(h, 16));
  return nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? undefined : nums;
}

function ipv6Blocked(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return true;
  const [a] = h as [number];
  if (h.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 inside.
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    return ipv4Blocked(`${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`);
  }
  if (a === 0x64 && h[1] === 0xff9b) return ipv4Blocked(`${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}`); // NAT64
  return (a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xff00) === 0xff00 || (a === 0x2001 && h[1] === 0xdb8); // ULA, link-local, multicast, documentation
}

/** True for any address that is not on the public internet (loopback, private, link-local, metadata, reserved). */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const v = isIP(bare);
  if (v === 4) return ipv4Blocked(bare);
  if (v === 6) return ipv6Blocked(bare);
  return true;
}

const BLOCKED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata(\.google\.internal)?)$/i;

/** Throws a clear `ToolError` unless `raw` is a public http(s) URL whose host resolves only to public addresses. */
export async function assertPublicUrl(raw: string, lookup: HostLookup = systemLookup, tool = WEB_FETCH_TOOL): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ToolError(tool, `"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError(tool, `only http:// and https:// URLs can be fetched, not ${url.protocol}`);
  if (url.username || url.password) throw new ToolError(tool, 'URLs with a username or password are not fetched.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new ToolError(tool, 'the URL has no host.');
  const blocked = `${host} is a private or local address, so it is not fetched (only the public internet).`;
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new ToolError(tool, blocked);
    return url;
  }
  if (BLOCKED_HOST.test(host)) throw new ToolError(tool, blocked);
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch (err) {
    throw new ToolError(tool, `could not resolve ${host} (offline, or no such site): ${(err as Error).message}`);
  }
  if (!addresses.length) throw new ToolError(tool, `could not resolve ${host}.`);
  if (addresses.some(isBlockedAddress)) throw new ToolError(tool, blocked);
  return url;
}

// ---------- HTML to text ----------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', times: '×',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Inline HTML to one clean line: tags dropped, entities decoded, whitespace collapsed. */
export function inlineText(html: string): string {
  return decodeEntities(html.replace(/<\/?(b|i|em|strong|span|mark|u|small|sup|sub|code)\b[^>]*>/gi, '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?)])/g, '$1')
    .trim();
}

/** The `<title>` of a page, if any. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? inlineText(m[1]!) : '';
  return t || undefined;
}

/** Readable plain text from HTML: scripts, styles and other non-content dropped, blocks become lines, entities decoded. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg|head|title|iframe|canvas|object)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(script|style|noscript)\b[^>]*\/?>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/?(p|div|section|article|main|header|footer|nav|aside|h[1-6]|ul|ol|tr|table|blockquote|pre|dd|dt|figure|figcaption|form)\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, all) => l && !(l === '-' && !all[i + 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- search results ----------

/** DuckDuckGo wraps result links in a redirect (`//duckduckgo.com/l/?uddg=<url>`): unwrap it. */
function unwrapResultUrl(href: string): string | undefined {
  const raw = decodeEntities(href.trim());
  let url: URL;
  try {
    url = new URL(raw, 'https://duckduckgo.com');
  } catch {
    return undefined;
  }
  if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) {
    if (url.pathname === '/y.js') return undefined; // an ad
    const target = url.searchParams.get('uddg');
    if (!target) return undefined;
    try {
      url = new URL(target);
    } catch {
      return undefined;
    }
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
}

/** Parses DuckDuckGo's HTML (or lite) results page into clean results, ads and duplicates dropped. */
export function parseSearchResults(html: string, limit = DEFAULT_SEARCH_RESULTS): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const seen = new Set<string>();
  const push = (href: string, titleHtml: string, snippetHtml: string): void => {
    const url = unwrapResultUrl(href);
    const title = inlineText(titleHtml);
    if (!url || !title || seen.has(url) || out.length >= limit) return;
    seen.add(url);
    out.push({ title, url, snippet: inlineText(snippetHtml) });
  };
  // html.duckduckgo.com: one `result` block per hit, with `result__a` (title link) and `result__snippet`.
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (/^[^>]*result--ad\b/i.test(block)) continue;
    const a = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const href = /href="([^"]*)"/i.exec(a[0])?.[1] ?? '';
    const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td|span)>/i.exec(block)?.[1] ?? '';
    push(href, a[1]!, snippet);
  }
  if (out.length) return out;
  // lite.duckduckgo.com: `result-link` anchors, each followed by a `result-snippet` cell.
  const link = /<a[^>]*class=['"][^'"]*\bresult-link\b[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = link.exec(html))) {
    const href = /href=['"]([^'"]*)['"]/i.exec(m[0])?.[1] ?? '';
    const rest = html.slice(link.lastIndex, link.lastIndex + 4000);
    const next = rest.search(/class=['"][^'"]*\bresult-link\b/i);
    const snippet = /class=['"][^'"]*\bresult-snippet\b[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i.exec(next >= 0 ? rest.slice(0, next) : rest)?.[1] ?? '';
    push(href, m[1]!, snippet);
  }
  return out;
}

// ---------- fetching ----------

const secs = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);

/** One request with a hard timeout. Network failures and timeouts become clear `ToolError`s. */
async function timedFetch(f: typeof fetch, tool: string, url: string, init: RequestInit, timeoutMs: number, what: string): Promise<{ res: Response; done: () => void; signal: AbortSignal }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await f(url, { ...init, signal: ctrl.signal });
    return { res, done: () => clearTimeout(timer), signal: ctrl.signal };
  } catch (err) {
    clearTimeout(timer);
    if (ctrl.signal.aborted) throw new ToolError(tool, `${what} timed out after ${secs(timeoutMs)}.`);
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new ToolError(tool, `could not reach ${what} (offline?): ${cause?.code ?? cause?.message ?? (err as Error).message}`);
  }
}

/** Reads at most `maxBytes` of a body as text, under the same timeout. */
async function readCapped(res: Response, maxBytes: number, signal: AbortSignal, tool: string, timeoutMs: number, what: string): Promise<string> {
  try {
    if (!res.body) return await res.text();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (signal.aborted) throw new Error('timeout');
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    const buf = new Uint8Array(Math.min(total, maxBytes));
    let at = 0;
    for (const c of chunks) {
      const take = c.subarray(0, buf.length - at);
      buf.set(take, at);
      at += take.byteLength;
      if (at >= buf.length) break;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } catch (err) {
    if (signal.aborted) throw new ToolError(tool, `${what} timed out after ${secs(timeoutMs)}.`);
    throw new ToolError(tool, `could not read ${what}: ${(err as Error).message}`);
  }
}

const TEXTUAL = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml)|$)/i;

/** Fetches a public page and returns its readable text. Every redirect hop is checked against the SSRF guard. */
export async function fetchPage(raw: string, opts: WebToolsOptions = {}): Promise<WebPage> {
  const f = opts.fetch ?? fetch;
  const lookup = opts.lookup ?? systemLookup;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
  const maxChars = Math.max(200, opts.maxChars ?? DEFAULT_FETCH_CHARS);
  let url = await assertPublicUrl(raw, lookup);
  for (let hop = 0; ; hop++) {
    const { res, done, signal } = await timedFetch(f, WEB_FETCH_TOOL, url.toString(), { redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' } }, timeoutMs, url.hostname);
    try {
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new ToolError(WEB_FETCH_TOOL, `${url.hostname} redirected without saying where.`);
        if (hop >= MAX_REDIRECTS) throw new ToolError(WEB_FETCH_TOOL, `too many redirects from ${raw}.`);
        url = await assertPublicUrl(new URL(location, url).toString(), lookup);
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!res.ok) throw new ToolError(WEB_FETCH_TOOL, `${url.hostname} answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (!TEXTUAL.test(type)) {
        await res.body?.cancel().catch(() => undefined);
        throw new ToolError(WEB_FETCH_TOOL, `${url} is ${type}, not a readable page.`);
      }
      const body = await readCapped(res, MAX_BODY_BYTES, signal, WEB_FETCH_TOOL, timeoutMs, url.hostname);
      const html = /html|xml/i.test(type) || /^\s*</.test(body);
      const full = html ? htmlToText(body) : body.replace(/\r\n?/g, '\n').trim();
      const title = html ? htmlTitle(body) : undefined;
      const truncated = full.length > maxChars;
      return { url: raw, finalUrl: url.toString(), ...(title ? { title } : {}), text: truncated ? `${full.slice(0, maxChars - 1).trimEnd()}…` : full, truncated };
    } finally {
      done();
    }
  }
}

/** Searches the web (DuckDuckGo, no key) and returns the top results. */
export async function searchWeb(query: string, opts: WebToolsOptions & { limit?: number } = {}): Promise<WebSearchResult[]> {
  const q = query.trim();
  if (!q) throw new ToolError(WEB_SEARCH_TOOL, 'needs a non-empty query.');
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_SEARCH_RESULTS)), MAX_SEARCH_RESULTS);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
  const endpoint = new URL(opts.searchUrl ?? DUCKDUCKGO_HTML_URL);
  endpoint.searchParams.set('q', q);
  const { res, done, signal } = await timedFetch(opts.fetch ?? fetch, WEB_SEARCH_TOOL, endpoint.toString(), { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } }, timeoutMs, 'DuckDuckGo');
  try {
    if (!res.ok) throw new ToolError(WEB_SEARCH_TOOL, `DuckDuckGo answered HTTP ${res.status}. Try again in a minute.`);
    const html = await readCapped(res, MAX_BODY_BYTES, signal, WEB_SEARCH_TOOL, timeoutMs, 'DuckDuckGo');
    const results = parseSearchResults(html, limit);
    if (!results.length && /anomaly|captcha|challenge/i.test(html)) throw new ToolError(WEB_SEARCH_TOOL, 'DuckDuckGo asked for a captcha (too many searches). Try again in a few minutes.');
    return results;
  } finally {
    done();
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `web.search` and `web.fetch`: both read-only, no API key. */
export function webTools(opts: WebToolsOptions = {}): ToolDefinition<Record<string, unknown>, unknown>[] {
  return [
    {
      name: WEB_SEARCH_TOOL,
      description: 'Search the web (DuckDuckGo, no key). Args: {"query":"...","limit":6}. Returns [{title,url,snippet}].',
      readOnly: true,
      execute: (args) => searchWeb(str(args.query) || str(args.q), { ...opts, ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) }),
    },
    {
      name: WEB_FETCH_TOOL,
      description: 'Read one public web page as plain text (max ~6000 chars). Args: {"url":"https://..."}.',
      readOnly: true,
      execute: (args) => {
        const url = str(args.url).trim();
        if (!url) throw new ToolError(WEB_FETCH_TOOL, 'needs a url.');
        return fetchPage(url, opts);
      },
    },
  ];
}
