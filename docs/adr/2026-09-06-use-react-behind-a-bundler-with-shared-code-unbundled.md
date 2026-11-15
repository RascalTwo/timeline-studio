# Use React behind a bundler, with shared code left unbundled

Status: Accepted, 2026-09-06

The port was completed on 2026-09-07. The record below reflects the finished state. One of the four exceptions the first version listed had a recorded reason that was not true. The correction is kept in place, because the wrong reason is the part worth not repeating.

## Context and Problem Statement

The page was one static file for its whole life: `web/index.html`, 9,467 lines, served from S3 behind CloudFront with no build step. On 2026-09-05 it was split into markup plus `web/src/app.ts` and put through `tsc`. That is where the argument for stopping was strongest: there was now a build, and it emitted one plain ES module the browser ran verbatim.

That did not fix the render model. `render()` tears the chart down and rebuilds it (`$$(".row,.lane-head,…").forEach(n => n.remove())`, `svg.innerHTML = ""`, `bar.innerHTML = …`), and the page carries a hand-written patch for each thing that destroys:

- `render()` saves and restores `window.scrollY` and `#chart.scrollLeft` around every call.
- `renderKeepFocus(selector)` exists so typing into the inspector does not blur the field, and `emit(cmd, keep)` threads a selector through the command layer to reach it.
- `applyFilter()` reaches into `#legend` and `#msbar` and toggles classes by hand, with a comment saying the real render function "cannot be called from here".
- `reorderChip()` removes one node and appends another because one card could not change without rebuilding the row.

Those are four instances of one defect. A reconciler removes the category rather than the instances.

The counter-argument, taken seriously: this is about 4,000 lines of code under about 4,000 lines of commentary that is the design record, maintained by one developer and their agents, and it runs a client's live delivery schedule. It cannot be rewritten safely without tests it does not have.

## Decision

React 19, bundled by Vite, migrated region by region rather than rewritten.

- `web/src/app.ts` stays plain TypeScript. It owns the document, the socket, the scheduler wrappers and every derived number, and it is still the entry point named by `index.html`.
- `web/src/ui/*.tsx` holds components. They are presentation: they take a view model and callbacks, and no domain type but `Id`. A component cannot compute a date, so it cannot disagree with the chart about one.
- `web/src/ui/mount.tsx` is the seam and the readable list of which containers React owns. One root per container, held in a `WeakMap`.
- `render()` stays the single choke point. A migrated region is `mountX(container, props)` inside it, and nothing else changes about how a command reaches the screen.
- No state library. `render()` is already the one place everything funnels through, so props from there are enough. Redux, Zustand or context would be a second answer to a question that already has one.

### Shared code stays outside the bundle

`shared/schedule.js` and `shared/commands.js` are marked external and are not bundled. This is not an optimisation. It keeps [2026-08-20-use-a-server-authoritative-command-log.md](2026-08-20-use-a-server-authoritative-command-log.md) true.

That parity gate proves the scheduler going to the bucket is byte-identical to the one in the image. It rests on an unstated premise: that the page loads the file being compared. A bundler makes the premise false by default, because inlining is Rollup's job. An inlined scheduler means the browser runs a transformed copy while the gate compares two files that still match. Both sides green, nobody running the code.

`sync-server/test/bundle.test.ts` asserts the built chunk imports `/schedule.js` and `/commands.js` and contains no text from either. It was proved by letting the bundler inline them: both tests fail.

Two tools read a build output that no longer exists in readable form, and both moved:

- `docs/original/verify.sched.mjs` slices about 30 top-level declarations out of the page. Rollup deconflicts names (`spanOf` becomes `spanOf$1`), rewrites `const` to `var` and drops every comment. It now reads `web/src/app.ts` and strips types itself with `stripTypeScriptTypes` from `node:module`. In `strip` mode the output is the same length as the input, so the slicer's character walk still lines up. It needs nothing built.
- `sync-server/test/selectors.test.ts` scans sources, not output, and discovers every file under `web/src/`.

### Consequences

Good:

- As of 2026-09-07 every region is ported. `ui/mount.tsx` holds 34 mount points. The first pass took the panels and the chart grid (`#rows`). The second took what this record had listed as exceptions: the walkthrough frames, the six dropdowns, the one-shot banners, the axis, the background furniture and the arrow layer.
- No panel on the render path is built with `innerHTML`. `app.ts` has no `innerHTML =` assignment and no `esc()` helper, which existed only because the file assembled markup as strings. The remaining `createElement` calls make containers React renders into (`#cursors`, the banners' hosts) or nodes nobody sees (the canvas behind `measureText`, the div `fontOf` reads a computed font from, the `<a>` a download goes through).
- Several functions returned markup for things that were always data (`heldBy`, `hDelta`, `nudgeStale`). Each is now a value and the component says the sentence.
- `#msbar` (`ui/MilestoneBar.tsx`) took the `applyFilter` class-poking, the `reorderChip` splice and one `emit(cmd, keep)`.
- `#insp` (`ui/Inspector.tsx`) replaced about 200 lines of `innerHTML` template plus 30 handler assignments. That rebuild was why `renderKeepFocus` existed, and why `#lab` needed a `setTimeout` and `document.activeElement` dance: the focused field was destroyed on every keystroke, which fires `blur`, so typing a name looked like leaving the field and opened the mentions dialog on a half-typed word.
- `#legend` took the last of `applyFilter()`'s hand-poking. `#chedit` held three of the four remaining `emit(cmd, keep)` sites. One is left (`#title` in the top bar) and goes when that does.
- The browser suite grew from 30 checks to 88. The load-bearing ones are discriminators rather than output assertions: a property stamped on the live `<input>` survives a re-render only if the element did. That was proved by giving the chips an unstable `key`. It also showed the old hand-rolled path dropped a character while restoring the caret.
- Twelve checks were written against the imperative inspector before it was touched, which is why the port is trustworthy: eleven passed unchanged on the first run. The twelfth failed for the right reason. React's `onChange` is the DOM `input` event, not `change`. `#dur`, `#ref` and `#url` commit on blur or Enter through a `CommitField`, because `onChange` would emit a command per character and `setTaskUrl` refuses "h", "ht", "htt".
- Vite's hashed output replaced about 40 lines of `shasum` and `sed` in `scripts/deploy-web.sh`, including a BSD-vs-GNU `\b` trap that matched nothing on a laptop and everything in CI.

Bad:

- The bundle went from 46 kB to 106 kB gzipped. It is content-hashed and `immutable`, so it is paid once per deploy.
- Rollup strips the page's comments from the artefact, which `shared/` deliberately keeps (`removeComments: false`, because `/commands.js` is the protocol reference agents are told to read). The sourcemap ships for that reason.

Four things the stub server and suite were getting wrong, found by porting and fixed in `scripts/playback-harness.ts`:

- `POST /api/commands` was answered with a 404. Batches go over HTTP, not the socket, so every batch in every test had silently done nothing.
- An HTTP command carries no session ref, so the server broadcasts to everyone including the sender and the page deliberately does not apply optimistically. A stub that returns `{ok:true}` and broadcasts nothing leaves the chart untouched, which reads as a broken feature.
- `confirm()` blocks headless Chrome until something answers it. The run hung to its timeout with no failing check to point at.
- A failed subresource logs `Failed to load resource: … 404` and names nothing. The suite now records the URL.

Two regressions the tests did not catch, found by reading the old handler list against the new one: the link popover no longer focused and selected the URL field, and Escape inside it no longer stopped propagating, so it reached the global Escape and closed the whole panel. Both are fixed and both have checks.

### What was deliberately not ported, and why each exception did not survive

Nothing is left unported. This section originally listed four exceptions. Three were cost arguments written as constraints and the first was a mistake.

- **The walkthrough frames.** The recorded reason was wrong. It said the six `<img>` elements had to stay in `index.html` because "the screenshot export inlines images it can SEE as data URIs". There is no such export. The image export is `html-to-image`'s `toBlob($("#grid"))`, which captures the chart, and the frames live in `#tour-frames`, which it never touches. The real cause was a build fact. `index.html` said `src="walkthrough/tour-1-plan.jpg"`, Vite rewrites that to `/assets/tour-1-plan-<hash>.jpg`, and `scripts/deploy-web.sh` deletes the unhashed `walkthrough/` prefix from the bucket on purpose. So a path assembled at runtime misses, in a JSX string as much as anywhere, and an `import` does not. `ui/Tour.tsx` uses imports. The mistake kept a region out of the port for two days. The browser suite could not have caught it either: the stub fell back to serving `web/`, which still held the unhashed directory, so a runtime-assembled path passed the whole suite. The harness now 404s that prefix, as the bucket does.
- **Six `<select>` option lists** (`#dhover`, `#dclick`, `#swapa`, `#swapb`, `#ggroup`, `#zoom`; the record said "four" and listed six). The reason was that React would own the `<option>`s while the markup owned the element the change fires on. That is an argument against doing it halfway. `ui/Picker.tsx` owns the whole control, so `value` is a prop rather than a property assigned after the options were replaced. The container is a `<span class="pickhost">` with `display:contents`, which generates no box, so each still sits in its `<label class="lbl">` with the same layout.
- **One-shot banners.** "Written once into `document.body` and replaced wholesale" says what React would buy, not what it could do. It buys one thing. Each of the six interpolated a value into an HTML string, so each needed `esc()` at every interpolation and was one forgotten call from a scheduler error, a plan title or a share token becoming markup. Two carry tokens. `ui/Banners.tsx` has no `esc()` because a JSX expression is text by construction.
- **The background furniture and the arrow layer.** "`position:absolute` against `#grid`" is not a reason, and neither is "relies on SVG document order for stacking". The honest argument was that these are recomputed wholesale every render so reconciliation has nothing to conserve, and it had never been measured. A full render of the 135-task plan takes about a millisecond, and 6 to 7ms after the port against a 5ms quiet threshold, so there was no headroom being protected. Deleting the imperative sweep was load-bearing. `renderInner` cleared `.gl,.gl-lab,.nwd` out of `#grid` before rebuilding them, and left in place it threw `NotFoundError: The node to be removed is not a child of this node` once the reconciler got there first. `.gl-lab` had no producer at all.

What replaced the exceptions is coverage: 47 browser checks were added alongside, including the walkthrough's missing-frame path.

### Porting the grid

The row loop was the last region and had the most invariants. Two survived intact and a rewrite could quietly drop either: a folded lane reuses one row element for several bars, so "a row per task" is not the shape of the tree, and `POS` keys row nodes by task id, which is now a ref map filled by the reconciler.

The regression fingerprint is paint, not geometry. That was forced. The first version carried `left`/`top`/`width`/`height` and passed on a laptop while failing in CI on the same commit (`left: 1072.98px` against `1079.74px`). The label column's width is measured from text with canvas `measureText`, so every pixel is downstream of font metrics, which differ between macOS and Linux. A golden that encodes them is only right on the machine that wrote it. Layout is covered by checks that compare against themselves. The port was gated on the fingerprint and matched byte for byte across all three shapes on the first green run.

It also surfaced a bug masked for as long as it existed. `#chart`'s click handler deselects on a click that did not travel 4px, and took its origin from a `pointerdown` listener on the bubble phase. The handlers that stop propagation to claim a gesture (`startDrag` on the grip most of all) meant the origin was never recorded for the gestures the distance test measures. It went unnoticed because rows were destroyed on every render, so the click had nowhere coherent to land. React keeps the row, so a 90px grip drag read as a click on empty chart and cleared the selection. The listener is on the capture phase now.

One workaround was not retired. `render()` still saves and restores `window.scrollY` and `#chart.scrollLeft`. The browser suite's scroll check passes with those two lines deleted, but it runs an eleven-row fixture whose chart clamps `scrollLeft` to 15px, and the bug they prevent concerns a long document being momentarily shortened. The comment on them says what would settle it.

## Alternatives Considered

- Stop at `tsc` with the plain ES module: no new dependency and the browser runs the code verbatim. Rejected because the render model keeps producing the same four patches, and a reconciler removes the category.
- Rewrite the page in React in one pass: rejected because the page runs a live delivery schedule and had no tests to make a rewrite safe. Region-by-region porting, with checks written against the old behaviour first, kept each step verifiable.
- A state library (Redux, Zustand, context): rejected, see Decision.
- Bundle `shared/` into the page too: rejected because it breaks the parity gate, see above.

## More Information

- Related: [2026-08-20-use-a-server-authoritative-command-log.md](2026-08-20-use-a-server-authoritative-command-log.md).
- Rewritten 2026-11-13 from ADR 0004; alternatives reconstructed from code and history where the original did not record them.
