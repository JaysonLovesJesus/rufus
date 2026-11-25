# Rufus

A small, domain-agnostic **AI + Code + Human** chief-of-staff engine.

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
- Voice notes are not transcribed by Telegram; send text.

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

Extraction also records the **situation** of each pair (group or DM, the previous 4 turns, the gap since the previous turn, your reply delay, hour and weekday), **skips noise** (one-time passcodes / verification codes and bare tapback echoes such as `Liked "..."`; pass `includeNoise: true` to keep them), and counts the **silence**: `extractHistoryFromMessages(messages, opts)` returns `{ pairs, noise, ignored }`, where `ignored` says per channel and sender how many incoming turns you answered and how many you left alone.

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

**`mine`** is code first. `analyzeHistory(pairs)` computes, with no AI and no cost: volume by channel and the most frequent senders; your voice (median and 90th percentile word count, lowercase-start %, trailing-period %, em-dash count, exclamation and question %, emoji, greetings and sign-offs, typical reply time); **candidate rules** that are exactly true of at least 90% of your replies, each with its count (`Keep replies to at most 5 words. (19/20)`; `code` rules belong in `verify`, `principle` rules in the prompt); and recurring intents, bucketed by channel with a deterministic keyword match (confirmations, follow-ups, scheduling, logistics, questions, other; first match wins, so the counts add up) with exact counts and sample pairs. Below 10 pairs no rule is proposed. Tune it in `config.json`:

```json
{ "mine": { "buckets": [{ "id": "invoices", "label": "Invoice questions", "pattern": "invoice|receipt|refund" }], "minPairs": 10, "minShare": 0.9, "provider": "smart" } }
```

`seed` also skips noise pairs (2FA / OTP codes, tapback echoes) and reports how many it skipped; `--include-noise` keeps them. A seeded case's `input` also carries `isGroup`, `gapSincePreviousMs` and `priorMessages` when the pair has them.

**Context, not one average.** A single global "median 8 words" flattens what matters: who you are talking to, how close you are, DM or group, which channel, and whether the thread is live or cold. `buildContactProfiles(pairs)` computes, from real history and with no AI, a **closeness tier** per contact (`inner-circle` >= 20 pairs, or >= 10 and mostly live; `regular` 5-19; `occasional` 2-4; `new` 1) and the same exact style numbers (`count`, `medianWords`, `p90Words`, `greetingRate`, `signOffRate`, `emojiRate`, `exclamationRate`, `lowercaseRate`, `medianReplyMins`) per contact, tier, DM vs. group, channel, rhythm (`live` < 10 min, `same-day`, `cold` > 24h) and channel x intent. `mine` prints that breakdown, and emits `[context]` candidate rules (`For inner-circle WhatsApp DMs, keep replies ~6 words, no greeting.`) only where a situation differs meaningfully from your overall style.

At runtime, call `buildSituationalContext({ channel, sender, isGroup, incoming, gapSincePreviousMs, priorMessages }, pairs)` inside a flow's `ctx.code` step. It returns the contact's tier, the rhythm, the most specific style slice with enough evidence (this contact, else channel + DM/group + intent, else wider), 2-4 relevant past examples (same sender first, then same channel + DM/group, then same intent) and a one-line `voiceHint` such as `Inner-circle WhatsApp DM (45 past exchanges), live chat: median 6 words, casual, no greeting/sign-off`. Hand that to `ctx.ai` as context.

**`mine --ai`** sends a provider the code-assembled statistics plus a small sample (24 pairs by default, picked round-robin across the biggest intents and trimmed; contact names are withheld) and the anonymized situational slices (by closeness tier, DM vs. group, channel and rhythm; never names or prior messages), never the raw history. It returns *workflow blueprints* (name, frequency quoting your counts, trigger, what code handles, what the AI handles, where you approve) and *lessons* tagged `code`, `context` or `principle`, each with a ready-to-paste `rufus propose` line, so the regression gate still decides what is kept. Unparseable output is retried with the exact reason, like any `ctx.ai` step. `--save` writes the report to `history/mine-report.json`.

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

`fast` and `smart` are just names (any key of `providers` works, see below). `--provider <name>` is accepted by `rufus mine --ai`, `rufus compare` and `rufus replay`; with no flag, `mine --ai` uses `mine.provider`, else `smart` if you defined it. The way to choose: run `rufus compare <flow> --provider fast` on your seeded cases. If the fast tier passes the same `verify`, switch that step.

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
pnpm rufus demo                 # code -> ai (verify retry) -> human pause
pnpm rufus pending              # your turn
pnpm rufus answer <cardId> 1    # resume and finish
pnpm rufus lessons
```

Add `--reply "1"` to `demo` to see the whole thing in one go. Commands: `init`, `flows`, `run <flowId> [inputJson]`, `pending`, `answer <cardId> <reply>`, `bridge`, `lessons`, `propose <scope> <rule...>`, `demo`, `tick`, `watch`, `emit`, `replay`, `compare <flowId>`, `chat <message...>`.

### Your own flows and your own data

Rufus keeps **all state outside the repo**, in a workspace directory: `--dir <path>`, or `$RUFUS_HOME`, default `~/.rufus`.

```
<workspace>/
  config.json     provider(s), telegram/beeper settings
  lessons.json    saved lessons
  scheduler.json  lastRunAt per flow (created by the first tick)
  cases/          saved human reviews, one file per flow (replay + prompt examples)
  history/        pairs.jsonl from `rufus seed`, mine-report.json from `rufus mine --save`
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

Set one in `config.json`:

```json
{ "version": 1, "provider": { "type": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "model": "your-model", "apiKeyEnv": "RUFUS_API_KEY" } }
```
```json
{ "version": 1, "provider": { "type": "command", "command": "claude", "args": ["-p"] } }
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
src/engine/     defineFlow, Engine, step runner, AI verify loop, providers
src/store/      atomic JSON file store (no native deps)
src/learning/   lessons (cap, consolidate, prune, layers, regression gate); cases (auto-captured reviews, prompt examples); replay; compare (plain vs. assisted)
src/history/    HistoryPair, message extraction, `seed` (pairs -> replay cases), `profiles` (closeness tiers, situational slices, `buildSituationalContext`), `mine` (voice, rules, intents, optional AI blueprints)
src/scheduler/  at/every/onEvent triggers, quiet hours, tick/startLoop
src/channels/   ChannelAdapter, text formatter + reply parser, CardBridge, Telegram and Beeper adapters
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
