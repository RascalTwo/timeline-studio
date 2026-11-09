# Paused work goes back in the queue

2026-10-04. Amends ADR 0015 ("forecast from now") for paused tasks.

## Context

`sched` seeded every started task at its first session, outside the queue, and `spanOf` forecast what was
left of it from now. On a one-lane plan with one running and three paused tasks, all four remainders
started at the same minute: the lane's capacity only ever applied to work nobody had started. The new
calendar view made it obvious; the Timeline drew the same thing.

## Decision

- **Only running work is a fact about the lane.** A task with a session open, and a finished one, are
  seeded as before.
- **A paused task is forecast again**: it goes through the queue like unstarted work, in its row's place,
  never before now (`resume`), and spends what is left of `dur` from where it lands. Its scheduled start is that turn, not its first
  session; its sessions are still drawn where they happened.
- **Its dependencies no longer hold it.** Starting it already overrode them, and re-queuing must not take
  that back.
- **Several open sessions stay parallel.** Two running tasks mean two things really are going on.
- `noQueue` paused work still neither waits for nor holds a slot, so it forecasts from now.

## Rejected

- *Serialise all in-progress work, running first* (option A). It keeps the seeded start, so the bar would
  still claim the work is happening from its first session through the queue wait.
- *Do not forecast paused work at all.* The remaining work would vanish from the chart and its dependents
  would be dated too early.
- *Paused work jumps the queue* (fewer context switches). Deferred to its own decision: it would beat row
  order, so an unstarted task with a close deadline could not be moved ahead of it.
