# Planned stretches sit beside sessions, not inside them

2026-10-04. Follows ADR 0016 (sessions are the only record of work).

## Decision

- **`planned` is a list on the task**, `[{start, stop}]`, the same shape as `sessions`. Sessions are what
  happened; planned is what is promised. The scheduler holds a planned stretch in wall-clock time, works
  other tasks around it (`calOf` carries them as `blocks`, so every `spanOf`/`snapFwd`/`offHours` call
  honours them), and a task held by its plan does not queue. It ignores its dependencies: the slack chip
  is the warning.
- **The clock never converts a plan into work.** A meeting can be cancelled and work skipped, and nothing
  in this tool is created by the clock. `completePlanned` moves a stretch into `sessions` (times
  correctable), `setPlanned` deletes one, and finishing a never-started task records the stretches
  already under way as its sessions and drops the rest. The converted stretch leaves `planned`: there is
  no planned-versus-actual record, because duration versus sessions already says whether it ran over.
- **A plan that lapsed is ordinary work again.** Once the last stretch is over and nobody started the
  task, `sched` forecasts it from now like any task, and the page marks the stretch missed until it is
  converted or deleted. `spanOf` is wall clock only when drawn at the first stretch's start, so the two
  answers cannot disagree.
- **Once a task has a session it is ordinary work**, but its remaining stretches keep blocking others.
- **Repeating tasks do not carry `planned`** to their copies: the same times would double-book, and the
  rule has no place to hold them. Plan each copy.

## Rejected

- *A `slot` flag reusing `notBefore` and `due`* (shipped in 437468f, never published). It overloaded two
  fields, allowed one stretch, and ended at the first session.
- *Future-dated entries in `sessions`.* Worked time would count work that has not happened, a planned task
  would read as worked-on with no way back to not started (ADR 0016), and a stored task would mean
  different things depending on the clock.
