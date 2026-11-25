import type { LoopPlan, LoopSignal, LoopStageContext, Sensor, SignalHandler, Urgency } from '../engine/loop';
import { BeeperApi, beeperApiOptions, type BeeperApiOptions, type BeeperChat } from '../tools/beeper-api';
import { beeperConfigured, parseOutput, runCommand, type CommandRunner } from '../tools/tools';
import type { BeeperSensorConfig, CommandSensorConfig, RufusConfig } from '../types';
import { clip } from '../corpus/types';

/**
 * Live App Sensors: plain code that notices what is new in your apps, at $0 AI cost. Each sensor keeps a small cursor
 * (saved by the Master Loop in `loop-state.json`), so a restart never re-reads, and nothing is ever handled twice.
 */

const KEEP_SEEN = 1000;

interface SeenCursor {
  /** ISO time: only messages after this are new. */
  since?: string;
  /** Recently emitted ids, for messages that share a timestamp. */
  seen: string[];
}

function readCursor(cursor: string | undefined): SeenCursor | undefined {
  if (!cursor) return undefined;
  try {
    const c = JSON.parse(cursor) as Partial<SeenCursor>;
    return { ...(typeof c.since === 'string' ? { since: c.since } : {}), seen: Array.isArray(c.seen) ? c.seen.filter((x): x is string => typeof x === 'string') : [] };
  } catch {
    return undefined;
  }
}

const writeCursor = (c: SeenCursor): string => JSON.stringify({ ...(c.since ? { since: c.since } : {}), seen: c.seen.slice(-KEEP_SEEN) });

// ---------- Beeper ----------

export const DEFAULT_BOT_PATTERN = '\\bbot\\b|bot$';

export interface BeeperSensorOptions extends BeeperSensorConfig, BeeperApiOptions {
  /** Sensor id. Default `beeper`. */
  id?: string;
  /** A ready client (tests, or to share one). */
  api?: BeeperApi;
  /** Your Rufus control chat, never sensed (Rufus would otherwise read its own conversation with you). */
  controlChatId?: string;
}

const isGroup = (c: BeeperChat): boolean => /group/i.test(c.type ?? '');

/**
 * New incoming messages from people across your Beeper chats. Skips your own messages, deleted and non-text messages,
 * bot chats (by title), muted and archived chats (by default), your Rufus chat and any `ignoreChatIds`.
 * The first pass only sets the cursor to now: old history is never replayed as new work.
 */
export function beeperSensor(opts: BeeperSensorOptions = {}): Sensor {
  const api = opts.api ?? new BeeperApi(opts);
  const ignore = new Set([...(opts.ignoreChatIds ?? []), ...(opts.controlChatId ? [opts.controlChatId] : [])]);
  const bot = new RegExp(opts.botPattern ?? DEFAULT_BOT_PATTERN, 'i');
  const limit = opts.limitPerChat ?? 20;
  return {
    id: opts.id ?? 'beeper',
    surface: 'chat',
    async poll(cursor, ctx) {
      const prev = readCursor(cursor);
      if (!prev?.since) return { signals: [], nextCursor: writeCursor({ since: ctx.now.toISOString(), seen: [] }) };
      const seen = new Set(prev.seen);
      let since = prev.since;
      const signals: LoopSignal[] = [];
      for (const chat of await api.listChats()) {
        if (ignore.has(chat.id)) continue;
        if (chat.title && bot.test(chat.title)) continue;
        if (opts.groups === false && isGroup(chat)) continue;
        if ((opts.skipMuted ?? true) && chat.isMuted) continue;
        if (chat.isArchived) continue;
        if (chat.lastActivity && chat.lastActivity <= prev.since) continue; // nothing new here: one cheap call saved
        for (const m of await api.listMessages(chat.id, { limit })) {
          if (!m.timestamp || m.timestamp < prev.since) continue;
          const id = `${chat.id}:${m.id}`;
          if (seen.has(id)) continue;
          if (m.isSender || m.isDeleted || !m.text.trim()) continue;
          if (m.type && !['TEXT', 'VOICE', 'AUDIO'].includes(m.type.toUpperCase())) continue;
          if (m.senderName && bot.test(m.senderName)) continue;
          seen.add(id);
          if (m.timestamp > since) since = m.timestamp;
          signals.push({
            id,
            surface: 'chat',
            kind: 'message.received',
            text: m.text,
            ...(m.senderName ? { actor: m.senderName } : chat.title && !isGroup(chat) ? { actor: chat.title } : {}),
            timestamp: m.timestamp,
            data: {
              chatId: chat.id,
              messageId: m.id,
              ...(chat.title ? { chatTitle: chat.title } : {}),
              ...(chat.network ? { network: chat.network } : {}),
              isGroup: isGroup(chat),
            },
          });
        }
      }
      signals.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
      return { signals, nextCursor: writeCursor({ since, seen: [...seen] }) };
    },
  };
}

// ---------- any read-only command ----------

export interface CommandSensorOptions extends CommandSensorConfig {
  /** Injectable for tests. */
  run?: CommandRunner;
}

function pick(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function itemsOf(out: unknown, itemsPath?: string): Record<string, unknown>[] {
  const found = itemsPath ? pick(out, itemsPath) : out;
  if (Array.isArray(found)) return found.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
  if (!itemsPath && found && typeof found === 'object') {
    for (const k of ['items', 'events', 'messages', 'threads', 'data']) {
      const v = (found as Record<string, unknown>)[k];
      if (Array.isArray(v)) return itemsOf(v);
    }
  }
  return [];
}

const strOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

/**
 * Runs a read-only command (e.g. a calendar or mail CLI that prints JSON), diffs its items against the ids it has
 * already seen, and emits only the new ones as signals. Code only, $0. The first pass records what is there without
 * emitting it (set `baseline: false` to emit it).
 */
export function commandSensor(opts: CommandSensorOptions): Sensor {
  if (!opts.id?.trim()) throw new Error('A command sensor needs an id.');
  if (!opts.command?.trim()) throw new Error(`Command sensor "${opts.id}" needs a command.`);
  const surface = opts.surface ?? opts.id;
  const kind = opts.kind ?? `${surface}.item`;
  const run = opts.run ?? runCommand;
  const idField = opts.idField ?? 'id';
  return {
    id: opts.id,
    surface,
    async poll(cursor, ctx) {
      const prev = readCursor(cursor);
      let stdout: string;
      try {
        stdout = await run(opts.command, opts.args ?? [], { timeoutMs: opts.timeoutMs ?? 30_000, cwd: opts.cwd ?? ctx.dir });
      } catch (err) {
        throw new Error(`sensor ${opts.id}: ${(err as Error).message}`);
      }
      const out = parseOutput(stdout);
      if (typeof out === 'string' && out) throw new Error(`sensor ${opts.id}: the command did not print JSON (got "${clip(out, 80)}").`);
      const items = itemsOf(out, opts.itemsPath);
      const seen = new Set(prev?.seen ?? []);
      const first = prev === undefined && (opts.baseline ?? true);
      const signals: LoopSignal[] = [];
      for (const item of items) {
        const id = strOf(pick(item, idField));
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (first) continue;
        const text = strOf(pick(item, opts.textField ?? 'text')) ?? strOf(item.summary) ?? strOf(item.subject) ?? strOf(item.title) ?? strOf(item.snippet);
        const actor = strOf(pick(item, opts.actorField ?? 'actor')) ?? strOf(item.from) ?? strOf(item.organizer);
        const timestamp = strOf(pick(item, opts.timestampField ?? 'timestamp')) ?? strOf(item.date) ?? strOf(item.start);
        signals.push({
          id,
          surface,
          kind,
          ...(text ? { text } : {}),
          ...(actor ? { actor } : {}),
          ...(timestamp ? { timestamp } : {}),
          ...(opts.urgency ? { urgency: opts.urgency } : {}),
          data: item,
        });
      }
      return { signals, nextCursor: writeCursor({ seen: [...seen] }) };
    },
  };
}

/** The sensors in `config.sensors`: Beeper (when configured) and each command sensor. */
export function buildSensors(config: RufusConfig, opts: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; run?: CommandRunner } = {}): Sensor[] {
  const env = opts.env ?? process.env;
  const sensors: Sensor[] = [];
  const b = config.sensors?.beeper;
  if (b) {
    if (!beeperConfigured(config.beeper, env)) throw new Error('config.sensors.beeper is on, but Beeper is not configured: set RUFUS_BEEPER_TOKEN (or "beeper" in config.json).');
    sensors.push(
      beeperSensor({
        ...beeperApiOptions(config.beeper, env),
        ...(typeof b === 'object' ? b : {}),
        ...(config.beeper?.chatId ? { controlChatId: config.beeper.chatId } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }),
    );
  }
  for (const c of config.sensors?.commands ?? []) sensors.push(commandSensor({ ...c, ...(opts.run ? { run: opts.run } : {}) }));
  return sensors;
}

// ---------- message triage ----------

export type TriageLabel = 'ignore' | 'batch' | 'urgent';

export interface TriageResult {
  label: TriageLabel;
  reason: string;
  /** The drafted reply, when one is worth sending. Sent only after your yes. */
  reply?: string;
  /** Where it would go. */
  chatId?: string;
  to?: string;
  surface: string;
}

interface TriagePlan extends LoopPlan {
  label: TriageLabel;
  reason: string;
}

const ACK = new Set(['ok', 'okay', 'k', 'kk', 'thanks', 'thank', 'you', 'thx', 'ty', 'lol', 'haha', 'hahaha', 'nice', 'cool', 'great', 'perfect', 'awesome', 'yep', 'yup', 'sure', 'done', 'got', 'it', 'sounds', 'good', 'np', 'no', 'problem', 'worries', '👍', '❤️', '🙏', '😂', '🙌']);
/** A short message made only of acknowledgement words ("ok thanks", "sounds good!", "👍"). */
const isAck = (t: string): boolean => {
  const words = t.toLowerCase().replace(/[!.,~]+/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 4 && words.every((w) => ACK.has(w));
};
const URGENT = /\b(urgent|asap|emergency|right now|immediately|call me|help|hospital|accident|deadline (is )?today)\b/i;

/** The free, code-only first guess. `undefined` when code cannot tell and a model (or a person) should judge. */
export function classifyByCode(text: string): { label: TriageLabel; reason: string } | undefined {
  const t = text.trim();
  if (!t) return { label: 'ignore', reason: 'empty message' };
  if (isAck(t)) return { label: 'ignore', reason: 'a short acknowledgement, nothing to answer' };
  if (URGENT.test(t)) return { label: 'urgent', reason: 'it says it is urgent' };
  return undefined;
}

function parseTriage(raw: string): { label?: TriageLabel; reason?: string; reply?: string } {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return {};
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const label = ['ignore', 'batch', 'urgent'].includes(String(o.label)) ? (o.label as TriageLabel) : undefined;
    return {
      ...(label ? { label } : {}),
      ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
      ...(typeof o.reply === 'string' && o.reply.trim() ? { reply: o.reply.trim() } : {}),
    };
  } catch {
    return {};
  }
}

const MAX_REPLY = 600;

export interface MessageTriageOptions {
  /** Handler id. Default `message.triage`. */
  id?: string;
  /** The send tool for chat replies. Default `beeper.send`. */
  sendTool?: string;
  /** The tool for email replies (a draft, never a send). Default `gmail.draft`. */
  emailTool?: string;
}

/**
 * Built-in handler for `chat` and `email` messages. Plan: code classifies what it can for free (acknowledgements are
 * ignored, "urgent"/"asap" is urgent); anything else gets one fast model call with SOUL.md, the Anchor and your closest
 * past decisions. Execute: a concise draft in your voice. Verify: the draft must be short and free of placeholders, and
 * sending is `external`, so it always waits for your yes. Commit: sends through `beeper.send` (or saves a
 * `gmail.draft`) only after you approve.
 */
export function messageTriageHandler(opts: MessageTriageOptions = {}): SignalHandler<TriageResult, TriagePlan> {
  const sendTool = opts.sendTool ?? 'beeper.send';
  const emailTool = opts.emailTool ?? 'gmail.draft';
  const sample = (ctx: LoopStageContext, actionType: string): string =>
    ctx
      .examples({ actionType, limit: 3 })
      .map((h) => `- ${clip(h.item.summary, 240)}`)
      .join('\n');
  return {
    id: opts.id ?? 'message.triage',
    match: (s) => (s.surface === 'chat' || s.surface === 'email') && /message|email|received|mail/i.test(s.kind),
    maxReplans: 1,
    async plan(signal, ctx) {
      const surface = signal.surface;
      const who = signal.actor ?? 'someone';
      const text = signal.text ?? '';
      let judged = classifyByCode(text);
      if (!judged && ctx.hasAi) {
        const raw = await ctx.ai(
          [
            `Triage this ${surface} message for your human. Reply with JSON only: {"label":"ignore"|"batch"|"urgent","reason":"<short>"}.`,
            'ignore = needs nothing from them; batch = answer at the next check-in; urgent = they should see it now.',
            `From: ${who}`,
            `Message: ${clip(text, 1200)}`,
            ...(ctx.replan ? [`A previous attempt failed: ${ctx.replan.reason}`] : []),
            sample(ctx, `reply.${surface}`) ? `Their past decisions:\n${sample(ctx, `reply.${surface}`)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          { tier: 'fast', json: true },
        );
        const t = parseTriage(raw);
        if (t.label) judged = { label: t.label, reason: t.reason ?? 'model triage' };
      }
      judged ??= { label: signal.urgency === 'urgent' ? 'urgent' : 'batch', reason: 'no model configured: you decide' };
      const urgency: Urgency = judged.label === 'urgent' || signal.urgency === 'urgent' ? 'urgent' : 'normal';
      if (judged.label === 'ignore') {
        return { goal: `Ignore ${who}'s ${surface} message (${judged.reason})`, actionType: `triage.ignore`, route: 'code', urgency: 'normal', label: 'ignore', reason: judged.reason };
      }
      const replyTool = surface === 'email' ? emailTool : sendTool;
      if (!ctx.hasAi) {
        return {
          goal: `Reply to ${who}: "${clip(text, 120)}"`,
          actionType: `reply.${surface}`,
          route: 'human',
          humanStep: `Reply to ${who} (${surface}): "${clip(text, 200)}"`,
          urgency,
          label: judged.label,
          reason: judged.reason,
        };
      }
      return {
        goal: `Draft a concise reply to ${who}'s ${surface} message`,
        actionType: `reply.${surface}`,
        route: ctx.replan ? ctx.replan.nextRoute : 'fast',
        sensitivity: ['external'],
        uses: [replyTool],
        urgency,
        label: judged.label,
        reason: judged.reason,
        criteria: ['short and in their voice', 'no placeholders', 'never sent without a yes'],
      };
    },
    async execute(plan, signal, ctx) {
      const base: TriageResult = {
        label: plan.label,
        reason: plan.reason,
        surface: signal.surface,
        ...(typeof signal.data?.chatId === 'string' ? { chatId: signal.data.chatId } : {}),
        ...(signal.actor ? { to: signal.actor } : {}),
      };
      if (plan.label === 'ignore') return base;
      const past = sample(ctx, plan.actionType);
      const raw = await ctx.ai(
        [
          `Draft the reply your human would send to this ${signal.surface} message. Their voice, as short as it can be, no greeting fluff.`,
          'Never invent facts, times or commitments that are not in the message, SOUL.md or the Anchor. If a fact is missing, ask for it briefly.',
          'Reply with JSON only: {"reply":"<the message to send>"}',
          `From: ${signal.actor ?? 'someone'}`,
          `Message: ${clip(signal.text ?? '', 1500)}`,
          past ? `How they decided before:\n${past}` : '',
          ctx.replan ? `Your last draft failed a check: ${ctx.replan.reason}. Fix exactly that.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        { json: true },
      );
      const reply = parseTriage(raw).reply ?? raw.trim().replace(/^"|"$/g, '');
      return { ...base, reply };
    },
    crossCheck(result) {
      if (result.label === 'ignore') return { ok: true };
      const r = result.reply?.trim() ?? '';
      if (!r) return { ok: false, reason: 'the draft is empty' };
      if (r.length > MAX_REPLY) return { ok: false, reason: `the draft is ${r.length} characters; keep it under ${MAX_REPLY}` };
      if (/\[[A-Z][^\]]{0,30}\]|\{\{|<name>|lorem ipsum/i.test(r)) return { ok: false, reason: 'the draft has a placeholder like [Name]' };
      return { ok: true };
    },
    async commit(output, plan, signal, ctx) {
      // An edit typed in chat arrives as plain text: that text IS the reply.
      const raw: unknown = output;
      const o: Partial<TriageResult> = typeof raw === 'string' ? { reply: raw } : ((raw ?? {}) as Partial<TriageResult>);
      if (plan.label === 'ignore' && !(typeof raw === 'string' && raw.trim())) return;
      const text = (o.reply ?? '').trim();
      if (!text) return;
      const chatId = o.chatId ?? (typeof signal.data?.chatId === 'string' ? signal.data.chatId : undefined);
      if (signal.surface === 'email') {
        if (!ctx.tools.has(emailTool)) throw new Error(`Approved, but no "${emailTool}" tool is configured, so nothing was saved. Copy the draft yourself.`);
        await ctx.tools.call(emailTool, { ...(signal.data ?? {}), to: o.to ?? signal.actor, text });
        return;
      }
      if (!chatId) throw new Error('Approved, but the message has no chatId to reply to. Send it yourself.');
      if (!ctx.tools.has(sendTool)) throw new Error(`Approved, but no "${sendTool}" tool is configured. Send it yourself.`);
      await ctx.tools.call(sendTool, { chatId, text });
    },
  };
}
