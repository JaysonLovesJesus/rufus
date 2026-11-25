import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EmbeddingCache,
  GeminiEmbeddingProvider,
  HttpEmbeddingProvider,
  LocalEmbeddingProvider,
  OllamaEmbeddingProvider,
  buildSituationalContext,
  corpusEmbedItems,
  cosineSimilarity,
  createEmbeddingProvider,
  localEmbed,
  pairEmbedItems,
  queryCorpus,
  retrieveSimilarExamples,
  type CorpusItem,
  type EmbeddingProvider,
  type HistoryPair,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

/** A provider that counts what it is asked to embed. */
function counting(inner: EmbeddingProvider = new LocalEmbeddingProvider()): EmbeddingProvider & { texts: string[]; calls: number } {
  const p = {
    id: inner.id,
    dimensions: inner.dimensions,
    texts: [] as string[],
    calls: 0,
    async embed(texts: string[]) {
      p.calls++;
      p.texts.push(...texts);
      return inner.embed(texts);
    },
  };
  return p;
}

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: any;
}
function fakeFetch(reply: (seen: Seen) => unknown, status = 200): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: unknown, init?: RequestInit) => {
    const s: Seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? '{}')) };
    seen.push(s);
    return new Response(JSON.stringify(reply(s)), { status });
  }) as typeof fetch;
  return { fetch: f, seen };
}

const item = (id: string, summary: string, over: Partial<CorpusItem> = {}): CorpusItem => ({ id, source: 'file', kind: 'note', summary, timestamp: '2026-03-01T10:00:00.000Z', ...over });

describe('local embedding provider', () => {
  it('is deterministic, unit length, and offline', async () => {
    const p = new LocalEmbeddingProvider();
    const [a, b] = await p.embed(['Reschedule the dentist appointment', 'Reschedule the dentist appointment']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(256);
    expect(Math.sqrt(a!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a!, b!)).toBeCloseTo(1, 6);
    expect(localEmbed('   ').every((x) => x === 0)).toBe(true);
  });

  it('puts morphological and shared-wording neighbours above unrelated text', () => {
    const q = localEmbed('reschedule the dentist appointment');
    const near = cosineSimilarity(q, localEmbed('rescheduling my dentist appointments'));
    const far = cosineSimilarity(q, localEmbed('quarterly tax filing deadline'));
    expect(near).toBeGreaterThan(0.4);
    expect(far).toBeLessThan(0.2);
    expect(near).toBeGreaterThan(far + 0.25);
  });

  it('cosineSimilarity handles zero vectors and mismatched lengths', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1, 9);
  });
});

describe('EmbeddingCache.sync (incremental)', () => {
  it('embeds new items once, skips unchanged items on the second run, and re-embeds only what changed', async () => {
    const dir = await tempDir();
    const cache = new EmbeddingCache(path.join(dir, 'corpus', 'embeddings.jsonl'));
    const provider = counting();
    const items = [
      { id: 'a', text: 'dentist appointment next week' },
      { id: 'b', text: 'quarterly tax filing' },
    ];

    expect(await cache.sync(items, provider)).toEqual({ embedded: 2, cached: 0, total: 2 });
    expect(provider.texts).toHaveLength(2);

    expect(await cache.sync(items, provider)).toEqual({ embedded: 0, cached: 2, total: 2 });
    expect(provider.calls).toBe(1); // the second run never called the provider

    // One new item: only that one is embedded.
    const more = [...items, { id: 'c', text: 'flight to the conference' }];
    expect(await cache.sync(more, provider)).toEqual({ embedded: 1, cached: 2, total: 3 });
    expect(provider.texts.at(-1)).toBe('flight to the conference');

    // One changed text: re-embedded alone, with a new hash.
    const before = (await cache.load(provider.id)).get('a')!;
    const edited = [{ id: 'a', text: 'dentist appointment moved to friday' }, ...more.slice(1)];
    expect(await cache.sync(edited, provider)).toEqual({ embedded: 1, cached: 2, total: 3 });
    const after = (await cache.load(provider.id)).get('a')!;
    expect(after.hash).not.toBe(before.hash);
    expect(after.vector).not.toEqual(before.vector);
    expect(provider.texts.at(-1)).toBe('dentist appointment moved to friday');
  });

  it('keys vectors by { id, model, hash, vector }, one JSON line each, written atomically', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'embeddings.jsonl');
    const cache = new EmbeddingCache(file);
    await cache.sync([{ id: 'x', text: 'hello world' }], new LocalEmbeddingProvider());
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(Object.keys(row).sort()).toEqual(['hash', 'id', 'model', 'vector']);
    expect(row).toMatchObject({ id: 'x', model: 'local-hash-256' });
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.vector).toHaveLength(256);
  });

  it('re-embeds when the model changes, keeps both models, and can prune vanished items', async () => {
    const dir = await tempDir();
    const cache = new EmbeddingCache(path.join(dir, 'e.jsonl'));
    const items = [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }];
    await cache.sync(items, new LocalEmbeddingProvider(256));
    expect((await cache.sync(items, new LocalEmbeddingProvider(64))).embedded).toBe(2);
    expect(await cache.stats()).toEqual({ 'local-hash-256': 2, 'local-hash-64': 2 });
    const r = await cache.sync([items[0]!], new LocalEmbeddingProvider(256), { prune: true });
    expect(r).toEqual({ embedded: 0, cached: 1, total: 1 });
    expect(await cache.stats()).toEqual({ 'local-hash-256': 1, 'local-hash-64': 2 });
  });

  it('skips corrupt lines, ignores blank text, and saves progress when the provider fails part-way', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'e.jsonl');
    await writeFile(file, 'not json\n{"id":1}\n');
    const cache = new EmbeddingCache(file);
    expect(await cache.sync([{ id: 'blank', text: '   ' }], new LocalEmbeddingProvider())).toEqual({ embedded: 0, cached: 0, total: 0 });

    const local = new LocalEmbeddingProvider();
    let n = 0;
    const flaky: EmbeddingProvider = { id: local.id, dimensions: 256, embed: async (t) => (++n === 2 ? Promise.reject(new Error('provider down')) : local.embed(t)) };
    const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, text: `text ${id}` }));
    await expect(cache.sync(items, flaky, { chunkSize: 2 })).rejects.toThrow('provider down');
    expect((await cache.load(local.id)).size).toBe(2); // the first chunk survived
    expect(await cache.sync(items, local)).toEqual({ embedded: 2, cached: 2, total: 4 });
  });
});

describe('ollama, gemini and http embedders (mocked fetch)', () => {
  it('ollama posts to /api/embed with the model and returns unit vectors', async () => {
    const { fetch, seen } = fakeFetch((s) => ({ embeddings: s.body.input.map(() => [3, 4]) }));
    const p = new OllamaEmbeddingProvider({}, fetch);
    expect(p.id).toBe('ollama:nomic-embed-text');
    const out = await p.embed(['a', 'b']);
    expect(seen[0]!.url).toBe('http://127.0.0.1:11434/api/embed');
    expect(seen[0]!.body).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
    expect(out).toHaveLength(2);
    expect(out[0]![0]).toBeCloseTo(0.6, 9);
    expect(out[0]![1]).toBeCloseTo(0.8, 9);
    expect(p.dimensions).toBe(2);

    const custom = fakeFetch((s) => ({ embeddings: s.body.input.map(() => [1, 0]) }));
    await new OllamaEmbeddingProvider({ baseUrl: 'http://box:9999/', model: 'mxbai-embed-large' }, custom.fetch).embed(['x']);
    expect(custom.seen[0]!.url).toBe('http://box:9999/api/embed');
    expect(custom.seen[0]!.body.model).toBe('mxbai-embed-large');
  });

  it('ollama reports a vector count mismatch and HTTP errors clearly', async () => {
    const short = fakeFetch(() => ({ embeddings: [[1, 0]] }));
    await expect(new OllamaEmbeddingProvider({}, short.fetch).embed(['a', 'b'])).rejects.toThrow(/1 usable vector\(s\) for 2 text\(s\)/);
    const down = fakeFetch(() => ({ error: 'model not found' }), 404);
    await expect(new OllamaEmbeddingProvider({}, down.fetch).embed(['a'])).rejects.toThrow(/404/);
  });

  it('gemini posts batchEmbedContents with the key in x-goog-api-key only', async () => {
    const SECRET = 'AIzaSyFAKE_KEY_0123456789abcdefghij';
    const { fetch, seen } = fakeFetch((s) => ({ embeddings: s.body.requests.map(() => ({ values: [0, 5] })) }));
    const p = new GeminiEmbeddingProvider({ apiKey: SECRET }, fetch);
    const out = await p.embed(['one', 'two']);
    expect(out).toEqual([[0, 1], [0, 1]]);
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
    expect(seen[0]!.url).not.toContain(SECRET);
    expect(seen[0]!.headers['x-goog-api-key']).toBe(SECRET);
    expect(JSON.stringify(seen[0]!.body)).not.toContain(SECRET);
    expect(seen[0]!.body.requests[0]).toMatchObject({ model: 'models/gemini-embedding-001', content: { parts: [{ text: 'one' }] }, outputDimensionality: 768 });
  });

  it('gemini reads the key from the environment, fails clearly without one, and scrubs keys from errors', async () => {
    const none = fakeFetch(() => ({}));
    await expect(new GeminiEmbeddingProvider({}, none.fetch, {}).embed(['a'])).rejects.toThrow(/GEMINI_API_KEY/);
    expect(none.seen).toHaveLength(0);

    const env = fakeFetch((s) => ({ embeddings: s.body.requests.map(() => ({ values: [1] })) }));
    await new GeminiEmbeddingProvider({}, env.fetch, { GEMINI_API_KEY: 'from-env' }).embed(['a']);
    expect(env.seen[0]!.headers['x-goog-api-key']).toBe('from-env');

    const leaky = fakeFetch(() => ({ error: { message: 'bad key AIzaSyFAKE_KEY_0123456789abcdefghij' } }), 400);
    const err = await new GeminiEmbeddingProvider({ apiKey: 'AIzaSyFAKE_KEY_0123456789abcdefghij' }, leaky.fetch).embed(['a']).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/400/);
    expect((err as Error).message).not.toContain('AIza');
  });

  it('http speaks the OpenAI-compatible /embeddings shape with a bearer header', async () => {
    const { fetch, seen } = fakeFetch((s) => ({ data: s.body.input.map((_: string, index: number) => ({ index, embedding: [index + 1, 0] })).reverse() }));
    const p = new HttpEmbeddingProvider({ baseUrl: 'https://api.example.test/v1/', model: 'embed-small' }, fetch, { RUFUS_API_KEY: 'k-123' });
    const out = await p.embed(['a', 'b']);
    expect(seen[0]!.url).toBe('https://api.example.test/v1/embeddings');
    expect(seen[0]!.headers.authorization).toBe('Bearer k-123');
    expect(out).toEqual([[1, 0], [1, 0]]);
    expect(p.id).toBe('http:embed-small');
  });

  it('createEmbeddingProvider defaults to local and validates its config', () => {
    expect(createEmbeddingProvider().id).toBe('local-hash-256');
    expect(createEmbeddingProvider({ type: 'ollama' }).id).toBe('ollama:nomic-embed-text');
    expect(createEmbeddingProvider({ type: 'gemini' }).id).toBe('gemini:gemini-embedding-001:768');
    expect(() => createEmbeddingProvider({ type: 'http' })).toThrow(/baseUrl/);
    expect(() => createEmbeddingProvider({ type: 'nope' as never })).toThrow(/Unknown embedding provider/);
  });
});

describe('hybrid queryCorpus', () => {
  const items = [
    item('note-resched', 'rescheduling the dentist appointments for spring', { title: 'Dental plans' }),
    item('note-tax', 'quarterly tax filing deadline and receipts', { title: 'Taxes' }),
    item('note-trip', 'flight and hotel for the conference trip', { title: 'Travel' }),
  ];

  it('ranks by meaning and morphology when vectors are cached, where keywords alone find nothing', async () => {
    const dir = await tempDir();
    const cache = new EmbeddingCache(path.join(dir, 'e.jsonl'));
    const provider = new LocalEmbeddingProvider();
    await cache.sync(corpusEmbedItems(items), provider);

    // "reschedule the dentist visit": no exact word overlap with the dental note's "rescheduling ... appointments" besides "dentist".
    const query = 'reschedule dentist visit';
    const keywordOnly = queryCorpus(items, { query, dedupeTitles: false });
    const lookup = await cache.lookup(provider, query);
    expect(lookup).toBeDefined();
    const hybrid = queryCorpus(items, { query, embeddings: lookup, dedupeTitles: false });
    expect(hybrid[0]!.item.id).toBe('note-resched');
    expect(hybrid[0]!.similarity).toBeGreaterThan(0.1);

    // A query with no keyword in common at all: keywords miss it entirely, vectors still find it.
    const noKeyword = 'dentistry visits';
    expect(queryCorpus(items, { query: noKeyword })).toEqual([]);
    const semantic = queryCorpus(items, { query: noKeyword, embeddings: await cache.lookup(provider, noKeyword) });
    expect(semantic[0]!.item.id).toBe('note-resched');
    expect(semantic[0]!.matched).toEqual([]);
    expect(keywordOnly.length).toBeGreaterThan(0);
  });

  it('keeps the keyword-only behaviour when no embeddings are passed, and scores unembedded items by keywords alone', async () => {
    const plain = queryCorpus(items, { query: 'tax' });
    expect(plain.map((h) => h.item.id)).toEqual(['note-tax']);
    expect(plain[0]).not.toHaveProperty('similarity');

    const dir = await tempDir();
    const cache = new EmbeddingCache(path.join(dir, 'e.jsonl'));
    const provider = new LocalEmbeddingProvider();
    await cache.sync(corpusEmbedItems([items[0]!]), provider); // only one item has a vector
    const hits = queryCorpus(items, { query: 'tax', embeddings: await cache.lookup(provider, 'tax') });
    expect(hits.map((h) => h.item.id)).toContain('note-tax'); // found by keyword, no vector needed
  });

  it('still weighs recency and spreads across sources', async () => {
    const dir = await tempDir();
    const cache = new EmbeddingCache(path.join(dir, 'e.jsonl'));
    const provider = new LocalEmbeddingProvider();
    const many = [
      item('old', 'budget planning spreadsheet', { timestamp: '2025-01-01T00:00:00.000Z', title: 'Budget old' }),
      item('new', 'budget planning spreadsheet', { timestamp: '2026-03-01T00:00:00.000Z', title: 'Budget new' }),
      item('mail', 'budget planning questions from finance', { source: 'email', kind: 'received', timestamp: '2025-06-01T00:00:00.000Z', title: 'Budget mail' }),
    ];
    await cache.sync(corpusEmbedItems(many), provider);
    const hits = queryCorpus(many, { query: 'budget planning', embeddings: await cache.lookup(provider, 'budget planning'), limit: 3 });
    expect(hits[0]!.item.id).toBe('new');
    expect(hits.map((h) => h.item.source)).toContain('email');
  });
});

describe('retrieveSimilarExamples', () => {
  const pair = (id: string, sender: string, incoming: string, reply: string, at: string, channel = 'sms'): HistoryPair => ({ id, channel, sender, incoming, reply, incomingAt: at });
  const pairs: HistoryPair[] = [
    pair('p1', 'Jordan Lee', 'could we reschedule the dentist appointment to thursday?', 'thursday works', '2026-01-10T10:00:00Z'),
    pair('p2', 'Pat Kim', 'rescheduling the dentist visit again, sorry!', 'no worries, thursday is fine', '2026-02-10T10:00:00Z'),
    pair('p3', 'Jordan Lee', 'quarterly tax filing is due friday', 'on it', '2026-02-11T10:00:00Z'),
    pair('p4', 'Sam Ortiz', 'lunch tomorrow?', 'sure', '2026-02-12T10:00:00Z'),
  ];

  it('ranks the semantically and morphologically closest real exchange first when vectors are cached', async () => {
    const dir = await tempDir();
    const cache = new EmbeddingCache(path.join(dir, 'e.jsonl'));
    const provider = new LocalEmbeddingProvider();
    await cache.sync(pairEmbedItems(pairs), provider);
    const query = 'can we reschedule my dentist appointments?';
    const embeddings = await cache.lookup(provider, query);

    const found = retrieveSimilarExamples(query, pairs, { embeddings });
    expect(found.slice(0, 2).map((e) => e.id).sort()).toEqual(['p1', 'p2']);
    expect(found[0]!.similarity).toBeGreaterThan(found.find((e) => e.id === 'p3')?.similarity ?? 0);
    expect(found.at(-1)!.id).not.toBe('p1');
    expect(found[0]!.because).toEqual(expect.arrayContaining(['similar meaning']));
  });

  it('vectors rescue a paraphrase that shares no whole words', async () => {
    const dir = await tempDir();
    const cache = new EmbeddingCache(path.join(dir, 'e.jsonl'));
    const provider = new LocalEmbeddingProvider();
    await cache.sync(pairEmbedItems(pairs), provider);
    const query = 'dental checkup';
    expect(retrieveSimilarExamples(query, pairs)).toEqual([]); // no shared word, stem or prefix
    const withVectors = retrieveSimilarExamples(query, pairs, { embeddings: await cache.lookup(provider, query) });
    expect(withVectors.length).toBeGreaterThan(0);
    expect(['p1', 'p2']).toContain(withVectors[0]!.id);
  });

  it('adds contact affinity and observation recency, and returns nothing when nothing resembles the message', () => {
    // p1 and p2 both say "dentist": the newer one wins on recency, unless the message is from the older one's contact.
    const q = 'dentist';
    expect(retrieveSimilarExamples(q, pairs, { limit: 2 }).map((e) => e.id)).toEqual(['p2', 'p1']);
    const toJordan = retrieveSimilarExamples(q, pairs, { limit: 2, sender: 'Jordan Lee' });
    expect(toJordan[0]!.id).toBe('p1');
    expect(toJordan[0]!.because).toContain('same sender');
    expect(retrieveSimilarExamples('zzzz qqqq', pairs, { sender: 'Nobody' })).toEqual([]);
    expect(retrieveSimilarExamples('lunch', pairs, { channel: 'sms' })[0]).toMatchObject({ id: 'p4', channel: 'sms' });

    const twins = [pair('old', 'A', 'dinner plans?', 'old reply', '2024-01-01T00:00:00Z'), pair('new', 'A', 'dinner plans?', 'new reply', '2026-01-01T00:00:00Z')];
    expect(retrieveSimilarExamples('dinner plans?', twins).map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('drops an exchange that was saved twice', () => {
    const dup = [pair('d1', 'A', 'dinner plans?', 'sounds good', '2026-01-01T00:00:00Z'), pair('d2', 'A', 'dinner plans?', 'sounds good', '2026-01-02T00:00:00Z')];
    expect(retrieveSimilarExamples('dinner plans?', dup)).toHaveLength(1);
  });
});

describe('buildSituationalContext: example-driven learning', () => {
  const pairs: HistoryPair[] = [
    { id: 'a', channel: 'sms', sender: 'Jordan Lee', incoming: 'are we still on for coffee?', reply: 'yep, 9am', incomingAt: '2026-01-01T10:00:00Z' },
    { id: 'b', channel: 'sms', sender: 'Jordan Lee', incoming: 'did you see the invoice?', reply: 'looking now', incomingAt: '2026-01-02T10:00:00Z' },
    { id: 'c', channel: 'sms', sender: 'Pat Kim', incoming: 'could you reschedule the dentist appointment?', reply: 'done, thursday', incomingAt: '2026-01-03T10:00:00Z' },
    { id: 'd', channel: 'email', sender: 'Sam Ortiz', incoming: 'rescheduling the dentist visit?', reply: 'thursday works', incomingAt: '2026-01-04T10:00:00Z' },
  ];
  const input = { channel: 'sms', sender: 'Jordan Lee', incoming: 'can we reschedule the dentist appointment?' };

  it('is on by default (no explicit lessons) and pulls in the closest real moment even from another sender', () => {
    const on = buildSituationalContext(input, pairs, { examples: 3 });
    expect(on.examples.map((e) => e.id)).toContain('c');
    expect(on.examples.every((e) => typeof e.similarity === 'number')).toBe(true);
    const off = buildSituationalContext(input, pairs, { examples: 2, exampleDriven: false });
    expect(off.examples.every((e) => e.because[0] === 'same sender')).toBe(true);
    expect(off.examples[0]).not.toHaveProperty('similarity');
  });

  it('explicit lessons switch it off unless asked for, and nothing becomes a rule', () => {
    const lessons = [{ rule: 'Keep replies to at most 15 words.' }];
    const legacy = buildSituationalContext(input, pairs, { explicitLessons: lessons, examples: 2 });
    expect(legacy.examples.every((e) => e.because[0] === 'same sender')).toBe(true);
    const both = buildSituationalContext(input, pairs, { explicitLessons: lessons, exampleDriven: true, examples: 3 });
    expect(both.examples.map((e) => e.id)).toContain('c');
    expect(both.voiceHint).not.toMatch(/dentist/); // examples teach; the hint never turns them into text rules
  });

  it('uses cached vectors for meaning when given', async () => {
    const dir = await tempDir();
    const cache = new EmbeddingCache(path.join(dir, 'e.jsonl'));
    const provider = new LocalEmbeddingProvider();
    await cache.sync(pairEmbedItems(pairs), provider);
    const embeddings = await cache.lookup(provider, input.incoming);
    const ctx = buildSituationalContext(input, pairs, { embeddings, examples: 4 });
    const top = [...ctx.examples].sort((x, y) => (y.similarity ?? 0) - (x.similarity ?? 0))[0]!;
    expect(['c', 'd']).toContain(top.id);
  });
});

describe('rufus embed and incremental embedding on collect', () => {
  const run = async (dir: string, ...argv: string[]): Promise<string> => {
    const lines: string[] = [];
    const io = { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) };
    await main(['--dir', path.join(dir, 'ws'), ...argv], io);
    return lines.join('\n');
  };

  it('collect embeds new items, a second collect embeds nothing, `embed` is a no-op afterwards, and context uses the vectors', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'chat.jsonl');
    await writeFile(
      file,
      [
        { role: 'user', content: 'Please reschedule the dentist appointment.', timestamp: '2026-03-01T10:00:00Z', threadId: 't' },
        { role: 'user', content: 'Quarterly tax filing questions.', timestamp: '2026-03-02T10:00:00Z', threadId: 't' },
      ].map((r) => JSON.stringify(r)).join('\n'),
    );
    const first = await run(dir, 'collect', 'ai-prompts', file);
    expect(first).toMatch(/Embedded 2 new or changed item\(s\), 0 already cached \(local-hash-256\)/);
    const again = await run(dir, 'collect', 'ai-prompts', file);
    expect(again).toMatch(/Embedded 0 new or changed item\(s\), 2 already cached/);
    expect(await run(dir, 'embed')).toMatch(/Embedded 0 new or changed item\(s\); 2 already cached; 2 total/);

    const out = await run(dir, 'context', 'dentistry visits');
    expect(out).toMatch(/reschedule the dentist appointment/i);

    const stored = await readFile(path.join(dir, 'ws', 'corpus', 'embeddings.jsonl'), 'utf8');
    expect(stored.trim().split('\n')).toHaveLength(2);
  });

  it('a dry run embeds nothing, an unreachable provider never loses collected items, and a bad --provider is rejected', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'chat.jsonl');
    await writeFile(file, JSON.stringify({ role: 'user', content: 'Plan the offsite.', timestamp: '2026-03-01T10:00:00Z' }));
    await run(dir, 'collect', 'ai-prompts', file, '--dry-run');
    await expect(readFile(path.join(dir, 'ws', 'corpus', 'embeddings.jsonl'), 'utf8')).rejects.toThrow();

    expect(await run(dir, 'collect', 'ai-prompts', file)).toMatch(/Embedded 1 new/);
    await expect(run(dir, 'embed', '--provider', 'bogus')).rejects.toThrow(/--provider for embed must be/);
    await expect(run(dir, 'embed', '--provider', 'http')).rejects.toThrow(/baseUrl/);
  });

  it('collect keeps the items and only warns when the configured embedder is unreachable', async () => {
    const dir = await tempDir();
    const ws = path.join(dir, 'ws');
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'config.json'), JSON.stringify({ version: 1, embeddings: { type: 'ollama', baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 } }));
    const file = path.join(dir, 'chat.jsonl');
    await writeFile(file, JSON.stringify({ role: 'user', content: 'Plan the offsite.', timestamp: '2026-03-01T10:00:00Z' }));
    const out = await run(dir, 'collect', 'ai-prompts', file);
    expect(out).toMatch(/Added 1/);
    expect(out).toMatch(/embedding was skipped/);
    expect(await readFile(path.join(ws, 'corpus', 'items.jsonl'), 'utf8')).toContain('Plan the offsite.');
  });
});
