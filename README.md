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

## Quickstart

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm rufus demo                 # code -> ai (verify retry) -> human pause
pnpm rufus pending              # your turn
pnpm rufus answer <cardId> 1    # resume and finish
pnpm rufus lessons
```

Add `--reply "1"` to `demo` to see the whole thing in one go. Commands: `init`, `flows`, `run <flowId> [inputJson]`, `pending`, `answer <cardId> <reply>`, `bridge`, `lessons`, `demo`.

### Your own flows and your own data

Rufus keeps **all state outside the repo**, in a workspace directory: `--dir <path>`, or `$RUFUS_HOME`, default `~/.rufus`.

```
<workspace>/
  config.json     provider settings
  lessons.json    saved lessons
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
src/learning/   lessons: add, forScope, candidatesForCode, markHardened
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
