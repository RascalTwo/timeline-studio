# Store task times as instants, and give a plan a time zone

Status: Accepted, 2026-09-26

## Context and Problem Statement

Until schema v6, `notBefore`, `due`, `actualStart`, `actualEnd` and `refinedAt` were day numbers: float days since `doc.start`, the fraction being the writer's wall clock. That format was the scheduler's working unit leaking into storage. On one morning it produced or hid three separate bugs:

- Whole day versus instant was a matter of being an integer. `7` meant "all of Sep 26" and `7.25` meant 6 a.m., and both passed every type and validator. The first Kanban board wrote `todayD()` where it meant `nowD()`, and 13 finished tasks held a one-lane plan busy until midnight.
- There was no zone. The fraction was the writer's local clock, so an agent converting a UTC instant was silently hours off, and the server (a UTC container) and the page (a Central browser) disagreed about "today" every evening.
- The value was relative to a patchable origin. Moving `doc.start` moved every recorded fact.

## Decision

Schema v6, 2026-09-26. This supersedes the day-number convention for stored task times.

- The five fields are UTC ISO instants, the `toISOString()` shape, like `createdAt` and `updatedAt` already were. Commands accept any offset and normalise to `Z`. A string with no zone, or a number, is refused.
- The document carries `timeZone` (IANA). The server and the page both count days in it (`todayISO`, `todayOf`, `nowOf`, the starter plan's `start`), so they agree by construction. Times are shown in the plan's zone for everyone, labelled.
- The scheduler still counts in day numbers. `dayNumbers()` projects a stored document into them, and every shared entry point (`readiness`, `verdict`, `boardColumns`, `suggestReorders`, `laneOrder`) goes through it. The page does the same in its read-only guard, so its roughly 70 readers were untouched. Writes convert back with `whenOf`.
- The whole-day convention is gone. The v5 to v6 rung turns an integer `n` into local midnight of day `n`, the instant the scheduler already meant, so no date moved. After it, 00:00 is midnight.
- The rung's zone is the document's or `America/Chicago`, never the runtime's. The page migrates history versions with no context and the server with context, and both must produce identical instants. A test runs it under other `TZ` values.
- The server now refuses `actualEnd` without `actualStart` or not after it, and `setRefined` gets the value check it never had.

Not decided here: `dur`, `doneWindow` and `dueBuffer` stay numbers of days (whether `dur` should be whole minutes was left for v7). `doc.start`, milestone dates, holidays and `sprint.start` stay plain dates, because they are whole days by nature.

## Alternatives Considered

- Keep day numbers and document the convention: rejected because the integer-versus-fraction distinction is invisible to validators and caused the first bug.
- Store instants with the zone on each value, or in local time: rejected in favour of UTC ISO plus one plan zone, so the server and page agree and agents can convert exactly.
- Run the migration in the runtime's zone: rejected, see above.

## More Information

- Followed by [2026-09-26-store-durations-as-whole-minutes.md](2026-09-26-store-durations-as-whole-minutes.md).
- Rewritten 2026-11-13 from ADR 0010; alternatives reconstructed from code and history where the original did not record them.
