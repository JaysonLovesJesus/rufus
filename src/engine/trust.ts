import path from 'node:path';
import { FileStore } from '../store';

/**
 * Earned Trust: every kind of action (`reply.chat`, `schedule.block`, ...) starts at `check` - it does the work from
 * Day 1, but a human verifies the result. Clean approvals build a streak; after `promotionThreshold` in a row Rufus
 * *suggests* working on its own. Only the human promotes. A rejection of an autonomous action demotes it immediately.
 * Stored in `<workspace>/trust.json`.
 *
 * v21, the Graduated Autonomy Ladder:
 *   blocked      never runs (the human said no to this kind of action entirely)
 *   check        does the work, a human verifies every result (the default, and where everything starts)
 *   auto_notify  runs on its own and tells you right away what it just did ("reply 'undo' or 'demote'")
 *   autonomous   runs on its own, quietly (still in the audit ledger)
 * Any rejection or complaint on `auto_notify` / `autonomous` drops it straight back to `check` with a zero streak.
 * A global kill switch (`pauseAutonomy`) makes every non-blocked action `check` until `resumeAutonomy`.
 * Money and logins never auto-run, whatever the rung. External actions (a send, a reaction) only auto-run once the
 * human explicitly put them on the v21 ladder (`coversExternal`); a pre-v21 `autonomous` record keeps asking for them.
 */

/** The v21 ladder, lowest to highest. */
export type TrustMode = 'blocked' | 'check' | 'auto_notify' | 'autonomous';
export const TRUST_MODES: readonly TrustMode[] = ['blocked', 'check', 'auto_notify', 'autonomous'];
/** The pre-v21 name, kept: same values. */
export type Autonomy = TrustMode;
export const isTrustMode = (v: unknown): v is TrustMode => typeof v === 'string' && (TRUST_MODES as readonly string[]).includes(v);
/** True for the rungs that run without a per-run yes. */
export const actsOnItsOwn = (m: TrustMode): boolean => m === 'auto_notify' || m === 'autonomous';
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
  /**
   * v21: earned trust also covers this action's external step (a send, a reaction). Set only by an explicit v21
   * promotion (`setTrustMode`, `promote(..., mode)`, `rufus trust promote --mode`); `auto_notify` always implies it.
   * Cleared by any demotion. Never covers money or logins.
   */
  coversExternal?: boolean;
  /** v21: user complaints recorded against this action ("stop doing that"). */
  complaints?: number;
}

export interface TrustFile {
  version: 1;
  actions: Record<string, TrustRecord>;
  /** v21 kill switch: while true, every non-blocked action is `check`. */
  paused?: boolean;
  pausedAt?: string;
  pauseReason?: string;
}

export interface FeedbackResult {
  record: TrustRecord;
  /** True when this approval is the one that reached the threshold. */
  promotionNewlySuggested: boolean;
  /** True when a rejection moved an `auto_notify` / `autonomous` action back to `check`. */
  demoted: boolean;
  /** v21: the rung before this verdict. */
  previousMode?: TrustMode;
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
export function promotionMessage(r: Pick<TrustRecord, 'actionType' | 'consecutiveClean'> & { autonomy?: TrustMode }): string {
  if (r.autonomy === 'auto_notify')
    return `${r.actionType} has run on its own ${r.consecutiveClean} times in a row without a complaint - want me to stop telling you each time? (rufus trust promote ${r.actionType} --mode autonomous)`;
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
    const autonomy: TrustMode = isTrustMode(r.autonomy) ? r.autonomy : 'check';
    return {
      actionType,
      autonomy,
      accepted: count(r.accepted),
      edited: count(r.edited),
      rejected: count(r.rejected),
      consecutiveClean: count(r.consecutiveClean),
      promotionThreshold: count(r.promotionThreshold) || this.threshold,
      promotionSuggested: r.promotionSuggested === true && (autonomy === 'check' || autonomy === 'auto_notify'),
      lastUpdated: typeof r.lastUpdated === 'string' ? r.lastUpdated : base.lastUpdated,
      ...(typeof r.lastNote === 'string' && r.lastNote ? { lastNote: r.lastNote } : {}),
      ...(r.coversExternal === true && actsOnItsOwn(autonomy) ? { coversExternal: true } : {}),
      ...(count(r.complaints) ? { complaints: count(r.complaints) } : {}),
    };
  }

  async load(): Promise<TrustFile> {
    const raw = await this.fs.readJson<Partial<TrustFile>>(this.file, { version: 1, actions: {} });
    const actions: Record<string, TrustRecord> = {};
    for (const [k, v] of Object.entries(raw.actions ?? {})) if (ACTION_TYPE.test(k)) actions[k] = this.normalize(k, v);
    const out: TrustFile = { version: 1, actions };
    if (raw.paused === true) {
      out.paused = true;
      if (typeof raw.pausedAt === 'string') out.pausedAt = raw.pausedAt;
      if (typeof raw.pauseReason === 'string' && raw.pauseReason.trim()) out.pauseReason = raw.pauseReason;
    }
    return out;
  }

  /** v21: true while the global kill switch is on. */
  async isPaused(): Promise<boolean> {
    return (await this.load()).paused === true;
  }

  /**
   * v21: the rung that actually applies right now. `blocked` stays blocked; while autonomy is paused everything else is
   * `check`; otherwise the record's own rung (an unseen action type is `check`).
   */
  async mode(actionType: string): Promise<TrustMode> {
    const t = assertActionType(actionType);
    const file = await this.load();
    const own = file.actions[t]?.autonomy ?? 'check';
    if (own === 'blocked') return 'blocked';
    return file.paused ? 'check' : own;
  }

  /** v21 kill switch: nothing runs on its own until `resume()`. Records stay as they are (resume restores them). */
  async pause(reason?: string): Promise<TrustFile> {
    return this.mutateFile((file) => {
      file.paused = true;
      file.pausedAt = this.now().toISOString();
      if (reason?.trim()) file.pauseReason = reason.trim();
      else delete file.pauseReason;
    });
  }

  /** v21: lifts the kill switch; every action is back on its own rung. */
  async resume(): Promise<TrustFile> {
    return this.mutateFile((file) => {
      delete file.paused;
      delete file.pausedAt;
      delete file.pauseReason;
    });
  }

  private mutateFile(change: (f: TrustFile) => void): Promise<TrustFile> {
    const run = this.queue.then(async () => {
      const file = await this.load();
      change(file);
      await this.fs.writeJson(this.file, file);
      return file;
    });
    this.queue = run.catch(() => undefined);
    return run;
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
   *  - accept: +1 accepted and +1 to the clean streak; at the threshold (at `check` or `auto_notify`) a promotion is suggested.
   *  - edit:   +1 edited; the streak resets and any suggestion is withdrawn.
   *  - reject: +1 rejected; the streak resets, any suggestion is withdrawn, and an `auto_notify` / `autonomous` action
   *            goes straight back to `check`.
   */
  async recordFeedback(actionType: string, verdict: Verdict, note?: string): Promise<FeedbackResult> {
    if (!['accept', 'edit', 'reject'].includes(verdict)) throw new Error(`verdict must be accept, edit or reject (got ${JSON.stringify(verdict)}).`);
    const { record, out } = await this.update(actionType, (r) => {
      let promotionNewlySuggested = false;
      let demoted = false;
      const previousMode = r.autonomy;
      if (verdict === 'accept') {
        r.accepted++;
        r.consecutiveClean++;
        if ((r.autonomy === 'check' || r.autonomy === 'auto_notify') && r.consecutiveClean >= r.promotionThreshold) {
          promotionNewlySuggested = !r.promotionSuggested;
          r.promotionSuggested = true;
        }
      } else {
        if (verdict === 'edit') r.edited++;
        else r.rejected++;
        r.consecutiveClean = 0;
        r.promotionSuggested = false;
        if (verdict === 'reject' && actsOnItsOwn(r.autonomy)) {
          r.autonomy = 'check';
          delete r.coversExternal;
          demoted = true;
        }
      }
      if (note?.trim()) r.lastNote = note.trim();
      return { promotionNewlySuggested, demoted, previousMode };
    });
    return { record, ...out };
  }

  /**
   * v21: an `auto_notify` run went out and nobody complained (yet). +1 to the clean streak (not to `accepted`: no human
   * looked at it); at the threshold Rufus suggests going fully `autonomous`. A later complaint still demotes it.
   */
  async recordAutoRun(actionType: string): Promise<FeedbackResult> {
    const { record, out } = await this.update(actionType, (r) => {
      let promotionNewlySuggested = false;
      r.consecutiveClean++;
      if (r.autonomy === 'auto_notify' && r.consecutiveClean >= r.promotionThreshold) {
        promotionNewlySuggested = !r.promotionSuggested;
        r.promotionSuggested = true;
      }
      return { promotionNewlySuggested, demoted: false, previousMode: r.autonomy };
    });
    return { record, ...out };
  }

  /**
   * v21: the human complained about this action ("stop doing that", "don't react to my mom"). Like a rejection: the
   * streak resets, and `auto_notify` / `autonomous` drops straight back to `check`.
   */
  async recordComplaint(actionType: string, note?: string): Promise<FeedbackResult> {
    const { record, out } = await this.update(actionType, (r) => {
      const previousMode = r.autonomy;
      r.complaints = (r.complaints ?? 0) + 1;
      r.consecutiveClean = 0;
      r.promotionSuggested = false;
      let demoted = false;
      if (actsOnItsOwn(r.autonomy)) {
        r.autonomy = 'check';
        delete r.coversExternal;
        demoted = true;
      }
      if (note?.trim()) r.lastNote = note.trim();
      return { promotionNewlySuggested: false, demoted, previousMode };
    });
    return { record, ...out };
  }

  /**
   * The human says: stop checking with me on this one.
   *  - no `mode` (pre-v21): `autonomous` for internal results only; external sends, money and logins still ask.
   *  - an explicit v21 `mode` (`auto_notify` | `autonomous`): that rung, and it covers the action's external step too.
   */
  async promote(actionType: string, mode?: 'auto_notify' | 'autonomous'): Promise<TrustRecord> {
    if (mode !== undefined && mode !== 'auto_notify' && mode !== 'autonomous') throw new Error(`mode must be auto_notify or autonomous (got ${JSON.stringify(mode)}).`);
    return (
      await this.update(actionType, (r) => {
        r.autonomy = mode ?? 'autonomous';
        r.promotionSuggested = false;
        if (mode) r.coversExternal = true;
      })
    ).record;
  }

  /** Back to `check`: every result is verified by a human again, and the streak starts over. */
  async demote(actionType: string): Promise<TrustRecord> {
    return this.setMode(actionType, 'check');
  }

  /**
   * v21: puts an action on one exact rung. Going up (to `auto_notify` / `autonomous`) is an explicit human promotion and
   * covers the action's external step; `check` or `blocked` resets the streak and clears it.
   */
  async setMode(actionType: string, mode: TrustMode): Promise<TrustRecord> {
    if (!isTrustMode(mode)) throw new Error(`mode must be one of ${TRUST_MODES.join(', ')} (got ${JSON.stringify(mode)}).`);
    return (
      await this.update(actionType, (r) => {
        r.autonomy = mode;
        r.promotionSuggested = false;
        if (actsOnItsOwn(mode)) r.coversExternal = true;
        else {
          r.consecutiveClean = 0;
          delete r.coversExternal;
        }
      })
    ).record;
  }

  /** How many clean approvals in a row before a promotion is suggested for this action type. */
  async setThreshold(actionType: string, threshold: number): Promise<TrustRecord> {
    if (!(Number.isInteger(threshold) && threshold > 0)) throw new Error('The threshold must be a whole number above 0.');
    return (
      await this.update(actionType, (r) => {
        r.promotionThreshold = threshold;
        r.promotionSuggested = (r.autonomy === 'check' || r.autonomy === 'auto_notify') && r.consecutiveClean >= threshold;
      })
    ).record;
  }
}

/** One line per action type, for `rufus trust`. v21: with `paused`, a first line says the kill switch is on. */
export function formatTrust(records: TrustRecord[], opts: { paused?: boolean; pauseReason?: string } = {}): string[] {
  const head = opts.paused ? [`Autonomy is PAUSED${opts.pauseReason ? ` (${opts.pauseReason})` : ''}: every action asks you first. rufus trust resume lifts it.`] : [];
  if (!records.length) return [...head, 'No trust recorded yet. Every action starts at "check": it works from Day 1, and you verify each result.'];
  const lines = records.map(
    (r) =>
      `${r.actionType}  ${r.autonomy}${r.coversExternal && actsOnItsOwn(r.autonomy) ? ' (incl. external)' : ''}  accepted ${r.accepted} · edited ${r.edited} · rejected ${r.rejected} · clean streak ${r.consecutiveClean}/${r.promotionThreshold}`,
  );
  for (const r of records) if (r.promotionSuggested) lines.push(promotionMessage(r));
  return [...head, ...lines];
}

// ---------- v21 helpers by workspace ----------

/** v21 kill switch: from now on every non-blocked action is `check`. */
export async function pauseAutonomy(dir: string, reason?: string): Promise<TrustFile> {
  return new TrustStore(dir).pause(reason);
}

/** v21: lifts the kill switch. */
export async function resumeAutonomy(dir: string): Promise<TrustFile> {
  return new TrustStore(dir).resume();
}

/** v21: one action back to `check` (streak 0). */
export async function demoteAction(dir: string, action: string): Promise<TrustRecord> {
  return new TrustStore(dir).demote(action);
}

/** v21: one action on an exact rung. */
export async function setTrustMode(dir: string, action: string, mode: TrustMode): Promise<TrustRecord> {
  return new TrustStore(dir).setMode(action, mode);
}

/** v21: the rung that applies right now (the kill switch makes everything but `blocked` a `check`). */
export async function trustMode(dir: string, action: string): Promise<TrustMode> {
  return new TrustStore(dir).mode(action);
}
