import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MessageSink, ModelProvider, Receipt, ScriptContext, ScriptOutput, ToolManifest } from '../types';
import { recordOpsFailure } from '../eval/ops-log';
import { runCreateBrain, runInvestigateBrain, runPlanBrain, runVerifyBrain, type BrainStateName } from '../brains/states';
import { realNextMove, servesGap, WAITS_ON, type WatchStore } from '../events/watches';
import { startBrainJob } from '../brains/jobs';
import { calendarBusy, nextOwnerFree, ownerTimeZoneNow, parseWindow } from '../gaps/owner-time';
import { gapBrief, gapText, hashSimilarity, loadProjectCards, matchProjectCard, raisingEvent, type Similarity } from '../gaps/context';
import { ROOT_GAP_ID, findsGaps, needsNextMove, ownerSpoke, parseDue, resolveGapSource, type Gap, type GapStore } from '../gaps/store';
import { renderWithSpeaker, type SpeakerWakeContext } from '../speaker/speaker';
import type { ApprovalStore } from './approvals';
import { PROMOTION_STREAK } from './ledger';
import type { TrustLevel, RpgTurnTrace } from '../types';
import { protectedTargets, RUFUS_REPO_DIR } from './protected';
import { registerReasoningTool } from './reasoning';
import type { ToolRegistry } from './registry';
import { registerRollbackTool } from './rollback';
import { registerSelfUpgrade } from './self-upgrade';
import { registerLocalSearch } from './local-search';
import { archiveSkill } from './versions';

const execFileAsync = promisify(execFile);

export interface BuiltinDeps {
  registry: ToolRegistry;
  approvals?: ApprovalStore;
  gaps?: GapStore;
  watches?: WatchStore;
  brainProvider?: ModelProvider;
  brainModel?: string;
  speakerProvider: ModelProvider;
  speakerModel?: string;
  sink: MessageSink;
  getActiveSink?: () => MessageSink;
  getWakeReceipts: () => readonly Receipt[];
  getCurrentWakeTrace?: () => readonly RpgTurnTrace[];
  getWakeContext?: () => SpeakerWakeContext | undefined;
  /** Logs what Rufus sent, with the channel's messageId so later edits and the Desk can point at it. */
  onSent: (text: string, messageId?: string) => void | Promise<void>;
  /** Updates the logged message after a successful edit, so the log shows what the owner now sees. */
  onEdited?: (messageId: string, text: string) => Promise<void>;
  /** Who wrote a logged message, by its channel messageId (only Rufus's own messages can be edited). */
  messageAuthor?: (messageId: string) => Promise<'rufus' | 'owner' | undefined>;
  /** Scores texts against a query by meaning (the event store's embedder); falls back to a local hash embedder. */
  similarity?: Similarity;
  onApprovalDecision?: (decision: 'approved' | 'denied', toolId: string, approvalId?: string) => Promise<void>;
  searchMemory?: (query: string, opts?: { source?: string; limit?: number }) => Promise<Array<{ event: { id: string; timestamp: string; source: string; kind: string; actor?: string; text: string; deleted?: boolean; reactions?: Array<{ emoji: string; actor?: string }>; provenance?: string; metadata?: Record<string, unknown> }; score: number }>>;
  onSleep: (reason: string) => void;
  /** The owner <-> Rufus conversation since a time (owner messages and what Rufus sent), oldest first. */
  getConversationSince?: (iso: string) => Promise<string[]>;
  /** Told about each brain started as a background job (tests and shutdown wait on them). */
  onBackgroundJob?: (done: Promise<unknown>) => void;
  /** How often send_message refreshes the channel typing indicator while the Speaker writes (default 4000ms). */
  typingRefreshMs?: number;
  /** Speaks text as a voice-note file (local Kokoro TTS); unset means Rufus has no voice for notes. */
  voiceNote?: (text: string) => Promise<{ ok: boolean; path?: string; seconds?: number; error?: string }>;
}

/**
 * Did the owner say anything after the delivery? The delivery is Rufus's last message in the conversation since the gap
 * opened (or the gap's opening, when nothing was sent). Lines are "- [ISO] Owner ..." / "- [ISO] Rufus ...".
 */
export function ownerReactedSinceDelivery(conversation: readonly string[], gapCreatedAt: string): boolean {
  const parsed = conversation.map((l) => /^- \[([^\]]+)\] (Owner|Rufus)\b/.exec(l)).filter((m): m is RegExpExecArray => !!m);
  const delivered = parsed.filter((m) => m[2] === 'Rufus').map((m) => m[1]!).sort().pop() ?? gapCreatedAt;
  return parsed.some((m) => m[2] === 'Owner' && m[1]! > delivered);
}

/** The failed receipt for a draft the truth gate still rejects after its rewrite: nothing was sent. */
function gateRefusal(rendered: { text: string; violations: string[]; blocked: string[] }): ScriptOutput {
  return {
    ok: false,
    summary: `Not sent: the draft still failed the truth gate after a rewrite (${rendered.blocked.join('; ')}). Make the real change first, or ask for a message that says plainly what has not happened yet.`,
    error: 'truth_gate',
    data: { draft: rendered.text, violations: rendered.violations },
  };
}

/** The channel the Speaker writes for when a message is spoken as a voice note. */
const VOICE_NOTE_CHANNEL = 'telegram_voice_note';

/**
 * send_message's result once the voice note went through the ladder: sent, drafted for the owner's yes, or held by its
 * rung. Undefined when it ran and failed, so the words go out as text instead.
 */
function voiceOutcome(spoken: Receipt, rendered: { text: string; rewritten: boolean; violations: string[] }): ScriptOutput | undefined {
  const data = (spoken.data && typeof spoken.data === 'object' ? spoken.data : {}) as { messageId?: string; seconds?: number; rehearsed?: boolean };
  if (spoken.status === 'ok' && !data.rehearsed) {
    return {
      ok: true,
      summary: `Sent the owner a voice note (${data.seconds !== undefined ? `${Math.round(data.seconds)}s, ` : ''}${rendered.text.length} chars${data.messageId ? `, messageId=${data.messageId}` : ''}${rendered.rewritten ? ', rewritten by truth gate' : ''}).`,
      changes: ['sent_message_to_user'],
      data: { ...(data.messageId ? { messageId: data.messageId } : {}), text: rendered.text, voice: true, rewritten: rendered.rewritten, remainingViolations: rendered.violations },
    };
  }
  // Nothing reached the owner, so `text` is left out of data: the Speaker counts only what he was really sent.
  if (spoken.status === 'pending_approval') return { ok: true, summary: `Nothing sent yet: ${spoken.summary}`, data: { draftText: rendered.text } };
  if (data.rehearsed || spoken.error === 'neverAllow' || spoken.error === 'undeclared action') {
    return { ok: false, summary: `Not sent: ${spoken.summary} Send it as text (as: "text") instead.`, error: 'voice_note_held', data: { draftText: rendered.text } };
  }
  return undefined;
}

/** approvals.approve / deny with no draft to act on: the id is wrong, or the draft was already handled. */
const NO_PENDING_APPROVAL =
  'No matching pending approval. Nothing ran. Use an id from "Pending approvals" on the Desk; if none is listed, the draft was already approved or cancelled, so check its receipt or redo the move.';

/** Takes one declared action through the ladder; a context without the ladder (a bare script run) takes none. */
async function step(ctx: ScriptContext, actionId: string, input: Record<string, unknown>): Promise<Receipt> {
  if (ctx.act) return ctx.act(actionId, input);
  return { toolId: actionId, effect: 'write', status: 'failed', durationMs: 0, summary: `${actionId} did not run: this call has no trust ladder to go through.`, changes: [], error: 'no ladder', at: ctx.now.toISOString() };
}

const RUNG_WORDS: Record<TrustLevel, string> = {
  rehearse: 'rehearse (it does not run until the owner raises it)',
  draft: 'draft (each call asks the owner first)',
  act_and_report: 'do and report',
  act_quietly: 'do quietly',
};

/** The starting rung a just-built or repaired tool got, and why. */
function startWords(res: { startLevel?: TrustLevel; evidence?: { testRanTool: boolean; replayWorked: number } }): string {
  if (!res.startLevel) return 'its usual rung';
  const why = res.evidence?.testRanTool
    ? 'its test ran it and it worked'
    : res.evidence?.replayWorked
      ? `${res.evidence.replayWorked} replayed real call(s) worked`
      : 'no test really ran it';
  return `${RUNG_WORDS[res.startLevel]}, because ${why}`;
}

/** brain.investigate and brain.verify: the brain itself wraps up at ~80% of this and returns what it has. */
const READ_BRAIN_TIMEOUT_MS = 120_000;
/** A brain running as a background job has longer: nothing waits on it. */
const BACKGROUND_BRAIN_TIMEOUT_MS = 300_000;
/** Sub-gaps one plan may add. */
const MAX_PLAN_SUBGAPS = 6;

/** Starts a best-effort typing indicator on the sink, refreshed on an interval. Returns a stop function. */
function startTyping(sink: MessageSink, refreshMs: number): () => void {
  if (!sink.sendTyping) return () => undefined;
  const ping = () => {
    Promise.resolve()
      .then(() => sink.sendTyping!())
      .catch((err) => console.error(`typing indicator failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  ping();
  const timer = setInterval(ping, refreshMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Registers the engine's built-in tools: talking, the tool library, memory search, skills, the four brains, gaps, watches, approvals, sleep, startup, rollback and self-upgrade. */
export async function registerBuiltins(deps: BuiltinDeps): Promise<void> {
  const { registry } = deps;
  registry.useTrust(deps.approvals);
  const similarity = deps.similarity ?? hashSimilarity;

  /** Everything the board knows about a gap, handed to a brain so Decide never has to retype it. */
  const gapContextFor = async (gapId: unknown, workspaceDir: string, now: Date, opts: { withOwnerWords?: boolean } = {}): Promise<{ gap?: Gap; brief?: string }> => {
    const id = typeof gapId === 'string' ? gapId.trim() : '';
    const gap = id && deps.gaps ? await deps.gaps.get(id) : undefined;
    if (!gap) return {};
    const card = gap.id === ROOT_GAP_ID ? undefined : await matchProjectCard(await loadProjectCards(workspaceDir), gapText(gap), similarity);
    const ownerWords =
      opts.withOwnerWords !== false && deps.getConversationSince ? (await deps.getConversationSince(gap.createdAt)).filter((l) => /\] Owner\b/.test(l)) : [];
    return { gap, brief: gapBrief({ gap, ...(card ? { card } : {}), ownerWords, now }) };
  };

  /** Starts a brain as a tracked background job tied to the gap; code watches it as the gap's next move. */
  const background = async (
    ctx: ScriptContext,
    gap: Gap,
    toolId: string,
    label: string,
    work: () => Promise<{ summary: string; data?: unknown }>,
  ): Promise<ScriptOutput> => {
    const { job, done } = await startBrainJob({ workspaceDir: ctx.workspaceDir, toolId, gapId: gap.id, label, timeoutMs: BACKGROUND_BRAIN_TIMEOUT_MS, now: ctx.now, work });
    deps.onBackgroundJob?.(done);
    return {
      ok: true,
      summary: `Started ${toolId} as background job ${job.id} for ${gap.id}. Nothing is known from it yet: keep moving on what does not need it (acknowledge the owner, act, message); its result wakes you and is noted on the gap.`,
      changes: [`job_started:${job.id}`],
      data: { jobId: job.id },
      asyncWork: { kind: 'brain_job', threadId: job.id, label },
    };
  };

  /** A gap that is closed or dropped needs no next move: its watches go in the same step. */
  const retireWatchesFor = async (gapId: string): Promise<number> => {
    if (!deps.watches) return 0;
    const retired = await deps.watches.reconcile((w) => {
      if (!servesGap(w, gapId)) return w;
      const others = (w.gapIds ?? []).filter((x) => x !== gapId);
      // A quick return shared with other stranded gaps keeps serving them.
      return others.length ? { ...w, gapId: w.gapId === gapId ? others[0]! : w.gapId, gapIds: others } : null;
    });
    return retired.length;
  };

  await registry.registerInline(
    {
      id: 'send_message',
      version: 1,
      description: "Sends the owner ONE short message for ONE purpose. The Speaker writes it from your purpose and this wake's receipts; a claim no receipt backs is rewritten or blocked, so do the work before saying it is done. Two topics are two messages, on separate turns.",
      whenToUse: ['You have one focused thing to tell or ask the owner (never cram unrelated topics into one message; use separate turns)'],
      effect: 'write',
      requiresApproval: false,
      // Talking to the owner is its own report: there is nothing further to tell him about it.
      defaultTrust: 'act_quietly',
      // It touches only Rufus's own state or the owner himself, and can be undone or corrected.
      reversible: true,
      // Speaking instead of texting, and optional follow-up wait/watch in the same turn, go through the ladder on their own rungs.
      actions: ['talk.voice_note', 'gaps.update', 'watch.set'],
      timeoutMs: 60_000,
      inputSchema: {
        type: 'object',
        properties: {
          purpose: { type: 'string', description: 'Short factual reason for this message (e.g. "announce restart", "answer ticket confirmation question").' },
          as: {
            type: 'string',
            enum: ['text', 'voice'],
            description: 'text (default), or voice: a voice note in your own spoken voice with the words as its caption. Your call, when hearing it lands better than reading (e.g. he sent you a voice note).',
          },
          wait: {
            type: 'object',
            description: 'Optional shortcut: in the SAME turn after sending, mark this gap waiting and/or schedule its next-move timer (saves 1-2 Decide turns).',
            properties: {
              waitingOn: { type: 'string', description: 'Who/what the gap now waits on (e.g. "owner: his reply")' },
              label: { type: 'string', description: 'Short watch label (defaults to waitingOn or purpose)' },
              minutesFromNow: { type: 'number', description: 'Minutes until the next-move timer fires' },
              fireAt: { type: 'string', description: 'ISO timestamp for the next-move timer' },
              waitsOn: { type: 'string', enum: ['owner', 'person', 'job', 'time'] },
              waitsFor: { type: 'string' },
              expect: { type: 'string' },
              atOwnerFree: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        required: ['purpose'],
        additionalProperties: false,
      },
      exampleInput: { purpose: 'Tell the owner I restarted and share the latest update.' },
    },
    async (input, ctx) => {
      const purpose = String(input.purpose ?? '').trim();
      const wakeContext = deps.getWakeContext?.();
      const activeSink = deps.getActiveSink ? deps.getActiveSink() : deps.sink;
      // On a live call every message is already spoken; a voice note needs a channel that takes one.
      const asVoice = input.as === 'voice' && activeSink.channel !== 'voice' && !!activeSink.sendVoice;
      const stopTyping = startTyping(activeSink, deps.typingRefreshMs ?? 4000);
      let rendered: Awaited<ReturnType<typeof renderWithSpeaker>>;
      let sent: Awaited<ReturnType<MessageSink['send']>>;
      let voiceFallback = '';
      try {
        rendered = await renderWithSpeaker({
          workspaceDir: ctx.workspaceDir,
          provider: deps.speakerProvider,
          ...(deps.speakerModel ? { model: deps.speakerModel } : {}),
          purpose,
          receipts: deps.getWakeReceipts(),
          ...(wakeContext ? { wakeContext } : {}),
          ...(asVoice ? { channel: VOICE_NOTE_CHANNEL } : activeSink.channel ? { channel: activeSink.channel } : {}),
          now: ctx.now,
        });
        // A draft that still fails the truth gate after its rewrite is never sent: Decide gets the violations and re-plans.
        if (rendered.blocked.length) return gateRefusal(rendered);
        if (asVoice) {
          const spoken = await step(ctx, 'talk.voice_note', { text: rendered.text });
          const out = voiceOutcome(spoken, rendered);
          if (out) return out;
          // The ladder let it run but no voice note went out (no TTS, a conversion or upload error): the words still go, as text.
          voiceFallback = `; a voice note was asked for but failed (${spoken.summary.slice(0, 160)}), so it went as text`;
        }
        sent = await activeSink.send(rendered.text).catch(async (err: unknown) => {
          await recordOpsFailure(ctx.workspaceDir, { kind: 'send_failed', channel: activeSink.channel, error: err });
          throw err;
        });
      } finally {
        stopTyping();
      }
      const messageId = sent && typeof sent === 'object' ? sent.messageId : undefined;
      // In the log before the next move runs, so an edit right after (or the channel's echo) finds it. The message is out either way.
      await Promise.resolve(deps.onSent(rendered.text, messageId)).catch((err: unknown) =>
        console.error(`logging a sent message failed: ${err instanceof Error ? err.message : String(err)}`),
      );
      const changes = ['sent_message_to_user'];
      const notes: string[] = [];
      const wait = input.wait && typeof input.wait === 'object' ? (input.wait as Record<string, unknown>) : undefined;
      if (wait && ctx.gapId) {
        if (typeof wait.waitingOn === 'string' && wait.waitingOn.trim()) {
          const upd = await step(ctx, 'gaps.update', { gapId: ctx.gapId, status: 'waiting', waitingOn: wait.waitingOn.trim() });
          if (upd.status === 'ok') {
            changes.push(...upd.changes);
            notes.push(`gap marked waiting`);
          } else {
            notes.push(`waiting update failed: ${upd.summary}`);
          }
        }
        if (wait.minutesFromNow !== undefined || wait.fireAt !== undefined) {
          const wIn: Record<string, unknown> = {
            kind: 'timer',
            gapId: ctx.gapId,
            label: typeof wait.label === 'string' && wait.label.trim() ? wait.label.trim() : typeof wait.waitingOn === 'string' && wait.waitingOn.trim() ? wait.waitingOn.trim() : purpose.slice(0, 120),
            ...(wait.minutesFromNow !== undefined ? { minutesFromNow: wait.minutesFromNow } : {}),
            ...(wait.fireAt !== undefined ? { fireAt: wait.fireAt } : {}),
            ...(wait.waitsOn !== undefined ? { waitsOn: wait.waitsOn } : {}),
            ...(wait.waitsFor !== undefined ? { waitsFor: wait.waitsFor } : {}),
            ...(wait.expect !== undefined ? { expect: wait.expect } : {}),
            ...(wait.atOwnerFree !== undefined ? { atOwnerFree: wait.atOwnerFree } : {}),
          };
          const set = await step(ctx, 'watch.set', wIn);
          if (set.status === 'ok') {
            changes.push(...set.changes);
            notes.push(`watch set`);
          } else {
            notes.push(`watch failed: ${set.summary}`);
          }
        }
      }
      return {
        ok: true,
        summary: `Sent message to the owner (${rendered.text.length} chars${messageId ? `, messageId=${messageId}` : ''}${rendered.rewritten ? ', rewritten by truth gate' : ''}${voiceFallback})${notes.length ? `; ${notes.join(', ')}` : ''}.`,
        changes,
        data: { ...(messageId ? { messageId } : {}), text: rendered.text, rewritten: rendered.rewritten, remainingViolations: rendered.violations },
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'talk.voice_note',
      version: 1,
      description: "Speaks a message to the owner as a voice note in Rufus's own voice (local Kokoro TTS), with the words as its caption.",
      whenToUse: ['A step of send_message when Decide picks as: "voice"'],
      effect: 'write',
      requiresApproval: false,
      // Talking to the owner, like a text; the owner can move it on the ladder like any other action.
      defaultTrust: 'act_quietly',
      reversible: true,
      internal: true,
      timeoutMs: 60_000,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The exact words, already written by the Speaker and checked by the truth gate' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const text = String(input.text ?? '').trim();
      const sink = deps.getActiveSink ? deps.getActiveSink() : deps.sink;
      if (!text) return { ok: false, summary: 'Nothing to say.', error: 'empty' };
      if (!sink.sendVoice) return { ok: false, summary: 'This channel cannot take a voice note.', error: 'no_voice_channel' };
      if (!deps.voiceNote) return { ok: false, summary: 'No voice is set up for notes (local TTS missing).', error: 'no_tts' };
      const note = await deps.voiceNote(text);
      if (!note.ok || !note.path) return { ok: false, summary: `Could not make the voice note: ${note.error ?? 'unknown error'}.`, error: 'tts_failed' };
      let sent: Awaited<ReturnType<NonNullable<MessageSink['sendVoice']>>>;
      try {
        sent = await sink.sendVoice(note.path, text);
      } catch (err) {
        await recordOpsFailure(ctx.workspaceDir, { kind: 'send_failed', channel: sink.channel, error: err });
        return { ok: false, summary: `The voice note did not go out: ${(err as Error).message.slice(0, 200)}.`, error: 'send_failed' };
      } finally {
        await fs.rm(note.path, { force: true }).catch(() => undefined);
      }
      const messageId = sent && typeof sent === 'object' ? sent.messageId : undefined;
      // Logged here, not in send_message, so a voice note the owner approved later is logged too.
      await Promise.resolve(deps.onSent(text, messageId)).catch((err: unknown) => console.error(`logging a sent voice note failed: ${(err as Error).message}`));
      return {
        ok: true,
        summary: `Sent a voice note${note.seconds !== undefined ? ` (${Math.round(note.seconds)}s)` : ''}.`,
        changes: ['sent_message_to_user'],
        data: { ...(messageId ? { messageId } : {}), ...(note.seconds !== undefined ? { seconds: note.seconds } : {}), voice: true },
      };
    },
  );

  await registry.registerInline(
    {
      id: 'edit_message',
      version: 1,
      description: 'Edits a previously sent message in place using a Purpose + the current wake context and Receipts.',
      whenToUse: ['You noticed an omission or typo in a message you just sent and have its messageId from the receipt'],
      effect: 'write',
      requiresApproval: false,
      defaultTrust: 'act_quietly',
      // It touches only Rufus's own state or the owner himself, and can be undone or corrected.
      reversible: true,
      timeoutMs: 30_000,
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The messageId returned by send_message' },
          purpose: { type: 'string', description: 'The corrected purpose for this message' },
        },
        required: ['messageId', 'purpose'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const activeSink = deps.getActiveSink ? deps.getActiveSink() : deps.sink;
      if (!activeSink.edit) return { ok: false, summary: 'Not edited: this channel does not support editing messages. Send the correction as a new short message (send_message) instead.', error: 'edit not supported' };
      const messageId = String(input.messageId).trim();
      // Only Rufus's own messages can be edited; the owner's ids sit next to Rufus's on the Desk.
      if ((await deps.messageAuthor?.(messageId)) === 'owner') {
        return { ok: false, summary: `Refused: message ${messageId} is the owner's, not one Rufus sent. Use the messageId of your own message (marked "You (Rufus)" on the Desk, or in the send_message receipt).`, error: 'not_own_message' };
      }
      // Avoid editing the same message over and over in one wake when nothing new was observed since the last edit.
      const prior = deps.getWakeReceipts();
      let lastEditIdx = -1;
      for (let i = prior.length - 1; i >= 0; i--) {
        if (prior[i]?.toolId === 'edit_message' && prior[i]?.status === 'ok' && prior[i]?.changes.includes(`edited_message:${messageId}`)) {
          lastEditIdx = i;
          break;
        }
      }
      if (lastEditIdx >= 0 && !prior.slice(lastEditIdx + 1).some((r) => r.status === 'ok' && r.toolId !== 'edit_message' && r.toolId !== 'send_message')) {
        return {
          ok: false,
          summary: `Refused: you already edited message ${messageId} in this wake and no new facts arrived since. Move on or sleep.`,
          error: 'repeat_edit_without_new_facts',
        };
      }
      const purpose = String(input.purpose ?? '').trim();
      const wakeContext = deps.getWakeContext?.();
      const rendered = await renderWithSpeaker({
        workspaceDir: ctx.workspaceDir,
        provider: deps.speakerProvider,
        ...(deps.speakerModel ? { model: deps.speakerModel } : {}),
        purpose,
        receipts: deps.getWakeReceipts(),
        ...(wakeContext ? { wakeContext } : {}),
        ...(activeSink.channel ? { channel: activeSink.channel } : {}),
        now: ctx.now,
      });
      if (rendered.blocked.length) return gateRefusal(rendered);
      await activeSink.edit(messageId, rendered.text).catch(async (err: unknown) => {
        await recordOpsFailure(ctx.workspaceDir, { kind: 'edit_failed', channel: activeSink.channel, error: err });
        throw err;
      });
      await deps.onEdited?.(messageId, rendered.text).catch(() => undefined);
      return {
        ok: true,
        summary: `Edited message ${messageId} in place.`,
        changes: [`edited_message:${messageId}`],
        data: { messageId, text: rendered.text },
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'react_message',
      version: 1,
      description: "Reacts to one of the owner's messages with a single emoji (e.g. 👍, 🔥, 🫡, 🤔, ⚡) instead of or alongside texting.",
      whenToUse: ['The owner said something brief like "ok", "thanks", "cool" where an emoji reaction is cleaner than a text reply'],
      effect: 'write',
      requiresApproval: false,
      defaultTrust: 'act_quietly',
      // It touches only Rufus's own state or the owner himself, and can be undone or corrected.
      reversible: true,
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: "The owner's messageId, shown on the Desk next to the incoming event and each owner message" },
          emoji: { type: 'string', description: 'A standard Telegram reaction emoji (e.g. 👍, 🔥, ❤️, 🫡, 🤔, ⚡, 🎉)' },
        },
        required: ['messageId', 'emoji'],
        additionalProperties: false,
      },
    },
    async (input) => {
      // The channel this wake talks on, like send_message and edit_message (a voice wake has no message to react to).
      const activeSink = deps.getActiveSink ? deps.getActiveSink() : deps.sink;
      if (!activeSink.react) return { ok: false, summary: 'Not reacted: this channel does not support emoji reactions. Reply with a short send_message if a reply is needed, or skip it.', error: 'react not supported' };
      const messageId = String(input.messageId).trim();
      const emoji = String(input.emoji).trim();
      await activeSink.react(messageId, emoji);
      return {
        ok: true,
        summary: `Reacted with ${emoji} on message ${messageId}.`,
        changes: [`reacted:${messageId}:${emoji}`],
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'tools.list_all',
      version: 1,
      description: 'Lists every registered tool with its effect, approval requirement and description (the Desk shows every id, but only some in full).',
      whenToUse: ['A tool in the Desk\'s tool index might fit, but its description is not shown in full on the Desk'],
      effect: 'read',
      requiresApproval: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const list = registry.list().filter((m) => !m.internal).map((m) => ({
        id: m.id,
        effect: m.effect,
        requiresApproval: m.requiresApproval,
        description: m.description,
        inputs: Object.keys(m.inputSchema.properties ?? {}),
        required: m.inputSchema.required ?? [],
      }));
      return {
        ok: true,
        summary: `Listed ${list.length} registered tool(s).`,
        data: list,
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'tools.create',
      version: 1,
      description:
        'Pioneer tool: creates a new packaged script (tool.json + run.mjs + test.mjs), runs test.mjs, and activates it if tests pass. The new tool starts at draft (asks the owner) when test.mjs really calls run() and gets ok back, else at rehearse.',
      whenToUse: ['You need a repeatable deterministic capability that no existing tool provides'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          manifest: { type: 'object', description: 'Valid tool.json object' },
          runCode: { type: 'string', description: 'ESM source for run.mjs exporting async function run(input, ctx)' },
          testCode: { type: 'string', description: 'ESM test script for test.mjs (exits 0 on pass)' },
        },
        required: ['manifest', 'runCode', 'testCode'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const res = await registry.createOrRepair({
        manifest: input.manifest as ToolManifest,
        runCode: String(input.runCode),
        testCode: String(input.testCode),
        tag: { reason: 'tools.create', now: ctx.now, ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}), ...(ctx.gapId ? { gapId: ctx.gapId } : {}) },
      });
      if (!res.ok) return { ok: false, summary: `Tool creation failed: ${res.error}`, error: res.error };
      const id = (input.manifest as ToolManifest).id;
      return {
        ok: true,
        summary: `Created, tested, and embedded new packaged script "${id}". It starts at ${startWords(res)}.`,
        changes: [`tool_created:${id}`],
        data: { id, testOutput: res.testOutput, startLevel: res.startLevel, evidence: res.evidence },
        nextHints: [id],
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'tools.repair',
      version: 1,
      description:
        "Repairs a broken packaged script, re-runs test.mjs and replays its real past calls, and reactivates it if they pass. The repaired tool goes back to draft (asks the owner) when its test really ran it or a replayed real call worked, else to rehearse.",
      whenToUse: ['A script returned a brokenWarning or failed due to a bug or API change'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          manifest: { type: 'object', description: 'Updated tool.json object' },
          runCode: { type: 'string', description: 'Fixed ESM source for run.mjs' },
          testCode: { type: 'string', description: 'Updated test.mjs' },
        },
        required: ['manifest', 'runCode', 'testCode'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const res = await registry.createOrRepair({
        manifest: input.manifest as ToolManifest,
        runCode: String(input.runCode),
        testCode: String(input.testCode),
        tag: { reason: 'tools.repair', now: ctx.now, ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}), ...(ctx.gapId ? { gapId: ctx.gapId } : {}) },
      });
      if (!res.ok) return { ok: false, summary: `Tool repair failed: ${res.error}`, error: res.error };
      const id = (input.manifest as ToolManifest).id;
      return {
        ok: true,
        summary: `Repaired, tested, and reactivated packaged script "${id}". It is back at ${startWords(res)}.${res.replaced ? ` Previous version kept (${res.replaced}); tools.rollback restores it.` : ''}`,
        changes: [`tool_repaired:${id}`],
        data: { id, testOutput: res.testOutput, startLevel: res.startLevel, evidence: res.evidence },
        nextHints: [id],
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'memory.search',
      version: 1,
      description: 'Semantically searches Rufus\'s automatic real-world event memory (past messages, emails, calendar, screen/browser activity, and actions). Read-only — memory is recorded automatically by code.',
      whenToUse: ['You want to recall something from earlier conversations, messages, emails, or activity that is not already in the top wake context'],
      effect: 'read',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query (semantic meaning, not just exact keywords)' },
          source: { type: 'string', description: 'Optional source filter (e.g. "message", "email", "calendar", "screen", "browser", "download", "webhook")' },
          limit: { type: 'number', description: 'Max events to return (default 8, max 20)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      exampleInput: { query: 'Alex chat handle', limit: 6 },
    },
    async (input) => {
      if (!deps.searchMemory) return { ok: false, summary: 'Memory search is not configured.', error: 'searchMemory missing' };
      const query = String(input.query ?? '').trim();
      const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : undefined;
      const limit = Math.max(1, Math.min(20, Number(input.limit ?? 8) || 8));
      // The event that woke Rufus (and anything that arrived mid-wake) is already on the Desk; recall should find something new.
      const wake = deps.getWakeContext?.();
      const onDesk = new Set([wake?.trigger?.id, ...(wake?.arrivals ?? []).map((a) => a.id)].filter(Boolean));
      const hits = (await deps.searchMemory(query, { ...(source ? { source } : {}), limit: limit + onDesk.size })).filter((h) => !onDesk.has(h.event.id)).slice(0, limit);
      const rows = hits.map((h) => ({
        id: h.event.id,
        timestamp: h.event.timestamp,
        source: h.event.source,
        kind: h.event.kind,
        ...(h.event.actor ? { actor: h.event.actor } : {}),
        // Whose word it is: a Rufus claim is not proof, and a superseded one was contradicted.
        ...(h.event.provenance ? { provenance: h.event.provenance } : {}),
        ...(typeof h.event.metadata?.supersededBy === 'string' ? { supersededBy: h.event.metadata.supersededBy } : {}),
        text: h.event.text,
        ...(h.event.deleted ? { deleted: true } : {}),
        score: Number(h.score.toFixed(3)),
      }));
      return {
        ok: true,
        summary: `Found ${rows.length} memory event(s) matching "${query}".`,
        data: rows,
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'skills.save',
      version: 2,
      description: 'Replaces one brain skill (DECIDE, INVESTIGATE, PLAN, CREATE, VERIFY) in skills/<STATE>.md with `content`. It overwrites the whole file, so send the full skill with your change in it, not just the new part. The old version is kept for tools.rollback.',
      whenToUse: ['Refining how a specific brain state operates (never spawn one-off micro-skill files)'],
      effect: 'write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['DECIDE', 'INVESTIGATE', 'PLAN', 'CREATE', 'VERIFY'], description: 'Which brain-state skill to update' },
          content: { type: 'string', description: 'The complete new skill in markdown (it replaces the whole file)' },
        },
        required: ['state', 'content'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const state = String(input.state).toUpperCase() as BrainStateName;
      const dir = path.join(ctx.workspaceDir, 'skills');
      await fs.mkdir(dir, { recursive: true });
      const kept = await archiveSkill(dir, state, { at: ctx.now, reason: 'skills.save', ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}), ...(ctx.gapId ? { gapId: ctx.gapId } : {}) });
      await fs.writeFile(path.join(dir, `${state}.md`), `${String(input.content).trim()}\n`, 'utf8');
      return {
        ok: true,
        summary: `Replaced brain skill skills/${state}.md.${kept ? ` Previous version kept as skills/.history/${kept}.md (tools.rollback restores it).` : ''}`,
        changes: [`skill_saved:${state}`],
      };
    },
    { alwaysVisible: true },
  );

  // --- 4 Fresh-Context Narrow Brain-State AI Tools (Investigate, Plan, Create, Verify) ---

  await registry.registerInline(
    {
      id: 'brain.investigate',
      version: 1,
      description: 'Fresh-context READ-ONLY detective: inspects real files, logs, tools, or memory to answer ONE specific question and return verified facts + unknowns (never writes or guesses). Its facts are noted on the gap (gaps.note).',
      whenToUse: ['You do not yet have verified facts or the root cause for a gap or an owner request'],
      effect: 'read',
      requiresApproval: false,
      actions: ['gaps.note'],
      timeoutMs: READ_BRAIN_TIMEOUT_MS,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The exact question to investigate from reality' },
          gapId: { type: 'string', description: "The gap it serves (filled in from the move's gap): the brain gets its target, reality, work log, project card and the owner's words, and its facts are saved on the gap" },
          maxSteps: { type: 'number', description: 'Max read-only steps (default 5, max 8)' },
          background: { type: 'boolean', description: "Run as a tracked background job tied to the gap: you keep moving (acknowledge, message, act) and its result wakes you and lands on the gap. Counts as the gap's next move." },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const { gap, brief } = await gapContextFor(input.gapId, ctx.workspaceDir, ctx.now);
      const question = String(input.question ?? '').trim();
      const investigate = async (timeoutMs: number) => {
        const res = await runInvestigateBrain({
          workspaceDir: ctx.workspaceDir,
          provider,
          ...(deps.brainModel ? { model: deps.brainModel } : {}),
          registry,
          question,
          ...(brief ? { gapContext: brief } : {}),
          ...(input.maxSteps ? { maxSteps: Number(input.maxSteps) } : {}),
          timeoutMs,
          now: ctx.now,
        });
        // What was found belongs to the gap, so the next wake (and the next brain) starts from it.
        if (gap && res.facts.length) await step(ctx, 'gaps.note', { gapId: gap.id, findings: res.facts.map((f) => f.slice(0, 400)) });
        return res;
      };
      if (input.background === true) {
        if (!gap) return { ok: false, summary: 'Refused: a background investigation needs the gap it serves, so its result has somewhere to land.', error: 'no gap' };
        return background(ctx, gap, 'brain.investigate', `Investigate: ${question.slice(0, 160)}`, async () => {
          const res = await investigate(BACKGROUND_BRAIN_TIMEOUT_MS);
          return { summary: `${res.partial ? '[PARTIAL] ' : ''}${res.summary} Facts: ${res.facts.join(' | ').slice(0, 1500)}`, data: res };
        });
      }
      const res = await investigate(READ_BRAIN_TIMEOUT_MS);
      return { ok: true, summary: `${res.partial ? '[PARTIAL] ' : ''}${res.summary}`, data: res };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'brain.plan',
      version: 1,
      description: "Fresh-context strategist: breaks a big Gap + verified facts into concrete, verifiable Sub-Gaps, options, and tradeoffs (does not execute anything). Its sub-gaps are saved under the planned gap (gaps.create): under a gap the owner approved they open at once, since they serve it.",
      whenToUse: ['A Gap is too big or fuzzy for one action and needs concrete Sub-Gaps, options, or a plan'],
      effect: 'read',
      requiresApproval: false,
      actions: ['gaps.note', 'gaps.create'],
      timeoutMs: 90_000,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The Gap/goal to break down' },
          verifiedFacts: { type: 'string', description: "Observed facts from Investigate / Receipts (the gap's saved facts are added automatically)" },
          constraints: { type: 'string', description: 'Optional constraints (budget, trust, timeline)' },
          gapId: { type: 'string', description: "The gap being planned (filled in from the move's gap): the planner gets everything the board knows about it" },
        },
        required: ['goal'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const { gap, brief } = await gapContextFor(input.gapId, ctx.workspaceDir, ctx.now);
      const plan = await runPlanBrain({
        workspaceDir: ctx.workspaceDir,
        provider,
        ...(deps.brainModel ? { model: deps.brainModel } : {}),
        goal: String(input.goal ?? '').trim(),
        verifiedFacts: String(input.verifiedFacts ?? '').trim(),
        ...(typeof input.constraints === 'string' && input.constraints.trim() ? { constraints: input.constraints.trim() } : {}),
        ...(brief ? { gapContext: brief } : {}),
      });
      if (gap && plan.recommendation) await step(ctx, 'gaps.note', { gapId: gap.id, findings: [`Plan: ${String(plan.recommendation).slice(0, 300)}`] });
      // The plan's sub-gaps become real children of the planned gap, so the tree is a tree.
      const saved: string[] = [];
      if (gap && gap.status !== 'closed' && gap.status !== 'dropped' && Array.isArray(plan.subGaps)) {
        for (const sub of (plan.subGaps as Array<Record<string, unknown>>).slice(0, MAX_PLAN_SUBGAPS)) {
          const title = typeof sub?.title === 'string' ? sub.title.trim() : '';
          const target = typeof sub?.target === 'string' ? sub.target.trim() : '';
          if (!title || !target) continue;
          const made = await step(ctx, 'gaps.create', {
            title,
            target,
            parentId: gap.id,
            source: 'observed',
            ...(typeof sub.firstMove === 'string' && sub.firstMove.trim() ? { reality: `Not started. First move: ${sub.firstMove.trim().slice(0, 200)}` } : {}),
          });
          const g = made.data as Gap | undefined;
          if (made.status === 'ok' && g?.id) saved.push(`${g.id} [${g.status}] ${g.title}`);
        }
      }
      return {
        ok: true,
        summary: `${String(plan.recommendation || 'Produced top-down plan and Sub-Gaps.')}${saved.length ? ` Saved ${saved.length} sub-gap(s) under ${gap!.id}: ${saved.join('; ')}.` : ''}`,
        ...(saved.length ? { changes: saved.map((s) => `gap_created:${s.split(' ')[0]}`) } : {}),
        data: plan,
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'brain.create',
      version: 1,
      description: 'Fresh-context builder: produces one concrete non-code work artifact (lesson, copy, script, spec, draft) saved to drafts/<slug>.md.',
      whenToUse: ['A Sub-Gap requires creating a real written artifact grounded in verified facts'],
      effect: 'write',
      requiresApproval: false,
      actions: ['gaps.note'],
      timeoutMs: 90_000,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Artifact title' },
          brief: { type: 'string', description: 'Exact requirements for what to create' },
          verifiedFacts: { type: 'string', description: "Verified facts to ground the artifact in (the gap's saved facts are added automatically)" },
          slug: { type: 'string', description: 'Optional filename slug' },
          gapId: { type: 'string', description: "The gap it serves (filled in from the move's gap): the builder gets the target, reality, work log, project card and the owner's words" },
          background: { type: 'boolean', description: "Write it as a tracked background job tied to the gap: you keep moving, and the finished draft wakes you. Counts as the gap's next move." },
        },
        required: ['title', 'brief'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const { gap, brief } = await gapContextFor(input.gapId, ctx.workspaceDir, ctx.now);
      const create = async () => {
        const res = await runCreateBrain({
          workspaceDir: ctx.workspaceDir,
          provider,
          ...(deps.brainModel ? { model: deps.brainModel } : {}),
          title: String(input.title ?? '').trim(),
          brief: String(input.brief ?? '').trim(),
          verifiedFacts: String(input.verifiedFacts ?? '').trim(),
          ...(typeof input.slug === 'string' ? { slug: input.slug } : {}),
          ...(brief ? { gapContext: brief } : {}),
        });
        if (gap) await step(ctx, 'gaps.note', { gapId: gap.id, findings: [`Draft written: ${res.path} (${res.chars} chars)`] });
        return res;
      };
      if (input.background === true) {
        if (!gap) return { ok: false, summary: 'Refused: a background draft needs the gap it serves, so its result has somewhere to land.', error: 'no gap' };
        return background(ctx, gap, 'brain.create', `Create: ${String(input.title ?? '').slice(0, 120)}`, async () => {
          const res = await create();
          return { summary: `Created artifact ${res.path} (${res.chars} chars). Chat-length version: ${res.chat}`, data: res };
        });
      }
      const res = await create();
      return {
        ok: true,
        summary: `Created artifact ${res.path} (${res.chars} chars). The full content and a chat-length version are in data.content and data.chat.`,
        changes: [`created_draft:${res.path}`],
        data: res,
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'brain.verify',
      version: 1,
      description:
        "Fresh-context reality checker: checks a gap's own Target (what the owner wants true) directly against reality using read-only tools, and returns PASS/FAIL + proof. The check is a read; on PASS it takes the gaps.close action, the ONLY way a gap closes, on that action's own trust rung (an owner-facing deliverable can close once it is delivered and checkable). The owner's words are evidence; Rufus's messages are only claims. When the outcome hinges on the owner's reaction and he has not reacted, the gap waits on the owner (gaps.update) and its next move is a chase: silence is never done. Every deliverable is also checked against the owner's standing gaps.",
      whenToUse: ['You think a gap is closed and want it checked against reality'],
      effect: 'read',
      requiresApproval: false,
      actions: ['gaps.note', 'gaps.close', 'gaps.update'],
      timeoutMs: READ_BRAIN_TIMEOUT_MS,
      inputSchema: {
        type: 'object',
        properties: {
          gapId: { type: 'string', description: "Gap to verify (filled in from the move's gap). Its stored Target is what gets checked; it is closed by code ONLY if verification PASSES." },
          target: { type: 'string', description: 'Only when verifying something that is not a gap: the exact end-state to check' },
          maxSteps: { type: 'number', description: 'Max read-only check steps (default 5, max 8)' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const provider = deps.brainProvider ?? deps.speakerProvider;
      const gapId = typeof input.gapId === 'string' && input.gapId.trim() ? input.gapId.trim() : undefined;
      const gap = gapId && deps.gaps ? await deps.gaps.get(gapId) : undefined;
      // A gap is checked against its OWN stored target, never an easier claim written in the moment.
      const target = gap ? gap.target : String(input.target ?? '').trim();
      if (!target) return { ok: false, summary: 'Nothing to verify: name a gap (or give a target).', error: 'no target' };
      const conversation = gap && deps.getConversationSince ? await deps.getConversationSince(gap.createdAt) : [];
      // The conversation is already step 0, so the rest of the brief leaves the owner's words out.
      const { brief } = gap ? await gapContextFor(gap.id, ctx.workspaceDir, ctx.now, { withOwnerWords: false }) : {};
      // The owner's lasting preferences: every deliverable is checked against them.
      const standing = deps.gaps
        ? (await deps.gaps.unclosed())
            .filter((g) => g.standing && g.id !== gap?.id)
            .map((g) => `- ${g.id} ${g.title}: ${g.target}`)
            .join('\n')
        : '';
      const res = await runVerifyBrain({
        workspaceDir: ctx.workspaceDir,
        provider,
        ...(deps.brainModel ? { model: deps.brainModel } : {}),
        registry,
        target,
        ...(conversation.length
          ? {
              context: `Owner <-> Rufus conversation, from the owner message that opened this gap to now. The owner's own words are evidence of what he wants and whether it is met. Rufus's messages are claims: they show only that they were sent and what they said.\n${conversation.join('\n')}`,
            }
          : {}),
        ...(standing ? { standing } : {}),
        ...(brief ? { gapContext: brief } : {}),
        ...(gap?.due ? { due: gap.due } : {}),
        ...(input.maxSteps ? { maxSteps: Number(input.maxSteps) } : {}),
        timeoutMs: READ_BRAIN_TIMEOUT_MS,
        now: ctx.now,
      });
      let closedGap = false;
      let closeNote = '';
      // Silence is never a yes: an outcome that hinges on the owner's reaction is not met until he reacts after the delivery.
      const awaitingOwner = !!gap && res.passed && res.hingesOnOwner && !ownerReactedSinceDelivery(conversation, gap.createdAt);
      if (awaitingOwner) res.passed = false;
      if (gap) {
        // What was checked, and the receipt behind each criterion, stays on the gap (bookkeeping, through the ladder).
        const verifyId = `verify_${ctx.now.getTime()}`;
        await step(ctx, 'gaps.note', {
          gapId: gap.id,
          lastVerify: {
            id: verifyId,
            at: ctx.now.toISOString(),
            passed: res.passed,
            criteria: res.criteria,
            ...(awaitingOwner ? { awaitingOwner: true, remaining: "Delivered; whether it is what he wanted hinges on the owner's reaction, and he has not reacted yet." } : res.remaining ? { remaining: res.remaining } : {}),
          },
          evidence: [verifyId],
          // The root gap never closes; a passing check only refreshes its reality.
          ...(res.passed && gap.id === ROOT_GAP_ID ? { reality: res.evidence } : {}),
        });
        if (res.passed && gap.id !== ROOT_GAP_ID) {
          // Checking is a read; closing is an action on its own rung (default: close and tell the owner).
          const close = await step(ctx, 'gaps.close', { gapId: gap.id, verifyId, evidence: res.evidence.slice(0, 2000) });
          closedGap = close.status === 'ok' && close.changes.includes(`gap_closed:${gap.id}`);
          closeNote = ` | close: ${close.summary}`;
        }
        if (awaitingOwner && gap.status !== 'waiting') {
          const wait = await step(ctx, 'gaps.update', { gapId: gap.id, status: 'waiting', waitingOn: "owner: his reaction to what was delivered (is it what he wanted?)" });
          closeNote = ` | ${wait.status === 'ok' ? 'now waiting on the owner' : `not marked waiting: ${wait.summary}`}`;
        }
      }
      if (awaitingOwner) {
        return {
          ok: true,
          summary: `Verify AWAITING OWNER for ${gap!.id}: delivered (${res.evidence.slice(0, 300)}), but whether it is what he wanted hinges on his reaction, and he has not reacted since. Silence is not a yes. Next move: chase him (watch.set waitsOn=owner, expect his verdict), a different way than last time.${closeNote}`,
          data: { ...res, gapId: gap!.id, closedGap: false, awaitingOwner: true },
          nextHints: ['watch.set'],
        };
      }
      return {
        ok: true,
        summary: `Verify ${res.passed ? 'PASS' : 'FAIL'}${gap ? ` for ${gap.id}` : ''}: ${res.evidence}${!res.passed && res.remaining ? ` | still off: ${res.remaining}` : ''}${closeNote}`,
        data: { ...res, ...(gapId ? { gapId, closedGap } : {}) },
      };
    },
    { alwaysVisible: true },
  );

  // --- Gap tree tools ---

  await registry.registerInline(
    {
      id: 'gaps.create',
      version: 1,
      description:
        "Adds a gap to the tree under parentId (filled in from the move's gap; top-level gaps hang off the root). Gaps the owner states start `open`; new gaps Rufus spots start `proposed` until the owner says yes; a sub-gap of a gap the owner approved starts `open`. standing=true makes one of the owner's lasting preferences or boundaries: it never closes, every deliverable is checked against it, and its window says when it applies.",
      whenToUse: ['A desired state of the owner needs its own gap', 'A gap is too big and needs splitting into smaller gaps'],
      effect: 'write',
      requiresApproval: false,
      // Rufus's own board: bookkeeping, on the ladder like everything else.
      defaultTrust: 'act_quietly',
      // It touches only Rufus's own state or the owner himself, and can be undone or corrected.
      reversible: true,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short concrete gap title' },
          target: { type: 'string', description: "What the owner wants true, in the owner's own words and context; brain.verify checks exactly this" },
          reality: { type: 'string', description: 'What is true now (from Receipts / Investigate)' },
          source: { type: 'string', enum: ['owner', 'observed'], description: 'owner (the owner asked for it) or observed (spotted by Rufus)' },
          parentId: { type: 'string', description: "Parent gap (filled in from the move's gap)" },
          due: { type: 'string', description: "ISO time the owner wants it true by, only when the owner's words give a by-when (e.g. \"by Friday\" -> that Friday's end in the owner's time zone)" },
          standing: { type: 'boolean', description: "A lasting preference or boundary of the owner's that never closes (\"short replies\", \"off devices at bedtime\")" },
          window: { type: 'string', description: 'Standing gaps only: when it applies, in the owner\'s local time: "21:15-06:00" daily, or "Fri 17:00-Sat 19:00" weekly' },
          sensedBy: { type: 'array', items: { type: 'string' }, description: 'Senses whose latest events are its reality: a source ("screen") or source/kind ("message/assistant_sent")' },
        },
        required: ['title', 'target'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'The gap tree is not configured.', error: 'no gap store' };
      const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : undefined;
      if (parentId && !(await deps.gaps.exists(parentId))) {
        return { ok: false, summary: `Refused: there is no gap ${parentId} to put this under. Use a gap id from the tree (or leave parentId out for a top-level gap). Nothing saved.`, error: 'unknown parent' };
      }
      if (typeof input.window === 'string' && input.window.trim() && !parseWindow(input.window)) {
        return { ok: false, summary: `Refused: window "${input.window}" is not a window. Use "21:15-06:00" (daily) or "Fri 17:00-Sat 19:00" (weekly), in the owner's local time. Nothing saved.`, error: 'bad window' };
      }
      const wake = deps.getWakeContext?.();
      const trigger = wake?.trigger;
      const source = resolveGapSource(input.source, ownerSpoke(trigger, wake?.arrivals));
      // The gap points at the message that raised it, which may have arrived mid-wake rather than being the trigger.
      const raisedBy = await raisingEvent({ spec: { title: String(input.title), target: String(input.target) }, ...(trigger ? { trigger } : {}), arrivals: wake?.arrivals ?? [], similarity });
      const gap = await deps.gaps.create({
        title: String(input.title),
        target: String(input.target),
        reality: typeof input.reality === 'string' ? input.reality : 'Not measured yet.',
        source,
        ...(parentId ? { parentId } : {}),
        ...(raisedBy?.id ? { evidenceIds: [raisedBy.id] } : {}),
        ...(parseDue(input.due) ? { due: parseDue(input.due)! } : {}),
        ...(input.standing === true ? { standing: true } : {}),
        ...(input.standing === true && typeof input.window === 'string' ? { window: input.window } : {}),
        ...(Array.isArray(input.sensedBy) ? { sensedBy: input.sensedBy.map(String) } : {}),
        now: ctx.now,
      });
      return {
        ok: true,
        summary: `Added ${gap.standing ? 'standing ' : ''}Gap ${gap.id} [${gap.status}]: ${gap.title}`,
        changes: [`gap_created:${gap.id}`],
        data: gap,
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'gaps.approve',
      version: 1,
      description: 'Promotes a `proposed` observed Gap to `open` after the owner approves it directly.',
      whenToUse: ['The owner said yes to a proposed gap on the gap tree'],
      effect: 'write',
      requiresApproval: false,
      defaultTrust: 'act_quietly',
      // It touches only Rufus's own state or the owner himself, and can be undone or corrected.
      reversible: true,
      inputSchema: {
        type: 'object',
        properties: { gapId: { type: 'string', description: 'Gap ID to promote to open' } },
        required: ['gapId'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'The gap tree is not configured.', error: 'no gap store' };
      const wake = deps.getWakeContext?.();
      if (!ownerSpoke(wake?.trigger, wake?.arrivals)) {
        return { ok: false, summary: 'Refused: only the owner can approve a proposed Gap.', error: 'owner_direct required' };
      }
      const g = await deps.gaps.approve(String(input.gapId).trim(), ctx.now);
      if (!g) return { ok: false, summary: `Gap ${input.gapId} not found. Nothing changed. Use a gap id from the gap tree on the Desk.`, error: 'not found' };
      return { ok: true, summary: `Gap ${g.id} is now open: ${g.title}`, changes: [`gap_opened:${g.id}`], data: g };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'gaps.update',
      version: 1,
      description: "Updates a gap's reality or target, reopens a closed gap (status=open), marks it waiting on someone (status=waiting + waitingOn; it still needs a scheduled next move), or drops it when the owner says it's not wanted (status=dropped). A new target is its own action (gaps.retarget) on its own trust rung. Cannot close a gap; only a passing brain.verify can. A proposed gap opens only through gaps.approve.",
      whenToUse: ['New reality on a gap', "The owner's words show a closed gap is not done: reopen it with status=open", 'A gap is blocked on someone: status=waiting + waitingOn, then schedule the chase', 'The owner declined a gap or said it no longer matters: status=dropped'],
      effect: 'write',
      requiresApproval: false,
      defaultTrust: 'act_quietly',
      // It touches only Rufus's own state or the owner himself, and can be undone or corrected.
      reversible: true,
      actions: ['gaps.retarget'],
      inputSchema: {
        type: 'object',
        properties: {
          gapId: { type: 'string' },
          reality: { type: 'string' },
          target: { type: 'string' },
          status: { type: 'string', enum: ['open', 'waiting', 'dropped'] },
          waitingOn: { type: 'string', description: 'What this Gap is waiting on (empty string clears it)' },
          due: { type: 'string', description: "ISO time the owner wants it true by, from the owner's words (empty string clears it)" },
          areas: { type: 'array', items: { type: 'string' }, description: "Root only, from the owner's words: his life areas, which the root checks its coverage against" },
          window: { type: 'string', description: 'Standing gaps: when it applies ("21:15-06:00" or "Fri 17:00-Sat 19:00"; empty clears it)' },
          sensedBy: { type: 'array', items: { type: 'string' }, description: 'Senses whose latest events are its reality' },
        },
        required: ['gapId'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'The gap tree is not configured.', error: 'no gap store' };
      const current = await deps.gaps.get(String(input.gapId).trim());
      if (current?.status === 'proposed' && (input.status === 'open' || input.status === 'waiting')) {
        return { ok: false, summary: `Refused: ${current.id} is proposed; it opens only when the owner says yes (gaps.approve).`, error: 'needs owner approval' };
      }
      if (input.status === 'dropped' || Array.isArray(input.areas)) {
        // Dropping what the owner wants, or changing which areas of his life the root covers, is his call.
        const wake = deps.getWakeContext?.();
        if (!ownerSpoke(wake?.trigger, wake?.arrivals)) {
          return {
            ok: false,
            summary: input.status === 'dropped' ? 'Refused: only the owner can drop a gap. If it no longer seems needed, ask the owner.' : "Refused: only the owner says which areas of his life the root covers. Ask him.",
            error: 'owner_direct required',
          };
        }
      }
      if (typeof input.window === 'string' && input.window.trim() && !parseWindow(input.window)) {
        return { ok: false, summary: `Refused: window "${input.window}" is not a window ("21:15-06:00" or "Fri 17:00-Sat 19:00"). Nothing changed.`, error: 'bad window' };
      }
      // The target is what the owner wants true and what brain.verify checks: changing it is its own action.
      const retarget = typeof input.target === 'string' ? await step(ctx, 'gaps.retarget', { gapId: String(input.gapId).trim(), target: input.target }) : undefined;
      const g = await deps.gaps.update(
        String(input.gapId).trim(),
        {
          ...(typeof input.reality === 'string' ? { reality: input.reality } : {}),
          ...(input.status === 'open' || input.status === 'waiting' || input.status === 'dropped' ? { status: input.status } : {}),
          ...(typeof input.waitingOn === 'string' ? { waitingOn: input.waitingOn.trim() || null } : {}),
          ...(typeof input.due === 'string' ? { due: input.due.trim() ? input.due : null } : {}),
          ...(Array.isArray(input.areas) ? { areas: input.areas.map(String) } : {}),
          ...(typeof input.window === 'string' ? { window: input.window.trim() ? input.window : null } : {}),
          ...(Array.isArray(input.sensedBy) ? { sensedBy: input.sensedBy.map(String) } : {}),
        },
        ctx.now,
      );
      if (!g) return { ok: false, summary: `Gap ${input.gapId} not found. Nothing changed. Use a gap id from the gap tree on the Desk.`, error: 'not found' };
      const retired = g.status === 'dropped' ? await retireWatchesFor(g.id) : 0;
      return {
        ok: true,
        summary: `Updated Gap ${g.id} [${g.status}]${retired ? `; retired ${retired} watch(es) that served it` : ''}.${retarget ? ` Target: ${retarget.summary}` : ''}`,
        changes: [`gap_updated:${g.id}`],
        data: g,
      };
    },
    { alwaysVisible: true },
  );

  // --- Gap actions: steps other tools (and the engine) take through the ladder, never moves Decide picks itself ---

  await registry.registerInline(
    {
      id: 'gaps.note',
      version: 1,
      description: "Rufus's notes on a gap: facts found, drafts made, the latest verification, the root gap's refreshed reality, a move's work-log entry, its quick-return count.",
      whenToUse: ['A step of brain.investigate / plan / create / verify, or of the engine after each move'],
      effect: 'write',
      requiresApproval: false,
      defaultTrust: 'act_quietly',
      // It touches only Rufus's own state or the owner himself, and can be undone or corrected.
      reversible: true,
      internal: true,
      inputSchema: {
        type: 'object',
        properties: {
          gapId: { type: 'string' },
          findings: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'string' } },
          lastVerify: { type: 'object', description: 'The latest verification record' },
          reality: { type: 'string', description: "The root gap's reality, refreshed by a passing check" },
          log: { type: 'object', description: "One move's work-log entry" },
          resumeAttempts: { type: 'number', description: 'Quick returns in a row (0 clears it)' },
          misses: { type: 'number', description: 'Moves in a row that missed what they expected (0 clears it)' },
          coverage: { type: 'object', description: "Root only: a look at one of the owner's life areas ({area, note})" },
        },
        required: ['gapId'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'The gap tree is not configured.', error: 'no gap store' };
      const gapId = String(input.gapId).trim();
      if (!(await deps.gaps.get(gapId))) return { ok: false, summary: `Gap ${gapId} not found. Nothing noted.`, error: 'not found' };
      const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
      const attempts = typeof input.resumeAttempts === 'number' ? (input.resumeAttempts > 0 ? input.resumeAttempts : null) : undefined;
      await deps.gaps.annotate(gapId, {
        ...(strings(input.findings).length ? { addFindings: strings(input.findings) } : {}),
        ...(strings(input.evidence).length ? { addEvidence: strings(input.evidence) } : {}),
        ...(input.lastVerify && typeof input.lastVerify === 'object' ? { lastVerify: input.lastVerify as NonNullable<Gap['lastVerify']> } : {}),
        ...(attempts !== undefined ? { resumeAttempts: attempts } : {}),
        ...(typeof input.misses === 'number' ? { misses: input.misses > 0 ? input.misses : null } : {}),
        ...(input.coverage && typeof input.coverage === 'object' && typeof (input.coverage as { area?: unknown }).area === 'string'
          ? { coverage: { area: String((input.coverage as { area: string }).area), note: String((input.coverage as { note?: unknown }).note ?? ''), at: ctx.now.toISOString() } }
          : {}),
      });
      if (input.log && typeof input.log === 'object') await deps.gaps.appendLog(gapId, input.log as NonNullable<Gap['log']>[number]);
      if (typeof input.reality === 'string' && gapId === ROOT_GAP_ID) await deps.gaps.update(gapId, { reality: input.reality }, ctx.now);
      return { ok: true, summary: `Noted on ${gapId}.`, changes: [`gap_noted:${gapId}`] };
    },
  );

  await registry.registerInline(
    {
      id: 'gaps.close',
      version: 1,
      description: "Closes a gap after a passing brain.verify (the step brain.verify takes on PASS). Refused unless the gap's latest verification is that passing check and nothing about the gap changed since. Its watches retire in the same step.",
      whenToUse: ['A step of brain.verify when the check passes'],
      effect: 'write',
      requiresApproval: false,
      // Close and tell the owner, unless he moves it (e.g. to act_quietly) in trust.json.
      defaultTrust: 'act_and_report',
      // A closed gap reopens and a target can be set back, so the owner may let this go quiet.
      reversible: true,
      internal: true,
      inputSchema: {
        type: 'object',
        properties: {
          gapId: { type: 'string' },
          verifyId: { type: 'string', description: 'The passing check this close rests on' },
          evidence: { type: 'string', description: "The check's proof; it becomes the gap's reality" },
        },
        required: ['gapId', 'verifyId', 'evidence'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'The gap tree is not configured.', error: 'no gap store' };
      const gapId = String(input.gapId).trim();
      const verifyId = String(input.verifyId).trim();
      const gap = await deps.gaps.get(gapId);
      if (!gap) return { ok: false, summary: `Gap ${gapId} not found. Nothing closed.`, error: 'not found' };
      if (gap.id === ROOT_GAP_ID) return { ok: false, summary: 'The root gap never closes.', error: 'root' };
      if (gap.standing) return { ok: false, summary: `${gapId} is a standing gap: it never closes (a passing check only refreshes its reality).`, error: 'standing' };
      if (gap.status === 'closed') return { ok: true, summary: `${gapId} is already closed.` };
      if (gap.status === 'dropped') return { ok: false, summary: `${gapId} was dropped by the owner; nothing to close.`, error: 'dropped' };
      // Only a fresh passing check closes a gap: the latest verification must be this one, and the gap unchanged since.
      const last = gap.lastVerify;
      if (!last?.passed || last.id !== verifyId) {
        return { ok: false, summary: `Not closed: ${gapId}'s latest verification is not the passing check ${verifyId}. Run brain.verify again.`, error: 'no passing verification' };
      }
      if (Date.parse(gap.updatedAt) > Date.parse(last.at)) {
        return { ok: false, summary: `Not closed: ${gapId} changed after check ${verifyId} passed. Run brain.verify again.`, error: 'stale verification' };
      }
      await deps.gaps.closeVerified(gapId, String(input.evidence), verifyId, ctx.now);
      const retired = await retireWatchesFor(gapId);
      return {
        ok: true,
        summary: `Closed ${gapId} "${gap.title}"${retired ? `, retired ${retired} watch(es)` : ''}.`,
        changes: [`gap_closed:${gapId}`],
      };
    },
  );

  await registry.registerInline(
    {
      id: 'gaps.retarget',
      version: 1,
      description: "Changes a gap's Target: what the owner wants true, and what brain.verify checks (a step of gaps.update).",
      whenToUse: ['A step of gaps.update when it is given a new target'],
      effect: 'write',
      requiresApproval: false,
      // What the owner wants is his: a new target is done and reported.
      defaultTrust: 'act_and_report',
      // A closed gap reopens and a target can be set back, so the owner may let this go quiet.
      reversible: true,
      internal: true,
      inputSchema: {
        type: 'object',
        properties: { gapId: { type: 'string' }, target: { type: 'string' } },
        required: ['gapId', 'target'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.gaps) return { ok: false, summary: 'The gap tree is not configured.', error: 'no gap store' };
      const gapId = String(input.gapId).trim();
      if (gapId === ROOT_GAP_ID) return { ok: false, summary: "The root gap's target is fixed.", error: 'root' };
      const g = await deps.gaps.update(gapId, { target: String(input.target) }, ctx.now);
      if (!g) return { ok: false, summary: `Gap ${gapId} not found. Target unchanged.`, error: 'not found' };
      return { ok: true, summary: `${gapId}'s target is now: ${g.target.slice(0, 200)}`, changes: [`gap_retargeted:${gapId}`] };
    },
  );

  // --- Productivity Watch / Alarm Tool ---

  await registry.registerInline(
    {
      id: 'watch.set',
      version: 1,
      description:
        "Schedules a gap's next move: a timer (minutesFromNow or fireAt ISO), or a wake when a running T3 Code thread finishes, needs input or is blocked (t3.thread start/send sets this one by itself). Tied to the gap the move serves; code wakes Rufus when it is due. A timer counts as a next move for sleep only when it says what it waits on (waitsOn: owner, person, job, or time when the world changes; waitsFor: who or what) and what will have changed by then (expect). A bare re-check is not a next move: do it now. atOwnerFree moves a ping past the owner's calendar events and standing-gap windows.",
      whenToUse: ["A gap's next move is waiting on someone or something: a chase to the owner, a person's reply, a running job, or a time when the world changes (a shop opens, sunset, a deadline), or the root's next look for gaps"],
      effect: 'write',
      requiresApproval: false,
      // Rufus's own timers: bookkeeping. Code's own scheduling (thread watches, quick returns) is gated on this rung too.
      defaultTrust: 'act_quietly',
      // It touches only Rufus's own state or the owner himself, and can be undone or corrected.
      reversible: true,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['timer', 't3_thread', 'brain_job'] },
          label: { type: 'string', description: 'What to check when this watch fires' },
          gapId: { type: 'string', description: "Gap this is the next move for (filled in from the move's gap)" },
          minutesFromNow: { type: 'number', description: 'For kind=timer: minutes from now (default 15 when neither this nor fireAt is given)' },
          fireAt: { type: 'string', description: 'For kind=timer: explicit ISO timestamp' },
          threadId: { type: 'string', description: 'For kind=t3_thread: exact T3 Code thread id (for kind=brain_job: the job id)' },
          waitsOn: { type: 'string', enum: [...WAITS_ON], description: 'What the move waits on: owner (a chase), person, job (a running job), or time (a time when the world changes)' },
          waitsFor: { type: 'string', description: 'Who or what: "Pat\'s reply", "the shop opens at 9", "sunset ends the Sabbath"' },
          expect: { type: 'string', description: 'What will be different when it fires (e.g. "the owner has replied with the link")' },
          atOwnerFree: { type: 'boolean', description: "For a ping to the owner: move the time past his calendar events and standing-gap windows (resolved by code in his sensed time zone)" },
        },
        required: ['kind', 'label'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.watches) return { ok: false, summary: 'Watch store not configured.', error: 'no watch store' };
      const kind = input.kind === 't3_thread' ? 't3_thread' : input.kind === 'brain_job' ? 'brain_job' : 'timer';
      const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : '';
      if (kind !== 'timer' && !threadId) return { ok: false, summary: `Refused: a ${kind} watch needs the id of the running ${kind === 't3_thread' ? 'thread' : 'job'} (threadId).`, error: 'missing threadId' };
      let fireAt: string | undefined;
      if (kind === 'timer') {
        // A next move that can never fire is not a next move: the time must be real.
        if (typeof input.fireAt === 'string' && input.fireAt.trim()) {
          const at = Date.parse(input.fireAt.trim());
          if (Number.isNaN(at)) return { ok: false, summary: `Refused: fireAt "${input.fireAt}" is not an ISO time. Use minutesFromNow or an ISO timestamp.`, error: 'bad fireAt' };
          fireAt = new Date(at).toISOString();
        } else {
          const mins = input.minutesFromNow === undefined ? 15 : Number(input.minutesFromNow);
          if (!Number.isFinite(mins) || mins <= 0) return { ok: false, summary: `Refused: minutesFromNow must be a positive number.`, error: 'bad minutesFromNow' };
          fireAt = new Date(ctx.now.getTime() + mins * 60_000).toISOString();
        }
      }
      let heldNote = '';
      if (fireAt && input.atOwnerFree === true) {
        // Pings hold to the owner's free time; work never does.
        const free = nextOwnerFree(new Date(fireAt), {
          busy: await calendarBusy(ctx.workspaceDir, ctx.now),
          windows: deps.gaps ? (await deps.gaps.unclosed()).filter((g) => g.standing && g.window).map((g) => ({ id: g.id, title: g.title, window: g.window! })) : [],
          timeZone: ownerTimeZoneNow(),
        });
        if (free.getTime() > Date.parse(fireAt)) {
          heldNote = ` Held to the owner's next free time (was ${fireAt}).`;
          fireAt = free.toISOString();
        }
      }
      const waitsOn = WAITS_ON.find((x) => x === input.waitsOn);
      const waitsFor = typeof input.waitsFor === 'string' ? input.waitsFor.trim() : '';
      const expect = typeof input.expect === 'string' ? input.expect.trim() : '';
      const w = await deps.watches.add(
        {
          kind,
          label: String(input.label).trim(),
          ...(typeof input.gapId === 'string' && input.gapId.trim() ? { gapId: input.gapId.trim() } : {}),
          ...(fireAt ? { fireAt } : {}),
          ...(threadId ? { threadId } : {}),
          ...(waitsOn ? { waitsOn } : {}),
          ...(waitsFor ? { waitsFor } : {}),
          ...(expect ? { expect } : {}),
        },
        ctx.now,
      );
      const mins = w.fireAt ? Math.max(1, Math.round((Date.parse(w.fireAt) - ctx.now.getTime()) / 60_000)) : 0;
      const when = w.fireAt ? ` (fires ${w.fireAt}, in ${mins < 90 ? `${mins} min` : `${(mins / 60).toFixed(1)} h`})` : w.threadId ? ` (wakes you when ${kind === 'brain_job' ? 'job' : 'thread'} ${w.threadId} finishes${kind === 't3_thread' ? ', needs input or is blocked' : ''})` : '';
      const real = realNextMove(w);
      const counts = real.ok ? '' : ` It does not count as a next move for sleep: ${real.why}. If nothing will change by then, do it now instead.`;
      return { ok: true, summary: `Set ${kind} watch ${w.id}${when}: ${w.label}.${heldNote}${counts}`, changes: [`watch_set:${w.id}`], data: w };
    },
    { alwaysVisible: true },
  );

  const PROMOTE_ACTION = 'trust.promote';

  await registry.registerInline(
    {
      id: PROMOTE_ACTION,
      version: 1,
      description: 'Internal action: raises one trust scope one rung up the Trust Ladder after the owner says yes.',
      whenToUse: ['Only via owner approval of a promotion offer'],
      effect: 'write',
      requiresApproval: true,
      defaultTrust: 'draft',
      internal: true,
      reversible: true,
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string', enum: ['rehearse', 'draft', 'act_and_report', 'act_quietly'] },
        },
        required: ['key', 'to'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.approvals) return { ok: false, summary: 'Approval store not configured.', error: 'no approval store' };
      const key = String(input.key ?? '').trim();
      const to = String(input.to ?? '').trim() as TrustLevel;
      await deps.approvals.setLevel(key, to);
      await deps.approvals.record.offered(key, ctx.now);
      return {
        ok: true,
        summary: `Raised trust for ${key} to ${to}.`,
        changes: [`trust_promoted:${key}:${to}`],
      };
    },
  );

  async function earnTrust(manifest: ToolManifest, input: Record<string, unknown>, key: string, ctx: ScriptContext): Promise<string | undefined> {
    if (!deps.approvals) return undefined;
    const rec = await deps.approvals.record.approved(key, ctx.now);
    if (rec.streak < PROMOTION_STREAK || rec.offer) return undefined;
    const next = await deps.approvals.promotionFor(manifest, input);
    if (!next) return undefined;
    const saved = await deps.approvals.enqueue(PROMOTE_ACTION, { key: next.key, from: next.from, to: next.to }, ctx.now);
    await deps.approvals.record.offered(next.key, ctx.now, saved.id);
    return `Clean streak (${PROMOTION_STREAK}): queued promotion offer ${saved.id} to raise ${next.key} from ${next.from} to ${next.to} if the owner wants.`;
  }

  await registry.registerInline(
    {
      id: 'approvals.approve',
      version: 2,
      description: "Runs a draft waiting for approval (Pending approvals on the Desk) after the owner says yes. Code checks it: it only works in a wake where the owner himself spoke (his direct message or voice).",
      whenToUse: ['There is a pending approval on the Desk and the owner directly said yes to it'],
      effect: 'write',
      requiresApproval: false,
      timeoutMs: 120_000,
      inputSchema: {
        type: 'object',
        properties: {
          approvalId: { type: 'string', description: 'Optional pending approval id (defaults to the most recent pending approval)' },
          alwaysAllow: { type: 'boolean', description: 'Legacy alias: promotes tool to act_and_report' },
          promoteTo: { type: 'string', enum: ['act_and_report', 'act_quietly'], description: 'Set ONLY if the owner explicitly asked to raise trust for this tool' },
        },
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.approvals) return { ok: false, summary: 'Approval store not configured.', error: 'no approval store' };
      const wake = deps.getWakeContext?.();
      if (!ownerSpoke(wake?.trigger, wake?.arrivals)) {
        return {
          ok: false,
          summary: 'Refused: only the owner can approve, in his own direct message or voice (never an external message or email). Nothing ran. Ask the owner, and schedule a chase for this gap.',
          error: 'owner_direct required',
        };
      }
      const id = typeof input.approvalId === 'string' && input.approvalId.trim() ? input.approvalId.trim() : undefined;
      const queued = await deps.approvals.listPending();
      if (!id && queued.length > 1) {
        return {
          ok: false,
          summary: `Refused: ${queued.length} approvals are pending (${queued.map((a) => `${a.id}:${a.toolId}${a.gapId ? `/${a.gapId}` : ''}`).join(', ')}). Pass the exact approvalId matching what the owner actually said yes to.`,
          error: 'ambiguous pending approval',
        };
      }
      const peek = id ? queued.find((a) => a.id === id) : queued[queued.length - 1];
      if (peek && ctx.gapId && peek.gapId && peek.gapId !== ctx.gapId) {
        return {
          ok: false,
          summary: `Refused: pending approval ${peek.id} (${peek.toolId}) belongs to ${peek.gapId}, not ${ctx.gapId}. Never apply the owner's yes on one topic to an unrelated pending draft.`,
          error: 'approval gap mismatch',
        };
      }
      if (peek && registry.get(peek.toolId)?.manifest.effect === 'write') {
        // A change to the trust files, tool manifests or gate code needs an owner message that came after the draft:
        // a message that predates the draft cannot have approved it.
        const hits = protectedTargets(peek.input, { workspaceDir: ctx.workspaceDir });
        const createdAt = Date.parse(peek.createdAt);
        const ownerSaidSince = [wake?.trigger, ...(wake?.arrivals ?? [])].some((e) => e?.kind === 'owner_direct' && Date.parse(e.timestamp) > createdAt);
        if (hits.length && !ownerSaidSince) {
          return {
            ok: false,
            summary: `Refused: ${peek.id} would change ${hits.join(', ')}. Show the owner this exact change and wait for his yes to it; a message from before the draft does not approve it.`,
            error: 'protected change needs a fresh owner yes',
          };
        }
      }
      const pending = await deps.approvals.take(id);
      if (!pending) return { ok: false, summary: NO_PENDING_APPROVAL, error: 'no pending approval' };
      const promote: TrustLevel | undefined =
        input.promoteTo === 'act_quietly' || input.promoteTo === 'act_and_report'
          ? input.promoteTo
          : input.alwaysAllow === true
            ? 'act_and_report'
            : undefined;
      const pendingManifest = registry.get(pending.toolId)?.manifest;
      // Trust is scoped by who and what: a raise covers this call's scope (e.g. this recipient), not the whole tool.
      const key = pendingManifest ? await deps.approvals.keyFor(pendingManifest, pending.input) : pending.toolId;
      if (promote) {
        await deps.approvals.setLevel(key, promote);
      }
      const execReceipt = await registry.call(pending.toolId, pending.input, {
        workspaceDir: ctx.workspaceDir,
        now: ctx.now,
        approved: true,
        ownerApproved: true,
        ...(ctx.wakeId ? { wakeId: ctx.wakeId } : {}),
        ...(pending.gapId ? { gapId: pending.gapId } : {}),
      });
      await deps.onApprovalDecision?.('approved', pending.toolId, pending.id);
      const offer = promote || pending.toolId === PROMOTE_ACTION || !pendingManifest ? undefined : await earnTrust(pendingManifest, pending.input, key, ctx);
      return {
        ok: execReceipt.status === 'ok',
        summary: `Approved & ran ${pending.toolId}: ${execReceipt.summary}${promote ? ` (trust raised to ${promote} for ${key})` : ''}${offer ? ` ${offer}` : ''}`,
        changes: [...execReceipt.changes, ...(promote ? [`trust_promoted:${key}:${promote}`] : [])],
        data: execReceipt.data,
        ...(execReceipt.error ? { error: execReceipt.error } : {}),
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'approvals.deny',
      version: 2,
      description: 'Cancels a draft waiting for approval when the owner says no / skip / cancel (and drops trust if needed).',
      whenToUse: ['There is a pending approval on the Desk and the owner declined or cancelled it'],
      effect: 'write',
      requiresApproval: false,
      // Recording the owner's no (or withdrawing a draft) is bookkeeping.
      defaultTrust: 'act_quietly',
      // It touches only Rufus's own state or the owner himself, and can be undone or corrected.
      reversible: true,
      inputSchema: {
        type: 'object',
        properties: {
          approvalId: { type: 'string', description: 'Optional pending approval id (defaults to the most recent pending approval)' },
        },
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      if (!deps.approvals) return { ok: false, summary: 'Approval store not configured.', error: 'no approval store' };
      const id = typeof input.approvalId === 'string' && input.approvalId.trim() ? input.approvalId.trim() : undefined;
      const pending = await deps.approvals.take(id);
      if (!pending) return { ok: false, summary: NO_PENDING_APPROVAL, error: 'no pending approval' };
      // Only the owner's "no" is a denial that costs trust and teaches the bouncer; Rufus withdrawing his own draft is neither.
      const wake = deps.getWakeContext?.();
      if (!ownerSpoke(wake?.trigger, wake?.arrivals)) {
        return { ok: true, summary: `Withdrew pending approval ${pending.id} (${pending.toolId}). Trust unchanged.`, changes: [`approval_withdrawn:${pending.id}`] };
      }
      // The owner's no costs that scope its rung (one down, never below draft) and starts its clean streak over.
      const manifest = registry.get(pending.toolId)?.manifest;
      const key = manifest ? await deps.approvals.keyFor(manifest, pending.input) : pending.toolId;
      const lowered = manifest ? await deps.approvals.demoteCall(manifest, pending.input) : undefined;
      await deps.approvals.record.denied(key, ctx.now);
      // A declined promotion offer is answered: the scope keeps its rung and earns its next offer from zero.
      if (pending.toolId === PROMOTE_ACTION && typeof pending.input.key === 'string') await deps.approvals.record.offered(pending.input.key, ctx.now);
      await deps.onApprovalDecision?.('denied', pending.toolId, pending.id);
      return {
        ok: true,
        summary: `Cancelled pending approval ${pending.id} (${pending.toolId}).${lowered ? ` Trust for ${key} dropped to ${lowered}.` : ''}`,
        changes: [`approval_denied:${pending.id}`, ...(lowered ? [`trust_demoted:${key}:${lowered}`] : [])],
      };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'sleep',
      version: 1,
      description:
        'Ends this wake. Only accepted when every unclosed gap, root included, has a real next move: a running thread or job, or a watch that names what will change (the owner, a person, a job, or a time when the world changes) and what it expects. Standing preferences with no window need none.',
      whenToUse: ['Every unclosed gap, root included, already has a real next move in motion'],
      effect: 'meta',
      requiresApproval: false,
      // Ending a wake changes nothing outside Rufus; it is on the ladder like any tool (trust.json can still move it).
      defaultTrust: 'act_quietly',
      // It touches only Rufus's own state or the owner himself, and can be undone or corrected.
      reversible: true,
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short factual reason for going back to sleep.' },
        },
        required: ['reason'],
        additionalProperties: false,
      },
      exampleInput: { reason: "Answered the owner's question; every gap has a next move." },
    },
    async (input) => {
      const reason = String(input.reason ?? 'done').trim();
      if (deps.gaps && deps.watches) {
        const active = await deps.watches.active();
        const problems: string[] = [];
        const stranded: Gap[] = [];
        for (const g of (await deps.gaps.unclosed()).filter(needsNextMove)) {
          const moves = active.filter((w) => servesGap(w, g.id));
          // Waiting on the owner means the next move is a chase: something that waits on him.
          const owed = !!g.waitingOn && /^owner\b/i.test(g.waitingOn);
          const real = moves.filter((w) => realNextMove(w).ok && (!owed || w.waitsOn === 'owner' || w.kind !== 'timer'));
          if (real.length) continue;
          stranded.push(g);
          const why = moves.length
            ? owed
              ? `it waits on the owner, but no watch chases him (waitsOn: owner)`
              : moves.map((w) => { const r = realNextMove(w); return r.ok ? '' : `${w.id}: ${r.why}`; }).filter(Boolean).join('; ')
            : 'no next move';
          problems.push(`${g.id} "${g.title}" (${why})`);
        }
        if (stranded.length) {
          return {
            ok: false,
            summary: `Not yet: ${stranded.length} gap(s) have no real next move: ${problems.join(', ')}. For each one, do now whatever needs nobody else; only what waits on the owner, another person, a running job or a time when the world changes may wait, and its watch.set says which (waitsOn, waitsFor) and what will have changed (expect). If the owner is the blocker, schedule a chase, a different way than last time.`,
            error: 'gaps_without_next_move',
            nextHints: ['watch.set'],
          };
        }
      }
      deps.onSleep(reason);
      return { ok: true, summary: `Sleeping: ${reason}` };
    },
    { alwaysVisible: true },
  );

  await registry.registerInline(
    {
      id: 'system.startup_snapshot',
      version: 1,
      description: 'Collects exact $0 startup state (when Rufus started, and the latest code update he restarted on) for a startup message.',
      whenToUse: ['Rufus just booted or restarted and needs to orient the owner'],
      effect: 'read',
      requiresApproval: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async (_input, ctx) => {
      const git = (args: string[]) =>
        // The repo this code runs from, whatever directory the daemon was started in.
        execFileAsync('git', args, { cwd: RUFUS_REPO_DIR, timeout: 1500 })
          .then((r) => r.stdout.trim())
          .catch(() => undefined);
      const [subject, committedIso] = (await git(['log', '-1', `--before=${ctx.now.toISOString()}`, '--pretty=%s%x00%cI']))?.split('\0') ?? [];
      const lastChange = subject || undefined;
      const committed = committedIso ? new Date(committedIso) : undefined;
      // The live daemon runs the working tree, so uncommitted edits are part of what just started, and the last commit may be old news.
      const uncommitted = (await git(['status', '--porcelain']))?.split('\n').filter(Boolean).length ?? 0;
      return {
        ok: true,
        summary: `Restarted.${lastChange ? ` Latest commit: ${lastChange}` : ''}${uncommitted ? ` Also running ${uncommitted} uncommitted file change(s).` : ''}`,
        data: {
          startedAt: ctx.now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          ...(lastChange ? { latestUpdate: lastChange } : {}),
          ...(committed && !Number.isNaN(committed.getTime()) ? { latestUpdateAt: committed.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } : {}),
          ...(uncommitted ? { uncommittedFiles: uncommitted } : {}),
        },
        nextHints: ['send_message'],
      };
    },
  );

  // Self-change tools live in the engine (reserved ids), so they can't be repaired around their own safeguards.
  await registerRollbackTool(registry);
  await registerSelfUpgrade(registry);
  // Self-awareness: read-only flight-recorder introspection so Rufus explains real recorded reasoning, never guesses.
  await registerReasoningTool(registry, { ...(deps.getCurrentWakeTrace ? { getCurrentWakeTrace: deps.getCurrentWakeTrace } : {}) });
  // The general search (names and contents, any folder), so finding something never means walking folders by hand.
  await registerLocalSearch(registry);
}
