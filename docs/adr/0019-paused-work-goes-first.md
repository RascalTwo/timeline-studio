# Paused work goes first, after the dates

2026-10-04. Follows ADR 0018 (paused work goes back in the queue).

## Context

Once paused work queued in its row's place, it could sit behind new work indefinitely: more context switches and
tasks left dangling. Putting it first outright would also put it ahead of an unstarted task with a close deadline,
and no reordering could rescue that.

## Decision

- **A new key in the reorder search, between the dates and the person's ranking**: dates (lateness, then the
  `dueBuffer`), then paused before unstarted, then the person's ranking, then the suggested ranking.
- **It is a two-level ranking**, counted the way the ranking is: a move that puts a paused task ahead of unstarted
  work fixes pairs, reported as `paused: true` with `ranked` the pairs fixed. A ranking or suggested move may break
  none of its pairs, so the person's ranking orders paused work among itself and unstarted work among itself.
- **Only queued work has an opinion**: running, finished, `noQueue` and planned tasks are left out.
- It acts through Auto-order and `/api/reorder` as ordinary row moves; `sched` is unchanged.

## Rejected

- *Paused first inside `sched`.* Row order would stop deciding, so Auto-order could not move a deadline ahead.
- *Below the person's ranking.* With most pairs answered it would rarely fire.
- *Priority that grows the longer a task is paused.* Deferred until paused work still lingers under this rule.
