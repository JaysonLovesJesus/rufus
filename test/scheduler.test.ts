import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  FakeProvider,
  FileStore,
  Scheduler,
  at,
  defineFlow,
  every,
  isQuiet,
  onEvent,
  type Flow,
  type Trigger,
} from '../src';
import { tempDir } from './helpers';

// Local-time dates, so the tests pass in any timezone.
const t = (day: number, h: number, m = 0) => new Date(2026, 0, day, h, m);

const aiFlow = (id: string, trigger: Trigger, onRun?: () => void) =>
  defineFlow({ id, name: id, description: id, trigger }, async (ctx) => {
    onRun?.();
    return ctx.ai('summarize', { prompt: 'Summarize.' });
  });

async function setup(flows: Flow[], config: object = {}) {
  const dir = await tempDir();
  const store = new FileStore(dir);
  await store.init();
  await store.writeJson(store.configFile, { version: 1, ...config });
  const provider = new FakeProvider(() => 'ok');
  const engine = new Engine({ store, provider, flows });
  return { dir, store, provider, engine, scheduler: new Scheduler(engine) };
}

describe('every()', () => {
  it('runs on the first tick, then only once the interval has passed', async () => {
    const { scheduler, provider } = await setup([aiFlow('f', every('30m'))]);
    expect((await scheduler.tick(t(5, 9, 0)))[0]!.status).toBe('ran');
    expect((await scheduler.tick(t(5, 9, 10)))[0]!.status).toBe('not-due');
    expect((await scheduler.tick(t(5, 9, 29)))[0]!.status).toBe('not-due');
    expect((await scheduler.tick(t(5, 9, 30)))[0]!.status).toBe('ran');
    expect(provider.calls).toHaveLength(2);
  });
});

describe('at()', () => {
  it('fires once a day at the time, catches up a late tick once, and never twice', async () => {
    const { scheduler, provider } = await setup([aiFlow('f', at('08:00'))]);
    expect((await scheduler.tick(t(5, 7, 59)))[0]!.status).toBe('not-due');
    expect((await scheduler.tick(t(5, 8, 0)))[0]!.status).toBe('ran');
    expect((await scheduler.tick(t(5, 8, 1)))[0]!.status).toBe('not-due');
    expect((await scheduler.tick(t(5, 23, 0)))[0]!.status).toBe('not-due');
    // next day, the machine only wakes up at 10:30: it still runs, once
    expect((await scheduler.tick(t(6, 10, 30)))[0]!.status).toBe('ran');
    expect((await scheduler.tick(t(6, 10, 31)))[0]!.status).toBe('not-due');
    expect(provider.calls).toHaveLength(2);
  });
});

describe('lastRunAt', () => {
  it('is saved in scheduler.json so a restart never double-fires', async () => {
    const flow = aiFlow('f', at('08:00'));
    const first = await setup([flow]);
    await first.scheduler.tick(t(5, 8, 0));

    const saved = JSON.parse(await readFile(path.join(first.dir, 'scheduler.json'), 'utf8'));
    expect(saved.flows.f.lastRunAt).toBe(t(5, 8, 0).toISOString());

    // a brand-new process on the same workspace
    const provider = new FakeProvider(() => 'ok');
    const restarted = new Scheduler(new Engine({ store: first.dir, provider, flows: [flow] }));
    expect((await restarted.tick(t(5, 8, 30)))[0]!.status).toBe('not-due');
    expect(provider.calls).toHaveLength(0);
    expect((await restarted.tick(t(6, 8, 0)))[0]!.status).toBe('ran');
  });
});

describe('quiet hours', () => {
  const quiet = { quietHours: { start: '22:00', end: '07:00' } };

  it('isQuiet handles windows that wrap midnight and ones that do not', () => {
    const wrap = { start: '22:00', end: '07:00' };
    expect([isQuiet(t(5, 23), wrap), isQuiet(t(5, 3), wrap), isQuiet(t(5, 7), wrap), isQuiet(t(5, 12), wrap)]).toEqual([
      true, true, false, false,
    ]);
    expect(isQuiet(t(5, 13), { start: '12:00', end: '14:00' })).toBe(true);
    expect(isQuiet(t(5, 15), { start: '12:00', end: '14:00' })).toBe(false);
    expect(isQuiet(t(5, 3), { start: '09:00', end: '09:00' })).toBe(false);
    expect(isQuiet(t(5, 3), undefined)).toBe(false);
  });

  it('suppresses a due trigger (no run, no AI) and runs it once quiet hours end', async () => {
    const { scheduler, provider, engine } = await setup([aiFlow('f', every('1h'))], quiet);
    const [r] = await scheduler.tick(t(5, 23, 0));
    expect(r!.status).toBe('quiet-hours');
    expect(provider.calls).toHaveLength(0);
    expect(await engine.store.listRuns()).toHaveLength(0);
    // still owed afterwards
    expect((await scheduler.tick(t(6, 7, 0)))[0]!.status).toBe('ran');
    expect(provider.calls).toHaveLength(1);
  });

  it('lets urgent triggers through', async () => {
    const { scheduler, provider } = await setup(
      [aiFlow('calm', every('1h')), aiFlow('urgent', every('1h', { urgent: true }))],
      quiet,
    );
    const results = await scheduler.tick(t(5, 23, 0));
    expect(Object.fromEntries(results.map((r) => [r.flowId, r.status]))).toEqual({ calm: 'quiet-hours', urgent: 'ran' });
    expect(provider.calls).toHaveLength(1);
  });

  it('reports a bad quietHours config instead of silently ignoring it', async () => {
    const { scheduler } = await setup([aiFlow('f', every('1h'))], { quietHours: { start: '25:00', end: '07:00' } });
    await expect(scheduler.tick(t(5, 9))).rejects.toThrow(/Invalid time/);
  });
});

describe('when() gate', () => {
  it('false: no run is created and the provider is never called', async () => {
    let gateCalls = 0;
    const { scheduler, provider, engine } = await setup([
      aiFlow('f', every('10m', { when: () => (gateCalls++, false) })),
    ]);
    for (let i = 0; i < 5; i++) {
      const [r] = await scheduler.tick(t(5, 9, i * 10));
      expect(r!.status).toBe('gate-closed');
    }
    expect(gateCalls).toBe(5);
    expect(provider.calls).toHaveLength(0);
    expect(await engine.store.listRuns()).toHaveLength(0);
  });

  it('is checked at the interval, not on every tick', async () => {
    let gateCalls = 0;
    const { scheduler } = await setup([aiFlow('f', every('30m', { when: () => (gateCalls++, false) }))]);
    await scheduler.tick(t(5, 9, 0));
    await scheduler.tick(t(5, 9, 10));
    await scheduler.tick(t(5, 9, 20));
    expect(gateCalls).toBe(1);
  });

  it('can be async, and a persisted ctx.state lets it spot change so AI only runs when something moved', async () => {
    let inbox = 3;
    const when = async (ctx: { state: Record<string, unknown> }) => {
      const changed = ctx.state.inbox !== inbox;
      ctx.state.inbox = inbox;
      return changed;
    };
    const { scheduler, provider, dir } = await setup([aiFlow('f', every('10m', { when }))]);

    expect((await scheduler.tick(t(5, 9, 0)))[0]!.status).toBe('ran'); // first look: new to us
    expect((await scheduler.tick(t(5, 9, 10)))[0]!.status).toBe('gate-closed');
    expect((await scheduler.tick(t(5, 9, 20)))[0]!.status).toBe('gate-closed');
    inbox = 4;
    expect((await scheduler.tick(t(5, 9, 30)))[0]!.status).toBe('ran');
    expect(provider.calls).toHaveLength(2);
    expect(JSON.parse(await readFile(path.join(dir, 'scheduler.json'), 'utf8')).flows.f.state).toEqual({ inbox: 4 });
  });

  it('receives the flow, time and last run, and a throwing gate is reported without stopping other flows', async () => {
    const seen: unknown[] = [];
    const boom = aiFlow('boom', every('1h', { when: () => { throw new Error('gate broke'); } }));
    const fine = aiFlow('fine', every('1h', { when: (ctx) => (seen.push([ctx.flowId, ctx.now, ctx.lastRunAt]), true) }));
    const { scheduler } = await setup([boom, fine]);
    const results = await scheduler.tick(t(5, 9));
    expect(results.find((r) => r.flowId === 'boom')).toMatchObject({ status: 'error', error: 'gate broke' });
    expect(results.find((r) => r.flowId === 'fine')!.status).toBe('ran');
    expect(seen).toEqual([['fine', t(5, 9), undefined]]);
    await scheduler.tick(t(5, 10));
    expect(seen[1]).toEqual(['fine', t(5, 10), t(5, 9).toISOString()]);
  });
});

describe('inputs and overlap', () => {
  it('passes trigger input (static or computed) to the run', async () => {
    const seen: unknown[] = [];
    const mk = (id: string, input: unknown) =>
      defineFlow({ id, name: id, description: id, trigger: every('1h', { input }) }, async (ctx) => void seen.push(ctx.input));
    const { scheduler } = await setup([mk('a', { n: 1 }), mk('b', () => ({ n: 2 }))]);
    await scheduler.tick(t(5, 9));
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('does not pile up cards: a flow still waiting on a human is skipped (unless allowOverlap)', async () => {
    const waiting = (id: string, allowOverlap?: boolean) =>
      defineFlow({ id, name: id, description: id, trigger: every('10m', { allowOverlap }) }, async (ctx) => {
        await ctx.human('look', { title: 't', summary: 's' });
      });
    const { scheduler, engine } = await setup([waiting('strict'), waiting('loose', true)]);
    await scheduler.tick(t(5, 9, 0));
    const second = await scheduler.tick(t(5, 9, 10));
    expect(Object.fromEntries(second.map((r) => [r.flowId, r.status]))).toEqual({ strict: 'busy', loose: 'ran' });
    expect((await engine.pending()).filter((c) => c.flowId === 'strict')).toHaveLength(1);
  });
});

describe('onEvent() and emit()', () => {
  it('starts matching flows with the payload, only on emit, and honours the gate and quiet hours', async () => {
    const seen: unknown[] = [];
    const flow = defineFlow(
      { id: 'ev', name: 'ev', description: 'ev', trigger: onEvent('mail.arrived', { when: (c) => (c.event!.payload as { vip: boolean }).vip }) },
      async (ctx) => void seen.push(ctx.input),
    );
    const urgent = defineFlow(
      { id: 'ev2', name: 'ev2', description: 'ev2', trigger: onEvent('mail.arrived', { urgent: true }) },
      async (ctx) => void seen.push(['urgent', ctx.input]),
    );
    const { scheduler } = await setup([flow, urgent], { quietHours: { start: '22:00', end: '07:00' } });

    expect(await scheduler.tick(t(5, 12))).toEqual([]); // events are never polled
    expect(await scheduler.emit('other', {}, t(5, 12))).toEqual([]);

    const day = await scheduler.emit('mail.arrived', { vip: false }, t(5, 12));
    expect(day.map((r) => [r.flowId, r.status])).toEqual([['ev', 'gate-closed'], ['ev2', 'ran']]);
    await scheduler.emit('mail.arrived', { vip: true }, t(5, 12));
    expect(seen).toEqual([['urgent', { vip: false }], { vip: true }, ['urgent', { vip: true }]]);

    const night = await scheduler.emit('mail.arrived', { vip: true }, t(5, 23));
    expect(night.map((r) => [r.flowId, r.status])).toEqual([['ev', 'quiet-hours'], ['ev2', 'ran']]);
  });
});

describe('startLoop()', () => {
  it('ticks repeatedly until stopped, and stop() waits for the pass in flight', async () => {
    const { scheduler, provider } = await setup([aiFlow('f', every('1s'))]);
    const passes: number[] = [];
    const loop = scheduler.startLoop({ intervalMs: 5, onTick: (r) => passes.push(r.length) });
    await new Promise((r) => setTimeout(r, 60));
    await loop.stop();
    const n = passes.length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(provider.calls).toHaveLength(1); // every('1s') stayed deduped across the passes
    await new Promise((r) => setTimeout(r, 30));
    expect(passes).toHaveLength(n);
  });

  it('reports a failing pass to onError and keeps going', async () => {
    const { scheduler } = await setup([aiFlow('f', every('1h'))], { quietHours: { start: 'nope', end: '07:00' } });
    const errors: string[] = [];
    const loop = scheduler.startLoop({ intervalMs: 5, onError: (e) => errors.push(e.message) });
    await new Promise((r) => setTimeout(r, 40));
    await loop.stop();
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('trigger validation', () => {
  it('rejects bad times, intervals and event names when the flow is defined', () => {
    expect(() => at('8am')).toThrow(/Invalid time/);
    expect(() => at('24:00')).toThrow(/Invalid time/);
    expect(() => every('soon')).toThrow(/Invalid interval/);
    expect(() => every('0m')).toThrow(/Invalid interval/);
    expect(() => onEvent(' ')).toThrow(/event name/);
    expect(() => defineFlow({ id: 'x', name: 'x', description: 'x', trigger: { type: 'every', interval: 'x' } }, async () => {})).toThrow(
      /Invalid interval/,
    );
  });
});
