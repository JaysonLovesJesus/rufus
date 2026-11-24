import { describe, expect, it } from 'vitest';
import {
  CardBridge,
  ChiefOfStaff,
  Engine,
  FakeProvider,
  defineFlow,
  type IncomingMessage,
  type LiveChannel,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

class FakeChannel implements LiveChannel {
  sent: string[] = [];
  inbox: IncomingMessage[] = [];
  private n = 0;
  async send(text: string) {
    this.sent.push(text);
  }
  async poll(since?: string) {
    return this.inbox.filter((m) => !since || !m.at || m.at >= since);
  }
  human(text: string) {
    this.inbox.push({ id: `in_${++this.n}`, text, at: new Date(Date.now() + 60_000 + this.n).toISOString() });
  }
}

const approve = defineFlow<{ who: string }, { decision: string }>(
  { id: 'approve', name: 'Approve', description: 'Ask whether to approve someone' },
  async (ctx) => {
    const a = await ctx.human('ok', { title: `Approve ${ctx.input.who}?`, summary: 'Go?', options: ['Yes', 'No'] });
    return { decision: a.choice! };
  },
);

const sum = defineFlow<{ a: number; b: number }, { total: number }>(
  { id: 'sum', name: 'Sum', description: 'Adds two numbers' },
  async (ctx) => ({ total: await ctx.code('add', () => ctx.input.a + ctx.input.b) }),
);

/** A flow with an ai step, so replays and gates have something to measure. Draft must not contain "!". */
const notes = defineFlow<{ topic: string }>(
  { id: 'notes', name: 'Notes', description: 'Writes a calm line', role: 'writer' },
  async (ctx) => {
    const draft = await ctx.ai('draft', {
      prompt: `Write one line about ${ctx.input.topic}.`,
      verify: (t: string) => (t.includes('!') ? { ok: false, reason: 'No exclamation marks allowed.' } : { ok: true }),
      maxRetries: 0,
    });
    await ctx.human('review', { title: 'Review', summary: draft, options: ['Send as-is', 'Discard'] });
    return draft;
  },
);

async function setup(script: ConstructorParameters<typeof FakeProvider>[0] = () => 'Chief says hi.') {
  const provider = new FakeProvider(script);
  const engine = new Engine({ store: await tempDir(), provider, flows: [approve, sum, notes] });
  return { engine, provider, chief: new ChiefOfStaff({ engine }) };
}

describe('ChiefOfStaff fast commands (no AI from the chief)', () => {
  it('status lists open cards and running flows', async () => {
    const { engine, provider, chief } = await setup();
    expect(await chief.handleMessage('status')).toMatch(/^All clear/);

    const r = await engine.start('approve', { who: 'Sam' });
    if (r.status !== 'waiting_human') throw new Error('expected pause');
    for (const phrase of ['status', 'Pending', 'what needs me?', "What's pending?!"]) {
      const text = await chief.handleMessage(phrase);
      expect(text).toContain('Waiting on you (1):');
      expect(text).toContain('Approve Sam?');
      expect(text).toContain(`ref ${r.card.id}`);
    }
    expect(provider.calls).toHaveLength(0);
  });

  it('flows and lessons are plain lookups', async () => {
    const { engine, provider, chief } = await setup();
    expect(await chief.handleMessage('flows')).toBe(
      ['approve - Ask whether to approve someone', 'sum - Adds two numbers', 'notes - Writes a calm line'].join('\n'),
    );

    expect(await chief.handleMessage('lessons')).toMatch(/^No lessons yet/);
    await engine.lessons.add({ scope: 'global', rule: 'Keep it warm.' });
    await engine.lessons.add({ scope: 'flow:notes', rule: 'Be brief.' });
    await engine.lessons.add({ scope: 'flow:notes', rule: 'Be brief.' }); // repeated: ready to harden
    const text = await chief.handleMessage('Lessons?');
    expect(text).toContain('- Keep it warm. (global, x1)');
    expect(text).toContain('- Be brief. (flow:notes, x2, ready to harden into code)');
    expect(text).toContain('1 lesson(s) keep coming back');
    expect(provider.calls).toHaveLength(0);
  });

  it('run <flowId> [json] starts the flow: result when it finishes, the card when it pauses', async () => {
    const { engine, provider, chief } = await setup();
    const done = await chief.handle('run sum {"a": 2, "b": 3}');
    expect(done.text).toContain('Done (run_');
    expect(done.text).toContain('"total": 5');
    expect(done.cards).toEqual([]);

    const paused = await chief.handle('run approve {"who":"Ann"}');
    const [card] = await engine.pending();
    expect(paused.cards.map((c) => c.id)).toEqual([card!.id]);
    expect(paused.text).toContain('YOUR TURN: Approve Ann?');
    expect(provider.calls).toHaveLength(0);
  });

  it('run explains typos and bad JSON instead of guessing', async () => {
    const { chief, provider } = await setup();
    expect(await chief.handleMessage('run sumo')).toBe('No flow called "sumo". Available: approve, sum, notes.');
    expect(await chief.handleMessage('run sum {nope')).toContain("isn't valid JSON");
    expect(await chief.handleMessage('run sum {"a":1')).toContain("isn't valid JSON");
    expect(provider.calls).toHaveLength(0);
  });

  it('learn <scope>: <rule> goes through the v3 gate and reports accepted / rejected + suggested layer', async () => {
    const { engine, provider, chief } = await setup(() => 'Calm line');
    // With no saved cases nothing is measured, and no AI is called.
    const first = await chief.handleMessage('learn flow:notes: Keep it warm.');
    expect(first).toContain('Saved lesson for flow:notes: "Keep it warm."');
    expect(first).toContain('nothing was measured');
    expect(provider.calls).toHaveLength(0);
    expect((await engine.lessons.all()).map((l) => l.rule)).toEqual(['Keep it warm.']);

    // A bare flow id works too, and a checkable rule is pointed at code.
    const second = await chief.handleMessage('learn notes: Never use exclamation marks.');
    expect(second).toContain('Saved lesson for flow:notes');
    expect(second).toContain('looks like a code rule');
    expect(provider.calls).toHaveLength(0);
  });

  it('learn rejects a lesson that regresses a saved case, and saves nothing', async () => {
    const { engine, chief } = await setup(() => 'Calm line');
    const r = await engine.start('notes', { topic: 'tea' });
    if (r.status !== 'waiting_human') throw new Error('expected pause');
    await engine.answer(r.card.id, { choice: 'Send as-is' }); // a case that passes today

    // Once a rule is on trial the model starts shouting, so the previously passing case regresses.
    const loud = new Engine({
      store: engine.store,
      provider: new FakeProvider((req) => (req.system.includes('Be enthusiastic') ? 'Loud!' : 'Calm line')),
      flows: [notes],
    });
    const text = await new ChiefOfStaff({ engine: loud }).handleMessage('learn flow:notes: Be enthusiastic.');
    expect(text).toMatch(/^Rejected: this lesson broke 1 case/);
    expect(await loud.lessons.all()).toEqual([]);
  });

  it('reports a full scope instead of throwing', async () => {
    const { engine, chief } = await setup();
    for (let i = 1; i <= 7; i++) await engine.lessons.add({ scope: 'global', rule: `Rule ${i}` });
    expect(await chief.handleMessage('learn global: One too many')).toMatch(/Rule 1/);
    expect(await engine.lessons.all()).toHaveLength(7);
  });
});

describe('ChiefOfStaff free-form chat (code assembles context, AI replies)', () => {
  it('makes exactly one AI call with a live snapshot, and returns its words', async () => {
    const { engine, provider, chief } = await setup(() => 'Sam is waiting on a yes or no.');
    await engine.lessons.add({ scope: 'global', rule: 'Keep it warm.' });
    await engine.start('approve', { who: 'Sam' });
    await engine.start('sum', { a: 1, b: 1 });

    const reply = await chief.handle('hey, is anyone waiting on me?');
    expect(reply).toMatchObject({ text: 'Sam is waiting on a yes or no.', via: 'chat', cards: [] });
    expect(provider.calls).toHaveLength(1);
    const req = provider.calls[0]!;
    expect(req.meta).toMatchObject({ flowId: 'chief', step: 'chat' });
    const prompt = req.messages[0]!.content;
    expect(prompt).toContain('hey, is anyone waiting on me?');
    expect(prompt).toContain('"id": "approve"');
    expect(prompt).toContain('"title": "Approve Sam?"');
    expect(prompt).toContain('"rule": "Keep it warm."');
    expect(prompt).toContain('"status": "completed"');
    expect(req.system).toMatch(/never invent/);
    expect(req.system).toMatch(/explicit yes/);
  });

  it('never acts on its own: a model that asks to run a flow only gets to say so', async () => {
    const { engine, provider, chief } = await setup(() => 'run sum {"a":1,"b":1}');
    const reply = await chief.handle('please add one and one for me');
    expect(reply.text).toBe('run sum {"a":1,"b":1}');
    expect(provider.calls).toHaveLength(1);
    expect(await engine.store.listRuns()).toEqual([]); // nothing started
    expect(await engine.lessons.all()).toEqual([]);
  });

  it('treats natural language that merely starts with a command word as chat', async () => {
    const { provider, chief } = await setup(() => 'ok');
    expect(chief.isCommand('run the report for Sam today')).toBe(false);
    expect(chief.isCommand('learn how to cook: step one')).toBe(false);
    expect(chief.isCommand('status')).toBe(true);
    await chief.handle('run the report for Sam today');
    expect(provider.calls).toHaveLength(1);
  });

  it('degrades to a pointer at the quick commands when no AI is configured', async () => {
    const engine = new Engine({ store: await tempDir(), flows: [sum] });
    const reply = await new ChiefOfStaff({ engine }).handle('what should I do today?');
    expect(reply.unavailable).toBe(true);
    expect(reply.text).toContain('status, flows, lessons');
  });
});

describe('CardBridge routes to the chief', () => {
  it('with no open card, a free-form message gets a chief reply', async () => {
    const { engine, provider } = await setup(() => 'All quiet.');
    const channel = new FakeChannel();
    const bridge = new CardBridge({ engine, channel });
    await bridge.tick(); // start listening

    channel.human('how is everything going?');
    await bridge.tick();
    expect(channel.sent).toEqual(['All quiet.']);
    expect(provider.calls).toHaveLength(1);

    channel.human('flows');
    await bridge.tick();
    expect(channel.sent.at(-1)).toContain('approve - Ask whether to approve someone');
    expect(provider.calls).toHaveLength(1); // the command made no AI call
  });

  it('still answers an open card when one is open (number, free text) without calling the chief', async () => {
    const { engine, provider } = await setup();
    const channel = new FakeChannel();
    const bridge = new CardBridge({ engine, channel });
    const r = await engine.start('approve', { who: 'Sam' });
    if (r.status !== 'waiting_human') throw new Error('expected pause');
    await bridge.tick();

    channel.human('1');
    const report = await bridge.tick();
    expect(report.answered).toEqual([r.card.id]);
    expect(channel.sent.at(-1)).toBe('Got it (Yes). Done.');
    expect(provider.calls).toHaveLength(0);
  });

  it('explicit chief commands win over an open card, and the card is not answered', async () => {
    const { engine, provider } = await setup();
    const channel = new FakeChannel();
    const bridge = new CardBridge({ engine, channel });
    const r = await engine.start('approve', { who: 'Sam' });
    if (r.status !== 'waiting_human') throw new Error('expected pause');
    await bridge.tick();

    channel.human('status');
    const report = await bridge.tick();
    expect(report.answered).toEqual([]);
    expect(channel.sent.at(-1)).toContain('Waiting on you (1):');
    expect(await engine.pending()).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);

    // A ref still means "this is for that card", even if the text looks like a command.
    channel.human(`${r.card.id} 2`);
    await bridge.tick();
    expect(await engine.pending()).toEqual([]);
  });

  it('sends a card started by "run" once, not twice', async () => {
    const { engine } = await setup();
    const channel = new FakeChannel();
    const bridge = new CardBridge({ engine, channel });
    await bridge.tick();

    channel.human('run approve {"who":"Ann"}');
    const report = await bridge.tick();
    const cards = channel.sent.filter((t) => t.includes('YOUR TURN: Approve Ann?'));
    expect(cards).toHaveLength(1);
    expect(report.delivered).toEqual([]); // already in the chief's reply
    expect((await bridge.tick()).delivered).toEqual([]);
    expect(channel.sent).toHaveLength(1);

    channel.human('1'); // the card is now answerable like any other
    await bridge.tick();
    expect(await engine.pending()).toEqual([]);
  });

  it('a question while a choice-only card is open goes to the chief; with several cards it needs a ref only for answers', async () => {
    const strict = defineFlow({ id: 'strict', name: 'S', description: 'choice only' }, async (ctx) =>
      (await ctx.human('pick', { title: 'Pick', summary: 'one', options: ['Yes', 'No'], allowFreeText: false })).choice,
    );
    const { engine, provider } = await setup(() => 'Pick 1 or 2 when you can.');
    engine.register(strict);
    const channel = new FakeChannel();
    const bridge = new CardBridge({ engine, channel });
    await engine.start('strict');
    await bridge.tick();

    channel.human('what is this about?');
    await bridge.tick();
    expect(channel.sent.at(-1)).toBe('Pick 1 or 2 when you can.');
    expect(await engine.pending()).toHaveLength(1);

    await engine.start('approve', { who: 'Cy' });
    await bridge.tick();
    channel.human('1');
    await bridge.tick();
    expect(channel.sent.at(-1)).toMatch(/^2 cards are open\. Start your reply with a ref/);
    expect(provider.calls).toHaveLength(1);
  });

  it('chief: false keeps the bridge card-only', async () => {
    const { engine, provider } = await setup();
    const channel = new FakeChannel();
    const bridge = new CardBridge({ engine, channel, chief: false });
    await bridge.tick();
    channel.human('status');
    await bridge.tick();
    expect(channel.sent).toEqual(['Nothing is waiting on you right now.']);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('rufus chat', () => {
  it('answers fast commands from the CLI with no provider configured', async () => {
    const dir = await tempDir();
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    await main(['--dir', dir, 'chat', 'flows'], io);
    expect(out.join('\n')).toContain('triage-draft - ');
    await main(['--dir', dir, 'chat', 'learn', 'global:', 'Keep', 'it', 'warm.'], io);
    expect(out.join('\n')).toContain('Saved lesson for global: "Keep it warm."');
    await main(['--dir', dir, 'chat', 'lessons'], io);
    expect(out.at(-1)).toContain('- Keep it warm. (global, x1)');
    await expect(main(['--dir', dir, 'chat'], io)).rejects.toThrow(/Usage: rufus chat/);
  });
});
