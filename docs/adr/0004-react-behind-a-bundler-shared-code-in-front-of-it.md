# ADR 0004 — React behind a bundler, shared code in front of it

**Status:** accepted, 2026-09-05. **Amended 2026-09-07** — the port is complete;
see "What is deliberately NOT ported", which used to list four exceptions and now
lists none. One of the four was recorded with a reason that was not true, and the
correction is kept in place rather than deleted, because the wrong reason is the
part worth not repeating.

## Context

The page was one static file for its whole life: `web/index.html`, 9,467 lines,
served from S3 behind CloudFront with no build step of any kind. On 2026-09-05 it
was split into markup plus `web/src/app.ts` and put through `tsc`, which is where
the argument for stopping would have been strongest — there was now a build, and
it emitted one plain ES module the browser ran verbatim.

What that did not fix is the render model. `render()` tears the chart down and
rebuilds it — `$$(".row,.lane-head,…").forEach(n => n.remove())`, `svg.innerHTML =
""`, `bar.innerHTML = …` — and the page carries a hand-written patch for each
thing that destroys:

- `render()` saves and restores `window.scrollY` and `#chart.scrollLeft` around
  every call, because the rebuild loses the scroll position.
- `renderKeepFocus(selector)` exists so that typing into the inspector does not
  blur the field after every keystroke, and `emit(cmd, keep)` threads a selector
  through the command layer to reach it.
- `applyFilter()` reaches into `#legend` and `#msbar` and toggles classes by
  hand, with a comment saying the real render function "cannot be called from
  here — it rebuilds two live `<input>`s per chip".
- `reorderChip()` removes one node and appends another because there was no way
  to change one card without rebuilding the row.

Those are four instances of one defect. A reconciler is the thing that removes
the category rather than the instances.

The counter-argument, taken seriously: this is ~4,000 lines of code under ~4,000
lines of commentary that IS the design record, maintained by one developer and
their agents, and it runs a client's live delivery schedule. It also cannot be
rewritten safely without tests it does not have.

## Decision

React 19, bundled by Vite, migrated **region by region** rather than rewritten.

- `web/src/app.ts` stays plain TypeScript and keeps owning the document, the
  socket, the scheduler wrappers and every derived number. It is still the entry
  point named by `index.html`.
- `web/src/ui/*.tsx` holds components. They are presentation: they take a view
  model and callbacks, and no domain type but `Id`. A component cannot compute a
  date, so it cannot disagree with the chart about one.
- `web/src/ui/mount.tsx` is the seam, and the readable list of which containers
  React owns. One root per container, held in a `WeakMap`.
- `render()` stays the single choke point. A migrated region is
  `mountX(container, props)` inside it; nothing else changes about how a command
  reaches the screen.

**No state library.** `render()` is already the one place everything funnels
through, so props from there are enough. Redux/Zustand/context would be a second
answer to a question that already has one.

## The part that is easy to get wrong

`shared/schedule.js` and `shared/commands.js` are **marked external** and are not
bundled. This is not an optimisation; it is what keeps ADR 0001 true.

That gate proves the copy of the scheduler going to the bucket is byte-identical
to the copy inside the image, because a stale scheduler still computes *a* date.
Every word of it rests on an unstated premise — that the page **loads the file
being compared**. That premise was free while the page was a plain module
importing `./schedule.js`. A bundler makes it false by default: inlining is
Rollup's whole job, and an inlined scheduler means the browser runs a transformed
copy while the gate goes on comparing two files that still match. Both sides
green, nobody running the code.

`sync-server/test/bundle.test.ts` asserts the built chunk imports `/schedule.js`
and `/commands.js` and contains no text from either. It was proved by letting the
bundler inline them: both tests fail.

Two adjacent things also had to move, both because they read a build output that
no longer exists in a readable form:

- `docs/original/verify.sched.mjs` slices ~30 top-level declarations out of the
  page and evaluates them. Rollup deconflicts the page's wrappers against the
  imports they wrap (`spanOf` → `spanOf$1`), rewrites `const` to `var` and drops
  every comment, so nothing could be found. It reads `web/src/app.ts` and strips
  the types itself with `stripTypeScriptTypes` from `node:module` — stdlib, and
  in `strip` mode the output is the same length as the input, so the slicer's
  character walk still lines up. It now needs nothing built.
- `sync-server/test/selectors.test.ts` scans sources, not output, and discovers
  every file under `web/src/` rather than naming two.

## Consequences

**Good.** As of 2026-09-07 every region is ported — `ui/mount.tsx` is the readable
list and holds 34 mount points. The first pass took the panels and the chart grid
itself (`#rows`: the lane heads, rows, labels and bars); the second took what this
document had recorded as exceptions — the walkthrough frames, the six dropdowns,
the one-shot banners, the axis, the background furniture and the arrow layer.

**No panel on the render path is built with `innerHTML` any more.** What is left
of it is the chart grid — which is a different problem, see Open — and two
`<select>` option lists (`#dhover`/`#dclick`, `#swapa`/`#swapb`). Those stay
imperative on purpose: they are elements declared in the markup rather than
containers, so React would own their `<option>`s while the markup owned the
element the change fires on. That split ownership is what `mount.tsx` exists to
keep out.

A recurring shape in the port: several of these functions returned MARKUP for
things that were always data — `heldBy` built chip HTML under a comment saying
"as data rather than as a sentence"; `hDelta` returned a coloured `<span>`;
`nudgeStale` held a whole sentence with a `<b>` in it. Each is now a value, and
the component says the sentence.

`#msbar` (`ui/MilestoneBar.tsx`) took the `applyFilter` class-poking, the
`reorderChip` splice, and one `emit(cmd, keep)`.

`#insp` (`ui/Inspector.tsx`) replaced ~200 lines of `innerHTML` template plus 30
handler assignments made by re-querying children by id. That rebuild was the
reason `renderKeepFocus` existed, and also the reason `#lab` needed a `setTimeout`
+ `document.activeElement` dance on blur: the focused field was destroyed on every
keystroke, which fires `blur`, so typing a name looked like leaving the field and
opened the mentions dialog on a half-typed word. `emit`'s `keep` parameter now has
exactly one caller left — `#title` in the top bar — and goes when that does.

`#legend` took the last of `applyFilter()`'s hand-poking — it reached into both
chip rows and toggled `.on` element by element, with a note saying the real render
functions "cannot be called from here". They are called from there now, and only
when the picked set can actually have changed, so a pointer move across the legend
costs what it always did.

`#chedit` held **three** of the four remaining `emit(cmd, keep)` sites: a channel's
name, each value's name, and a lane's short name are all `oninput` text fields.
One is left — `#title` in the top bar — and it goes when that does. (An earlier
count of "one left" was wrong: the grep was line-based and the three in
`channelEditor` are written across two lines.)

The browser suite grew from 30 checks to 88. The load-bearing ones are
discriminators rather than assertions about output: a property stamped on the live
`<input>` survives a re-render only if the element did. Proved by giving the chips
an unstable `key`, which reproduces node replacement — and that falsifier showed
the old hand-rolled path *dropped a character* while restoring the caret, so the
workaround it replaced was not even fully correct.

Twelve of those checks were written against the imperative inspector BEFORE it was
touched, and are the reason the port is trustworthy: eleven passed unchanged on the
first run. The twelfth failed for the right reason — React's `onChange` is the DOM
`input` event, not `change`, so a synthetic `change` reaches nothing. `#dur`, `#ref`
and `#url` commit on blur or Enter through a `CommitField`, because wiring them to
`onChange` would emit a command per character and `setTaskUrl` refuses "h", "ht",
"htt".

**Four things the stub server and the suite were getting wrong**, all found by
porting and all fixed in `scripts/playback-harness.ts`:

- `POST /api/commands` was answered with a **404**. Batches — deleting a channel
  value moves every task off it first, in one commit — go over HTTP, not the
  socket. Every batch in every test had silently done nothing.
- Accepting it was not enough. An HTTP command carries no session ref, so the
  server broadcasts to everyone *including* the sender and the page deliberately
  does **not** apply optimistically. A stub that returns `{ok:true}` and
  broadcasts nothing leaves the chart untouched, which reads as a broken feature.
- A `confirm()` **blocks headless Chrome** until something answers it, and
  puppeteer answers nothing by itself. The run hung to its timeout with no failing
  check to point at.
- A failed subresource logs `Failed to load resource: … 404` and **names nothing**,
  so a real regression and a stray favicon are the same string. The suite now
  records the URL — the same blind spot that cost time on the live site.

**Two regressions the tests did not catch**, found by reading the old handler list
against the new one: opening the link popover no longer focused and selected the
URL field, and Escape inside it no longer stopped propagating — so it reached the
page's global Escape, cleared the selection and closed the whole panel. Both are
fixed and both now have checks.

Vite's hashed output replaced ~40 lines of `shasum` + `sed` in
`scripts/deploy-web.sh`, including a BSD-vs-GNU `\b` trap that matched nothing on
a laptop and everything in CI.

**Bad.** The bundle went from 46 kB to 106 kB gzipped. It is content-hashed and
`immutable`, so it is paid once per deploy.

Rollup strips the page's comments from the artefact, which `shared/` deliberately
keeps (`removeComments: false`, because `/commands.js` is the protocol reference
agents are told to read). The sourcemap ships for that reason.

## What is deliberately NOT ported

**Nothing, as of 2026-09-07.** React owns every region of the page. `app.ts`
contains no `innerHTML =` assignment and no `esc()` helper — the latter existed
solely because this file assembled markup as strings. The `createElement` calls
that remain make containers React renders into (`#cursors`, the one-shot banners'
hosts) or nodes nobody sees: the canvas behind `measureText`, the throwaway div
`fontOf` reads a computed font from, and the `<a>` a download is triggered
through.

What follows is what this section used to say, and why each entry did not
survive contact. Three of the four were cost arguments written as constraints;
the first was a mistake.

**The walkthrough frames — the recorded reason was wrong.** This section said the
six `<img>` elements had to stay in `index.html` because "the screenshot export
inlines images it can SEE as data URIs, and a `src` assigned from JS is invisible
to it — set dynamically, every frame 404'd on the live site". There is no such
export. The image export is `html-to-image`'s `toBlob($("#grid"))`, which
captures the **chart**; these live in `#tour-frames`, which it never touches. The
other export writes JSON.

What actually happened is a build fact. `index.html` said
`src="walkthrough/tour-1-plan.jpg"`; Vite rewrites that to
`/assets/tour-1-plan-<hash>.jpg`, and `scripts/deploy-web.sh` deletes the
unhashed `walkthrough/` prefix from the bucket on purpose. So a path **assembled
at runtime** misses — which is equally true of a string built in JSX and equally
false of an `import`, and `ui/Tour.tsx` uses imports. The observation was real;
the mechanism attached to it was not, and it kept a region out of the port for
two days.

That mistake had a second half worth recording. The browser suite could not have
caught the regression either way: the stub falls back to serving `web/`, which
still holds the unhashed `walkthrough/` directory, so a deliberate return to a
runtime-assembled path **passed the entire suite**. The harness was kinder than
production in exactly the dimension that mattered. It 404s that prefix now, the
way the bucket does.

**Six `<select>` option lists** (`#dhover`, `#dclick`, `#swapa`, `#swapb`,
`#ggroup`, `#zoom` — this section said "four" and then listed six). The reason
given was that React would own their `<option>`s while the markup owned the
element the change fires on. That is an argument against doing it *halfway*, not
against doing it: `ui/Picker.tsx` owns the whole control, so `value` is a prop
rather than a property assigned after the options were replaced — which is the
ordering bug the objection was really about. The container React needed is a
`<span class="pickhost">` with `display:contents`, which generates no box, so
every one of these still sits in its `<label class="lbl">` with the layout it had
when the markup held it directly.

**One-shot banners.** "Written once into `document.body` and replaced wholesale;
there is no state to reconcile" is a statement about what React would *buy*, not
about what it could do. It buys one thing: each of the six interpolated a value
into an HTML string, so each needed `esc()` at every interpolation and was one
forgotten call from a scheduler error, a plan title or a **share token** becoming
markup. Two of them carry tokens. `ui/Banners.tsx` has no `esc()` because a JSX
expression is text by construction rather than by remembering.

**The background furniture and the arrow layer.** "`position:absolute` against
`#grid`" is not a reason; React renders absolutely-positioned divs like anything
else. Nor is "relies on SVG document order for stacking" — a list rendered in
order is still in order. The honest argument was the third one, that these are
recomputed wholesale on every render so reconciliation has nothing to conserve,
and it had never been measured. It has been now: a full render of the 135-task
plan takes about a millisecond, and 6–7ms after the port against a 5ms quiet
threshold. There was no headroom being protected.

Deleting the imperative sweep was the load-bearing part. `renderInner` cleared
`.gl,.gl-lab,.nwd` out of `#grid` before rebuilding them; left in place it threw
`NotFoundError: The node to be removed is not a child of this node` as soon as
the reconciler got there first — which is exactly what the comment above it
already warned about for `.row` and `.lane-head`, one region late. `.gl-lab`
turned out to have no producer at all: swept every render, never made.

**What replaced the exceptions is coverage.** Every one of these regions was
rewritten with nothing watching it, which is why 47 browser checks were added
alongside — including the walkthrough's missing-frame path, which
`remaining-work.md` had listed as the one that mattered most.

## Porting the grid, and the two things it turned up

The row loop was the last region and the one with the most invariants. Two of them
survived the port intact and are worth naming because a rewrite could quietly drop
either: a folded lane reuses ONE row element for several bars, so "a row per task"
is not the shape of the tree; and `POS` keys row NODES by task id, which several
other regions read — that is a ref map now, filled by the reconciler rather than by
keeping the node the loop had just made.

**The fingerprint is PAINT, not geometry, and that was forced rather than chosen.**
The first version carried `left`/`top`/`width`/`height` and passed on a laptop
while failing in CI on the same commit — `left: 1072.98px` against `1079.74px`.
The label column's width is MEASURED from text with canvas `measureText`, so every
pixel on this chart is downstream of font metrics, and those differ between macOS
and Linux. A golden that encodes them can only ever be right on the machine that
wrote it. Nothing it exists for is lost: all four things it protects are paint, and
layout is covered by checks that compare against themselves rather than a stored
number — rows ordered by start, a drag changing the width it should, the counts in
all three modes, the arrow layer sized to the grid.

**The port was gated on it, and it matched byte for byte** across all
three shapes on the first green run: every bar, shape, core, band, grip, tick and
strip, computed style and geometry, identical to what the imperative loop drew.

**It also surfaced a real bug that had been masked for as long as it existed.**
`#chart`'s click handler deselects on a click that did not travel 4px, and it takes
the origin from a `pointerdown` listener on `#chart`. That listener was on the
BUBBLE phase, so the two handlers that stop propagation to claim a gesture —
`startDrag` on the grip most of all — meant the origin was never recorded for
exactly the gestures the distance test exists to measure. It went unnoticed because
the rows were destroyed on every render: the element the pointer went down on
vanished, the click had nowhere coherent to land, and the deselect did not fire by
accident. React keeps the row, so the click now reliably arrives — and a 90px grip
drag read as a click on empty chart and cleared the selection. The listener is on
the capture phase now, which is what it always needed to be.

**One workaround it did NOT retire.** `render()` still saves and restores
`window.scrollY` and `#chart.scrollLeft`. The browser suite's scroll check passes
with those two lines deleted — but that suite runs an eleven-row fixture whose
chart clamps `scrollLeft` to 15px, and the bug they prevent is about a LONG
document being momentarily shortened. Two lines are not worth removing on evidence
that cannot reach the case they were written for. The comment on them says so, and
says what would settle it.
