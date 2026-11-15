# Add working hours

Status: Superseded by [2026-10-05-use-one-working-calendar.md](2026-10-05-use-one-working-calendar.md), 2026-10-05

Superseded in part. The single `workHours` window and the `workweek` and `holidays` fields it sat beside became one `hours` field. The scheduling rules below stand: work is spent only inside working time, a start outside it burns nothing until it opens, durations are hours, and the bands show at every zoom.

## Context and Problem Statement

Every working day was 24 hours of lane time. The live plan is one person, one lane and mostly hour-sized tasks (17 of 6h, 13 of 1h, 10 of 2h), so the forecast packed work straight through the night. A 40-hour queue "finished" in under two days, about three times too soon. `workweek` and `holidays` already said which days take work. Nothing said which hours of them do.

This follows [2026-09-26-store-durations-as-whole-minutes.md](2026-09-26-store-durations-as-whole-minutes.md), which kept "a day is 1440" and named working hours as a feature of their own.

## Decision

- `workHours: ["HH:MM", "HH:MM"]` on the plan: one window, applied to every working day, in the plan's `timeZone` wall clock (so 08:00 stays 08:00 across daylight saving). Start before end on the same day. `"24:00"` is a legal end. Nothing crosses midnight. Absent means the whole day, and every existing plan schedules as before.
- The scheduler lays work onto the window. `spanOf` spends a task's minutes only inside it, and `snapFwd` moves a forecast start to its next opening. This is the day-level rule the calendar already had, taken down to minutes. It applies to every task, `noQueue` included, because `noQueue` never exempted anything from the calendar either.
- Two kinds of time, not three: working and not. "Asleep" and "awake" were in the original idea, but nothing would consume awake time, so it would be a setting that moves no date.
- A real start outside the window burns nothing until it opens. Started at 22:00, a one-hour task is forecast to end at 09:00 the next working day. This is the rule a Saturday start already followed. The other reading ("started means working") was chosen and then reversed: it assumes you work straight through the night, and when that is wrong the plan promises a finish that does not happen. An optimistic forecast is the worse error, and marking the task done replaces the forecast with what happened anyway.
- Durations are hours, both ways. With a window set, "a day" of work would mean either 24 hours or one window, so the page neither takes nor prints days: `8h`, `1h30m`, `45m`. A bare number and `3d` are refused rather than guessed at. Stored `dur` is still whole minutes. Slack, due, gains and `dueBuffer` are calendar spans and stay in days.
- Bands at every zoom. The hours outside the window are shaded like days off and merged with them, so Friday 17:00 to Monday 08:00 is one band.
- No schema bump: an optional field, and no existing data changes shape.

Durations already written as whole days (1440, 2880, …) meant a day when a day was 24 hours. They were converted by hand, once, when the live plan got its window: n × 1440 became n × the window's minutes, finished tasks included so history reads in the same unit. A migration was not used, because code kept forever for a one-time edit is not worth owning. Changing the window later only reschedules and never rewrites a duration.

Out of scope, and their own work if wanted: a daily budget without a clock window ("two hours a day, whichever two"), per-lane or per-weekday hours, a calendar of per-date exceptions, slack and due measured in hours, and time tracking.

## Alternatives Considered

- Three kinds of time (asleep, awake, working): rejected because nothing consumes awake time.
- Treat a start outside the window as working straight through: chosen and then reversed, see above.
- Keep durations in days alongside the window: rejected because "a day" becomes ambiguous.
- Convert old whole-day durations with a migration: rejected, see above.

## More Information

- Superseded in part by [2026-10-05-use-one-working-calendar.md](2026-10-05-use-one-working-calendar.md).
- Rewritten 2026-11-13 from ADR 0014; alternatives reconstructed from code and history where the original did not record them.
