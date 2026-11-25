import { spawn } from 'node:child_process';
import type { AiProvider, AiRequest, ProviderConfig, RufusConfig, Tier } from '../types';

type Scripted = string | ((req: AiRequest) => string | Promise<string>);

/** Deterministic provider for tests and demos. Replies with the script in order and records calls. */
export class FakeProvider implements AiProvider {
  readonly calls: AiRequest[] = [];
  constructor(private readonly script: Scripted[] | ((req: AiRequest, n: number) => string | Promise<string>)) {}

  async complete(req: AiRequest): Promise<string> {
    const n = this.calls.length;
    this.calls.push(req);
    const next = typeof this.script === 'function' ? this.script : this.script[n];
    if (next === undefined) throw new Error(`FakeProvider script ran out at call ${n + 1}.`);
    return typeof next === 'function' ? next(req, n) : next;
  }
}

/** Any OpenAI-compatible `/chat/completions` endpoint (OpenAI, OpenRouter, Ollama, vLLM, ...). */
export class OpenAiCompatibleProvider implements AiProvider {
  constructor(
    private readonly cfg: { baseUrl: string; model: string; apiKey?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(req: AiRequest): Promise<string> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model ?? this.cfg.model,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
      }),
    });
    if (!res.ok) throw new Error(`AI request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('AI response had no message content.');
    return text;
  }
}

/** Pipes the conversation to a CLI on stdin and reads stdout, e.g. `claude -p`. No shell involved. */
export class CommandProvider implements AiProvider {
  constructor(private readonly cfg: { command: string; args?: string[] }) {}

  complete(req: AiRequest): Promise<string> {
    const transcript = [
      req.system,
      ...req.messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`),
      'Assistant:',
    ].join('\n\n');
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.command, this.cfg.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(out.trim()) : reject(new Error(`${this.cfg.command} exited ${code}: ${err.slice(0, 200)}`)),
      );
      child.stdin.end(transcript);
    });
  }
}

export function createProvider(cfg: ProviderConfig | undefined): AiProvider | undefined {
  if (!cfg) return undefined;
  if (cfg.type === 'command') return new CommandProvider(cfg);
  const apiKey = process.env[cfg.apiKeyEnv ?? 'RUFUS_API_KEY'];
  return new OpenAiCompatibleProvider({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey });
}

/** The provider name that always means "the top-level `provider`". */
export const DEFAULT_PROVIDER = 'default';

/** `provider` and every entry of `providers`, built. A name missing from `providers` is not an error here, only when used. */
export function createProviders(config: Pick<RufusConfig, 'provider' | 'providers'>): {
  provider?: AiProvider;
  providers: Record<string, AiProvider>;
} {
  const providers: Record<string, AiProvider> = {};
  for (const [name, cfg] of Object.entries(config.providers ?? {})) {
    if (name === DEFAULT_PROVIDER) throw new Error(`"${DEFAULT_PROVIDER}" is reserved for the top-level "provider"; pick another name.`);
    const built = createProvider(cfg);
    if (built) providers[name] = built;
  }
  return { provider: createProvider(config.provider), providers };
}

/**
 * Which provider serves an ai step: its explicit `provider` name, else its `tier` (`providers.fast` / `providers.smart`)
 * if that tier is configured, else the flow's provider, else the default. An unconfigured tier is never an error, so a
 * flow that says `tier: 'fast'` still runs on a one-provider setup.
 */
export function pickProvider(
  o: { provider?: string; tier?: Tier; flowProvider?: string },
  from: { providerFor(name?: string): AiProvider; tierFor(tier: Tier): AiProvider | undefined },
): AiProvider {
  if (o.provider) return from.providerFor(o.provider);
  return (o.tier && from.tierFor(o.tier)) || from.providerFor(o.flowProvider);
}
