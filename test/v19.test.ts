import { describe, expect, it } from 'vitest';
import {
  FakeProvider,
  ToolError,
  ToolRegistry,
  assertPublicUrl,
  buildDecisionCard,
  buildTools,
  emptyAnchor,
  fetchPage,
  formatDecisionCard,
  htmlToText,
  isBlockedAddress,
  parseSearchResults,
  searchWeb,
  webTools,
  type HostLookup,
  type ResearchSource,
  type ToolContext,
} from '../src';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ dir: '/tmp', now: new Date(2026, 10, 25, 9, 0), ...over });

/** Every host resolves to a public address unless listed. */
const lookupOf =
  (map: Record<string, string[]> = {}): HostLookup =>
  async (host) =>
    map[host] ?? ['93.184.216.34'];

/** A fake fetch: answers from a route table by URL (prefix match), records every request. */
function fakeWeb(routes: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), ...(init ? { init } : {}) });
    const key = Object.keys(routes).find((k) => url.toString().startsWith(k));
    if (!key) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    return routes[key]!(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const html = (body: string, status = 200, headers: Record<string, string> = {}): Response => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

const DDG_HTML = `<!DOCTYPE html><html><body>
<div class="result results_links results_links_deep result--ad">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x&amp;u3=https%3A%2F%2Fads.example.com">Sponsored: Cheap Flights!!!</a>
  <a class="result__snippet" href="https://duckduckgo.com/y.js?ad=1">Buy now</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.kayak.com%2Fflights%2FNYC-DEN&amp;rut=abc">Cheap Flights from <b>New York</b> to <b>Denver</b> &amp; more</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.kayak.com%2Fflights%2FNYC-DEN">Find flights from $89 &#8212; compare <b>nonstop</b> fares.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.united.com%2Fden&amp;rut=def">United: New York to Denver</a></h2>
  <a class="result__snippet" href="#">Nonstop, lands 2pm. From $320.</a>
</div>
<div class="result results_links web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.kayak.com%2Fflights%2FNYC-DEN&amp;rut=dup">Duplicate Kayak</a></h2>
</div>
<div class="result results_links web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fflyfrontier.com%2Fden">Frontier Airlines</a></h2>
  <a class="result__snippet" href="#">1 stop, lands 7pm. From $180.</a>
</div>
</body></html>`;

const DDG_LITE = `<html><body><table>
<tr><td>1.&nbsp;</td><td><a rel="nofollow" href="https://www.rei.com/tents" class='result-link'>Best Tents of 2026 | REI</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Our picks for <b>backpacking</b> tents.</td></tr>
<tr><td>2.&nbsp;</td><td><a rel="nofollow" href="https://www.outdoorgearlab.com/tents" class='result-link'>Tent Reviews</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>We tested 30 tents.</td></tr>
</table></body></html>`;

describe('v19: web.search', () => {
  it('parses DuckDuckGo HTML into clean results: redirects unwrapped, tags and entities gone, ads and duplicates dropped', () => {
    expect(parseSearchResults(DDG_HTML)).toEqual([
      { title: 'Cheap Flights from New York to Denver & more', url: 'https://www.kayak.com/flights/NYC-DEN', snippet: 'Find flights from $89 — compare nonstop fares.' },
      { title: 'United: New York to Denver', url: 'https://www.united.com/den', snippet: 'Nonstop, lands 2pm. From $320.' },
      { title: 'Frontier Airlines', url: 'https://flyfrontier.com/den', snippet: '1 stop, lands 7pm. From $180.' },
    ]);
    expect(parseSearchResults(DDG_HTML, 2)).toHaveLength(2);
    expect(parseSearchResults('<div class="result"><a class="result__a" href="https://ts.dev/">The <b>TypeScript</b> Handbook</a><a class="result__snippet">Learn <b>TypeScript</b>, a typechecker.</a></div>')).toEqual([
      { title: 'The TypeScript Handbook', url: 'https://ts.dev/', snippet: 'Learn TypeScript, a typechecker.' },
    ]);
  });

  it('also parses the lite endpoint', () => {
    expect(parseSearchResults(DDG_LITE)).toEqual([
      { title: 'Best Tents of 2026 | REI', url: 'https://www.rei.com/tents', snippet: 'Our picks for backpacking tents.' },
      { title: 'Tent Reviews', url: 'https://www.outdoorgearlab.com/tents', snippet: 'We tested 30 tents.' },
    ]);
  });

  it('caps results at 8 (default 6)', () => {
    const many = Array.from({ length: 12 }, (_, i) => `<div class="result"><a class="result__a" href="https://site${i}.com/">Site ${i}</a><a class="result__snippet">s${i}</a></div>`).join('');
    expect(parseSearchResults(many)).toHaveLength(6);
    expect(parseSearchResults(many, 8)).toHaveLength(8);
  });

  it('runs as a read-only tool during plan, with the query in the URL and no API key', async () => {
    const web = fakeWeb({ 'https://html.duckduckgo.com/html/': () => html(DDG_HTML) });
    const tools = new ToolRegistry({ tools: webTools({ fetch: web.fetch }) });
    const results = await tools.call<Array<{ url: string }>>('web.search', { query: 'flights NYC to Denver', limit: 2 }, ctx({ stage: 'plan' }));
    expect(results.map((r) => r.url)).toEqual(['https://www.kayak.com/flights/NYC-DEN', 'https://www.united.com/den']);
    expect(new URL(web.calls[0]!.url).searchParams.get('q')).toBe('flights NYC to Denver');
    expect(JSON.stringify(web.calls[0]!.init?.headers ?? {})).not.toMatch(/key|token|authorization/i);
    expect(tools.get('web.search')!.readOnly).toBe(true);
    expect(tools.get('web.fetch')!.readOnly).toBe(true);
    expect(tools.get('web.search')!.sensitivity).toBeUndefined();
  });

  it('empty query, offline, HTTP errors and captcha pages become clear errors', async () => {
    await expect(searchWeb('  ')).rejects.toThrow('needs a non-empty query');
    const offline = fakeWeb({});
    await expect(searchWeb('x', { fetch: offline.fetch })).rejects.toThrow(/web\.search failed: could not reach DuckDuckGo \(offline\?\): ENOTFOUND/);
    await expect(searchWeb('x', { fetch: fakeWeb({ 'https://html': () => html('nope', 503) }).fetch })).rejects.toThrow('HTTP 503');
    await expect(searchWeb('x', { fetch: fakeWeb({ 'https://html': () => html('<form id="challenge-form">anomaly detected</form>') }).fetch })).rejects.toThrow('captcha');
    expect(await searchWeb('zzqx', { fetch: fakeWeb({ 'https://html': () => html('<div class="no-results">No results.</div>') }).fetch })).toEqual([]);
  });

  it('times out after the limit instead of hanging', async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as typeof fetch;
    const started = Date.now();
    const err = await searchWeb('slow', { fetch: hang, timeoutMs: 30 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toBe('Tool web.search failed: DuckDuckGo timed out after 30ms.');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('v19: web.fetch', () => {
  const PAGE = `<!doctype html><html><head><title>Tent Guide &amp; Reviews</title><style>body{color:red}</style>
<script>window.track("secret")</script><meta name="x"></head>
<body><nav>Home</nav><!-- hidden comment --><h1>Best tents</h1><p>The <b>Big Agnes</b> weighs 2&nbsp;lb.</p>
<ul><li>Light</li><li>Roomy</li></ul><noscript>Enable JS</noscript><script type="module">alert(1)</script>
<table><tr><td>Price</td><td>$450</td></tr></table></body></html>`;

  it('strips scripts, styles and tags into readable text with the page title', async () => {
    const web = fakeWeb({ 'https://gear.example.com/': () => html(PAGE) });
    const page = await fetchPage('https://gear.example.com/tents', { fetch: web.fetch, lookup: lookupOf() });
    expect(page.title).toBe('Tent Guide & Reviews');
    expect(page.text).toBe('Home\nBest tents\nThe Big Agnes weighs 2 lb.\n- Light\n- Roomy\nPrice $450');
    expect(page.text).not.toMatch(/track|secret|color:red|alert|hidden comment|Enable JS|</);
    expect(page.truncated).toBe(false);
    expect(page.finalUrl).toBe('https://gear.example.com/tents');
  });

  it('caps text at ~6,000 characters', async () => {
    const big = `<p>${'word '.repeat(5000)}</p>`;
    const page = await fetchPage('https://big.example.com/', { fetch: fakeWeb({ 'https://big.example.com/': () => html(big) }).fetch, lookup: lookupOf() });
    expect(page.text.length).toBeLessThanOrEqual(6000);
    expect(page.text.endsWith('…')).toBe(true);
    expect(page.truncated).toBe(true);
  });

  it('plain text and JSON pass through; images and PDFs are refused', async () => {
    const web = fakeWeb({
      'https://a.example.com/robots.txt': () => new Response('User-agent: *\r\nDisallow:', { headers: { 'content-type': 'text/plain' } }),
      'https://a.example.com/doc.pdf': () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
    });
    expect((await fetchPage('https://a.example.com/robots.txt', { fetch: web.fetch, lookup: lookupOf() })).text).toBe('User-agent: *\nDisallow:');
    await expect(fetchPage('https://a.example.com/doc.pdf', { fetch: web.fetch, lookup: lookupOf() })).rejects.toThrow('application/pdf, not a readable page');
  });

  it.each([
    'http://127.0.0.1/admin',
    'http://127.1.2.3:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:3000/',
    'http://LOCALHOST./',
    'http://api.localhost/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://printer.local/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://2130706433/', // 127.0.0.1 as one decimal number
    'http://0x7f.1/', // 127.0.0.1 in hex
  ])('blocks %s before any request (SSRF)', async (url) => {
    const web = fakeWeb({ 'http': () => html('should never be reached') });
    await expect(fetchPage(url, { fetch: web.fetch, lookup: lookupOf() })).rejects.toThrow(/private or local address/);
    expect(web.calls).toEqual([]);
  });

  it('blocks a public-looking host that resolves to a private address (DNS)', async () => {
    const web = fakeWeb({ 'http': () => html('nope') });
    await expect(fetchPage('https://sneaky.example.com/', { fetch: web.fetch, lookup: lookupOf({ 'sneaky.example.com': ['93.184.216.34', '169.254.169.254'] }) })).rejects.toThrow('sneaky.example.com is a private or local address');
    expect(web.calls).toEqual([]);
  });

  it('re-checks every redirect hop: a public page cannot bounce to the metadata endpoint', async () => {
    const web = fakeWeb({
      'https://short.example.com/': () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
      'http://169.254.169.254/': () => html('instance secrets'),
    });
    await expect(fetchPage('https://short.example.com/x', { fetch: web.fetch, lookup: lookupOf() })).rejects.toThrow('169.254.169.254 is a private or local address');
    expect(web.calls.map((c) => c.url)).toEqual(['https://short.example.com/x']);
    expect(web.calls[0]!.init?.redirect).toBe('manual');
  });

  it('follows safe redirects (relative ones too) and reports where it ended up', async () => {
    const web = fakeWeb({
      'https://old.example.com/': () => new Response(null, { status: 301, headers: { location: 'https://new.example.com/start' } }),
      'https://new.example.com/start': () => new Response(null, { status: 302, headers: { location: '/final' } }),
      'https://new.example.com/final': () => html('<title>Final</title><p>Arrived</p>'),
    });
    const page = await fetchPage('https://old.example.com/', { fetch: web.fetch, lookup: lookupOf() });
    expect(page).toMatchObject({ url: 'https://old.example.com/', finalUrl: 'https://new.example.com/final', title: 'Final', text: 'Arrived' });
  });

  it('refuses non-web schemes, credentials and junk', async () => {
    for (const [url, msg] of [
      ['file:///etc/passwd', 'only http:// and https://'],
      ['ftp://example.com/', 'only http:// and https://'],
      ['javascript:alert(1)', 'only http:// and https://'],
      ['https://user:pass@example.com/', 'username or password'],
      ['not a url', 'not a valid URL'],
    ] as const) {
      await expect(assertPublicUrl(url, lookupOf())).rejects.toThrow(msg);
    }
    const tools = new ToolRegistry({ tools: webTools({ lookup: lookupOf() }) });
    await expect(tools.call('web.fetch', {}, ctx())).rejects.toThrow('web.fetch failed: needs a url');
  });

  it('DNS failure, offline and timeouts are clear errors', async () => {
    const failing: HostLookup = async () => {
      throw new Error('getaddrinfo ENOTFOUND nowhere.invalid');
    };
    await expect(fetchPage('https://nowhere.invalid/', { lookup: failing })).rejects.toThrow('could not resolve nowhere.invalid');
    await expect(fetchPage('https://down.example.com/', { fetch: fakeWeb({}).fetch, lookup: lookupOf() })).rejects.toThrow('could not reach down.example.com (offline?)');
    const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as typeof fetch;
    await expect(fetchPage('https://slow.example.com/', { fetch: hang, lookup: lookupOf(), timeoutMs: 25 })).rejects.toThrow('slow.example.com timed out after 25ms');
    await expect(fetchPage('https://gone.example.com/', { fetch: fakeWeb({ 'https://gone': () => html('x', 404) }).fetch, lookup: lookupOf() })).rejects.toThrow('HTTP 404');
  });

  it('a body that stalls mid-stream still times out', async () => {
    const stall = ((_u: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('<p>partial'));
          init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
        },
      });
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/html' } }));
    }) as typeof fetch;
    await expect(fetchPage('https://stall.example.com/', { fetch: stall, lookup: lookupOf(), timeoutMs: 25 })).rejects.toThrow('timed out after 25ms');
  });

  it('isBlockedAddress: private ranges blocked, public ones allowed', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.31.255.255', '192.168.0.1', '100.100.100.200', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fe80::abcd', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'nonsense']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('htmlToText handles entities, line breaks and odd markup', () => {
    expect(htmlToText('a&amp;b &lt;c&gt; &#x1F600; &#8217; &unknown;<br>next')).toBe('a&b <c> 😀 ’ &unknown;\nnext');
    expect(htmlToText('<SCRIPT>bad()</SCRIPT><STYLE>x{}</STYLE>ok')).toBe('ok');
  });
});

describe('v19: built in, and the chat knows to research', () => {
  it('buildTools registers web.search and web.fetch by default; tools.web false turns them off', () => {
    const on = buildTools({ version: 1 }, { env: {} });
    expect(on.has('web.search') && on.has('web.fetch')).toBe(true);
    expect(buildTools({ version: 1, tools: { web: false } }, { env: {} }).has('web.search')).toBe(false);
  });

  it('buildTools passes the injected fetch and lookup to the web tools', async () => {
    const web = fakeWeb({ 'https://docs.example.com/': () => html('<p>Docs</p>') });
    const tools = buildTools({ version: 1 }, { env: {}, fetch: web.fetch, lookup: lookupOf({ 'docs.example.com': ['10.0.0.9'] }) });
    await expect(tools.call('web.fetch', { url: 'https://docs.example.com/' }, ctx({ stage: 'execute' }))).rejects.toThrow('private or local address');
  });
});

describe('v19: decision cards', () => {
  const RESULTS: ResearchSource[] = [
    { title: 'United: New York to Denver', url: 'https://www.united.com/den', snippet: 'Nonstop, lands 2pm. From $320.' },
    { title: 'Frontier Airlines | Denver', url: 'https://flyfrontier.com/den', snippet: '1 stop, lands 7pm. From $180.', text: 'Frontier flight 1234 departs 9am, connects in Chicago, arrives 7:05pm.' },
    { title: 'Kayak', url: 'https://www.kayak.com/flights' },
  ];

  it('with a model: Option A vs B, a clear pick, why and next step, in plain chat lines', async () => {
    const anchor = { ...emptyAnchor(new Date(2026, 10, 25)), goals: [{ id: 'g', title: 'Be at the Denver offsite by 4pm Friday', priority: 'high' as const, horizon: 'week' as const, active: true }] };
    const provider = new FakeProvider([
      '```json\n{"a":{"name":"United nonstop","summary":"$320, lands 2pm","source":1},"b":{"name":"Frontier","summary":"$180, 1 stop, lands 7pm","source":2},"pick":"A","why":"Lands before your **4pm** offsite.","next":"Want me to hold the United fare?"}\n```',
    ]);
    const card = await buildDecisionCard({ question: 'Flights NYC to Denver Friday?', results: RESULTS, ai: provider, soul: 'I hate red-eyes.', anchor, constraints: ['under $400'] });
    expect(card.by).toBe('ai');
    expect(card.pick).toBe('A');
    expect(card.text).toBe(
      [
        'Flights NYC to Denver Friday?',
        'A: United nonstop, $320, lands 2pm (united.com)',
        'B: Frontier, $180, 1 stop, lands 7pm (flyfrontier.com)',
        'Pick: A. Lands before your 4pm offsite.',
        'Next: Want me to hold the United fare?',
      ].join('\n'),
    );
    const req = provider.calls[0]!;
    expect(req.json).toBe(true);
    const prompt = req.messages[0]!.content;
    expect(prompt).toContain('I hate red-eyes.');
    expect(prompt).toContain('Be at the Denver offsite by 4pm Friday');
    expect(prompt).toContain('under $400');
    expect(prompt).toContain('[2] Frontier Airlines | Denver (https://flyfrontier.com/den)');
    expect(prompt).toContain('Page: Frontier flight 1234');
  });

  it('never contains tables, headings, bold or bullets, and stays short', async () => {
    const provider = new FakeProvider(['{"a":{"name":"| Opt | A |","summary":"## big\\n- bullet **bold**","source":1},"b":{"name":"B","summary":"' + 'x'.repeat(900) + '","source":2},"pick":"b","why":"| why |","next":"`go`"}']);
    const card = await buildDecisionCard({ question: '### Which?', results: RESULTS, ai: provider });
    expect(card.pick).toBe('B');
    expect(card.text).not.toMatch(/\||\*\*|^#|^- |`/m);
    expect(card.text.length).toBeLessThanOrEqual(700);
    expect(card.text.split('\n')[0]).toBe('Which?');
  });

  it('falls back to a code card when there is no model, the reply is junk, or the call fails', async () => {
    const plain = await buildDecisionCard({ question: 'Which flight?', results: RESULTS });
    expect(plain.by).toBe('code');
    expect(plain.text).toBe(
      [
        'Which flight?',
        'A: United: New York to Denver, Nonstop, lands 2pm. From $320. (united.com)',
        'B: Frontier Airlines Denver, 1 stop, lands 7pm. From $180. (flyfrontier.com)',
        'Pick: A. Top match for what you asked; I have not compared the details yet.',
        'Next: Open https://www.united.com/den to confirm, or ask me to dig into B.',
      ].join('\n'),
    );
    expect((await buildDecisionCard({ question: 'q', results: RESULTS, ai: new FakeProvider(['I think A is nice']) })).by).toBe('code');
    const broken = { complete: async () => Promise.reject(new Error('quota')) };
    expect((await buildDecisionCard({ question: 'q', results: RESULTS, ai: broken })).by).toBe('code');
  });

  it('no results: an honest card and no model call', async () => {
    const provider = new FakeProvider([]);
    const card = await buildDecisionCard({ question: 'Best tent?', results: [], ai: provider });
    expect(card.options).toEqual([]);
    expect(card.pick).toBeUndefined();
    expect(card.text).toBe("Best tent?\nCouldn't find anything solid on that yet.\nNext: Want me to try a different search?");
    expect(provider.calls).toHaveLength(0);
  });

  it('a model pick of B with only one option falls back to A; unknown source numbers get no link', async () => {
    const card = await buildDecisionCard({ question: 'q', results: RESULTS, ai: new FakeProvider(['{"a":{"name":"Only","summary":"s","source":9},"pick":"B","why":"w","next":"n"}']) });
    expect(card.options).toEqual([{ name: 'Only', summary: 's' }]);
    expect(card.pick).toBe('A');
    expect(formatDecisionCard(card)).toBe('q\nA: Only, s\nPick: A. w\nNext: n');
  });
});
