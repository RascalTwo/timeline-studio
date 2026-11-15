# Put paused work first, after the dates

Status: Accepted, 2026-10-04

## Context and Problem Statement

Once paused work queued in its row's place ([2026-10-04-requeue-paused-work.md](2026-10-04-requeue-paused-work.md)), it could sit behind new work indefinitely. That means more context switches and tasks left dangling. Putting it first outright would also put it ahead of an unstarted task with a close deadline, and no reordering could rescue that.

## Decision

- A new key in the reorder search, between the dates and the person's ranking: dates (lateness, then the `dueBuffer`), then paused before unstarted, then the person's ranking, then the suggested ranking.
- It is a two-level ranking, counted the way the ranking is. A move that puts a paused task ahead of unstarted work fixes pairs, reported as `paused: true` with `ranked` the pairs fixed. A ranking or suggested move may break none of its pairs, so the person's ranking orders paused work among itself and unstarted work among itself.
- Only queued work has an opinion. Running, finished, `noQueue` and planned tasks are left out.
- It acts through Auto-order and `/api/reorder` as ordinary row moves. `sched` is unchanged.

## Alternatives Considered

- Paused first inside `sched`: row order would stop deciding, so Auto-order could not move a deadline ahead.
- Below the person's ranking: with most pairs answered it would rarely fire.
- Priority that grows the longer a task is paused: deferred until paused work still lingers under this rule.

## More Information

- Rewritten 2026-11-13 from ADR 0019; alternatives reconstructed from code and history where the original did not record them.
