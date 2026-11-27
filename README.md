# Rufus

**A personal AI chief of staff combining deterministic code, local ML, and LLMs to be fast, cheap, honest, and reliable.**

---

## Why Rufus Exists

Most personal AI bots are just a giant prompt taped to a chat box. You ask them to run your life, and for the first ten minutes it feels like magic — until they burn credits checking things you don't care about, quietly hallucinate that they finished a task they never touched, or forget a preference you told them three days ago.

Rufus takes a different approach: **force code and AI to do what each one is actually good at.**

- **Reliable.** Anything repeatable lives in a small, self-tested script — not a wish in a system prompt.
- **Honest.** Every action produces a real receipt from code, and every wake is recorded in a flight recorder. Rufus can't bluff that something happened when it didn't.
- **Fast and cheap.** A tiny local neural model guards the door in milliseconds on your own machine, so the big reasoning model only wakes up when something actually matters.
- **Learns your real life.** Your pushbacks, skips, approvals, and idle wakes retrain the local bouncer and sharpen modular skills — without turning your prompt into a bloated wall of text.
- **Feels like one mind, not a chatbot.** Rufus wakes on his own, works across turns, folds in new messages as you send them, edits his own messages if he misses something, and goes back to sleep when he's done.

---

## How It Works

Everything Rufus does serves a **gap**: what you want true minus what is true now. The full design, item by item, is in [`docs/OUTLINE.md`](docs/OUTLINE.md), and `pnpm rufus verify` measures the code against it.

### 1. Waiting Mode (Local & Instant)
Messages (text, voice notes, replies, reactions, captions), emails, calendar changes, and files flow into one lossless event stream. A lightweight local **SetFit** model (a tiny sentence transformer + classifier head) classifies every incoming event in milliseconds: **`SLEEP`** or **`WAKE`**.

Every time you push back on a nudge, skip an item, approve a change, or the reasoning model wakes up and immediately decides to sleep, Rufus logs a training example. Over time, the bouncer learns your exact bar for what's worth interrupting you.

### 2. Awake Mode (A Turn-Based Loop)
When something deserves real thought, one reasoning model wakes up with fresh context, relevant embedded memories, and the top relevant tools and skills.

It picks **one** action and the gap it serves, then switches **off** while deterministic code executes it and hands back an immutable **Receipt** (exact pass/fail, real changes made, and raw output). On the next turn, the model wakes up with that Receipt and decides what to do next — until it calls **`sleep`**.

### 3. Packaged Scripts (`tools/<id>/`)
Every capability — built-in or created by Rufus himself — is a clean, self-contained package:

```text
tools/<id>/
  tool.json    # Description, when-to-use conditions (embedded), schema, approval gate
  run.mjs      # Deterministic code returning { ok, summary, changes, data }
  test.mjs     # Must pass (plus an engine contract check) before activation
  stats.json   # Automatic usage and failure tracking
```

### 4. A Pure, Fresh-Context Speaker
When it's time to talk to you, a fast speaker model receives only **why** Rufus is messaging you (`purpose`), the clean **Receipts** from code, and your personal `VOICE.md` — checked by a fast code gate so nothing unverified slips through.

### 5. Full Transparency (`wakes.jsonl`)
Every wake saves its complete turn-by-turn transcript. Run `pnpm rufus stats` for a live scorecard (wasted wake rate, tool success rate, approval rate, average speed) or `pnpm rufus eval` to replay golden judgment cases.

---

## Getting Started

Requires **Node.js 20+** and [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (or any custom `ModelProvider`).

```bash
git clone https://github.com/JaysonLovesJesus/rufus.git
cd rufus
pnpm install

# Initialize your local workspace (~/.rufus-v2 by default)
pnpm rufus init

# See loaded tools
pnpm rufus tools

# Wake Rufus from your terminal
pnpm rufus wake "What is on my schedule today?"

# Run continuously (connects to Telegram when TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID are set)
pnpm rufus start
```

### Local SetFit Bouncer (Optional — Recommended)

Out of the box, Rufus uses a zero-dependency local prototype classifier. To enable the real SetFit neural bouncer (~10 ms per event on Apple Silicon):

```bash
uv venv --python 3.12 ~/.rufus-v2/setfit-venv
uv pip install --python ~/.rufus-v2/setfit-venv/bin/python setfit scikit-learn

pnpm rufus bouncer train
pnpm rufus bouncer test "Production deploy failed on main"
```

### Commands

```bash
pnpm typecheck              # TypeScript check
pnpm test                   # Run all test suites
pnpm check                  # Typecheck + tests + rufus verify (run before committing)
pnpm rufus help             # Every command
pnpm rufus start --shadow   # Shadow mode (log decisions without sending)
pnpm rufus stats            # Live outcome scorecard
pnpm rufus verify           # Measure the code against docs/OUTLINE.md (sends nothing)
pnpm rufus verify --live    # Replay real owner messages through the real model on a workspace copy
pnpm rufus eval             # Replay golden judgment evals
pnpm rufus dashboard --open # Read-only local dashboard
pnpm rufus bouncer status   # Training example counts (SLEEP vs WAKE)
```

---

## License

MIT
