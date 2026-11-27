# How Rufus Works (the Outline)

Rufus exists to close the gaps between what the owner wants to be true and what is true, as fast as possible.
This outline is the goal. `rufus verify` measures the code against each numbered item.

1. **Senses.** Small pollers check Telegram, Beeper, Gmail, Calendar, the active app, browser history, downloads, the owner's code repos and Rufus's own scheduled wake-ups. Anything new becomes an event.
2. **Memory.** Every event goes into one log and is indexed for meaning-based search. Rufus's own actions go into the same log.
3. **Bouncer.** A tiny local classifier decides WAKE or SLEEP for each event in milliseconds. Direct messages from the owner and Rufus's own scheduled wake-ups always wake him. Wakes where the big model does nothing become training examples.
4. **Gaps.** A gap is what the owner wants true (target) minus what is true now (reality). Gaps form one tree. The root gap, "find the gaps that matter to the owner", is always there and never closes, so "nothing to do" just means the root gap is open. Gaps the owner states start open; gaps Rufus spots start proposed until the owner says yes. Only a fresh verification can close a gap. Anything the owner says that shows it isn't done reopens it. Only the owner can drop a gap.
5. **The Desk.** On every wake, code builds one page, top-down: the gap tree (target vs. reality, with recently closed gaps), each gap's next move, then the event that woke him as new reality, then memories and tools picked for the gaps in play, then this wake's receipts.
6. **Decide.** The big model reads the Desk and outputs exactly one tool call plus the gap it serves: an existing gap, or a new desired state in the owner's words, which code saves as a new gap in the same step. A move that names no gap is rejected. Then the model is off.
7. **Trust gate.** Code checks the tool against the trust ladder (blocked, rehearse, draft and ask, do and report, do quietly), runs it, and returns a receipt of what really happened.
8. **Repeat.** The Desk is rebuilt with the receipt and any new messages, and Decide picks again, until `sleep`.
9. **Tools.** Everything Rufus does is a tool: talking (a Speaker writes from the purpose, the receipts and `VOICE.md`; code blocks unbacked claims), scheduling (timers and "wake me when this thread finishes"), memory search, gaps, approvals, investigate / plan / create / verify (each a fresh model call), the script library, and building new tools.
10. **Sleep.** `sleep` is a tool too, but code only accepts it when every gap that isn't closed, root included, has a next move in motion: a scheduled wake-up or a running thread tied to that gap. If the owner is the blocker, the next move is to chase the owner again, a different way. If a wake ends any other way, code schedules a quick return for every gap left without a next move. Nothing waits passively.

Not part of Rufus: any separate gap poller, gap-specific cooldown, "empty board" event, or special gap wake rule. Gaps wake Rufus through the same scheduling tool as everything else.
