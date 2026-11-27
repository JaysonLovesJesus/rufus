import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeProvider, TelegramChannel, verifySpokenReply, type Receipt } from '../src';
import { stripMarkdown, toTelegramHtml } from '../src/channels/format';
import { isBlockingViolation, localizeTimes, renderWithSpeaker } from '../src/speaker/speaker';
import { createVoiceHttpHandler } from '../src/voice/server';
import type { KokoroTts } from '../src/voice/kokoro';
import { tempDir } from './helpers';

const AT = '2026-11-26T17:28:00.000Z';
const receipt = (toolId: string, changes: string[], extra: Partial<Receipt> = {}): Receipt => ({
  toolId,
  effect: 'write',
  status: 'ok',
  durationMs: 1,
  summary: `${toolId} ran`,
  changes,
  at: AT,
  ...extra,
});
const blocking = (text: string, receipts: Receipt[]) => verifySpokenReply(text, receipts).filter(isBlockingViolation);

afterEach(() => vi.unstubAllGlobals());

// Each case is shaped like a message Rufus really sent, with the receipts that wake really had.
describe('Truth gate on real past messages', () => {
  it('lets honest "nothing has changed" statements through', () => {
    expect(blocking('Found it. Nothing has been changed yet. Shall I go ahead?', [])).toEqual([]);
  });

  it('backs a claim about a saved skill with the skill, and a file move with the shell command that moved it', () => {
    const skill = [receipt('skills.save', ['skill_saved:contact-note'])];
    expect(blocking('Noted. I saved the contact skill as `skills/contact-note.md`.', skill)).toEqual([]);
    expect(blocking("Got it. I'm project lead now, and I've saved that as a skill.", skill)).toEqual([]);
    // A saved skill still backs nothing in the owner's world.
    expect(blocking("I saved that as a skill and I've updated your calendar.", skill).length).toBeGreaterThan(0);
    const moved = [receipt('approvals.approve', ['shell:mv projects/a.md projects/_archived/a.md'], { summary: 'Approved & ran shell.run: Ran "mv ..."' })];
    expect(blocking('Done. I moved projects/a.md into projects/_archived/.', moved)).toEqual([]);
  });

  it('blocks a "Done" opener when nothing really changed, even if no tool failed', () => {
    expect(blocking("Done, sir. Let's leave the repair until tomorrow.", [receipt('files.read', [], { effect: 'read' })])).toHaveLength(1);
  });

  it('catches UTC in every form, more than one "sir", and the gate leaking into the message', () => {
    expect(verifySpokenReply("It's nearly 6am UTC.", [])).toContain('quoted UTC time instead of the user’s local time');
    expect(verifySpokenReply('Restarted at 05:49 UTC.', [])).toContain('quoted UTC time instead of the user’s local time');
    expect(verifySpokenReply('Sorry, sir, I missed that. Goodnight, sir.', []).some((f) => f.includes('"sir"'))).toBe(true);
    expect(verifySpokenReply('Goodnight, sir.', [])).toEqual([]);
    expect(verifySpokenReply("I can't confirm it was removed. No verified facts back that up.", []).some((f) => f.startsWith('mentioned internal plumbing'))).toBe(true);
  });
});

describe('Speaker prompt', () => {
  it('gets the current time, local times in receipts, and a hint to skip "sir" right after using it', async () => {
    const provider = new FakeProvider(() => 'The calendar shows two events today.');
    await renderWithSpeaker({
      workspaceDir: await tempDir(),
      provider,
      purpose: 'answer',
      receipts: [receipt('calendar.read', [], { effect: 'read', data: { start: '2026-11-26T17:00:00Z' } })],
      wakeContext: { conversation: '- [Thu, Nov 26, 12:20 PM EST] You (Rufus) [messageId:9]: Back online, sir.' },
      now: new Date(AT),
    });
    const { prompt, system } = provider.calls[0]!;
    expect(prompt).toMatch(/^Now: /);
    expect(prompt).not.toContain('2026-11-26T17:00:00Z');
    expect(prompt).toContain(localizeTimes('2026-11-26T17:00:00Z'));
    expect(prompt).toContain('leave it out of this one');
    expect(system).toContain('No tool ids');
  });

  it('rewrites without telling the model to talk about the gate', async () => {
    const provider = new FakeProvider((_req, i) => (i === 0 ? "Done, I've updated your calendar." : "I haven't changed the calendar yet."));
    const out = await renderWithSpeaker({ workspaceDir: await tempDir(), provider, purpose: 'status', receipts: [] });
    expect(out.rewritten).toBe(true);
    expect(provider.calls[1]!.prompt).toContain("The owner never sees this check, so don't mention it");
    expect(out.blocked).toEqual([]);
  });
});

describe('Telegram formatting', () => {
  it('renders light markdown as escaped HTML and strips it for speech', () => {
    expect(toTelegramHtml('A **Wake** runs `send_message` for *you* & <me>')).toBe('A <b>Wake</b> runs <code>send_message</code> for <i>you</i> &amp; &lt;me&gt;');
    expect(toTelegramHtml('send_message and 2*3*4 and $X/month stay as they are')).toBe('send_message and 2*3*4 and $X/month stay as they are');
    expect(toTelegramHtml('*Schēma* is the mold')).toBe('<i>Schēma</i> is the mold');
    expect(stripMarkdown('A **Wake** runs `send_message`, *Schēma*.')).toBe('A Wake runs send_message, Schēma.');
  });

  it('sends HTML, and resends the same words as plain text when Telegram cannot parse it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (body.parse_mode && String(body.text).includes('<b>bad')) {
          return new Response('{"ok":false,"description":"Bad Request: can\'t parse entities"}', { status: 400 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: bodies.length } }));
      }),
    );
    const tg = new TelegramChannel({ token: 'T', chatId: '1' });
    expect(await tg.send('The **tool** ran.')).toEqual({ messageId: '1' });
    expect(bodies[0]).toMatchObject({ parse_mode: 'HTML', text: 'The <b>tool</b> ran.' });
    expect(await tg.send('**bad** markup')).toEqual({ messageId: '3' });
    expect(bodies[2]).toEqual({ chat_id: '1', text: '**bad** markup' });
  });
});

describe('Voice page', () => {
  it('still shows the reply as text when the voice is unavailable, without markdown', async () => {
    const tts = { voice: 'test', synthesize: async () => ({ ok: false, error: 'sidecar down' }), clipPath: () => '' } as unknown as KokoroTts;
    let sink: { send: (t: string) => Promise<unknown> } | undefined;
    const handler = createVoiceHttpHandler({ tts, turnHoldMs: 10, onVoiceTurn: async (_ev, s) => void (sink = s) });
    const server = http.createServer((req, res) => void handler(req, res, new URL(req.url ?? '/', 'http://x').pathname));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ctrl = new AbortController();
    try {
      const events = await fetch(`${base}/voice/events`, { signal: ctrl.signal });
      const reader = events.body!.getReader();
      await fetch(`${base}/voice/turn`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
      await new Promise((r) => setTimeout(r, 50));
      await sink!.send('The **Wake** ran.');
      let seen = '';
      while (!seen.includes('"type":"text"')) seen += new TextDecoder().decode((await reader.read()).value);
      expect(seen).toContain('{"type":"text","text":"The Wake ran."}');
    } finally {
      ctrl.abort();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
