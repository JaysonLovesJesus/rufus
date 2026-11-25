import { newId, type FileStore } from '../store';
import { recallMemory, type CaseStore } from '../learning/cases';
import type { LessonStore } from '../learning/lessons';
import { AiVerificationError, buildSystemPrompt, runAiStep } from './ai';
import { pickProvider } from './providers';
import { tierOfName } from './spectrum';
import type {
  AiProvider,
  AiStepOptions,
  EscalateOptions,
  EscalateResult,
  Flow,
  FlowContext,
  HumanAnswer,
  HumanCard,
  HumanOption,
  HumanStepSpec,
  RunRecord,
  StepRecord,
  Tier,
} from '../types';

/** Thrown by `ctx.human` to unwind the flow while it waits. Don't swallow it. */
export class PauseSignal extends Error {
  constructor(readonly card: HumanCard) {
    super('Run paused: waiting for a human.');
    this.name = 'PauseSignal';
  }
}

/** Round-trip through JSON so first run and replay always see identical values. */
function toJson<T>(value: T): T {
  return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as T;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'option';

export function normalizeOptions(options: HumanStepSpec['options']): HumanOption[] {
  const used = new Set<string>();
  return (options ?? []).map((o) => {
    const spec = typeof o === 'string' ? { label: o } : o;
    let id = spec.id ?? slug(spec.label);
    for (let n = 2; used.has(id); n++) id = `${spec.id ?? slug(spec.label)}-${n}`;
    used.add(id);
    return { id, label: spec.label, ...(spec.description ? { description: spec.description } : {}) };
  });
}

export interface RunnerDeps {
  store: FileStore;
  lessons: LessonStore;
  cases: CaseStore;
  /** Resolves a provider name (undefined = default). Throws on an unknown name. */
  providerFor(name?: string): AiProvider;
  /** The provider configured under `providers.fast` / `providers.smart`, or undefined if that tier is not set up. */
  tierFor(tier: Tier): AiProvider | undefined;
}

/** Executes one pass of a flow, replaying finished steps from the run record. */
export class StepRunner<I = unknown> implements FlowContext<I> {
  readonly runId: string;
  readonly input: I;
  /** Set when the flow hit an unanswered human step. */
  paused?: HumanCard;
  /** True only if the paused card was created during this pass (so a channel should send it). */
  cardIsNew = false;
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly deps: RunnerDeps,
    private readonly run: RunRecord,
    private readonly flow: Flow,
  ) {
    this.runId = run.id;
    this.input = run.input as I;
  }

  /** `kind:name`, with `#2`, `#3`... for repeats of the same name (e.g. in loops). */
  private keyFor(kind: StepRecord['kind'], name: string): string {
    if (this.paused) throw new PauseSignal(this.paused);
    const base = `${kind}:${name}`;
    const n = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  }

  async code<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const key = this.keyFor('code', name);
    const cached = this.run.steps[key];
    if (cached?.done) return cached.result as T;

    const result = toJson(await fn());
    this.run.steps[key] = { kind: 'code', name, done: true, result };
    await this.deps.store.saveRun(this.run);
    return result;
  }

  /** Provider for a step: an explicit `provider` name, else its `tier` (if configured), else the flow's or the default provider. */
  private route(o: { provider?: string; tier?: Tier }): AiProvider {
    return pickProvider({ ...o, flowProvider: this.flow.meta.provider }, this.deps);
  }

  /** The rung an ai step counts as: its tier, a provider literally named `fast`/`smart`, else `smart`. */
  private rungOf(o: { provider?: string; tier?: Tier }): Tier {
    return o.tier ?? tierOfName(o.provider ?? this.flow.meta.provider) ?? 'smart';
  }

  /** Lessons and examples for this step, stamped as used. Shared by `ai` and `escalate`. */
  private async recall(name: string, includeExamples: AiStepOptions['includeExamples']): Promise<string> {
    const { meta } = this.flow;
    const { lessons, examples } = await recallMemory(this.deps, { flowId: meta.id, role: meta.role, stepName: name, includeExamples });
    // Remember which lessons actually reach a prompt, so `lessons.prune` keeps the ones that matter.
    await this.deps.lessons.markUsed(lessons.map((l) => l.id));
    return buildSystemPrompt(meta.role, lessons, examples);
  }

  ai(name: string, opts: AiStepOptions<string> & { parse?: undefined }): Promise<string>;
  ai<T>(name: string, opts: AiStepOptions<T> & { parse: (raw: string) => T }): Promise<T>;
  async ai(name: string, opts: AiStepOptions<any>): Promise<any> {
    const key = this.keyFor('ai', name);
    const cached = this.run.steps[key];
    if (cached?.done) return cached.result;

    const { value, attempts } = await runAiStep({
      provider: this.route(opts),
      system: await this.recall(name, opts.includeExamples),
      step: name,
      opts,
      meta: { runId: this.run.id, flowId: this.flow.meta.id },
    });
    const result = toJson(value);
    this.run.steps[key] = { kind: 'ai', name, done: true, result, attempts, rung: this.rungOf(opts) };
    await this.deps.store.saveRun(this.run);
    return result;
  }

  escalate(name: string, opts: EscalateOptions<string> & { parse?: undefined }): Promise<EscalateResult<string>>;
  escalate<T>(name: string, opts: EscalateOptions<T> & { parse: (raw: string) => T }): Promise<EscalateResult<T>>;
  async escalate(name: string, opts: EscalateOptions<any>): Promise<EscalateResult<any>> {
    const key = this.keyFor('ai', name);
    if (!this.run.steps[key]?.done) await this.climb(key, name, opts);
    const rec = this.run.steps[key]!;

    if (rec.handoff) {
      const spec = typeof opts.human === 'function' ? opts.human(rec.handoff) : opts.human;
      if (!spec) throw new AiVerificationError(name, rec.handoff.reason, rec.attempts ?? 0, rec.handoff.lastOutput);
      const answer = await this.human(name, spec);
      return { rung: 'human', answer, reason: rec.handoff.reason };
    }
    return { rung: rec.rung ?? 'smart', value: rec.result, attempts: rec.attempts ?? 1 };
  }

  /** Try `fast`, then `smart`, saving the outcome (a result, or a handoff to a human) as this step's record. */
  private async climb(key: string, name: string, opts: EscalateOptions<any>): Promise<void> {
    const { fast, smart, human, ...base } = opts;
    const meta = { runId: this.run.id, flowId: this.flow.meta.id };
    const system = await this.recall(name, opts.includeExamples);
    const fastProvider = this.route({ provider: fast?.provider, tier: 'fast' });
    const smartProvider = this.route({ provider: smart?.provider, tier: 'smart' });
    // With no separate fast model (tier not configured), climbing would only ask the same model twice.
    const distinct = fastProvider !== smartProvider || fast?.model !== smart?.model;

    let attempts = 0;
    let failure: AiVerificationError | undefined;
    const attempt = async (rung: Tier, provider: AiProvider, r: typeof fast, retries: number) => {
      try {
        const out = await runAiStep({ provider, system, step: name, opts: { ...base, model: r?.model, maxRetries: r?.maxRetries ?? retries }, meta });
        attempts += out.attempts;
        return { value: out.value, rung };
      } catch (err) {
        if (!(err instanceof AiVerificationError)) throw err;
        attempts += err.attempts;
        failure = err;
        return undefined;
      }
    };

    const won = (distinct ? await attempt('fast', fastProvider, fast, 1) : undefined) ?? (await attempt('smart', smartProvider, smart, 2));
    if (won) {
      this.run.steps[key] = { kind: 'ai', name, done: true, result: toJson(won.value), attempts, rung: won.rung, ...(distinct && won.rung === 'smart' ? { escalated: true } : {}) };
    } else {
      const f = failure!;
      if (!human) throw new AiVerificationError(name, f.reason, attempts, f.lastOutput);
      this.run.steps[key] = { kind: 'ai', name, done: true, result: null, attempts, escalated: true, handoff: { reason: f.reason, lastOutput: f.lastOutput } };
    }
    await this.deps.store.saveRun(this.run);
  }

  async human(name: string, spec: HumanStepSpec): Promise<HumanAnswer> {
    const key = this.keyFor('human', name);
    const existing = this.run.steps[key];
    if (existing?.done) return existing.result as HumanAnswer;

    let card = existing?.card;
    if (!card) {
      const options = normalizeOptions(spec.options);
      const allowFreeText = spec.allowFreeText ?? true;
      if (!options.length && !allowFreeText) {
        throw new Error(`Human step "${name}" needs options or allowFreeText.`);
      }
      card = {
        id: newId('c'),
        runId: this.run.id,
        flowId: this.flow.meta.id,
        step: name,
        title: spec.title,
        summary: spec.summary,
        ...(spec.details ? { details: spec.details } : {}),
        options,
        allowFreeText,
        createdAt: new Date().toISOString(),
      };
      this.run.steps[key] = { kind: 'human', name, done: false, card };
      this.run.status = 'waiting_human';
      this.run.pendingCardId = card.id;
      await this.deps.store.saveRun(this.run);
      this.cardIsNew = true;
    }
    this.paused = card;
    throw new PauseSignal(card);
  }
}
