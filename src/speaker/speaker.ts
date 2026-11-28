import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LosslessEvent, ModelProvider, Receipt } from '../types';

/**
 * Universal $0 truth & formatting gate.
 * Checks a rendered reply against the immutable `Receipt[]` from this wake:
 * - Every completion claim must be backed by a real change to the outside world, and a claim about a
 *   specific thing (the calendar, an email, a file...) by a change to that thing. Talk and Rufus's own
 *   bookkeeping (gaps, watches, skills) never back a claim.
 * - Never addresses a third party: every message goes to the owner.
 * - Preserves clean line breaks on numbered lists and bans em-dashes / sycophancy / plumbing excuses.
 */
const COMPLETION_CLAIM = new RegExp(
  [
    String.raw`\bi(?:'ve| have)?\s+(?:just\s+|now\s+|already\s+)?(?:updated|removed|deleted|archived|moved|created|renamed|fixed|sent|replied|booked|scheduled|cleared|dropped|changed|added|saved|blocked|cancell?ed|wrote|written|emailed|texted|messaged|built|set up|stopped|turned off)\b`,
    String.raw`\b(?:it(?:'s| is)|they(?:'re| are)|that(?:'s| is))\s+(?:now\s+)?(?:done|updated|removed|deleted|archived|sent|cleared|scheduled|booked|gone|fixed|added|saved|cancell?ed|off (?:the|your) )`,
    String.raw`\b(?:has|have)\s+been\s+(?:updated|removed|deleted|archived|moved|created|renamed|fixed|sent|booked|scheduled|cleared|changed|added|saved|cancell?ed)\b`,
    String.raw`\b(?:is|are)\s+(?:now\s+)?(?:no longer (?:on|in)|gone from|off)\b`,
    String.raw`\ball set\b`,
    String.raw`\bdown to (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:projects?|items?|files?)\b`,
  ].join('|'),
  'i',
);

const HEDGE_OR_QUESTION =
  /\b(?:not|never|nothing|yet|haven'?t|hasn'?t|didn'?t|don'?t|can'?t|cannot|won'?t|waiting|queued|approval|approve|pending|say yes|want me|should i|i'?ll|i will)\b|\?\s*$/i;

const EMPTY_FUTURE_PROMISE =
  /\b(?:i(?:'ll| will)\s+(?:stop|start|always|never|remember to|make sure to|drop|skip)|from now on\s+i(?:'ll| will))\b/i;

/** Owner asking Rufus to explain why he did, said, skipped, or decided something. */
const ASKED_FOR_REASONING =
  /\b(?:why\s+did\s+you|why\s+didn'?t\s+you|why\s+haven'?t\s+you|why\s+were\s+you|what\s+was\s+your\s+reasoning|explain\s+your\s+reasoning|how\s+did\s+you\s+decide|why\s+did\s+rufus)\b/i;

/** Rufus claiming past internal reasoning or justifying a past action/skip. */
const REASONING_CLAIM =
  /\b(?:my\s+reasoning\s+was|the\s+reason\s+i\s+(?:did|said|sent|skipped|slept|woke|chose|decided|didn'?t)|i\s+(?:did\s+that|said\s+that|sent\s+that|woke\s+up(?:\s+\S+){0,4}|skipped(?:\s+\S+){0,4}|slept\s+on(?:\s+\S+){0,4}|decided\s+to(?:\s+\S+){0,5}|chose\s+to(?:\s+\S+){0,5}|didn'?t(?:\s+\S+){1,4})\s+because|i\s+thought\s+(?:that\s+)?[^.!?]{3,60}\s+so\s+i)\b/i;

/** Honest admission that there is no recorded trace (always allowed, never confabulation). */
const HONEST_NO_RECORD =
  /\b(?:no\s+record(?:ed)?|not\s+recorded|don'?t\s+have\s+a\s+record|nothing\s+recorded|can'?t\s+verify\s+why|let\s+me\s+check\s+my\s+(?:trace|log|reasoning))\b/i;

/** Tools whose writes are talk or Rufus's own bookkeeping, never a change to the owner's world. */
const INTERNAL_TOOL = /^(?:send_message|edit_message|react_message|sleep|approvals\.deny|(?:gaps|watch|watches|skills)\.[\w.]+)$/;
const INTERNAL_CHANGE = /^(?:sent_message_to_user|edited_message:|reacted:|gap_\w+:|watch_set:|skill_saved:|trust_promoted:|always_allow:)/;
/** Meta tools that still change something the owner can ask for (Rufus's own tools). */
const CAPABILITY_TOOLS = new Set(['tools.create', 'tools.repair']);

export interface WorldChange {
  toolId: string;
  change: string;
  /** The tool that really ran (for approvals.approve, the approved tool). */
  ranToolId: string;
}

/** The changes this wake made to the outside world: ok write receipts, minus talk, gaps, watches and skills. */
export function worldChanges(receipts: readonly Receipt[]): WorldChange[] {
  const out: WorldChange[] = [];
  for (const r of receipts) {
    if (r.status !== 'ok' || INTERNAL_TOOL.test(r.toolId)) continue;
    if (r.effect !== 'write' && !CAPABILITY_TOOLS.has(r.toolId)) continue;
    const ranToolId = r.toolId === 'approvals.approve' ? (/\bran ([\w.-]+):/.exec(r.summary)?.[1] ?? r.toolId) : r.toolId;
    for (const change of r.changes) {
      if (!INTERNAL_CHANGE.test(change)) out.push({ toolId: r.toolId, change, ranToolId });
    }
  }
  return out;
}

/** What a claim is about, and which real changes can back a claim about it. */
const CLAIM_OBJECTS: Array<{ name: string; claim: RegExp; backedBy: RegExp }> = [
  { name: 'the calendar', claim: /\b(?:calendar|gcal|events?|meetings?|appointments?|invites?|blocks?)\b/i, backedBy: /^calendar\.|\bgcal_/i },
  { name: 'email', claim: /\b(?:e-?mails?|gmail|inbox)\b/i, backedBy: /^gmail\.|\bgmail_|\bemail/i },
  { name: 'a chat message', claim: /\b(?:beeper|whatsapp|imessage|instagram|texted|dm(?:'d|ed)?)\b/i, backedBy: /^(?:beeper|instagram|whatsapp|imessage|sms)\.|_sent:|_replied:/i },
  { name: 'a file', claim: /\b(?:files?|docs?|documents?|markdown|readme|notes? file|drafts?|\.md)\b/i, backedBy: /^files\.|^shell\.run$|^brain\.create$|\b(?:wrote|edited|created_draft|archived|shell):/i },
  { name: 'the todo list', claim: /\b(?:to-?dos?|todo list|task list)\b/i, backedBy: /^todos\.|\btodo_/i },
  { name: 'a tool', claim: /\b(?:tools?|scripts?)\b/i, backedBy: /^tools\.(?:create|repair)$/i },
  { name: 'a deploy', claim: /\b(?:deploy(?:ed|ment)?|vercel|fly\.io)\b/i, backedBy: /^deploy\./i },
];

/** Persisting a rule (a skill, VOICE.md) is what backs a promise about future behaviour. */
const RULE_SAVED = /\bskill_saved:|(?:VOICE|SOUL)\.md|\/skills\//;
/** A claim about Rufus's own notes ("I saved that as a skill") is backed by the saved note itself, not by a change to the world. */
const OWN_NOTE_CLAIM = /\b(?:skills?|rules?)\b/i;

/** Third parties named in the wake context: people whose messages the owner received. */
export function thirdPartyNames(ctx: SpeakerWakeContext | undefined): string[] {
  if (!ctx) return [];
  const events = [ctx.trigger, ...(ctx.arrivals ?? []), ...(ctx.relatedEvents ?? [])].filter((e): e is LosslessEvent => !!e);
  const own = new Set(
    events
      .filter((e) => e.kind === 'owner_direct' || e.kind === 'assistant_sent')
      .flatMap((e) => (e.actor ? [e.actor.toLowerCase(), e.actor.split(/\s+/)[0]!.toLowerCase()] : [])),
  );
  for (const n of ['owner', 'rufus', 'me', 'you', 'system', 'unknown']) own.add(n);
  const names = new Set<string>();
  for (const e of events) {
    if (e.kind === 'owner_direct' || e.kind === 'assistant_sent' || !e.actor) continue;
    const full = e.actor.trim();
    if (/[@\d]/.test(full)) continue;
    for (const n of [full, full.split(/\s+/)[0]!]) {
      if (n.length >= 2 && /^[A-Z]/.test(n) && !own.has(n.toLowerCase())) names.add(n);
    }
  }
  return [...names];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A message that speaks *to* a third party ("Thank you, Mom", "Hi Alex,"), not to the owner about them. */
function addressedThirdParty(text: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const n = escapeRe(name);
    const patterns = [
      new RegExp(String.raw`(?:^|\n)\s*(?:(?:hi|hey|hello|dear|thanks|thank you|sorry|ok(?:ay)?|yes|no)[,!]?\s+)?(${n})\s*[,!:]`, 'i'),
      new RegExp(String.raw`\b(?:hi|hey|hello|dear|thanks|thank you|sorry)[,!]?\s+(${n})\b`, 'i'),
      new RegExp(String.raw`,\s*(${n})\s*[.!]+(?:\s|$)`, 'i'),
    ];
    for (const re of patterns) {
      const m = re.exec(text);
      if (m && /^[A-Z]/.test(m[1]!)) return name;
    }
  }
  return undefined;
}

/** Violations that make a draft unsafe to send (a false claim or the wrong recipient), as opposed to style. */
export function isBlockingViolation(v: string): boolean {
  return /^(?:unbacked completion claim|unbacked reasoning claim|empty future promise|opened with "Done"|addressed a third party|reply is empty)/.test(v);
}

export function verifySpokenReply(
  text: string,
  receipts: readonly Receipt[],
  opts: { thirdParties?: readonly string[]; ownerPrompt?: string } = {},
): string[] {
  const s = text.trim();
  if (!s) return ['reply is empty'];
  const fails: string[] = [];

  // 1. Universal $0 truth check: each claim needs a real change to the outside world, to the thing it names.
  const world = worldChanges(receipts);
  const anyFailed = receipts.some((r) => r.status === 'failed' || r.status === 'timed_out' || r.status === 'invalid_input');
  const ruleSaved = receipts.some((r) => r.status === 'ok' && r.changes.some((c) => RULE_SAVED.test(c)));
  if (/^done\b/i.test(s) && world.length === 0 && !ruleSaved) {
    fails.push(`opened with "Done" even though ${anyFailed ? 'a tool failed and ' : ''}0 real changes succeeded`);
  }
  if (EMPTY_FUTURE_PROMISE.test(s) && !ruleSaved) {
    fails.push('empty future promise ("I\'ll stop/start/always..."): persist the rule via skills.save first before promising it');
  }
  const clauses = s.split(/(?<=[.!?])\s+|\n+/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (HEDGE_OR_QUESTION.test(clause) || !COMPLETION_CLAIM.test(clause)) continue;
    const quoted = clause.slice(0, 80);
    // A skill is a file, so "saved the skill as skills/x.md" is about the note; any other object still needs its own change.
    if (ruleSaved && OWN_NOTE_CLAIM.test(clause) && !CLAIM_OBJECTS.some((o) => o.name !== 'a file' && o.claim.test(clause))) continue;
    if (world.length === 0) {
      fails.push(`unbacked completion claim ("${quoted}"): 0 real changes to the outside world succeeded in receipts`);
      break;
    }
    // A clause can name several things ("emailed her about the meeting"); one backed object is enough.
    const named = CLAIM_OBJECTS.filter((o) => o.claim.test(clause));
    if (named.length && !named.some((o) => world.some((w) => o.backedBy.test(w.ranToolId) || o.backedBy.test(w.change)))) {
      fails.push(`unbacked completion claim ("${quoted}"): no receipt shows a change to ${named.map((o) => o.name).join(' or ')}`);
      break;
    }
  }

  // 1b. Self-awareness / anti-confabulation gate: never invent why you did, said, skipped, or decided something.
  const checkedReasoning = receipts.some((r) => r.toolId === 'self.reasoning' && r.status === 'ok');
  const ownerAskedReasoning = Boolean(opts.ownerPrompt && ASKED_FOR_REASONING.test(opts.ownerPrompt));
  if (!checkedReasoning && !HONEST_NO_RECORD.test(s)) {
    const reasoningClause = clauses.find((c) => REASONING_CLAIM.test(c));
    if (reasoningClause) {
      fails.push(
        `unbacked reasoning claim ("${reasoningClause.slice(0, 80)}"): call self.reasoning first to inspect your recorded thoughts instead of guessing`,
      );
    } else if (ownerAskedReasoning && !HEDGE_OR_QUESTION.test(s)) {
      fails.push(
        'unbacked reasoning claim: the owner asked why you did/said/skipped something, but self.reasoning was not called to read your actual recorded trace',
      );
    }
  }

  // 2. Recipient: every message goes to the owner; third parties are people he heard from, never people Rufus talks to.
  const addressed = opts.thirdParties?.length ? addressedThirdParty(s, opts.thirdParties) : undefined;
  if (addressed) fails.push(`addressed a third party ("${addressed}"): this message goes to the owner, so talk to him about them, never to them`);

  // 2. Clean formatting, local time, conciseness & voice invariants
  if (/\b\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?\s*)?(?:UTC|GMT)\b/i.test(s)) fails.push('quoted UTC time instead of the user’s local time');
  if ((s.match(/\bsir\b/gi) ?? []).length > 1) fails.push('said "sir" more than once (once at most, and most messages need none)');
  if (/\b(?:verified facts|truth gate|wake context)\b/i.test(s)) {
    fails.push('mentioned internal plumbing (verified facts, the gate, the wake context): say plainly what is and isn\'t done');
  }
  // Numbered or bulleted: either way it's a list the owner can scan, so the short-reply budget doesn't apply.
  const hasList = /^\s*(?:1\.|[-•*])\s+\S/m.test(s);
  if (!hasList && s.length > 380) fails.push('message is too long/wordy (keep non-list replies under ~350 chars, 1-3 crisp sentences)');
  if (/—/.test(s)) fails.push('no em-dashes (use a comma, period, or plain hyphen)');
  if (/^(?:great question|awesome question|sure thing|absolutely!|happy to help|certainly!|hi\s+\w+[.!,\s])/i.test(s)) {
    fails.push('sycophantic or generic chatbot opener (lead straight with the answer)');
  }
  if (/\b(?:want me to (?:check anything|pull something up|look into anything|do anything)|let me know if you need anything|how can i help)\b/i.test(s)) {
    fails.push('generic assistant closing filler ("Want me to...?"): drop it and end cleanly');
  }
  if (/\b1\.[ \t]+\S+[^\n]*[ \t]+2\.[ \t]+\S+/.test(s)) {
    fails.push('numbered list is cramped on one line: put each numbered item on its own line');
  }
  if (/\b(?:my notes cut off|got cut off in my read|so i can't tell you more)\b/i.test(s)) {
    fails.push('plumbing excuse instead of clear factual status');
  }

  return fails;
}

/** Preserves newlines cleanly while capping length. */
export function normalizeMultiline(text: string, maxChars = 2000): string {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1).trimEnd()}…` : clean;
}

async function loadVoiceGuide(workspaceDir: string): Promise<string> {
  try {
    return (await fs.readFile(path.join(workspaceDir, 'VOICE.md'), 'utf8')).trim();
  } catch {
    try {
      return (await fs.readFile(path.join(workspaceDir, 'SOUL.md'), 'utf8')).trim();
    } catch {
      return 'Calm, poised, concise, human. Use clean numbered lists (one item per line) for 3+ items. Never claim an action succeeded unless it appears in the receipts.';
    }
  }
}

export interface SpeakerWakeContext {
  trigger?: LosslessEvent;
  arrivals?: readonly LosslessEvent[];
  relatedEvents?: readonly LosslessEvent[];
  /** The recent owner <-> Rufus conversation before this wake, oldest first. */
  conversation?: string;
}

const localStamp = (d: Date) => d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;

/** Rewrites ISO timestamps (UTC) in tool output as the owner's local time, so the Speaker never has a UTC time to quote. */
export function localizeTimes(text: string): string {
  return text.replace(ISO_TIME, (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : localStamp(d);
  });
}

function formatEventLine(e: LosslessEvent): string {
  const ts = new Date(e.timestamp);
  const when = Number.isNaN(ts.getTime()) ? e.timestamp : localStamp(ts);
  const own = e.kind === 'owner_direct' || e.kind === 'assistant_sent';
  const who = e.actor ? (own ? ` | ${e.actor}` : ` | from ${e.actor}, received by the owner`) : '';
  return `- [${when}] (${e.source}/${e.kind}${who}): ${e.text.slice(0, 320)}`;
}

/**
 * Fresh-context fast model (Haiku) speaker.
 * Code passes the full structured Wake Context + all Receipts from this wake.
 * Opus passes the short Purpose; Haiku voices it via VOICE.md + deterministic truth gate.
 */
export async function renderWithSpeaker(opts: {
  workspaceDir: string;
  provider: ModelProvider;
  model?: string;
  purpose: string;
  receipts: readonly Receipt[];
  wakeContext?: SpeakerWakeContext;
  /** The owner-facing channel this message goes out on (e.g. "telegram", "voice"). */
  channel?: string;
  /** The time this message is written (defaults to now), so the Speaker never works out "now" from stale timestamps. */
  now?: Date;
}): Promise<{ text: string; violations: string[]; rewritten: boolean; blocked: string[] }> {
  const voice = await loadVoiceGuide(opts.workspaceDir);

  const ctxLines: string[] = [];
  if (opts.wakeContext?.conversation) ctxLines.push(`Recent conversation with the owner (before this wake):\n${opts.wakeContext.conversation}`);
  if (opts.wakeContext?.trigger) ctxLines.push(`Trigger:\n${formatEventLine(opts.wakeContext.trigger)}`);
  if (opts.wakeContext?.arrivals?.length) {
    ctxLines.push(`Arrived mid-wake:\n${opts.wakeContext.arrivals.map(formatEventLine).join('\n')}`);
  }
  if (opts.wakeContext?.relatedEvents?.length) {
    ctxLines.push(`Relevant past events:\n${opts.wakeContext.relatedEvents.map(formatEventLine).join('\n')}`);
  }
  const wakeContextBlock = ctxLines.length ? ctxLines.join('\n\n') : '(none)';

  // What the owner has already been told this wake, so the next message builds on it instead of repeating or contradicting it.
  const alreadySent = opts.receipts
    .filter((r) => r.toolId === 'send_message' && r.status === 'ok')
    .map((r) => (r.data && typeof r.data === 'object' ? String((r.data as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean);
  const alreadySentBlock = alreadySent.length ? alreadySent.map((t, i) => `${i + 1}. ${t}`).join('\n\n') : '(nothing yet)';

  const meaningful = opts.receipts.filter((r) => r.toolId !== 'send_message' && r.toolId !== 'edit_message' && r.toolId !== 'sleep');
  const receiptBlock = meaningful.length
    ? meaningful
        .map(
          (r, i) =>
            localizeTimes(
              `${i + 1}. [${r.toolId} | ${r.status}] ${r.summary}` +
                (r.changes.length ? ` | changes: ${r.changes.join('; ')}` : '') +
                (r.data !== undefined ? ` | data: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}` : '') +
                (r.error ? ` | error: ${r.error}` : ''),
            ),
        )
        .join('\n')
    : '(none: no tools ran before this message)';

  const world = worldChanges(opts.receipts);
  const worldBlock = world.length ? world.map((w) => `- ${w.ranToolId}: ${w.change}`).join('\n') : '(none: nothing outside this chat has changed yet)';
  const thirdParties = thirdPartyNames(opts.wakeContext);

  // Fixed per channel, so it is the cacheable system prompt; everything that changes per message goes in the prompt.
  const system = [
    'You are the Speaker for Rufus, the owner\'s personal chief of staff.',
    `Recipient: you are always writing to the owner himself, in his private chat with Rufus, on ${describeChannel(opts.channel)}. Nobody else reads this message.`,
    'Messages from other people in the Wake Context are things the owner received. Talk to him about them; never address, thank, answer or greet those people.',
    'Hard Rules:',
    '- Honor the Purpose directly, using ONLY the real Wake Context and Receipts.',
    '- Never invent facts or claim any change that did not actually happen. Only the "Real changes" list counts as done; talk, gaps, watches and saved notes are not changes to his world.',
    '- Self-awareness: when explaining why you did, said, skipped, or decided something, use ONLY the recorded thoughts and decisions from self.reasoning. Never invent or post-hoc rationalize a reason; if there is no record, say so plainly.',
    '- First person only ("I"). Never quote UTC times.',
    '- Never repeat what the owner was already sent, and never contradict it. If something earlier was wrong, say so once, plainly.',
    '- Never parrot standing guardrails or disclaimers you already stated in recent messages (e.g., if you already said you will not message someone until he confirms, do not say it again).',
    '- Sound like a sharp, warm human chief of staff — not a nervous legal disclaimer bot. Do not start every message with "Understood, sir." or his name.',
    '- Use the recent conversation: never say you lack something the conversation or receipts show you already have or already sent.',
    '- Talk in his terms, about what he will notice. No tool ids (calendar.write), approval, thread or message ids, function or file names unless he asked for them or needs a path to find something.',
    '- Never mention receipts, verified facts, the gate or the Wake Context. If something has not happened, just say so.',
    '',
    'Voice Guide:',
    voice,
  ].join('\n');

  // "sir" lands when it is rare: if the last thing Rufus said used it, this message goes without.
  const lastRufus = alreadySent.at(-1) ?? (opts.wakeContext?.conversation ?? '').split('\n').filter((l) => l.includes('You (Rufus)')).pop();
  const now = opts.now ?? new Date();
  const prompt = [
    `Now: ${now.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`,
    `Purpose of this message:\n${opts.purpose}`,
    `Wake Context (with real timestamps):\n${wakeContextBlock}`,
    `Receipts from This Wake:\n${receiptBlock}`,
    `Real changes to the outside world this wake:\n${worldBlock}`,
    `Already sent to the owner this wake:\n${alreadySentBlock}`,
    ...(lastRufus && /\bsir\b/i.test(lastRufus) ? ['Your last message already said "sir", so leave it out of this one.'] : []),
    'Write ONLY the final message.',
  ].join('\n\n');

  const ownerPrompt = [
    opts.wakeContext?.trigger?.kind === 'owner_direct' ? opts.wakeContext.trigger.text : '',
    ...(opts.wakeContext?.arrivals ?? []).filter((e) => e.kind === 'owner_direct').map((e) => e.text),
  ]
    .filter(Boolean)
    .join('\n');
  const gate = (t: string) => verifySpokenReply(t, opts.receipts, { thirdParties, ...(ownerPrompt ? { ownerPrompt } : {}) });
  let text = normalizeMultiline(await opts.provider.complete({ system, prompt, ...(opts.model ? { model: opts.model } : {}) }));
  let violations = gate(text);
  let rewritten = false;

  if (violations.length) {
    rewritten = true;
    const fixPrompt = `${prompt}\n\nYour draft was:\n${text}\n\nThe draft has these problems: ${violations.join('; ')}.\nRewrite it fixing every one. The owner never sees this check, so don't mention it, verification or missing facts; just say plainly what is and isn't done.`;
    text = normalizeMultiline(await opts.provider.complete({ system, prompt: fixPrompt, ...(opts.model ? { model: opts.model } : {}) }));
    violations = gate(text);
  }

  // A draft that still makes a false claim or talks to the wrong person is never sent; the caller returns a failed receipt.
  return { text, violations, rewritten, blocked: violations.filter(isBlockingViolation) };
}

function describeChannel(channel: string | undefined): string {
  if (!channel) return 'his usual chat channel';
  if (channel === 'telegram') return 'Telegram';
  if (channel === 'voice') return 'a live voice call (your words are spoken aloud to him)';
  return channel;
}
