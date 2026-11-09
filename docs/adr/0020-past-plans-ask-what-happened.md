# Past plans ask what happened

2026-10-04. Follows ADR 0017 (planned stretches beside sessions), which stands: the clock never converts a plan.

## Context

Synced calendar meetings made planned stretches common, and every one that ended stayed a promise about the past
until somebody pressed ✓ or × on it in the Inspector, task by task. Nothing said they were waiting, so they piled
up, and an unconfirmed meeting queued from now like unstarted work.

## Decision

- **The Order panel is renamed Review**, with a third tab, **Past plans**: every planned stretch that is over on an
  unfinished task, oldest first, as soon as it ends, one at a time. The chip carries two badges (amber: past plans,
  blue: unranked), shows whenever a past plan waits even if Auto-order has not run, and opens on Past plans then.
- **Two steps, two keys** (→ good, ← bad). First: → it happened, ← it didn't, E corrects the times (prefilled with
  the stretch) and goes on as "happened". Then, if it happened: → finished (`completePlanned` + `finishTask`, which
  drops the task's later stretches), ← carries on (`completePlanned`). If it didn't: ← delete the task
  (`removeTask`), → keep it (`setPlanned` without that stretch). Esc backs out of the second step.
- **Enter takes the default for the kind of task**: a meeting (`ref` starts `gcal:`) is finished or deleted; your own
  work carries on or is kept. A confirmed-but-open meeting would count as paused work and go first (ADR 0019).
- **The Inspector says "unconfirmed"** (was "missed") on those rows and offers the same two steps as buttons.
- **Page only**: existing commands, nothing stored, no new route. An agent asks the same question from `planned`.

## Rejected

- *Four keys, one per outcome.* Faster, but the two questions are separate and four keys are a lookup table.
- *Undo.* A wrong answer is fixed the way any edit is; an undo stack for one tab is not worth its state.
- *Confirming accepted meetings automatically.* That is the clock converting a plan, which ADR 0017 rules out.
