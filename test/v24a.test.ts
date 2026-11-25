import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChiefOfStaff,
  Engine,
  FakeProvider,
  MasterLoop,
  PENDING_CLEAR_TOOL,
  STRATEGIES,
  ToolRegistry,
  UnifiedDaemon,
  VERIFIER_RETRY_PROMPT,
  clearPendingItems,
  detectActionClaims,
  detectUnbackedActionClaims,
  formatBenchmark,
  honestCorrection,
  incomingOf,
  isMessageAlreadyHandled,
  loadStartState,
  parsePendingRefs,
  pendingClearTool,
  pruneHandledPendingItems,
  requestCheckin,
  runStrategyBenchmark,
  saveStartState,
  freshStartState,
  type IncomingMessage,
  type LiveChannel,
  type LoopRun,
  type StalenessMessage,
  type ToolDefinition,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

const NOW = new Date('2026-11-25T15:00:00.000Z');
const at = (min: number): string => new Date(Date.parse('2026-11-25T14:00:00.000Z') + min * 60_000).toISOString();

// ---------- helpers ----------

/** A chat reply item waiting at Verify, written straight into `loop-runs/`. */
async function waitingRun(dir: string, n: number, opts: { chatId?: string; timestamp?: string; messageId?: string; surface?: string } = {}): Promise<LoopRun> {
  const run: LoopRun = {
    id: `loop_run_${n}`,
    sensorId: 'beeper',
    handlerId: 'chat.reply',
    signal: {
      id: `sig_${n}`,
      surface: opts.surface ?? 'chat',
      kind: 'message.received',
      text: `message ${n}`,
      actor: `Contact ${n}`,
      timestamp: opts.timestamp ?? at(n),
      data: { chatId: opts.chatId ?? `chat-${n}`, messageId: opts.messageId ?? `m${n}` },
    },
    status: 'awaiting_human_verify',
    actionType: 'chat.reply',
    goal: `Reply to Contact ${n}`,
    urgency: 'normal',
    replans: 0,
    trail: [],
    aiCalls: 0,
    spectrum: { code: 1, fast: 0, smart: 0, human: 1 },
    createdAt: at(n),
    updatedAt: at(n),
  };
  await mkdir(path.join(dir, 'loop-runs'), { recursive: true });
  await writeFile(path.join(dir, 'loop-runs', `${run.id}.json`), JSON.stringify(run, null, 2));
  return run;
}

/** Five chats: #1-#4 you answered with a text, #5 you reacted to, #6 nobody answered. */
function liveChats(): Record<string, StalenessMessage[]> {
  const chats: Record<string, StalenessMessage[]> = {};
  for (let n = 1; n <= 6; n++) {
    const incoming: StalenessMessage = { id: `m${n}`, text: `message ${n}`, timestamp: at(n), isSender: false };
    if (n <= 4) chats[`chat-${n}`] = [incoming, { id: `r${n}`, text: 'on it!', timestamp: at(n + 10), isSender: true }];
    else if (n === 5) chats[`chat-${n}`] = [{ ...incoming, reactions: [{ emoji: '👍', isMe: true }] }];
    else chats[`chat-${n}`] = [incoming];
  }
  return chats;
}

function beeperRead(chats: Record<string, StalenessMessage[]> | 'offline'): ToolDefinition & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'beeper.read',
    description: 'read a chat (fake)',
    readOnly: true,
    calls,
    async execute(args) {
      calls.push(String(args.chatId));
      if (chats === 'offline') throw new Error('connect ECONNREFUSED 127.0.0.1:23373');
      return chats[String(args.chatId)] ?? [];
    },
  };
}

// ---------- 1. Code Verifies: unbacked action claims ----------

describe('detectUnbackedActionClaims (anti-hallucination)', () => {
  it('catches the live failure: "so I\'ve cleared them" with no tool call', () => {
    const reply = "My bad, those were all already handled, so I've cleared them.";
    expect(detectUnbackedActionClaims(reply, [])).toEqual(['claimed_clear_without_tool']);
  });

  it('a successful pending.clear backs the claim; a failed one does not', () => {
    const reply = "My bad, those were all already handled, so I've cleared them.";
    expect(detectUnbackedActionClaims(reply, [{ name: 'pending.clear', ok: true }])).toEqual([]);
    expect(detectUnbackedActionClaims(reply, [{ name: 'pending.clear', ok: false }])).toEqual(['claimed_clear_without_tool']);
    expect(detectUnbackedActionClaims(reply, [{ name: 'anchor.update', ok: true }])).toEqual(['claimed_clear_without_tool']);
  });

  it('flags each kind of mutation claim with its own reason', () => {
    expect(detectUnbackedActionClaims('Sent Dana a heads-up that you are running late.', [])).toEqual(['claimed_send_without_tool']);
    expect(detectUnbackedActionClaims("I've replied to Sam for you.", [])).toEqual(['claimed_send_without_tool']);
    expect(detectUnbackedActionClaims('I reacted 👍 to her message.', [])).toEqual(['claimed_react_without_tool']);
    expect(detectUnbackedActionClaims('Moved gym to 6pm.', [])).toEqual(['claimed_schedule_without_tool']);
    expect(detectUnbackedActionClaims("I've scheduled the dentist for Friday at 3.", [])).toEqual(['claimed_schedule_without_tool']);
    expect(detectUnbackedActionClaims('I deleted the meeting.', [])).toEqual(['claimed_schedule_without_tool']);
    expect(detectUnbackedActionClaims("I've paused everything, nothing runs on its own now.", [])).toEqual(['claimed_autonomy_without_tool']);
    expect(detectUnbackedActionClaims("On it, I've started researching and will ping you.", [])).toEqual(['claimed_mission_without_tool']);
    expect(detectUnbackedActionClaims("I cancelled the mission.", [])).toEqual(['claimed_mission_without_tool']);
    expect(detectUnbackedActionClaims("Got it, I've saved that.", [])).toEqual(['claimed_remember_without_tool']);
    expect(detectUnbackedActionClaims('They are all cleared now.', [])).toEqual(['claimed_clear_without_tool']);
    expect(detectUnbackedActionClaims("I marked #1-#4 as done.", [])).toEqual(['claimed_clear_without_tool']);
  });

  it('several claims in one reply: each unbacked kind once, in order', () => {
    const reply = "Done! I've cleared #1-#3 and I've texted Sam. I also moved gym to 7.";
    expect(detectUnbackedActionClaims(reply, [{ name: 'beeper.send', ok: true }])).toEqual(['claimed_clear_without_tool', 'claimed_schedule_without_tool']);
    expect(detectActionClaims(reply)).toEqual(['clear', 'send', 'schedule']);
  });

  it('matching tools back each claim (anchor.update, calendar.write, beeper.react, mission.start, remember, gmail.send)', () => {
    expect(detectUnbackedActionClaims('Moved gym to 6:30pm.', [{ name: 'anchor.update', ok: true }])).toEqual([]);
    expect(detectUnbackedActionClaims("I've booked it.", [{ name: 'calendar.write', ok: true }])).toEqual([]);
    expect(detectUnbackedActionClaims('Reacted 😂 to Mom.', [{ name: 'beeper.react', ok: true }])).toEqual([]);
    expect(detectUnbackedActionClaims('I started a background mission on that.', [{ name: 'mission.start', ok: true }])).toEqual([]);
    expect(detectUnbackedActionClaims("Got it, I've noted that.", [{ name: 'remember', ok: true }])).toEqual([]);
    expect(detectUnbackedActionClaims('I emailed the landlord.', [{ name: 'gmail.send', ok: true }])).toEqual([]);
    // read-only calendar calls never back a write claim
    expect(detectUnbackedActionClaims("I've scheduled it.", [{ name: 'calendar.read', ok: true }])).toEqual(['claimed_schedule_without_tool']);
  });

  it('a queued send (ok: false) does not back "I sent it", but an honest "reply 1 to send" is fine', () => {
    expect(detectUnbackedActionClaims('Sent it to Sam.', [{ name: 'beeper.send', ok: false }])).toEqual(['claimed_send_without_tool']);
    expect(detectUnbackedActionClaims('A text to Sam is ready: "running late". Reply 1 to send.', [{ name: 'beeper.send', ok: false }])).toEqual([]);
    expect(detectUnbackedActionClaims("I've queued a reply to Sam for your yes.", [])).toEqual([]);
  });

  it('does not flag questions, offers, denials, future tense or reports of what someone else did', () => {
    for (const reply of [
      'Want me to clear #1-#4?',
      "I haven't cleared them yet.",
      "I can't send messages on my own.",
      "I'll clear those once you say so.",
      'You already replied to Sam at 2pm.',
      'Sam replied an hour ago.',
      'Your meeting is scheduled for 3pm.',
      'You have Gym at 6pm and a team call at 6:30.',
      'Should I move gym to 7?',
      'Those were all already handled by you.',
      "I'd cancel the call if you want.",
      'REACT: 👍',
      'NO_REPLY',
    ]) {
      expect(detectUnbackedActionClaims(reply, []), reply).toEqual([]);
    }
  });

  it('honestCorrection says plainly what was not done', () => {
    expect(honestCorrection(['claimed_clear_without_tool'])).toBe("Correction: I haven't actually cleared anything yet. No tool ran for that, so tell me again if you want it done.");
    expect(honestCorrection(['claimed_send_without_tool', 'claimed_schedule_without_tool'])).toContain("nothing has actually been sent yet and your schedule hasn't actually changed");
    expect(honestCorrection([])).toBe('');
  });
});

// ---------- 2. Code Prepares: live Beeper staleness ----------

describe('isMessageAlreadyHandled', () => {
  const incoming: StalenessMessage = { id: 'm1', text: 'can you call me?', timestamp: at(0), isSender: false };

  it('true when you sent a text reply after the incoming message', () => {
    expect(isMessageAlreadyHandled([incoming, { id: 'r1', text: 'calling now', timestamp: at(3), isSender: true }], at(0), 'm1')).toBe(true);
  });

  it('false when your last message is older, empty or deleted', () => {
    expect(isMessageAlreadyHandled([{ id: 'r0', text: 'hey', timestamp: at(-5), isSender: true }, incoming], at(0), 'm1')).toBe(false);
    expect(isMessageAlreadyHandled([incoming, { id: 'r1', text: '   ', timestamp: at(3), isSender: true }], at(0), 'm1')).toBe(false);
    expect(isMessageAlreadyHandled([incoming, { id: 'r1', text: 'oops', timestamp: at(3), isSender: true, isDeleted: true }], at(0), 'm1')).toBe(false);
    expect(isMessageAlreadyHandled([incoming], at(0), 'm1')).toBe(false);
  });

  it('true when you reacted to that message (isMe), by id or by a later message from them', () => {
    expect(isMessageAlreadyHandled([{ ...incoming, reactions: [{ emoji: '❤️', isMe: true }] }], at(0), 'm1')).toBe(true);
    expect(isMessageAlreadyHandled([{ ...incoming, timestamp: undefined, reactions: [{ emoji: '❤️', isMe: true }] }], at(0), 'm1')).toBe(true);
    expect(isMessageAlreadyHandled([incoming, { id: 'm2', text: 'also this', timestamp: at(1), isSender: false, reactions: [{ emoji: '👍', isMe: true }] }], at(0))).toBe(true);
  });

  it('their reaction, or your reaction to an older message, does not count', () => {
    expect(isMessageAlreadyHandled([{ ...incoming, reactions: [{ emoji: '👍', isMe: false }] }], at(0), 'm1')).toBe(false);
    expect(isMessageAlreadyHandled([{ id: 'm0', text: 'old', timestamp: at(-10), isSender: false, reactions: [{ emoji: '👍', isMe: true }] }, incoming], at(0), 'm1')).toBe(false);
  });

  it('incomingOf reads the chat, the latest folded message time and the message id', () => {
    const run = { signal: { id: 's', surface: 'chat', kind: 'message.received', timestamp: at(1), data: { chatId: 'c1', messageId: 'm9', messages: [{ text: 'a', at: at(1) }, { text: 'b', at: at(4) }] } } };
    expect(incomingOf(run)).toEqual({ chatId: 'c1', timestamp: at(4), messageId: 'm9' });
    expect(incomingOf({ signal: { id: 's', surface: 'calendar', kind: 'x', data: { chatId: 'c1' } } })).toBeUndefined();
  });
});

describe('pruneHandledPendingItems (Code Prepares, $0)', () => {
  it('dismisses the items you already answered or reacted to, keeps the rest, and renumbers start-state', async () => {
    const dir = await tempDir();
    for (let n = 1; n <= 6; n++) await waitingRun(dir, n);
    const loop = new MasterLoop({ dir, now: () => NOW });
    const state = freshStartState();
    state.numbers = { loop_run_1: 1, loop_run_2: 2, loop_run_3: 3, loop_run_4: 4, loop_run_5: 5, loop_run_6: 6 };
    state.delivered = ['loop_run_1', 'loop_run_6'];
    await saveStartState(dir, state);
    const read = beeperRead(liveChats());

    const r = await pruneHandledPendingItems(dir, loop, new ToolRegistry({ tools: [read] }), undefined, { now: NOW });
    expect(r.pruned.sort()).toEqual(['loop_run_1', 'loop_run_2', 'loop_run_3', 'loop_run_4', 'loop_run_5']);
    expect(r.checked).toBe(6);
    expect(r.errors).toEqual([]);
    expect((await loop.pending()).map((x) => x.id)).toEqual(['loop_run_6']);
    const run1 = await loop.getRun('loop_run_1');
    expect(run1).toMatchObject({ status: 'expired', dismissed: true });
    expect(run1.expiredReason).toMatch(/already handled/);
    expect(run1.committed).toBeUndefined(); // nothing was sent or applied
    const saved = await loadStartState(dir);
    expect(saved.numbers).toEqual({ loop_run_6: 6 });
    expect(saved.delivered).toEqual(['loop_run_6']);
  });

  it('updates a live start state in place (the daemon saves it)', async () => {
    const dir = await tempDir();
    await waitingRun(dir, 1);
    await waitingRun(dir, 6);
    const loop = new MasterLoop({ dir, now: () => NOW });
    const state = freshStartState();
    state.numbers = { loop_run_1: 1, loop_run_6: 2 };
    const r = await pruneHandledPendingItems(dir, loop, new ToolRegistry({ tools: [beeperRead(liveChats())] }), state, { now: NOW });
    expect(r.pruned).toEqual(['loop_run_1']);
    expect(state.numbers).toEqual({ loop_run_6: 2 });
  });

  it('Beeper offline: nothing changes and the error is reported, not thrown', async () => {
    const dir = await tempDir();
    await waitingRun(dir, 1);
    const loop = new MasterLoop({ dir, now: () => NOW });
    const r = await pruneHandledPendingItems(dir, loop, new ToolRegistry({ tools: [beeperRead('offline')] }), undefined, { now: NOW });
    expect(r.pruned).toEqual([]);
    expect(r.errors[0]).toMatch(/ECONNREFUSED/);
    expect(await loop.pending()).toHaveLength(1);
  });

  it('no beeper.read: skipped; non-chat items are never touched', async () => {
    const dir = await tempDir();
    await waitingRun(dir, 1, { surface: 'email' });
    const loop = new MasterLoop({ dir, now: () => NOW });
    expect(await pruneHandledPendingItems(dir, loop, new ToolRegistry(), undefined, { now: NOW })).toMatchObject({ skipped: true, pruned: [] });
    const read = beeperRead(liveChats());
    expect((await pruneHandledPendingItems(dir, loop, new ToolRegistry({ tools: [read] }), undefined, { now: NOW })).pruned).toEqual([]);
    expect(read.calls).toEqual([]);
  });
});

// ---------- 3. the real pending.clear tool ----------

describe('pending.clear', () => {
  it('parses refs: ranges, lists, numbers, "all" and run ids', () => {
    expect(parsePendingRefs('#1-#4')).toEqual({ all: false, numbers: [1, 2, 3, 4], ids: [] });
    expect(parsePendingRefs(['#1', 3, '5'])).toEqual({ all: false, numbers: [1, 3, 5], ids: [] });
    expect(parsePendingRefs('#2, #4 and #5')).toEqual({ all: false, numbers: [2, 4, 5], ids: [] });
    expect(parsePendingRefs('all')).toMatchObject({ all: true });
    expect(parsePendingRefs('loop_abc')).toEqual({ all: false, numbers: [], ids: ['loop_abc'] });
  });

  it('dismisses #1-#4 and #5 by their start-state numbers, sends nothing, and frees the numbers', async () => {
    const dir = await tempDir();
    for (let n = 1; n <= 6; n++) await waitingRun(dir, n);
    const loop = new MasterLoop({ dir, now: () => NOW });
    const state = freshStartState();
    state.numbers = { loop_run_1: 1, loop_run_2: 2, loop_run_3: 3, loop_run_4: 4, loop_run_5: 5, loop_run_6: 6 };
    await saveStartState(dir, state);

    const r = await clearPendingItems({ loop }, { refs: ['#1 - #4', '#5'] });
    expect(r.cleared.map((c) => c.ref)).toEqual(['#1', '#2', '#3', '#4', '#5']);
    expect(r.remaining).toBe(1);
    expect(r.reason).toBe('already_handled');
    expect(r.done).toBe('Cleared #1, #2, #3, #4, #5 (already handled). 1 still waiting.');
    expect((await loop.pending()).map((x) => x.id)).toEqual(['loop_run_6']);
    expect(await loop.getRun('loop_run_3')).toMatchObject({ status: 'expired', dismissed: true });
    expect((await loadStartState(dir)).numbers).toEqual({ loop_run_6: 6 });
    // Earned Trust is untouched: a dismissal is not a rejection of the draft.
    expect(await loop.trust.get('chat.reply')).toMatchObject({ accepted: 0, edited: 0, rejected: 0 });
  });

  it('"all" clears everything; an unknown ref is an error that lists what is waiting', async () => {
    const dir = await tempDir();
    await waitingRun(dir, 1);
    await waitingRun(dir, 2);
    const loop = new MasterLoop({ dir, now: () => NOW });
    await expect(clearPendingItems({ loop }, { refs: '#9' })).rejects.toThrow(/Nothing waiting matches #9\. Waiting now: #1 Reply to Contact 1; #2 Reply to Contact 2/);
    await expect(clearPendingItems({ loop }, {})).rejects.toThrow(/refs is required/);
    expect((await clearPendingItems({ loop }, { refs: 'all' })).cleared).toHaveLength(2);
    expect(await loop.pending()).toEqual([]);
  });

  it('is a local workspace tool (runs from chat right away, never queued)', () => {
    const dir = '/nowhere';
    const tool = pendingClearTool({ loop: new MasterLoop({ dir }) });
    expect(tool).toMatchObject({ name: PENDING_CLEAR_TOOL, local: true, readOnly: false });
    expect(tool.sensitivity).toBeUndefined();
  });
});

// ---------- 4. the Chief of Staff: verifier + retry + pending.clear ----------

async function chiefSetup(script: (req: Parameters<FakeProvider['complete']>[0], n: number) => string, items = 5) {
  const dir = await tempDir();
  for (let n = 1; n <= items; n++) await waitingRun(dir, n);
  const state = freshStartState();
  for (let n = 1; n <= items; n++) state.numbers[`loop_run_${n}`] = n;
  await saveStartState(dir, state);
  const provider = new FakeProvider(script);
  const engine = new Engine({ store: dir, provider, flows: [] });
  const loop = new MasterLoop({ dir, now: () => NOW });
  const chief = new ChiefOfStaff({ engine, loop, now: () => NOW });
  return { dir, provider, loop, chief };
}

describe('ChiefOfStaff: Code Verifies every reply against the tool calls that ran', () => {
  it('the live failure, fixed: the draft "I\'ve cleared them" is rejected, the retry calls pending.clear, code confirms', async () => {
    const { provider, loop, chief } = await chiefSetup((_req, n) =>
      n === 0 ? "My bad, those were all already handled, so I've cleared them." : n === 1 ? 'TOOL_CALL: {"tool":"pending.clear","args":{"refs":"#1-#4, #5"}}' : 'Cleared #1-#5, nothing else is waiting.',
    );
    const reply = await chief.handle('I already responded to 1-4 and reacted to 5');
    expect(reply.text).toBe('Cleared #1-#5, nothing else is waiting.');
    expect(reply.toolsUsed).toEqual(['pending.clear']);
    expect(reply.verifier).toEqual({ violations: ['claimed_clear_without_tool'], retried: true, corrected: false });
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]!.messages.some((m) => m.role === 'user' && m.content.startsWith(VERIFIER_RETRY_PROMPT))).toBe(true);
    expect(await loop.pending()).toEqual([]);
  });

  it('the system prompt offers pending.clear and the snapshot shows the #refs', async () => {
    const { provider, chief } = await chiefSetup(() => 'REACT: 👍', 2);
    await chief.handle('thanks');
    const req = provider.calls[0]!;
    expect(String(req.system)).toContain('pending.clear');
    expect(String(req.system)).toContain('Never say you did something');
    expect(req.messages[0]!.content).toContain('"ref": "#2"');
  });

  it('a retry that honestly says "not yet" is sent as is', async () => {
    const { chief } = await chiefSetup((_req, n) => (n === 0 ? 'Sent it to Sam.' : "I haven't sent anything yet. Want me to draft it?"), 0);
    const reply = await chief.handle('tell Sam I am late');
    expect(reply.text).toBe("I haven't sent anything yet. Want me to draft it?");
    expect(reply.verifier).toMatchObject({ retried: true, corrected: false });
  });

  it('still claiming after the retry: code appends an honest correction', async () => {
    const { provider, chief } = await chiefSetup(() => "Done, I've cleared them all.", 2);
    const reply = await chief.handle('those are handled');
    expect(provider.calls).toHaveLength(2); // exactly ONE corrective retry
    expect(reply.verifier).toEqual({ violations: ['claimed_clear_without_tool'], retried: true, corrected: true });
    expect(reply.bubbles).toEqual(["Done, I've cleared them all.", "Correction: I haven't actually cleared anything yet. No tool ran for that, so tell me again if you want it done."]);
  });

  it('a backed reply costs no extra call', async () => {
    const { provider, chief } = await chiefSetup((_req, n) => (n === 0 ? 'TOOL_CALL: {"tool":"pending.clear","args":{"refs":"all"}}' : 'Cleared #1 and #2.'), 2);
    const reply = await chief.handle('clear them all, I handled them');
    expect(reply.text).toBe('Cleared #1 and #2.');
    expect(reply.verifier).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
  });

  it('talk-only chat (no tools) is not retried', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(() => 'Booked lunch with Sam at 12.');
    const chief = new ChiefOfStaff({ engine: new Engine({ store: dir, provider, flows: [] }), now: () => NOW });
    const reply = await chief.handle('book lunch');
    expect(reply.verifier).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
  });
});

// ---------- 5. the daemon: no nudges about handled messages ----------

describe('UnifiedDaemon staleness guard', () => {
  function chatChannel(clock: () => Date) {
    return new (class implements LiveChannel {
      sent: string[] = [];
      inbox: IncomingMessage[] = [];
      async send(text: string) {
        this.sent.push(text);
      }
      async poll(since?: string) {
        return this.inbox.filter((m) => !since || !m.at || m.at >= since);
      }
      human(text: string) {
        this.inbox.push({ id: `in_${this.inbox.length + 1}`, text, at: new Date(clock().getTime() + this.inbox.length + 1).toISOString() });
      }
    })();
  }

  it('a check-in never mentions messages you already answered or reacted to in Beeper', async () => {
    const dir = await tempDir();
    for (let n = 1; n <= 6; n++) await waitingRun(dir, n);
    const read = beeperRead(liveChats());
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'ok'), flows: [] });
    const loop = new MasterLoop({ dir, tools: new ToolRegistry({ tools: [read] }), now: () => NOW });
    const chat = chatChannel(() => NOW);
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, chief: false, heartbeat: false, calendarSync: false, bubblePauseMs: 0, now: () => NOW });
    expect(loop.tools.has(PENDING_CLEAR_TOOL)).toBe(true);

    await requestCheckin(dir, NOW);
    const report = await daemon.tick();
    expect(report.pruned?.sort()).toEqual(['loop_run_1', 'loop_run_2', 'loop_run_3', 'loop_run_4', 'loop_run_5']);
    expect(report.checkin).toEqual(['loop_run_6']);
    const said = chat.sent.join('\n');
    expect(said).toContain('Contact 6');
    for (let n = 1; n <= 5; n++) expect(said).not.toContain(`Contact ${n}`);
    expect(Object.keys((await loadStartState(dir)).numbers)).toEqual(['loop_run_6']);
  });

  it('Beeper offline: the check-in still goes out, nothing is dismissed', async () => {
    const dir = await tempDir();
    await waitingRun(dir, 1);
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'ok'), flows: [] });
    const loop = new MasterLoop({ dir, tools: new ToolRegistry({ tools: [beeperRead('offline')] }), now: () => NOW });
    const chat = chatChannel(() => NOW);
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, chief: false, heartbeat: false, calendarSync: false, bubblePauseMs: 0, now: () => NOW });
    await requestCheckin(dir, NOW);
    const report = await daemon.tick();
    expect(report.pruned).toBeUndefined();
    expect(report.checkin).toEqual(['loop_run_1']);
    expect(report.errors).toEqual([]);
  });

  it('staleGuard: false turns it off', async () => {
    const dir = await tempDir();
    await waitingRun(dir, 1);
    const read = beeperRead(liveChats());
    const engine = new Engine({ store: dir, provider: new FakeProvider(() => 'ok'), flows: [] });
    const loop = new MasterLoop({ dir, tools: new ToolRegistry({ tools: [read] }), now: () => NOW });
    const daemon = new UnifiedDaemon({ loop, engine, channel: chatChannel(() => NOW), chief: false, heartbeat: false, calendarSync: false, staleGuard: false, bubblePauseMs: 0, now: () => NOW });
    await daemon.tick();
    expect(read.calls).toEqual([]);
  });

  it('end to end in chat: "I already responded to 1-4 and reacted to 5" really clears them', async () => {
    const dir = await tempDir();
    for (let n = 1; n <= 6; n++) await waitingRun(dir, n);
    let t = NOW;
    const clock = () => t;
    const provider = new FakeProvider((_req, n) => (n === 0 ? "My bad, so I've cleared them." : n === 1 ? 'TOOL_CALL: {"tool":"pending.clear","args":{"refs":["#1-#4","#5"]}}' : 'Cleared #1-#5. Just #6 left.'));
    const engine = new Engine({ store: dir, provider, flows: [] });
    const loop = new MasterLoop({ dir, now: clock });
    const chat = chatChannel(clock);
    const daemon = new UnifiedDaemon({ loop, engine, channel: chat, heartbeat: false, calendarSync: false, bubblePauseMs: 0, now: clock });
    await daemon.tick(); // numbers #1-#6 assigned, listening from now
    t = new Date(t.getTime() + 60_000);
    chat.human('I already responded to 1-4 and reacted to 5');
    await daemon.tick();
    expect(chat.sent.at(-1)).toBe('Cleared #1-#5. Just #6 left.');
    expect((await loop.pending()).map((r) => r.id)).toEqual(['loop_run_6']);
    expect(Object.keys((await loadStartState(dir)).numbers)).toEqual(['loop_run_6']);
  });
});

// ---------- 6. the strategy benchmark ----------

describe('runStrategyBenchmark', () => {
  it('is deterministic', () => {
    expect(runStrategyBenchmark()).toEqual(runStrategyBenchmark());
  });

  it('bidirectional and code_ai_code beat both ai_only and code_only', () => {
    const r = runStrategyBenchmark();
    const s = Object.fromEntries(r.scores.map((x) => [x.strategy, x]));
    expect(r.scenarios).toHaveLength(6);
    expect(r.winner).toBe('bidirectional');
    expect(r.ranking).toEqual(['bidirectional', 'code_ai_code', 'code_only', 'ai_only']);
    for (const good of ['bidirectional', 'code_ai_code'] as const) {
      for (const weak of ['ai_only', 'code_only'] as const) expect(s[good]!.score).toBeGreaterThan(s[weak]!.score);
      expect(s[good]).toMatchObject({ hallucinatedClaims: 0, staleNudges: 0, safetyViolations: 0 });
    }
    expect(s.bidirectional).toMatchObject({ tasksCompleted: 6, score: 100 });
    expect(s.code_ai_code).toMatchObject({ tasksCompleted: 5, score: 83 });
    expect(s.code_only).toMatchObject({ tasksCompleted: 1, hallucinatedClaims: 0, safetyViolations: 0, aiCalls: 0 });
    expect(s.ai_only).toMatchObject({ hallucinatedClaims: 2, staleNudges: 5, safetyViolations: 3 });
  });

  it('the live failures are in the suite: ai_only nudges 5 stale items and keeps the hallucinated "cleared"', () => {
    const r = runStrategyBenchmark({ strategies: ['ai_only', 'code_ai_code'] });
    const get = (st: string, sc: string) => r.outcomes.find((o) => o.strategy === st && o.scenario === sc)!;
    expect(get('ai_only', 'stale-beeper-nudge')).toMatchObject({ staleNudges: 5, completed: false });
    expect(get('code_ai_code', 'stale-beeper-nudge')).toMatchObject({ staleNudges: 0, completed: true });
    expect(get('ai_only', 'hallucinated-clear')).toMatchObject({ hallucinatedClaims: 1, completed: false });
    const fixed = get('code_ai_code', 'hallucinated-clear');
    expect(fixed).toMatchObject({ hallucinatedClaims: 0, completed: true, aiCalls: 2 });
    expect(fixed.trace.join(' ')).toContain('code verifier rejected the draft: claimed_clear_without_tool');
  });

  it('every strategy runs every scenario', () => {
    const r = runStrategyBenchmark();
    expect(r.outcomes).toHaveLength(STRATEGIES.length * r.scenarios.length);
  });

  it('formats a scorecard, and `rufus benchmark` prints it (or JSON)', async () => {
    const text = formatBenchmark(runStrategyBenchmark());
    expect(text).toContain('Winner: Bidirectional.');
    expect(text.split('\n')[3]).toMatch(/^Bidirectional\s+6\/6\s+0\s+0\s+0\s+\d+\s+100$/);
    const out: string[] = [];
    const io = { out: (s: string) => void out.push(s), err: (s: string) => void out.push(s) };
    await main(['benchmark'], io);
    expect(out.join('\n')).toContain('Strategy benchmark: 6 scenarios');
    out.length = 0;
    await main(['benchmark', '--json'], io);
    expect(JSON.parse(out.join('\n')).winner).toBe('bidirectional');
  });
});
