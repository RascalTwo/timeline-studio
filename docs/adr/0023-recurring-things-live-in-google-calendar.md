# Recurring things live in Google Calendar

2026-10-09. Removes repeating tasks (`setRecur`, shipped 2026-10-04 in 3ff6938). Supersedes ADR 0017's line "Repeating
tasks do not carry `planned`": there are no repeating tasks.

## Decision

- **No repeating tasks.** The `setRecur` command, the task's `recur` field and the inspector's Repeats row are gone. A
  request naming `setRecur` fails like any unknown command, and a task carrying `recur` is refused like any unknown key.
- **Anything that comes round on a calendar is a Google Calendar event.** The hourly google-calendar-to-timeline-studio
  sync brings it into the plan as an ordinary task (`ref` starting `gcal:`, `noQueue`, `planned`; ADR 0017, ADR 0020).
  `setRecur` was a second way to do what the calendar already does, and every change to commands, the inspector or the
  tests carried it.
- **Schema v11.** The v10 -> v11 rung deletes `recur` from every task and touches nothing else, so every copy a series
  made stays as an ordinary task. The v9 rung's own field list still names `recur`: a shipped rung never changes.

## Why now

Its only use was three monthly bills (rent, electric, water: nine open copies). A scan of all 158 saved versions of the
plan found no other series. The monthly duty it was built for never used it and is already a calendar event.

## Accepted

A bill becomes a calendar block, not a task that stays overdue until someone finishes it. Unverified when this was
decided: whether the sync keeps a "done" on a calendar task.
