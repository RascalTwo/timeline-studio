# Driving Timeline Studio as an agent

**Do not drive the UI.** There is no gesture here you cannot perform better by editing
the document. Dragging a bar's grip *is* setting `dur`; linking a dependency *is* pushing
an id into `deps`; reordering a row *is* moving an element in `tasks`. The chart is a
lens over a JSON document, and every number on screen is derived from it — so an agent
that clicks is doing the same work through a worse interface, with pixel coordinates and
a scroll position in the way.

`README.md` is the design rationale — why the arrow dashes mean distance, why undo was
removed. It is written for a human deciding how to change the tool. **This file is the
reference for a program changing a plan.**

## Read this before writing anything

- **Durations are DAYS.** `dur: 10` is ten days, not two weeks. The base unit changed at
  schema 4 and half the prose in `README.md` still discusses plans in weeks because
  humans do.
- **Every save is archived.** `/save` snapshots the whole document into the plan's
  history, so an agent write is recoverable — but it also means a careless loop makes a
  version per iteration. Batch your edits into one save.
- **Pass a `note`.** It is the only description the human gets of what you did, and it is
  the field they read in the History panel. `"added QA deploy for eAdvantage"` beats an
  empty string every time.
- **The human's open tab is a second writer.** The browser holds unsaved edits in memory
  and writes the whole document on Save. If a tab is open on the plan you are editing,
  whoever saves last wins and the other's work is gone silently — the page will not even
  reload, because `data/` is a symlink outside the directory the dev server watches. If
  the plan might be open, say so and ask before writing.

## Where the plans are

`TIMELINE_DATA_DIR` if set, otherwise `./data` — which is gitignored and on this machine
a symlink to a directory outside the repo, because the plans are a client's real delivery
schedule. **Never copy plan contents into the repo, a commit message, or anywhere public.**

## The HTTP surface

Base URL is the page's own URL. Everything is JSON.

| | |
|---|---|
| `GET api/list` | `{models: [{id, title, tasks, order}]}`, sorted by `order` then id |
| `GET api/load?id=<id>` | the document |
| `POST api/save` | `{id, doc, note}` → `{ok, id, tasks, snapshot}`. Writes the file **and** archives a version. `snapshot:false` means the document was byte-identical to the newest version, so no version was added |
| `GET api/history?id=<id>` | `{versions: [{n, at, approx, note, doc}]}`, oldest first. Every version carries its whole document |
| `POST api/histnote` | `{id, n, note}` — rewrite one version's note. The only mutable part of an archived version |
| `POST api/histput` | `{id, versions}` — replace a plan's entire archive. For import only; `/save` appends |
| `GET api/reorder?id=<id>` | **which row to move, and which team goes on top.** `{base, suggestions: [{lane, id, label, from, to, after, gain, gains, worsens}], skipped}` — the best single move for each task that has one, sorted by the biggest improvement in days. `gains` is per-milestone plus `finish`; `worsens: true` means it buys one date by costing another. Optional `limit` (20) and `maxLane` (40). Also returns `lanes: {order, backward, total, was, changed}` — the lane order that puts each team above the teams waiting on it, minimising the weight of dependencies forced to point up. Cycles across lanes are normal, so a floor above zero is the right answer, not a failure |
| `POST api/reorder` | `{doc}` — the same answer for a document you have **not** saved |
| `GET api/verdict?id=<id>` | **what the plan lands on.** `{tasks, start, finish, milestones: [{id, label, date, tasks, waitsOn, finish, met, byDays}]}` |
| `POST api/verdict` | `{doc}` — the same answer for a document you have **not saved**, so you can price an edit before committing it |
| `POST api/delete` | `{id}` — removes the plan **and its archive**. Refuses the last remaining plan |

Ids match `/^[a-z0-9][a-z0-9-]{0,63}$/i` and become filenames, so a bad one is rejected
rather than sanitised.

`/save` **validates** and returns `400` with a specific reason. It rejects a wrong
`schemaVersion`, duplicate or missing task ids, a non-positive `dur`, a `color` that is
not an array, any channel value or milestone not present in its list, a dependency on a
task that does not exist, and self-dependency. It does **not** check for dependency
cycles — the scheduler refuses those loudly when the plan is opened.

## The document

```jsonc
{
  "schemaVersion": 4,          // REQUIRED, and must be 4. See "Schema" below.
  "title": "eAdvantage Member API",
  "order": 0,                  // picker position; lower first, 99 is "at the end"
  "start": "2026-08-17",       // the chart's origin. Every day-number field counts from here.
  "sprint": { "weeks": 3, "start": "2026-08-12" },

  // ---- CHANNELS. Each is a list of values; a task points at ids in them. ----
  "lanes":   [{ "id": "SRV", "label": "Server builds", "cap": 2, "short": "SRV" }],
  "colors":  [{ "id": "rates", "label": "Rates API", "color": "#5aa9f0" }],
  "borders": [{ "id": "prod", "label": "prod", "style": "solid" }],
  "fills":   [{ "id": "known", "label": "known", "pattern": "solid" }],
  "shapes":  [{ "id": "s1", "label": "none", "shape": "soft" }],

  "milestones": [{ "id": "cab", "label": "Final Cab", "date": "2026-11-18" }],

  // ---- OPTIONAL ----
  "channelLabels": { "lanes": "Team", "colors": "Application",
                     "borders": "Environment", "fills": "Accuracy" },
  "defaults":  { "borders": "b1", "shapes": "s1", "fills": "guess" },
  "workweek":  [0,1,1,1,1,1,0],        // Sun..Sat, 1 = a working day. Absent = all seven.
  "holidays":  ["2026-09-07"],         // ISO dates, non-working
  "arrows":    { },                     // per-relationship line overrides

  "tasks": [ /* below */ ]
}
```

### A task

```jsonc
{
  "id":     "d-rates",          // unique in this plan; referenced by other tasks' deps
  "label":  "Create Rates API Service",
  "lane":   "SRV",              // REQUIRED, must be a lanes[].id
  "border": "prod",             // REQUIRED, must be a borders[].id
  "fill":   "known",            // REQUIRED, must be a fills[].id
  "shape":  "s1",               // REQUIRED, must be a shapes[].id
  "color":  ["rates"],          // REQUIRED ARRAY of colors[].id. [] is legal ("no system").
                                //   Two entries splits the bar — a shared server really is both.
  "dur":    10,                 // REQUIRED, DAYS, > 0
  "deps":   ["p-db-dev-srv"],   // task ids this waits on. [] is normal.
  "ms":     "ms1",              // optional; a milestones[].id

  // ---- OPTIONAL, all day-numbers counting from doc.start ----
  "notBefore":   28,            // "cannot begin before then". A constraint, not a position.
  "actualStart": 14,            // it really started here — pins it, overriding the forecast
  "actualEnd":   35             // it really finished here. Both present = done.
}
```

**An unstarted task is never scheduled before today.** `sched()` floors every forecast at
the current date, so a plan whose `start` has passed does not keep drawing its rootless
tasks on day 0 as though they had been under way since. Recording an `actualStart` is what
lets a bar sit to the left of the today line — the floor applies to guesses, never to
facts, and an in-progress task keeps both its pinned start and its overtaken estimate. So
if you write a plan and a task looks later than you expect, check the date before you
reach for `notBefore`: `/verdict` applies the same floor the chart does.

**A channel value is not free text.** `border: "prod"` is a pointer into `doc.borders`,
not the word "prod". To use a value that does not exist yet, add it to the channel list
first, then point tasks at it — `/save` rejects a dangling reference rather than
inventing one.

Legal `style` (borders): `none dotted dashed solid double top bottom left right rails caps`
Legal `pattern` (fills): `solid underline overline midline hatch hatchdense backslash backslashdense cross vertical dots fade`
Legal `shape` (shapes): `soft pill oval roundleft roundright slant trapezoid chevron chevronback diamond notch`

### What is *not* in the document

Everything the scheduler computes: start dates, end dates, finish dates, slack, whether a
milestone is met, bar positions. Do not add them, and do not trust any you find. If you
want to know when something lands, open the plan and read the chart — the model is the
only input, by design.

## Recipes

> **Queue order is a scheduling input, and `/reorder` is how you see it.** A lane is a
> serial queue and array position is queue position, so the order of `tasks` decides
> dates. Nothing else checks it and it leaves no trace in the document — a plan can be
> 32 days wrong with every duration and dependency correct. Ask `/reorder` before
> concluding a plan cannot go faster.
>
> **It suggests; it never applies.** Run to convergence on a real plan and it will bury
> a de-risking spike to save two days on a task that gates nothing. It knows finish
> dates, not why a task exists. Apply one move, then ask again — the entries are each
> measured against the current order, so applying one invalidates the rest.

**They are not in this file, and that is deliberate.** They live in
[`agent-recipes.ts`](agent-recipes.ts) — as code, not as prose — and the interaction
suite applies every one of them to a scratch plan on each run: mutate, save through the
real `/save`, read back from disk, check. **A recipe that stops working fails the build.**

Copying them into this document would create a second copy, and a second copy is the thing
that rots. No file format fixes that: a stale OpenAPI spec passes CI exactly as happily as
a stale paragraph. The only documentation that cannot drift is documentation that runs.

Read them there. What is covered:

| | |
|---|---|
| add a dependency | push an id into `deps` |
| change a duration | `dur`, in **days** |
| add a task | every channel required, every value an id from its list |
| constrain a start | `notBefore` as a day number from `doc.start` |
| mark started / finished | two dates, no status field |
| reorder within a lane | position in `tasks` **is** the queue order |
| remove a task | and clean it out of every other task's `deps`, or `/save` refuses the plan |

They are written against the **demo seed** (`lease`, `permits`, `plumbing`, `health`),
which lives in `web/demo-plan.json` — so they run anywhere, and no client data is in them.
`day(doc, iso)` is exported alongside them for the day-number fields.

## Reading the schedule back

`/save` proves a document is structurally sound, not that it says what you meant. **Ask
`/verdict` what it costs.**

```js
// price an edit BEFORE saving it
doc.tasks.find(t => t.id === "plumbing").dur = 21;
const after = await post("api/verdict", { doc });
console.log(after.finish, after.milestones.map(m => `${m.label} ${m.met ? "met" : m.byDays + "d late"}`));
```

`byDays` is positive when the milestone is missed. `tasks` is how many are assigned to it;
`waitsOn` is the full upstream closure the date is actually computed over.

**It runs the same scheduler the chart runs** — `schedule.js`, imported by both this
backend and the page — so the endpoint cannot tell you something the room is not being
told. The verification suite reads the numbers off the chart and off the endpoint and
requires them to match.

**What is still browser-only:** *why* a task sits where it does. Click it — the dependency
chips are sorted tightest-first with one marked `pinning`, and after a `held by` divider
the real cause appears as chips when it is not a dependency at all (a full lane and what
is in it, a `not before`, an `actual start`, a `working day` snap). That is the fastest
way to check whether a dependency you added is load-bearing or just slack.

## Schema

`schemaVersion` is **4** and `/save` requires it. Older documents are upgraded by a
migration ladder that lives in `index.html` and runs when the *browser* opens one — there
is no server-side migrator, so never write a document at an older version and expect it
to be fixed up. If you find an old file, open it in the browser once and save it.

Archived versions may legitimately sit at older schemas (an imported archive), which is
why `/histput` is not validated. Migrate one by reading `.doc` and opening it.

## Verifying your change

The server accepting a save proves the document is *structurally* sound, not that it says
what you meant. To check the effect, open the plan and read the chart — the milestone
chips carry the verdict (`misses by 16 days`), and `History → Compare` on the version
before your edit paints where every bar used to be. That comparison is the fastest way to
show a human exactly what you changed.

If you changed the TOOL rather than a plan, the suites are in the repo root's
`AGENTS.md` — `npm test` in `sync-server/`, `npm run test:playback` in `scripts/`,
and `scripts/smoke.sh` after a deploy. `verify.interactions.ts` used to be named
here and has been deleted: it needed a live deployment and a runner from outside
this repo, so nothing in CI could execute it, and a suite nobody runs reads as
coverage. What it uniquely covered — the migrator over a synthetic ladder — is
`sync-server/test/migrations.test.ts` now.
