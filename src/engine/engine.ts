import { FileStore } from '../store';
import { LessonStore, scopes } from '../learning/lessons';
import type { ChannelAdapter } from '../channels/text';
import { StepRunner } from './context';
import type {
  AiProvider,
  Flow,
  HumanAnswer,
  HumanCard,
  HumanReply,
  RunRecord,
  RunResult,
} from '../types';

export interface EngineOptions {
  /** A FileStore, or a workspace directory. */
  store: FileStore | string;
  /** Needed only if a flow uses `ctx.ai`. */
  provider?: AiProvider;
  flows?: Flow[];
  /** If set, new human cards are sent through it as soon as a run pauses. */
  channel?: ChannelAdapter;
}

const noProvider: AiProvider = {
  async complete() {
    throw new Error('No AI provider configured. Pass `provider` to Engine (or set "provider" in config.json).');
  },
};

export class Engine {
  readonly store: FileStore;
  readonly lessons: LessonStore;
  private readonly flows = new Map<string, Flow>();
  private readonly provider: AiProvider;
  private readonly channel?: ChannelAdapter;
  private ready?: Promise<void>;

  constructor(opts: EngineOptions) {
    this.store = typeof opts.store === 'string' ? new FileStore(opts.store) : opts.store;
    this.lessons = new LessonStore(this.store);
    this.provider = opts.provider ?? noProvider;
    this.channel = opts.channel;
    this.register(...(opts.flows ?? []));
  }

  register(...flows: Flow[]): this {
    for (const f of flows) this.flows.set(f.meta.id, f);
    return this;
  }

  listFlows(): Flow[] {
    return [...this.flows.values()];
  }

  private init(): Promise<void> {
    return (this.ready ??= this.store.init());
  }

  private flow(id: string): Flow {
    const flow = this.flows.get(id);
    if (!flow) throw new Error(`Flow "${id}" is not registered.`);
    return flow;
  }

  /** Start a new run. Resolves when the flow finishes, fails, or pauses for a human. */
  async start<I>(flowId: string, input?: I): Promise<RunResult> {
    const flow = this.flow(flowId);
    await this.init();
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      flowId,
      status: 'running',
      input: input ?? null,
      steps: {},
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveRun(run);
    return this.execute(run, flow);
  }

  /** Re-run a run from its saved steps (e.g. after a crash or a failed step). */
  async resume(runId: string): Promise<RunResult> {
    await this.init();
    const run = await this.store.getRun(runId);
    if (run.status === 'completed') return { status: 'completed', runId, output: run.output };
    if (run.status === 'waiting_human') {
      const card = Object.values(run.steps).find((s) => s.card?.id === run.pendingCardId)?.card;
      if (card) return { status: 'waiting_human', runId, card };
    }
    return this.execute(run, this.flow(run.flowId));
  }

  /** Cards waiting for a human, oldest first. */
  async pending(): Promise<HumanCard[]> {
    await this.init();
    const cards: HumanCard[] = [];
    for (const run of await this.store.listRuns()) {
      if (run.status !== 'waiting_human') continue;
      const card = Object.values(run.steps).find((s) => s.card?.id === run.pendingCardId)?.card;
      if (card) cards.push(card);
    }
    return cards;
  }

  /** Answer a pending card (full id or unique prefix) and run the flow to its next stop. */
  async answer(cardRef: string, reply: HumanReply): Promise<RunResult> {
    await this.init();
    const run = await this.store.findRunByCard(cardRef);
    const flow = this.flow(run.flowId);
    const [key, step] = Object.entries(run.steps).find(([, s]) => s.card?.id === run.pendingCardId)!;
    const card = step.card!;
    const answer = validateReply(card, reply);

    step.done = true;
    step.result = answer;
    run.status = 'running';
    delete run.pendingCardId;
    run.steps[key] = step;
    await this.store.saveRun(run);

    if (reply.lesson) {
      const l = typeof reply.lesson === 'string' ? { rule: reply.lesson } : reply.lesson;
      await this.lessons.add({
        scope: l.scope ?? scopes.flow(run.flowId),
        rule: l.rule,
        sourceRunId: run.id,
      });
    }
    return this.execute(run, flow);
  }

  private async execute(run: RunRecord, flow: Flow): Promise<RunResult> {
    const runner = new StepRunner(
      { store: this.store, lessons: this.lessons, provider: this.provider },
      run,
      flow,
    );
    run.status = 'running';
    let output: unknown;
    let thrown: unknown;
    let threw = false;
    try {
      output = await flow.run(runner);
    } catch (err) {
      thrown = err;
      threw = true;
    }

    let result: RunResult;
    // If a human step paused the run, that wins even if the flow caught the pause signal.
    if (runner.paused) {
      run.status = 'waiting_human';
      run.pendingCardId = runner.paused.id;
      result = { status: 'waiting_human', runId: run.id, card: runner.paused };
    } else if (threw) {
      run.status = 'failed';
      run.error = thrown instanceof Error ? thrown.message : String(thrown);
      result = { status: 'failed', runId: run.id, error: run.error };
    } else {
      run.status = 'completed';
      run.output = output ?? null;
      delete run.error;
      result = { status: 'completed', runId: run.id, output: run.output };
    }
    await this.store.saveRun(run);
    // The run is already safely saved; a channel hiccup must not lose it.
    if (result.status === 'waiting_human' && runner.cardIsNew) await this.channel?.sendCard(result.card);
    return result;
  }
}

function validateReply(card: HumanCard, reply: HumanReply): HumanAnswer {
  const text = reply.text?.trim() || undefined;
  let option;
  if (reply.choice !== undefined) {
    const c = reply.choice.trim().toLowerCase();
    option = card.options.find((o) => o.id.toLowerCase() === c || o.label.toLowerCase() === c);
    if (!option && /^\d+$/.test(c)) option = card.options[Number(c) - 1];
    if (!option) {
      throw new Error(`"${reply.choice}" is not one of: ${card.options.map((o) => o.id).join(', ') || '(no options)'}.`);
    }
  }
  if (!option && !text) throw new Error('An answer needs a choice or some text.');
  if (text && !card.allowFreeText) throw new Error('This card only accepts one of its options.');
  return {
    ...(option ? { choice: option.id, choiceLabel: option.label } : {}),
    ...(text ? { text } : {}),
    answeredAt: new Date().toISOString(),
  };
}
