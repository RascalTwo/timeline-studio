# What is left, and what is deliberately not

Written 2026-09-07, at the end of the migration that took this page from one
static 9,467-line HTML file to React 19 behind Vite. It is a handoff, not a
roadmap: everything below is either measured or read out of the code, and where
it is a judgement it says so.

**Read [`AGENTS.md`](../AGENTS.md) first** for how to build and test, and
[`docs/adr/0004`](adr/0004-react-behind-a-bundler-shared-code-in-front-of-it.md)
for why the page is shaped the way it is.

## Where things stand

| | |
|---|---|
| `npm test` in `sync-server/` | 65 tests + 106 scheduler checks |
| `npm run test:playback` in `scripts/` | **247 browser checks** in ~45s, all green |
| React-owned regions | all of them — 34 mount points in `ui/mount.tsx`, and no `innerHTML =` left in `app.ts` |
| `web/src/app.ts` | 7,448 lines (was 8,143 at the start of the port) |
| `web/src/ui/` | 2,091 lines across 16 files |

`/api/reorder` on the live 135-task plan: **23s → 200** (was 90s → 504).
`/api/health` stays under 400ms while it runs (was starved past its 5s timeout,
which killed the container six times on 2026-09-04).

## 0. The browser suite is green, and the four "page bugs" were not

Found and closed 2026-09-19. The suite had fifteen failures and a crash. Eleven
were the suite reading a page that had moved on. The four that looked like real
regressions were **also** the suite, and both are worth remembering because both
fail in a way that accuses the product:

**A drag that misses reports as "the feature is gone."** The reorder drag aimed
at a bar underneath the pinned inspector; `elementFromPoint` at the drag origin
returned `fk`, an inspector field label. The gesture was never asked. There is
now a check that says so by name — *the bar the reorder drag aims at is actually
under the pointer* — because "nothing moved" is not a diagnosis.

**An edit typed into a folded panel is indistinguishable from an edit that
changed nothing.** One click leaves the inspector folded, `#dur` sits in the
collapsed region with a zero-sized box, and `focus()` on it does not take — so
`keyboard.type` typed into nothing and `t7.dur` stayed at 1. The slow-device
check failed honestly. Its fast-device twin **passed**, because "not stale" is
also what doing nothing looks like: a check that cannot fail was sitting next to
one that could, describing the same broken gesture.

Both now go through `selectTask()`, which selects and then opens the panel.

## 1. Test coverage — no gaps left

The browser suite covers the chart, the inspector, the legend, all three grid
shapes, the three drag gestures, playback, history, save, compare, the channel
and swap editors, the order panel, both alternate views, zoom, the front door,
the walkthrough, the mentions dialog, the keyring, import and export, both forks,
and the chart's own background — the axis, the rules, the day bands and the arrow
layer's paint.

Four things in it are worth knowing about rather than merely listing. Who else is
in the room: the roster, and a peer's cursor landing on OUR pixels from their
chart coordinates. Drawing a dependency, including the cycle refusal, checked by
what went on the WIRE rather than by what the chart looks like. The three actions
that ask before they act — revert, a channel swap and sorting the teams. And a
plan that will not open, where what is asserted is that the fixture is NOT drawn
in its place.

It covers everything, including the last banner, which was recorded here as
unreachable — "it fires only when the scheduler disagrees with itself, which no
fixture can provoke". That was the wrong description of what `selftest()` does.

**The self-test used to be four-fifths unit test, and that part is gone.** It ran
four reference plans with hand-computed answers and a synthetic migration ladder
on every page load. Every one of those was already asserted at build time — in
`verify.sched.mjs`, which slices the same constants out of `app.ts`, and in
`sync-server/test/migrations.test.ts`. The one thing the in-page copies added was
catching a browser that had loaded a STALE `/schedule.js`, and that is prevented
now rather than detected: the file is served `no-cache`, like `index.html`.

What remains is three lines, and they are not a test. `auditSchedule(doc.tasks…)`
audits the document that actually loaded for a schedule that violates its own
constraints — a task starting before something it waits on has finished, or a
lane running two at once. That is a claim about DATA, which varies, rather than
about code, which does not: the case a hand-edited import or a bad migration
produces. The browser suite provokes it by serving a `/schedule.js` with one
token changed in the dependency gate.

One thing that fell out of writing that check, worth keeping: **the ordinary
fixture cannot expose a broken dependency gate.** Every dependency in it runs
t(n) <- t(n-2), the same lane and in queue order, so the lane's own serialisation
reproduces exactly the dates the dependencies would have forced. It takes
SORTABLE — a task in one team waiting on a task in another — for the audit to
have anything to say.

## 2. `suggestReorders` runs on the machine reading the plan

Shape unchanged, and it is not going to change: **Σ(lane²) full schedules of the
whole plan** — 2,932 of them on the real plan. What changed is where they run.
Measured through the same `/schedule.js`:

| | |
|---|---|
| the server | **23s** — Fargate at `Cpu: '256'`, a quarter of one core |
| a browser | **1.8s** |

The server was never slow because the function is slow. It is the smallest
container AWS sells, running against a machine that is sitting idle. So the page
computes it in a Web Worker (`web/src/reorder-worker.ts`), and `/api/reorder`
stays as the fallback rather than the default.

**How slow a device before that stops being true**, measured with Chrome's CPU
throttle on the same plan: 2× → 3.8s, 4× → 7.5s, 6× → 11.4s, 10× → 19.0s,
20× → 41.4s. The server takes 23s, so the browser wins until the client is about
**thirteen times slower than a current laptop** — worse than any current laptop
and most phones.

**The routing is measured, not predicted.** It used to ask
`reorderUnits() <= LOCAL_BUDGET`, a cost model with a hand-tuned constant, and
send anything over the line to the slowest machine in the system. The model was
not even wrong — it says ~300 units/ms and the browser measures 211. The
destination was. The page now runs the search, remembers what it cost **on this
machine**, and uses that: under `AUTO_MS` (3s) the panel refreshes itself after
every edit, over it the panel goes back to marking the answer stale and offering
to check again. The first run is the measurement, and the chip's progress bar is
sized from it.

That also fixes the thing that actually happened to the person using this, which
was never the 23-second wait: *"I applied the best one, moved on with my life,
and forgot to come back."* The advice does not rot any more.

What is still true, and was ruled out with measurements — do not repeat it:

- **Pruning to queue-blocked tasks is wrong.** In the "idle task in front of a
  gate" case the task you MOVE is the idler, not the blocked one — that prune
  deletes the feature's headline suggestion.
- **Skipping lanes with no queue-delayed task** is sound but saves 3%.
- **The calendar walk in `spanOf` is not the hot path.** Durations are short
  (median 2 days); it was the allocations.

**An incremental scheduler is not needed and was not built.** It was the only
route left to "interactive" while the work was happening on a quarter of a core,
and it would have meant a second way of computing dates — a new invariant whose
failure mode is silently wrong dates. Moving the same code to a faster machine
bought 12× for nothing. If this is ever reopened, it should be reopened against
these numbers.

## 3. Two small things — both done

- **`render()`'s hand-rolled scroll restore is gone.** It saved `window.scrollY`
  and `#chart.scrollLeft` and put them back, because rebuilding every row
  shortened the document for an instant and the browser's clamp survived. The
  only evidence it was dead was an eleven-row fixture whose chart clamps
  `scrollLeft` to 15px — evidence that cannot reach the case. The suite now runs
  the case: 135 rows, zoomed to the narrowest preset so the chart is genuinely
  wider than its window, scrolled 900px down and 400px across, through a render
  caused by somebody else's command. It holds without the two lines.
- **`docs/original/verify.interactions.ts` is deleted.** 3,793 lines needing a
  live deployment and a runner from outside this repo, so nothing here or in CI
  could execute it — and a suite nobody runs is worse than none, because it reads
  as coverage. Everything it claimed the browser suite now does, except one
  thing: it drove the migrator over a synthetic ladder, and nothing else did.
  That is `sync-server/test/migrations.test.ts` now — nine checks on the WALK
  rather than on any one rung, because "the migrations are trivial, the
  sequencing is what silently ruins data". Its references in `README.md`,
  `docs/original/AGENTS.md`, `docs/original/README.md`, `verify.sched.mjs` and
  `reset-demo.sh` are corrected rather than left pointing at a missing file.

## 4. Deliberately NOT doing — do not "fix" these

**The three exceptions that used to head this list are gone.** The walkthrough
frames, the six `<select>` option lists and the one-shot banners are all React's,
and so are the chart's background furniture and the arrow layer. Every reason
recorded for keeping them out turned out to be either a cost argument stated as
a constraint or, in the walkthrough's case, simply wrong — see
[`docs/adr/0004`](adr/0004-react-behind-a-bundler-shared-code-in-front-of-it.md).
`app.ts` holds no `innerHTML =` and no `esc()`; the only `createElement` calls
left make containers React renders into, or nodes nobody sees.

What is left below is genuinely load-bearing.
- **`shared/schedule.js` and `shared/commands.js` must stay OUT of the bundle.**
  `web/vite.config.ts` marks them external and `sync-server/test/bundle.test.ts`
  asserts it. Inlining them silently voids `assert-shared-parity.sh`: the gate
  goes on comparing two files that match while the browser runs a copy of one.

## 5. Habits this codebase earned the hard way

Every one of these cost real time in the session that produced this file:

- **A fixture kinder than production does not just flatter the numbers, it ranks
  your fixes wrong.** A local fixture said an optimisation was worth 1.3×; on the
  real plan it was 3.9×, because the fixture made a sixth of the calendar calls.
- **Check that a new test can FAIL.** The first grid fingerprint passed a
  deliberately introduced regression, because the fixture had no hatch to erase.
- **`verify.sched.mjs` is checked by EXIT CODE, not by grepping its output** — its
  failure mode removes a line rather than adding one.
- **A backgrounded tab does not run `requestAnimationFrame`**, so the arrow layer
  looks broken when you drive the live site from an automated browser. It is not.
- **`const` helpers declared below their first use throw** "cannot access before
  initialization". This has now bitten in `emit` and three times in the harness.
- **A check that two mechanisms both satisfy cannot fail.** "The pointers survive
  a render" passed with `#cursors` deliberately added to `renderInner`'s
  remove-by-selector list, because `drawPresence()` runs after every render and
  rebuilt the layer in the same tick. Each mechanism hid the other one breaking.
  It only became a test when it asserted the layer NODE survived, not the
  pointers.
- **An idempotency guard in front of a check hides the check.** The first cycle
  test asked t4 to wait for t2 when it already did, so `addDep`'s `includes`
  guard returned before the refusal ran: nothing sent, nothing printed, and
  three of its four checks green. A refusal and a no-op look identical from
  outside. Pick a pair with no arrow between them yet.
- **Read the field, not the row.** A channel value's `textContent` is its usage
  count and its buttons; the label is in `input.cl`. Asserting a swap on the
  counts fails for a correct reason — colours are a list channel and fills are
  not, so a multi-colour task loses its extras on the way across.
- **Wait for the page, not for the clock.** The suite held 109 hand-picked
  `setTimeout`s adding up to 48 of its 60 seconds at 27% CPU. Replacing them with
  a MutationObserver quiescence wait took it to 14s — but four checks then failed,
  and every one was a place where quiescence is the WRONG question: a CDN import,
  a nudge computed after the render that provokes it, a reload, and a recompute
  crossing the network all leave a perfectly quiet DOM. Those want `until()`.
  A `settle()` that hits its ceiling is the tell, and it says so in the log.
- **A check that silently takes its other branch is worse than one that fails.**
  Sampling the Order chip too early sent it down the `else` path — "this plan has
  nothing to move" — which skipped the panel AND left the document unedited, and
  the two drag checks two hundred lines later failed instead. The failure was
  nowhere near the cause.
- **"The suite still passes" is not evidence about code no test runs.** Six
  one-shot banners were rewritten and every check stayed green, because nothing
  had ever drawn one of them. Before rewriting an untested region, make the stub
  able to provoke it — or say plainly that it is unverified.
- **"It shows what I just picked" proves nothing about a controlled input.** An
  UNCONTROLLED select keeps the user's own choice too — swapping `value` for
  `defaultValue` passed the first version of the chain-depth check. The property
  is that the control follows the DOCUMENT, so it has to be changed from the
  room and then read, never clicked and then read.
- **Two elements is not two plans.** A recent is an `<li>` wrapping a
  `<button class="recent">`, so `querySelectorAll('#recents li, .recent')` counts
  every plan twice. The first version of that check asserted two entries and
  passed, against one plan listed once.
- **A filter you cannot violate is not under test.** The grouping list drops
  channels with under two values; the fixture gives every channel exactly two, so
  removing the filter changed nothing and the check stayed green.
- **The stub served a directory the bucket deletes.** `deploy-web.sh` uploads
  `dist/assets/` and then `aws s3 rm`s `walkthrough/`, but the harness fell back
  to `web/` and served it — so an unhashed `walkthrough/x.jpg` resolved locally
  and 404'd live, which is the exact failure the tour frames' old comment was
  about. A deliberate regression to a runtime-assembled path passed the entire
  suite. The stub 404s that prefix now.
- **A single backslash in an evaluated template literal is not a backslash.** It
  is dropped before the page ever sees the string, and it has cost a debugging
  round twice. `/\/assets\/…/` arrives as `//assets/…` — a line comment — which
  truncates the script and kills the run on "Unexpected end of input" with no
  failing check to point at. `.replace(/\s+/g, ' ')` arrives as `/s+/g` and
  deletes every lowercase S from the string under test, so "unstamped" reads as
  "un tamped" and the assertion fails for a reason that has nothing to do with
  the page. Either double it (`\\w` in the source is correct, and one check does
  this) or do the work on the Node side, where a regex literal is a regex.
- **Do not assert the shape of somebody else's hash.** The first version of the
  hashed-asset check took the last `-` segment and required eight characters.
  Vite's hash for these is `Tis-AIBN` — it contains a hyphen — so the check
  failed against a correct build.
