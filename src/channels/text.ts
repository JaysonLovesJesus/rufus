import type { HumanCard, HumanReply } from '../types';

/**
 * A channel moves a HumanCard to a person and turns their reply back into a HumanReply.
 * The card stays structured, so a visual HUD can render the same object later.
 */
export interface ChannelAdapter {
  sendCard(card: HumanCard): Promise<void>;
  parseReply(text: string, card: HumanCard): HumanReply | null;
}

/** Concise, scannable text for Beeper / SMS / voice-transcribed replies. */
export function formatCardAsText(card: HumanCard): string {
  const lines: string[] = [`YOUR TURN: ${card.title}`, card.summary];
  if (card.details) lines.push('', card.details);

  if (card.options.length) {
    lines.push('');
    card.options.forEach((o, i) => lines.push(`${i + 1}) ${o.label}${o.description ? ` - ${o.description}` : ''}`));
    const nums = card.options.map((_, i) => i + 1).join(' / ');
    lines.push('', card.allowFreeText ? `Reply ${nums} / or reply in your own words.` : `Reply ${nums}.`);
  } else {
    lines.push('', 'Reply in your own words.');
  }
  if (card.allowFreeText) lines.push('Tip: add a line "Lesson: <rule>" to teach me for next time.');
  lines.push(`(ref ${card.id})`);
  return lines.join('\n');
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Understands, in order: "2", "2) make it shorter", a typed option label, then free text.
 * A line starting "Lesson:" is pulled out as a lesson. Returns null if it can't be read as an
 * answer (e.g. free text on a choice-only card).
 */
export function parseTextReply(text: string, card: HumanCard): HumanReply | null {
  let lesson: string | undefined;
  const body = text
    .split('\n')
    .filter((line) => {
      const m = /^\s*lesson\s*[:\-]\s*(.+)$/i.exec(line);
      if (m && lesson === undefined) {
        lesson = m[1]!.trim();
        return false;
      }
      return true;
    })
    .join('\n')
    .trim();
  const withLesson = (reply: HumanReply): HumanReply => (lesson ? { ...reply, lesson } : reply);
  if (!body) return null;

  const numbered = /^(\d+)(?:\s*[).:\-–—]\s*([\s\S]*))?$/.exec(body);
  if (numbered) {
    const option = card.options[Number(numbered[1]) - 1];
    if (option) {
      const note = numbered[2]?.trim();
      return withLesson({ choice: option.id, ...(note && card.allowFreeText ? { text: note } : {}) });
    }
  }

  const typed = squash(body);
  const byLabel = card.options.find((o) => squash(o.label) === typed || squash(o.id) === typed);
  if (byLabel) return withLesson({ choice: byLabel.id });

  return card.allowFreeText ? withLesson({ text: body }) : null;
}

/** Plain-text channel: hand it any `send(text)` (Beeper bridge, SMS gateway, console...). */
export class PlainTextChannel implements ChannelAdapter {
  constructor(private readonly send: (text: string, card: HumanCard) => void | Promise<void>) {}

  async sendCard(card: HumanCard): Promise<void> {
    await this.send(formatCardAsText(card), card);
  }

  parseReply(text: string, card: HumanCard): HumanReply | null {
    return parseTextReply(text, card);
  }
}
