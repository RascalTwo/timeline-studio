# One working calendar

2026-10-05. Supersedes ADR 0014's single window and the `workweek` and `holidays` fields it sat beside. ADR 0014's
scheduling rules stand: work is spent only inside working time, a start outside it burns nothing until it opens,
durations are hours, and the bands show at every zoom.

Working time was three fields that answered one question: `workweek` (a 7-slot on/off mask), `holidays` (dates
nobody works) and `workHours` (one window applied to every working day). That could not say "Fridays run late",
"a lunch break", or "this Sunday I work 08:00 to 21:00", and each new case would have been a fourth field.

## Decision

- **One optional field, `hours`**: `week` maps `sun`..`sat` to a list of `["HH:MM", "HH:MM"]` windows, and `dates` maps
  `"YYYY-MM-DD"` to the list that REPLACES that date's weekday hours. A weekday missing or `[]` is a day off; a date
  with `[]` is off (a holiday is now exactly that).
- **Window rules**: start before end, `"24:00"` is a legal end, nothing crosses midnight, the windows of a day ascend
  and do not overlap (touching is fine). Several windows per day are allowed and work spans the gap between them.
- **Nothing set means every hour works.** `hours` absent, or a `week` with no window at all, reads as the whole day on
  every weekday (date overrides still apply). This is what a plan with nothing set did before, and it keeps `spanOf`
  from walking an all-off calendar forever.
- **Wall clock in the plan's `timeZone`**, day numbers counted from `doc.start`, as before.
- **Schema v10.** The v9 -> v10 rung moves every plan across without moving a scheduled date: no old key means no
  `hours`; a mask with no working day means no `hours` either (the old calendar read that as all-on, holidays and
  window ignored); otherwise each weekday the mask allows gets the one window (the whole day if there was none) and
  each holiday becomes a date with no windows. The three old keys are deleted.
- **`patchDoc` takes `hours` (or `null`) and refuses the three old keys**, naming `hours` and v10 in the message. This
  is the one refusal that names a removed key; the three were replaced in place, not dropped, and a caller still
  sending them is better told where their meaning went.
- **The calendar interface is per-day.** `Cal.win(day)` returns the day's windows as fractions of it and `isWorking` is
  "has a window", replacing the scalar `from`/`to`. `allOn` now means "every day works", whatever its hours.
- **Settings is one editor**: a row per weekday with its windows (time pairs, remove, add; an empty row reads "Off", or
  "Any hour" while no weekday has a window), and below it the date overrides from today on. Past overrides stay in the
  document untouched, as history.

## Consequences

No date moves in the migration, and the grid fingerprint is unchanged. History keeps every version in the schema it was
saved in and each one still opens through the ladder.

Out of scope: a daily budget without a clock window, per-lane hours, recurring date rules ("every first Monday"), and
windows that cross midnight (a night shift is two windows on two days).
