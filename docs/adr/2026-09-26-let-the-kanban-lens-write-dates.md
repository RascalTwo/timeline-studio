# Let the kanban lens write dates

Status: Superseded by [2026-10-04-make-sessions-the-only-record-of-work.md](2026-10-04-make-sessions-the-only-record-of-work.md), 2026-10-04

Superseded in part. The board still writes, but its drops are now session events (start, stop, finish, reopen), In progress is two groups (Running now and Paused), and nothing goes back to Not started. The text below is the decision as it was made.

## Context and Problem Statement

[2026-09-19-let-the-graph-lens-write-dependencies.md](2026-09-19-let-the-graph-lens-write-dependencies.md) let the graph write dependencies and kept one line: it still cannot move a date, because position on the graph is not time. The kanban lens crosses that line on purpose. This record says why it is not the same mistake.

The board's states are Blocked, Ready, In progress and Done. All four are derived: from `readiness()` for the first two, from `actualStart` and `actualEnd` for the last two. There is no stored status and this does not add one. So "move this card to In progress" can only mean one thing: I started this today. A column here is a statement about the two actual dates, which a node's position on the graph never was.

## Decision

The board accepts drags into three columns: Not started, In progress, Done. Those are the three states the two actual dates can express, so they are the three places a card can be put.

- Why a task has not started is the scheduler's opinion, so every not-started task shares one column. It is grouped under the Ready filter's own chips, nearest to startable first: Ready now, Needs refining, Queued, Not before, Blocked. Counts sit on the header line. "Blocked" means what it means on that chip, waiting on a dependency. A task only in its lane's queue says "Queued". Moving a card between groups is not a gesture the board offers.
- Each drop is one `setActuals` stamped with the current instant, the same value the Inspector's "now" buttons write. Those buttons are the keyboard route. Into In progress means started now (from Done, reopened, and the start is kept). Into Done means finished now (from Not started, started and finished now). Into Not started clears both dates, and the card lands above or below the divider wherever `readiness()` puts it. Blocked is advice, not a lock: a blocked card can be dragged straight into In progress.
- It writes nothing else. Duration, dependencies, constraints and wording stay on the timeline and the Inspector.

The board cannot disagree with `/api/ready`. `boardColumns` in `schedule.ts` is `readiness()` sorted with no rule of its own, so an unrefined task nothing is holding sits in Blocked, marked `unrefined`, as the API reports it.

Done is a window, 7 days unless the viewer looks further back from the column header. That look-back was `doc.doneWindow`, set per plan, on the argument that a chores plan and a delivery plan want different memory. It was reversed on 2026-09-26: looking back is not an edit, and saving it meant every click rewrote the plan for everyone. It is a view setting now, back to 7 on reload.

Inside that window, Done is grouped by when (2026-09-26): Today, Yesterday, "Last Tuesday" for two to six days ago, Last week, Two weeks ago, then one divider per month. Each divider carries its count and an empty one is not drawn. A card under a named day shows only its time, and one under a week or month only its date.

## Alternatives Considered

- Per-card buttons (Start, Finish, Un-start, Reopen): this was the first version, replaced on 2026-09-26. The buttons were chosen because a drop onto Blocked or Ready had no meaning. Merging those states into one column removed that problem, and the buttons cost a row of vertical space on every card.
- Keep the board read-only, like the graph was: rejected because moving a card is the natural way to say "I started this".
- A stored status field: rejected because all four states are already derivable.

## More Information

- Superseded in part by [2026-10-04-make-sessions-the-only-record-of-work.md](2026-10-04-make-sessions-the-only-record-of-work.md), which also replaced `setActuals`.
- Rewritten 2026-11-13 from ADR 0009; alternatives reconstructed from code and history where the original did not record them.
