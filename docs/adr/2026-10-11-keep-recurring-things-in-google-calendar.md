# Keep recurring things in Google Calendar

Status: Accepted, 2026-10-11

## Context and Problem Statement

Repeating tasks (`setRecur`, shipped 2026-10-04 in 3ff6938) were a second way to do what Google Calendar already does, and every change to commands, the inspector or the tests carried them. Their only use was three monthly bills (rent, electric, water: nine open copies). A scan of all 158 saved versions of the plan found no other series. The monthly duty it was built for never used it and is already a calendar event.

## Decision

This removes repeating tasks. It supersedes the line "Repeating tasks do not carry `planned`" in [2026-10-04-keep-planned-stretches-beside-sessions.md](2026-10-04-keep-planned-stretches-beside-sessions.md): there are no repeating tasks.

- No repeating tasks. The `setRecur` command, the task's `recur` field and the inspector's Repeats row are gone. A request naming `setRecur` fails like any unknown command, and a task carrying `recur` is refused like any unknown key.
- Anything that comes round on a calendar is a Google Calendar event. The hourly google-calendar-to-timeline-studio sync brings it into the plan as an ordinary task (`ref` starting `gcal:`, `noQueue`, `planned`; see [2026-10-04-keep-planned-stretches-beside-sessions.md](2026-10-04-keep-planned-stretches-beside-sessions.md) and [2026-10-04-ask-what-happened-to-past-plans.md](2026-10-04-ask-what-happened-to-past-plans.md)).
- Schema v11. The v10 to v11 rung deletes `recur` from every task and touches nothing else, so every copy a series made stays as an ordinary task. The v9 rung's own field list still names `recur`, because a shipped rung never changes.

Accepted cost: a bill becomes a calendar block, not a task that stays overdue until someone finishes it. Unverified when this was decided: whether the sync keeps a "done" on a calendar task.

## Alternatives Considered

- Keep `setRecur` and fix its rough edges: rejected because it duplicates the calendar and its only users were three bills.
- Move the monthly bills to a script or another recurrence feature: rejected, the calendar already does it.

## More Information

- Rewritten 2026-11-13 from ADR 0023; alternatives reconstructed from code and history where the original did not record them.
