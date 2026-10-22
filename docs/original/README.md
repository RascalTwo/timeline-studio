# Timeline Studio

Edit a resource-constrained delivery timeline **live, in front of people**. Drag a
duration, link a dependency, watch the finish date move. No code, no rebuild.

> **Changing how it works?** Skip to [Working on this](#working-on-this) — the design
> decisions, the landmines that cost real time, and what the verification actually covers.
>
> **Changing a plan, as a program?** Read [`AGENTS.md`](AGENTS.md) instead. This file is
> written for a human with a mouse and explains *why*; that one is the document shape, the
> HTTP surface and the recipes, and its first rule is that an agent should never touch the
> UI — every gesture here is a field over there.

```
http://127.0.0.1:5180/Desktop/Desktop/Code/explorables/viz-pages/timeline-studio/
```

Server not running? `bun ~/.claude/skills/viz/viz.ts server start` (or any `/viz` command) spawns it.

## Driving it in a meeting

| They say | You do |
|---|---|
| *"That'll take three weeks, not two"* | Drag the bar's right edge, or click it and type in **Duration** |
| *"That can't start until X is done"* | Click the bar for **X** → **Link from this →** → click the bar that must wait |
| *"Why is that waiting?"* | Click the bar — its dependencies are listed as chips, and its arrows light up |
| *"Which of those five is actually holding it?"* | Click the bar — the chips are sorted tightest-first and one says **pinning**; the rest say how much slack they had |
| *"Nothing's pinning it and it still won't move"* | The line under the chips names the real cause — a full lane (and what is in it), its own constraint, or a fact |
| *"What changed last?"* | Top right of the milestone row: the last save's note and how long ago. Click it for the rest |
| *"When does that one finish?"* | Click the bar — the inspector reads **starts … ends …** |
| *"Just show me that one's chain"* | Click the bar → **👁** — everything it is not connected to disappears |
| *"Take that dependency off"* | Click the **×** on the chip |
| *"Do the QA server before the prod one"* | **Drag the bar up or down**, or select it → **↑ / ↓** (or **Alt+↑/↓**) |
| *"That can't begin before September"* | **Drag the bar sideways**, or set **Not before** in the inspector |
| *"We actually started that on the 3rd"* | Click the bar → **Started**. It lands on that date, whatever the plan thought |
| *"That one's finished"* | Click the bar → **Mark done**. The bar becomes how long it really took |
| *"Was our estimate any good?"* | A finished bar carries a tick where the estimate said it would end — inside means it overran, a dashed whisker past the edge means it beat it |
| *"Where did we say that would be?"* | **History → Compare** on any save; every bar then carries a strip showing where that version put it |
| *"What did this look like last week?"* | **History**. Every save you have made, newest first, with what it landed on |
| *"Show me the version before the monitoring work"* | **History → Open** on that row. Look at it; **Revert** comes back |
| *"What does that one hold up?"* | **Hover** any bar — its chain lights up without changing your selection |
| *"Forget the dates — what waits on what?"* | **View → Graph**. Same plan, laid out by what blocks what |
| *"Just this one's chain, then"* | In the graph, **Show → Selected chain** (the ⊙ does the same thing) |
| *"This is three projects in a trenchcoat"* | In the graph, **Group by** — one band per value |
| *"Split that in two"* | **Duplicate** (⌘D), then retime both halves |
| *"Could that team do two at once?"* | **⚙** (or **✎ Lanes**) → set `at once` to 2 |
| *"That server is both systems"* | Click the bar → tick **both** under **Color**; the bar splits |
| *"That one's not up to us"* | Give it a **Shape** — the demo points those bars into a chevron |
| *"Border should mean confidence, not environment"* | **⚙ → Swap** |
| *"Stop calling it Color, it's the project"* | **⚙ → Channels** → type over the heading |
| *"What can this thing even draw?"* | **?** → **See every style** |
| *"Which one is Plumbing, again?"* | **Hover** a dependency chip — its bar lights up. **Click** it to go there |
| *"Only show me the prod networking"* | Click **prod** then **Networking** in the legend |
| *"Now hide everything else"* | Tick **isolate**, or press <kbd>I</kbd> — same filter, different lens |
| *"How many of those are there, and how long?"* | Read it off the legend — every value carries `count·weeks` |
| *"…and how much is that lot together?"* | The **Selected** chip beside **Whole plan**, whenever anything is filtered |
| *"What if we hadn't co-located?"* | Switch model in the picker |

**Esc** deselects and cancels a link.

### Which one is actually holding it

A task waiting on five things is waiting on **one** of them. The other four finished
earlier and are irrelevant to its date — and a list of five chips said nothing about which
was which, so *"what do we go and fix"* had to be answered by reading arrows.

The chips are now **sorted tightest-first**, one is marked **pinning**, and the rest carry
the slack they had. Downstream is the same question reversed: which of the things waiting
on me actually starts when I finish.

**The scheduler already knew.** Every placement is `Math.max(dependencies, notBefore,
lane, today)` — that maximum *is* the bottleneck, and it was being thrown away one line
after it was computed. Recording which term won is three lines; nothing is inferred or
re-derived.

**Tightest, not zero.** The obvious test — "is the slack zero" — is wrong on any plan with
a working week: the binding dependency finishes on a Friday, the task snaps to Monday, and
every chip reads as slack while the bar sits pinned. It marked nothing at all on the first
real plan it saw. The right test is "is it the smallest", and the calendar day is reported
separately as what it is.

**When it is not a dependency at all, the same row says so — as data, not a sentence.**
After a `held by` divider come chips in the same vocabulary: `queue · Development work`,
then the task that has it and until when, clickable like any other chip. A `not before`
constraint, an `actual start`, `not started · no earlier than Aug 20` for the today floor,
or `working day +1d` for the calendar snap. This is the case worth the code, because a
queue is the one bottleneck with no arrow on the chart pointing at its cause, and "that
lane is busy" stops one question short of useful.

`today` sorts **last** among the five, below even the queue, because it names the *absence*
of a cause rather than a cause: a task whose dependency happens to end today is held by
that dependency and says so. And the chip names the date rather than saying "today",
because a screenshot read a week later has to still mean something.

**It was generated prose first, and prose was wrong twice over**: you had to read a whole
sentence to find the two facts in it, and a sentence reads as something the tool *inferred*
when every part of it is something the scheduler *computed*. It also cost a drag test —
its own row made the inspector taller, and the inspector is pinned over the chart, so every
row it grows is a row of bars nobody can drag. On the same line it costs nothing.

Every task in a plan answers, and a task that explained nothing was the bug **twice** —
once because the map lived in a global that `selftest()` overwrote at boot with a reference
plan's answers, once because started tasks are seeded before the loop that records the
reason and so had no entry at all. The suite counts rather than samples for that reason.

### The scheduler moved out, so the backend can answer

`sched()` and the migration ladder lived only in `index.html`, which meant the two
questions that matter most about a plan — *what does it land on* and *is this document
current* — could only be answered by a browser. Anything else editing a plan
([`AGENTS.md`](AGENTS.md)) could write a perfectly valid document and had no way to ask
what it cost.

They now live in [`schedule.js`](schedule.js), imported by **both** the page and `api.ts`,
which is the only arrangement that keeps them honest. A second copy on the server would be
the worst possible place to have one: this is the part of the tool that must be exactly
right, because a chart that computes the wrong date tells a room something confidently
false — and a *backend* that computes a different wrong date tells the room and the robot
two different things.

`GET api/verdict?id=` answers for a stored plan; `POST api/verdict {doc}` prices an edit
you have not saved. The suite reads the finish dates and task counts off the **chart** and
off the **endpoint** and requires them to be the same numbers, rather than trusting that
one import means one answer.

Three things the extraction had to get right:

- **`cal` became a required argument.** ~50 call sites here are written against the
  `cal = CAL` default, so six one-line wrappers restore it. The module has no page to read
  a global off, and nothing below those wrappers had to change.
- **`calOf` stopped reaching for the open plan's origin.** It converted holidays using
  `doc.start` — invisible while the two documents matched, wrong the moment the comparison
  lens or an archived version scheduled something that had moved its start.
- **The API re-imports the module per call.** The dev server re-imports `api.ts` on every
  request so edits land without a restart, but only that file — a static import resolves to
  the same specifier and Bun serves the cached copy. So editing the scheduler updated the
  page and left the backend on the old one, silently. That is the exact divergence the
  module exists to prevent, so it is made impossible rather than documented.

### `?demo` is gone, and the demo is a plan

**Superseded 2026-09-02.** This section described a query parameter that forced an
inline fixture at boot, and the care needed to stop it outranking the hash on every
refresh. Both are gone with the thing they served.

The fixture was a document this page could adopt *without a socket* — which is why
`loadDemo()` closed the connection on purpose, so a bakery could never write into a
real plan's room. The cost was that every edit a first-time visitor made was silently
discarded: the one claim this tool makes is that the numbers on screen are real and
shared, and on the front door they were neither.

The demo is now `demo-bakery`, a plan like any other, reached by `DEMO_TOKEN`. Arriving
with no token shows the front door immediately — it is static markup, so it paints in one
frame — and opens that plan behind it without blocking, which is what keeps a 30-90s
Fargate wake off the first impression. `web/demo-plan.json` is its tracked starting
state: `scripts/reset-demo.sh` reverts the live plan back to it. One bakery, one
source.

### The last change is on the milestone row

*"What did I change last, and when"* is the first question on opening a plan you have not
seen since Friday, and it was two clicks into History. It now sits at the far end of the
milestone row — opposite the milestones, pushed right with `margin-left:auto` so it stays
there however many there are — showing the newest save's note and a coarse relative time.
Clicking it opens the panel it summarises, and it collapses with the rest of the bar.

It costs no documents: `api/history?meta=1` returns the versions without them, because the
panel needs every document to compute what each version landed on and this line needs a
note and a date.

### There is no undo, on purpose

**Revert** throws away everything since the last Save, and that is the only way back.

Undo existed and was removed. It was a whole-document snapshot stack with **28 push sites**
threaded through every mutating operation, and the case for it — "I broke it live and can't
get back" — is a case Revert already answers for someone who saves often. Twenty-eight call
sites is twenty-eight chances to add an edit and forget the snapshot, which is not a
hypothetical: colour picking and arrow styling both shipped without one, so ⌘Z silently undid
whatever you did *before* them. A feature that is subtly wrong in the corner you reach for it
is worse than one that isn't there.

Two things went with it, both improvements:

- **The cycle guard rolls back by hand.** Linking a dependency that would create a cycle used
  to call `undo()` — a general-purpose time machine existing largely to serve one `catch`. It
  now restores the one array it just touched, which is shorter and cannot pop an unrelated
  earlier edit.
- **The suite resets by reloading the fixture.** Undo-as-teardown meant every reset depended
  on the feature under test elsewhere in the file being correct, so a broken undo could hide a
  second failure behind itself. A reload cannot be wrong about what pristine means.

Nothing is written to disk until you press **Save** — and because of that, closing the tab
with unsaved edits asks first, the same way switching plans and **New** already did.

### History is not undo, and the difference is one number

**History** keeps every version you have saved. That looks like the feature the section above
just argued against, and it is not — the whole case is a single number.

Undo needed a snapshot at **28 mutation sites**, one per operation that changes the document,
and it only takes one new edit written without one for ⌘Z to start silently undoing something
else. History snapshots at **one site**: `save()`. You cannot add an edit and forget to
snapshot it, because snapshotting is not per-edit. Add a hundred new operations and the
guarantee is unchanged.

The other half is scope. **Revert is about the unsaved buffer; History is about saved states**,
and they look adjacent without being so. Revert is untouched by this feature and means exactly
what it always meant. The moment History could reach into unsaved edits it would need a
snapshot per edit, and it would be undo again, wearing a different hat.

Everything here is **append-only**. Opening an old version loads it as your working document
with unsaved changes — the version you came from is still in the list, and saving from there
writes the *next* version rather than overwriting anything. There is no branch, no merge, no
version delete, and no path through the panel that loses a document. If a version is a genuine
alternative you want to keep developing, that is what **Fork** is for: it becomes its own plan,
with its own history.

Three things about a version are worth knowing without opening it, so every row carries them:
how many tasks, **what it landed on**, and both deltas against the row below. The finish date
is not stored — it is recomputed per row by the same scheduler the chart uses, so a row cannot
disagree with what opening that row would show you. That turned out to matter: the first run
of this panel against the real plans disagreed with a hand-maintained table by one day on four
of seven rows, and the panel was right — the table predated `fmtEnd` and had never been
recomputed.

**The note is the only thing you can change about a version.** Save opens a one-line field —
focused, Enter commits, Esc cancels, empty is fine — and any row's note stays editable
afterwards, because you usually know what changed once the meeting is over. The snapshot
itself is frozen: an archive you can edit is not an archive. Saving with nothing changed adds
no row and says so.

**Where it lives.** A sidecar, never a field on the document. In the document it would make
every plan read as permanently unsaved (that answer is a string comparison against the last
save), send the migration ladder walking through nested old documents, and rewrite the whole
archive on every save. On disk it is `data/.history/<plan>/`, one plain JSON file per save,
unbounded — these are 16KB files and disk is free. In the browser it is one gzipped blob per
plan, capped at 200.

That asymmetry is deliberate twice over. Uncompressed on disk because the promise there is
plans you can diff and back up. Compressed in the browser because that is the store with a
real ceiling — and because storing the archive as **one** blob rather than a blob per version
measured **25×** on the seven real plans this tool was built for, against 7× for a plan on its
own. Deflate's window catches the redundancy *between* versions, which is diff-grade
compression with no diff algorithm, no patch chain, and nothing that breaks when one link is
missing. All seven plans, complete, in 3.7KB. At that ratio 200 versions is years of saving,
so the cap is a backstop rather than a limit — but it is never silent: the top bar counts down
from 25 remaining, and the save that would drop the oldest stops and names it first.

**Export carries it**, in both scopes — a single plan keeps its ordinary document shape with
the archive attached, so it still drops straight into `data/`, and Import takes it either way
and ignores files that have none. Deleting a plan takes its archive with it.

## What the colours mean

Beyond the legend on the page:

- **Dependency lines** — **hue is the direction, dash is the distance**. Blue = upstream
  (what this waits on), green = downstream (what this unblocks); solid = one hop, dashed =
  the rest of that chain, which is what a deps list cannot show you. Hover previews the same
  thing for any bar without moving your selection.

  All four are **data, not constants** — `doc.arrows`, edited in **⚙ → Arrows**, so a plan can
  carry its own convention. The defaults above replaced a scheme where a third hue (amber)
  carried "further upstream" while a single green carried the *whole* downstream side: one
  colour answering two questions, and another answering half of one.

### How far the chain lights up is two numbers, not one

**Hover 1 hop, click 2 — and both are per-plan** (`doc.depth`, in **⚙ → Arrows**).

The whole transitive closure is the wrong default for the same reason a deps list is: it is
a diagram of the *plan*, not an answer about *one task*. Sweep a pointer across sixty rows
with everything lit and each bar paints half the chart, which is indistinguishable from the
bar before it.

Hovering and selecting are different acts, so they get different budgets. **A hover is a
glance you did not commit to** — you are asking "what does this one touch", and one hop is
the honest answer. **A click is deliberate**: you picked that task and you are willing to
read what comes back. Making it one shared number forces you to tune for the worse case and
lose the other.

**An edge is classified by which hop of the walk it is**, counting outward from the focused
task — edge `d → t` sits at level `hops(t) + 1` going upstream. The obvious rule (colour an
edge when *both* its ends are in reach) is the same thing when nothing is limited and wrong
the moment something is: two tasks can both be one hop away *and* depend on each other, so
the edge between them passes "both ends within 1 hop" while being unmistakably the second hop
on screen. On a real plan, hovering a task with seven interlinked dependencies drew seven
solid lines and **nine dashed ones** at the setting that says *direct only*. The control
promised one thing and the chart did another.

Past the budget an arrow goes **muted, not missing** — the same faint grey every unrelated
dependency already draws. An arrow that *vanished* at depth 3 would say *there is nothing
there*, which is a different claim and a false one.

The sentinel for "this edge is on neither side" is **0, not Infinity**. Infinity is the
obvious choice and the wrong one: the budget is *also* Infinity at "the whole chain",
`Infinity <= Infinity` holds, and every unrelated dependency in the plan came out coloured.
A sentinel that compares equal to the limit is not a sentinel.

The limit is on the **arrows only**. The ⊙ chain-focus lens and the inspector's transitive
list stay unbounded on purpose: those are "show me the whole chain", asked once, deliberately.
This is a question about what the pointer is allowed to shout while you move it.
- **Bar border** — faint → bright as dev → QA → prod.
- **Hatch** — a guessed number. Unmarked bars are estimates; an inner white underline means
  known.

### The style enums, and where they run out

**Fill patterns come in three families, and the family is the point.** Values from the *same*
family read as a ramp; values from *different* families read as merely distinct. Pick within
a family for an ordinal channel, across families for a nominal one.

| family | reads as | values |
|---|---|---|
| rule | where a bright line sits | `underline` `overline` `midline` |
| hatch | direction × density, a full 2×2 | `hatch` `hatchdense` `backslash` `backslashdense` |
| texture | non-directional | `cross` `vertical` `dots` `fade` |

Plus `solid`, the unmarked default. `fade` is the only one directional along the bar's
*length*, which makes it the one to reach for when a value means something about the end of
the work rather than the whole of it.

**The rules float; they are not flush.** Pressed against the edge, `underline` was a
border-bottom drawn two pixels in — indistinguishable from the border channel's `bottom`.
Held 3px clear of the rim it reads as a mark *on* the bar rather than the edge *of* it, and a
bar can wear both at once and stay legible. `edges` did not survive that test and was deleted:
it was the border channel's `rails` drawn two pixels further in, the same mark in two
channels, and one of them had to go.

**Nothing here uses opacity**, and nothing here can: opacity is the filter's, and a fill that
dimmed a bar would be indistinguishable from a bar the legend had filtered out. That rules out
the "hollow" and "ghost" looks, which are the most obvious things to ask for and the two this
channel cannot have.

**Border styles are close to their ceiling at seven, and that is a fact about CSS.** It offers
ten `border-style` values; the five not used here (`hidden`, `groove`, `ridge`, `inset`,
`outset`) derive their appearance by lightening and darkening the border *colour*, and at 2px
of near-white on a dark bar they render as a thinner solid or as nothing. They are not
options, they are traps — don't spend an afternoon rediscovering that.

The only genuinely new values available were **side-selective** ones, because a rim on two
sides instead of four is a different *silhouette* rather than a different texture, and a
silhouette survives being small. So the eleven values are **two axes kept deliberately
apart**: `none` `dotted` `dashed` `solid` `double` are *which texture* on all four sides;
`top` `bottom` `left` `right` `rails` `caps` are *which sides*, always plain solid.

Crossing them — a dashed left-and-top — is 5 × 6 = 30 values nobody can hold in their head,
and the point of an enum is that you can point at a bar and say which one it is. That is the
same reason thickness stays rejected: 1/2/3px is not separable on a projector, which is the
only screen that matters.

## Shape — the last visual channel, and it is opt-in

Position and length are the dates (load-bearing — never decorate with them), hue is the
system, the rim is the environment, the texture is the confidence, and opacity belongs to
the filter. **Shape is what was left**, and there is nothing after it.

Eleven values in two families. **Rounded** — `soft` (the default) · `pill` · `oval` ·
`roundleft` · `roundright` — are pure `border-radius`, so a real CSS border survives around
the curve and every border style reads exactly. **Pointed** — `slant` · `trapezoid` ·
`chevron` · `chevronback` · `diamond` · `notch` — are `clip-path` silhouettes. 7-8px of point
per end still leaves a flat middle on a half-week bar.

`square` was in that list and is not any more: 0px versus 4px of corner on an 18px bar is not
a difference you can name across a room, and the obvious fix — rounding `soft` harder — walks
it into `pill` at 9px. A channel value nobody can identify is worse than one fewer value.

### A pointed shape paints its own rim

A CSS border is painted on the box edges and *then* clipped. On a chevron that means the flat
top and bottom rims stop dead where the diagonal starts and the point has no rim at all — it
reads as a detached triangle. That shipped, and it looked like a rendering fault because it
effectively was one.

So a clipped shape draws its rim itself: `.shape` **is** the rim, clipped to the silhouette,
and `.core` is the same silhouette inset 2px carrying the fill, the pattern and the bands. The
rim follows every edge, diagonals included.

**The border style survives as a texture rather than as a stroke pattern**, because CSS cannot
dash a diagonal. A 2px band of dot-tile reads as dotted on any edge; a dash-tile reads as
dashes along the flats and shortens on the angles. The four values stay *distinguishable*,
which is what the channel needs — exact stroke fidelity on a 2px diagonal is not something a
projector resolves anyway. Rounded shapes keep the real border and are untouched.

Two details, both caught by assertions rather than by eye: `.shape` carries a faint 1px border
by default, and with border-box sizing that pushed the core's `inset:2px` to **3px** of
visible rim — a hairline of the wrong colour under the rim meant to replace it. And `rim-none`
needs `.core { inset:0 }`, or a borderless pointed bar wears a 2px transparent moat.

Because the fill can live on either layer, both carry a **`.fillbody`** class. That is the
hook to query for "the thing wearing the pattern" — `.shape` alone is wrong for six of the
eleven shapes.

**A plan with no `doc.shapes` gets no Shape group and renders exactly as before.** Seeding
one would impose a meaning nobody asked for on every plan already on disk, and an empty
group in the legend is a control that looks broken. Add values in **⚙ → Channels → Shape**.

The demo uses it for **who controls the date** — the building permits and the health
inspection are chevrons, because they sit on someone else's calendar. That is deliberately
an axis none of the other four channels can express: not the team, not the system, not the
environment, not how well you know the number.

### Why the bar is two elements now

`clip-path` clips *everything* inside its element. The resize grip overhangs the bar's right
edge by 3px, the amber constraint tick overhangs the left by 5px, and the selection outline
sits outside the border box — all three would have silently vanished the first time someone
picked a diamond, on exactly the bars they most needed them on.

So the bar is a transparent hit-box and **`.shape` is the visible body one layer in**. The
clip lives on `.shape`; the grip, the tick and the halo are its siblings, outside the clip,
and behave identically for every shape. `.shape` also gets `overflow:hidden`, which is safe
there in a way it never was on `.bar` — and it means the colour bands are clipped to
whatever silhouette the shape is wearing, so a diamond's second colour comes to the same
point as its first, with no per-band corner logic at all.

The selection halo stays a **rectangle** rather than tracing the silhouette, on purpose: a
selection that changes shape with the data is one you have to re-learn per row.

## A channel is a rendering, not a meaning — so a meaning can move

Nothing in this code knows that `doc.colors` holds *systems*. It holds labels that happen to
be drawn as hues. That discipline had no payoff until now, and **⚙ → Swap two channels** is
the payoff: send "dev / QA / prod" off the border and onto the fill, and every task's
assignment goes with it.

**What moves is the label and the assignment. Styles stay with the channel** — a value
landing on `fills` needs a fill pattern, because that is what a fill *is*. So the mapping you
supply is `label → style in the destination`, which is the question you were already asking
out loud: *map dev to the underline, QA to hatch*. Defaults pair them off position for
position; override any row.

**Nothing is merged.** Two labels may be given the same destination style, and they stay two
separate values that happen to render identically — the legend, the filter and the counts
still tell them apart, and the panel says so in as many words. Merging them would destroy
which-task-was-which irreversibly; "you cannot tell these apart on the chart" is a fair price,
"we threw away your data" is not. That is the whole of the granularity-loss story.

Three things genuinely do not survive, and each says so before you commit:

- **Lane capacity.** "at once" is a property of a lane, not of a meaning. The schedule moves.
- **Extra colours.** Colour is the only list; every other channel holds one value, so a
  two-system task keeps only its first when colour moves out.
- **Nothing else.** Dates do not move — neither border nor fill feeds `sched()` — and the
  verification asserts exactly that.

**A swap is in-memory until Save**, so Revert throws it away. There is no undo to lean on —
which is why the confirm dialog names both counts and the task total before it runs, rather
than trusting you to reverse it afterwards.

> **The bug this shipped with, once.** `uid()` checks the ids already in the document — right
> for the one-at-a-time "+ Add" it was written for, wrong for a swap, which mints a whole list
> before writing any of it. Every new value got the same id, every task pointed at it, and the
> legend reported all 12 tasks under all 3 values. The labels moved correctly the entire time,
> so it looked right. **Per-value counts were the only thing that could have caught it**, and
> that is now what the test asserts: if "known" had 2 tasks and 3 weeks as a fill, it has 2
> tasks and 3 weeks as a border.

## Colour is a list. Nothing else is.

A task has one owning team, one environment, one confidence — but it can genuinely touch
**two systems**. A shared server belongs to both applications sitting on it, and saying so
by inventing a combined value ("Rates API & MOAuth") is a combinatorial trap: three systems
have three possible pairs, four have eleven, every one is hand-maintained, and none of them
is visible to a filter for either half.

So `task.color` is a **list**, and a task carrying two systems is drawn as **two bands**
along the bar. Tick them in the inspector; the bands follow the order of the legend, not
your click order, so two tasks with the same pair look the same.

**Only colour.** The other channels have nowhere to draw it — a 1px rim cannot be half
dotted and half solid legibly, and the fill patterns already own the bar's interior texture.
Colour has the room; nothing else does. The model takes any number of colours, but the eye
takes about three.

Two consequences worth knowing before someone in the room spots them:

- **The Colour counts add up to more than the plan.** A shared server is counted under both
  systems, because that is what "how many touch Rates API" means. The Colour heading carries
  a `*` saying so. Every other channel still sums to the task count.
- **Deleting a colour drops it from a task's list** rather than replacing the whole thing.
  Only a task left with *nothing* falls back to another value. That is what makes retiring a
  combined value clean: tick the two real colours on its tasks, then delete it and it goes.

### The inspector is one line of controls per channel

Every channel is a **dropdown**, including Colour. Colour was a row of toggle chips, which is
the better gesture in isolation and the wrong one here: it grows with the number of values,
and the inspector is pinned *over* the chart it describes, so every pixel it takes is a pixel
of plan. A control one line wide whatever the plan contains beats one that reads slightly
nicer at four values. It is still multi-select — it opens rather than sprawling, and it stays
open across the re-render, because "this task is both" should not be a two-trip job.

**Delete is a trash can**, not the word. It was the widest button in a row where width is the
scarce thing, and it is the one button in there nobody needs to read twice.

Gone: the *"2 direct, 4 more behind them"* line. The two chip rows above it already say that,
in the same glance, with the names attached.

### The row label is the row

Hovering the name on the left does what hovering the bar does; clicking it does what clicking
the bar does. The label column is this chart's **index**, and an index you cannot click is a
caption — reading a name and then travelling to its bar to act on it is the same complaint the
dependency chips answer.

It borrows the chips' `.hot` for the same reason they need it: the pointer is a long way from
the bar, so *which one is that* has to be answered **on the bar**. And it stops the click
propagating, because `#chart`'s own click means "you clicked the background, deselect" —
without that the label would select a task and instantly clear it.

### Chips are pointers to rows

Every dependency chip in the inspector — direct, transitive, and downstream — **highlights its
bar on hover** and **selects it on click**, scrolling it into view horizontally if it is off
the edge. Reading "Plumbing & gas rough-in" in a list and then hunting for that row by eye was
the slow half of every *why is this waiting?*. The highlight is white, deliberately not the
selection blue: the point is to find a row while the selected one stays obviously selected.

### Every style, side by side

**? → See every style** is the paint-swatch wall: every shape, every fill pattern and every
border style at once, drawn as real bars at a plausible width rather than as chips, because a
silhouette and a rim do not read honestly at swatch size.

It lived in Settings and does not any more, for a reason worth stating: **nothing on it
changes anything**. It is a reference, and it belongs with the other *what is this thing*
material behind the **?** rather than among four panels that all write to the document.

It is **generated from the enums**, never hand-listed — a hand-kept reference of "here are all
the fill patterns" is wrong the day someone adds the twelfth, and wrong silently. Borders go
through `rimCss()`, the same function the chart uses, so exactly one place knows what `rails`
looks like.

Axes are shown independently. 7 shapes × 12 fills × 7 borders is 588 bars and nobody has ever
learned anything from the 588th.

> The wall's bars are `.swbar`, **not `.bar`** — and that distinction cost a debugging round.
> Reusing the real class looked like a guarantee of fidelity and was actually a namespace
> collision: `#settings` sits before `#chart` in the document, so `querySelector(".bar")`
> started returning a swatch inside a hidden modal. The fixture's bar count went from 12 to 38
> and the suite's first click landed on an invisible element. Nothing was lost by dropping it —
> `.bar` only supplies position and size, and every visual the wall exists to show lives on
> `.shape`, which is still the genuine article.

### Counting things

Every legend value carries its own **`count·weeks`**, so "how many are prod?", "how many
guessed?", "how much work does that team own?" are all read off the key you were already
looking at. Filter across channels and the **Selected** chip beside **Whole plan** totals
whatever survives — which is how you answer "how many are Rates API *and* prod, and how many
weeks is that" without a stats panel existing at all.

The counts are totals for the plan and do not move when you filter; the Selected chip is the
one that responds. That split is deliberate — a legend whose numbers changed as you filtered
could not tell you what you were filtering *out of*.

## ↑ / ↓ is a scheduling control, not a cosmetic one

A lane is a **serial queue**, and the scheduler breaks ties by position in the list — so
row order *is* the order that team works in. Moving a task up is literally "do this first",
and it changes dates whenever two tasks are ready at the same moment (which is every server
build, since none of them has a dependency). Measured on a real plan: moving one prod server
to the front of the queue costs **half a week**.

When a move changes nothing the tool says so — that means something upstream is pinning
that task and its queue position is not what is holding it up.

Corollary: after edits the bars may stop descending in a tidy staircase. That is
information, not a rendering glitch.

The big coloured line at the top is the whole point — it is the answer to "does this
still make Nov 18", and it recomputes on every edit.

### Three lenses: dim, isolate, or follow one chain

Clicking legend values sets the filter. **How** that filter is shown is a separate choice,
and the **isolate** tick-box — <kbd>I</kbd> — switches between two:

- **Dim** (default) greys the rest and leaves them on screen. You keep the context — where
  the prod work sits relative to everything else, and the fact that there *is* everything
  else. In a meeting that matters: a chart that silently drops rows can be argued with
  dishonestly.
- **Isolate** removes them. The subset becomes its own short chart, which is what you want
  when the answer is "just show me the networking" and eighteen other rows are noise on a
  projector. Teams with nothing left lose their heading too.

**Neither touches the schedule.** A bar sits at exactly the same date in both, and the
milestone verdicts do not move, because filtering is a view. The verification suite asserts
precisely that: it isolates, then checks every surviving bar is still at the same x and the
chips still read the same.

Hover-preview works until isolate is actually hiding something, then stops — previewing by
hiding would reflow the chart on every pointer move across the legend, and previewing by
dimming cannot show you a row that is not rendered.

The lens is part of the view state, so a link to an isolated subset reopens as that subset.

The third is **👁 in the inspector**, and it filters on something the legend cannot express.
The legend channels are *attributes* of a task — its team, its colour, its environment.
Chain focus is a *relationship between* tasks: it keeps the selected task, everything it
waits on, everything those wait on, everything it unblocks, and everything those unblock,
and treats the rest exactly as a legend pick would. It is the answer to "which rows do these
lines actually touch", which the arrows alone answer badly the moment a chart is twenty rows
tall.

**It reads the same tick-box.** Until 2026-08-19 it always removed the other rows, whatever
**isolate** (called "hide the rest" until 2026-09-20) said — so one control meant "grey them" for a legend pick and nothing at all
for a chain, which is two behaviours wearing one label. Now dim greys what is outside the
chain and isolate drops it, and the difference between the two questions is what they ASK,
not how the answer is drawn.

That made a marker necessary. While the eye removed every other row, the survivors *were*
the answer and the origin needed no highlight; in dim mode the chart looks the same, only
greyer, so the focused task carries a dashed accent ring — and, where the bar is at least
20px wide, an 👁 in the middle of it. The ring is the primary marker because an outline
works at any width; the glyph is the extra, and is dropped rather than squeezed.

It **composes with the legend filter** rather than replacing it — an isolated chain can still
be narrowed to prod — because they are two independent questions. **show everything** clears
both, and says when a chain is what is doing the hiding.

## Milestones, start date, today

- **Start** (top bar) is the project's week 0. Editable.
- **TODAY** is the real current date, drawn as its own green line. It is *not* week 0 —
  those were the same thing only while `start` was hardcoded. The axis always extends far
  enough to show it.
- **Milestones** are a list. Each has a name and a date, each draws its own line, and each
  gets its own pass/fail chip. Assign a task to one in the inspector.

A milestone is not met until every task assigned to it **and everything those tasks wait
on** is done. Reporting only the directly-assigned tasks would flatter it — a milestone
with three quick tasks sitting on nine weeks of predecessors has not been met.

Deleting a milestone reassigns its tasks rather than orphaning them.

## The legend is three things at once

- **A key** — what the colours, borders and fills mean, and **how many tasks and weeks** sit
  behind each value.
- **A filter** — hover any value to preview it, click to focus. Within a channel clicks
  widen (prod *or* QA); across channels they narrow (prod *and* Networking). "show
  everything" clears it. **Filtering never changes the schedule.**
- **A swap** — any two channels can exchange what they mean, in **⚙ → Swap two channels**.

Editing them is **not** a fourth job. Each group used to carry its own ✎, which was a link to
Settings dressed as an editor — five in a row read as five separate editing surfaces, and the
first thing anyone asked on seeing them was whether the code had been written twice. **⚙ is
the only door.** The legend is a key and a filter again.

Each channel is its own **card**, because five groups separated by nothing but whitespace read
as one long run of swatches, and *which of these is a border and which is a fill* is the
question the legend exists to stop you asking.

**One tint for all of them.** The first cut alternated two shades to separate adjacent cards
and it just looked like a rendering fault — the eye reads an inconsistent background as a
mistake long before it reads it as a grouping. The card edge does the separating; the fill
only has to say "this is a panel". And the tint is a neutral, which is a constraint rather
than a preference: every hue on this page is load-bearing, so a card tinted with a real hue
would be a sixth thing for a colour to mean. Resist "just make Border blue".

The **⌃** in the top-right corner collapses the whole control bar to a single line, keeping
only the plan name and whether it makes its date.

**The inspector folds the same way**, from its top-left corner, and for the same reason at
the other end of the screen: it can be 44vh of dependency chips sitting over the bottom of
the chart. Folded it keeps its header row — the task name, and the buttons that act on it —
so it stays useful rather than merely small, exactly the bargain the collapsed bar makes by
keeping its mini line.

Two things had to move to make room. The **?** left the bottom-left corner for the top bar
beside the **⚙**: it was a floating disc over the panel's own corner, and the panel was
reserving a 48px left gutter purely so its last row did not read through it. That gutter now
carries the fold control, and **?** collapses with the bar like every other button there.

Folding is also the one place the panel's height reservation is allowed to SHRINK.
`padForPanel()` only ever grows it — that is what stops the page twitching as the panel
changes height from one selection to the next — so folding resets the high-water mark
explicitly. Without that the space would be hidden but not given back, which is a fold that
does nothing you can see.

## The top bar holds only what a meeting touches

**Three zones, not one run**: *which* plan on the left (picker, ✎ rename, **New**), *what you
do to it* in the middle (**+ Task**, **Link dependency**), *what happens to it* on the right
(**Save**, **Revert**, **⚙**) — so the two buttons that write are nowhere near the two you
press constantly. The spacers are `flex-grow`, so the middle group stays centred at any width.

Everything set once and then driven — start date, sprint cadence, which store
plans live in, Fork, Export / Export all / Import, the dependency-arrow styles and every
channel definition — is behind **⚙**.

Two things fell out of that. The plan-name text box became a **✎** popover, because the name
was already on screen twice (the picker, and the collapsed mini line) and a permanent 300px
input was spending the scarcest space in the tool on a control used once per plan. And the
channel editor stopped being one-at-a-time: inside a modal there is room for all four, which
deleted the "which one is open" state and the second click that used to put it away.

## Settings is five tabs, and each one is a SCOPE

**Plan · Channels · Swap · Arrows · Global.** A tab is not just one job, it is one blast
radius — which is what the earlier layout got wrong. "Where plans are kept" and **Import** sat
under a tab headed *This plan*, and neither is about the plan in front of you: the store is a
property of the browser, and Import loads whatever is in a file into that store, possibly
several plans, possibly none of them the one you are looking at. The heading was making a
claim about their reach that was false.

So **Plan** is strictly this document — its dates, a copy of it, a download of it, nothing
that can touch another plan — and **Global** is the shelf rather than the book: the store
selector, Import, and Export all. The **Arrows** tab carries *how far* (the two depth budgets)
above *how it looks* (the four styles), because on a chart of any size the first thing you want
from the arrows is less of them, not a different blue.

They were sections in one column, which meant the one you wanted was always below the fold and
reaching it scrolled past two you did not. The tab is remembered across opens, because the
thing you were last editing is overwhelmingly the thing you are coming back to.

### The demo is a fixture, and Save refuses it

Saving while the demo is open used to write a `demo.json` the tool could never open again.
`refreshPicker` appends its own hardcoded `demo` option *after* the store's list, so the stored
copy showed up as a **duplicate** entry — and `load()` short-circuits on that id before it ever
reaches a store, so the file was unreachable by construction. Twelve tasks of dead data filed
in among the real plans.

Refused rather than silently forked: a Save that quietly writes somewhere else under a name you
did not choose is a worse surprise than being told no, and **Fork** is right there doing exactly
that, on purpose.

### What this plan calls each channel

`CH[key].label` names the **rendering** — Lanes, Color, Border, Fill, Shape — and that is the
right default precisely because it claims no meaning. But a plan *does* have a meaning for
each, and "COLOR" in the legend when everyone in the room says *project* is a small tax paid
on every glance.

So `doc.channelLabels` is optional and per-plan, edited in **⚙ → Channels** by typing over the
heading. The legend, the inspector, the swap panel and every confirmation follow it. A
document that never sets one is unchanged, and the fallback is the rendering's own name rather
than an empty heading.

### The channel editor is a table

Four columns — **value / style / used / controls** — identical in every channel, so the eye
runs down a column even where one channel's style control is a colour well and the next
one's is a texture.

### The style control IS the swatch (schema v4 era)

The channel editor has no dropdowns left. A name is not what you are choosing — "backslashdense"
and "hatchdense" differ by one letter as words and obviously as textures — so the control is
the swatch, and it opens a **grid of swatches** to click. No words anywhere; the name survives
as a `title` for anyone describing a plan out loud and nowhere else. Colour never had this
problem, because its control has always been its preview; this is the rest of the channels
catching up.

The popover is `position:fixed` at **z-index 90**, and that number is load-bearing: it shipped
at 80 under a settings overlay at 85, which meant correct position, correct size, correct
contents, and completely invisible. A rect inside the viewport is a weaker claim than a pixel
you can click — the suite asks `elementFromPoint`, not `getBoundingClientRect`.

**A shape swatch is a real `.shape`**, not a `.k` with an `sh-` class on it. `.k` sets its own
`border-radius` and is declared *after* the `.sh-*` block — equal specificity, later wins — so
every radius-based silhouette (soft, pill, oval, both round-ends) collapsed to the same 3px
rectangle while the clip-path ones (chevron, diamond, notch) rendered fine. *Some of them work*
is the signature of a cascade collision, and the swatch wall looking correct all along was the
proof it was never the shapes. It is also **wider** than a `.k`: a silhouette needs length, and
at 26px a pill and an oval are the same lozenge however right the CSS is.

**A channel's array is optional on a document.** Shapes are opt-in, and no plan written before
they existed carries one. Every *read* site spells this `doc[key] || []`; `+ Add` was the sole
*write* site and did not, so it threw — silently — on precisely the empty channel you would
need it for.

The style column is **fixed width** because the swatches in it are not one shape — a colour
well, a rim, a texture, a silhouette. Letting the column size to content is what made the
previous layout read as a pile of unrelated widgets rather than a table.

## A channel under two values shows no UI

**One value is not a choice.** If every task in the plan is "prod", the border is not telling
you which ones are — it is telling you there is only one kind, which the *absence* of the
group says just as well and in no space at all. A legend entry you can click to isolate 100%
of the chart is a control that cannot do anything, and a filter that cannot narrow reads as
broken rather than as complete. Same for a dropdown with one option, on a panel that is pinned
over the chart it describes.

So under two values a channel draws **no legend group and no inspector control**. This was
already true of shapes as a special case; it is the same argument at one value as at zero, so
it is the rule now rather than a carve-out for the opt-in channel. The values are still in
**⚙ → Channels**, which is where you go to add the second one that makes the axis mean
something.

**No channel can be emptied, and since v3 that has a reason it did not have before.** It used
to read as an arbitrary "keep at least one value", which is what made deleting the last shape
feel like a bug — it *was* one, because the guard was protecting nothing anybody could name.
Now every task points at a real value in every channel, so the last value is not arbitrary at
all: it is what every task in the plan is currently pointing **at**. The way to stop using a
channel is to take it down to *one* value, not zero; at one value it costs a row in Settings
and nothing anywhere else.

## A team you are not looking at should take one row

Click a lane head and it folds. The chevron is the whole affordance, and the lane head needed
one anyway — it was the only thing in the label column you could not click, which made it
read as a caption next to a column of names that are all live.

**Three states, in decreasing order of respect for the team:**

| | | |
|---|---|---|
| `▾` | every task on its own row | the default |
| `▸` | one row **per track** | full-height bars, everything still draggable |
| `▪` | one row, whatever it takes | bar height divided between the tracks |

`▸` is the one to reach for. It collapses a team to the number of rows its work actually
*needs* — which for most lanes is one — and gives up nothing: the bars are full height, the
grips work, the drag still edits. `▪` is for a team you have genuinely stopped caring about,
and it trades editability for the last few pixels.

This is not a filter. Folding a team does not remove its work from the schedule, the
milestones or the arrows; it removes it from your *attention*. **Nothing about the plan
changes, which is why it is view state** and lives in the hash beside the zoom and the
isolate lens rather than in the document.

### A track is measured, not declared

A **track** is a lane of work that does not overlap itself, assigned greedily by start date.
The number of them is what both fold states are built on, and it is deliberately **not** the
lane's capacity: a team allowed three at once that never ran more than two has two tracks,
because the fold should show what happened rather than reserve space for a claim nobody made.
The scheduler has already guaranteed no more than `cap` concurrent, so this can never need
more tracks than the lane is allowed.

Tracks are counted even for an expanded lane, because the count decides how many fold states
that lane *has*. **Where the work never overlaps there is one track, `▸` and `▪` are the same
picture, and offering both would be a click that changes nothing** — so a serial lane cycles
in two states, and only a lane that genuinely runs work in parallel gets three.

That also means a folded serial lane — the common case — is *pixel-identical to the expanded
one with the labels removed*. Same bar height, same grips, same drag. It is free.

**The grip goes only in `▪`, and only when there is more than one track.** It overhangs 22px
against a bar that may be 9px tall, so it would reach into the track below and resize the
wrong task. That state is for getting a team out of the way and losing a drag handle in it is
the right trade — the bars stay clickable, which is checked with `elementFromPoint` rather
than a bounding rect, for the reason this file has needed that distinction before.

**The queue drag goes in both folded states.** Dragging a bar up its lane means "do this one
first", and a folded lane's rows are *tracks*, not queue positions — 26px of travel would
reorder a queue you cannot see move, which is the invisible-state failure this tool is built
against. The order is still real and still reorderable from the inspector.

## Zoom is a question about time, not a percentage

`PPD` used to be `54 / 7` — a week is 54px — and a plan too wide for the window simply
overflowed into `#chart`'s scroller. That was fine until plans got long enough that the
whole thing at once was unreadable and a single month was unreachable.

So the picker is named in **time**: *Plan · 1 month · 1 sprint*. One rule covers every
setting including the old one — **`PPD = pixels available / days in view`** — so "Plan"
stopped needing a magic number and started being a statement of intent. A zoom *percentage*
would have been the obvious control and the wrong one: nobody wants 150%, they want the
sprint they are standing in.

**A sprint is per-plan data, so the options cannot be static markup.** `1 sprint` means three
weeks in one plan and two in another, and a picker naming someone else's sprint length would
be the same class of lie as a chart titled for a date it does not land on. The list is sorted
widest-first for the same reason it is built rather than written: at a five-week cadence a
sprint is wider than a month, and the order should follow the spans rather than the names.

**Pinch works too**, because on a Mac a trackpad pinch arrives as a `wheel` event with
`ctrlKey` set — that is the platform's own signal rather than a heuristic, and ctrl+wheel on
a mouse means the same thing to anyone who has zoomed anything else. It writes a fraction
into the same number the picker sets, so the picker stops claiming *1 month* the moment that
becomes untrue: rather than a "Custom" that says nothing, the spare option reports the span
you are actually looking at, which is the same kind of answer the four presets give.

**The two gestures disagree about the anchor, so it is an argument.** The picker has no
position and keeps the middle of the view. A pinch has a very definite position, and zooming
away from your own fingers is the thing that makes trackpad zoom feel broken.

### Snapping, and the trap it sets

**Within 5% of a named span is that span.** A pinch lands on 29.97 and never on 30, so an
exact match never fired: the picker read *30 days* while sitting next to an option that said
*1 month* — a control disagreeing with itself about the thing it was showing. Snapping also
makes the presets magnetic, which is what anyone who has dragged a guide already expects.

And it sets a trap that is worth knowing about, because the obvious implementation walks
straight into it. **If the next zoom is stepped from the value on screen, a step smaller than
the snap tolerance gets pulled back to the same preset every time, and the zoom cannot be
moved off a preset at all.** Coarse test gestures sail through it; a real trackpad emits
exactly those small steps, which is how it was found.

So there are two numbers. `zoomRaw` is what the gestures have asked for and is what every
step is applied to; `zoomDays` is what gets drawn, after snapping. The raw value keeps moving
underneath a preset the display is resting on, so the presets attract without capturing.
Measured on fine steps: pinching in passes *Plan → 1 month → 1 sprint*, dwelling about three
events on each, and carries on past.

**Panning was already built.** `#chart` has been `overflow-x:auto` since the beginning and
`render()` already preserved `scrollLeft` across every rebuild, so zoom is a scale change
and nothing else — no viewport model, no range inputs, no minimap.

### The centre of the view is the thing you were looking at

`render()` restoring `scrollLeft` is right for every other rebuild and wrong for this one:
the same pixel means a different date once the scale moves. So the zoom handler reads the
date at the centre before, and puts it back after. Zooming that dumps you at the left edge
costs you the exact thing you zoomed in to see.

It is view state, so it lives in the hash — same argument as the isolate lens. A link to
*the plan, at a month* should reopen as that.

### What day am I pointing at

The axis labels months and the sprint rules label sprints, and between them a bar's edge was
a pixel you estimated against the nearest tick — which gets *worse* as you zoom in, because
the ticks do not get denser as the days get wider.

So the pointer's date reads out in the gutter's corner: the one piece of chrome already
pinned to the left edge and otherwise empty. **Weekday first**, because on a five-day week
the weekday is half the answer — and a day nobody works says which kind it is, since
*Nov 26 · day off* and *Nov 28 · weekend* are different facts and a shaded band alone cannot
tell you which.

### The arrows layer was a ratchet

`drawArrows` sized its `<svg>` from `grid.scrollWidth`. The svg is a **child** of `#grid`, so
a too-wide svg kept the scroll extent too wide, which sized the svg wide again — it could
only ever grow. Nothing showed while `PPD` was a constant and the extent never had a reason
to shrink. Zoom out from two weeks to the whole plan and the chart still scrolled eighteen
thousand pixels into blank space it had nothing left to draw in.

Two changes, and they work together. `#grid` is now **told** its width — the gutter plus the
span at the current scale, both of which are already in hand — rather than having it inferred
from whatever its absolutely-positioned children overflowed by. And the svg reads
`offsetWidth`, which is the width it was told, so it can no longer feed itself.

Worth naming as a class of bug rather than an incident: a measurement taken from a container
you are also a child of is a feedback loop, and it stays invisible for exactly as long as
nothing ever asks the value to go *down*.

### Zoom broke the row labels, and they had been broken all along

The label column scrolled away with the chart. That was always true and never visible,
because at one fixed scale most plans fitted the window and nobody scrolled — the bug needed
a feature that makes scrolling normal before it could be seen. A Gantt row whose name has
slid off the left is a bar belonging to nobody, and the README already calls that column
**this chart's index**.

`position:sticky; left:0` on `.rowlabel` and `.lane-head` pins them, plus one opaque block
for the axis strip above them, which is otherwise a hole the shaded weekends slide through.
The check is `elementFromPoint` down the gutter rather than a bounding rect, for the reason
this file has needed it before: a rect inside the viewport is a weaker claim than a pixel
you can actually click.

## Work does not happen on weekends

`doc.workweek` is a 7-slot mask of which weekdays are worked and `doc.holidays` is a list of
dates nobody works. One `isWorking()` predicate answers both, because they are the same
question asked of a weekday and of a date.

**`dur` means WORKING days.** A plan that says neither of those things reads as the all-on
week, which is exactly what every duration written before this already meant — so nothing
migrated and there is no schema bump. `doc.workweek || ALL_ON` at the read sites is the same
shape as the optional channel arrays.

This is the v4 change presenting its bill. While the base unit was weeks the finest thing
anyone could say was half a week, every duration was at least 3.5 days, weekends were already
inside the estimate and the error hid in the rounding. A one-day task made it visible.

### A bar is as long as the work in it, so its width depends on when it starts

The axis stays calendar. `PPD = 54 / 7` does not move, the month rules stay real month
boundaries, and a milestone still sits on its own date. What changes is that **a duration and
a span are no longer the same number**, and the difference depends on the weekday:

| duration | starting Monday | starting Thursday |
|---|---|---|
| 3 working days | 3 calendar days | 5 |
| 5 working days | 5 calendar days (Mon–Fri) | 7 |
| 15 working days | 19 calendar days | 21 |

Note the row that surprises people: three working weeks of work is **19** calendar days from a
Monday, not 21. Work stops on the Friday; the weekend after it belongs to nobody. A sprint is
three *calendar* weeks and stays 21 days, and the two only coincide when the work starts
mid-week.

Compressing the axis so that bar width tracks work instead was the alternative, and it costs
the month rules, the milestone positions, the TODAY line and the no-zoom-control property — to
buy an answer to *how many working days across*, which nobody asks this chart. The only
question it exists for is *does this land before Nov 18*, and that is a calendar question.

The README's own rule, one level up: the base unit is not the display unit, and now the
**input** unit is not the **axis** unit either.

### Two units, so two formatters

`durStr` was handed a task's duration and a lane's load — **working** days — and also every
milestone slack — **calendar** days. One formatter was right for both only while they were the
same number. `weekStr(n, per)` does the work now and the two units have their own names.

**Slack stays calendar on purpose.** *Nine days before Nov 18* is a claim about the date;
restating it in working days would answer a question nobody asked and understate the wall-clock
room. The visible consequence of the split is that a lane holding 28 working days stops saying
*4 wks* and starts saying *28 days*, because 28 is not a whole number of five-day weeks — which
is the honest answer, and the old one was only ever right by coincidence.

### A task cannot begin on a day nobody works

It snaps forward, and the snap happens **inside** the scheduler's estimate rather than after it
picks a winner. The loop's contract is the earliest *feasible* start, and choosing on an
unsnapped Saturday is choosing on a date the task cannot have.

The consequence is not obvious and is worth knowing: **weekends collapse two candidate days
into one, so ties get markedly more common.** Array order already breaks ties and is visible as
*drag a bar up its lane to do it first* — that control is doing more work under a five-day week
than it ever did under a seven-day one. The reference plan pins the behaviour with a pair of
tasks constrained to a Saturday and a Sunday in the wrong order, which come out swapped if the
snap is moved after the choice.

### The audit gained the assertion that catches everything

*Cannot end on a non-working day* is unfalsifiable once the span walk only ever spends working
days — the last day worked is a working day by construction. The invariant behind it is not:

**a task's calendar span must contain exactly its duration in working days.**

That is the single check that fails if `spanOf` is wrong in any direction, and it sits beside a
cheaper one that catches a snap which went the wrong way or not at all. The end of a task stays
the **exclusive** boundary, so `end = start + span` and both the dependency check and the
capacity sweep keep the shape they had. An exclusive end landing on a Saturday is correct and
invisible: it means work stopped on the Friday.

### ALAP slides by whole weeks, and that is the one branch

The right-alignment slides the whole picture without rescheduling it, which is sound while any
two days are interchangeable. Once a week has holes in it, sliding by an arbitrary number of
days draws bars at widths their positions no longer justify — the span depends on the weekday
— and can land a start on a Saturday the scheduler just refused.

A multiple of seven moves every task to the weekday it already had, so every span survives and
every start stays legal. It costs up to six days of alignment precision, given up in the safe
direction: the chart shows work starting slightly earlier than it strictly had to. The
milestone chips keep reporting the **true** slack, because the slack is the fact and the
alignment is only a drawing choice.

**And this is the single place the working week could not be expressed without a branch.** With
no non-working days there is nothing to preserve, and quantising there would re-align every
plan written before this by up to six days for no reason at all. One branch, in one place, with
a name: *a translation is only free when every day is alike.* Better said than disguised as
configuration.

### Days off are the same question asked of a date

Holidays ship with the working week because the mechanism is already there, and they are cheap
only while they stay boring — a flat list of dates on the document, no per-team scope, no
ranges, no names.

So the test for anything proposed into that list later is: **is it a property of the DAY, or a
property of the TASK?** A change freeze is the second kind. It blocks *deploying* while other
work continues, it belongs to a team, and it is a period rather than a date. Same data shape,
different meaning, and unifying them is the trap this paragraph exists to name.

### Non-working days are drawn, faintly

A bar that crosses a weekend is wider than its duration, and on a chart whose whole argument is
that it contains no unexplained discrepancies, that gap needed a reason visible on the chart
rather than buried in a tooltip. One band per **run** of non-working days: a weekend reads as
one gap, and a day off touching a weekend reads as one longer gap, which is what it is to the
people living through it.

Notching the bars instead was rejected — it spends the bar's encoding budget, which the fill and
pattern channels are already using for data. A plan with a calendar week draws no bands at all
and is pixel-identical to every chart made before this existed.

### Both drags had to learn the difference

**The grip** added the dragged pixels straight onto `dur`, which was right only while a span and
a duration were the same quantity — drag an edge across a weekend and it claimed two days of
work nobody was going to do. The pointer now says where the *end* goes and the answer is how
much work fits between the start and there, so the edge **sticks** through non-working days and
then jumps. Honest rather than smooth, and self-explaining once the bands are drawn: the edge is
parked over days that cannot take any work.

**The pin snaps forward, or it silently vanishes.** The existing rule hands a constraint back
whenever the scheduler placed the task later than it — *then the floor is not what is holding
it* — and snapping makes that true of every weekend drop, so dropping a pin on a Saturday would
have looked exactly like the drag doing nothing. Moving the pin instead puts it on a date work
could actually begin, which is all a start constraint has ever meant, and leaves that rule
completely alone.

### What stays legal

**A plan can start on a Saturday.** `doc.start` is a coordinate origin, not a start of work; the
first task simply snaps to Monday.

**A milestone can fall on a Saturday**, and it comes out right for free. Slack is calendar days,
so an exclusive finish of Saturday against a Saturday deadline is zero slack — *exactly on time*
— meaning the work ended on the Friday. Refusing a Saturday deadline would be the tool refusing
a real contract date.

**A week with no working days is refused.** It makes the span walk run forever: a hang, not an
error. The floor is one working day, and the last one left is not an arbitrary value to protect
— it is the only day any work in the plan is happening on.

An unusual week is fine. Monday and Thursday only, for a two-day-a-week contractor, touches
nothing but the week-collapse in `durStr`, which reads the working-days-per-week count and lands
correctly at 5, at 7 and at 2.

### Per-lane working weeks are deliberately not here

The offshore team on Sun–Thu beside the Mon–Fri team is a real want, and the mask is
document-global anyway. Not because per-lane is wrong but because it is a strict **superset**:
the field moves from the document to the lane with the document value as its default, and
nothing built here has to be unbuilt to get there. That is what made it safe to defer rather
than guess at.

## Actuals — started, done, and comparing against an older save

Two nullable dates on a task, `actualStart` and `actualEnd`. Everything else in this
section falls out of them, and the reason it is a section rather than a bullet is that
adding them is not a display feature.

### An actual start is an input, not an overlay

**This tool stores no start dates.** `sched()` computes every one from four things:
durations, dependencies, lane capacity and `notBefore`. So there is no "planned start"
field to draw an actual next to — the planned start is an *output*, recomputed on every
edit, stored nowhere.

That kills the obvious design. You cannot draw planned-vs-actual as two bars read from two
stored fields, because only one of them exists.

So **an actual start is an input to the scheduler, and a stronger one than `notBefore`.**
`notBefore` is a floor: inside `sched()` it is one term in a `Math.max`, and a dependency
or a busy lane can push a task past it. An actual start is not a floor, it is a fact. It
says *exactly here*, and it overrides the dependency arithmetic and the lane queue rather
than joining them — a pinned task is **seeded before the loop begins** and never solved
for. The lane still fills up, because the team was still busy, by `Math.max` rather than
assignment: two pinned tasks can share a slot the capacity says holds one, and the second
must not pull the lane's busy-until backwards.

**And a pinned start is not snapped.** `snapFwd` exists because a *forecast* cannot begin
on a day nobody works. Work that really did start on a Saturday did, and moving it to the
Monday is inventing a date. Forecasts get snapped; facts do not.

An actual **end** does the same to the other side, and it is one branch at the top of
`spanOf` — because the working week already pulled `end = start + dur` out of nine places
into that one function, every site that needs the end of a task already asks. `dur` stays
in the document as the estimate that turned out to be wrong, which is worth keeping, and
stops driving the bar. With only a start, the task is in progress and the estimate is still
the best thing anyone has, so the walk runs from the real start.

This is the same test the `notBefore` section applies: *if a reschedule would silently
invalidate it, it is a cached position wearing a disguise.* A reschedule cannot invalidate
"we started on the 3rd".

### A forecast cannot begin in the past

The other half of the same idea, and it was missing for as long as `sched()` existed.
`sched()` answered *earliest feasible start* counting from day 0, and **day 0 never moves**
— so a task with no predecessors kept claiming the plan's start date however long ago that
was. On the reference plan three days after its start, nine tasks were drawn as three days
into work nobody had recorded, every dependent inherited the head start, and the finish
date and every milestone chip were optimistic by the same three days. The chart was not a
forecast. It was a forecast **as of the day the plan was written**, presented as current,
getting one day more wrong every morning.

So `today` is a fourth term in the `Math.max`, and the rule is one line: **a forecast that
has not started cannot have started in the past.** Work that really began is seeded before
the loop and never reaches the term, so a fact is never moved by the clock — only a guess
is, and a guess about the past is not a guess.

**In-progress work is left exactly alone**, including when its estimated *end* is already
behind us. Its start is a fact and stays pinned; an estimate that has been overtaken is
information, not an error to paper over, and stretching the bar to today would erase the
miss the elapsed strip exists to show.

**It is a parameter, not a clock read inside the function.** `sched(tasks, lanes, cal,
today = -Infinity)` — same reasoning as `lanes` and `cal`: `selftest()` and
`verify.sched.mjs` schedule hardcoded reference plans whose answers must not change because
a day passed, and they pass `-Infinity` to opt out. A wall clock reaching implicitly into
the one function that must be exactly right is how a suite starts failing overnight on
nothing. The page's wrapper defaults it to `todayD()`, which is document-relative, so an
archived version behind the comparison lens floors against **its own** origin.

**And a negative floor changes nothing**, which is what makes this safe rather than merely
stricter: a plan dated next month has a negative `today`, `Math.max` discards it, and the
plan schedules exactly as it always did. That case is the falsifier in the test.

`/verdict` and `suggestReorders` apply the same floor, or an agent asking "what does this
land on" gets the stale, cheerful number while the room reads the honest one.

### Status is derived, never stored

| `actualStart` | `actualEnd` | state |
|---|---|---|
| — | — | not started |
| set | — | in progress |
| set | set | done |

**There is no status field and there must not be one.** A stored status can disagree with
the dates — someone marks a task Done while its finish is empty — and a chart reading
"Done" beside dates that say otherwise is the same failure class as one titled "fits Nov
18" while landing Dec 2. Derived from two dates, the state cannot contradict itself,
because there is nothing for it to contradict.

**The one hole the table does not cover is a future start**, which reads as in-progress
work nobody has begun. It is refused at entry, and the refusal names the field that does
want a future date: an intention to start next Tuesday is a `notBefore`.

The finish field is disabled until there is a start, and clearing the start clears the
finish with it. An end on its own is a date nothing reads — invisible stored state, which
is the shape of bug this file keeps recording.

### A forecast is audited; a fact is reported

`auditSchedule()` asks four questions, and every one is a question about whether a plan is
*possible*:

| rule | what actuals do to it |
|---|---|
| a task starts before something it waits on has ended | fires — work really does start early |
| a lane runs over capacity | fires — a team really did run three at once |
| a task starts on a non-working day | fires on any Saturday anyone worked |
| **a task's span holds exactly `dur` working days** | **fires on every completed task** |

The last is the assertion that proves `spanOf` is right in any direction, and an actual end
makes it false **by design** — the whole point is that the estimate was wrong. So the rule
is mechanical: **every one of the four is skipped for a task with an `actualStart`, the
capacity sweep included.** That is not leniency. A check that fires on every honest plan is
one you stop reading, and then it cannot tell you about the forecast either.

`REFERENCE_ACT` is the fixture, and it is the only one whose starts are **hand-written
rather than solved for**: a schedule is what we forecast, and this is where the work
landed. The audit is run against that map directly and must be silent; `sched()` is
separately required to arrive at exactly the same map.

### The tail slides, the past does not

The ALAP right-alignment adds one `SHIFT` scalar to every bar. That is a drawing choice
about where work sits inside its slack, and work that has already started has none — it is
on the date it happened. So the shift is per task: `shiftOf(t)` is `SHIFT` for a forecast
and **0** for anything with an `actualStart`. Five read sites: the bar's left edge, its
tooltip, `POS`, the inspector's starts/ends line, and the chart's horizontal extent.

The whole-week quantum is untouched and now has a smaller job. It exists so a slide leaves
every task on the weekday its span was measured from; a pinned task's span comes from its
own two dates, so there was never anything there to preserve.

The extent needed thought rather than a substitution. `fin + shift` assumed every bar moved
together and over-reserves a month of empty calendar whenever the plan's last work is
pinned. It is left-plus-width summed the way the bars are actually drawn — deliberately
*not* `endOf(t, shifted)`, because a bar's **width** comes from the unshifted span, and
asking the calendar again from the shifted start answers a different question the moment a
holiday sits between the two.

**And an actual start can be negative**, which nothing else here can be. Every start
`sched()` computes is at or after day 0 by construction, so until work could be recorded as
already done there was no way for a bar to want the left of the origin — work begun before
the plan's start date rendered behind the row-label gutter. `LO` makes room for it, the
same way it already did for a TODAY that went negative.

### The strip, and it means one thing per chart

**A thin 3px strip in the row's existing slack.** A full-height bar is 18px at `top:4px`
inside a 26px row, so the 4px underneath was already doing nothing — the strip costs the
chart no space at all. It is a *sibling* of the bar rather than a child, because it can run
past the bar's right-hand edge, and `pointer-events:none` for the same reason the colour
bands have it: a mark must never swallow the drag.

**It is the comparison while one is on, and elapsed while none is.** They never mix within
a chart, so the reading is learned once; the chip in the top bar and the one beside **Whole
plan** both name the version, and both strips are named in the tooltip. Elapsed loses to a
comparison on purpose — elapsed is already readable as the gap between a bar's left edge and
the TODAY line, and an older version's position is readable from nowhere at all.

**In progress draws ELAPSED, not percent complete.** With a start and no finish, how much
*time* has passed is something the document knows and that cannot go stale. How much *work*
is done it does not know, and a stored percentage is the field most likely to rot — nobody
updates one between meetings. The cost, stated rather than hidden: a task can be 90%
elapsed and 10% done and this chart will not know. *Reopens if someone starts actually
tracking completion.*

**Skipped in the squeezed fold.** That state divides bar height between tracks, so the 4px
is not there, and shrinking the strip to fit would turn a reading into a decoration — the
same trade that state already makes with the grip.

Two extents on two rows of pixels handle every relationship without ambiguity: longer,
shorter, later, earlier, or not overlapping at all. The alternative — a **ghost outline bar
behind** the real one — was rejected for the case that matters most: when a task has
slipped so far the two do not overlap, a ghost reads as two tasks, and when they partly
overlap the eye has to separate two stacked rectangles sharing a fill and a hatch.

**Done-ness is the row label struck through.** Position and length are the dates, hue is
the system, the rim is the environment, the texture is the confidence, and opacity belongs
to the filter — the label was the one channel left that costs the chart nothing.

**Which formatter?** An observed *duration* is work, so `durStr`. An observed *elapsed
span*, and any variance, are wall clock, so `calStr`. Getting this backwards is easy and
silent — see above on why there are two.

### The estimate, on a finished bar

A finished bar is drawn at **what really happened** — `spanOf` returns the observed span
and stops reading `dur` — so the estimate sits in the document and appears on screen
nowhere. A tick marks where it said the work would end: **inside the bar means it overran**,
**past the right edge with a dashed whisker means it beat the estimate**, and landing
exactly on the edge says so in muted grey.

**This is the planned-versus-actual that needs no baseline**, and that is the whole reason
it exists. History → Compare answers a different question — *did this bar move* — which
depends on the rest of the schedule and so needs a version saved **before** the work
started. Enter your actuals after the fact and that variance is unrecoverable. *Was the
estimate right* needs none of it: `dur` and the two actual dates are all already here.

**Nothing is converted between units.** `dur` is an amount of work and an observed span is
wall clock, and mixing them is the silent mistake. So the estimate is re-walked over the
calendar from the **real** start, by the same `spanOf` the scheduler uses with the actuals
stripped — *"if it had taken as long as we thought, starting when it really started"*. The
inspector quotes the same calendar space, so the number and the mark cannot tell two
stories.

**A tick rather than a ghost bar.** Both extents share a left edge, so the estimate is
described completely by a single x-coordinate; a translucent second bar spends a hundred
pixels saying it and reads as a halo when the overrun is small. And it could not go in the
4px strip: there the strip is reality and the bar is the plan, so putting the estimate in
it flips that polarity on the same mark. It is a sibling of `.shape` like the grip, so a
pointed shape cannot clip it.

**Nothing is drawn for a task still in progress**, because its bar already *is* the
estimate walked from the real start — the elapsed strip overhanging the right edge is that
same overrun, already visible. The mark exists precisely where the bar stops being the plan.

One honest limit: `dur` stays editable after a task is done, so the variance is only as
true as the discipline of not tidying the estimate afterwards. It also means editing
**Duration** on a finished task finally does something visible again — it moved nothing at
all before this.

### The comparison stopped being stored, and the rule is why

Once actuals pin the schedule, **the planned position is gone.** The reflow already
happened and the dates the plan used to predict are recorded nowhere. So planned-vs-actual
needs an immutable past state to measure against.

This used to be `doc.baseline` — one snapshot per plan, frozen by a button, written into the
document, destructive to replace. The rule that justified storing it still holds, word for
word: **a comparison must not track current state — that is its entire job. One that
silently recomputes is worse than none, because it will always show zero variance and look
like good news.**

**What changed is where an immutable past state comes from.** When that was written, the
only way to have one was to freeze a copy, and the only place to put a copy was the
document. Every Save now archives the whole document, so the plan's own history *is* a list
of immutable past states — and the rule is satisfied by **pointing at one** rather than by
copying it. A version cannot drift because a version cannot change.

The old note even named its own reopening condition: *"Many is a list, a picker, a
comparison mode and a different, larger tool. Reopens when there is a meeting that needs the
other."* History is the list and the picker, so it reopened.

So the comparison is a **lens**, not a field:

- the source is a saved version — **History → Compare** on any row, toggled off from the
  chip in the top bar
- it lives in memory, and its identity lives in the **URL hash** beside the other eight keys
  of view state, so a refresh keeps it and the document stays clean
- switching is free and reversible, so the *"there is one of them and no undo"* confirm is
  gone — the last destructive confirm in the tool went with it
- it survives Revert and survives opening a version, because both re-adopt the same plan.
  That last one is the interesting case: **open v6 and compare against v4** and you are
  looking at two arbitrary versions at once, which the single stored baseline could not do
- it drops when you switch plans, because a version number means nothing against a different
  plan's archive

**The strips are a property of a RENDER, not of a document**, which is why deriving them is
not three lines. They need `st` and `SHIFT` — the ALAP alignment, a drawing choice made
against the tightest milestone — and only `renderInner()` fills those. So `stripsFrom()`
points the globals at the archived version, runs **one real render pass**, and puts
everything back. Reusing the pipeline rather than transcribing the alignment maths is the
whole point: a second copy of that calculation is a second copy that can disagree, and the
note above it records what that cost last time — 11 of 38 bars recorded 4–11px off the bar
anybody had actually looked at.

**Still derived in ISO dates, not day numbers.** Every other coordinate counts from
`doc.start`, which is editable — and the two documents being compared can now have
*different* start dates, which makes day numbers not merely fragile but meaningless across
the pair. And it still records the **drawn** extent, shift included, because what it is a
record of is the chart people looked at; comparing today's shifted bar against an unshifted
snapshot would report movement for work that never moved.

**The demo cannot do this**, and that is the accepted cost. Save refuses the fixture, so it
has no history and therefore nothing to compare against. Fork it, save twice, and the copy
has both.

The inspector reports **two** numbers, not one, because a bar can move without changing
length and change length without moving. Saying only the first reported *"on the plan of
record"* for a bar that had since doubled. Tasks added after the capture draw no strip, and
the inspector says so rather than leaving a blank.

### Typed, not dragged

The bar already means three things under a pointer — body is the constraint, grip is the
duration, vertical is the queue — and a fourth gesture would be one too many. So the fields
copy **Not before** exactly: a `<input type="date">` converting through `dayOf` / `isoOf`,
and a `×` to take it back off. Plus **Mark done**, which writes today into whichever of the
two is missing, and is coherent *only* because done-ness is two dates — next to a stored
percentage it would have to guess which number means finished.

**Finished holds the last day worked and stores the exclusive boundary after it**,
converting by one day at that one input. Storing the human's number instead would make it
the only inclusive date in the document, which is a worse trade than one ±1 where a human
types. That made an old inconsistency visible: the inspector's *ends* line named the raw
exclusive boundary while sitting one control away from the new field, so two dates a day
apart claimed to be the same fact. It reads through `fmtEnd` now — which already existed
and says exactly this in its own comment.

**Two gestures are refused**, because one that silently does nothing is the invisible-state
bug this tool keeps finding. The **body drag** on a started bar would store a `notBefore`
the scheduler no longer consults, and the bar would sit still while you dragged it. The
**grip** on a finished bar would edit an estimate that no longer draws anything. Both say
so. (Both also leave nothing selected, which is not new: a drag that changes nothing never
re-renders, so the click after the pointerup reaches `#chart`, whose click means deselect.)

### What must not be built

A fresh reader will propose at least one of these:

- **A `status` field.** Status is derived from two dates and cannot contradict itself.
- **A stored planned start.** There isn't one and there must not be one. Nothing derived is
  stored any more, now that the comparison points at a version instead of freezing a copy.
- **A schema bump.** `SCHEMA` is 4. `actualStart` and `actualEnd` are absent-means-none, the
  same `doc[key] || []` shape the optional channel arrays use. Removing `doc.baseline` needed
  no rung either: there were zero stored baselines in any plan, any archived version or any
  backup when it went. A no-op migration rung is a rung that exists to be tested.
- **A recomputing comparison.** Measuring against anything that tracks current state always
  looks like good news. A saved version cannot track it, which is the whole reason it is
  allowed to be the source.

### Not covered

Dependency lag, effort-vs-elapsed, owners, and cost. **Change freezes** stay half-answered:
a working calendar already says whether work happens on a day and `doc.holidays` is the
list, but a freeze needs per-team scope and a period rather than a date — and the test for
anything proposed into that list is still whether it is a property of the DAY or of the
TASK.

## The graph lens — what waits on what

**⚙ is not the door; the top bar is.** *View · Timeline / Graph.* Same plan, same
schedule, same selection, same legend filter, same chain focus, same inspector. Nothing
in the graph writes to the document and nothing in it can move a date.

### Why a second view at all, and it is not "graphs are nice"

The timeline answers **when**, using the two encodings this file calls load-bearing:
position and length are the dates. Everything else is spent — hue is the system, the rim
is the environment, the texture is the confidence, opacity belongs to the filter, and
*shape was what was left, and there is nothing after it*.

So the argument for a second view is not aesthetic, it is arithmetic: **there is no
channel left to answer a new question in.** A question the timeline cannot already
express needs new *geometry*. "What waits on what" is that question, and the evidence it
was always underserved is already in this file — the two arrow-depth budgets and the ⊙
chain lens exist precisely because on a plan of any size the dependency lines cross the
whole chart.

**What it gives up, stated rather than discovered: position stops meaning time.** That is
the entire trade, and it is why this is a switch rather than a split screen — two views
that disagree about what an x-coordinate means cannot share a mental model, so you go to
one deliberately rather than reading both at once.

### The layout, and the two stages that earned their place

The first version was a column per dependency depth with each column sorted by the average
row of what it waits on. It measured **186 crossing edges** on a real 39-task plan, and
"chaos" was a fair description. The fix was not tuning. In order:

**1. Columns are the longest path, not the shortest.** Breadth-first depth puts a task in
the first column that can reach it, so an edge arriving from a longer chain points
*backwards* on screen. Longest-path layering makes every edge point the same way, which is
the whole reason to draw this as columns.

**2. A long edge is broken into bends, one per column it crosses.** This was the missing
piece and it is structural rather than an optimisation: **an edge spanning four columns is
invisible to the three columns it passes over.** Nothing in them knows it is there, nothing
leaves room for it, and it is free to slice through everything between its ends. Sorting
harder cannot fix an edge nobody can see. With bends, every edge spans exactly one column,
every column in between carries a placeholder that takes part in its own ordering, and a
corridor gets reserved for the edge to travel down.

> **And the edges have to be DRAWN through them.** Reserving a corridor and then drawing
> the edge straight from end to end — which is what the first attempt did — optimises a
> model the picture does not follow. Measured crossings went 137 → 134 and the chart looked
> identical. Each dependency is a chain of segments now, with the arrowhead on the last one,
> so what is optimised and what is drawn are the same thing.

**3. Sweep down, sweep up, keep the best.** Each column is ordered by the *median* row of
its neighbours in the column just fixed — median rather than mean, because a mean is dragged
around by one distant neighbour, which is exactly what a long chain produces. A sweep is a
heuristic and can make things worse, so the best ordering seen is kept rather than the last;
that also keeps the result deterministic, which `preset` exists to guarantee.

> **Reindex after every column, not after the whole sweep.** A sweep is a chain of
> decisions — column 2 is ordered against the column 1 that was just fixed — so reindexing
> at the end means every column after the first reads positions one sweep out of date. It
> looks like it works, because the numbers still move. They just stop going down.

Result on identical data: **186 → 69** crossings on the 39-task plan, **128 → 34** on
another, 1 → 1 on the demo.

### The stage that did not earn its place

The obvious next step is proper coordinate assignment — pull each node toward the median of
its neighbours so long edges come out horizontal. It is the fourth stage of the standard
method, and this file does not have it, because it was built and then deleted.

**It left the crossings exactly unchanged and made the drawing half as tall again** — 14
rows to 24 on one plan, 11 to 16 on the other. Straightening a long edge means reserving a
clear lane for it, and the real work gets shoved apart to make the room. Every layout knob
trades something; this one traded the whole page.

`cytoscape-dagre` was measured too, since not reinventing a layout engine is the obvious
call. On the same plan it drew 68 crossings against this file's 69 — a tie — in a picture
with no visible column structure and long edges cut straight across the nodes between their
ends, because it does its own ranking and does not route. The dependency was not worth a
tie, so there isn't one.

If either comes back it needs to beat the numbers above, which is why every draw records
them.

### Group by, when a plan is really several plans

**Show · Group by.** Each value of a channel keeps its work in its own horizontal band, and
ordering happens inside the bands. On a plan that is really three parallel efforts sharing a
few dependencies, this is the difference between a mesh and a few readable ribbons.

**It is a control rather than a default because whether it helps depends entirely on the
plan, and the difference is not subtle.** Banding the real plan by *application* came out a
quarter shorter for the same crossings. Banding the same plan by *team* took it from 69
crossings to 234 — work flows across teams, so banding by team fights the structure the
graph exists to show.

So the crossing count is on the label next to the task and dependency counts. A control
whose effect you cannot see is a control you cannot use, and this tool already puts
`count·weeks` on every legend value.

### Scoped to what you clicked

**Show · Whole plan / Selected chain.** The scope control writes `chainFocus` — the *same*
state the inspector's chain button sets, not a second copy. Two controls over one piece of
state is fine; two pieces of state meaning the same thing is what this file has a scar
about. So scoping the graph scopes the timeline, and the ⊙ works from either side.

Edge colour is the timeline's own, read through `arrowStyle`, so a plan carrying its own
convention carries it into both views: blue upstream, green downstream. And it is
**unbounded** rather than depth-limited, which is exactly the carve-out the arrow depth
budgets already name for themselves — this lens *is* "show me the whole chain", asked once
and on purpose.

Done-ness is a struck-through label here too, for the reason it is one on the row label:
every other channel already means something.

### The library loads on first use

`cytoscape` is imported dynamically the first time the view is opened. The timeline is the
default and works with no network at all, and making every page load fetch a graph library
for a view most sessions never open would be a tax on the common case. A failure is
reported inside the panel rather than thrown — losing the graph must not take the timeline
down with it, and the message says the dates on the timeline are unaffected.

### The view says what it drew, and how tangled it is

A canvas cannot be asked. Every other surface here is DOM and can be interrogated — a bar
has a class, a chip has a data attribute — so a verification run has something to hold and
something to fail on. Cytoscape paints pixels. So `#cy` carries a `data-graph` summary of
what it just drew: node and edge counts, the selection, how many nodes are dimmed, how many
are done or in progress, whether a chain is scoped, how many columns, **how many edge
crossings, and how many rows tall**. It is the view stating its own result, the same way
every legend value carries its `count·weeks` — not a hook that exists only for the tests.

Those last two are what made "this looks like chaos" answerable. A layout can trade
crossings for a page of white space and call it an improvement, so both get reported — and
every claim in the section above is a number that was measured rather than an argument that
sounded right, including the two that went against what I expected.

**The layout is tested in `verify.sched.mjs`, not in the browser suite**, which is worth
saying because the browser looks like where it belongs. The demo is twelve tasks in a
near-straight line: it draws one crossing with the layered ordering and one with the
ordering deliberately switched off, so any threshold put on it is an assertion that cannot
fail — confirmed by breaking the code and watching it pass. The harness builds a graph that
is genuinely tangled, six columns of six wired so the obvious order is the worst one, and
asserts 88 crossings laid out naively against 0 after ordering. Break the bend routing or
the sweeps and it fails.

## The base unit is days (schema v4)

One day used to be `1/7` — not representable in binary, so a chain of them accumulated error
and *does this milestone make it* rode on an epsilon. (The `1e-9` tolerances in
`auditSchedule` are the fossil.) Integer days compare exactly, and a one-day task became
something you can type.

**Not hours.** The moment the atom is finer than a day you owe the user working hours,
weekends, holidays and time zones — a 4-hour task starting 4pm Friday does not end at 8pm
Friday in any plan a human believes. This tool has no calendar semantics beyond "a week is 7
days" and lane capacity, so hours would buy precision nobody plans at and cost the entire
non-working-time model.

**The base unit is not the display unit.** `durStr` shows weeks when the number *is* weeks and
days when it is not — so a plan whose durations were all whole weeks says exactly what it said
before, and only the tasks that could not be said in weeks start speaking days. `sprint.weeks`
stays in weeks in the document, because a sprint *is* a number of weeks; it converts at the one
place that renders it.

**No zoom control was needed *for this change***, and that is not luck: `PPD = 54 / 7` kept
every bar exactly the width it was, so the chart was pixel-identical across it. (One is
needed now, for an unrelated reason — see below. The claim here is about the migration, and
it still holds.) The migration is lossless
— half a week was the finest thing the old unit could say and `0.5 * 7 = 3.5` is exact in
binary — so every plan came out more precise than it went in.

One gotcha worth naming: the month axis had an **inline copy** of the old conversion
(`/ (7 * DAY)`) rather than a call to it, so it survived a rename that moved every other site
and drew two years of ticks under a four-month chart. It goes through `dayOfDate` now.

## Unassigned is not a state (schema v3)

Every task points at a real value in every channel. **Colour is the one exception** — `[]` is
not a missing answer, it is the honest bottom of a *list*: a task can genuinely touch no
system, and a "no system" entry in a multi-select would read as a system you tick alongside
the real ones.

What this replaced was four channels with four different rules: `border` was nullable **and**
had a value styled `none` (two ways to say one thing), `fill` was nullable and silently
*drawn* as `fills[0]` while being *counted* as none of them, `shape` was nullable with an
explicit "—", and `lane` could not be null at all.

### The migration rule is "preserve appearance", not "assign the first value"

That difference is not academic. In every plan in this repo three tasks carry no border and
`borders[0]` is **dev** — assigning the first value would have grown them a dotted rim they
never had and moved dev's legend count from 10 to 13. A migration that relabels data is worse
than the incoherence it removes. So, per channel:

- **borders** — a null border drew *no rim*, and a value styled `none` draws exactly that. The
  target is that value: reused if the plan has one, created if not.
- **fills** — a different rule, because a null fill did *not* draw as nothing. It fell back to
  `fills[0]`, so the honest target is the value it was already being drawn as. No default is
  designated: "how sure are we" always applies, so there is no not-applicable fill.
- **shapes** — the channel is simply absent from every plan written before it existed, where a
  null shape drew as `soft`. One `soft` value for the whole plan reproduces that, and at one
  value it draws no UI at all.
- **lanes** — already total; a task with no lane has no row to sit in.

### The not-applicable value is designated, not first — and settable

The ○ / ● toggle in each row of Border, Fill and Shape sets it, and clicking the marked one
says *this plan has no not-applicable value at all*. Not offered on **Lanes** (every task has
to sit in a queue; "no lane" is not a thing a row can be) or on **Colour** (that channel says
it with an empty list, which is why it needed a configurable neutral hue instead).

`doc.noColor` is that hue — **what a task with no system looks like**, edited on the Colour
channel's header. Colour is the one channel that cannot express its neutral as a *value*,
because the neutral is `[]`; every other channel gets the same effect by keeping one value and
styling it.


`doc.defaults[channel]` holds an **id**, so reordering values with ↑/↓ cannot silently change
which one means "not applicable". Position in these lists already means something else — the
border ramp reads dev → prod down the list — which is exactly why this is not "the first one".
It is set only where the migration actually *had* somewhere to put an unassigned task: a plan
that already answers every channel on every task has no not-applicable value, and inventing
one would put a meaningless entry in its legend.

It is what an unassigned task lands on, what a **new** task with nothing selected takes, and
where a deleted value's tasks are reassigned. `add()` used to hand a new task `border: null`;
handing it `borders[0]` instead would have a brand-new task claiming an environment nobody put
it in.

### What it buys

`fillDef` loses its `|| fills[0]` fallback — the path that drew a task as "known" while the
tally said nothing did. The inspector's dropdowns lose their blank "unset" option, because
clearing a task's environment is now *picking the "—" value*, not emptying a field. And every
channel's legend counts provably sum to the task count, not just fills: on `v5-monitoring` the
border row now reads `dev 10 · QA 13 · prod 11 · — 3` = 37, where those last three tasks
previously had no environment **and no way to see that they didn't**.

### The colour picker is `position:fixed`, and that is not a style choice

`#insp` is `overflow-y:auto` with a 44vh cap, the picker opens *upward*, and an absolutely
positioned child of a scroll container is **clipped by it** — so on a plan with more than two
or three colours everything above the panel's own top edge was simply not drawn. You saw the
first item or two, cut off dead level with the panel. `position:fixed` leaves that clip; the
price is that "above the button" becomes something to measure rather than declare, and that
the panel scrolling has to close it.

## Where plans live

**One store at a time, never two**, chosen when the page loads and named in the toolbar next
to **Store**.

| | when | where |
|---|---|---|
| **files** | a backend is answering | `data/*.json`, one file per plan |
| **this browser only** | no backend — a static host, or you switched | `localStorage`, one key per plan |

The **Store** control switches between them where both are available. Switching moves
nothing: the picker reloads from the other store and plans in the one you left are simply
not listed until you go back. Carrying work across is **Export** / **Import**, which is
explicit on purpose.

Two writable stores at once is deliberately not offered. It sounds convenient and its
failure is silent — you edit, you Save, the browser copy takes it, and the file on disk
never changes.

`data/` is **not in this repo**, and that is the point: it is a location, not a checked-in
folder. Set `TIMELINE_DATA_DIR` to put it anywhere; it defaults to `./data`, which is
gitignored. Real plans have a habit of being someone else's business.

**Save is always explicit.** No autosave — this tool gets driven live in front of people and
"I broke it, Revert" has to keep working. Closing the tab with unsaved changes asks first.

### The demo plan

`demo.json` is tracked, invented, and loads when the store is empty. **It is also always in
the picker**, as a synthetic entry — it lives beside `index.html` rather than in the store, so
`store.list()` cannot see it, which meant that the moment you had one real plan on disk there
was no route back to the demo from the UI at all. `?demo`, an empty store and the **?** door
all still reached it, which is exactly the kind of technically-reachable that reads as broken
to someone looking at a dropdown. `refreshPicker()` still *returns* only the real plans,
because its callers use the list to answer "does this store have anything in it". Twelve tasks opening a
second bakery: four teams with one at capacity 2, a six-deep dependency chain, all three
confidence fills, a start constraint, one genuinely two-system task (the espresso bar is
front-of-house counter *and* kitchen plumbing, so its bar splits), two shape values (the
permits and the inspection are on someone else's calendar, so they point), and two
milestones with one met and one missed.

It does three jobs. It is what a stranger sees. It is the fixture the verification suite
drives, so the suite's numbers are constants rather than a reading of whatever plan you last
edited. And it is the stage for the walkthrough.

### Export and import

Two scopes: **Export** writes the plan you are looking at, **Export all** writes every plan in
the current store as one file. **Import** accepts either shape. If an id already exists you
are asked — OK overwrites, Cancel skips that one — because silently overwriting loses a plan
with no undo across a page load, and silently renaming leaves you hunting for it.

### Migrations

Documents outlive the assumptions you wrote them under, and these are not all in one place:
files on a disk, a browser nobody opens for a year, a file a colleague kept. So migration is a
property of **loading** a document — file, browser, demo or import alike.

A `schemaVersion` integer and an ordered list of pure functions in `MIGRATIONS`. The loop
chains, so a document from ten versions ago walks every rung in order and arrives current.
Append only; never renumber and never edit a shipped migration, because a document in
someone's browser depends on the ladder that existed when it was written.

**v1 → v2 widened `task.color` to a list.** Widening rather than renaming: the field keeps
its name and a v1 value becomes a one-element list, so a plan that never needed this is
unchanged in meaning and every read site sees one shape. A `null` colour becomes `[]`, which
is a real state ("no system"), not an error.

What a migration **cannot** do is unpick a combined value — `"Rates API & MOAuth"` is one
opaque id, and nothing in the document says it means two others. That is an edit, not a
migration. `colorsOf()` also tolerates the pre-v2 string forever, so a hand-edited file or a
half-applied paste renders instead of throwing.

**New** starts an empty plan; **Fork** copies the current one. Both write immediately.

## The one thing that must not break

`sched()` in `index.html` is the load-bearing part of this tool: if it is wrong, the chart
tells a room something confidently false, which is worse than having no chart.

A `selftest()` runs on every page load and drops a red banner on the page if anything
drifts. Be precise about what it does and does not cover — it is narrower than "the plans
are correct". What it actually does (see `selftest()` near the bottom of `index.html`) is:

1. schedule four hardcoded reference plans and assert their starts and finishes —
   `REFERENCE` (serial lanes, gating, the array-order tie-break, a fraction, a losing pin),
   `REFERENCE_WW` (a five-day week, weekends inside tasks, a snap that only ties because of
   snapping), `REFERENCE_HOL` (a day off on a working weekday) and `REFERENCE_ACT` (work
   that has already happened). This is what catches a broken `sched()`;
2. audit **the currently loaded plan** for dependency violations (a task starting before
   something it waits on ends) and lane over-capacity.

So a plan whose *date* silently moves is not caught by the audit alone, which is why the
fixture is tracked and why absolute numbers are asserted against it. The migrator is driven
over a synthetic ladder in `sync-server/test/migrations.test.ts`, since what ruins data is
the sequencing rather than any one migration.

### `verify.sched.mjs` — the same scheduler, in a second

```
node verify.sched.mjs
```

`selftest()` is right and lives in a browser: start a server, drive puppeteer, wait. Nobody
runs a two-minute suite to find out whether they typed a tie-break backwards. So this
**extracts** `sched`, `spanOf`, `endOf`, `snapFwd`, `workDaysIn`, `auditSchedule`,
`finishOf` and the fixtures out of `index.html` by name and runs them in node.

**It extracts rather than copies, and that is the whole point** — a copied function passes
while the real one rots, which is worse than no test. Everything it needs takes its calendar
and its lanes as parameters, which is exactly why they are parameters.

What it cannot see stays with the browser: the render layer, and a calendar leaking out of
the loaded document into a fixture — in there every calendar is whatever the caller passed.

> Dates are computed in **UTC on purpose**. Local-time arithmetic across the Nov 1 DST
> boundary rendered Dec 2 as "Dec 1" and turned exactly-zero slack into 0.006 weeks of
> slack — which silently softens the one sentence the chart exists to say.

## Not built yet

- **Per-milestone alignment** — the right-align rule targets the *last* milestone only.
- **Dependency lag, effort-vs-elapsed, owners, cost** — and change freezes, which are
  half-answered by the working calendar and need per-team scope to finish.
Add them when a meeting actually needs them.

### Three lenses that are wanted, in the order they are wanted

These are decided-yes and unbuilt, which is a different state from the list above. They
are here rather than in a scratch file because this README is the record, and the reason
each one is worth building is the part that would be lost.

**1. Which tasks actually control the date.** The chart says *when* everything is, and
cannot say which handful of tasks the finish date actually turns on — there is no
per-task slack anywhere in it (`slack` is per **milestone** only). The rest is
interesting: the textbook answer is a critical-path forward/backward pass, and it would
be **confidently wrong here**, because lanes are capacity-constrained serial queues and
classical float ignores resources. The correct-by-construction version is to ask the
scheduler, which is what `startConstrain` already does for a different question: bump a
task a day, re-run `sched()`, see whether the binding milestone moved. That is one extra
run per task, milliseconds at any size a room can read, and it is right *because* it uses
the real scheduler. Two readings fall out that nothing here can currently give: "five
tasks control this date and the other thirty-three can slip a week", and a one-day slip
that costs **three** days because the task sits against a weekend and `snapFwd` pushes it
to Monday. Probably a ranked panel rather than a picture — the best answers in this tool
are already sentences.

**2. Why is this task here.** Every start is the latest of three things — a dependency
ending, a `notBefore`, a lane freeing up — and exactly one of them wins. Surfacing which
splits a plan into *dependency-bound* and *resource-bound*, which is the argument actually
being had in the room: unblock something, or add someone. `sched()` already computes the
losing terms and throws them away. The one place that answers this today is a refusal
message, and it was wrong until the commit above.

**3. Group rows by something other than team.** Low priority, and now HALF answered — the
graph lens groups by depth in the dependency chain, which was the version of this that
mattered most, so what is left is the *timeline* keeping its dates while grouping its rows
by something else. Group by milestone and it answers "what does Nov 18 actually rest on".
The argument stands either way: this file insists that *a channel is a rendering, not a
meaning* and ships **⚙ → Swap two channels** on the strength of it, and the y-axis is the
one channel that was never made movable.

**Considered and declined: team load over time.** A lane-by-time grid shaded against
capacity. It answers "who is saturated", which is a real question, and it is not one this
chart is asked.

**Actuals shipped** — two nullable dates, a per-task shift, a strip and a comparison.
This list used to say they were deferred and pointed at a proposal file; both are gone. See
[Actuals](#actuals--started-done-and-a-plan-of-record).

**Lane capacity shipped** — `cap` on a lane, edited via **⚙ → Channels → Lanes → at once**.
This list used to claim it was missing; it is not. The lane header shows it as **`∥2`**: the
words "2 at a time" were four times the width of the number, in a header already competing
with the label gutter, for a fact most lanes do not carry. The parallel bars say "these run
alongside each other", and the sentence is one hover away on the header's tooltip.

### Start constraints shipped — "it can't begin before Sept 1"

`notBefore` on a task: a **start-no-earlier-than** constraint, which is what the biggest
modelling gap on the list above turned out to want. **Drag a bar's body** left or right, or
type a date into the inspector's **Not before** field. Constrained bars carry an amber tick
at their left edge, because a constraint you cannot see is one you cannot argue with in a
meeting.

**A bar drags on both axes**, and the axis is chosen by whichever way you move first and
then held for the rest of the drag. **Sideways** is the constraint above. **Up and down** is
the ↑/↓ queue control under a gesture — one swap per row, and it stops at the ends of the
team, because a bar has no meaning in a lane that is not its own. The right-edge grip still
means duration and nothing else. Everything snaps to **half-weeks**, matching the 0.5wk
tasks in the model.

It is an *input* to the scheduler, exactly like a dependency — not a stored x-coordinate.
That distinction is the whole feature: **a coordinate does not survive a reflow, a
constraint does.** A pinned position has nowhere to live in a model that stores no start
dates, and the first duration edit would either ignore it or hold a bar somewhere the
schedule no longer supports — at which point the bar stops meaning "this is when this can
happen" and starts meaning "this is where the mouse was". MS Project calls this SNET; it
can only ever push a task later, so it can never make a plan unschedulable.

Two behaviours worth knowing before driving it live:

- **Dragging left past the earliest the plan allows does nothing, and says why** — the bar
  stops dead and the message names the dependency holding it. There is no clamping code for
  that; the scheduler simply ignores a floor it is already past.
- **Dragging a task that is on the binding milestone's chain spends slack.** The right-align
  shift is recomputed from slack, so the bar you dragged can stay put while everything else
  slides left. That is the plan telling you the constraint's real cost, and the message says
  how much slack went with it.

## Working on this

**Everything is derived; almost nothing is stored.** Every bug in the sessions that led to
this tool was a derived fact somebody had written down, which then drifted — a chart titled
"fits Nov 18" while landing Dec 2. Resist storing anything the model can compute.

**There are exactly two legitimate exceptions, and they pass the same test from opposite
directions.** A **constraint** — "it can't begin before Sept 1", and an actual start, which
is the same shape said harder — is stored because the model *cannot* compute it, as an
*input to* `sched()` rather than an output of it. The second used to be a **baseline**,
stored because the model *must not recompute* it — a historical claim, where one that
tracked current state would always show zero variance and look like good news. That test
still stands; what changed is that history now supplies immutable past states directly, so
the comparison points at a saved version instead of storing a copy, and the exception closed
itself. Hold anything you are tempted to store to that test: if a reschedule would silently
invalidate it, it is a cached position wearing a disguise; if a reschedule would silently
*update* it, it is not a record.

**ALAP alignment is a drawing choice, so it is per task.** `shiftOf(t)` hands a forecast the
plan's shift and hands anything already started a 0. Work that has begun has no slack to sit
inside — it is on the date it happened.

**ALAP alignment is bound by the tightest milestone**, not the last one. Shift as late as
possible without blowing *any* milestone; the binding one has least slack and is labelled
"sets the start date" on its chip. Targeting the last one instead pushed a whole plan past an
earlier deadline while cheerfully reporting slack. Milestones with no work constrain nothing.

**A milestone is not met until its tasks *and their transitive predecessors* are done.**
Counting only directly-assigned tasks flatters a milestone sitting on nine weeks of upstream
work.

**Filtering is a view.** The legend dims rows; it never touches the schedule. A filtered chart
shows the same dates as an unfiltered one.

### Landmines — every one of these cost real time

- **`bar.style.background` is the shorthand**, and assigning it wipes `background-image`,
  where the fill hatch lives. Use `backgroundColor`.
- **The same landmine, one layer down: a split bar is not a `linear-gradient`.** Gradients
  live in `background-image` — the hatch's address — so the obvious way to draw two colours
  on one bar silently erases the confidence marking. The bands are real child elements
  carrying the same `pat-*` class, which also keeps the hatch running across the seam.
  They are `pointer-events:none` (a band must never swallow the drag or the hover preview),
  and there is no `overflow:hidden` on the bar to clip them because `.grip` deliberately
  overhangs the right edge — only the last band gets a corner radius.
- **`clip-path` clips the controls, not just the paint.** The grip, the constraint tick and
  the selection outline all deliberately overhang the bar, and a pointed shape would have
  eaten all three. That is the entire reason `.bar` and `.shape` are separate elements, and
  the verification asserts each of them survives a **diamond** specifically — asserting it on
  a rounded shape would pass whether the split existed or not.
- **`.pat-underline` IS a `box-shadow`.** The band seam was one too, and one rule silently
  replaced the other depending on stylesheet order. The seam is a `::before` now.
- **`[hidden]` is `display:none` and loses to any class that sets `display`.** `.lbl` is an
  `inline-flex`, so hiding the zoom control in the graph view — where there is no time axis
  for it to be about — did precisely nothing until a `.lbl[hidden]` rule said otherwise. Same
  specificity trap as the `.k` swatch overriding every shape's `border-radius`.
- **An HTML comment inside a template literal is still JavaScript.** The inspector's markup
  is built in backticked strings, so a `<!-- ... -->` explaining it lives *inside* the
  literal — and naming `max` and `min` in backticks there closed the string and turned the
  rest of the function into a syntax error. `node --check` on the extracted `<script>` catches
  it in seconds, which is the entire reason that check is first on the list.
- **A CSS comment that closes early takes the next rule with it.** `.band` lost
  `position:absolute` to a stray `*/` mid-comment and rendered as a zero-height static div —
  no error, no warning, just a bar that refused to split. `getComputedStyle` said `static`
  when the rule said `absolute`, which is the tell.
- **Never read layout mid-render.** Reading `offsetTop` inside the row loop forces a flush
  while the grid is half-rebuilt; the browser clamps `scrollTop` and every click throws the
  page to the top. Measure once, afterwards. This is also why the label column is measured
  with canvas `measureText` rather than `offsetWidth`.
- **Reserved space must never shrink either**, for the same reason — dismissing the inspector
  used to shorten the document and trigger the same clamp. It is a high-water mark now.
- **`viz-kit.css` sets `body { height:100% }`.** With border-box, `padding-bottom` is absorbed
  rather than extending the page, so the inspector's reserved space did nothing until
  `body { height:auto; min-height:100% }`.
- **`#chart` sets `overflow-x:auto`, which computes `overflow-y` to `auto` too.** Anything
  positioned above y=0 is clipped and simply does not appear. The month axis had to become a
  real in-flow element.
- **All date maths is UTC.** Local-time arithmetic across a DST boundary renders Dec 2 as
  "Dec 1" and turns exactly-zero slack into 0.006 weeks — which softens the one sentence the
  chart exists to say.
- **`position:fixed` does not rescue a subtree an ancestor has set to `display:none`.** The
  refusal message lived in the control bar, and collapsing that bar hid it entirely — so the
  moment you most needed telling why a drag was refused was the moment nothing was said.
- **Writing into the viz folder trips the dev server's watcher** and reloads the page. Saving,
  forking and capturing walkthrough frames all do it. Nothing is lost, but scroll and
  selection reset and it destroys the execution context mid-test — which is why anything that
  writes runs LAST in the suite, and why frames are captured to a temp dir and published at
  the end.
- **A selection can outlive its task.** Undo restores an older task list, and anything
  selected that is no longer in it leaves `sel` dangling; the inspector then throws on every
  render and the tool looks frozen. Guarded at the top of `inspector()`.

### Verification

**`verify.interactions.ts` has been deleted, and this section is what it said.**
It drove the demo fixture end to end through an external runner
(`viz verify`) against a live URL, forking a scratch plan on a
real server. Nothing in this repo or its CI could execute it, so it had not run in
a long time — and a suite nobody runs is worse than none, because it reads as
coverage. What replaced it:

- **`npm run test:playback` in `scripts/`** drives the real page in headless
  Chrome against a stub API, in about fifteen seconds and on no infrastructure. It
  covers what the list below covered — the drag gestures and their refusals, the
  legend filter, the channel editor, the arrow styles reaching a drawn path,
  actuals, the settings tabs, the graph lens, an export/import round trip, the
  walkthrough frames — and a good deal it did not.
- **`sync-server/test/migrations.test.ts`** drives the migrator over a synthetic
  ladder, which was the one thing here nothing else did.

The warning it carried is worth keeping even though the file is gone, because the
shape recurs:

> **Pass `--interactions` explicitly.** It does *not* auto-detect through a
> symlinked path, and without it the run silently executes nothing and reports
> success — which is the assertion-that-cannot-fail failure applied to a whole
> file at once.

`selftest()` additionally drives the real `MIGRATIONS[1]` on every page load, because the
fixture is stamped v2 and nothing else on the page would exercise the rung the documents on
someone's disk actually need.

> **Anything now behind ⚙ has to be opened before it can be clicked.** Puppeteer refuses a
> click on an element the modal is covering, but `$eval` dispatches happily into a hidden
> one — so the suite has `openSettings()` / `closeSettings()` helpers and only the *clicks*
> need them. A test that quietly kept passing by dispatching into an unreachable control
> would be exactly the "assertion that cannot fail" this file already has three scars from.

> **A green run is not proof.** The channel editor once shipped visibly broken with 0 errors
> and 0 layout findings, because an `<input>` whose value overflows looks normal from outside.
> When changing layout, write a throwaway pass that screenshots the thing and checks
> `scrollWidth > clientWidth`.

> **Suspect the test first.** Most failures here have been the test, not the app: the widest
> bar had a perfectly healthy rect and sat *underneath* the pinned inspector, so every gesture
> in a new section landed on the toolbar and every refusal silently did not happen; a point
> captured before an edit that moves the chart's own origin points at empty space after it;
> `page.click`
> scrolls the target into view, so it measures Puppeteer rather than the page;
> `scrollIntoView` and `getBoundingClientRect` in one `evaluate()` return pre-scroll
> coordinates; `text-transform:uppercase` does not change `textContent`; a hardcoded scroll
> target clamps on a short page; a bar can sit past the right edge of the viewport while its
> rect looks healthy; and a blocked `confirm()` freezes every later CDP call, surfacing as a
> protocol timeout hundreds of lines from its cause.

> **Assertions that cannot fail are worse than none.** Three lived here: a gutter check
> selecting a class the page no longer renders (`Math.min()` of nothing is `Infinity`, which
> passes everything), a dead-space check using `scrollWidth` (clamped to at least
> `clientWidth`, so it can never exceed it), and a visibility check on a rect that is all
> zeros when the element is hidden — zero is inside every viewport.
