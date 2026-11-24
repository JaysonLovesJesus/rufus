import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BeeperChannel,
  BeeperOfflineError,
  CardBridge,
  Engine,
  defineFlow,
  formatCardAsText,
  resolveBeeperOptions,
  type IncomingMessage,
  type LiveChannel,
} from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

/** In-memory chat: `sent` is what the bot texted; `inbox` is what the human typed. */
class FakeChannel implements LiveChannel {
  sent: string[] = [];
  inbox: IncomingMessage[] = [];
  down = false;
  private n = 0;

  async send(text: string) {
    if (this.down) throw new Error('chat app is offline');
    this.sent.push(text);
    return `out_${this.sent.length}`;
  }

  async poll(since?: string) {
    if (this.down) throw new Error('chat app is offline');
    return this.inbox.filter((m) => !since || !m.at || m.at >= since);
  }

  human(text: string, at = new Date(Date.now() + 60_000).toISOString()) {
    this.inbox.push({ id: `in_${++this.n}`, text, at });
  }
}

const approve = defineFlow<{ who: string }, { decision: string }>(
  { id: 'approve', name: 'Approve', description: 'one question' },
  async (ctx) => {
    const a = await ctx.human('ok', { title: `Approve ${ctx.input.who}?`, summary: 'Go?', options: ['Yes', 'No'] });
    return { decision: a.choice! };
  },
);

const strict = defineFlow(
  { id: 'strict', name: 'Strict', description: 'choice only' },
  async (ctx) => (await ctx.human('pick', { title: 'Pick', summary: 'one', options: ['Yes', 'No'], allowFreeText: false })).choice,
);

const twoStep = defineFlow<unknown, { final: string }>(
  { id: 'two-step', name: 'Two step', description: 'two questions' },
  async (ctx) => {
    await ctx.human('first', { title: 'First?', summary: 'one', options: ['A', 'B'] });
    const b = await ctx.human('second', { title: 'Second?', summary: 'two', options: ['C', 'D'] });
    return { final: b.choice! };
  },
);

async function setup() {
  const dir = await tempDir();
  const engine = new Engine({ store: dir, flows: [approve, twoStep, strict] });
  const channel = new FakeChannel();
  const bridge = () => new CardBridge({ engine, channel });
  return { dir, engine, channel, bridge };
}

describe('CardBridge delivery', () => {
  it('texts a pending card once, even across bridge restarts', async () => {
    const { dir, engine, channel, bridge } = await setup();
    const r = await engine.start('approve', { who: 'Sam' });
    if (r.status !== 'waiting_human') throw new Error('expected pause');

    const first = bridge();
    expect((await first.tick()).delivered).toEqual([r.card.id]);
    expect((await first.tick()).delivered).toEqual([]);
    expect((await bridge().tick()).delivered).toEqual([]); // "restart"
    expect(channel.sent).toEqual([formatCardAsText(r.card)]);

    const state = JSON.parse(await readFile(path.join(dir, 'bridge-state.json'), 'utf8'));
    expect(state.delivered).toEqual([r.card.id]);
  });

  it('sends cards that appear later, and retries (without duplicates) after a channel failure', async () => {
    const { engine, channel, bridge } = await setup();
    const b = bridge();
    channel.down = true;
    const r = await engine.start('approve', { who: 'Sam' });
    if (r.status !== 'waiting_human') throw new Error('expected pause');

    const failed = await b.tick();
    expect(failed.error).toMatch(/offline/);
    expect(failed.delivered).toEqual([]);

    channel.down = false;
    expect((await b.tick()).delivered).toEqual([r.card.id]);
    expect((await b.tick()).delivered).toEqual([]);
    expect(channel.sent).toHaveLength(1);
  });
});

describe('CardBridge replies', () => {
  it('"1" answers the open card, resumes the flow and confirms in one line', async () => {
    const { engine, channel, bridge } = await setup();
    const r = await engine.start('approve', { who: 'Sam' });
    if (r.status !== 'waiting_human') throw new Error('expected pause');
    const b = bridge();
    await b.tick();

    channel.human('1');
    const report = await b.tick();
    expect(report.answered).toEqual([r.card.id]);
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[1]).toBe('Got it (Yes). Done.');
    expect(await engine.pending()).toEqual([]);
    const run = await engine.store.getRun(r.runId);
    expect(run.output).toEqual({ decision: 'yes' });

    expect((await b.tick()).answered).toEqual([]); // same message is never handled twice
    expect((await bridge().tick()).answered).toEqual([]); // ...even after a restart
    expect(channel.sent).toHaveLength(2);
  });

  it('accepts free text (a voice-note transcript) and a Lesson line', async () => {
    const { engine, channel, bridge } = await setup();
    const open = defineFlow(
      { id: 'open', name: 'Open', description: 'free text' },
      async (ctx) => (await ctx.human('say', { title: 'What now?', summary: 'Tell me.' })).text,
    );
    engine.register(open);
    const r = await engine.start('open');
    if (r.status !== 'waiting_human') throw new Error('expected pause');
    const b = bridge();
    await b.tick();

    channel.human('Move it to Friday please.\nLesson: Mornings only');
    await b.tick();
    expect((await engine.store.getRun(r.runId)).output).toBe('Move it to Friday please.');
    expect(channel.sent.at(-1)).toBe('Got it (your note). Done. Lesson saved.');
    expect((await engine.lessons.all()).map((l) => l.rule)).toEqual(['Mornings only']);
  });

  it('sends the next card when the flow pauses again, instead of a confirmation', async () => {
    const { engine, channel, bridge } = await setup();
    const r = await engine.start('two-step');
    if (r.status !== 'waiting_human') throw new Error('expected pause');
    const b = bridge();
    await b.tick();
    channel.human('2');
    const report = await b.tick();

    const [next] = await engine.pending();
    expect(next!.title).toBe('Second?');
    expect(report.delivered).toEqual([next!.id]);
    expect(channel.sent.at(-1)).toBe(formatCardAsText(next!));
    expect(channel.sent).toHaveLength(2);
    expect((await b.tick()).delivered).toEqual([]);
  });

  it('with several open cards, needs a ref prefix; the ref picks the card', async () => {
    const { engine, channel, bridge } = await setup();
    const a = await engine.start('approve', { who: 'Ann' });
    const c = await engine.start('approve', { who: 'Cy' });
    if (a.status !== 'waiting_human' || c.status !== 'waiting_human') throw new Error('expected pauses');
    const b = bridge();
    await b.tick();
    expect(channel.sent).toHaveLength(2);

    channel.human('1');
    await b.tick();
    expect(channel.sent.at(-1)).toMatch(/^2 cards are open\. Start your reply with a ref/);
    expect(await engine.pending()).toHaveLength(2);

    channel.human(`${c.card.id.slice(0, 6)} 2`);
    await b.tick();
    expect((await engine.store.getRun(c.runId)).output).toEqual({ decision: 'no' });
    expect((await engine.pending()).map((x) => x.id)).toEqual([a.card.id]);

    channel.human('ref c_ffffff 1');
    await b.tick();
    expect(channel.sent.at(-1)).toBe('No open card matches "c_ffffff".');
    expect(await engine.pending()).toHaveLength(1);
  });

  it('says so when a reply cannot be read or nothing is open', async () => {
    const { engine, channel, bridge } = await setup();
    const r = await engine.start('strict');
    if (r.status !== 'waiting_human') throw new Error('expected pause');
    const b = bridge();
    await b.tick();

    channel.human('hmm not sure');
    await b.tick();
    expect(channel.sent.at(-1)).toBe("Couldn't read that as an answer. Reply 1 (Yes), 2 (No).");
    expect(await engine.pending()).toHaveLength(1);

    channel.human('2');
    await b.tick();
    channel.human('anything');
    await b.tick();
    expect(channel.sent.at(-1)).toBe('Nothing is waiting on you right now.');
  });

  it("never answers itself when the channel echoes the bot's own texts back", async () => {
    const { engine, channel, bridge } = await setup();
    const r = await engine.start('approve', { who: 'Sam' });
    if (r.status !== 'waiting_human') throw new Error('expected pause');
    const b = bridge();
    await b.tick();
    channel.human(channel.sent[0]!); // echo of the card itself
    const report = await b.tick();
    expect(report.ignored).toBe(1);
    expect(report.answered).toEqual([]);
    expect(channel.sent).toHaveLength(1);
  });

  it('does not replay chat history from before the bridge first started', async () => {
    const { engine, channel, bridge } = await setup();
    channel.human('1', '2000-01-01T00:00:00.000Z');
    const r = await engine.start('approve', { who: 'Sam' });
    if (r.status !== 'waiting_human') throw new Error('expected pause');
    const report = await bridge().tick();
    expect(report.answered).toEqual([]);
    expect(await engine.pending()).toHaveLength(1);
  });
});

describe('BeeperChannel', () => {
  type Call = { url: string; init: RequestInit };
  const mockFetch = (respond: (call: Call) => Response | Promise<Response>) => {
    const calls: Call[] = [];
    const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
      const call = { url: String(url), init };
      calls.push(call);
      return respond(call);
    }) as typeof fetch;
    return { fn, calls };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const opts = { token: 'test-token', chatId: '!room:example.org' };

  it('sends to the configured chat with the bearer token', async () => {
    const { fn, calls } = mockFetch(() => json({ chatID: '!room:example.org', pendingMessageID: 'pending_1' }));
    const beeper = new BeeperChannel({ ...opts, fetch: fn });
    expect(await beeper.send('hello')).toBe('pending_1');
    expect(calls[0]!.url).toBe('http://localhost:23373/v1/chats/!room%3Aexample.org/messages');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer test-token');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ text: 'hello' });
  });

  it('polls only human messages: drops self-sent, deleted and non-text, keeps voice transcripts, oldest first', async () => {
    const { fn } = mockFetch(() =>
      json({
        items: [
          { id: 'm3', isSender: false, type: 'TEXT', text: 'later', timestamp: '2026-01-01T00:00:03Z' },
          { id: 'm1', isSender: true, type: 'TEXT', text: 'bot said this', timestamp: '2026-01-01T00:00:01Z' },
          { id: 'm2', isSender: false, type: 'TEXT', text: '1', timestamp: '2026-01-01T00:00:02Z' },
          { id: 'm4', isSender: false, type: 'IMAGE', timestamp: '2026-01-01T00:00:04Z' },
          { id: 'm5', isSender: false, type: 'TEXT', text: 'gone', isDeleted: true, timestamp: '2026-01-01T00:00:05Z' },
          {
            id: 'm6',
            isSender: false,
            type: 'VOICE',
            timestamp: '2026-01-01T00:00:06Z',
            attachments: [{ type: 'audio', transcription: { transcription: 'make it shorter' } }],
          },
          { id: 'm0', isSender: false, type: 'TEXT', text: 'old', timestamp: '2025-12-31T00:00:00Z' },
        ],
      }),
    );
    const beeper = new BeeperChannel({ ...opts, fetch: fn });
    const got = await beeper.poll('2026-01-01T00:00:00Z');
    expect(got.map((m) => [m.id, m.text])).toEqual([
      ['m2', '1'],
      ['m3', 'later'],
      ['m6', 'make it shorter'],
    ]);
    expect(got[0]!.at).toBe('2026-01-01T00:00:02Z');
  });

  it('selfChat keeps your own account\'s messages (the bridge filters its own echoes)', async () => {
    const { fn } = mockFetch(() => json({ items: [{ id: 'a', isSender: true, type: 'TEXT', text: '2', timestamp: 't' }] }));
    expect(await new BeeperChannel({ ...opts, fetch: fn }).poll()).toEqual([]);
    expect((await new BeeperChannel({ ...opts, selfChat: true, fetch: fn }).poll()).map((m) => m.text)).toEqual(['2']);
  });

  it('reports offline cleanly when Beeper Desktop is not running', async () => {
    const { fn } = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const beeper = new BeeperChannel({ ...opts, fetch: fn });
    expect(await beeper.status()).toEqual({ online: false, reason: expect.stringContaining('not reachable') });
    await expect(beeper.send('x')).rejects.toBeInstanceOf(BeeperOfflineError);
    await expect(beeper.poll()).rejects.toBeInstanceOf(BeeperOfflineError);
  });

  it('explains auth failures and reports online when healthy', async () => {
    const denied = new BeeperChannel({ ...opts, fetch: mockFetch(() => json({ error: 'nope' }, 401)).fn });
    await expect(denied.send('x')).rejects.toThrow(/401.*RUFUS_BEEPER_TOKEN/);
    const ok = new BeeperChannel({ ...opts, fetch: mockFetch(() => json({ items: [] })).fn });
    expect(await ok.status()).toEqual({ online: true });
  });

  it('keeps the bridge alive when Beeper is down, then delivers once it is back', async () => {
    const dir = await tempDir();
    const engine = new Engine({ store: dir, flows: [approve] });
    let online = false;
    const sentBodies: string[] = [];
    const { fn } = mockFetch(({ init }) => {
      if (!online) throw new TypeError('fetch failed');
      if (init.method === 'POST') {
        sentBodies.push(JSON.parse(init.body as string).text);
        return json({ pendingMessageID: `p${sentBodies.length}` });
      }
      return json({ items: [] });
    });
    const bridge = new CardBridge({ engine, channel: new BeeperChannel({ ...opts, fetch: fn }) });
    await engine.start('approve', { who: 'Sam' });

    const down = await bridge.tick();
    expect(down.error).toMatch(/not reachable/);
    online = true;
    expect((await bridge.tick()).delivered).toHaveLength(1);
    expect((await bridge.tick()).delivered).toHaveLength(0);
    expect(sentBodies).toHaveLength(1);
  });
});

describe('Beeper config', () => {
  it('env overrides config.json; url defaults to localhost', () => {
    expect(resolveBeeperOptions({ token: 'file', chatId: 'file-chat' }, {})).toMatchObject({
      url: 'http://localhost:23373',
      token: 'file',
      chatId: 'file-chat',
    });
    expect(
      resolveBeeperOptions({ token: 'file', chatId: 'file-chat' }, { RUFUS_BEEPER_TOKEN: 'env', RUFUS_BEEPER_URL: 'http://x:1', RUFUS_BEEPER_SELF_CHAT: 'true' }),
    ).toMatchObject({ url: 'http://x:1', token: 'env', chatId: 'file-chat', selfChat: true });
  });

  it('says what is missing', () => {
    expect(() => resolveBeeperOptions({}, {})).toThrow(/RUFUS_BEEPER_TOKEN and RUFUS_BEEPER_CHAT_ID/);
  });
});

describe('rufus bridge (cli)', () => {
  it('--once sends the demo card to the channel, then applies a reply', async () => {
    const dir = await tempDir();
    const lines: string[] = [];
    const io = { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) };
    const channel = new FakeChannel();

    await main(['--dir', dir, 'demo'], io); // pauses on the example card
    await main(['--dir', dir, 'bridge', '--once'], io, { channel });
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toContain('YOUR TURN: Reply to Sam Rivera?');
    expect(lines.join('\n')).toMatch(/sent card c_/);

    channel.human('1');
    await main(['--dir', dir, 'bridge', '--once'], io, { channel });
    expect(channel.sent.at(-1)).toBe('Got it (Send as-is). Done.');

    lines.length = 0;
    await main(['--dir', dir, 'bridge', '--once'], io, { channel });
    expect(lines).toEqual(['Nothing new.']);
  });
});
