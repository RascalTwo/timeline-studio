# The kanban lens can write dates

> **Partly superseded by ADR 0016 (2026-10-04).** The drops no longer write `setActuals`: each is a session event
> (start, stop, finish, reopen), In progress is two groups, and nothing goes back to Not started.

ADR 0007 let the graph write dependencies and kept one line: it "still cannot move
a date", because position on the graph is not time. The kanban lens crosses that
line on purpose, and this says why it is not the same mistake.

Its states are Blocked, Ready, In progress and Done, and all four are derived
— from `readiness()` for the first two, from `actualStart`/`actualEnd` for the
last two. There is no stored status and this does not add one. So "move this
card to In progress" can only mean one thing: *I started this today*. A column
here is a statement about the two actual dates, which a node's position on the
graph never was.

## What it writes, and how

Drag, into three columns: Not started, In progress, Done. Those are the three
states the two actual dates can express, so they are the three places a card can
be put. Why a task has not started is the scheduler's opinion, so every
not-started task shares one column, grouped under the Ready filter's own chips —
in nearest-to-startable order — Ready now, Needs refining, Queued, Not before,
Blocked — with the counts on its header line. "Blocked" means what it means on that chip, waiting on a dependency; a
task that is only in its lane's queue says "Queued". Moving a card between groups
is not a gesture the board offers.

Each drop is one `setActuals` stamped with the current instant — the same value
the Inspector's "now" buttons write, and those buttons are the keyboard route to
it. Into In progress means *started now* (or, from Done, *reopened*: the start
is kept). Into Done means *finished now* (from Not started, started and finished
now). Into Not started clears both dates, and the card lands above or below the
divider wherever `readiness()` puts it. Blocked is advice, not a lock: a blocked
card can be dragged straight into In progress.

This replaced per-card buttons (Start, Finish, Un-start, Reopen) on 2026-09-26.
The buttons were chosen because a drop onto Blocked or Ready had no meaning;
merging those into one column removed that problem, and the buttons cost a row
of vertical space on every card.

It writes nothing else. Duration, dependencies, constraints and wording stay on
the timeline and the Inspector.

## What did not change

The board cannot disagree with `/api/ready`. `boardColumns` in `schedule.ts` is
`readiness()` sorted, with no rule of its own — so an unrefined task nothing is
holding sits in Blocked, marked `unrefined`, exactly as the API reports it.

Done is a window, 7 days unless the viewer looks further back from the column header.
That look-back was `doc.doneWindow`, set per plan, on the argument that a chores plan
and a delivery plan want different memory — reversed on 2026-09-26: looking back is not
an edit, and saving it meant every click rewrote the plan for everyone. It is a view
setting now, back to 7 on reload.

Inside that window, Done is grouped by when (2026-09-26): Today, Yesterday, "Last
Tuesday" for two to six days ago, Last week, Two weeks ago, then one divider per month.
Each divider carries its count and an empty one is not drawn; a card under a named day
shows only its time, one under a week or month only its date.
