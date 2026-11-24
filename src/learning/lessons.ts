import { newId, type FileStore } from '../store';
import type { LessonLayer } from './layers';

/** Scope strings: `global`, `flow:<id>`, `role:<name>`. */
export const scopes = {
  global: 'global',
  flow: (id: string) => `flow:${id}`,
  role: (name: string) => `role:${name}`,
};

/** Most active (non-hardened) lessons one scope may hold before it must be consolidated. */
export const MAX_LESSONS_PER_SCOPE = 7;

export interface Lesson {
  id: string;
  scope: string;
  rule: string;
  /** Which layer should own this rule. Default `principle` (a line in the prompt). */
  layer: LessonLayer;
  /** How many times a human has given this same correction. */
  count: number;
  sourceRunIds: string[];
  /** True once the rule has been turned into a code validator. */
  hardened: boolean;
  createdAt: string;
  updatedAt: string;
  /** Last time this lesson was injected into a `ctx.ai` prompt. Absent if it never was. */
  lastUsedAt?: string;
}

export interface LessonStoreOptions {
  /** Default 7. */
  maxLessonsPerScope?: number;
}

interface LessonsFile {
  version: 1;
  lessons: Lesson[];
}

export const normalizeRule = (rule: string) =>
  rule.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!]+$/g, '').trim();

/** Does a lesson in `scope` apply to this flow/role? */
export function lessonApplies(scope: string, q: { flowId?: string; role?: string }): boolean {
  return (
    scope === scopes.global ||
    (q.flowId !== undefined && scope === scopes.flow(q.flowId)) ||
    (q.role !== undefined && scope === scopes.role(q.role))
  );
}

/** Most repeated first, then oldest. */
export const byPriority = (a: Lesson, b: Lesson) => b.count - a.count || a.createdAt.localeCompare(b.createdAt);

/** Thrown when a brand-new lesson would push a scope past its cap. Tells the caller what to do instead. */
export class LessonCapError extends Error {
  constructor(
    readonly scope: string,
    readonly cap: number,
    readonly lessons: Lesson[],
  ) {
    super(
      [
        `Scope "${scope}" already has ${lessons.length} active lessons (cap ${cap}). Do not keep appending rules.`,
        'Current lessons:',
        ...lessons.map((l) => `  ${l.id}  x${l.count}  [${l.layer}]  ${l.rule}`),
        'Instead: consolidate several into one sharper principle (lessons.consolidate), turn an exact rule into a code',
        '`verify` check and mark it hardened (lessons.markHardened), or prune stale ones (lessons.prune).',
      ].join('\n'),
    );
    this.name = 'LessonCapError';
  }
}

/**
 * The hardening loop: Human corrects -> lesson saved -> injected into future AI prompts ->
 * when it keeps recurring, `candidatesForCode()` says "turn this into a code validator".
 * A per-scope cap stops the pile from growing forever: new lessons must replace, not accumulate.
 */
export class LessonStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly maxLessonsPerScope: number;

  constructor(
    private readonly store: FileStore,
    opts: LessonStoreOptions = {},
  ) {
    const cap = opts.maxLessonsPerScope ?? MAX_LESSONS_PER_SCOPE;
    if (!Number.isInteger(cap) || cap < 1) throw new Error('maxLessonsPerScope must be a whole number of at least 1.');
    this.maxLessonsPerScope = cap;
  }

  /** Serialize read-modify-write cycles within this process. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<LessonsFile> {
    const file = await this.store.readJson<LessonsFile>(this.store.lessonsFile, { version: 1, lessons: [] });
    // Older files have no `layer`.
    for (const l of file.lessons) l.layer ??= 'principle';
    return file;
  }

  private write(file: LessonsFile): Promise<void> {
    return this.store.writeJson(this.store.lessonsFile, file);
  }

  async all(): Promise<Lesson[]> {
    return (await this.read()).lessons;
  }

  private active(file: LessonsFile, scope: string): Lesson[] {
    return file.lessons.filter((l) => l.scope === scope && !l.hardened);
  }

  private assertRoomIn(file: LessonsFile, scope: string, rule: string): void {
    if (file.lessons.some((l) => l.scope === scope && normalizeRule(l.rule) === normalizeRule(rule))) return;
    const active = this.active(file, scope);
    if (active.length >= this.maxLessonsPerScope) throw new LessonCapError(scope, this.maxLessonsPerScope, active);
  }

  /** Throws `LessonCapError` if this rule would be a new lesson in a full scope. A repeat of an existing rule is fine. */
  async assertRoom(scope: string, rule: string): Promise<void> {
    this.assertRoomIn(await this.read(), scope, rule);
  }

  /**
   * Saves a lesson. The same rule in the same scope bumps `count` instead of duplicating.
   * A brand-new lesson in a scope that is at its cap throws `LessonCapError`.
   */
  add(input: { scope: string; rule: string; layer?: LessonLayer; sourceRunId?: string }): Promise<Lesson> {
    const rule = input.rule.trim();
    if (!rule) throw new Error('A lesson needs a non-empty rule.');
    return this.serial(async () => {
      const file = await this.read();
      const now = new Date().toISOString();
      let lesson = file.lessons.find((l) => l.scope === input.scope && normalizeRule(l.rule) === normalizeRule(rule));
      if (lesson) {
        lesson.count += 1;
        lesson.updatedAt = now;
        if (input.sourceRunId && !lesson.sourceRunIds.includes(input.sourceRunId)) {
          lesson.sourceRunIds.push(input.sourceRunId);
        }
      } else {
        this.assertRoomIn(file, input.scope, rule);
        lesson = {
          id: newId('l'),
          scope: input.scope,
          rule,
          layer: input.layer ?? 'principle',
          count: 1,
          sourceRunIds: input.sourceRunId ? [input.sourceRunId] : [],
          hardened: false,
          createdAt: now,
          updatedAt: now,
        };
        file.lessons.push(lesson);
      }
      await this.write(file);
      return lesson;
    });
  }

  /**
   * Atomically replace several messy or overlapping lessons in one scope with a single sharper principle.
   * The new lesson keeps their combined `count`, sources and oldest `createdAt`.
   */
  async consolidate(
    scope: string,
    input: { replaceIds: string[]; replacementRule: string; layer?: LessonLayer },
  ): Promise<Lesson> {
    const rule = input.replacementRule.trim();
    if (!rule) throw new Error('A replacement needs a non-empty rule.');
    const ids = [...new Set(input.replaceIds)];
    if (!ids.length) throw new Error('consolidate needs at least one lesson id to replace.');
    return this.serial(async () => {
      const file = await this.read();
      const old = ids.map((id) => {
        const l = file.lessons.find((x) => x.id === id);
        if (!l) throw new Error(`No lesson with id "${id}".`);
        if (l.scope !== scope) throw new Error(`Lesson "${id}" is in scope "${l.scope}", not "${scope}".`);
        if (l.hardened) throw new Error(`Lesson "${id}" is already enforced by code; leave it alone.`);
        return l;
      });
      const clash = file.lessons.find(
        (l) => l.scope === scope && !ids.includes(l.id) && normalizeRule(l.rule) === normalizeRule(rule),
      );
      if (clash) throw new Error(`Lesson "${clash.id}" already says that. Add its id to replaceIds to merge into it.`);

      const now = new Date().toISOString();
      const used = old.map((l) => l.lastUsedAt).filter((d): d is string => !!d).sort();
      const merged: Lesson = {
        id: newId('l'),
        scope,
        rule,
        layer: input.layer ?? 'principle',
        count: old.reduce((n, l) => n + l.count, 0),
        sourceRunIds: [...new Set(old.flatMap((l) => l.sourceRunIds))],
        hardened: false,
        createdAt: old.map((l) => l.createdAt).sort()[0]!,
        updatedAt: now,
        ...(used.length ? { lastUsedAt: used.at(-1)! } : {}),
      };
      file.lessons = [...file.lessons.filter((l) => !ids.includes(l.id)), merged];
      await this.write(file);
      return merged;
    });
  }

  /**
   * Remove stale lessons. Hardened lessons are never touched.
   * - `olderThanDays`: drop one-off lessons (count 1) not injected or updated in that many days.
   *   Recurring ones (count 2+) stay: they are candidates for code.
   * - `maxUnused`: per scope, keep at most this many lessons that were never injected (highest count first).
   * With neither option, `olderThanDays` defaults to 30.
   */
  async prune(opts: { olderThanDays?: number; maxUnused?: number } = {}): Promise<Lesson[]> {
    const { olderThanDays, maxUnused } = opts;
    const days = olderThanDays ?? (maxUnused === undefined ? 30 : undefined);
    if (days !== undefined && !(days >= 0)) throw new Error('olderThanDays must be 0 or more.');
    if (maxUnused !== undefined && !(maxUnused >= 0)) throw new Error('maxUnused must be 0 or more.');
    return this.serial(async () => {
      const file = await this.read();
      const removed = new Set<string>();

      if (days !== undefined) {
        const cutoff = Date.now() - days * 86_400_000;
        for (const l of file.lessons) {
          const lastActive = Date.parse(l.lastUsedAt ?? l.updatedAt);
          if (!l.hardened && l.count < 2 && lastActive < cutoff) removed.add(l.id);
        }
      }
      if (maxUnused !== undefined) {
        const byScope = new Map<string, Lesson[]>();
        for (const l of file.lessons) {
          if (l.hardened || l.lastUsedAt || removed.has(l.id)) continue;
          byScope.set(l.scope, [...(byScope.get(l.scope) ?? []), l]);
        }
        for (const group of byScope.values()) {
          group
            .sort((a, b) => b.count - a.count || b.updatedAt.localeCompare(a.updatedAt))
            .slice(maxUnused)
            .forEach((l) => removed.add(l.id));
        }
      }

      const gone = file.lessons.filter((l) => removed.has(l.id));
      if (gone.length) {
        file.lessons = file.lessons.filter((l) => !removed.has(l.id));
        await this.write(file);
      }
      return gone;
    });
  }

  /** Stamp lessons as just used (injected into an AI prompt), so `prune` knows which ones matter. */
  markUsed(ids: string[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    return this.serial(async () => {
      const file = await this.read();
      const now = new Date().toISOString();
      let changed = false;
      for (const l of file.lessons) {
        if (ids.includes(l.id)) {
          l.lastUsedAt = now;
          changed = true;
        }
      }
      if (changed) await this.write(file);
    });
  }

  /** Lessons that apply to a flow/role: `global`, `flow:<id>`, `role:<name>`. Most repeated first. */
  async forScope(q: { flowId?: string; role?: string }): Promise<Lesson[]> {
    return (await this.all()).filter((l) => lessonApplies(l.scope, q)).sort(byPriority);
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
      await this.write(file);
      return lesson;
    });
  }
}
