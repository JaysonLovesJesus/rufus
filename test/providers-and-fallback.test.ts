import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalStore, FakeProvider, GapStore, ToolRegistry } from '../src';
import { CreditTracker, isRateLimitError, parseResetTime } from '../src/providers/credits';
import { FallbackProvider } from '../src/providers/fallback';
import { handleZeroAiMessage } from '../src/rpg/zero-ai';
import { tempDir } from './helpers';

const NOW = new Date('2026-11-27T11:30:00-05:00');

describe('CreditTracker & FallbackProvider', () => {
  it('parses Claude 5-hour limit reset times and formats remaining credits for The Desk', async () => {
    const dir = await tempDir('rufus-credits-');
    const credits = new CreditTracker(dir);
    const err = "claude CLI error: You've hit your 5-hour limit · resets 12:40pm (America/New_York)";
    expect(isRateLimitError(err)).toBe(true);
    const parsed = parseResetTime(err, NOW);
    expect(parsed.window).toBe('5h');
    expect(parsed.resetLabel).toBe('12:40pm');

    await credits.recordLimit('claude-cli:opus', err, NOW);
    const line = await credits.formatForDesk({
      activeProvider: 'gemini-cli',
      primaryProvider: 'claude-cli:opus',
      backups: ['gemini-cli', 'local:qwen2.5-3b'],
      now: NOW,
    });
    expect(line).toContain('active=gemini-cli');
    expect(line).toContain('0% left (resets 12:40pm)');
    expect(line).toContain('backups: gemini-cli, local:qwen2.5-3b');
  });

  it('automatically falls through from rate-limited primary to fallback and parks primary until reset', async () => {
    const dir = await tempDir('rufus-fallback-');
    const credits = new CreditTracker(dir);
    let primaryCalls = 0;
    const primary = new FakeProvider(() => {
      primaryCalls++;
      throw new Error("claude CLI error: You've hit your 5-hour limit · resets 12:40pm");
    });
    Object.defineProperty(primary, 'name', { value: 'claude-cli:opus' });
    const backup = new FakeProvider(() => '{"toolId":"sleep","input":{"reason":"from backup"}}');
    Object.defineProperty(backup, 'name', { value: 'gemini-cli' });

    const fb = new FallbackProvider({ chain: [primary, backup], credits, now: () => NOW });
    const r1 = await fb.complete({ system: 'sys', prompt: 'p1' });
    expect(r1).toContain('from backup');
    expect(fb.activeProviderName()).toBe('gemini-cli');
    expect(primaryCalls).toBe(1);

    // Second call skips parked primary without even invoking it!
    const r2 = await fb.complete({ system: 'sys', prompt: 'p2' });
    expect(r2).toContain('from backup');
    expect(primaryCalls).toBe(1);
  });
});

describe('Natural-language Zero-AI fallback', () => {
  it('answers calendar, gaps, status, and plain-English approvals without any slash commands or LLM', async () => {
    const dir = await tempDir('rufus-zero-ai-');
    const gaps = new GapStore(dir);
    const approvals = new ApprovalStore(dir);
    const credits = new CreditTracker(dir);
    const registry = new ToolRegistry({ toolsDir: path.join(dir, 'tools') });
    await credits.recordLimit('claude-cli:opus', "You've hit your 5-hour limit · resets 12:40pm", NOW);
    await gaps.create({ title: 'Finish sermon outline', target: 'Outline ready', reality: 'Drafted', source: 'owner', now: NOW });
    await registry.registerInline(
      { id: 'calendar.today', version: 1, description: 'cal', whenToUse: ['cal'], effect: 'read', requiresApproval: false, inputSchema: { type: 'object', properties: { days: { type: 'number' } } } },
      async () => ({ ok: true, summary: '2:00 PM Dentist', data: '2:00 PM Dentist' }),
    );
    let ran = 0;
    await registry.registerInline(
      { id: 'demo.send', version: 1, description: 'send', whenToUse: ['send'], effect: 'write', requiresApproval: true, inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
      async () => {
        ran++;
        return { ok: true, summary: 'Sent to Alex' };
      },
    );
    await approvals.enqueue('demo.send', { to: 'Alex' }, NOW);

    const deps = { workspaceDir: dir, registry, gaps, approvals, credits, primaryProvider: 'claude-cli:opus', now: () => NOW };
    const cal = await handleZeroAiMessage("What's on my calendar today?", deps);
    expect(cal.intent).toBe('calendar');
    expect(cal.text).toContain('2:00 PM Dentist');
    expect(cal.text).toContain('12:40pm');

    const g = await handleZeroAiMessage('What are you working on?', deps);
    expect(g.intent).toBe('gaps');
    expect(g.text).toContain('Finish sermon outline');

    const ok = await handleZeroAiMessage('yes go ahead', deps);
    expect(ok.intent).toBe('approve');
    expect(ok.acted).toBe(true);
    expect(ran).toBe(1);

    const notice = await handleZeroAiMessage('Can you redesign my landing page?', deps);
    expect(notice.intent).toBe('offline_notice');
    expect(notice.text).toContain('12:40pm');
  });
});
