# Task times are instants, and a plan has a time zone

Schema v6, 2026-09-26. Supersedes the day-number convention for stored task times.

Until v6, `notBefore`, `due`, `actualStart`, `actualEnd` and `refinedAt` were **day
numbers**: float days since `doc.start`, the fraction being the writer's wall clock. That
format was the scheduler's working unit leaking into storage, and on one morning it
produced or hid three separate bugs:

- **Whole day vs instant was a matter of being an integer.** `7` meant "all of Sep 26"
  and `7.25` meant 6 a.m.; both passed every type and validator. The first Kanban board
  wrote `todayD()` where it meant `nowD()`, and 13 finished tasks held a one-lane plan
  busy until midnight.
- **No zone.** The fraction was whoever wrote it's local clock, so an agent converting a
  UTC instant was silently hours off, and the server (container, UTC) and the page
  (browser, Central) disagreed about "today" every evening.
- **Relative to a patchable origin.** Moving `doc.start` moved every recorded fact.

## Decision

- The five fields are **UTC ISO instants**, the `toISOString()` shape, like `createdAt`
  and `updatedAt` already were. Commands accept any offset and normalise to `Z`; a string
  with no zone, or a number, is refused.
- The document carries **`timeZone`** (IANA). The server and the page both count days in
  it — `todayISO`, `todayOf`, `nowOf`, the starter plan's `start` — so they agree by
  construction. Times are shown in the plan's zone for everyone, labelled.
- **The scheduler still counts in day numbers.** `dayNumbers()` projects a stored document
  into them, and every shared entry point (`readiness`, `verdict`, `boardColumns`,
  `suggestReorders`, `laneOrder`) goes through it. The page does the same in its read-only
  guard, so its ~70 readers were untouched; writes convert back with `whenOf`.
- **The whole-day convention is gone.** The v5→v6 rung turns an integer `n` into local
  midnight of day `n` — the instant the scheduler already meant — so no date moved. After
  it, 00:00 is midnight.
- The rung's zone is the document's or `America/Chicago`, **never the runtime's**: the
  page migrates history versions with no context and the server with context, and both
  must produce identical instants. A test runs it under other `TZ` values.
- The server now refuses `actualEnd` without `actualStart` or not after it, and
  `setRefined` gets the value check it never had.

## Not decided here

`dur`, `doneWindow` and `dueBuffer` stay numbers of days. Whether `dur` should be whole
minutes is a v7 question. `doc.start`, milestone dates, holidays and `sprint.start` stay
plain dates — they are whole days by nature.
