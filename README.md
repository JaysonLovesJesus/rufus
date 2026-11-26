# Rufus v2 Core

A minimal, from-scratch personal agent core built around three primitives:

1. **Waiting Mode (`$0`, every few seconds):** Lossless event ingestion + a tiny local **SetFit** neural bouncer (`Sentence Transformer` + classifier head) predicting `SLEEP` vs `WAKE` in ~10 ms.
2. **Awake Mode (Text-Based RPG Consciousness Loop):** One reasoning model wakes with fresh context, relevant embedded events, immutable receipts from earlier turns, and top-K embedded **Packaged Scripts**. It chooses one script, switches OFF while the script executes, and wakes on the next turn with the exact pass/fail receipt until it calls `sleep`.
3. **Packaged Script Standard (`tools/<id>/`):** Every capability is a self-contained folder (`tool.json`, `run.mjs`, `test.mjs`, `stats.json`). New or repaired scripts must pass `test.mjs` before activation. `send_message` hands exact receipts to a fresh-context fast speaker model behind a `$0` universal truth & formatting gate.

## Commands

```bash
pnpm typecheck
pnpm test
pnpm rufus init
pnpm rufus tools
pnpm rufus wake "What is on my schedule?"
pnpm rufus bouncer status
pnpm rufus bouncer train
```
