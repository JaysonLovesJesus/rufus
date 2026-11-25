import path from 'node:path';
import { FileStore } from '../store';

/**
 * Earned Trust: every kind of action (`reply.chat`, `schedule.block`, ...) starts at `check` - it does the work from
 * Day 1, but a human verifies the result. Clean approvals build a streak; after `promotionThreshold` in a row Rufus
 * *suggests* working on its own. Only the human promotes. A rejection of an autonomous action demotes it immediately.
 * Stored in `<workspace>/trust.json`.
 */

export type Autonomy = 'check' | 'autonomous';
export type Verdict = 'accept' | 'edit' | 'reject';

export interface TrustRecord {
  actionType: string;
  autonomy: Autonomy;
  accepted: number;
  edited: number;
  rejected: number;
  /** Approvals in a row with no edit or rejection. */
  consecutiveClean: number;
  /** Clean approvals in a row before Rufus suggests autonomy. */
  promotionThreshold: number;
  /** True once the streak reached the threshold while still at `check`. */
  promotionSuggested: boolean;
  /** ISO time of the last change. */
  lastUpdated: string;
  /** The human's last note, if any. */
  lastNote?: string;
}

export interface TrustFile {
  version: 1;
  actions: Record<string, TrustRecord>;
}

export interface FeedbackResult {
  record: TrustRecord;
  /** True when this approval is the one that reached the threshold. */
  promotionNewlySuggested: boolean;
  /** True when a rejection moved an autonomous action back to `check`. */
  demoted: boolean;
}

export const TRUST_FILE = 'trust.json';
export const DEFAULT_PROMOTION_THRESHOLD = 10;

const ACTION_TYPE = /^[a-z0-9][a-z0-9_.:-]*$/i;

export function assertActionType(actionType: string): string {
  const t = typeof actionType === 'string' ? actionType.trim() : '';
  if (!ACTION_TYPE.test(t)) throw new Error(`"${actionType}" is not an action type. Use letters, digits and dots, e.g. reply.chat.`);
  return t;
}

/** The question Rufus asks once an action has earned it. */
export function promotionMessage(r: Pick<TrustRecord, 'actionType' | 'consecutiveClean'>): string {
  return `You've approved ${r.actionType} cleanly ${r.consecutiveClean} times in a row - want me to stop checking with you? (rufus trust promote ${r.actionType})`;
}

export interface TrustStoreOptions {
  /** Default `promotionThreshold` for action types seen for the first time. Default 10. */
  promotionThreshold?: number;
  now?: () => Date;
}

export class TrustStore {
  readonly file: string;
  private readonly fs: FileStore;
  private readonly threshold: number;
  private readonly now: () => Date;
  /** Serializes writes inside this process, so two quick decisions never lose one another. */
  private queue: Promise<unknown> = Promise.resolve();

  /** `dir` is the workspace; trust lives in `<dir>/trust.json`. */
  constructor(dir: string, opts: TrustStoreOptions = {}) {
    this.fs = new FileStore(dir);
    this.file = path.join(dir, TRUST_FILE);
    const t = opts.promotionThreshold ?? DEFAULT_PROMOTION_THRESHOLD;
    if (!(Number.isInteger(t) && t > 0)) throw new Error('promotionThreshold must be a whole number above 0.');
    this.threshold = t;
    this.now = opts.now ?? (() => new Date());
  }

  private fresh(actionType: string): TrustRecord {
    return {
      actionType,
      autonomy: 'check',
      accepted: 0,
      edited: 0,
      rejected: 0,
      consecutiveClean: 0,
      promotionThreshold: this.threshold,
      promotionSuggested: false,
      lastUpdated: this.now().toISOString(),
    };
  }

  private normalize(actionType: string, raw: unknown): TrustRecord {
    const base = this.fresh(actionType);
    if (typeof raw !== 'object' || raw === null) return base;
    const r = raw as Partial<TrustRecord>;
    const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
    return {
      actionType,
      autonomy: r.autonomy === 'autonomous' ? 'autonomous' : 'check',
      accepted: count(r.accepted),
      edited: count(r.edited),
      rejected: count(r.rejected),
      consecutiveClean: count(r.consecutiveClean),
      promotionThreshold: count(r.promotionThreshold) || this.threshold,
      promotionSuggested: r.promotionSuggested === true && r.autonomy !== 'autonomous',
      lastUpdated: typeof r.lastUpdated === 'string' ? r.lastUpdated : base.lastUpdated,
      ...(typeof r.lastNote === 'string' && r.lastNote ? { lastNote: r.lastNote } : {}),
    };
  }

  async load(): Promise<TrustFile> {
    const raw = await this.fs.readJson<Partial<TrustFile>>(this.file, { version: 1, actions: {} });
    const actions: Record<string, TrustRecord> = {};
    for (const [k, v] of Object.entries(raw.actions ?? {})) if (ACTION_TYPE.test(k)) actions[k] = this.normalize(k, v);
    return { version: 1, actions };
  }

  /** Every known action type, sorted by name. */
  async all(): Promise<TrustRecord[]> {
    return Object.values((await this.load()).actions).sort((a, b) => a.actionType.localeCompare(b.actionType));
  }

  /** The record for an action type. One never seen before is `check`, with nothing recorded (and nothing is written). */
  async get(actionType: string): Promise<TrustRecord> {
    const t = assertActionType(actionType);
    return (await this.load()).actions[t] ?? this.fresh(t);
  }

  private update<T>(actionType: string, change: (r: TrustRecord) => T): Promise<{ record: TrustRecord; out: T }> {
    const t = assertActionType(actionType);
    const run = this.queue.then(async () => {
      const file = await this.load();
      const record = file.actions[t] ?? this.fresh(t);
      const out = change(record);
      record.lastUpdated = this.now().toISOString();
      file.actions[t] = record;
      await this.fs.writeJson(this.file, file);
      return { record: { ...record }, out };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * One human verdict on one result.
   *  - accept: +1 accepted and +1 to the clean streak; at the threshold (still at `check`) a promotion is suggested.
   *  - edit:   +1 edited; the streak resets and any suggestion is withdrawn.
   *  - reject: +1 rejected; the streak resets, any suggestion is withdrawn, and an autonomous action goes back to `check`.
   */
  async recordFeedback(actionType: string, verdict: Verdict, note?: string): Promise<FeedbackResult> {
    if (!['accept', 'edit', 'reject'].includes(verdict)) throw new Error(`verdict must be accept, edit or reject (got ${JSON.stringify(verdict)}).`);
    const { record, out } = await this.update(actionType, (r) => {
      let promotionNewlySuggested = false;
      let demoted = false;
      if (verdict === 'accept') {
        r.accepted++;
        r.consecutiveClean++;
        if (r.autonomy === 'check' && r.consecutiveClean >= r.promotionThreshold) {
          promotionNewlySuggested = !r.promotionSuggested;
          r.promotionSuggested = true;
        }
      } else {
        if (verdict === 'edit') r.edited++;
        else r.rejected++;
        r.consecutiveClean = 0;
        r.promotionSuggested = false;
        if (verdict === 'reject' && r.autonomy === 'autonomous') {
          r.autonomy = 'check';
          demoted = true;
        }
      }
      if (note?.trim()) r.lastNote = note.trim();
      return { promotionNewlySuggested, demoted };
    });
    return { record, ...out };
  }

  /** The human says: stop checking with me on this one. */
  async promote(actionType: string): Promise<TrustRecord> {
    return (
      await this.update(actionType, (r) => {
        r.autonomy = 'autonomous';
        r.promotionSuggested = false;
      })
    ).record;
  }

  /** Back to `check`: every result is verified by a human again, and the streak starts over. */
  async demote(actionType: string): Promise<TrustRecord> {
    return (
      await this.update(actionType, (r) => {
        r.autonomy = 'check';
        r.consecutiveClean = 0;
        r.promotionSuggested = false;
      })
    ).record;
  }

  /** How many clean approvals in a row before a promotion is suggested for this action type. */
  async setThreshold(actionType: string, threshold: number): Promise<TrustRecord> {
    if (!(Number.isInteger(threshold) && threshold > 0)) throw new Error('The threshold must be a whole number above 0.');
    return (
      await this.update(actionType, (r) => {
        r.promotionThreshold = threshold;
        r.promotionSuggested = r.autonomy === 'check' && r.consecutiveClean >= threshold;
      })
    ).record;
  }
}

/** One line per action type, for `rufus trust`. */
export function formatTrust(records: TrustRecord[]): string[] {
  if (!records.length) return ['No trust recorded yet. Every action starts at "check": it works from Day 1, and you verify each result.'];
  const lines = records.map(
    (r) =>
      `${r.actionType}  ${r.autonomy === 'autonomous' ? 'autonomous' : 'check'}  accepted ${r.accepted} · edited ${r.edited} · rejected ${r.rejected} · clean streak ${r.consecutiveClean}/${r.promotionThreshold}`,
  );
  for (const r of records) if (r.promotionSuggested) lines.push(promotionMessage(r));
  return lines;
}
