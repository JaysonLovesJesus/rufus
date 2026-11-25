import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrustStore, formatTrust, promotionMessage } from '../src';
import { main } from '../src/cli';
import { tempDir } from './helpers';

function capture() {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) } };
}

describe('Earned Trust', () => {
  it('starts every action at check with nothing recorded, and does not write on read', async () => {
    const dir = await tempDir();
    const trust = new TrustStore(dir);
    const r = await trust.get('reply.chat');
    expect(r).toMatchObject({ actionType: 'reply.chat', autonomy: 'check', accepted: 0, edited: 0, rejected: 0, consecutiveClean: 0, promotionThreshold: 10, promotionSuggested: false });
    expect(await trust.all()).toEqual([]);
    await expect(trust.get('not valid!')).rejects.toThrow(/not an action type/);
  });

  it('suggests promotion after N clean approvals in a row, once', async () => {
    const dir = await tempDir();
    const trust = new TrustStore(dir, { promotionThreshold: 3 });
    const a = await trust.recordFeedback('schedule.block', 'accept');
    const b = await trust.recordFeedback('schedule.block', 'accept');
    expect([a.promotionNewlySuggested, b.promotionNewlySuggested, b.record.promotionSuggested]).toEqual([false, false, false]);
    const c = await trust.recordFeedback('schedule.block', 'accept', 'perfect');
    expect(c.promotionNewlySuggested).toBe(true);
    expect(c.record).toMatchObject({ accepted: 3, consecutiveClean: 3, promotionSuggested: true, autonomy: 'check', lastNote: 'perfect' });
    const d = await trust.recordFeedback('schedule.block', 'accept');
    expect(d.promotionNewlySuggested).toBe(false); // already suggested
    expect(d.record.promotionSuggested).toBe(true);
    expect(promotionMessage(d.record)).toBe("You've approved schedule.block cleanly 4 times in a row - want me to stop checking with you? (rufus trust promote schedule.block)");
    // It is only a suggestion: still check until the human promotes.
    expect((await trust.get('schedule.block')).autonomy).toBe('check');
  });

  it('an edit or a rejection resets the streak and withdraws the suggestion', async () => {
    const dir = await tempDir();
    const trust = new TrustStore(dir, { promotionThreshold: 2 });
    await trust.recordFeedback('email.triage', 'accept');
    await trust.recordFeedback('email.triage', 'accept');
    const edited = await trust.recordFeedback('email.triage', 'edit');
    expect(edited.record).toMatchObject({ accepted: 2, edited: 1, consecutiveClean: 0, promotionSuggested: false });
    await trust.recordFeedback('email.triage', 'accept');
    const rejected = await trust.recordFeedback('email.triage', 'reject');
    expect(rejected.record).toMatchObject({ rejected: 1, consecutiveClean: 0, promotionSuggested: false, autonomy: 'check' });
    expect(rejected.demoted).toBe(false);
  });

  it('promote / demote, and a rejection of an autonomous action demotes it at once', async () => {
    const dir = await tempDir();
    const trust = new TrustStore(dir, { promotionThreshold: 1 });
    await trust.recordFeedback('research.brief', 'accept');
    const promoted = await trust.promote('research.brief');
    expect(promoted).toMatchObject({ autonomy: 'autonomous', promotionSuggested: false });
    // Accepting while autonomous never re-suggests.
    expect((await trust.recordFeedback('research.brief', 'accept')).record.promotionSuggested).toBe(false);
    const rejected = await trust.recordFeedback('research.brief', 'reject', 'wrong sources');
    expect(rejected.demoted).toBe(true);
    expect(rejected.record).toMatchObject({ autonomy: 'check', consecutiveClean: 0 });
    await trust.promote('research.brief');
    expect(await trust.demote('research.brief')).toMatchObject({ autonomy: 'check', consecutiveClean: 0 });
  });

  it('persists in trust.json, survives concurrent writes, and per-action thresholds can change', async () => {
    const dir = await tempDir();
    const trust = new TrustStore(dir);
    await Promise.all(Array.from({ length: 8 }, () => trust.recordFeedback('reply.chat', 'accept')));
    const file = JSON.parse(await readFile(path.join(dir, 'trust.json'), 'utf8'));
    expect(file.actions['reply.chat'].accepted).toBe(8);
    const lowered = await trust.setThreshold('reply.chat', 5);
    expect(lowered).toMatchObject({ promotionThreshold: 5, promotionSuggested: true });
    expect((await new TrustStore(dir).get('reply.chat')).consecutiveClean).toBe(8);
    await expect(trust.recordFeedback('reply.chat', 'maybe' as never)).rejects.toThrow(/verdict/);
  });

  it('formats a readable table with the promotion question', async () => {
    const dir = await tempDir();
    const trust = new TrustStore(dir, { promotionThreshold: 1 });
    expect(formatTrust([])[0]).toContain('Every action starts at "check"');
    await trust.recordFeedback('reply.chat', 'accept');
    const lines = formatTrust(await trust.all());
    expect(lines[0]).toBe('reply.chat  check  accepted 1 · edited 0 · rejected 0 · clean streak 1/1');
    expect(lines[1]).toContain('want me to stop checking with you?');
  });

  it('rufus trust | promote | demote', async () => {
    const dir = await tempDir();
    const run = async (...args: string[]) => {
      const c = capture();
      await main(['--dir', dir, 'trust', ...args], c.io);
      return c.lines.join('\n');
    };
    expect(await run()).toContain('No trust recorded yet');
    expect(await run('promote', 'reply.chat')).toContain('reply.chat is now autonomous');
    expect(await run()).toContain('reply.chat  autonomous');
    expect(await run('demote', 'reply.chat')).toContain('back to check');
    await expect(run('promote')).rejects.toThrow(/Usage: rufus trust/);
  });
});
