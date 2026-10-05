# Driving Timeline Studio as an agent

**Do not drive the UI.** There is no gesture here you cannot perform better by sending a
command. Dragging a bar's grip *is* `setDuration`; linking a dependency *is* `addDep`;
reordering a row *is* `moveTaskInLane`. The chart is a lens over a document, and every
number on screen is derived from it — so an agent that clicks is doing the same work
through a worse interface, with pixel coordinates and a scroll position in the way.

`README.md` in the original tool is the design rationale — why arrow dashes mean distance,
why undo was removed. **This file is the reference for a program changing a plan.**

**The mechanical facts now live in [`/api/openapi.json`](/api/openapi.json)** — paths,
methods, headers, request bodies, response shapes, and the command enum — with
[`/api/docs`](/api/docs) rendering it. A test pins that document to the routes the server
actually registers and to the vocabulary `commands.js` actually accepts, so it cannot
quietly go stale the way a prose list does. What stays HERE is the half a schema cannot
carry: why you would call a thing, what to check after you write, and the four plan
conventions that are not expressible as types.

## The service parks itself, and `/api/*` will not wake it

**Before your first API call, `POST /wake` and wait for the task to come up** — on a
DEPLOYED instance. `/wake` is a CloudFront behaviour in front of a Lambda, not a route on
the server, so a local or self-hosted instance does not have one and answers `404`. That
is correct and means the opposite of trouble: nothing there parks itself, so there is
nothing to wake. Skip this section and go straight to `GET /api/plan`.

```bash
curl -sX POST "$BASE/wake"      # -> {"status":"starting","desired":1,"running":0}
# poll until an /api/ call returns 200; a cold start is 30-90s
```

The sync server scales itself to zero after 60 idle minutes and a wake Lambda
scales it back. The wake is reached at the **relative path `/wake`**, routed by a
CloudFront behaviour — it is not an API route and **nothing under `/api/` triggers
it**. The browser page calls it on load, which is why the tool appears to have no
cold-start problem when you use it as a human and every appearance of one when you
use it as an agent.

So a scaled-to-zero service answers `/api/anything` with an **ALB `503` in under
200ms, forever**. That is not an outage and there is nothing to fix:

| What you see | What it means |
|---|---|
| `503`, instantly, on every `/api/*` while `/schedule.js` still serves | Parked at zero. You did not call `/wake`. Static assets come from CloudFront and are always up, which is what makes this misleading. |
| `504`, then success on a retry | Already waking. Keep retrying. |
| `404 no such plan` | The token is wrong. Not a scaling problem — see below. |

This has cost real time at least once: an agent read the instant `503`s as a
crashed server, pulled AWS credentials, and went through ECS events, task logs and
target-group health before finding the removed deploy template's note that the page — not
the API — is what wakes anything. The container logs said `SIGTERM` and nothing
else, because nothing had gone wrong.

If you genuinely need to know whether it is running rather than guessing from
status codes, the service's own health endpoint is the check you can make from here.

## Authentication is a link, and the link is the whole story

Every request carries:

| header | |
|---|---|
| `x-timeline-token` | **the capability.** 22 chars of base64url. It identifies the plan *and* authorises the call — there is nothing else |
| `x-timeline-by` | display name for attribution. Nothing verifies it; it is a label on your saves, not a claim. Set it to something a human will recognise in the History panel |

**The token names the plan.** There is no `id` parameter on any endpoint, and there is no
plan-listing endpoint. Both absences are deliberate. If you find yourself
wanting to enumerate plans, you are holding the wrong idea — one token reaches one plan.

A bad token returns **404 `no such plan`**, never 401 or 403. An unknown token and a
nonexistent plan are indistinguishable on purpose, so the error cannot be used to confirm
which tokens are real. Do not build logic that distinguishes them; there is no signal there.

**`POST /api/plan/new` is the one call with no token**, because it is where a token comes
from. It returns `{id, shareToken}`, and that response is the only time you will see that
token — nothing lists plans, so an agent that drops it has made a plan nobody can reach.
Post `{title}` for a blank plan, or `{doc, note}` to fork or import one; the same route
serves all three, and the *server* derives the id and tells you which one it used. Do not
try to choose an id or probe whether one is free.

**Never put the token in a URL, a log line, or a commit message.** It is the only thing
standing between a client's real delivery schedule and the open internet.

## Read this before writing anything

- **A task needs an `id`, a label and a `dur`.** Nothing else.
  `{"type":"addTask","task":{"id":"renew-passport","label":"Renew passport","dur":240}}` is
  a whole command. The channel fields — lane, border, fill, shape — are filled from the
  plan's own `defaults`, falling back to the first value of each list, so you do not have
  to read the document to write to it. Send a field and your value is kept; omit it and the
  plan answers. A key that is not a `Task` field (`description` for `desc`, say) is refused. `color: []` means "no project" and is left alone, because absent and empty
  are different claims.

  **`dur` is the one the plan will NOT answer for you.** It is **whole MINUTES** (schema
  v7, 2026-09-26 — it was a float of days before): 15 is fifteen minutes, 60 an hour. They
  are minutes of WORK: if the plan has `workHours` (e.g. `["08:00", "17:00"]`) they are only
  spent inside that window, so 540 is one full working day there, not 1440. Its full rules,
  and what every date field means, are on
  `Task` in [`/api/openapi.json`](/api/openapi.json). They are stated there once and a test
  holds them to the code, so they are not repeated here.
- **There is no "I do not know" value for `dur`.** If you genuinely do not know, write your
  best number and say what it rests on in `desc`. A small honest guess that a human can see
  and correct beats a zero that would silently vanish from the schedule.
- **A DURATION IS A CLAIM. DO NOT FILL IT IN CASUALLY.** Every date this tool computes is
  derived from the durations you write, so an invented number is not a harmless placeholder
  — it silently moves finish dates, milestone verdicts and the queue order the scheduler
  breaks ties by. A plan full of round guesses looks exactly like a plan full of knowledge,
  which is the failure this warning exists for.

  Before writing a `dur`, in this order:

  1. **Use the number the human gave you.** If they said "straightforward and simple", that
     is an estimate — do not write 1.5 days over the top of it. If they gave a range, take
     it; a range recorded honestly beats a midpoint invented confidently.
  2. **Use a number from something that read the code.** A report from whoever actually
     opened the repo beats your impression of the task title.
  3. **Look before you guess.** If you are about to estimate work in a codebase you can
     read, read it first. This warning was added after an agent estimated a change at 1.5
     days from its own one-line summary, then implemented it in under twenty minutes once
     it opened the file — the model already supported the feature and the summary had
     made it sound structural.
  4. **If you genuinely cannot know, say so in the task's `desc` rather than dressing the
     guess up as an estimate.** "Waiting on someone else's IT process, wait unknown" is
     information. `dur: 2400` on its own is not.

  When a task finishes, the `dur` you wrote stays in the plan and the bar becomes what it
  actually took, so the gap between them is visible on the chart. That is deliberate. Read
  it occasionally — it is the only feedback an estimator ever gets.

  **If the human has told you how they want durations handled, that instruction outranks
  every rule above.**
- **Work somebody ELSE does is their task, not a new concept.** There is no
  waiting-on field and there does not need to be: give their work its own task, put
  their name in the title, set `noQueue: true`, and depend on it. `noQueue` is what
  keeps their days out of the plan's capacity — a lane rations working time, and
  somebody else's week is not a week of yours. Two things fall out of doing it this way
  rather than inventing a field: their work is a node on the graph like anything else,
  and there is exactly one blocking mechanism to reason about instead of two.
- **Work that comes round on a calendar is `setRecur`, not a pile of hand-made copies.** Give a task a `notBefore`
  (the first occurrence; a task with only a `due` repeats on that) and `{"type":"setRecur","id":"...","recur":{"n":1,"unit":"month"}}`: it repeats every `n`
  days, weeks or months counted from that anchor, in the plan's zone. Each copy is an ordinary new task that keeps
  the sign-off; `ahead` (default 1) copies wait beyond the open one, and **finishing a copy adds the next** — nothing
  is created by the clock, so a copy nobody finishes just stays overdue. `recur: null` ends the series. The label
  does not carry the period.
- **A task that happens at a fixed time is planned, not a `notBefore` and hope.** `setPlanned` replaces the task's `planned`
  list: `[{start, stop}]`, the times it is promised to happen, in the same shape as `sessions` (which are what happened). The
  scheduler holds those times in wall-clock time (outside working hours is fine), works everything else around them, and
  does not queue the task. A planned task ignores what it waits on (the slack chip shows a dependency that finishes after
  it starts). A plan is a claim and the clock never turns it into work: `completePlanned` (`index`, optional corrected
  `start`/`stop`) says that stretch happened and moves it into `sessions`; `setPlanned` with it left out cancels it; finishing
  a never-started task records the stretches already under way as its sessions and drops the rest. A stretch that is over and
  neither is shown as missed, and a plan that lapsed unstarted is ordinary work again. Repeating tasks do not carry `planned` to
  their copies.
- **Work tracked somewhere else gets a stub, not a copy.** One task, one line, and `url`
  pointing at the real artifact — the issue, the pull request, the ticket. The system of
  record keeps the detail; this plan only needs to know the work exists and what it
  blocks. Mirroring the detail in here means two descriptions of one thing, and the one
  that drifts is always this one, because nobody closes a task twice.
- **You send commands, not documents.** The vocabulary is
  [`commands.js`](/commands.js) — **served live at `/commands.js`**, so you
  can read it without this repo. It is as code, imported by both the browser and
  the server, so it cannot drift from either. Read it there. Copying it into prose would
  create a second copy, and a second copy is the thing that rots.
- **A batch commits atomically.** `POST /api/commands` takes `{cmd}` or `{cmds: [...]}`.
  If any command in a batch fails, the whole batch is discarded. That is what "add a lane,
  then move tasks onto it" needs.
- **Saving and changing are different acts.** Commands change the live shared draft
  immediately, for everyone looking at it, and the server has already persisted them —
  nothing is stranded in a tab. `POST /api/save` is what turns the current draft into an
  archived version. **Pass a note** — it is the only description a human gets of what you
  did.
- **Until you save, your edits read to everyone as "unsaved changes", attributed to your
  `x-timeline-by`.** That state belongs to the room, not to any browser, so a human who
  never saw you work can hit Revert and discard it. If your change matters, save it.
- **Old versions are read-only.** You can read one (`/api/history`, `/api/version`) and
  compare it. There is no endpoint that loads one in place — that would time-machine
  everyone in the room. Only the note on an entry is mutable (`/api/histnote`); the
  snapshot is frozen.
- **`POST /api/revert` is the one history operation that changes the room.** It discards
  the live draft for *everyone* and puts version `n` in its place, announcing it to whoever
  is present. The discarded draft is archived first, so reverting again undoes it. In the UI
  this is the "discard unsaved changes" button and it always targets the newest save;
  the endpoint will take any `n`, which makes it a deliberate act and not a cleanup step.

## Every endpoint

**[`/api/openapi.json`](/api/openapi.json) is the endpoint list** — its paths are read from
the server's own route table, so it cannot miss one. A hand-kept table here did, twice.
**Start with `GET /api/plan`**; do not use `POST /api/save` as a read.

Anything else under `/api/` answers `404` with JSON, so probing there is reliable. Paths
OUTSIDE `/api/` are not: an unknown one falls through to the single-page app and answers
`200 text/html`, which looks like a route that exists. `/wake` is the exception worth
knowing — see above.

## What can I start right now

`GET /api/ready` answers it per task, so you do not have to run the scheduler yourself:

```json
{ "id": "send-invitations", "status": "todo", "ready": false,
  "waitingOn": "deps", "blockedBy": ["book-venue"],
  "starts": "2026-09-20T13:00:00.000Z", "ends": "2026-09-20T15:00:00.000Z",
  "due": "2026-10-09T22:00:00.000Z", "slackDays": 19 }
```

By default only not-started (`todo`) tasks come back, best `rank` first — the queue, not
the plan; a blocked one is still there with its `waitingOn`. `?all=1` returns every task
with its `status` — `todo`, `running` (a session open), `paused` (worked on, none open) or
`done` — and there `ready` is `null` for work already started or finished —
"can I pick this up" is not a question about work underway, and `false` would read as
blocked.

**Ready is measured against NOW**, in the plan's time zone: a task whose scheduled start
has already come is ready, whatever decided that start. On a one-lane plan that is the
head of the queue once the lane is free — one task, because a lane runs one thing at a
time. Finished work frees its lane at its recorded finish (never later than now), and
`noQueue` work never holds a lane, in progress or not.

`ready` also requires the task to be REFINED — see below. A task nothing in the schedule
is holding, that nobody has read and agreed with, answers `false` with
`waitingOn: "unrefined"`. That is deliberate: "what should I pick up" should not hand you
work whose description has never been checked.

`waitingOn` is the scheduler's own word for what decided the start: `deps`, `notBefore`,
`lane`, or `unrefined` when the schedule is clear and the sign-off is the only thing
left. A scheduling reason outranks an unread task — a blocked task that is also unrefined
reports the blocker, because that is what has to move first.
**`lane` with an empty `blockedBy` means resource-blocked, not
dependency-blocked** — nothing is in its way except that its lane is a serial queue and
something else is in it.

**`deps` with an empty `blockedBy` is not a contradiction.** Every dependency is
recorded as finished, but one of them finishes after now — a recorded finish in the
future — and this cannot start before it. `starts` says when.

`slackDays` is positive for time to spare and negative for late, against `due`, in days to
two decimals — `-0.04` is an hour late.

## The document

**`GET /api/plan` returns the whole live document.** This is the first call to make and
the one everything else is checked against:

```bash
curl -s "$BASE/api/plan" -H "x-timeline-token: $TOKEN"
# -> { "id", "seq", "epoch", "viewers", "doc": { … } }
```

`doc` is the plan. `seq` is the command sequence number the server has reached, and
`viewers` is how many people have it open — worth reading before you start moving work
around in front of someone.

**Every time on a task is an ISO instant with a zone** — `notBefore`, `due`,
`refinedAt`, each session's `start` and `stop`, like `createdAt` and `updatedAt`. Send
`2026-09-26T08:16:00Z` or any offset (`2026-09-26T03:16:00-05:00`); it is stored as UTC. A
time without a zone is refused, and so is a number: **these were day numbers until schema
v6 (2026-09-26)**, and anything still sending them gets an error that says so.

`doc.timeZone` (an IANA name, `America/Chicago`) decides which calendar day an instant
falls on — for "today", for the chart, for `/api/ready`. `doc.start`, milestone dates and holidays stay plain
`YYYY-MM-DD` dates: they are whole days by nature.

### Work sessions — `startTask`, `stopTask`, `finishTask`, `reopenTask`, `setSessions`

**Sessions are the only record of work** (schema v8). A task carries `sessions: [{start,
stop}]` (`stop: null` while running) and, once finished, `done: true`. **Start and stop
tasks as you work on them**; that is also how you claim one. **Finish with `finishTask`**:
it stops the running session, and a task never started gets a session of no length at that
moment, so every finished task has one. It started at its first session's start and
finished at its last stop. `reopenTask` clears `done` and keeps the sessions (the task is
paused). None of these take a time of their own — the moment is the command's `at`, which
the server fills. To correct a time, send `setSessions` with the whole list (in order, no
overlaps, only the last may still run, none running on a finished task). **There is no way
back to not started**: a task with sessions keeps at least one, so to start over, split it
into a new task. Status is derived — done, else running, else paused, else not started — and none
of this clears `refinedAt`. Worked time is wall clock, and the forecast for an unfinished
task is its estimate minus that, never under a minute: from now while it runs, and from its
turn in its lane while paused, so paused work does not pile up at now beside what is running.

### `refinedAt` — has a human read this and agreed with it

A task carries `refinedAt` when somebody has read its **title, description and duration**
and signed off on them. Absent means nobody has, which is how every task is born.

**The applier clears it by itself.** `renameTask`, `setTaskDesc` and `setDuration` each
void the sign-off when they actually change the value — so there is no way to change what
a task says and leave it looking approved. That is the whole point of the field, and it
applies to your edits as much as to a human's: rewrite a description and the task goes
back to unrefined, which is correct and is not something to work around.

Set it with `{"type":"setRefined","id":"…","refinedAt": "<ISO instant>"}`, or `null` to
withdraw. **Do not refine a task on a human's behalf** unless they have asked you to —
the field means "a person read this", and an agent setting it on its own output is the
exact thing it exists to prevent.

`doc.dueBuffer` (days, optional) is how much margin this plan wants before a deadline. It
is read only by the reorder search and by the Risk reading; it changes no date.

The Kanban view's Done column shows the last 7 days of finished work; how far back
is each viewer's own choice and is not saved on the plan (it was `doc.doneWindow`
until 2026-09-26 — that key is no longer patchable). The Kanban
columns are `/api/ready` sorted — Blocked is everything not ready, including
`waitingOn: "unrefined"` — so reading the board and reading `/api/ready` agree. In
progress is two groups, Running now and Paused, and a drop is the command it means:
into Running starts, into Paused stops, into Done finishes, out of Done reopens.

Work decided against is removed with `removeTask`; the version history is the record.

**Round-trip a task whole.** A task keeps keys this protocol does not know, and a program
that rebuilds one from the fields it cares about deletes someone's `desc`, `url`, `ref` or
`createdAt`.

**You do not set `createdAt` or `updatedAt`. You set `at`.** Any command may carry `at`, an
ISO instant saying when you issued it, and the server fills it in on `POST /api/commands`
if you leave it out. The applier never reads a clock: it runs in the page, the server and
every client on the same command, and a timestamp taken inside it would differ in every
copy.

**A task may carry a `ref`** — its id in whatever tracker the team works in. Nothing here
knows or cares which one: an issue number, a row id in something homegrown, anything — they
are all just strings. Set and cleared with `setTaskRef` (`null` clears; the value is
trimmed).

Worked example, with a tracker nobody can read anything into: `ref` is `1234`, the viewer's
base is `https://github.com/octocat/hello-world/issues/{ref}`, and the page opens
`https://github.com/octocat/hello-world/issues/1234`. The plan holds `1234` and nothing
else — which repository, and which host, are the viewer's half. It is validated for SHAPE only — non-blank, under 200 characters, no newlines —
and deliberately not as a URL, because it is only half of one. **The other half, the base
URL, is not on the document and cannot be put there**: it is not in `PATCHABLE_DOC_KEYS`,
so `patchDoc` refuses it. It lives per plan in each viewer's browser, and the page
interpolates the ref into it with `encodeURIComponent`. That split is the point — a plan
carrying 135 refs still does not say whose tracker they belong to.

**A task may also carry a `url`** — one link to the page that task is really about: the
ticket, the runbook, the design doc. It is optional, nothing has one by default, and it is
set and cleared with `setTaskUrl` (`null` clears, exactly like `setTaskDesc`). It is the one
string field with a value rule: **`http:` or `https:` only**, refused at the command and
skipped by the renderer, because a `url` becomes an `href` in the browser of everyone
holding the plan's link. Round-trip it with the rest of the task or you delete it.

And **a lane may carry a `short` string** — what that team is called when it has to fit in a
row label rather than a heading. It is optional and falls back to `label`, so a plan without
one is unchanged; it is only ever read by the `Rows: Date` view, where the rows are flat and
the team is a chip instead of a header. Nothing validates it, and nothing else reads it.

Everything the scheduler computes — start dates, end dates, finish dates, slack, whether a
milestone is met, bar positions — is **not** in the document. Do not add it and do not
trust any you find. Ask `/api/verdict`.

A channel value is not free text. `border: "prod"` is a pointer into `doc.borders`, not the
word "prod". To use a value that does not exist yet, add it to the channel list first.

## Comments

A task carries **`comments`**, oldest first — the conversation on it, like comments on a
GitHub issue: progress, findings, "waiting on Leah", what an agent did. The **description
is what the task IS**; a comment is what happened to it. That difference is the point:
editing `desc` clears the task's sign-off (`refinedAt`), **a comment never does**, and
never moves `updatedAt` either.

**So log progress as a comment, not by appending a dated paragraph to `desc`.** Only
`text` is required; the server fills the id, the time and `by` (from `x-timeline-by`):

```json
{"type":"addComment","id":"task-id","comment":{"text":"Supplier confirmed **Tuesday**."}}
{"type":"editComment","id":"task-id","commentId":"c-1a2b3c4d","text":"…"}
{"type":"removeComment","id":"task-id","commentId":"c-1a2b3c4d"}
```

Text is Markdown. An edited comment keeps its `at` and gains `editedAt`.

## Auto-order, and `settle=1`

A plan with **`doc.autoOrder: true`** keeps its own queues in order: after any change that
could move one — durations, dependencies, actuals, constraints, deadlines, adding or
removing tasks, lanes — the server runs the `/api/reorder` search in the background and
applies the moves itself as `moveTaskInLane` commands attributed to **"Auto-order"**,
until no single move helps. Renames and descriptions trigger nothing. Switch it with
`{"type":"patchDoc","patch":{"autoOrder":true}}`.

**Settling follows your change; it does not block it.** So on an Auto-order plan the
document you read right after a write may be about to change. **Add `?settle=1` to any
call** — `POST /api/commands?settle=1` returns only once Auto-order has finished with your
change (its `seq` then counts the moves; a write that cannot move the queue returns at once),
and a read with `settle=1` waits out any settle in progress first. It costs seconds on a large plan; that is the price of reading a plan
that will not move under you. It is harmless when Auto-order is off.

`moveTaskInLane` still works on an Auto-order plan: the order you set stands unless it
makes the plan worse, in which case the settle that follows re-orders it.

## The ranking — "what should happen first?"

A plan can carry one ranking of its unfinished work, built by asking a person about two
tasks at a time (the **Review → Rank** tab in the page). The document stores only the
answers, as `doc.rankLog`; the order is derived from them by
[`@rascaltwo/pairwise-sorter`](https://github.com/RascalTwo/pairwise-sorter), vendored
as `/pairwise.js`, so the page and the server cannot disagree about it.

**Never answer ranking questions on the user's behalf.** The ranking is worth something
only because it is their judgement — an agent that fills it in has replaced their
priorities with a guess and labelled it theirs. Read it; do not write it unless they have
told you, in so many words, which of two tasks comes first.

**What you may do instead is suggest.** `setRankSuggestion` hands over a whole proposed order
in one command and writes nothing to `rankLog`. That is the agent path: *a suggestion, never an
answer.* A suggestion is a **backdrop**: it orders whatever the person has not answered, and
their answers win wherever the two meet. It is never turned into their answers and there is no
command to discard it — a newer suggestion simply replaces it. Send the tasks first-to-happen
first and give each a one-line `why` that is about THAT task (required): the person sees it
under the task while they answer pairs, so a sentence shared across a group of tasks misleads.
`toss: true` marks a placement that is close to a coin flip; it is stored but the page does
not show it. The page shows the suggestion's place and reason under each card of the pair
being answered (the side it ranks higher in a distinct box) and beside a task's rank in the
Inspector, and its Rank tab has a box to paste a suggested order too.

```json
{"type":"setRankSuggestion","order":[{"id":"task-a","why":"unblocks task-c"},{"id":"task-b","why":"quick","toss":true}]}
```

**A suggestion steers Auto-order and `/api/reorder`**, as a weaker key under the
person's own ranking: dates first, then paused work before unstarted work, then their ranking,
then the suggestion — and only on pairs
they have not settled (a pair they called equal is settled too). Its moves come back with
`suggested: true`. The plan's `useRankSuggestion: false` (patchable; the Rank tab has the same switch) turns that off.

The suggestion is `doc.rankSuggestion` (`by`, `at`, `order`, and a reason per task in `notes`).
One slot. Tasks you leave out have no suggested place; finishing or removing a task takes it
out of it; a dependency that contradicts your order wins when it is read, exactly as it does for
the person's own answers. Each `/api/ready` row carries `suggestedRank` beside `rank` (null when
no suggestion covers the task); the two are never mixed.

```json
{"type":"addRankAnswer","a":"task-a","b":"task-b","verdict":-1}
{"type":"removeRankAnswer","a":"task-a","b":"task-b"}
{"type":"resetRanking"}
```

`verdict` is `-1` (a first), `1` (b first) or `0` (equal). Answering a pair again replaces
the earlier answer. Finished tasks cannot be ranked.

- **Where it shows up:** each `/api/ready` row carries `rank` — 1 is first, ties share a
  number, `null` for a task nobody has ranked yet.
- **What it changes:** it is a tie-break for Auto-order and `/api/reorder`. **Dates always
  win**: a ranking move is only suggested when it makes no date worse and eats into no
  deadline buffer. Such a suggestion has `gain: 0` and `ranked`, the number of ranked
  pairs it puts in the order asked for. With Auto-order on, an answer re-settles the
  queue. **Paused work goes first** (ADR 0019): between dates and the ranking, Auto-order puts
  paused tasks ahead of unstarted ones (`paused: true` on the move), and no ranking move undoes it.
- **Finishing or removing a task** takes it out of the ranking without re-asking anything:
  its answers go, and the pairs the old order settled are filled in as *implied* answers
  (`[pairKey, verdict, true]` in `rankLog`).
- **Dependencies answer their own pairs.** When one task waits on the other, directly or
  through a chain, the ranking never asks: that pair is worked out on every read (it shows
  as implied) and is never stored, so it follows the dependencies as they change. A
  dependency outranks a stored answer that contradicts it.
- **Queue order is not ranking order.** Moving a row changes neither the answers nor the
  ranking derived from them.

## Reading the schedule back

A command being accepted proves it was structurally sound, never that it says what you
meant. **Ask what it costs.**

- **`/api/verdict`** — what the plan lands on. Milestones, whether each is met, and by how
  many days it is missed. Accepts a document you have not sent, so you can price an edit
  before committing to it.
- **`/api/reorder`** — which row to move. **It answers from a worker thread**, so a
  long search no longer blocks everything else this server is doing; it is still
  by far the most expensive call here — ~4s on a 240-task plan — so give it time
  rather than retrying. The page asks for it **once on load** and then marks its
  own answer out of date when the plan changes, rather than re-asking after every
  edit; if you are driving a plan through a run of commands, the advice you last
  fetched is the advice you have until you fetch it again. Queue order is a scheduling input that leaves no
  trace in the document and no arrow on the chart, so a plan can be weeks wrong with every
  duration and dependency correct. It suggests; it never applies. Apply one move, then ask
  again — each suggestion is measured against the current order, so applying one
  invalidates the rest.

Both run **the same scheduler the chart runs** — the file served at `/schedule.js`, imported by the
server and loaded by the page — so the endpoint cannot tell you something the room is not
being told. A deploy-time check proves the two copies are byte-identical, so this is a
guarantee rather than a hope.

## Watching a plan change over time

`POST /api/save` archives a version; `/api/history` returns every one of them with
its full document inline. The page turns that into **playback**: History → Play
puts each saved document on the chart in turn, through the same renderer, so the
bars are the ones this tool would have drawn that day.

It is worth knowing about for two reasons. It is the fastest way to show a human
what a run of your commands did across several saves — better than describing it,
and better than Compare when more than two versions are involved. And it is the
one part of the UI that **takes the tab out of the room**: it closes the socket
while it plays and rejoins on exit, because the renderer reads a global `doc` and
an inbound command landing on an archived document would write yesterday's numbers
into today's plan. Nothing you do through the API interacts with it, but do not be
surprised to see `viewers` drop while somebody is watching one.

## Verifying your change

Open the plan and read the chart. The milestone chips carry the verdict (`misses by 16
days`), and History → Compare against the version before your edit paints where every bar
used to be. That comparison is the fastest way to show a human exactly what you changed.

---

Changing the TOOL rather than a plan is a different job with a different audience, and it
lives in this repository's own `AGENTS.md`. Nothing about it is served here: this file
reaches anyone holding a share link, and build commands and repository paths are no use
to them.
