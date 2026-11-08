# Auto-order: the server keeps the queues ordered

2026-09-26.

Queue order is the one scheduling input with no arrow on the chart, and the page's answer
to it was advice: an Order chip that reran the reorder search after edits and offered moves
for a human to apply. On a one-lane plan of ~150 tasks one search is ~8 seconds, the chip
went stale on every edit, and applying a suggestion invalidated the rest.

## Decision

- A plan-level **`autoOrder`** flag (patchable, off by default). When on, the Order chip is
  gone and the page runs no search of its own.
- **Manual reordering stays on** (revised the same day — it was disabled at first). The
  search only moves a task for a strict improvement, so a hand-made order that is as good
  as any stands, and one that makes something later or late is re-settled — to the best
  order the search finds, which is not necessarily the one before the edit. On a one-lane
  plan most orders tie, so most manual moves stick.
- **The server settles after the change, not during it.** After any apply that alters
  `orderSignature` (the page's old `orderSig`, moved to shared so both ask the same
  question), it runs `suggestReorders` in the existing worker, applies the best single move
  as `moveTaskInLane` by "Auto-order", and searches again until nothing helps. A change that
  lands mid-search restarts it from the new state.
- **Blocking every edit was the owner's first idea and was rejected** for the page: every
  keystroke would wait seconds. Callers that need the settled plan — agents that read back
  and act — pass **`settle=1`** on any call: writes return after settling, reads wait for a
  settle in progress. The owner's expectation is that agents send it on every call.
- It is a local search, so "settled" means no single move improves the plan, not a proven
  optimum.
