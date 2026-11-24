import type { Engine } from '../engine/engine';
import { suggestLayer, type LessonLayer } from './layers';
import type { Lesson } from './lessons';
import { parseScope, replayScope, type ScopedReplayOptions, type ScopedReplayReport } from './replay';

export interface ProposeInput {
  scope: string;
  rule: string;
  /** Which layer should own the rule. Default `principle`. */
  layer?: LessonLayer;
  sourceRunId?: string;
}

export interface ProposeOptions extends Omit<ScopedReplayOptions, 'withLessons'> {
  /** Save the lesson even if it broke previously passing cases. */
  force?: boolean;
}

export type ProposeResult =
  | {
      accepted: true;
      lesson: Lesson;
      suggestedLayer: { layer: LessonLayer; reason: string };
      report: ScopedReplayReport;
    }
  | {
      accepted: false;
      reason: string;
      suggestedLayer: { layer: LessonLayer; reason: string };
      report: ScopedReplayReport;
    };

/**
 * The replay regression gate. A lesson is a change to every future prompt in its scope, so test it first:
 * replay the scope with the candidate temporarily active (in memory only; `lessons.json` is untouched),
 * and save it only if no previously passing case now fails.
 *
 * Throws `LessonCapError` up front if the scope is full, before spending any AI calls.
 * The gate measures what `verify` can check. With no saved cases, nothing is measured (see `report.total`).
 */
export async function proposeLesson(engine: Engine, input: ProposeInput, opts: ProposeOptions = {}): Promise<ProposeResult> {
  const rule = input.rule.trim();
  if (!rule) throw new Error('A lesson needs a non-empty rule.');
  parseScope(input.scope);
  const suggestedLayer = suggestLayer(rule);

  await engine.lessons.assertRoom(input.scope, rule);

  const { force, ...replayOpts } = opts;
  const now = new Date().toISOString();
  const candidate: Lesson = {
    id: 'candidate',
    scope: input.scope,
    rule,
    layer: input.layer ?? 'principle',
    count: 1,
    sourceRunIds: [],
    hardened: false,
    createdAt: now,
    updatedAt: now,
  };
  const report = await replayScope(engine, input.scope, { ...replayOpts, withLessons: [candidate] });

  if (report.regressed > 0 && !force) {
    const broken = report.flows.flatMap((f) =>
      f.results.filter((r) => r.change === 'regressed').map((r) => `  ${f.flowId} ${r.caseId} (${r.stepName}): ${r.reason}`),
    );
    return {
      accepted: false,
      suggestedLayer,
      report,
      reason: [
        `Rejected: this lesson broke ${report.regressed} case(s) that passed before. Nothing was saved.`,
        ...broken,
        'Reword the rule, or enforce it in code, or pass force to save it anyway.',
      ].join('\n'),
    };
  }

  const lesson = await engine.lessons.add({
    scope: input.scope,
    rule,
    layer: input.layer,
    sourceRunId: input.sourceRunId,
  });
  return { accepted: true, lesson, suggestedLayer, report };
}
