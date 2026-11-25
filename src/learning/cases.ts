import { newId, type FileStore } from '../store';
import type { Lesson, LessonStore } from './lessons';
import type { HumanAnswer, HumanCard, RunRecord } from '../types';

/** Examples shown to the model per `ctx.ai` call unless `includeExamples` says otherwise. */
export const DEFAULT_EXAMPLES = 3;

/**
 * One human review of one AI draft, saved automatically when `engine.answer()` resolves a card.
 * Used two ways: as a short "how the human responded before" block in later prompts, and as a test
 * case for `replayFlow` (re-run today's flow against it in seconds).
 */
export interface ReplayCase {
  id: string;
  flowId: string;
  /** The run it came from. Replay reads that run's saved code results, so nothing re-executes. */
  runId: string;
  at: string;
  input: unknown;
  /** Key of the ai step in the run, e.g. `ai:draft` or `ai:draft#2` in a loop. */
  stepKey: string;
  /** Name of the ai step whose draft the human reviewed. */
  stepName: string;
  aiDraft: unknown;
  /** The option label the human picked, if any. */
  humanChoice: string | null;
  humanText: string | null;
  /** True when the human wrote their own words. */
  edited: boolean;
  /**
   * Set on cases made by `rufus seed` from real history instead of a live run. There is no original run:
   * `input` is the incoming message, `humanText` is what the human actually answered, and replay re-runs the
   * flow's `ctx.code` steps on that input (nothing was saved to reuse).
   */
  seeded?: true;
}

interface CasesFile {
  version: 1;
  cases: ReplayCase[];
}

/** Builds a case from a just-answered card: the draft is the latest finished ai step before it. */
export function captureCase(run: RunRecord, card: HumanCard, answer: HumanAnswer): ReplayCase | null {
  let draft: { key: string; name: string; result: unknown } | undefined;
  for (const [key, step] of Object.entries(run.steps)) {
    if (step.card?.id === card.id) break;
    if (step.kind === 'ai' && step.done) draft = { key, name: step.name, result: step.result };
  }
  if (!draft) return null; // a human step with no AI draft before it has nothing to learn from
  return {
    id: newId('case'),
    flowId: run.flowId,
    runId: run.id,
    at: answer.answeredAt,
    input: run.input,
    stepKey: draft.key,
    stepName: draft.name,
    aiDraft: draft.result,
    humanChoice: answer.choiceLabel ?? answer.choice ?? null,
    humanText: answer.text ?? null,
    edited: answer.text !== undefined,
  };
}

/** Plain JSON files: `cases/<flowId>.json`, oldest first. */
export class CaseStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: FileStore) {}

  async forFlow(flowId: string): Promise<ReplayCase[]> {
    return (await this.store.readJson<CasesFile>(this.store.casesFile(flowId), { version: 1, cases: [] })).cases;
  }

  add(c: ReplayCase): Promise<ReplayCase> {
    const next = this.queue.then(async () => {
      const cases = await this.forFlow(c.flowId);
      cases.push(c);
      await this.store.writeJson(this.store.casesFile(c.flowId), { version: 1, cases } satisfies CasesFile);
      return c;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Add many cases at once (one atomic write), skipping ids that already exist, and keep the file oldest first.
   * Returns how many were new.
   */
  addMany(flowId: string, incoming: ReplayCase[]): Promise<number> {
    const next = this.queue.then(async () => {
      const cases = await this.forFlow(flowId);
      const have = new Set(cases.map((c) => c.id));
      const fresh = incoming.filter((c) => !have.has(c.id) && have.add(c.id));
      if (!fresh.length) return 0;
      const merged = [...cases, ...fresh].map((c, i) => ({ c, i })).sort((a, b) => a.c.at.localeCompare(b.c.at) || a.i - b.i).map(({ c }) => c);
      await this.store.writeJson(this.store.casesFile(flowId), { version: 1, cases: merged } satisfies CasesFile);
      return fresh.length;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The most recent `limit` cases for one ai step of a flow, oldest first. */
  async recent(q: { flowId: string; stepName?: string; limit: number; excludeId?: string }): Promise<ReplayCase[]> {
    if (q.limit <= 0) return [];
    const cases = (await this.forFlow(q.flowId)).filter(
      (c) => c.id !== q.excludeId && (q.stepName === undefined || c.stepName === q.stepName),
    );
    return cases.slice(-q.limit);
  }
}

/** Everything code hands the model besides the prompt: scoped lessons + recent human reviews. */
export async function recallMemory(
  deps: { lessons: Pick<LessonStore, 'forScope'>; cases: CaseStore },
  q: {
    flowId: string;
    role?: string;
    stepName: string;
    includeExamples?: number | false;
    /** Replay leaves the case under test out, or the model would just copy its answer. */
    excludeCaseId?: string;
  },
): Promise<{ lessons: Lesson[]; examples: ReplayCase[] }> {
  const limit = q.includeExamples === false ? 0 : (q.includeExamples ?? DEFAULT_EXAMPLES);
  const [lessons, examples] = await Promise.all([
    deps.lessons.forScope({ flowId: q.flowId, role: q.role }),
    deps.cases.recent({ flowId: q.flowId, stepName: q.stepName, limit, excludeId: q.excludeCaseId }),
  ]);
  return { lessons, examples };
}

const compact = (value: unknown, max: number): string => {
  const text = (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** The small, readable block added to the system prompt. Empty string when there is nothing to show. */
export function formatExamples(cases: ReplayCase[]): string {
  if (!cases.length) return '';
  const lines = [
    'Examples of how a human responded to earlier drafts of this step (oldest first).',
    'Learn from the responses. Do not copy a draft the human rejected or rewrote.',
  ];
  cases.forEach((c, i) => {
    const reaction = [
      c.humanChoice ? `chose "${c.humanChoice}"` : '',
      c.humanText ? `wrote "${compact(c.humanText, 300)}"` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    if (c.seeded) {
      // Real history has no AI draft: show the message and what the human actually answered.
      lines.push(`Example ${i + 1}:`, `  Input: ${compact(c.input, 200)}`, `  Human replied: "${compact(c.humanText ?? '', 300)}"`);
      return;
    }
    lines.push(
      `Example ${i + 1}:`,
      `  Input: ${compact(c.input, 200)}`,
      `  Draft: ${compact(c.aiDraft, 400)}`,
      `  Human ${reaction || 'replied'}${c.edited ? ' (edited)' : ''}`,
    );
  });
  return lines.join('\n');
}
