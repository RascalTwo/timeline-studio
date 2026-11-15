# Keep planned stretches beside sessions, not inside them

Status: Accepted, 2026-10-04

## Context and Problem Statement

Meetings and other time-boxed work need to hold wall-clock time on the plan before they happen. [2026-10-04-make-sessions-the-only-record-of-work.md](2026-10-04-make-sessions-the-only-record-of-work.md) made sessions the only record of work, so a promise about the future needs a place that is not a session.

## Decision

- `planned` is a list on the task, `[{start, stop}]`, the same shape as `sessions`. Sessions are what happened and planned is what is promised. The scheduler holds a planned stretch in wall-clock time and works other tasks around it (`calOf` carries them as `blocks`, so every `spanOf`, `snapFwd` and `offHours` call honours them). A task held by its plan does not queue. It ignores its dependencies, and the slack chip is the warning.
- The clock never converts a plan into work. A meeting can be cancelled and work skipped, and nothing in this tool is created by the clock. `completePlanned` moves a stretch into `sessions` (times correctable) and `setPlanned` deletes one. Finishing a never-started task records the stretches already under way as its sessions and drops the rest. The converted stretch leaves `planned`. There is no planned-versus-actual record, because duration versus sessions already says whether it ran over.
- A plan that lapsed is ordinary work again. Once the last stretch is over and nobody started the task, `sched` forecasts it from now like any task, and the page marks the stretch missed until it is converted or deleted. `spanOf` is wall clock only when drawn at the first stretch's start, so the two answers cannot disagree.
- Once a task has a session it is ordinary work, but its remaining stretches keep blocking others.
- Repeating tasks do not carry `planned` to their copies: the same times would double-book, and the rule has no place to hold them. Plan each copy.

## Alternatives Considered

- A `slot` flag reusing `notBefore` and `due` (shipped in 437468f, never published): overloaded two fields, allowed one stretch, and ended at the first session.
- Future-dated entries in `sessions`: worked time would count work that has not happened, a planned task would read as worked-on with no way back to not started ([2026-10-04-make-sessions-the-only-record-of-work.md](2026-10-04-make-sessions-the-only-record-of-work.md)), and a stored task would mean different things depending on the clock.

## More Information

- Superseded in one line by [2026-10-11-keep-recurring-things-in-google-calendar.md](2026-10-11-keep-recurring-things-in-google-calendar.md): there are no repeating tasks, so the line about them no longer applies. The rest stands.
- Followed by [2026-10-04-ask-what-happened-to-past-plans.md](2026-10-04-ask-what-happened-to-past-plans.md).
- Rewritten 2026-11-13 from ADR 0017; alternatives reconstructed from code and history where the original did not record them.
