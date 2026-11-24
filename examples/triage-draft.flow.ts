import { defineFlow, FakeProvider } from '../src';

/**
 * Generic example: triage an incoming message, draft a reply, let a human decide.
 *   code  -> pull exact facts out of the message
 *   ai    -> draft a reply, checked by a code `verify` (retries with the exact reason)
 *   human -> approve / edit / discard
 *   code  -> finalize
 */

export interface TriageInput {
  from: string;
  subject?: string;
  body: string;
}

export interface TriageOutput {
  action: 'send' | 'discard';
  reply?: string;
}

const MAX_WORDS = 60;

export function extractFacts(input: TriageInput) {
  const sender = input.from.replace(/<.*>/, '').trim() || 'there';
  const text = `${input.subject ?? ''} ${input.body}`.toLowerCase();
  return {
    sender,
    firstName: sender.split(/\s+/)[0]!,
    subject: input.subject ?? '(no subject)',
    urgency: /\b(urgent|asap|today|immediately|deadline)\b/.test(text) ? 'high' : 'normal',
    hasQuestion: input.body.includes('?'),
    maxWords: MAX_WORDS,
  };
}

export function checkDraft(draft: string): { ok: true } | { ok: false; reason: string } {
  const placeholder = /\[[^\]]+\]|\bTODO\b|\blorem\b/i.exec(draft);
  if (placeholder) {
    return { ok: false, reason: `The draft contains a placeholder "${placeholder[0]}". Replace it with real text.` };
  }
  const words = draft.trim().split(/\s+/).length;
  if (words > MAX_WORDS) {
    return { ok: false, reason: `The draft is ${words} words; the limit is ${MAX_WORDS}. Shorten it.` };
  }
  return { ok: true };
}

export const triageDraft = defineFlow<TriageInput, TriageOutput>(
  {
    id: 'triage-draft',
    name: 'Triage & draft a reply',
    description: 'Reads a message, drafts a short reply, and asks a human to approve, edit or discard it.',
    role: 'assistant',
    trigger: { type: 'manual' },
  },
  async (ctx) => {
    const facts = await ctx.code('extract-facts', () => extractFacts(ctx.input));

    const draft = await ctx.ai('draft-reply', {
      prompt: `Write a short, friendly reply to ${facts.firstName}. Answer any question directly.`,
      context: { facts, message: ctx.input },
      verify: checkDraft,
      maxRetries: 2,
    });

    const decision = await ctx.human('approve-draft', {
      title: `Reply to ${facts.sender}?`,
      summary: `Re: ${facts.subject} (urgency: ${facts.urgency}). Here is my draft:`,
      details: draft,
      options: [
        { id: 'send', label: 'Send as-is' },
        { id: 'discard', label: 'Discard' },
      ],
      allowFreeText: true, // free text = your own wording, sent instead of the draft
    });

    return ctx.code('finalize', (): TriageOutput => {
      if (decision.choice === 'discard') return { action: 'discard' };
      return { action: 'send', reply: decision.text ?? draft };
    });
  },
);

export const demoInput: TriageInput = {
  from: 'Sam Rivera <sam@example.com>',
  subject: 'Moving Thursday to Friday?',
  body: "Hi, can we move Thursday's review to Friday afternoon? It's a bit urgent for the planning.",
};

/** Scripted stand-in for a model: the first draft breaks a rule, so you can watch the retry. */
export const demoProvider = () =>
  new FakeProvider([
    'Hi Sam, Friday afternoon works for me. Talk then! [Your Name]',
    'Hi Sam, Friday afternoon works for me. I will move the invite now. Talk then!',
  ]);
