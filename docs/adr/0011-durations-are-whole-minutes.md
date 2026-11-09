# Durations are whole minutes

Schema v7, 2026-09-26. Follows ADR 0010, which made task times instants.

`dur` was a float of DAYS. The page already let people type and read "2h" and "15m", so
nothing was wrong on screen — but the stored value was what agents read and write, and it
showed: a fifteen-minute bill was `0.0104166…`, and 19 of 147 durations in the live plan
were not a whole minute at all (`0.03` days is 43.2 minutes). Those were not float drift,
which was measured long ago as negligible; they were decimal guesses a format with no
natural grain made easy to write.

## Decision

- `dur` is **whole minutes, greater than zero**. Commands refuse anything else, by name.
- **A day is 1440.** The scheduler's day is 24 hours of lane time and this does not change
  it, so every exact value schedules exactly as before. Working hours — asleep, awake,
  working — are a feature of their own, not part of the unit. (They landed in ADR 0014.)
- **The field keeps its name.** Every writer is this tool's own page and its owner's
  agents, all updated in the same change, so there is no stale writer for a rename to
  catch.
- The v6→v7 rung keeps exact values and rounds the rest to the **nearest five minutes**,
  never below five — the owner's call: a value that was not a whole minute was a guess, and
  a guess is not precise to the minute. A legacy zero is left for `invalid()`.
- The scheduler still counts in days. `dayNumbers()` divides by 1440, and the page's
  read-only guard does the same, as it does for the ISO times.

`doneWindow` and `dueBuffer` stay whole days: they are calendar spans, not work.
