# Store durations as whole minutes

Status: Accepted, 2026-09-26

## Context and Problem Statement

`dur` was a float of days. The page already let people type and read "2h" and "15m", so nothing was wrong on screen. But the stored value is what agents read and write, and it showed: a fifteen-minute bill was `0.0104166…`, and 19 of 147 durations in the live plan were not a whole minute at all (`0.03` days is 43.2 minutes). Those were not float drift, which was measured long ago as negligible. They were decimal guesses that a format with no natural grain made easy to write.

This follows [2026-09-26-store-task-times-as-instants.md](2026-09-26-store-task-times-as-instants.md), which made task times instants.

## Decision

Schema v7, 2026-09-26.

- `dur` is whole minutes, greater than zero. Commands refuse anything else, by name.
- A day is 1440. The scheduler's day is 24 hours of lane time and this does not change it, so every exact value schedules as before. Working hours are a feature of their own, not part of the unit (they landed in [2026-09-26-add-working-hours.md](2026-09-26-add-working-hours.md)).
- The field keeps its name. Every writer is this tool's own page and its owner's agents, all updated in the same change, so there is no stale writer for a rename to catch.
- The v6 to v7 rung keeps exact values and rounds the rest to the nearest five minutes, never below five. That was the owner's call: a value that was not a whole minute was a guess, and a guess is not precise to the minute. A legacy zero is left for `invalid()`.
- The scheduler still counts in days. `dayNumbers()` divides by 1440, and the page's read-only guard does the same, as it does for the ISO times.

`doneWindow` and `dueBuffer` stay whole days, because they are calendar spans, not work.

## Alternatives Considered

- Keep float days and round on display: leaves the stored value as the thing agents read, so decimal guesses stay easy to write.
- Rename the field to say its unit (for example `durMin`): rejected because there is no stale writer a rename would catch.
- Round the legacy values to the nearest minute: rejected for the nearest five minutes, per the owner, since a non-whole-minute value was a guess.

## More Information

- Rewritten 2026-11-13 from ADR 0011; alternatives reconstructed from code and history where the original did not record them.
