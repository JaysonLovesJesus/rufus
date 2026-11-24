import { createHash } from 'node:crypto';
import path from 'node:path';
import { ChiefOfStaff } from '../chief/chief';
import type { Engine } from '../engine/engine';
import type { HumanCard, HumanReply, RunResult } from '../types';
import { formatCardAsText, parseTextReply } from './text';

/** A message that came in from the human. Voice notes arrive as their transcript text. */
export interface IncomingMessage {
  /** Stable id, used to never handle the same message twice. */
  id: string;
  text: string;
  /** ISO timestamp, if the channel has one. Used to resume polling after a restart. */
  at?: string;
}

/** The smallest thing a chat app needs to be: somewhere to send text, and (optionally) to read replies. */
export interface LiveChannel {
  send(text: string): Promise<string | void>;
  /** Optional richer way to send a card (e.g. tap-to-answer buttons). `text` is the plain rendering. */
  sendCard?(card: HumanCard, text: string): Promise<string | void>;
  /** New messages from the human, oldest first. `since` is the `at` of the last message handled. */
  poll?(since?: string): Promise<IncomingMessage[]>;
}

export interface TickReport {
  /** Card ids sent this tick. */
  delivered: string[];
  /** Card ids answered this tick. */
  answered: string[];
  /** Incoming messages skipped (echoes of our own texts, already handled). */
  ignored: number;
  /** Set when the channel failed (e.g. the chat app is not running). The next tick retries. */
  error?: string;
}

interface BridgeState {
  version: 1;
  /** Cards already texted. Pruned to cards that are still pending. */
  delivered: string[];
  /** Incoming message ids already handled. */
  handled: string[];
  /** Hashes of texts we sent, so a channel that echoes our own messages back can't answer itself. */
  sent: string[];
  since?: string;
}

export interface CardBridgeOptions {
  engine: Engine;
  channel: LiveChannel;
  /** Where `bridge-state.json` lives. Defaults to the engine's workspace. */
  workspaceDir?: string;
  now?: () => Date;
  /**
   * Answers anything that is not a reply to an open card (status, flows, lessons, run, learn, or free-form chat).
   * Defaults to a `ChiefOfStaff` on the same engine; pass `false` to keep the bridge card-only.
   */
  chief?: ChiefOfStaff | false;
}

const STATE_FILE = 'bridge-state.json';
const KEEP_HANDLED = 500;
const KEEP_SENT = 100;

const hash = (text: string): string => createHash('sha1').update(text.trim()).digest('hex');
const oneLine = (s: string, max = 200): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Optional leading card ref: "c_1234 2", "ref c_1234: 2", "(ref c_1234abcd) 2". */
const REF = /^\(?(?:ref\s+)?(c_[0-9a-f]{2,})\)?(?=[\s:,.\-–—]|$)[\s:,.\-–—]*/i;

/**
 * Texts each new "waiting_human" card to a person through any `LiveChannel`, then turns their
 * replies into `engine.answer(...)` calls. Remembers what it already sent in
 * `<workspace>/bridge-state.json`, so a restart never double-texts.
 */
export class CardBridge {
  private readonly engine: Engine;
  private readonly channel: LiveChannel;
  private readonly stateFile: string;
  private readonly now: () => Date;
  private readonly chief?: ChiefOfStaff;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: CardBridgeOptions) {
    this.engine = opts.engine;
    this.channel = opts.channel;
    this.stateFile = path.join(opts.workspaceDir ?? opts.engine.store.dir, STATE_FILE);
    this.now = opts.now ?? (() => new Date());
    this.chief = opts.chief === false ? undefined : (opts.chief ?? new ChiefOfStaff({ engine: this.engine }));
  }

  /** One pass: read replies, then send any cards the human hasn't seen. Never throws on channel errors. */
  tick(): Promise<TickReport> {
    const run = this.queue.then(() => this.runTick());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Tick forever (until `signal` aborts), waiting `intervalMs` between passes. */
  async run(opts: { intervalMs: number; signal?: AbortSignal; onTick?: (report: TickReport) => void }): Promise<void> {
    const { signal } = opts;
    while (!signal?.aborted) {
      opts.onTick?.(await this.tick());
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, opts.intervalMs);
        signal?.addEventListener('abort', done, { once: true });
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        }
      });
    }
  }

  // ---------- internals ----------

  private async runTick(): Promise<TickReport> {
    const report: TickReport = { delivered: [], answered: [], ignored: 0 };
    const state = await this.load();
    if (this.channel.poll && state.since === undefined) {
      // First run: only listen from now on, never replay old chat history as answers.
      state.since = this.now().toISOString();
      await this.save(state);
    }
    for (const step of [() => this.receive(state, report), () => this.deliver(state, report)]) {
      try {
        await step();
      } catch (err) {
        report.error ??= message(err);
      }
    }
    return report;
  }

  private async receive(state: BridgeState, report: TickReport): Promise<void> {
    if (!this.channel.poll) return;
    for (const msg of await this.channel.poll(state.since)) {
      if (state.handled.includes(msg.id)) {
        report.ignored++;
        continue;
      }
      state.handled.push(msg.id);
      state.handled = state.handled.slice(-KEEP_HANDLED);
      if (msg.at && (!state.since || msg.at > state.since)) state.since = msg.at;
      await this.save(state);

      const text = msg.text.trim();
      if (!text || state.sent.includes(hash(text))) {
        report.ignored++;
        continue;
      }
      await this.handleReply(state, text, report);
    }
  }

  /**
   * A message that is not an answer to a card goes to the Chief of Staff, who can always reply.
   * `hint` is what to say instead when the chief can't think (no AI configured) and a card is waiting.
   */
  private async chat(state: BridgeState, text: string, hint?: string): Promise<void> {
    const reply = await this.chief?.handle(text);
    if (!reply || (reply.unavailable && hint)) return void (await this.say(state, hint ?? 'Nothing is waiting on you right now.'));
    // The card is already in the reply, so mark it delivered or the next deliver pass would text it again.
    for (const card of reply.cards) if (!state.delivered.includes(card.id)) state.delivered.push(card.id);
    if (reply.cards.length) await this.save(state);
    await this.say(state, reply.text);
  }

  private async handleReply(state: BridgeState, raw: string, report: TickReport): Promise<void> {
    const pendingIds = new Set(state.delivered);
    const open = (await this.engine.pending()).filter((c) => pendingIds.has(c.id));

    let card: HumanCard | undefined;
    let body = raw;
    const ref = REF.exec(raw);
    if (ref) {
      const hits = open.filter((c) => c.id.toLowerCase().startsWith(ref[1]!.toLowerCase()));
      if (hits.length !== 1) {
        return void (await this.say(state, `${hits.length ? 'More than one' : 'No'} open card matches "${ref[1]}".`));
      }
      card = hits[0];
      body = raw.slice(ref[0].length);
    } else if (!open.length || this.chief?.isCommand(raw)) {
      return this.chat(state, raw);
    } else if (open.length === 1) {
      card = open[0];
    } else if (/^\d/.test(raw)) {
      return void (await this.say(state, `${open.length} cards are open. Start your reply with a ref, like "${open[0]!.id.slice(0, 6)} 1".`));
    } else {
      return this.chat(state, raw, `${open.length} cards are open. Start your reply with a ref, like "${open[0]!.id.slice(0, 6)} 1".`);
    }

    const parsed = parseTextReply(body, card!);
    if (!parsed) {
      const options = card!.options.map((o, i) => `${i + 1} (${o.label})`).join(', ');
      // A choice-only card can't take this text. It may be a question for the chief instead.
      return this.chat(state, raw, `Couldn't read that as an answer.${options ? ` Reply ${options}.` : ''}`);
    }

    let result: RunResult;
    try {
      result = await this.engine.answer(card!.id, parsed);
    } catch (err) {
      return void (await this.say(state, `Couldn't apply that: ${oneLine(message(err))}`));
    }
    report.answered.push(card!.id);

    if (result.status === 'waiting_human') {
      // The flow paused again: the next card is the confirmation.
      await this.sendCard(state, result.card, report);
    } else {
      await this.say(state, confirmation(card!, parsed, result));
    }
  }

  private async deliver(state: BridgeState, report: TickReport): Promise<void> {
    const pending = await this.engine.pending();
    for (const card of pending) {
      if (!state.delivered.includes(card.id)) await this.sendCard(state, card, report);
    }
    const still = new Set(pending.map((c) => c.id));
    const pruned = state.delivered.filter((id) => still.has(id) || report.delivered.includes(id));
    if (pruned.length !== state.delivered.length) {
      state.delivered = pruned;
      await this.save(state);
    }
  }

  /** Marks the card delivered *before* sending (a crash can't double-text); rolls back if the send fails. */
  private async sendCard(state: BridgeState, card: HumanCard, report: TickReport): Promise<void> {
    if (state.delivered.includes(card.id)) return;
    state.delivered.push(card.id);
    await this.save(state);
    try {
      await this.say(state, formatCardAsText(card), card);
    } catch (err) {
      state.delivered = state.delivered.filter((id) => id !== card.id);
      await this.save(state);
      throw err;
    }
    report.delivered.push(card.id);
  }

  private async say(state: BridgeState, text: string, card?: HumanCard): Promise<void> {
    state.sent.push(hash(text));
    state.sent = state.sent.slice(-KEEP_SENT);
    await this.save(state);
    if (card && this.channel.sendCard) await this.channel.sendCard(card, text);
    else await this.channel.send(text);
  }

  private async load(): Promise<BridgeState> {
    const fresh: BridgeState = { version: 1, delivered: [], handled: [], sent: [] };
    return { ...fresh, ...(await this.engine.store.readJson<Partial<BridgeState>>(this.stateFile, {})) };
  }

  private save(state: BridgeState): Promise<void> {
    return this.engine.store.writeJson(this.stateFile, state);
  }
}

function confirmation(card: HumanCard, reply: HumanReply, result: Exclude<RunResult, { status: 'waiting_human' }>): string {
  const label = card.options.find((o) => o.id === reply.choice)?.label;
  const what = label ?? (reply.text ? 'your note' : 'your answer');
  const lesson = reply.lesson ? ' Lesson saved.' : '';
  return result.status === 'failed'
    ? `Got it (${what}), but the run failed: ${oneLine(result.error)}`
    : `Got it (${what}). Done.${lesson}`;
}
