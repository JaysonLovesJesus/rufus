import { describe, expect, it } from 'vitest';
import { FakeProvider, MasterLoop, ToolRegistry, beeperTools, classifyByCode, messageTriageHandler, type LoopSignal, type Sensor } from '../src';
import { classifyBurst } from '../src/sensors';
import { formatCheckin, formatLoopItem } from '../src/unified/loop-text';
import { tempDir } from './helpers';

const NOW = new Date(2026, 10, 25, 8, 0);
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const msg = (id: string, text: string, over: Partial<LoopSignal> = {}): LoopSignal => ({ id, surface: 'chat', kind: 'message.received', text, actor: 'Mom', timestamp: at(Number(id) || 0), data: { chatId: 'c-mom' }, ...over });

/** A sensor that hands out one batch of signals per pass. */
function scripted(batches: LoopSignal[][]): Sensor {
  let i = 0;
  return { id: 'beeper', surface: 'chat', poll: () => ({ signals: batches[i++] ?? [], nextCursor: String(i) }) };
}

function fakeBeeper(thread: Array<Record<string, unknown>> = []) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: decodeURIComponent(u.pathname), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const body = method === 'GET' ? { items: thread } : { pendingMessageID: 'pm_1' };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe('v16: one conversation, one item', () => {
  it('a burst of messages from one chat becomes ONE item with ONE draft that sees all of it', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(['{"label":"batch","reason":"checking in"}', '{"reply":"All good! I will text Jamie now."}']);
    const loop = new MasterLoop({
      dir,
      sensors: [scripted([[msg('1', 'You doing okay today?'), msg('2', 'Jamie got worried you never responded'), msg('3', 'https://youtu.be/x')]])],
      handlers: [messageTriageHandler()],
      providers: { fast: provider },
      now: () => NOW,
    });
    const r = await loop.runOnce();
    expect(r.runs).toHaveLength(1);
    const run = await loop.getRun(r.runs[0]!.runId);
    expect(run.signal.text).toBe('You doing okay today?\nJamie got worried you never responded\nhttps://youtu.be/x');
    expect(provider.calls[1]!.messages[0]!.content).toContain('Jamie got worried');
    expect(run.status).toBe('awaiting_human_verify');
  });

  it('a newer message folds a still-waiting item from the same chat into one fresh item; other chats are untouched', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(['{"label":"batch","reason":"a"}', '{"reply":"Hi"}', '{"label":"batch","reason":"b"}', '{"reply":"Yes"}', '{"label":"batch","reason":"c"}', '{"reply":"Sure, 3 works"}']);
    const loop = new MasterLoop({
      dir,
      sensors: [scripted([[msg('1', 'Are you around?'), msg('2', 'Lunch?', { actor: 'Sam', data: { chatId: 'c-sam' } })], [msg('3', 'Can we talk at 3?')]])],
      handlers: [messageTriageHandler()],
      providers: { fast: provider },
      now: () => NOW,
    });
    await loop.runOnce();
    expect((await loop.pending()).map((r) => r.signal.actor)).toEqual(['Mom', 'Sam']);
    const second = await loop.runOnce();
    expect(second.folded).toHaveLength(1);
    const pending = await loop.pending();
    expect(pending.map((r) => r.signal.actor).sort()).toEqual(['Mom', 'Sam']);
    expect(pending.find((r) => r.signal.actor === 'Mom')!.signal.text).toBe('Are you around?\nCan we talk at 3?');
  });

  it('when you reply in that chat yourself, what waited on it closes: nothing nags, nothing is sent', async () => {
    const dir = await tempDir();
    const b = fakeBeeper();
    const provider = new FakeProvider(['{"label":"batch","reason":"a"}', '{"reply":"Hi Mom"}']);
    const loop = new MasterLoop({
      dir,
      sensors: [scripted([[msg('1', 'Call me later?')], [{ id: '2', surface: 'chat', kind: 'message.sent', actor: 'me', timestamp: at(2), data: { chatId: 'c-mom' } }]])],
      handlers: [messageTriageHandler()],
      tools: new ToolRegistry({ tools: beeperTools({ fetch: b.fetch }) }),
      providers: { fast: provider },
      now: () => NOW,
    });
    await loop.runOnce();
    const [waiting] = await loop.pending();
    const r = await loop.runOnce();
    expect(r.resolved).toEqual([waiting!.id]);
    expect(r.runs).toEqual([]); // your own message is never a work item
    expect(await loop.pending()).toEqual([]);
    expect((await loop.getRun(waiting!.id)).status).toBe('expired');
    expect(b.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('call notices are ignored for free; a burst is only ignored when every line is', () => {
    expect(classifyByCode('Incoming call. Use the WhatsApp app to answer.')?.label).toBe('ignore');
    expect(classifyByCode('Missed voice call')?.label).toBe('ignore');
    expect(classifyBurst('ok\nthanks!')?.label).toBe('ignore');
    expect(classifyBurst('ok\nwait, are we still on for 3?')).toBeUndefined();
    expect(classifyBurst('hi\nurgent: call me')?.label).toBe('urgent');
  });

  it('"don\'t forget to ..." becomes a to-do for you, never a drafted reply', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(['{"label":"todo","reason":"a reminder","todo":"Reimburse Pat."}']);
    const loop = new MasterLoop({ dir, sensors: [scripted([[msg('1', "Don't forget to reimburse Pat", { actor: 'Lee' })]])], handlers: [messageTriageHandler()], providers: { fast: provider }, now: () => NOW });
    const run = await loop.getRun((await loop.runOnce()).runs[0]!.runId);
    expect(run).toMatchObject({ status: 'awaiting_human_execute', actionType: 'todo.chat', humanStep: 'Reimburse Pat' });
    expect(provider.calls).toHaveLength(1); // no draft was written
    expect(formatLoopItem(run, 1)).toMatch(/^Reimburse Pat \(Lee: "Don't forget to reimburse Pat"\)/);
  });

  it('the draft sees the real conversation (your own messages included) through beeper.read', async () => {
    const dir = await tempDir();
    const b = fakeBeeper([{ id: 'a', text: 'Dinner Sunday?', isSender: true, timestamp: at(-30) }, { id: 'b', text: 'Yes! What time?', senderName: 'Mom', timestamp: at(1) }]);
    const provider = new FakeProvider(['{"label":"batch","reason":"a"}', '{"reply":"6pm?"}']);
    const loop = new MasterLoop({ dir, sensors: [scripted([[msg('1', 'Yes! What time?')]])], handlers: [messageTriageHandler()], tools: new ToolRegistry({ tools: beeperTools({ fetch: b.fetch }) }), providers: { fast: provider }, now: () => NOW });
    await loop.runOnce();
    expect(provider.calls[1]!.messages[0]!.content).toContain('Me: Dinner Sunday?');
  });
});

describe('v16: check-ins read like a person, not a ticket queue', () => {
  it('several items: one short lead, each item two lines, the how-to-answer said once', async () => {
    const dir = await tempDir();
    const provider = new FakeProvider(['{"label":"batch","reason":"a"}', '{"reply":"All good, you?"}', '{"label":"batch","reason":"b"}', '{"reply":"Thursday works."}']);
    const loop = new MasterLoop({ dir, sensors: [scripted([[msg('1', 'You okay today?'), msg('2', 'Lunch Thursday?', { actor: 'Sam', data: { chatId: 'c-sam' } })]])], handlers: [messageTriageHandler()], providers: { fast: provider }, now: () => NOW });
    await loop.runOnce();
    const items = (await loop.pending()).map((run, i) => ({ run, n: i + 1 }));
    const text = formatCheckin(items);
    expect(text).toBe(['Catching you up on 2:', '', '#1 Mom: "You okay today?"\n→ "All good, you?"', '', '#2 Sam: "Lunch Thursday?"\n→ "Thursday works."', '', 'Answer with the number: "#1 send", "#1 skip" or "#1 edit: your version".'].join('\n'));
    expect(text).not.toMatch(/\(urgent\)|\(focus\)|to send, /);
  });
});
