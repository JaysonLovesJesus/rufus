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
3. If the same correction keeps coming back, its `count` rises and `lessons.candidatesForCode()` surfaces it: time to turn the rule into a `verify` function. Then `lessons.markHardened(id)`.

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

Replay never re-runs `ctx.code` steps (they may send things); it reuses the results saved in the original run, and stops at the reviewed ai step. It does call your provider once or more per case. The pass/fail signal is your `verify`, so a rule that is not in `verify` is not measured.
## Quickstart

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm rufus demo                 # code -> ai (verify retry) -> human pause
pnpm rufus pending              # your turn
pnpm rufus answer <cardId> 1    # resume and finish
pnpm rufus lessons
```

Add `--reply "1"` to `demo` to see the whole thing in one go. Commands: `init`, `flows`, `run <flowId> [inputJson]`, `pending`, `answer <cardId> <reply>`, `bridge`, `lessons`, `demo`, `tick`, `watch`, `emit`, `replay`.

### Your own flows and your own data

Rufus keeps **all state outside the repo**, in a workspace directory: `--dir <path>`, or `$RUFUS_HOME`, default `~/.rufus`.

```
<workspace>/
  config.json     provider settings
  lessons.json    saved lessons
  scheduler.json  lastRunAt per flow (created by the first tick)
  cases/          saved human reviews, one file per flow (replay + prompt examples)
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

## Layout

```
src/engine/     defineFlow, Engine, step runner, AI verify loop, providers
src/store/      atomic JSON file store (no native deps)
src/learning/   lessons; cases (auto-captured reviews, prompt examples); replay
src/scheduler/  at/every/onEvent triggers, quiet hours, tick/startLoop
src/channels/   ChannelAdapter, text formatter + reply parser, CardBridge, Beeper adapter
src/cli.ts      the `rufus` command
examples/       a generic triage-and-draft flow
test/           vitest suite
```

```sh
pnpm typecheck && pnpm test
```

## License

MIT
