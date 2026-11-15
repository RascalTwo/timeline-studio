# Record work as sessions

Status: Superseded by [2026-10-04-make-sessions-the-only-record-of-work.md](2026-10-04-make-sessions-the-only-record-of-work.md), 2026-10-04

Superseded in part. Sessions are now the only record of work: `actualStart`, `actualEnd` and `setActuals` are gone, and finishing is `finishTask` and a `done` flag. The text below is the decision as it was made.

## Context and Problem Statement

[2026-09-26-add-working-hours.md](2026-09-26-add-working-hours.md) raised it in its grill: an off-hours start cannot say how much of the night was worked, because only a start and a finish were ever facts.

## Decision

- A task holds `sessions: [{start, stop}]`, with `stop` null while it runs. They are ordered, may not overlap, and only the last may be running. Many tasks can run at once and there is no lane limit on that. The same task cannot run twice.
- Three commands. `startTask` and `stopTask` use the command's `at` as the moment (the server fills it). `setSessions` replaces the whole list, which is how a forgotten stop is put back to 4pm instead of reading as an all-nighter. There is no auto-close: the running time on screen is the cue.
- Stopping is not finishing. `actualEnd` stays its own act. Sessions only set `actualStart`, to the first start. Finishing a task (`setActuals` with an end) stops the session still running, at the finish.
- Worked time is wall clock, not working-hours minutes, because the point is that off-hours work is real work.
- The forecast uses what is left. For an unfinished task with sessions, remaining is `dur` minus worked, never under a minute (an overrun task stays a bar you can click), forecast from now. `dur` stays the estimate, and lane loads still count all of it.
- None of it clears `refinedAt`. Sessions are a fact log, not the wording a sign-off was about. Agents use the same commands, and `setActuals` still works for a task with no sessions. Tasks finished before this keep their actuals, and no sessions are invented.
- No schema bump: `sessions` is optional, like `workHours` was.
- Drawn as work, not as elapsed time. A worked task draws a segment per session, wearing the task's own shape, rim and fill (hatching is the fill channel, so it is never used to mean "forecast"), with the bar behind them faint so the gaps read as gaps. The forecast part of any unfinished task, worked or not, is cut at the working hours: it stops when the window closes and resumes when it reopens, nights and weekends included (`offHours`, `workChunks`). What already happened is wall clock and is never cut. The chart's axis is pinned.

## Alternatives Considered

- Keep only a start and a finish: leaves an off-hours start unable to say how much was worked, which is the problem.
- Count worked time in working-hours minutes: rejected because off-hours work is real work.
- Auto-close a session left running: rejected, the running time on screen is the cue and `setSessions` fixes a forgotten stop.
- Use hatching to mean "forecast": rejected because hatching is the fill channel.

## More Information

- Superseded in part by [2026-10-04-make-sessions-the-only-record-of-work.md](2026-10-04-make-sessions-the-only-record-of-work.md).
- Rewritten 2026-11-13 from ADR 0015; alternatives reconstructed from code and history where the original did not record them.
