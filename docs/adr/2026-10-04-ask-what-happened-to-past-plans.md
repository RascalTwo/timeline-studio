# Ask what happened to past plans

Status: Accepted, 2026-10-04

## Context and Problem Statement

Synced calendar meetings made planned stretches common. Every one that ended stayed a promise about the past until somebody pressed ✓ or × on it in the Inspector, task by task. Nothing said they were waiting, so they piled up, and an unconfirmed meeting queued from now like unstarted work.

[2026-10-04-keep-planned-stretches-beside-sessions.md](2026-10-04-keep-planned-stretches-beside-sessions.md) stands: the clock never converts a plan.

## Decision

- The Order panel is renamed Review, with a third tab, Past plans: every planned stretch that is over on an unfinished task, oldest first, as soon as it ends, one at a time. The chip carries two badges (amber for past plans, blue for unranked), shows whenever a past plan waits even if Auto-order has not run, and opens on Past plans then.
- Two steps, two keys (→ good, ← bad). First: → it happened, ← it didn't, E corrects the times (prefilled with the stretch) and goes on as "happened". Then, if it happened: → finished (`completePlanned` + `finishTask`, which drops the task's later stretches), ← carries on (`completePlanned`). If it didn't: ← delete the task (`removeTask`), → keep it (`setPlanned` without that stretch). Esc backs out of the second step.
- Enter takes the default for the kind of task. A meeting (`ref` starts `gcal:`) is finished or deleted. Your own work carries on or is kept. A confirmed-but-open meeting would count as paused work and go first ([2026-10-04-put-paused-work-first-after-the-dates.md](2026-10-04-put-paused-work-first-after-the-dates.md)).
- The Inspector says "unconfirmed" (was "missed") on those rows and offers the same two steps as buttons.
- Page only: existing commands, nothing stored, no new route. An agent asks the same question from `planned`.

## Alternatives Considered

- Four keys, one per outcome: faster, but the two questions are separate and four keys are a lookup table.
- Undo: a wrong answer is fixed the way any edit is, and an undo stack for one tab is not worth its state.
- Confirming accepted meetings automatically: that is the clock converting a plan, which the earlier decision rules out.

## More Information

- Rewritten 2026-11-13 from ADR 0020; alternatives reconstructed from code and history where the original did not record them.
