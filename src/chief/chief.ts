import { formatCardAsText } from '../channels/text';
import type { Engine } from '../engine/engine';
import { LessonCapError, describeTension } from '../learning/lessons';
import { addSpectrum, emptySpectrum, formatSpectrum, spectrumOf, spectrumTotal } from '../engine/spectrum';
import type { HumanCard, RunResult } from '../types';

/** What the Chief of Staff says back, plus any cards whose full text is already in that reply. */
export interface ChiefReply {
  text: string;
  /** Cards shown in full inside `text`. A channel should not send them a second time. */
  cards: HumanCard[];
  /** `command`: answered by plain code, no AI call from the chief. `chat`: answered by the AI. */
  via: 'command' | 'chat';
  /** Free-form chat could not reach an AI provider, so `text` is only a pointer to the quick commands. */
  unavailable?: boolean;
}

export type ChiefCommand =
  | { kind: 'status' }
  | { kind: 'flows' }
  | { kind: 'lessons' }
  | { kind: 'run'; flowId: string; inputJson?: string }
  | { kind: 'learn'; scope: string; rule: string };

export interface ChiefOfStaffOptions {
  engine: Engine;
  /** Named provider for free-form chat (a key of the engine's `providers`). Default: the default provider. */
  provider?: string;
}

const STATUS_WORDS = new Set(['status', 'pending', 'what needs me', 'whats pending', "what's pending", 'what is pending', 'what needs my attention']);
const MAX_REPLY = 1500;

const oneLine = (s: string, max = 120): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** "What needs me?!" -> "what needs me" */
const normalize = (text: string): string => text.trim().toLowerCase().replace(/[?!.\s]+$/g, '').replace(/\s+/g, ' ');

const SYSTEM = [
  'You are Rufus, a calm, brief chief of staff texting with your human.',
  'Reply in plain words, usually 1 to 3 short sentences, like a chat message. No headings or tables.',
  'You are given a live snapshot of their flows, open cards, lessons and recent runs. Use only that; never invent facts.',
  'You cannot take actions yourself. If they want something done (run a flow, save a lesson, a new flow), say what you would do and the exact command that does it:',
  '"run <flowId> [json]" or "learn <scope>: <rule>". Nothing with side effects happens without their explicit yes.',
  'If they ask for a new AI + Code + Human flow, propose it as: code steps (exact facts), the ai step (judgement or drafting, with a verify check), and the human step (the final yes).',
  'If a message looks like an answer to an open card, tell them to start it with that card\'s ref.',
].join('\n');

/**
 * Talk to Rufus any time. Exact commands (`status`, `flows`, `lessons`, `run`, `learn`) are answered by plain code:
 * the chief itself makes no AI call. Anything else gets one AI call, with a compact live snapshot assembled by code.
 * Free-form chat can only reply with text: it can never start a run or save a lesson by itself.
 */
export class ChiefOfStaff {
  private readonly engine: Engine;
  private readonly providerName?: string;

  constructor(opts: ChiefOfStaffOptions) {
    this.engine = opts.engine;
    this.providerName = opts.provider;
  }

  /** Is this message an explicit chief command (so a channel should route it here even while a card is open)? */
  isCommand(text: string): boolean {
    return this.classify(text) !== undefined;
  }

  async handleMessage(text: string): Promise<string> {
    return (await this.handle(text)).text;
  }

  async handle(text: string): Promise<ChiefReply> {
    const trimmed = text.trim();
    if (!trimmed) return { text: 'Say "status", "flows", "lessons", or just ask me something.', cards: [], via: 'command' };
    const command = this.classify(trimmed);
    if (!command) return this.chat(trimmed);
    try {
      return await this.runCommand(command);
    } catch (err) {
      return { text: `Couldn't do that: ${oneLine(message(err), 300)}`, cards: [], via: 'command' };
    }
  }

  // ---------- routing ----------

  private classify(text: string): ChiefCommand | undefined {
    const trimmed = text.trim();
    const word = normalize(trimmed);
    if (STATUS_WORDS.has(word)) return { kind: 'status' };
    if (word === 'flows') return { kind: 'flows' };
    if (word === 'lessons') return { kind: 'lessons' };

    const known = new Set(this.engine.listFlows().map((f) => f.meta.id));
    const run = /^run\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(trimmed);
    if (run) {
      const [, flowId, rest] = run;
      const inputJson = rest?.trim();
      // "run triage-draft" is a command, even for a typo (we answer with the flow list). "run the report for Sam" is chat.
      if (known.has(flowId!) || !inputJson || /^[{[]/.test(inputJson)) return { kind: 'run', flowId: flowId!, ...(inputJson ? { inputJson } : {}) };
      return undefined;
    }

    const learn = /^learn\s+(global|flow:[^\s:]+|role:[^\s:]+|[^\s:]+)\s*:\s*([\s\S]+)$/i.exec(trimmed);
    if (learn) {
      let scope = learn[1]!;
      if (!/^(global|flow:|role:)/i.test(scope)) {
        if (!known.has(scope)) return undefined; // "learn how: to do x" is just chat
        scope = `flow:${scope}`;
      }
      return { kind: 'learn', scope, rule: learn[2]!.trim() };
    }
    return undefined;
  }

  private async runCommand(c: ChiefCommand): Promise<ChiefReply> {
    const reply = (text: string, cards: HumanCard[] = []): ChiefReply => ({ text, cards, via: 'command' });
    switch (c.kind) {
      case 'status':
        return reply(await this.status());
      case 'flows': {
        const flows = this.engine.listFlows();
        if (!flows.length) return reply('No flows are registered yet.');
        return reply(flows.map(({ meta }) => `${meta.id} - ${meta.description}`).join('\n'));
      }
      case 'lessons':
        return reply(await this.lessons());
      case 'run':
        return this.start(c.flowId, c.inputJson);
      case 'learn':
        return reply(await this.learn(c.scope, c.rule));
    }
  }

  // ---------- commands (all plain code) ----------

  private async status(): Promise<string> {
    const [cards, runs] = await Promise.all([this.engine.pending(), this.engine.store.listRuns()]);
    const active = runs.filter((r) => r.status === 'running' || r.status === 'waiting_human');
    // Where the work went across all runs: how much stayed in code and a fast model, how much needed smart or you.
    const spectrum = runs.reduce((sum, r) => addSpectrum(sum, spectrumOf(r)), emptySpectrum());
    const where = spectrumTotal(spectrum) ? [`Handled by (${runs.length} run${runs.length === 1 ? '' : 's'}): ${formatSpectrum(spectrum)}`] : [];
    if (!cards.length && !active.length) return ['All clear: nothing is waiting on you and no flows are running.', ...where].join('\n');
    const lines: string[] = [];
    if (cards.length) {
      lines.push(`Waiting on you (${cards.length}):`);
      for (const card of cards) lines.push(`- ${card.title} [${card.flowId}] (ref ${card.id})`);
    }
    const others = active.filter((r) => r.status === 'running');
    if (others.length) {
      lines.push(`Running (${others.length}):`);
      for (const r of others) lines.push(`- ${r.flowId} (${r.id})`);
    }
    return [...lines, ...where].join('\n');
  }

  private async lessons(): Promise<string> {
    await this.engine.reviewLessons();
    const all = await this.engine.lessons.all();
    if (!all.length) return 'No lessons yet. Add one with "learn <scope>: <rule>", or a "Lesson: <rule>" line when you answer a card.';
    const ready = new Set((await this.engine.lessons.candidatesForCode()).map((l) => l.id));
    const lines = all.map((l) => `- ${l.rule} (${l.scope}, x${l.count}${l.hardened ? ', in code' : ready.has(l.id) ? ', ready to harden into code' : ''}${l.evidence?.status === 'tension' ? ', in tension' : ''})`);
    const tense = all.map((l) => describeTension(l)).filter((q): q is string => !!q);
    if (tense.length) lines.push('', 'In tension with your latest replies:', ...tense.map((q) => `- ${q}`));
    if (ready.size) lines.push(`${ready.size} lesson(s) keep coming back: they are ready to become code checks.`);
    return lines.join('\n');
  }

  private async start(flowId: string, inputJson?: string): Promise<ChiefReply> {
    const none = (text: string): ChiefReply => ({ text, cards: [], via: 'command' });
    if (!this.engine.listFlows().some((f) => f.meta.id === flowId)) {
      const ids = this.engine.listFlows().map((f) => f.meta.id);
      return none(`No flow called "${flowId}".${ids.length ? ` Available: ${ids.join(', ')}.` : ''}`);
    }
    let input: unknown;
    if (inputJson) {
      try {
        input = JSON.parse(inputJson);
      } catch {
        return none(`That input isn't valid JSON. Use: run ${flowId} {"key":"value"}`);
      }
    }
    return this.describeRun(await this.engine.start(flowId, input));
  }

  private describeRun(result: RunResult): ChiefReply {
    if (result.status === 'waiting_human') {
      return { text: formatCardAsText(result.card), cards: [result.card], via: 'command' };
    }
    if (result.status === 'failed') return { text: `Run ${result.runId} failed: ${oneLine(result.error, 300)}`, cards: [], via: 'command' };
    const out = result.output === null || result.output === undefined ? '' : `\n${JSON.stringify(result.output, null, 2)}`;
    return { text: clip(`Done (${result.runId}).${out}`), cards: [], via: 'command' };
  }

  private async learn(scope: string, rule: string): Promise<string> {
    try {
      const r = await this.engine.proposeLesson({ scope, rule });
      const checked = r.report.total
        ? `Checked ${r.report.total} saved case(s): ${r.report.regressed} regressed.`
        : 'No saved cases in that scope, so nothing was measured.';
      const layer = r.suggestedLayer.layer === 'principle' ? '' : ` This looks like a ${r.suggestedLayer.layer} rule. ${r.suggestedLayer.reason}`;
      if (!r.accepted) return clip(`${r.reason}${layer}`);
      return clip(`Saved lesson for ${scope}: "${rule}". ${checked}${layer}`);
    } catch (err) {
      if (err instanceof LessonCapError) return clip(err.message);
      throw err;
    }
  }

  // ---------- free-form: code assembles the facts, AI answers in words ----------

  /** A compact live snapshot, assembled by code, so the model reasons over exact facts instead of guessing. */
  async snapshot(): Promise<unknown> {
    const [cards, lessons, runs, ready] = await Promise.all([
      this.engine.pending(),
      this.engine.lessons.all(),
      this.engine.store.listRuns(),
      this.engine.lessons.candidatesForCode(),
    ]);
    const readyIds = new Set(ready.map((l) => l.id));
    return {
      flows: this.engine.listFlows().map(({ meta }) => ({ id: meta.id, description: meta.description, trigger: meta.trigger?.type ?? 'manual' })),
      openCards: cards.map((c) => ({
        ref: c.id,
        flow: c.flowId,
        title: c.title,
        summary: oneLine(c.summary, 200),
        options: c.options.map((o, i) => `${i + 1}) ${o.label}`),
      })),
      lessons: lessons.slice(0, 20).map((l) => ({ scope: l.scope, rule: l.rule, count: l.count, hardened: l.hardened, readyToHarden: readyIds.has(l.id), ...(l.evidence?.status ? { evidence: l.evidence.status } : {}) })),
      recentRuns: runs
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 5)
        .map((r) => ({ id: r.id, flow: r.flowId, status: r.status, updatedAt: r.updatedAt, ...(r.error ? { error: oneLine(r.error, 100) } : {}) })),
    };
  }

  private async chat(text: string): Promise<ChiefReply> {
    const reply = (t: string, unavailable = false): ChiefReply => ({ text: t, cards: [], via: 'chat', ...(unavailable ? { unavailable } : {}) });
    try {
      const snapshot = await this.snapshot();
      const out = await this.engine.providerFor(this.providerName).complete({
        system: SYSTEM,
        messages: [{ role: 'user', content: `Live snapshot (exact data gathered by code):\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n\nTheir message:\n${text}` }],
        meta: { runId: 'chief', flowId: 'chief', step: 'chat', attempt: 1 },
      });
      return reply(clip(out.trim() || "I don't have anything to add."));
    } catch (err) {
      return reply(
        `I can't think that one through right now (${oneLine(message(err), 160)}). ` +
          'The quick commands still work: status, flows, lessons, run <flowId> [json], learn <scope>: <rule>.',
        true,
      );
    }
  }
}

function clip(text: string): string {
  return text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY - 1)}…` : text;
}
