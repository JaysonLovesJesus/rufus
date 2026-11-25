// Native Google Gemini provider: plain `fetch` against the Generative Language API, zero dependencies.
// The API key travels in the `x-goog-api-key` header, never in the URL, so it cannot leak into logs or error text.
import type { AiProvider, AiRequest } from '../types';

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
export const GEMINI_DEFAULT_API_KEY_ENV = 'GEMINI_API_KEY';
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiConfig {
  model?: string;
  /** The key itself. Prefer `apiKeyEnv`: a key in config.json is easy to commit by accident. */
  apiKey?: string;
  /** Environment variable holding the key (default `GEMINI_API_KEY`). */
  apiKeyEnv?: string;
  baseUrl?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Abort the request after this many milliseconds (default 120000). */
  timeoutMs?: number;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/** Remove anything that looks like the configured key (or a Google API key) from text that may reach a log or the user. */
function scrub(text: string, key: string | undefined): string {
  let out = text;
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]');
}

export class GeminiProvider implements AiProvider {
  constructor(
    private readonly cfg: GeminiConfig = {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  private apiKey(): string | undefined {
    return this.cfg.apiKey || this.env[this.cfg.apiKeyEnv ?? GEMINI_DEFAULT_API_KEY_ENV] || undefined;
  }

  async complete(req: AiRequest): Promise<string> {
    const key = this.apiKey();
    if (!key) {
      throw new Error(`Gemini API key missing: set the ${this.cfg.apiKeyEnv ?? GEMINI_DEFAULT_API_KEY_ENV} environment variable (or "apiKey" in the provider config).`);
    }
    const model = req.model ?? this.cfg.model ?? GEMINI_DEFAULT_MODEL;
    const base = (this.cfg.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;

    const generationConfig: Record<string, unknown> = {};
    if (this.cfg.temperature !== undefined) generationConfig.temperature = this.cfg.temperature;
    if (this.cfg.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = this.cfg.maxOutputTokens;
    if (req.json) generationConfig.responseMimeType = 'application/json';

    const body = {
      ...(req.system.trim() ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    };

    const controller = new AbortController();
    const timeoutMs = this.cfg.timeoutMs ?? 120_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Gemini request timed out after ${timeoutMs}ms.`);
      throw new Error(`Gemini request failed: ${scrub((err as Error).message ?? String(err), key)}`);
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text();
    let data: GeminiResponse = {};
    try {
      data = raw ? (JSON.parse(raw) as GeminiResponse) : {};
    } catch {
      // keep going: a non-JSON body is reported below
    }
    if (!res.ok) {
      const detail = data.error?.message ?? raw.slice(0, 200);
      throw new Error(`Gemini request failed: ${res.status} ${scrub(detail, key).slice(0, 300)}`.trim());
    }
    if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}.`);
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
    if (!text) {
      throw new Error(`Gemini response had no text${candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : ''}.`);
    }
    return text;
  }
}
