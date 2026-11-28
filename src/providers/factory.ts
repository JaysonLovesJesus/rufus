import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelProvider } from '../types';
import { ClaudeCliProvider } from './claude';
import { CreditTracker } from './credits';
import { FallbackProvider } from './fallback';
import { GeminiCliProvider } from './gemini';
import { LocalLlamaProvider, findLocalLlmModel } from './local';

export interface ProvidersConfig {
  /** Fast Decide loop (runs every turn). Defaults to Haiku -> Gemini -> Local. */
  reasoning?: string[];
  /** Deep specialist brains (brain.investigate / plan / create / verify). Defaults to Opus -> Gemini -> Local. */
  brain?: string[];
  speaker?: string[];
  triage?: string[];
}

function hasBin(bin: string, fallbackPath?: string): boolean {
  if (fallbackPath && existsSync(fallbackPath)) return true;
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildOne(spec: string, opts: { workspaceDir: string; timeoutMs?: number; effort?: string }): ModelProvider | undefined {
  const s = spec.trim();
  if (!s) return undefined;
  if (s === 'claude' || s.startsWith('claude:')) {
    const model = s.includes(':') ? s.split(':').slice(1).join(':') : 'opus';
    return new ClaudeCliProvider({
      model,
      cwd: opts.workspaceDir,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
    });
  }
  if (s === 'gemini' || s.startsWith('gemini:')) {
    if (!hasBin('gemini', '/opt/homebrew/bin/gemini')) return undefined;
    const model = s.includes(':') ? s.split(':').slice(1).join(':') : undefined;
    return new GeminiCliProvider({
      ...(model ? { model } : {}),
      cwd: opts.workspaceDir,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }
  if (s === 'local' || s.startsWith('local:')) {
    if (!hasBin('llama-cli', '/opt/homebrew/bin/llama-cli')) return undefined;
    const explicit = s.includes(':') ? s.split(':').slice(1).join(':') : undefined;
    const modelPath = explicit && existsSync(explicit) ? explicit : findLocalLlmModel(opts.workspaceDir);
    if (!modelPath) return undefined;
    return new LocalLlamaProvider({
      modelPath,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }
  return undefined;
}

/**
 * Builds the 4-lane configurable provider chains:
 * - reasoning (fast Decide loop, every turn): Haiku -> Gemini CLI -> Local
 * - brain (deep specialists: plan, create, verify, investigate): Opus -> Gemini CLI -> Local
 * - speaker (owner messages): Haiku -> Gemini CLI -> Local
 * - triage (cheap wake filter): Haiku -> Gemini CLI -> Local
 * Reads optional `providers` from `<workspaceDir>/config.json` so any user can pick their own stack.
 */
export function buildProviderSet(opts: { workspaceDir: string; credits?: CreditTracker }): {
  reasoning: FallbackProvider;
  brain: FallbackProvider;
  speaker: FallbackProvider;
  triage: FallbackProvider;
  credits: CreditTracker;
} {
  const credits = opts.credits ?? new CreditTracker(opts.workspaceDir);
  let cfg: ProvidersConfig = {};
  try {
    const raw = JSON.parse(readFileSync(path.join(opts.workspaceDir, 'config.json'), 'utf8')) as { providers?: ProvidersConfig };
    if (raw?.providers) cfg = raw.providers;
  } catch {
    /* default stack */
  }

  const reasoningSpecs = cfg.reasoning ?? [
    `claude:${process.env.RUFUS_DECIDE_MODEL || process.env.RUFUS_REASONING_MODEL || 'sonnet'}`,
    'gemini',
    'local',
  ];
  const brainSpecs = cfg.brain ?? [
    `claude:${process.env.RUFUS_BRAIN_MODEL || 'opus'}`,
    'gemini',
    'local',
  ];
  const speakerSpecs = cfg.speaker ?? [
    `claude:${process.env.RUFUS_SPEAKER_MODEL || 'haiku'}`,
    'gemini',
    'local',
  ];
  const triageSpecs = cfg.triage ?? [
    `claude:${process.env.RUFUS_TRIAGE_MODEL || 'haiku'}`,
    'gemini',
    'local',
  ];

  const makeChain = (specs: string[], extra: { timeoutMs?: number; effort?: string } = {}): FallbackProvider => {
    const providers = specs.map((sp) => buildOne(sp, { workspaceDir: opts.workspaceDir, ...extra })).filter((p): p is ModelProvider => !!p);
    if (!providers.length) {
      providers.push(new ClaudeCliProvider({ model: 'opus', cwd: opts.workspaceDir }));
    }
    return new FallbackProvider({ chain: providers, credits });
  };

  return {
    reasoning: makeChain(reasoningSpecs),
    brain: makeChain(brainSpecs),
    speaker: makeChain(speakerSpecs, { timeoutMs: 45_000, effort: 'low' }),
    triage: makeChain(triageSpecs, { timeoutMs: 45_000 }),
    credits,
  };
}
