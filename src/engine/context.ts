import { newId, type FileStore } from '../store';
import type { LessonStore } from '../learning/lessons';
import { buildSystemPrompt, runAiStep } from './ai';
import type {
  AiProvider,
  AiStepOptions,
  Flow,
  FlowContext,
  HumanAnswer,
  HumanCard,
  HumanOption,
  HumanStepSpec,
  RunRecord,
  StepRecord,
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
  provider: AiProvider;
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

  ai(name: string, opts: AiStepOptions<string> & { parse?: undefined }): Promise<string>;
  ai<T>(name: string, opts: AiStepOptions<T> & { parse: (raw: string) => T }): Promise<T>;
  async ai(name: string, opts: AiStepOptions<any>): Promise<any> {
    const key = this.keyFor('ai', name);
    const cached = this.run.steps[key];
    if (cached?.done) return cached.result;

    const { meta } = this.flow;
    const lessons = await this.deps.lessons.forScope({ flowId: meta.id, role: meta.role });
    const { value, attempts } = await runAiStep({
      provider: this.deps.provider,
      system: buildSystemPrompt(meta.role, lessons),
      step: name,
      opts,
      meta: { runId: this.run.id, flowId: meta.id },
    });
    const result = toJson(value);
    this.run.steps[key] = { kind: 'ai', name, done: true, result, attempts };
    await this.deps.store.saveRun(this.run);
    return result;
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
