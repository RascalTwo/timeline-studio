# Keep queues ordered with Auto-order, run by the server

Status: Accepted, 2026-09-26

## Context and Problem Statement

Queue order is the one scheduling input with no arrow on the chart. The page's answer was advice: an Order chip that reran the reorder search after edits and offered moves for a human to apply. On a one-lane plan of about 150 tasks one search takes about 8 seconds, the chip went stale on every edit, and applying one suggestion invalidated the rest.

## Decision

- A plan-level `autoOrder` flag, patchable and off by default. When on, the Order chip is gone and the page runs no search of its own.
- Manual reordering stays on (revised the same day; it was disabled at first). The search only moves a task for a strict improvement, so a hand-made order that is as good as any stands. One that makes something later or late is re-settled to the best order the search finds, which is not necessarily the one before the edit. On a one-lane plan most orders tie, so most manual moves stick.
- The server settles after the change, not during it. After any apply that alters `orderSignature` (the page's old `orderSig`, moved to shared so both ask the same question), it runs `suggestReorders` in the existing worker, applies the best single move as `moveTaskInLane` by "Auto-order", and searches again until nothing helps. A change that lands mid-search restarts it from the new state.
- Callers that need the settled plan, such as agents that read back and act, pass `settle=1` on any call. Writes then return after settling and reads wait for a settle in progress. The owner expects agents to send it on every call.
- It is a local search, so "settled" means no single move improves the plan, not a proven optimum.

## Alternatives Considered

- Keep the Order chip as advice: rejected because of the 8-second search and the stale suggestions.
- Block every edit until the plan settles: this was the owner's first idea and was rejected for the page, because every keystroke would wait seconds. It survives only as the opt-in `settle=1`.
- Disable manual reordering when Auto-order is on: tried first, then reversed the same day, see above.

## More Information

- Rewritten 2026-11-13 from ADR 0012; alternatives reconstructed from code and history where the original did not record them.
