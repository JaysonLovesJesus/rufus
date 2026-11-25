import { formatExamples, type ReplayCase } from '../learning/cases';
import type { Lesson } from '../learning/lessons';
import type { AiMessage, AiProvider, AiStepOptions } from '../types';

export class AiVerificationError extends Error {
  constructor(
    readonly step: string,
    readonly reason: string,
    readonly attempts: number,
    readonly lastOutput: string,
  ) {
    super(`AI step "${step}" failed verification after ${attempts} attempt(s): ${reason}`);
    this.name = 'AiVerificationError';
  }
}

export function buildSystemPrompt(role: string | undefined, lessons: Lesson[], examples: ReplayCase[] = []): string {
  const parts = ['You are a careful assistant inside a workflow engine. Follow the instructions exactly.'];
  if (role) parts.push(`Your role: ${role}.`);
  if (lessons.length) {
    parts.push(
      'Lessons learned from earlier human corrections. Always follow them:',
      ...lessons.slice(0, 20).map((l) => `- ${l.rule}`),
    );
  }
  const block = formatExamples(examples);
  if (block) parts.push(block);
  return parts.join('\n');
}

function buildUserPrompt(prompt: string, context: unknown): string {
  if (context === undefined) return prompt;
  return `${prompt}\n\nContext (exact data gathered by code):\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;
}

/** Ask, verify with code, and on failure feed the exact reason back and retry. */
export async function runAiStep<T>(args: {
  provider: AiProvider;
  system: string;
  step: string;
  opts: AiStepOptions<T>;
  meta: { runId: string; flowId: string };
}): Promise<{ value: T; attempts: number }> {
  const { provider, system, step, opts, meta } = args;
  const maxRetries = opts.maxRetries ?? 2;
  const messages: AiMessage[] = [{ role: 'user', content: buildUserPrompt(opts.prompt, opts.context) }];

  let lastOutput = '';
  let reason = '';
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    lastOutput = await provider.complete({
      system,
      messages: messages.map((m) => ({ ...m })),
      model: opts.model,
      ...(opts.json ? { json: true } : {}),
      meta: { ...meta, step, attempt },
    });

    let value: T | undefined;
    let verdict: { ok: true } | { ok: false; reason: string };
    try {
      value = opts.parse ? opts.parse(lastOutput) : (lastOutput as unknown as T);
      verdict = opts.verify ? await opts.verify(value) : { ok: true };
    } catch (err) {
      verdict = { ok: false, reason: `Could not parse the output: ${(err as Error).message}` };
    }
    if (verdict.ok) return { value: value as T, attempts: attempt };

    reason = verdict.reason;
    messages.push(
      { role: 'assistant', content: lastOutput },
      { role: 'user', content: `Your answer failed an automatic check: ${reason}\nFix exactly that and answer again.` },
    );
  }
  throw new AiVerificationError(step, reason, maxRetries + 1, lastOutput);
}
