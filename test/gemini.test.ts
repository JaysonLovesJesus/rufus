import { describe, expect, it } from 'vitest';
import { Engine, FakeProvider, GeminiProvider, createProvider, createProviders, defineFlow, type AiRequest } from '../src';
import { tempDir } from './helpers';

const req = (over: Partial<AiRequest> = {}): AiRequest => ({
  system: 'You are terse.',
  messages: [{ role: 'user', content: 'Say hi.' }],
  meta: { runId: 'r', flowId: 'f', step: 's', attempt: 1 },
  ...over,
});

interface Seen {
  url: string;
  init: RequestInit;
  body: any;
}

function fakeFetch(reply: { status?: number; body: unknown }): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, seen };
}

const ok = (text: string) => ({ body: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } });
const SECRET = 'AIzaSyFAKE_KEY_0123456789abcdefghij';

describe('gemini provider', () => {
  it('posts to models/<model>:generateContent with the key in x-goog-api-key, never in the URL', async () => {
    const { fetch, seen } = fakeFetch(ok('hi there'));
    const p = new GeminiProvider({ apiKey: SECRET }, fetch);
    expect(await p.complete(req())).toBe('hi there');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(seen[0]!.url).not.toContain(SECRET);
    expect(seen[0]!.url).not.toContain('key=');
    expect((seen[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe(SECRET);
    expect(seen[0]!.init.method).toBe('POST');
  });

  it('maps system -> systemInstruction, messages -> contents (assistant -> model), and omits generationConfig by default', async () => {
    const { fetch, seen } = fakeFetch(ok('x'));
    await new GeminiProvider({ apiKey: 'k' }, fetch).complete(
      req({ messages: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }] }),
    );
    expect(seen[0]!.body.systemInstruction).toEqual({ parts: [{ text: 'You are terse.' }] });
    expect(seen[0]!.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Q1' }] },
      { role: 'model', parts: [{ text: 'A1' }] },
      { role: 'user', parts: [{ text: 'Q2' }] },
    ]);
    expect(seen[0]!.body.generationConfig).toBeUndefined();
  });

  it('json: true turns on responseMimeType application/json; temperature and maxOutputTokens pass through', async () => {
    const { fetch, seen } = fakeFetch(ok('{"a":1}'));
    const p = new GeminiProvider({ apiKey: 'k', temperature: 0.2, maxOutputTokens: 512 }, fetch);
    await p.complete(req({ json: true }));
    expect(seen[0]!.body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 512, responseMimeType: 'application/json' });
    await p.complete(req());
    expect(seen[1]!.body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 512 });
  });

  it('honors model, baseUrl and a per-request model override; reads the key from apiKeyEnv', async () => {
    const { fetch, seen } = fakeFetch(ok('x'));
    const env = { MY_GEMINI: 'env-key' };
    const p = new GeminiProvider({ model: 'gemini-2.5-pro', baseUrl: 'https://proxy.example.org/v1beta/', apiKeyEnv: 'MY_GEMINI' }, fetch, env);
    await p.complete(req());
    expect(seen[0]!.url).toBe('https://proxy.example.org/v1beta/models/gemini-2.5-pro:generateContent');
    expect((seen[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('env-key');
    await p.complete(req({ model: 'gemini-2.5-flash-lite' }));
    expect(seen[1]!.url).toContain('/models/gemini-2.5-flash-lite:generateContent');
  });

  it('defaults the key variable to GEMINI_API_KEY', async () => {
    const { fetch, seen } = fakeFetch(ok('x'));
    await new GeminiProvider({}, fetch, { GEMINI_API_KEY: 'default-env' }).complete(req());
    expect((seen[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('default-env');
  });

  it('joins text parts, skips thought parts', async () => {
    const { fetch } = fakeFetch({ body: { candidates: [{ content: { parts: [{ text: 'secret thinking', thought: true }, { text: 'Hello ' }, { text: 'world' }] } }] } });
    expect(await new GeminiProvider({ apiKey: 'k' }, fetch).complete(req())).toBe('Hello world');
  });

  it('fails clearly with no key, without calling the network', async () => {
    const { fetch, seen } = fakeFetch(ok('x'));
    await expect(new GeminiProvider({}, fetch, {}).complete(req())).rejects.toThrow(/GEMINI_API_KEY/);
    expect(seen).toHaveLength(0);
  });

  it('turns HTTP errors into clear messages that never echo the key', async () => {
    const { fetch } = fakeFetch({ status: 400, body: { error: { message: `API key not valid: ${SECRET}. Please pass a valid API key.`, status: 'INVALID_ARGUMENT' } } });
    const err = await new GeminiProvider({ apiKey: SECRET }, fetch).complete(req()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Gemini request failed: 400/);
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).not.toContain('AIza');
  });

  it('scrubs the key from network errors, and reports blocked prompts and empty candidates', async () => {
    const boom = (async () => {
      throw new Error(`connect failed for https://x/?key=${SECRET}`);
    }) as typeof fetch;
    const err = await new GeminiProvider({ apiKey: SECRET }, boom).complete(req()).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Gemini request failed/);
    expect((err as Error).message).not.toContain(SECRET);

    const blocked = fakeFetch({ body: { promptFeedback: { blockReason: 'SAFETY' } } });
    await expect(new GeminiProvider({ apiKey: 'k' }, blocked.fetch).complete(req())).rejects.toThrow(/blocked the prompt: SAFETY/);
    const empty = fakeFetch({ body: { candidates: [{ finishReason: 'MAX_TOKENS' }] } });
    await expect(new GeminiProvider({ apiKey: 'k' }, empty.fetch).complete(req())).rejects.toThrow(/no text \(finishReason: MAX_TOKENS\)/);
    const html = fakeFetch({ status: 502, body: '<html>bad gateway</html>' });
    await expect(new GeminiProvider({ apiKey: 'k' }, html.fetch).complete(req())).rejects.toThrow(/502/);
  });

  it('times out with a clear message', async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
    await expect(new GeminiProvider({ apiKey: 'k', timeoutMs: 20 }, hang).complete(req())).rejects.toThrow(/timed out after 20ms/);
  });
});

describe('gemini config wiring', () => {
  it('createProvider builds a GeminiProvider from { type: "gemini" }', () => {
    expect(createProvider({ type: 'gemini' })).toBeInstanceOf(GeminiProvider);
  });

  it('a config.json with gemini fast + smart builds both, and each step reaches its own model', async () => {
    const cfg = {
      version: 1,
      provider: { type: 'gemini' },
      providers: { fast: { type: 'gemini', model: 'gemini-2.5-flash' }, smart: { type: 'gemini', model: 'gemini-2.5-pro' } },
    };
    const built = createProviders(cfg as never);
    expect(built.provider).toBeInstanceOf(GeminiProvider);
    expect(Object.keys(built.providers).sort()).toEqual(['fast', 'smart']);

    const urls: string[] = [];
    const f = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }));
    }) as typeof fetch;
    const mk = (model: string) => new GeminiProvider({ model, apiKey: 'k' }, f);
    const flow = defineFlow({ id: 'g', name: 'G', description: 'tiers' }, async (ctx) => {
      await ctx.ai('phrase', { prompt: 'p', tier: 'fast' });
      await ctx.ai('judge', { prompt: 'p', tier: 'smart' });
      return 'ok';
    });
    const dir = await tempDir();
    const engine = new Engine({ store: dir, providers: { fast: mk('gemini-2.5-flash'), smart: mk('gemini-2.5-pro') }, provider: new FakeProvider([]), flows: [flow] });
    expect(await engine.start('g')).toMatchObject({ status: 'completed' });
    expect(urls[0]).toContain('models/gemini-2.5-flash:');
    expect(urls[1]).toContain('models/gemini-2.5-pro:');
  });

  it('ai steps with json: true reach the provider as a JSON request', async () => {
    const seen: AiRequest[] = [];
    const fake = new FakeProvider((r) => (seen.push(r), '{}'));
    const dir = await tempDir();
    const flow = defineFlow({ id: 'j', name: 'J', description: 'json' }, async (ctx) => ctx.ai('a', { prompt: 'p', json: true }));
    await new Engine({ store: dir, provider: fake, flows: [flow] }).start('j');
    expect(seen[0]!.json).toBe(true);
  });
});
