# Timeline Studio

A planning tool whose dates are *computed*, not entered. You describe what the work is,
how long each piece takes, and what must precede what; the scheduler answers when it
lands. Originally built for client delivery plans, now also the store for one person's
whole task list — work and life in a single document.

## Language

### The document

**Plan**:
One document holding a set of tasks, their dependencies, and everything used to schedule
them. A plan is the unit you open, share, and back up. A person's entire task list is one
plan, not one plan per area of work.
_Avoid_: Board, workspace, project (a project is something else here — see below)

**Task**:
One piece of work. May belong to a plan's projects, may have a deadline, may be owned by
someone other than you. Everything on a plan is a task; there is no separate "issue",
"ticket", or "todo" concept.
_Avoid_: Item, issue, ticket, card, todo

**Stub**:
A task that stands in for work tracked authoritatively somewhere else, carrying a link to
the real artifact rather than duplicating its detail. How work items appear in a personal
plan without dragging their context along.

### Ordering and blocking

**Dependency**:
A finish-to-start relationship: this task cannot start until that one finishes. The only
blocking mechanism in the model — there is no separate "waiting on" concept.
_Avoid_: Blocker, prerequisite, link, relation

**Owner**:
Who does a task. Defaults to you. A task owned by someone else is how "waiting on a
person" is expressed: it becomes a real task you depend on, so it appears in the graph and
blocks what it should, while consuming none of your own capacity.
_Avoid_: Assignee, responsible party

**Lane**:
A channel of execution with a capacity — how many of its tasks can be in flight at once.
For a team, a lane is a team. For one person, a single lane with capacity one, which makes
the schedule serialize into the order you can actually work in.
_Avoid_: Swimlane, track, row, resource

### Grouping

**Channel**:
A categorical attribute of a task that the plan can filter by, group by, and draw. A
channel's display name is per-plan, so the same mechanism carries different meaning in
different plans.

**Project**:
A grouping of tasks that belong to the same effort, crossing freely into and out of other
projects via dependencies. A project is *inside* a plan; it is not a plan of its own.
_Avoid_: Plan, epic, workstream, category

**Milestone**:
A named dated outcome that several tasks feed, scored by whether the work reaching it
lands in time. Reserved for genuine multi-task outcomes — a single task with a deadline
uses a due date instead.
_Avoid_: Deadline (a milestone has one, but is not one), goal, release

### Dates

**Duration**:
Whole minutes of work a task consumes, not the calendar it spans; entered and shown in
hours. With working hours set they are only spent inside them. A task with no duration
occupies no working time — the right shape for something that is done the moment it is
started, or that someone else is doing.
_Avoid_: Estimate, effort, size, points

**Working hours**:
The one window of every working day in which work is scheduled, e.g. 08:00–17:00 in the
plan's zone. Absent means the whole day. Time outside it is shaded like a day off.
_Avoid_: Awake time, office hours, shift

**Week start**:
The day a plan's weeks begin on (`weekStart`, Sunday when unset): where the calendar's week
starts and where the timeline draws its week rules. Display only; the scheduler never reads it.
_Avoid_: First day of week, locale week

**Due**:
A date a task must finish by — a ceiling imposed from outside. Distinct from the date the
scheduler predicts, and the gap between them is the useful number.
_Avoid_: Deadline, target, end date

**Not-before**:
The earliest a task may start regardless of whether its dependencies are clear — a floor,
not a fixed date. Anything else may still push it later.
_Avoid_: Start date, scheduled date

**Planned**:
The times a task is promised to happen: `planned: [{start, stop}]`, the same shape as a session but a
claim about the future where a session is a fact. The scheduler holds them (wall clock, outside working
hours too) and works the rest of the plan around them. The clock never turns a plan into work: the user
converts a stretch into a session (`completePlanned`) or deletes it, and a stretch that is over and
neither is **unconfirmed**: a past plan, asked about in Review → Past plans (ADR 0020).
_Avoid_: Slot, pinned, appointment, future session

**Session**:
One stretch of real work on a task — a start and a stop, the stop empty while it runs.
Sessions are the only place task progress is written down: a task started at its first
session's start and, once **done**, finished at its last stop. Stopping is pausing, not
finishing. A task that has a session keeps one; starting over is a new task.
_Avoid_: Actuals, actual start/end (the fields sessions replaced in v8), time entry

**Done**:
The one flag a task carries for being finished, set by finishing it and cleared by
reopening it. A done task always has a session, none of them running.
_Avoid_: Complete, closed, resolved

**Instant**:
A moment in time with its zone — how every time on a task is recorded (sessions, due,
not-before, sign-off). Which calendar day an instant belongs to is decided in the plan's
time zone.
_Avoid_: Day number (the retired pre-v6 format), timestamp without a zone

**Plan time zone**:
The one zone a plan's days are counted in, shared by everyone who views it and by the
server. "Today" and "which day did this happen" have one answer because of it.
_Avoid_: Local time, browser zone

### Derived state

**Status**:
Whether a task is not started, running, paused or done — read from its sessions and its
done flag rather than stored: done, else running (a session open), else paused (sessions,
none open), else not started. Running and paused together are "in progress". Nobody sets a
status; you start, stop, finish or reopen and the status follows.
_Avoid_: State, stage, column, phase

**Comment**:
One entry in the conversation on a task, oldest first, with who wrote it and when —
progress, findings, decisions along the way. A comment is about the task; the description
is the task. Commenting never disturbs a sign-off.
_Avoid_: Note (that is the text on a saved version in History), log entry, update

**Auto-order**:
A plan setting under which the server keeps every queue in the order the reorder search
would suggest, re-settling after each change that could move it. A manual queue order is
kept unless it makes the plan worse.
_Avoid_: Auto-sort, optimise (it is a search for single improving moves, not a proof of
the best order)

**Ready**:
A task not yet started that nothing is holding back — no unfinished dependency, no
not-before date, no full lane. The answer to "what can I pick up right now".
_Avoid_: Available, actionable, unblocked

**Waiting**:
A task not yet started that something *is* holding back, together with which thing it is.
The complement of ready.
_Avoid_: Blocked, stuck, pending

**Dropped**:
A task deliberately abandoned. The one piece of task progress that cannot be derived,
because "decided not to" and "never got to" look identical in the dates.
_Avoid_: Cancelled, archived, deleted, won't-do

**Verdict**:
What a plan lands on once scheduled — when each milestone is reached and whether that is
in time. The plan's answer, as opposed to its contents.
