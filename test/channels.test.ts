import { describe, expect, it } from 'vitest';
import { PlainTextChannel, formatCardAsText, parseTextReply, type HumanCard } from '../src';

const card: HumanCard = {
  id: 'c_1234abcd',
  runId: 'run_1',
  flowId: 'f',
  step: 's',
  title: 'Reply to Sam?',
  summary: 'Here is my draft:',
  details: 'Hi Sam, Friday works.',
  options: [
    { id: 'send', label: 'Send as-is' },
    { id: 'discard', label: 'Discard', description: 'drop it' },
  ],
  allowFreeText: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('formatCardAsText', () => {
  it('is concise and scannable, with numbered choices and the card ref', () => {
    expect(formatCardAsText(card)).toBe(
      [
        'YOUR TURN: Reply to Sam?',
        'Here is my draft:',
        '',
        'Hi Sam, Friday works.',
        '',
        '1) Send as-is',
        '2) Discard - drop it',
        '',
        'Reply 1 / 2 / or reply in your own words.',
        'Tip: add a line "Lesson: <rule>" to teach me for next time.',
        '(ref c_1234abcd)',
      ].join('\n'),
    );
  });

  it('adapts to choice-only and text-only cards', () => {
    const strict = formatCardAsText({ ...card, allowFreeText: false, details: undefined });
    expect(strict).toContain('Reply 1 / 2.');
    expect(strict).not.toContain('own words');
    const open = formatCardAsText({ ...card, options: [] });
    expect(open).toContain('Reply in your own words.');
    expect(open).not.toContain('1)');
  });
});

describe('parseTextReply', () => {
  it('reads a numbered choice', () => {
    expect(parseTextReply('2', card)).toEqual({ choice: 'discard' });
    expect(parseTextReply(' 1. ', card)).toEqual({ choice: 'send' });
  });

  it('reads a number plus a note', () => {
    expect(parseTextReply('1) but say Saturday instead', card)).toEqual({ choice: 'send', text: 'but say Saturday instead' });
    expect(parseTextReply('2 - not now', card)).toEqual({ choice: 'discard', text: 'not now' });
  });

  it('matches an option label (or id), ignoring case and punctuation', () => {
    expect(parseTextReply('send as-is', card)).toEqual({ choice: 'send' });
    expect(parseTextReply('DISCARD!', card)).toEqual({ choice: 'discard' });
    expect(parseTextReply('discard', card)).toEqual({ choice: 'discard' });
  });

  it('falls back to free text, including when a number is out of range or just starts a sentence', () => {
    expect(parseTextReply('Make it warmer please', card)).toEqual({ text: 'Make it warmer please' });
    expect(parseTextReply('7', card)).toEqual({ text: '7' });
    expect(parseTextReply('3 reasons this is wrong', card)).toEqual({ text: '3 reasons this is wrong' });
  });

  it('extracts a "Lesson:" line', () => {
    expect(parseTextReply('1\nLesson: Keep replies under 40 words', card)).toEqual({
      choice: 'send',
      lesson: 'Keep replies under 40 words',
    });
    expect(parseTextReply('Shorter.\nlesson - no emojis', card)).toEqual({ text: 'Shorter.', lesson: 'no emojis' });
  });

  it('returns null when it cannot be an answer', () => {
    expect(parseTextReply('   ', card)).toBeNull();
    expect(parseTextReply('Lesson: only a lesson', card)).toBeNull();
    const strict = { ...card, allowFreeText: false };
    expect(parseTextReply('whatever', strict)).toBeNull();
    expect(parseTextReply('1) with a note', strict)).toEqual({ choice: 'send' });
  });
});

describe('PlainTextChannel', () => {
  it('sends the formatted card and parses replies', async () => {
    const sent: string[] = [];
    const channel = new PlainTextChannel((text) => void sent.push(text));
    await channel.sendCard(card);
    expect(sent[0]).toBe(formatCardAsText(card));
    expect(channel.parseReply('2', card)).toEqual({ choice: 'discard' });
  });
});
