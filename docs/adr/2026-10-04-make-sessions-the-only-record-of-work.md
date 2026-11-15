# Make sessions the only record of work

Status: Accepted, 2026-10-04

## Context and Problem Statement

A stopped session left a task reading "In progress". `stopTask` is a pause, and a status read off `actualStart` could not tell paused from running. [2026-09-28-record-work-as-sessions.md](2026-09-28-record-work-as-sessions.md) kept `actualStart` and `actualEnd` beside the sessions, and [2026-09-26-let-the-kanban-lens-write-dates.md](2026-09-26-let-the-kanban-lens-write-dates.md) wrote them from drops. This was settled in a three-round visual grill (`grill-ts-sessions-vs-actuals`).

## Decision

This supersedes the parts of those two records that kept the actuals.

- A task's work is its `sessions`, and nothing else. `actualStart`, `actualEnd` and `setActuals` are removed outright. No refusal names them, so they fail like any unknown command or task field (2026-10-04, after this ADR first shipped with named refusals). A task started at its first session's start. The scheduler and the page still read `actualStart` and `actualEnd` as day numbers, derived (`actualsOf`), never stored or sent.
- Finished is a flag on the task, `done: true`, not a field on a session. It finished at its last stop, and every done task has a session, none running. `finishTask` stops the running session at `at`, or for work never started writes a session of no length there. `reopenTask` clears the flag and keeps the sessions. Both take no time of their own.
- Status is derived: done, else running (a session open), else paused (sessions, none open), else not started. `/api/ready` reports `running` and `paused`, and `doing` is gone.
- No way back to not started. A task with sessions keeps at least one (`setSessions` with `[]` is refused there). Starting over is a new task: split it. There is no "abandoned".
- The board's In progress is two groups, Running now and Paused, in the existing order. A drop is the session event it means: into Running starts, into Paused stops (from Not started, a session of no length), into Done finishes, out of Done reopens.
- Reads carry `sessions` and `done` only. There is no derived `startedAt` or `finishedAt` on the wire, because a reader can take the first start and the last stop itself.

Migration (v7 to v8), through the ladder like every rung, so history versions migrate on read. Finished work with no sessions becomes one session over its old actuals and `done: true`. Work with sessions keeps them. Where an old start came before the first session, or an old finish after the last stop (a typed start, or a finish logged hours after the last stop; ten such tasks in the live plan on 2026-10-04), that moment becomes a session of no length, so no date moves and no worked time is invented. A start with neither finish nor sessions becomes a session of no length: paused, not a clock left running. `reorder-dedupe.test.ts` holds the v7 code and the v8 code to the same schedules and suggestions over 250 random plans.

Consequences:

- A finished task drawn from one migrated session looks as it did: the segment covers the bar.
- `startBeforeEnd` (a finish with no start, back-filled through working hours) is gone with `setActuals`. A finish with no start is now a moment of no length, and its time is corrected in the sessions if it matters.
- Undo cannot un-start. The in-page assistant's inverses undo the state (stop, reopen), not the sessions.

## Alternatives Considered

- Keep `actualStart` and `actualEnd` beside sessions: the state before this decision. Rejected because status read off `actualStart` cannot tell paused from running, and two records of the same fact can disagree.
- Store finish as a field on a session: rejected in favour of a task flag.
- Send derived `startedAt` and `finishedAt` on reads: rejected, a reader can derive them.

## More Information

- Supersedes in part [2026-09-28-record-work-as-sessions.md](2026-09-28-record-work-as-sessions.md) and [2026-09-26-let-the-kanban-lens-write-dates.md](2026-09-26-let-the-kanban-lens-write-dates.md).
- Rewritten 2026-11-13 from ADR 0016; alternatives reconstructed from code and history where the original did not record them.
