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

## Quickstart

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm rufus demo                 # code -> ai (verify retry) -> human pause
pnpm rufus pending              # your turn
pnpm rufus answer <cardId> 1    # resume and finish
pnpm rufus lessons
```

Add `--reply "1"` to `demo` to see the whole thing in one go. Commands: `init`, `flows`, `run <flowId> [inputJson]`, `pending`, `answer <cardId> <reply>`, `lessons`, `demo`.

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
src/channels/   ChannelAdapter, text formatter + reply parser
src/cli.ts      the `rufus` command
examples/       a generic triage-and-draft flow
test/           vitest suite
```

```sh
pnpm typecheck && pnpm test
```

## License

MIT
