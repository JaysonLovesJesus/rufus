# Rufus

**A personal AI chief of staff that actually knows what's real, learns what matters to you, and stays fast and cheap.**

Most AI bots are just prompts wrapped around a chat box. They burn tokens checking things that don't matter, lose track of what they actually did, and repeat the same mistakes a week later.

Rufus is built around one simple idea: **let deterministic code own reality, let a tiny local model guard the door, and only wake the smart AI when real judgment is needed.**

---

## How It Works (In 30 Seconds)

1. **Waiting Mode (local, runs in milliseconds)**
   Incoming messages, emails, calendar changes, and files flow into one lossless event stream (keeping exact timestamps, replies, reactions, and deleted flags). A tiny local **SetFit** neural model (`Sentence Transformer + classifier head`) runs right on your laptop in ~10 ms and decides: **`SLEEP`** (ignore) or **`WAKE`** (wake the brain).
   - Every time you skip a nudge, push back, approve an action, or the brain wakes up and goes right back to sleep, it automatically logs a training example — so the bouncer gets smarter around *your* life.

2. **Awake Mode (A Text-Based RPG)**
   When something actually matters, one reasoning model (e.g. Claude Opus) wakes up with fresh context, relevant embedded memories, and the top relevant tools.
   - It picks **one** tool to run, then switches **OFF** while deterministic code executes it and returns an immutable **Receipt** (exact pass/fail + what actually changed).
   - It wakes back up with that Receipt and plays the next turn until it calls **`sleep`**.
   - Because every action returns a real Receipt, the AI never has to guess whether something worked.

3. **Packaged Scripts (`tools/<id>/`)**
   Every capability — built-in or created by Rufus himself — is a small, self-contained folder:
   - `tool.json` — description, `whenToUse` conditions (embedded for semantic search), input schema, read/write effect, and approval flag.
   - `run.mjs` — deterministic code returning `{ ok, summary, changes, data }`.
   - `test.mjs` — automated test that must pass (alongside an engine contract check) before the tool is activated.
   - `stats.json` — automatic usage and failure tracking (flags broken scripts for repair).

4. **A Pure Fresh-Context Speaker**
   When Rufus messages you, a fast model (e.g. Claude Haiku) receives only **why** he's messaging you (`purpose`), the clean **Receipts** from code, and your personal `VOICE.md` — behind a fast code truth and formatting gate.

5. **Flight Recorder (`wakes.jsonl`)**
   Every wake is recorded turn-by-turn so you can inspect why Rufus made any decision, track real outcome metrics (`rufus stats`), and replay golden judgment cases (`rufus eval`).

---

## Quick Start

Requires **Node.js 20+** and [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (or any custom `ModelProvider`).

```bash
git clone https://github.com/JaysonLovesJesus/rufus.git
cd rufus
pnpm install

# Initialize your local workspace (~/.rufus-v2 by default)
pnpm rufus init

# See loaded packaged scripts
pnpm rufus tools

# Wake Rufus directly from the terminal
pnpm rufus wake "What is on my schedule today?"

# Run 24/7 (uses Telegram if TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID are set)
pnpm rufus start
```

### Optional: Local SetFit Bouncer (~10 ms on Apple Silicon)

Rufus works out of the box with a built-in zero-dependency prototype classifier. To upgrade to the real local SetFit neural bouncer:

```bash
uv venv --python 3.12 ~/.rufus-v2/setfit-venv
uv pip install --python ~/.rufus-v2/setfit-venv/bin/python setfit scikit-learn

pnpm rufus bouncer train
pnpm rufus bouncer test "Production deploy failed on main"
```

### Useful Commands

```bash
pnpm typecheck                  # TypeScript check
pnpm test                       # Run all milestone test suites
pnpm rufus start --shadow       # Shadow mode (logs decisions without sending)
pnpm rufus stats                # Real-world outcome scorecard
pnpm rufus eval                 # Replay golden judgment evals
pnpm rufus bouncer status       # Training example counts (SLEEP vs WAKE)
```

---

## License

MIT
