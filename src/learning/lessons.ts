import { newId, type FileStore } from '../store';

/** Scope strings: `global`, `flow:<id>`, `role:<name>`. */
export const scopes = {
  global: 'global',
  flow: (id: string) => `flow:${id}`,
  role: (name: string) => `role:${name}`,
};

export interface Lesson {
  id: string;
  scope: string;
  rule: string;
  /** How many times a human has given this same correction. */
  count: number;
  sourceRunIds: string[];
  /** True once the rule has been turned into a code validator. */
  hardened: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LessonsFile {
  version: 1;
  lessons: Lesson[];
}

const normalize = (rule: string) =>
  rule.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!]+$/g, '').trim();

/**
 * The hardening loop: Human corrects -> lesson saved -> injected into future AI prompts ->
 * when it keeps recurring, `candidatesForCode()` says "turn this into a code validator".
 */
export class LessonStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: FileStore) {}

  /** Serialize read-modify-write cycles within this process. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private read(): Promise<LessonsFile> {
    return this.store.readJson<LessonsFile>(this.store.lessonsFile, { version: 1, lessons: [] });
  }

  async all(): Promise<Lesson[]> {
    return (await this.read()).lessons;
  }

  /** Saves a lesson. The same rule in the same scope bumps `count` instead of duplicating. */
  add(input: { scope: string; rule: string; sourceRunId?: string }): Promise<Lesson> {
    const rule = input.rule.trim();
    if (!rule) throw new Error('A lesson needs a non-empty rule.');
    return this.serial(async () => {
      const file = await this.read();
      const now = new Date().toISOString();
      let lesson = file.lessons.find((l) => l.scope === input.scope && normalize(l.rule) === normalize(rule));
      if (lesson) {
        lesson.count += 1;
        lesson.updatedAt = now;
        if (input.sourceRunId && !lesson.sourceRunIds.includes(input.sourceRunId)) {
          lesson.sourceRunIds.push(input.sourceRunId);
        }
      } else {
        lesson = {
          id: newId('l'),
          scope: input.scope,
          rule,
          count: 1,
          sourceRunIds: input.sourceRunId ? [input.sourceRunId] : [],
          hardened: false,
          createdAt: now,
          updatedAt: now,
        };
        file.lessons.push(lesson);
      }
      await this.store.writeJson(this.store.lessonsFile, file);
      return lesson;
    });
  }

  /** Lessons that apply to a flow/role: `global`, `flow:<id>`, `role:<name>`. Most repeated first. */
  async forScope(q: { flowId?: string; role?: string }): Promise<Lesson[]> {
    const wanted = new Set<string>([scopes.global]);
    if (q.flowId) wanted.add(scopes.flow(q.flowId));
    if (q.role) wanted.add(scopes.role(q.role));
    return (await this.all())
      .filter((l) => wanted.has(l.scope))
      .sort((a, b) => b.count - a.count || a.createdAt.localeCompare(b.createdAt));
  }

  /** Recurring lessons not yet turned into code validators. */
  async candidatesForCode(minCount = 2): Promise<Lesson[]> {
    return (await this.all()).filter((l) => !l.hardened && l.count >= minCount);
  }

  /** Mark a lesson as now enforced by code, so it stops showing up as a candidate. */
  markHardened(id: string): Promise<Lesson> {
    return this.serial(async () => {
      const file = await this.read();
      const lesson = file.lessons.find((l) => l.id === id);
      if (!lesson) throw new Error(`No lesson with id "${id}".`);
      lesson.hardened = true;
      lesson.updatedAt = new Date().toISOString();
      await this.store.writeJson(this.store.lessonsFile, file);
      return lesson;
    });
  }
}
