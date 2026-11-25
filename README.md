# Rufus

A small, domain-agnostic **AI + Code + Human** chief-of-staff engine, in five pieces.

| # | Piece | What it is |
| --- | --- | --- |
| 1 | **Data** | Real-time and first-party history: chats, email, browser, calendar, files, and **human-only AI prompts** (what *you* asked and decided, never what a model answered). One local corpus, `rufus collect`. |
| 2 | **Learning** | One unified, living-belief system backed by observations: **invariants** (true nearly every time), **conditional logic** (`if / else` with real exceptions) and **tension flags** (where your stated ideals and your habits disagree). Lessons are proposed, replay-gated and kept honest. |
| 3 | **Flows** (Spectrum of Intelligence) | Every step runs on the cheapest rung that works: `Code → Fast Model → Smart Model → Human`. Work stays left; the human keeps vision, taste and the final say. Units of real work run as **plan → execute → verify**, with re-plan escalation when a check fails. |
| 4 | **Providers** | Pluggable AI power: **Google Gemini** (native, zero dependencies), Claude (any CLI, e.g. `claude -p`), any OpenAI-compatible HTTP endpoint, or any local command. |
| 5 | **Channels** | Pluggable human surfaces: CLI, Telegram, Beeper, or your own `ChannelAdapter`. |

```
 Data ──▶ Learning ──▶ Flows:  Code ─▶ Fast ─▶ Smart ─▶ Human ──▶ Channels
              ▲                        └──── Providers power Fast and Smart ────┘
              └────────────── every human answer teaches the next run ──────────┘
```

Around all five pieces runs **[one Master Loop](#the-one-master-loop-v11)**: `Sense → Plan → Execute → Verify → Record`, steered by your **Anchor** (goals, projects, boundaries, today's schedule) and gated by **Earned Trust** (every action works from Day 1, you check it until it has earned autonomy).

**The one primary path is [`rufus start`](#one-daemon-rufus-start-v12)**: a single daemon that senses your apps, works the loop with real tools, and texts you only what needs you, in plain text you answer with `1`, `2` or `edit: ...`. `rufus now` is the one-screen status.

### Run 100% on Google Gemini

No Claude needed. Put a key in your environment (`export GEMINI_API_KEY=...`; it is sent in the `x-goog-api-key` header, never in a URL) and use this `config.json` in your workspace:

```json
{
  "version": 1,
  "provider": { "type": "gemini", "model": "gemini-2.5-flash" },
  "providers": {
    "fast":  { "type": "gemini", "model": "gemini-2.5-flash" },
    "smart": { "type": "gemini", "model": "gemini-2.5-pro" }
  }
}
```

Optional per-provider settings: `apiKeyEnv` (default `GEMINI_API_KEY`), `apiKey`, `baseUrl`, `temperature`, `maxOutputTokens`, `timeoutMs`. Mix freely: `fast` on Gemini and `smart` on a local CLI works too. Steps then pick a rung with `tier: 'fast'` / `tier: 'smart'` (see [the Spectrum of Intelligence](#the-spectrum-of-intelligence-code-then-fast-then-smart-then-you)).

---

> **Code** for exactness and for making AI think better.
> **AI** for judgment and drafting.
> **Human** for vision, taste and the final say.

Rufus runs *flows*: ordinary async functions made of three kinds of durable steps. A flow can pause for a person for minutes or days, then resume exactly where it stopped without redoing finished work.

```ts
import { defineFlow } from './src';

export const triage = defineFlow(
  { id: 'triage-draft', name: 'Triage & draft', description: 'Draft a reply, human approves' },
  async (ctx) => {
    // CODE: exact facts, gathered deterministically
    const facts = await ctx.code('extract-facts', () => extractFacts(ctx.input));

    // AI: judgment + drafting, fenced in by a code check
    const draft = await ctx.ai('draft-reply', {
      prompt: 'Write a short, friendly reply.',
      context: facts,                       // exact data, handed to the AI
      verify: (text) => checkDraft(text),   // { ok: true } | { ok: false, reason }
      maxRetries: 2,                        // the exact `reason` is fed back on failure
    });

    // HUMAN: pauses the run, saves a card, resumes when answered
    const decision = await ctx.human('approve', {
      title: 'Send this reply?', summary: 'My draft:', details: draft,
      options: ['Send as-is', 'Discard'],   // free text = "your own words" (default on)
    });

    return ctx.code('finalize', () => finalize(decision, draft));
  },
);
```

## The three steps

| Step | What it is | On resume |
| --- | --- | --- |
| `ctx.code(name, fn)` | Deterministic work. | Never re-runs. The saved JSON result is replayed. |
| `ctx.ai(name, opts)` | A model call, helped by code. | Never re-runs. The accepted output is replayed. |
| `ctx.human(name, spec)` | Pauses and returns a `HumanCard`. | Replays the answer once given. |

**`ctx.ai` is code-assisted thinking.** `context` is structured data your code gathered first. `verify` is a deterministic validator; when it fails, the exact `reason` goes back to the model and it tries again (default 2 retries). If it still fails, the step throws `AiVerificationError`; let it fail the run, or catch it and escalate with `ctx.human`. Lessons saved for the flow or role are injected into the prompt automatically. `parse` turns raw text into a typed value (a parse error counts as a failed verification).

**How resume works.** The flow function re-runs from the top and each step looks itself up by name in the saved run (`runs/<id>.json`). So keep everything outside steps deterministic, and keep step results JSON-serializable (the first run returns the same JSON form a replay would). Repeated names in a loop are numbered automatically.

## The hardening loop: Human → AI → Code

1. A human answers a card and adds a lesson: `engine.answer(id, { choice, lesson: 'Never use exclamation marks.' })`.
2. Future `ctx.ai` calls for that flow (or role) get the lesson in their prompt.
3. If the same correction keeps coming back, its `count` rises and `lessons.candidatesForCode()` surfaces it: time to turn the rule into a `verify` function. Then `lessons.markHardened(id)`. See [Learning guardrails](#learning-guardrails-no-monkey-patching) for the cap, layers and the replay gate.

Lesson scopes are `global`, `flow:<id>` and `role:<name>`.

## Talking to humans: channels

A `HumanCard` is a structured object. `formatCardAsText(card)` renders it for Beeper, SMS or voice-transcribed replies, and `parseTextReply(text, card)` reads the answer back:

```
YOUR TURN: Reply to Sam Rivera?
Re: Moving Thursday to Friday? (urgency: high). Here is my draft:

Hi Sam, Friday afternoon works for me. I will move the invite now. Talk then!

1) Send as-is
2) Discard

Reply 1 / 2 / or reply in your own words.
Tip: add a line "Lesson: <rule>" to teach me for next time.
(ref c_55fbc5dd)
```

Accepted replies: `2`, `1) but say Saturday`, `discard` (a label), or any free text. A line starting `Lesson:` is saved as a lesson. Implement `ChannelAdapter` (`sendCard`, `parseReply`) to plug in any transport; pass it as `channel` to `Engine` and new cards are sent as runs pause. A visual UI can render the same `HumanCard`.

## Connecting Telegram

A native Telegram bot, no dependencies and no webhook server (Rufus polls).

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token.
2. Send your new bot any message, then find your chat id (for example the `chat.id` in `https://api.telegram.org/bot<token>/getUpdates`).
3. Export them and run the bridge:

```sh
export RUFUS_TELEGRAM_TOKEN=...      # from BotFather; prefer env over config.json
export RUFUS_TELEGRAM_CHAT_ID=...    # the only chat Rufus will read or write

pnpm rufus bridge --once --channel telegram
pnpm rufus bridge --channel telegram     # keep going (every 5s)
```

Or `config.json`: `"telegram": { "token": "...", "chatId": 123456789 }` (env vars win). Without `--channel`, Rufus uses whichever of Telegram (`RUFUS_TELEGRAM_TOKEN` or `config.telegram`) and Beeper (`config.beeper` or `RUFUS_BEEPER_*`) is set up, and asks you to pick if both are.

- Cards arrive with a tap-to-answer button per option; typing `1`, free text or a `Lesson:` line works too.
- **Only your chat is heard.** Messages from any other chat, and from bots, are ignored.
- The `getUpdates` offset is saved in `<workspace>/telegram-state.json`, so a restart never re-handles a message.
- If Telegram is unreachable the bridge reports it, keeps running, and delivers once it's back. The token is never printed in errors.
- Voice notes and audio files are transcribed locally (free, nothing leaves your machine) when you set `"telegram": { "transcribe": { "command": "...", "args": ["...", "{file}"] } }`. Rufus downloads the audio to a temp file, runs the command (`"{file}"` becomes the path; without it the path goes last), and treats its trimmed stdout as your message. The temp file is always deleted. Any speech-to-text CLI works, for example a small script that converts with `ffmpeg` and runs `whisper-cli -m <model> -f <wav> -nt -np`. Without `transcribe`, voice notes are skipped; if transcription fails, Rufus says so in one line and keeps going.

## Connecting Beeper (or your own channel)

`rufus bridge` texts every new "Your Turn" card to a chat and turns your replies back into answers. It remembers what it already sent in `<workspace>/bridge-state.json`, so restarts never double-text.

```sh
export RUFUS_BEEPER_TOKEN=...      # Beeper Desktop > Settings > Integrations > Approved connections (+)
export RUFUS_BEEPER_CHAT_ID=...    # the chat Rufus should use
# optional: RUFUS_BEEPER_URL (default http://localhost:23373)

pnpm rufus bridge --once           # one pass: send new cards, apply new replies
pnpm rufus bridge                  # keep going (every 5s; --interval <sec>)
```

The same settings can live in `config.json` as `"beeper": { "url", "token", "chatId" }`; env vars win. Prefer env for the token.

Reply `1`, `2) but say Friday`, an option name, free text, or a voice note (Beeper's transcript is used). Add a `Lesson: <rule>` line to teach Rufus. With several open cards, start your reply with the card ref: `c_1234 1`. Rufus answers with a one-line confirmation, or the next card if the flow pauses again.

- Only messages from the other side are read. If your chat is a note-to-self (you and Rufus share one account), set `RUFUS_BEEPER_SELF_CHAT=1`; Rufus still ignores echoes of its own texts.
- If Beeper Desktop isn't running, the bridge reports it, keeps running, and delivers once it's back.
- Only messages sent after the bridge first starts are treated as replies.

**Any other channel** is two methods:

```ts
import { CardBridge, Engine, type LiveChannel } from './src';

const channel: LiveChannel = {
  async send(text) { /* post text to your chat */ },
  async poll(since) { return [{ id: 'unique-id', text: 'what they typed', at: '2026-01-01T00:00:00Z' }]; }, // optional
};
const bridge = new CardBridge({ engine, channel });
await bridge.tick();          // or: bridge.run({ intervalMs: 5000 })
```

## Chief of Staff: text it any time

The bridge used to listen only while a card was open. `ChiefOfStaff` (`handleMessage(text)`) answers any time you text or voice-note it, and `CardBridge` wires it in:

- A message that answers an open card (it starts with the card's ref, or exactly one card is open and the text reads as an answer) still answers that card, as before.
- Anything else (nothing is open, a choice-only card can't take the text, or it is an explicit command) goes to the chief and the reply is texted back. With several open cards, a number with no ref still asks for a ref; other messages go to the chief.

**Fast commands: plain code, the chief makes no AI call.**

| You send | You get |
| --- | --- |
| `status`, `pending`, `what needs me?` | open cards and running flows |
| `flows` | the flows you can run |
| `lessons` | lessons, and which ones keep coming back and are ready to become code |
| `run <flowId> [json]` | starts the flow now; the card if it pauses, the result if it finishes |
| `learn <scope>: <rule>` | the v3 gate (`proposeLesson`): saved or rejected, plus the layer it belongs in. `<scope>` is `global`, `flow:<id>`, `role:<name>`, or a bare flow id |

`run` and `learn` start flows and replay saved cases, so *those* use your provider if the flow (or a replay) has an `ai` step. The chief itself adds nothing.

**Everything else is free-form.** Code assembles a compact live snapshot (flows, open cards with their refs and options, lessons, the last five runs) and asks your provider for one short plain-words reply. The chief can only reply with text: it cannot start a run, answer a card or save a lesson. If you ask it to draft a new AI + Code + Human flow, or to do something, it says what it would do and the exact command, and nothing happens until you send it. With no provider configured it says so and points at the fast commands.

From the terminal: `rufus chat status`, `rufus chat run triage-draft '{"from":"Sam","body":"Can we move Thursday?"}'`, `rufus chat "anything waiting on me?"`.

## Heartbeat: code decides, AI only when it matters

Give a flow a trigger. Most ticks end in plain code at $0.00; the AI is only called when a `when` gate says something changed or crossed a threshold.

```ts
import { defineFlow, at, every, onEvent } from './src';

defineFlow(
  {
    id: 'inbox-watch', name: 'Inbox watch', description: 'Summarize new mail',
    trigger: every('30m', {                      // or at('08:00'), or onEvent('mail.arrived')
      when: async (ctx) => {                     // pure code, free. false = no run, no AI call
        const n = await countUnread();
        const changed = n !== ctx.state.unread;  // ctx.state is saved in scheduler.json
        ctx.state.unread = n;
        return changed && n > 0;
      },
      // urgent: true,                           // run even during quiet hours
      // input: { ... }                          // run input (events default to their payload)
      // allowOverlap: true,                     // default: skip while the last run still waits on a human
    }),
  },
  async (ctx) => { /* ... ctx.ai(...) ... */ },
);
```

- `tick(now?)` is one deterministic pass (`rufus tick`, ideal for cron/launchd). `startLoop({ intervalMs })` keeps ticking (`rufus watch [--interval 30s]`). `emit(name, payload)` fires `onEvent` flows (`rufus emit <event> [json]`).
- `every` fires on the first tick, then once per interval. `at` fires once a day at a local `HH:MM`; a late tick still fires it once. The `when` gate is checked once per due slot, not on every tick.
- `scheduler.json` stores `lastRunAt` per flow (written *before* the run starts), so a restart never double-fires.
- Quiet hours live in `config.json`: `{ "quietHours": { "start": "22:00", "end": "07:00" } }` (wraps midnight). A due `at`/`every` trigger inside the window is held until it ends; `urgent: true` bypasses it. An event during quiet hours is dropped, not queued.

## Replay: iterate in seconds, not days

When `engine.answer()` resolves a card that follows an AI draft, Rufus saves a case in `cases/<flowId>.json`: `{ id, flowId, runId, at, input, stepKey, stepName, aiDraft, humanChoice, humanText, edited }`. Two things use it:

1. **Examples in the prompt.** Every `ctx.ai` call gets, in its system prompt, the flow's scoped Lessons plus the last 3 human reviews of that same step (draft, and whether the human chose, rewrote or discarded). Each is truncated, and the block is plain text you can read in the request. Set `includeExamples: 5` or `false` per step.
2. **Replay.** `rufus replay <flowId> [--limit N]` (or `engine.replay(flowId)`) re-runs each case against today's ai step: current prompt, `verify`/`parse`, lessons and examples (the case under test is left out of its own examples). It reports passed/failed/skipped, the exact `verify` reason for each failure, and, comparing with the draft saved in the case, how many `improved` (failed today's `verify` then, passes now) or `regressed` (the reverse). Exit code is 1 if any case fails.

Replay never re-runs `ctx.code` steps (they may send things); it reuses the results saved in the original run, and stops at the reviewed ai step. It does call your provider once or more per case. The pass/fail signal is your `verify`, so a rule that is not in `verify` is not measured. (The one exception: cases made by `rufus seed` have no original run, so replay executes the flow's `ctx.code` steps on the historical input. Keep side effects after the ai step.)

`rufus replay <flowId> --provider <name>` (and `compare --provider <name>`) runs the ai step on that named provider instead, so you can ask "would the cheap model have passed these same cases?" before you switch.

## Compare: how much does Code help the AI?

`rufus compare <flowId> [--limit N]` (or `engine.compare(flowId, { limit })`) replays your saved human-reviewed cases twice, graded by the exact same `verify`/`parse`:

- **plain**: the step's raw prompt plus the case's raw input, in a bare system prompt. No code-assembled `context`, no lessons, no examples, `maxRetries: 0`: one shot.
- **assisted**: the step as the flow runs it today: `context`, scoped lessons, recent examples (the case under test left out) and the `verify` retry loop.

```
Compared 6 case(s) for "triage-draft", graded by the same verify:
  plain AI       2/6 passed (33%), avg attempts 1.0
  code-assisted  5/6 passed (83%), avg attempts 1.3
Code lift: +3 case(s) (+50 points).
```

`CompareReport` has `plain` and `assisted` (`passed`, `failed`, `passRate`, `avgAttempts`), `delta` (`assisted.passed - plain.passed`, negative if the extra scaffolding hurt), `deltaRate`, per-case results, and `skipped` / `errored` counts. Like replay, it never re-runs `ctx.code` steps (it reuses the original run's saved results), and it only measures what `verify` can check. It costs at least two provider calls per case; use `--limit`. A case where the provider itself failed (offline, no key) is left out of the rates and reported, never scored as a wrong answer, and the CLI exits 1.

## Day 1: bootstrap from your own history (`seed` and `mine`)

Replay and compare need saved cases, and cases normally take weeks of real use to pile up. Skip the wait: feed Rufus the exchanges you already have.

A **history pair** is one real exchange: someone wrote `incoming`, a human answered with `reply`.

```ts
interface HistoryPair {
  id: string; channel: string; threadId?: string; sender: string;
  incoming: string; reply: string; incomingAt?: string; replyAt?: string;
  tags?: string[]; metadata?: Record<string, unknown>;
  // Optional situation (v6.1). Older pairs without these keep working.
  isGroup?: boolean;
  priorMessages?: Array<{ sender: string; isFromMe: boolean; text: string; timestamp?: string }>; // last few turns
  gapSincePreviousMs?: number;  // live chat (minutes) vs. same day vs. cold restart (> 24h)
  replyDelayMs?: number; incomingHour?: number; incomingDayOfWeek?: number;
}
```

Have a chronological message export instead? `extractPairsFromMessages(messages, { selfIds, maxGapMs })` turns `{ id, threadId, channel, sender, isFromMe, text, timestamp }` into pairs: bursts from one sender merge into one turn, empty and media-only messages are ignored, and a reply only counts if it follows within `maxGapMs` (default 24h). Write the result as JSONL (one pair per line) or a JSON array.

Extraction also records the **situation** of each pair (group or DM, the previous 4 turns, the gap since the previous turn, your reply delay, hour and weekday), **skips noise** (one-time passcodes / verification codes and bare tapback echoes such as `Liked "..."`; pass `includeNoise: true` to keep them), **cleans bridge text** (`cleanMessageText`: HTML bodies from Beeper/Matrix such as `<p>`, `<br>`, `<strong>`, `<ul><li>` become plain text with newlines, entities like `&quot;` `&amp;` `&#39;` are decoded, and sync placeholders such as `Old photo. Media will be requested from your phone automatically overnight.` are dropped and counted as `noise.placeholder`), and counts the **silence**: `extractHistoryFromMessages(messages, opts)` returns `{ pairs, noise, ignored }`, where `ignored` says per channel and sender how many incoming turns you answered and how many you left alone.

```sh
# 1. Load pairs as replay cases for a flow (and keep them in history/pairs.jsonl)
rufus seed history.jsonl --flow reply-drafter [--step draft] [--limit 200] [--dry-run] [--include-noise]

# 2. What does your history say? Free, offline, exact
rufus mine [--limit N] [--json] [--save]

# 3. Optionally let a model name the workflows and propose lessons
rufus mine --ai [--provider smart] [--scope flow:reply-drafter]

# 4. Measure it on real cases, on Day 1
rufus compare reply-drafter --limit 20 --provider fast
rufus propose flow:reply-drafter "Keep replies to at most 12 words." --layer code
```

**`seed`** dedupes by `id` (or a hash of channel + sender + incoming + reply), within the file and against what is already saved, so running it twice changes nothing. It reports invalid records instead of failing, and writes atomically. Each pair also becomes a replay case for `--flow`. The case's `input` is `{ channel, threadId?, sender, incoming, incomingAt?, tags?, metadata? }` (the `HistoryInput` type), so write the flow to read `ctx.input.incoming`; `--step` names the ai step that writes the reply (default `draft`). A seeded case treats what the human actually wrote as the reference: replay reports whether that real reply passes today's `verify` (`before`), and the real replies also appear as `Human replied: "..."` examples in the prompt.

**`mine`** is code first. `analyzeHistory(pairs)` computes, with no AI and no cost: volume by channel and the most frequent senders; your voice (median and 90th percentile word count, lowercase-start %, trailing-period %, em-dash count, exclamation and question %, emoji, greetings and sign-offs, typical reply time); **invariants** (exactly true of at least 98% of your replies, each with its count: `Do not use em dashes. (683/685 = 99.7%)`; safe as hard `verify` checks); **conditional logic** for behaviors with real exceptions (see below); and recurring intents, bucketed by channel with a deterministic keyword match (confirmations, follow-ups, scheduling, logistics, questions, other; first match wins, so the counts add up) with exact counts and sample pairs. Below 10 pairs no rule is proposed. Tune it in `config.json`:

```json
{ "mine": { "buckets": [{ "id": "invoices", "label": "Invoice questions", "pattern": "invoice|receipt|refund" }], "minPairs": 10, "invariantMinShare": 0.98, "minExceptions": 5, "minLift": 2, "minSlicePairs": 30, "minDistinctContacts": 5, "maxTopContactShare": 0.4, "provider": "smart" } }
```

`seed` also cleans HTML in pair text and skips noise pairs (2FA / OTP codes, tapback echoes, media sync placeholders; `filterNoise(pairs)` does the same in code) and reports how many it skipped; `--include-noise` keeps them. A seeded case's `input` also carries `isGroup`, `gapSincePreviousMs` and `priorMessages` when the pair has them.

**Context, not one average.** A single global "median 8 words" flattens what matters: who you are talking to, how close you are, DM or group, which channel, and whether the thread is live or cold. `buildContactProfiles(pairs)` computes, from real history and with no AI, a **closeness tier** per contact (`inner-circle` >= 20 pairs, or >= 10 and mostly live; `regular` 5-19; `occasional` 2-4; `new` 1) and the same exact style numbers (`count`, `medianWords`, `p90Words`, `greetingRate`, `signOffRate`, `emojiRate`, `exclamationRate`, `lowercaseRate`, `medianReplyMins`) per contact, tier, DM vs. group, channel, rhythm (`live` < 10 min, `same-day`, `cold` > 24h) and channel x intent. `mine` prints that breakdown, and emits `[context]` candidate rules (`For inner-circle WhatsApp DMs, keep replies ~6 words, no greeting.`) only where a situation differs meaningfully from your overall style.

**Invariants vs. conditional logic (v6.3).** A 90-95% habit is not a wall. "Skip the greeting" at 95% would break the 35 times you did greet; "max 35 words" at 91% would break the 63 long answers. So only a behavior that holds for at least `invariantMinShare` (default 98%) becomes an `[invariant]`. A behavior whose exceptions are 2%-45% of replies (and at least `minExceptions`, default 5) is contrasted instead: for **greeting**, **long reply** (>30 words) and **sign-off**, `rufus mine` compares the exception group with the norm group on deterministic features of the *incoming* message and context (`theyGreeted`, `coldRestart` >= 24h, `liveChat` < 10 min, `newOrOccasional` contact, `longIncoming` >= 30 words, `multiQuestion`, `isGroup` / `isDm`). It reports exact rates and lift for each feature that separates them: `[logic] Greeting (35/685 = 5%): much more likely when they greeted (20/40 (50%) vs 15/645 (2%) otherwise, lift 22x) or cold restart (>24h) (15/118 (13%) vs 20/567 (4%) otherwise, lift 3.6x); rarely when live chat; otherwise jump straight in.` A trigger needs lift >= `minLift` (default 2), at least 3 exceptions spread over at least 3 different contacts (one person cannot fake a trigger), at least 20% of all exceptions, and a two-proportion z-score >= 2. When nothing qualifies it says so (`35 exceptions, no single simple trigger explains them — keep flexible instead of adding a wall`). `mine --ai` receives the invariants and the conditional rules, and is told never to flatten a conditional rule into a ban or a cap.

**Decision hints at runtime.** `buildSituationalContext` also computes, in code, `greetHint` (`greet` | `optional` | `skip`, with `greetReason`) and `lengthBand` (`brief` | `medium` | `detailed`, with `lengthReason` and `approxWords`) from the incoming message and the rhythm: a short live ping the sender did not open with a greeting is `skip` / `brief`; a cold restart where they greeted is `greet`; a message with 3 questions is `detailed`. The facts behind them are in `features`, and the `voiceHint` carries both cues: `...no greeting/sign-off; greeting: live back-and-forth, they didn't greet → skip; length: short live ping (4 words) → brief (~6 words)`.

**Out-of-sample check.** `rufus mine` ends with a three-line holdout check (`evaluateHoldout(pairs, { holdoutFraction: 0.2 })`, no AI, $0.00). Pairs are sorted by time; profiles, invariants and conditional logic are learned from the older 80% only, and `buildSituationalContext` is then scored on the newest 20% it never saw: how often `greetHint` matches whether you greeted (against always guessing your usual), how often your real word count lands in the predicted `lengthBand` (against the band of your global median), and how many unseen replies satisfy every mined invariant. Scores that do not beat their baselines are not learning, and a near-perfect score on few replies may be over-fit. Below 10 older and 5 newer pairs it says it skipped rather than print a meaningless number.

**Person vs. pattern (confounding guardrails).** A quiet channel dominated by one or two people looks like "how you write on that channel" when it is really how you write to them. So every slice carries `distinctContacts` and `topContactShare`, and a situation (channel, closeness, DM/group, ...) becomes a generalized `[context]` rule only if it has at least `minSlicePairs` replies (default 30), at least `minDistinctContacts` different contacts (default 5), and no contact above `maxTopContactShare` (default 0.4). It must also pass a sender check: with each contact weighted equally (their own median, not message count), at least 60% of its contacts must individually deviate from your overall baseline in the same direction. Anything held back is listed in `suppressedSlices` and printed under "Not generalized" (`iMessage messages (36 replies across 3 contacts; top contact 69%) — ... handled per-contact instead`), and `rufus mine` shows the contact count next to every reply count (`iMessage: 36 replies (3 contacts — person-specific, not generalized)`). `buildSituationalContext` is unaffected: a known contact always gets their own style first.

At runtime, call `buildSituationalContext({ channel, sender, isGroup, incoming, gapSincePreviousMs, priorMessages }, pairs)` inside a flow's `ctx.code` step. It returns the contact's tier, the rhythm, the most specific style slice with enough evidence (this contact, else channel + DM/group + intent, else wider), 2-4 relevant past examples (same sender first, then same channel + DM/group, then same intent) and a one-line `voiceHint` such as `Inner-circle WhatsApp DM (45 past exchanges), live chat: median 6 words, casual, no greeting/sign-off`. Hand that to `ctx.ai` as context.

**`mine --ai`** sends a provider the code-assembled statistics plus a small sample (24 pairs by default, picked round-robin across the biggest intents and trimmed; contact names are withheld) and the anonymized situational slices (by closeness tier, DM vs. group, channel and rhythm; never names or prior messages), never the raw history. It returns *workflow blueprints* (name, frequency quoting your counts, trigger, what code handles, what the AI handles, where you approve) and *lessons* tagged `code`, `context` or `principle`, each with a ready-to-paste `rufus propose` line, so the regression gate still decides what is kept. Unparseable output is retried with the exact reason, like any `ctx.ai` step. `--save` writes the report to `history/mine-report.json`.

## Life context: more than chats (v7)

A chief of staff does not only know your chats. It knows your mail, the sites you live in, the notes you are working on and what is on your calendar. v7 adds one local corpus for all of it, and two principles for how Rufus uses your past:

1. **History is a recency-weighted baseline.** What you did last month says more about you than what you did two years ago, so every summary decays old activity (exponential half-life, counted in observations rather than calendar days) instead of averaging it in.
2. **Ideals beat habits.** People change, and do not always live up to what they believe. Rufus helps you live up to the lessons you *stated*; it does not freeze your rushed habits. But ideals do not overpower evolution either: when your latest replies keep contradicting a saved lesson, Rufus asks you about it instead of enforcing a stale rule forever.

### One corpus, five adapters (`rufus collect`)

Everything becomes a `CorpusItem`: `{ id, source, kind, title?, summary, actor?, domain?, path?, timestamp, tags?, metadata? }`, with `source` one of `chat`, `email`, `browser`, `file`, `calendar`, `ai-prompts` (or your own). Items live in `<workspace>/corpus/items.jsonl`, deduplicated by `id` (collecting twice changes nothing; an edited note is updated, not duplicated) and written atomically. Only a short summary is kept, never a full document or message body. Adapters are local and dependency-free:

```sh
rufus collect files ./notes ./docs [--ignore drafts,tmp]   # markdown / text / CSV / JSON
rufus collect calendar ./cal.ics                            # or a JSON list of events
rufus collect browser ./history.json                        # or a Chrome / Arc / Safari history database
rufus collect email ./mail.mbox --me me@example.org         # .mbox, .eml (or a folder of them), or JSONL
rufus collect ai-prompts ./chats.jsonl ./exports/            # AI chat transcripts: ONLY your own messages are kept (plus what you were replying to, as context)
# any of them: --limit N (keep the newest N)  --dry-run (read and report, write nothing)
```

| Adapter | Reads | Indexes |
| --- | --- | --- |
| `files` | `.md .markdown .txt .csv .tsv .json .jsonl` under one or more roots; skips `node_modules`, `.git`, hidden files, symlinks and binaries | title (front matter, first heading or file name), headings, tags (`tags:` and `#hashtags`), modified time, a 300-character snippet. Reads at most the first 16 KB of a file; tables and JSON contribute column names and keys, never values |
| `browser` | JSON / JSONL rows `{ url, title, visitCount, lastVisitAt }` or `{ url, title, count, last }` (`last` may be an ISO date, Unix milliseconds or seconds, or Apple Cocoa / CoreData epoch seconds, i.e. macOS Cocoa JSON history exports), or (with the `sqlite3` CLI installed) a Chromium-family (Chrome, Arc, Edge, Brave) or Safari history database | **domain**, title, visit frequency, last visit. The database is copied to a temp folder and queried read-only, so a running browser is never touched. Query strings and fragments are dropped from stored URLs (the library option `keepQuery` keeps them) because they often carry tokens |
| `calendar` | `.ics` (folded lines, escapes, attendees, all-day events, `RRULE`, cancellations skipped, alarms ignored), or JSON events `{ summary, start, end, location, attendees, recurring }` | start, end, location, attendees, organizer, whether and how it recurs. There is no time zone database: floating and `TZID` times are read as UTC |
| `email` | `.mbox`, `.eml` (or a folder), or normalized JSONL `{ id, from, to, subject, snippet, date, isFromMe }` | subject, a 240-character snippet (quoted replies and signatures dropped), counterpart, **sender domain**, sent vs. received. `--me` lists your own addresses so `.mbox` / `.eml` messages can be marked sent; without it nothing is guessed |

**`ai-prompts` is human-only on purpose.** It reads JSON / JSONL transcripts in common shapes (`{ role, content | text, timestamp, threadId }` lines, `{ type: "user_message", text }`, `{ createdBy: "user", text }`, or `{ messages: [...] }` conversations) and keeps only messages the human wrote. Assistant, model, system and tool messages are never imported, so model prose cannot colour Rufus's view of you; a message with no clear human signal is dropped rather than guessed, and empty messages and injected wrapper boilerplate are skipped. Each prompt is stored in your own words with a `kind` and `tags` set by plain rules (no AI): `pushback` (also tagged `correction`: "no,", "actually,", "don't", "stop", "instead of", "too complicated", "wrong idea", "not what I..."), `decision` ("let's", "go with", "we should", "I want to"), `question` (contains `?`), else `prompt`. The same prompt in the same thread is stored once.

**What you were replying to (v9).** "No, that's too complicated" means little without the thing that was complicated. So the assistant turn *immediately before* a human message is kept as context only: a snippet of at most 240 characters in `metadata.priorProposal`, plus a labeled `metadata.context` line (`[In response to proposal: ...]`). The summary stays your own words, the assistant turn is never an item of its own, and only the message right after it carries the context (a second message in a row does not; tool results and system messages in between do not hide it). `rufus context` prints the labeled line under the hit, and the snippet is embedded alongside your words, so a similar proposal later finds your earlier pushback.

Write your own: a `SourceAdapter` is `{ id, source, collect(options) => Promise<CorpusItem[]> }`, and `collectInto(store, adapter, options)` merges what it returns.

### The Life Context Snapshot (`rufus context`)

```sh
rufus context                       # observation-weighted snapshot of everything
rufus context passport renewal      # $0 keyword lookup across chats, email, browsing, files, calendar
rufus context invoice --source email --since 90 --limit 5 [--json] [--half-life 90]
```

`buildCorpusSummary(items, { now, halfLifeObservations = 200 })` is pure and deterministic. By default every weight is `0.5^(rank / 200)`, where rank counts how many items are newer: Rufus follows the *evidence*, not a wall-clock timer, so a shift over 20 messages in two days (or six months) is picked up at the same pace. Pass `halfLifeDays` (or `--half-life 90`) for a calendar decay instead; `--half-life 0` turns weighting off. Upcoming events keep full weight. It reports:

- **Volume by source**, raw and as a share of recent activity (`chat` comes from your seeded history).
- **Active sites & human contacts** and recurring portals from browsing and email senders (common mail providers are ignored). Machine-sent mail (`noreply`, `no-reply`, `donotreply`, `notifications`, `alerts`, `mailer-daemon`, and `accounts.*`, `business-updates.*`, `messages.*` senders) is kept out of them and listed on its own `Automated alerts / digests` line, so real portals and people are not buried. Browser visit counts add up logarithmically so one page with thousands of visits cannot drown the rest. A portal is a domain you return to on 3+ days or 10+ times; a keyword-only guess labels it `banking`, `travel`, `scheduling` or `docs` when the name says so.
- **Recently active projects and files**: folders of notes ranked by recent edits, and the latest files. Generic subfolders (`outbox`, `inbox`, `docs`, `notes`, `private`, `tmp`, `src`, `data`, `assets`, `archive`, `drafts`, `logs`, date-stamped folders like `2026-11-27-*`) roll up into the nearest real project folder, so counts merge under one label (`project-a`, or `parent/project-a` if two projects share a name).
- **Calendar commitments**: what is on in the next 7 days (recurring events are expanded from their `RRULE`, UTC) and the recurring commitments with their next occurrence.

`queryCorpus(items, { query, sources?, sinceDays?, limit?, halfLifeDays?, halfLifeObservations?, dedupeTitles?, maxPerTitle?, diversify? })` ranks by relevance times recency: title, tags, actor/domain, source and summary matches (exact or prefix), a phrase bonus, and a recency factor that softens but never erases an old exact match. Near-duplicates (same source and normalized title, like four `captions.txt` files from different date folders) are collapsed to `maxPerTitle` (default 2; `dedupeTitles: false` keeps all), and when several sources match, each gets a floor of the top results so one noisy source cannot fill every slot (`diversify: false` or a single `sources` entry gives a plain top-N). It takes milliseconds, so call it from any flow's `ctx.code` step and hand the AI the exact context:

```ts
import { CorpusStore, queryCorpus } from './src';

const hits = await ctx.code('find-context', async () => {
  const items = await new CorpusStore(`${workspace}/corpus/items.jsonl`).load();
  return queryCorpus(items, { query: ctx.input.subject, sources: ['email', 'file', 'calendar'], limit: 5 }).map((h) => h.item);
});
const draft = await ctx.ai('draft-reply', { prompt: '...', context: { incoming: ctx.input, related: hits } });
```

### Recency in history analysis (default: observation rank, half-life 100 replies)

`analyzeHistory`, `buildContactProfiles` and `buildSituationalContext` weight your replies by observation rank: `halfLifeObservations` (default **100**: the Nth newest reply weighs half the newest, however long those took, so a fast shift shows up at once and a slow one at the same pace). Pass `halfLifeDays` (e.g. 180) for a calendar decay instead; `0` turns weighting off. Rates, medians and the 90th percentile are weighted; reply counts and the contact-breadth gates stay raw, because evidence thresholds must count real replies. Weighted slices carry an `effectiveCount`. `rufus mine` adds a "Recency-weighted" line plus an "Evolving" note wherever your recent style differs from the all-time average, and an invariant that held for years but not across your latest 60 replies is demoted instead of being reported as a wall. Set it in `config.json` (`"mine": { "halfLifeObservations": 60 }` or `halfLifeDays`) or per run with `--half-life`. Conditional-logic contrast and tier thresholds still use raw counts.

### Ideals over habits, and drift

```ts
const lessons = (await engine.lessons.all()).filter((l) => !l.hardened);
const ctx = buildSituationalContext(incoming, pairs, { explicitLessons: lessons });
ctx.voiceHint;
// Ideals (override history): Always open with a greeting. | Keep replies to at most 15 words.
// Historical habits (descriptive baseline, recency-weighted): Regular SMS DM (40 past exchanges), live chat: median 3 words, ...
// Decision (ideals applied): greeting: ideal "Always open with a greeting." → greet (history alone said skip: ...); length: ...
```

With `explicitLessons` (saved lessons or plain rule text), `voiceHint` puts **Ideals (override history)** above **Historical habits (descriptive baseline)**. Code applies what it can verify: a greeting rule (`Always greet`, `Skip the greeting`) sets `greetHint`, a word cap (`at most 15 words`) caps `approxWords` and the `lengthBand`, and each change is listed in `idealOverrides` with what history alone would have done. Lessons about taste, conditional lessons ("only in group chats") and contradictory greeting lessons stay as labeled text and change no decision.

**Lessons are living beliefs backed by observations.** There is one learning system, not two. `engine.reviewLessons()` (or `lessons.review(pairs)`) checks every saved lesson against your reply history and keeps the result on the lesson as `evidence` (`forCount`, `againstCount`, `recentAgainst` / `recentTotal`, and a `status` of `aligned`, `tension` or `stale`), then returns the lessons in tension. `rufus lessons` (and `rufus chat lessons`) runs it for you, so one list shows all your lessons and flags the ones your latest replies keep contradicting. A review never retires or rewrites anything, and lessons about taste or conditional logic, which code cannot measure, simply carry no evidence.

**The check behind it.** `detectLessonDrift(lessons, pairs, { windowSize = 15, minSamples = 5, minRate = 0.4 })` (the same measurement, per claim, and still exported) looks at the last N *applicable* replies, however many hours or months they span, and flags a saved lesson (greeting, em dashes, exclamations, emoji, sign-offs, trailing period, lowercase start, word cap) that at least 40% of them break. `rufus mine` prints it under **Tension / drift**:

```
[drift] Saved lesson "Do not use em dashes." disagrees with 10/15 of your latest replies (67%; 14% of all history). Keep it as an aspiration, refine it into conditional logic, or retire it?
```

The lesson keeps applying (it is your stated ideal); the question is yours, and nothing is retired for you. `buildSituationalContext` returns the same entries as `drift`, deliberately out of the `voiceHint`, so a drafting model never sees a note meant for a human. Hardened lessons are skipped (code already enforces them). Everything here is deterministic: $0, no AI.

## Natural learning: cached embeddings and real examples (v9)

Rufus separates two kinds of knowing, and teaches each the way it is best learned:

| | Where it lives | How it learns |
| --- | --- | --- |
| **Hard boundaries** (never use an em dash, max 12 words, always include the link) | Deterministic `verify` code, `rufus propose --layer code`, invariants from `rufus mine` | Exact. Checked on every draft; a violation retries or goes to a human |
| **Taste, tone and judgment** (how you decline, how warm you are with this person, what "too complicated" means to you) | **Real examples**, retrieved by similarity | Not as bullet-list rules. Rufus shows the model the past moments that look like this one, with what you actually answered |

Stiff text rules are followed too literally by a language model; a handful of your real replies are followed the way a person follows an example. So the primary path is **no lessons at all**: `buildSituationalContext` is *example-driven* by default (`exampleDriven: true` whenever you pass no `explicitLessons`), and its `examples` are picked by what the past message says, who it was with, which channel and how recent it is. `LessonStore` and `explicitLessons` still work exactly as before (passing them turns example-driven selection off unless you set `exampleDriven: true`), and nothing ever turns an example into a rule. Every card you answer is saved as a case and shows up as a `Human replied: "..."` example, so the examples keep up with you.

### Cached, incremental vectors (`rufus embed`)

Finding "the past moments that look like this one" needs vectors, and re-embedding everything on every question would be slow and, for a hosted model, costly. So vectors are cached in `<workspace>/corpus/embeddings.jsonl`, one `{ id, model, hash, vector }` per line (`hash` is the SHA-256 of the exact text embedded). `cache.sync(items, provider)` embeds **only new or changed items** and returns `{ embedded, cached, total }`; a second run over unchanged data embeds nothing, an edited note is re-embedded alone, and switching model keeps both sets. It writes atomically and saves progress if a provider fails part-way.

```sh
rufus collect files ./notes          # collects, then embeds what is new (incremental, real time)
rufus embed                          # catch up: corpus items, answered chats, and each past incoming message
rufus embed --provider ollama        # or gemini, http; --model <name> to pick a model
rufus context "reschedule dentist visit"   # hybrid search when vectors are cached
```

Collecting never fails because of embedding: if the embedder is unreachable, the items are still collected and you get a one-line warning (`rufus embed` retries).

| Provider | Cost | Where text goes | Notes |
| --- | --- | --- | --- |
| `local` (default) | $0 | nowhere | Deterministic hashed character trigrams + words + word pairs, 256 dimensions, unit length. Works immediately, offline, zero dependencies. Catches morphology and shared wording (`reschedule` ~ `rescheduling`), not synonyms |
| `ollama` | $0 | your machine | Neural embeddings via `POST http://127.0.0.1:11434/api/embed` (default `nomic-embed-text`) |
| `gemini` | API pricing | Google | `batchEmbedContents` (default `gemini-embedding-001`, 768 dimensions); key in the `x-goog-api-key` header, never a URL |
| `http` | per endpoint | that endpoint | Any OpenAI-compatible `/embeddings`; key in the `authorization` header |

Choose one in `config.json` (omit it for `local`). Hosted providers receive the text being embedded, so pick them on purpose; prefer `apiKeyEnv` over `apiKey`:

```json
{ "embeddings": { "type": "ollama", "model": "nomic-embed-text", "baseUrl": "http://127.0.0.1:11434" } }
```

```ts
import { EmbeddingCache, createEmbeddingProvider, corpusEmbedItems, pairEmbedItems, queryCorpus, retrieveSimilarExamples, buildSituationalContext } from './src';

const provider = createEmbeddingProvider({ type: 'local' });
const cache = new EmbeddingCache(`${workspace}/corpus/embeddings.jsonl`);
await cache.sync([...corpusEmbedItems(items), ...pairEmbedItems(pairs)], provider); // new or changed only
```

### Hybrid retrieval

```ts
const embeddings = await cache.lookup(provider, 'can we reschedule my dentist appointments?');

// 1. The corpus: keyword relevance + cosine similarity, x observation recency, spread across sources.
queryCorpus(items, { query: 'dentist visit', embeddings });   // hits carry `similarity`

// 2. Your voice: the most relevant, recent real (incoming -> your reply) examples.
retrieveSimilarExamples('can we reschedule my dentist appointments?', pairs, { limit: 4, embeddings, sender: 'Jordan Lee', channel: 'sms' });
// [{ id, sender, channel, incoming, reply, similarity, score, because: ['same sender', 'similar meaning'] }, ...]

// 3. Or in one step, inside a flow's ctx.code:
buildSituationalContext(input, pairs, { embeddings });        // exampleDriven is already true
```

`queryCorpus` blends `(1 - semanticWeight) x keywords + semanticWeight x similarity` (default 0.5), then weights by observation rank, de-duplicates titles and guarantees each matching source a share of the top results. Similarity below `minSimilarity` counts as unrelated (default 0.25; raise it for neural models, whose unrelated pairs still score 0.3-0.5). Items without a cached vector are still found by keywords. `retrieveSimilarExamples` scores similarity (wording, plus meaning when vectors are given), adds a nudge for the same contact and channel, and a recency nudge, and drops an exchange that was saved twice. Without `embeddings` everything still works, by wording alone. All of it is deterministic.

## Time-travel backtest: would Rufus have done what you did? (v10)

`rufus backtest` answers that with real data, and with zero future leakage. It takes a sample of real past moments, rewinds to just before each one, predicts your reply, and compares it with what you actually sent.

```sh
rufus backtest --count 20                          # offline, deterministic, $0
rufus backtest --count 20 --channel sms            # only moments on one channel (all history stays visible)
rufus backtest --count 20 --provider smart         # a live AI run (implies --mode ai); or --provider fast
rufus backtest --mode ai                           # AI on `smart` if you defined it, else your default provider
rufus backtest --latest --limit 5 --json           # newest moments, five side-by-sides, every number as JSON
```

For each moment at time **T**:

1. **Strictly causal snapshot.** Only pairs whose whole exchange (your reply included) was known **before T**, and corpus items with `timestamp < T`, exist. An item at exactly T, a message you answered after T, an undated item, and a chat exchange copied into the corpus (it carries the reply text) are all excluded. The moment itself is removed.
2. **Real examples from before T.** The top similar examples (the v9 hybrid retriever, using cached vectors when you have them) plus your newest ones (same contact first), and related corpus hits, all from the snapshot. Recency, contact profiles and length bands are computed from the snapshot too.
3. **Predict.** *Offline:* the reply to the nearest real earlier example (else your newest reply to that contact, else on that channel). *AI:* a provider is shown the same snapshot, examples and situation, and never the answer.
4. **Compare** with what you actually did: length band (exact / within one), greeting, tone (lowercase start, `!`, emoji, trailing period, question), word overlap (F1), meaning (local vector cosine), a 0-100 overall, and a word-level diff (`[-only in yours-] {+only in prediction+}`) in a readable side-by-side for quick grading. The scoreboard also shows the always-guess baselines a prediction must beat, and how code's own greeting and length call (no model at all) did on the same moments.

Every pair, example and corpus hit is checked against T as it is used; one item from the future throws `CausalityError`, so a report with scores never contains a leak. The tests prove it directly: a moment's prediction, examples and score are identical whether or not everything after it exists, and a marker planted in the future never shows up in any retrieval or in any prompt sent to a model.

Moments are chosen deterministically (evenly spread across your timeline; `--latest` takes the newest), and only ones with at least 3 earlier pairs count (a cold start proves nothing). With `--provider`, the snapshot text is sent to that provider exactly as in a live run. In offline mode, text leaves your machine only if you configured a remote embedding provider.

## Fast and smart model tiers

Code does the heavy lifting, so many ai steps only phrase a result. Send those to a cheap, fast model and keep judgment on a strong one. Name the tiers in `config.json`:

```json
{
  "version": 1,
  "provider": { "type": "command", "command": "claude", "args": ["-p", "--model", "sonnet"] },
  "providers": {
    "fast":  { "type": "command", "command": "claude", "args": ["-p", "--model", "haiku"] },
    "smart": { "type": "command", "command": "claude", "args": ["-p", "--model", "sonnet"] }
  }
}
```

```ts
const decision = await ctx.ai('decide', { prompt: 'Should this wait for the human?', context, provider: 'smart' }); // judgment
const message  = await ctx.ai('phrase', { prompt: 'Say it in one friendly line.', context: { decision }, provider: 'fast' }); // wording only
```

### The Spectrum of Intelligence: code, then fast, then smart, then you

Every flow is a climb: do as much as possible in **code**, hand wording and light judgment to a **fast** model, hand real judgment to a **smart** model, and bring in a **human** last. Rufus makes the rungs first-class:

```ts
// Pick a rung per step. An unconfigured tier falls back to the flow's (or the default) provider, so nothing breaks.
await ctx.ai('phrase', { prompt: '...', context, tier: 'fast' });
await ctx.ai('judge',  { prompt: '...', context, tier: 'smart' });

// Or let it climb on its own: fast first, the deterministic `verify` decides, smart only if fast cannot pass, then a human.
const r = await ctx.escalate('reply', {
  prompt: 'Write a two-sentence reply.',
  context,
  verify: (text) => (text.length < 280 ? { ok: true } : { ok: false, reason: 'too long' }),
  fast:  { maxRetries: 1 },                                  // default 1
  smart: { maxRetries: 2 },                                  // default 2
  human: ({ reason }) => ({ title: 'Write this one', summary: reason }), // optional last rung
});
if (r.rung === 'human') { /* r.answer */ } else { /* r.value, r.rung is 'fast' or 'smart' */ }
```

`provider: 'name'` still beats `tier`. With no separate fast tier configured, `escalate` asks the one model once (with its retries) instead of twice. The failed attempts are saved on the run, so resuming after a human answers never re-asks a model.

Each run records which rung handled each step as `run.spectrum`, e.g. `code 2 · fast 1 · smart 0 · human 1` (plus `· 1 escalated` when fast had to hand up). An ai step with no `tier` counts as `smart`; a provider literally named `fast` or `smart` counts as that tier. `rufus run` / `answer` print it as `Handled by: ...`, and `rufus chat status` shows the total across your runs, so you can see how much stayed in code and fast versus how much needed smart or you. Replay judges an escalated step on its `smart` rung.

`fast` and `smart` are just names (any key of `providers` works, see below). `--provider <name>` is accepted by `rufus mine --ai`, `rufus compare` and `rufus replay`; with no flag, `mine --ai` uses `mine.provider`, else `smart` if you defined it. The way to choose: run `rufus compare <flow> --provider fast` on your seeded cases. If the fast tier passes the same `verify`, switch that step.

### Three stages: plan, execute, verify (v10)

A step-by-step flow is fine for small things. For a unit of real work, give it the shape a careful person uses: **decide, do, check**. `ctx.staged` runs three explicit stages, and each one may use code, a model, or both, always in the preference order **Code > Fast AI > Smart AI > Human**.

| Stage | Job | Typical rung |
| --- | --- | --- |
| **1. `plan(input, ctx)`** | Gather context (exact facts, `retrieveSimilarExamples` over real history), write one concrete **goal** (plus optional objective `criteria`), and choose the **route** upfront: `code`, `fast`, `smart` or `human`. | code |
| **2. `execute(plan, ctx)`** | Do the work on **that route only**. No fast-then-medium-then-smart cascade on a normal run: a plan that says `smart` never calls the fast model. | the planned route |
| **3. `verify(result, plan, ctx)`** | Cross-check the result against the Stage 1 goal. Code checks the AI's output; for complex output a cheap `ctx.ai` review can read it against the goal, the criteria and your real examples. | code (AI optional) |

```ts
import { defineStagedFlow, retrieveSimilarExamples } from './src';

export const reply = defineStagedFlow<{ sender: string; text: string }, string>(
  { id: 'reply', name: 'Reply', description: 'Plan, write, check.' },
  {
    maxReplans: 1, // default 1, hard cap 5
    plan: async (input, ctx) => {
      const examples = await ctx.code('examples', () => retrieveSimilarExamples(input.text, history, { sender: input.sender, limit: 3 }));
      const easy = examples.length >= 2 && examples[0]!.similarity > 0.6;
      return {
        goal: 'A reply of at most 12 words that answers the question and keeps their tone.', // explicit and concrete
        criteria: ['at most 12 words', 'no greeting unless they greeted first'],
        route: ctx.replan ? ctx.replan.nextRoute : easy ? 'fast' : 'smart', // chosen upfront
        context: { examples, message: input },
      };
    },
    execute: (plan, ctx) => ctx.ai('draft', { prompt: plan.goal, context: plan.context }), // tier defaults to plan.route
    verify: (text, plan) => (text.split(/\s+/).length <= 12 ? { ok: true } : { ok: false, reason: `"${text}" is over 12 words` }),
    human: ({ reason }) => ({ title: 'Write this one', summary: reason }), // optional card; a default is used without it
  },
);
```

**Re-plan escalation.** Only when `verify` fails does the engine do anything extra. It does **not** retry the same step blindly: it feeds the exact failure back into `plan` (`ctx.replan` has the `reason`, the previous plan, route and result, and `nextRoute`, one rung up), so the plan can change its prompt and **upgrade the route**. A re-plan can never route cheaper than the pass that just failed. This repeats at most `maxReplans` times. If verification still fails, or any plan routes to `human`, a person decides (`ctx.human`), with the goal, the last result and the reason on the card. A model that cannot pass its own step check inside `execute` counts as a failed attempt, not a crashed run.

```
plan ──▶ execute ──▶ verify ──ok──▶ done
 ▲                      │ fail (reason)
 └── re-plan: reason in, route up ◀┘      after maxReplans, or route "human" ──▶ human
```

The result is `{ status: 'passed' | 'human', route, goal, plan, result | answer, replans, trail }`; `trail` lists every pass (route, outcome, reason). Use `defineStagedFlow(meta, spec)` for a flow that is one unit, or `ctx.staged(name, spec)` inside any `defineFlow`. Every stage outcome is saved with the run, so a resume (or a human's answer) never plans, calls a model or verifies twice. In `run.spectrum`, plan and verify count as code, execute counts as its route, and the helpers inside a stage are not counted a second time. Replay and case capture work on the `ctx.ai` steps inside a stage like any other (put a `verify` on the step for the replay gate; the stage `verify` checks the goal). Existing flows are untouched: `ctx.code`, `ctx.ai`, `ctx.escalate` and `ctx.human` behave exactly as before.

## One daemon: `rufus start` (v12)

```
           SOUL.md + Anchor + closest examples ─────────────┐ (in every prompt)
                                                            ▼
 Sensors ──▶ Master Loop: Plan ─▶ Execute ─▶ Verify ─▶ Record ──▶ Tools (commit only)
 beeper,       (inbox.jsonl,        │            │                 beeper.send, gmail.draft,
 commands      flows/*.loop.ts)     │            └ waits on you ─┐ calendar.write, shell.run ...
                                    ▼                            ▼
                       urgent: now ── normal: batched ──▶ your chat (plain text) ◀── 1 / 2 / edit: ...
                                                              ▲
                                     flow cards + Chief of Staff ride along (CardBridge)
```

```sh
rufus init           # workspace + a SOUL.md template
rufus start          # the one daemon (Ctrl+C to stop); --once for a single pass
rufus now            # one screen: today, goals, what waits on you, what ran on its own, trust
```

What one pass does:

1. **Reads your replies** in your chat (Telegram or Beeper). Loop items are resolved right there; anything else goes to the CardBridge (flow cards, then the Chief of Staff).
2. **Runs the Master Loop**: `inbox.jsonl`, `flows/*.loop.ts` and the sensors in `config.json`. No new signals: idle, $0.
3. **Delivers what needs you.** `urgent` items go out immediately. `normal` items wait for the next **check-in** (every `start.checkinEvery`, default `2h`; or when you text `checkin` / `now`, or run `rufus now`), so Rufus never pings you for every tiny event.

### Beeper-safe plain-text Verify

Many chat apps (Beeper included, even when it shows your Telegram chats) do not render Telegram's inline buttons. So every paused item is short plain text, and every answer is something you can type in two keystrokes:

```
[#1] Sam: "Can we move lunch to Thursday?"
Draft: Thursday works. 12:30?
Reply: 1 = accept, 2 = reject, or type your edit
```

| You type | Means |
| --- | --- |
| `1`, `y`, `yes`, `ok`, `👍` | accept (`1 <note>` adds a note) |
| `2`, `n`, `no` | reject (`2 too formal` or `no: not now` gives the reason) |
| `edit: <your version>` | your version replaces the draft and is what gets applied |
| plain text right after a lone item | the same as `edit:` (a question ending in `?` goes to the Chief of Staff instead) |
| `#2 1`, `#2 2 <reason>`, `#2 edit: ...`, `#2 <text>` | the same, for item #2 when several are open |
| `checkin` / `now` | the one-screen summary plus everything waiting, right away |

When a flow card is open too, a bare `1` answers the card; loop items then need their `#n`. Plan items read `1 = go ahead, 2 = drop it, or type a better plan`; real-life steps read `1 = done, 2 = skip`. In code: `parseLoopReply(text)`, `formatLoopItem(run, n)`, `formatCheckin(items)`. From the terminal: `rufus decide #1 accept`.

### `SOUL.md`: your words in every prompt

`<workspace>/SOUL.md` is free-form: who you are, your voice, your priorities, your "never"s. `loadSoul(dir)` reads it (HTML comments are notes to yourself and are dropped, so the template `rufus init` writes changes nothing until you write in it). It is injected automatically, with a compact Anchor summary (`anchorBrief`) and the closest corpus examples and facts (`buildPersona`), into:

- every Chief of Staff chat reply;
- every Master Loop `ctx.ai(...)` call in plan, execute and verify (opt out per call with `{ persona: false }`, or per loop with `new MasterLoop({ soul: false })`). `ctx.soul` and `ctx.persona()` are there for handlers that build their own prompts.

A workspace without SOUL.md, an Anchor or a corpus gets exactly the old prompts.

### Real tool hands

A `ToolDefinition` is `{ name, description, sensitivity?, readOnly?, execute(args, ctx) }`, kept in a `ToolRegistry`. Handlers use them as `ctx.tools.call(name, args)` (`ctx.tools.has`, `ctx.tools.list`), and every call is recorded on the run (`run.toolCalls`). Two guardrails live in the registry itself:

1. **Side effects only in `commit`.** Read-only tools run while planning, executing or verifying; anything else throws `ToolGatedError` before `commit` (after Verify).
2. **Sensitive tools need your yes.** A tool marked `external`, `money` or `login` runs only once you approved the run, unless you trusted it by name in `config.tools.trusted`. List a tool in the plan's `uses: ['beeper.send']` and its sensitivity joins the Anchor's boundary check, so the run waits for you even when the action type is autonomous. An autonomous commit that tries an undeclared external send is stopped and reported (`commitError`).

Built in, all configured in `config.json` with nothing personal in code:

- `beeper.read` / `beeper.send` (Beeper Desktop's local API at `beeper.apiUrl`, default `http://127.0.0.1:23373`; `beeper.send` is `external`). On whenever Beeper is configured (`"tools": { "beeper": false }` turns them off).
- `commandTool(name, cfg)` for any local CLI: well-known names `calendar.read`, `calendar.write`, `gmail.read`, `gmail.draft` and `shell.run` (external by default) get sensible defaults. No shell: the args go on stdin as JSON and fill `{{key}}` placeholders. Output is parsed as JSON when it is JSON. Timeouts (default 30s), a missing command and a non-zero exit each give a clear `ToolError`.

### Live app sensors ($0)

- `beeperSensor`: new incoming messages from people across your Beeper chats. It skips your own messages, deleted and non-text ones, bot chats (title or sender matching `botPattern`, default `bot`), muted and archived chats, your Rufus chat (`beeper.chatId`) and `ignoreChatIds`. The first pass only sets the cursor: history is never replayed as work.
- `commandSensor`: runs a read-only command that prints JSON (a calendar or mail CLI), diffs item ids against what it has seen, and emits only new ones. The first pass records what is there without emitting it (`baseline: false` to emit).
- `messageTriageHandler` (built into `rufus start` for `chat` and `email` signals): code ignores acknowledgements (`ok thanks`, `👍`) and flags `urgent`/`asap`; anything else gets one fast model call with SOUL.md, the Anchor and your past decisions to classify `ignore | batch | urgent` and draft a concise reply. The draft must pass a code check (short, no `[Name]` placeholders, a failure re-drafts once), is marked `external`, and is only sent with `beeper.send` (or saved with `gmail.draft` for email) after your yes. Without a model it becomes your step ("Reply to Sam: ...").

### `config.json` for v12

```json
{
  "version": 1,
  "telegram": { "chatId": "<your chat id>" },
  "beeper": { "apiUrl": "http://127.0.0.1:23373" },
  "start": { "interval": "30s", "checkinEvery": "2h", "channel": "telegram" },
  "sensors": {
    "beeper": { "ignoreChatIds": [], "groups": true },
    "commands": [
      { "id": "calendar", "surface": "calendar", "kind": "calendar.event", "command": "my-calendar-cli", "args": ["list", "--json"] }
    ]
  },
  "tools": {
    "commands": {
      "calendar.read": { "command": "my-calendar-cli", "args": ["list", "--json", "--day", "{{date}}"] },
      "gmail.draft": { "command": "my-mail-cli", "args": ["draft"] }
    },
    "trusted": []
  }
}
```

Tokens belong in the environment (`RUFUS_TELEGRAM_TOKEN`, `RUFUS_BEEPER_TOKEN`). Without any chat configured, `rufus start` prints items in the terminal and you answer with `rufus decide #n ...`.

### `rufus now`

```
Now: 2026-11-25 08:00
Today:
  > 07:30-09:00 focus Deep work
    12:00-13:00 personal Gym
Goals: [high] Ship the beta
Waiting on you (2):
  [#1] (urgent) verify: reply.chat: Draft a concise reply to Sam's chat message -> "Thursday works. 12:30?"
  [#2] verify: triage.ignore: Ignore Alex's chat message (a short acknowledgement, nothing to answer)
Done on its own (last 24h): 1
  schedule.block: Put "Standup" (meeting) on 2026-11-25 at 09:30-09:45 without overlapping anything.
Earned Trust:
  reply.chat  check  accepted 4 · edited 1 · rejected 0 · clean streak 2/10
```

It also asks a running `rufus start` for a check-in on its next pass.

### What is primary and what is legacy

`rufus --help` now leads with eight **primary commands**: `start`, `now`, `anchor`, `trust`, `decide`, `chat`, `collect`, `embed`. Everything else (`bridge`, `loop`, `signal`, `run`/`pending`/`answer`, `tick`/`watch`/`emit`, `lessons`/`propose`, `seed`, `mine`, `replay`, `compare`, `backtest`, `context`, `demo`) still works exactly as before under **Advanced / Legacy**. `rufus bridge` and `rufus loop` are each half of what `rufus start` does.

## The One Master Loop (v11)

Everything Rufus does on its own goes through one small, mostly-code loop:

```
 Sense ──▶ Plan ──▶ Execute ──▶ Verify ──▶ Record
 (code)    (code + AI?)  (code + AI?)  │cross-check fail: re-plan, route up (bounded)
   │                                   │trust "check" or external/money/login: wait for you
   └ no signals: idle, $0              └trust "autonomous": done ──▶ commit
```

| Stage | Who | What happens |
| --- | --- | --- |
| **Sense** | code | Each `Sensor` reports what is new since its saved cursor (`loop-state.json`). The Anchor is loaded. Zero signals: `{ status: 'idle', cost: 0 }`, no model is called. A signal is never handled twice. |
| **Plan** | code + optional AI | A `SignalHandler` turns the signal into a concrete `goal`, an `actionType` (`reply.chat`, `schedule.block`, ...) and a route chosen up front: `code`, `fast`, `smart` or `human`. It can pull facts (`ctx.facts(query)`) and past verdicts (`ctx.examples({ actionType })`) from the corpus for free. Genuinely unclear? `needsHumanPlan: true` pauses with the **draft plan** and a question. |
| **Execute** | code + optional AI | The work, on the planned route only (`ctx.ai(prompt)` is counted on the run). A real-life step ("record the intro video") is `needsHumanExecute: true` with a clear `humanStep`. Side effects wait for `commit`. |
| **Verify** | code, AI, human | 1) `crossCheck` (code checks AI, or AI checks code). A failure **re-plans** with the reason (`ctx.replan`), the route only moves up, at most `maxReplans` times. 2) **Earned Trust** + the Anchor's boundaries: `check` waits in `awaiting_human_verify` with the verified result; `autonomous` completes and commits. External sends, money and logins always wait for a yes. A `never` boundary blocks the action before it runs. |
| **Record** | code | Every run is saved in `loop-runs/<id>.json`. `resolveHumanDecision(runId, { verdict, editedOutput?, note? })` updates trust, commits the accepted (or edited) output, and appends the verdict to `corpus/items.jsonl` (source `feedback`), so the very next plan can retrieve it. |

```ts
import { MasterLoop, inboxSensor, type SignalHandler } from './src';

const reply: SignalHandler<{ text: string }> = {
  id: 'reply',
  match: { surface: 'chat', kind: 'message.received' },
  plan: (signal, ctx) => ({
    goal: `Answer ${signal.actor} with a concrete time`,
    actionType: 'reply.chat',
    route: ctx.replan ? ctx.replan.nextRoute : 'fast',
    sensitivity: ['external'],              // sending is external: always asks first
  }),
  execute: async (plan, signal, ctx) => ({
    text: await ctx.ai(`Reply to: ${signal.text}\nPast verdicts: ${ctx.examples({ actionType: 'reply.chat' }).map((h) => h.item.summary).join('\n')}`),
  }),
  crossCheck: (draft) => (/\d/.test(draft.text) ? { ok: true } : { ok: false, reason: 'no time in the reply' }),
  commit: async (draft) => sendSomewhere(draft.text),
};

const loop = new MasterLoop({ dir: workspace, sensors: [inboxSensor(workspace)], handlers: [reply], providers: { fast, smart } });
await loop.runOnce();                                             // Sense -> ... -> Record
await loop.resolveHumanDecision(runId, { verdict: 'accept' });   // trust + commit + example
```

From the CLI, drop sensors and handlers into `flows/*.loop.ts` (any exported `Sensor` or `SignalHandler`, or arrays of them). Built in: the `inbox` sensor (`<workspace>/inbox.jsonl`, one signal per line, so any script or webhook can feed the loop) and the all-code `schedule.block` handler (signal kind `schedule.request`; proposes a block, refuses overlaps, writes the Anchor once approved).

```sh
rufus signal anchor schedule.request "Gym" --data '{"range":"12:00-13:00","kind":"personal"}'
rufus loop --once                # one pass; prints what ran, what waits on you, and the model-call cost
rufus loop status                # runs waiting for you
rufus decide <runId> accept      # or: edit [note] --output '<your version>' | reject [note]
rufus loop                       # keep passing every 60s (--interval 5m)
```

### The Anchor: what matters right now

`<workspace>/anchor.json` is small and domain-agnostic: `goals` (`priority` high/medium/low, `horizon` today/week/month, `active`), `projects` (`active`/`paused`/`done`, `nextStep`, `path`), `boundaries` (`require_approval`, `protect_time`, `never`, with optional `appliesTo` action types or sensitivities) and today's `schedule` (`HH:MM` blocks of kind `focus`, `meeting`, `break`, `scroll`, `personal` or `protected`, each `planned`/`done`/`skipped`). Planning another day archives the current one in `pastSchedules`, never losing it.

```sh
rufus anchor init                                   # default boundaries: external sends, money and logins need your yes
rufus anchor goal Ship the beta --priority high --horizon week
rufus anchor block 09:00-11:00 protected Deep work  # overlaps are refused; a protected block always wins
rufus anchor                                        # the summary
```

In code: `loadAnchor`, `saveAnchor`, `upsertGoal`, `upsertScheduleBlock` (throws `ScheduleOverlapError` naming the conflicts; `allowOverlap` for ordinary blocks), `checkBoundaries(anchor, actionType, sensitivity)` and `formatAnchorSummary`. Approvals let Rufus do external sends, payments and logins once you say yes, never silently.

### Earned Trust: works on Day 1, autonomous once earned

`<workspace>/trust.json` tracks each `actionType`: `autonomy` (`check` or `autonomous`, always starting at `check`), `accepted`, `edited`, `rejected`, `consecutiveClean`, `promotionThreshold` (default 10) and `promotionSuggested`.

- **accept** adds to the clean streak. At the threshold Rufus asks: *"You've approved `schedule.block` cleanly 10 times in a row - want me to stop checking with you?"* It only asks; you promote.
- **edit** resets the streak and withdraws the suggestion.
- **reject** does the same, and an `autonomous` action drops straight back to `check`.

```sh
rufus trust                          # one line per action type, plus any promotion question
rufus trust promote schedule.block   # stop checking with me
rufus trust demote schedule.block    # check with me again
```

## Learning guardrails: no monkey-patching

Every correction is tempting to append as one more line in the prompt. Piled up, those lines contradict each other and the model ignores them. Four guardrails keep learning honest:

1. **Hard cap, then consolidate.** Each scope (`global`, `flow:<id>`, `role:<name>`) holds at most 7 active (non-hardened) lessons; change it with `"learning": { "maxLessonsPerScope": 5 }` in `config.json` or the `learning` option of `Engine`. Adding a *new* lesson to a full scope throws `LessonCapError`, which lists the current lessons. Repeating an existing rule still just bumps its `count`. Make room with `lessons.consolidate(scope, { replaceIds, replacementRule })` (several lessons become one sharper principle, atomically), `lessons.markHardened(id)` (the rule now lives in code), or `lessons.prune({ olderThanDays, maxUnused })` / `rufus lessons --prune [--older-than <days>] [--max-unused <n>]`. Prune drops one-off lessons that nothing has used or updated in that long (default 30 days) and, with `maxUnused`, never-injected extras beyond that many per scope; hardened and recurring (count 2+) lessons are kept. Rufus stamps `lastUsedAt` on every lesson it injects into a `ctx.ai` prompt so this is based on use.
2. **Fix the right layer.** Each lesson has a `layer`: `principle` (default; taste and tone in the prompt), `code` (an exact rule that belongs in `verify`) or `context` (a missing fact that code should fetch and pass as `context`). `suggestLayer(rule)` is a pure, deterministic helper: word/character limits, forbidden words or characters, required opening/closing strings and sender/domain filters suggest `code`; "check / look up / fetch / include the order number" suggests `context`; everything else is `principle`. `rufus lessons` shows the suggestion under any lesson that should not be a prompt line.
3. **Scoped layered replay.** `engine.replayScope(scope, { samplePerFlow })` / `rufus replay --scope <scope> [--sample N]`: `flow:<id>` replays that flow's cases; `role:<name>` replays only flows whose `meta.role` matches; `global` replays a golden sample (default 2 per flow, edited cases first, then most recent) of every flow that has cases, so a broad check stays fast. The `ScopedReplayReport` has a per-flow breakdown plus `total`, `passed`, `failed`, `improved`, `regressed`, `skipped`.
4. **Replay regression gate.** `engine.proposeLesson({ scope, rule, layer? }, { force?, samplePerFlow? })` / `rufus propose <scope> <rule...> [--layer ...] [--sample N] [--force]` replays the scope with the candidate lesson active in memory only. If any previously passing case now fails (`regressed > 0`) it returns `{ accepted: false, reason, report }` and `lessons.json` is untouched. Otherwise it saves the lesson and returns `{ accepted: true, lesson, suggestedLayer, report }`. A full scope throws `LessonCapError` before any AI call is spent.

The gate is only as sharp as your `verify` checks and saved cases: a rule `verify` cannot see is not measured, and with no cases it measures nothing (the CLI says so). A human lesson added through `engine.answer()` that hits the cap does not stop the run: the answer is kept, the flow continues, and a warning explains why the lesson was not saved.

## Quickstart

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm rufus init                 # workspace + SOUL.md template
pnpm rufus start                # the one daemon (see "One daemon: rufus start")
pnpm rufus now                  # one screen: what matters and what waits on you
```

The flow engine underneath, step by step:

```sh
pnpm rufus demo                 # code -> ai (verify retry) -> human pause
pnpm rufus pending              # your turn
pnpm rufus answer <cardId> 1    # resume and finish
pnpm rufus lessons
```

Add `--reply "1"` to `demo` to see the whole thing in one go. Commands: `init`, `flows`, `run <flowId> [inputJson]`, `pending`, `answer <cardId> <reply>`, `bridge`, `lessons`, `propose <scope> <rule...>`, `demo`, `tick`, `watch`, `emit`, `replay`, `compare <flowId>`, `seed`, `mine`, `collect <source> <path>`, `context [query]`, `chat <message...>`, and for the Master Loop `anchor`, `trust`, `signal`, `loop`, `decide`.

### Your own flows and your own data

Rufus keeps **all state outside the repo**, in a workspace directory: `--dir <path>`, or `$RUFUS_HOME`, default `~/.rufus`.

```
<workspace>/
  config.json     provider(s), telegram/beeper settings
  lessons.json    saved lessons
  scheduler.json  lastRunAt per flow (created by the first tick)
  cases/          saved human reviews, one file per flow (replay + prompt examples)
  history/        pairs.jsonl from `rufus seed`, mine-report.json from `rufus mine --save`
  corpus/         items.jsonl from `rufus collect` (email, browser, files, calendar, ai-prompts), embeddings.jsonl (cached vectors from `rufus embed`)
  runs/           one readable JSON file per run
  flows/          your *.flow.ts files, loaded by the CLI
```

Use the library directly:

```ts
import { Engine, FakeProvider, createProvider } from './src';

const engine = new Engine({ store: '/path/to/workspace', provider: new FakeProvider([...]), flows: [triage] });
const r = await engine.start('triage-draft', { from: 'Sam', body: 'Can we move Thursday?' });
if (r.status === 'waiting_human') await engine.answer(r.card.id, { choice: 'send', lesson: '...' });
```

### AI providers

`AiProvider` is one method: `complete(req) => Promise<string>`. Included:

- `FakeProvider`: scripted, for tests and demos.
- `OpenAiCompatibleProvider`: any `/chat/completions` endpoint (OpenAI, OpenRouter, Ollama, vLLM...).
- `CommandProvider`: pipes the conversation to a CLI on stdin (for example `claude -p`).
- `GeminiProvider`: Google Gemini over plain `fetch` (`type: "gemini"`), no SDK. Defaults: model `gemini-2.5-flash`, key from `GEMINI_API_KEY`, base URL `https://generativelanguage.googleapis.com/v1beta`. The key goes in the `x-goog-api-key` header only, and error messages never echo it. `ctx.ai(..., { json: true })` switches on Gemini's native JSON mode.

Set one in `config.json`:

```json
{ "version": 1, "provider": { "type": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "model": "your-model", "apiKeyEnv": "RUFUS_API_KEY" } }
```
```json
{ "version": 1, "provider": { "type": "command", "command": "claude", "args": ["-p"] } }
```
```json
{ "version": 1, "provider": { "type": "gemini", "model": "gemini-2.5-flash" } }
```

### Named providers (a different model per flow or step)

Add `providers` next to the default `provider`. A flow picks one with `meta.provider`, a step with `ctx.ai(..., { provider })`; a step beats its flow, and no name means the default (`"default"` also works as a name). An unknown name fails the run with the list of configured names; it never silently uses another model.

```json
{
  "version": 1,
  "provider": { "type": "command", "command": "claude", "args": ["-p"] },
  "providers": {
    "claude": { "type": "command", "command": "claude", "args": ["-p"] },
    "fast": { "type": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "model": "your-small-model", "apiKeyEnv": "RUFUS_API_KEY" }
  },
  "chief": { "provider": "claude" }
}
```

```ts
defineFlow({ id: 'inbox', name: 'Inbox', description: '...', provider: 'claude' }, async (ctx) => {
  const urgency = await ctx.ai('triage', { prompt: '...', provider: 'fast' }); // light model for the cheap step
  const draft = await ctx.ai('draft', { prompt: '...' });                       // the flow's provider (claude)
});
```

`chief.provider` sets the model for free-form Chief of Staff chat. Replay and `rufus compare` use the same routing (and `--provider <name>` overrides it for one run). See *Fast and smart model tiers* above for a `fast`/`smart` setup. Library users pass `providers: { name: provider }` to `Engine`; `createProviders(config)` builds them from a config.

## Layout

```
src/providers/  native providers (Google Gemini over fetch)
src/anchor/     the Anchor: goals, projects, boundaries, schedule (overlap detection)
src/engine/     defineFlow, defineStagedFlow, Engine, step runner, `stages` (plan -> execute -> verify with re-plan escalation), AI verify loop, providers, spectrum (code / fast / smart / human), `loop` (the Master Loop) + built-ins, `trust` (Earned Trust)
src/store/      atomic JSON file store (no native deps)
src/learning/   lessons (cap, consolidate, prune, layers, regression gate); cases (auto-captured reviews, prompt examples); replay; compare (plain vs. assisted)
src/history/    HistoryPair, message extraction, `noise` (passcodes, tapbacks, HTML and sync-placeholder cleanup), `seed` (pairs -> replay cases), `profiles` (closeness tiers, situational slices, `buildSituationalContext`, `retrieveSimilarExamples`), `contrast` (invariants vs. conditional logic), `eval` (holdout check), `backtest` (strictly causal time-travel check), `ideals` (explicit lessons as constraints, drift), `mine` (voice, invariants, intents, recency, optional AI blueprints)
src/corpus/     `CorpusItem`, `CorpusStore`, `SourceAdapter`s (files, browser, calendar, email, ai-prompts), recurrence, `buildCorpusSummary` / hybrid `queryCorpus`, `embeddings` (providers, `EmbeddingCache`)
src/recency.ts  exponential and rank-based recency weights, shared by history and the corpus
src/scheduler/  at/every/onEvent triggers, quiet hours, tick/startLoop
src/channels/   ChannelAdapter, text formatter + reply parser, CardBridge, Telegram and Beeper adapters
src/soul/       SOUL.md loader and the persona block (SOUL.md + Anchor + examples + facts) for every prompt
src/tools/      ToolRegistry (side effects only in commit, sensitive tools need a yes), Beeper and command tools
src/sensors/    beeperSensor, commandSensor, messageTriageHandler
src/unified/    `rufus start` (UnifiedDaemon), plain-text Verify (parseLoopReply / formatLoopItem), batching, `rufus now`
src/chief/      ChiefOfStaff: fast code commands + code-assembled free-form chat
src/cli.ts      the `rufus` command
examples/       a generic triage-and-draft flow
test/           vitest suite
```

```sh
pnpm typecheck && pnpm test
```

## License

MIT
