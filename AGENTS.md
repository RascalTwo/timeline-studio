# Working on Timeline Studio

**Two audiences, two files.** This one is for an agent working in this repository: how
the tool is built, where its boundaries are, and what the deploy asserts. The other is
[`web/AGENTS.md`](web/AGENTS.md), which is served at `/AGENTS.md` to anyone holding a
share link and says how to drive a PLAN over HTTP. It deliberately mentions nothing about
this repository — no paths, no build commands, no ADRs — because a reader on the far end
of that link cannot see any of it.

ADRs belong here, not there. `docs/adr/` is a record of decisions taken while building
the tool; it is development history, and it is noise to anybody who only wants to add a
task.

**[`docs/remaining-work.md`](docs/remaining-work.md)** is the current handoff:
what is covered, what is not, what has been ruled out with measurements, and what
must not be "fixed".

**The page is built now, and it is React.** `web/src/app.ts` plus
`web/src/ui/*.tsx` are bundled by Vite into `web/dist/`, so a source edit changes
nothing anybody can see until something builds it.

`app.ts` owns the document, the socket, the scheduler wrappers and every derived
number; `ui/*.tsx` are presentation and take no domain type but `Id`, so a
component cannot compute a date and therefore cannot disagree with the chart.
`ui/mount.tsx` is the readable list of which containers React owns, and that now
includes the chart itself (`#rows`). What is still imperative is the background
furniture — gridlines, day bands, rules, flags, the axis and the arrow layer — all
of which are absolutely positioned against `#grid` or in flow above the rows. See
[`docs/adr/0004`](adr/0004-react-behind-a-bundler-shared-code-in-front-of-it.md)
for that and the three other deliberate exceptions. `npm run build` in `scripts/` does both halves — `shared/*.ts`
with tsc, the page with Vite — and installs `web/`'s dependencies if they are
missing. Every deploy path and every CI job runs that one line.

Three suites, and each one is checked by its **exit code**. A failure in the
scheduler harness *removes* a line from the log rather than adding one, which is
how it was last missed.

| | |
|---|---|
| `npm test` in `sync-server/` | the room, the scheduler, the cost budgets, the bundle's shared-code externals. Builds first. |
| `npm run test:playback` in `scripts/` | the real page in headless Chrome against a stub API. ~20s, no AWS. This is the only thing that sees the DOM. |
| `scripts/assert-shared-parity.sh` | ADR 0001: one copy of the scheduler, and the running server agrees with it. |
| `npm run format:check` in `scripts/` | oxfmt 0.71.0, defaults, over every tracked `.ts`/`.tsx` except `*.d.ts` (the scope is the glob in `scripts/package.json`; nothing else is formatted). 0.1s, lists the files that differ. **Fix with `npm run format`, and run that before you commit** — the gate refuses an unformatted file before it starts the suites, and it is never known-red. |
| `npm run lint` in `scripts/` | type-aware Oxlint (viz's rule set) over the four TypeScript programs, each linted from its own folder. ~2s, zero findings or fail. See below. |
| `npm run coverage` in `scripts/` | **The coverage floor.** Reads what the sync-server suite (`NODE_V8_COVERAGE`, converted by `scripts/coverage-server.ts` as the last step of its `npm test`) and the browser suite (`test:playback:cov`: V8 coverage of the one page, through the source maps) left in `.verify/coverage/`, prints one line per suite (`coverage: server lines 96.7% branches 87.9% (floor …)`) and fails if lines or branches are below `scripts/coverage-floor.json`. Seconds; it measures nothing itself. See below. |
| `npm run check` in `scripts/` | **`lint`, `format:check`, `tsc -p scripts/tsconfig.json` (the harness), then `bun scripts/check-suites.ts`, which compiles `shared/`, typechecks `web/` and builds both bundles once and then runs the sync-server suite, the browser suite on the UNMINIFIED bundle (`web/dist-cov`, the one coverage is measured on) and the browser suite on the MINIFIED bundle the deploy ships (`web/dist`) together; then the parity check and `coverage`; one command, one exit code.** ~75s on a quiet machine. `CHECK_BROWSERS` (default 2) is how many browsers run at once: `CHECK_BROWSERS=1 npm run check` runs them one after the other (~130s), the setting to reach for if a busy machine makes checks flake. Each browser run has its own port (`HARNESS_PORT`: 5211 minified, 5212 coverage). |
| `test/openapi.test.ts` in `sync-server/` | Part of `npm test`. Pins `src/openapi.ts` to the routes `server.ts` registers and to `applyCommand`'s own switch, in both directions. |
| `scripts/check-gate.sh` | `npm run check`, plus the `known-red.txt` comparison. **This is what the pre-commit hook runs.** |

**All four TypeScript programs (`shared/`, `web/`, `sync-server/`, `scripts/`) compile under the same flag set**: viz's `STRICT`
(including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature`) plus
`noUncheckedSideEffectImports` and `erasableSyntaxOnly`. `sync-server/test/tsconfig-strict.test.ts` pins them, so a flag cannot be
loosened quietly, and holds every `// @ts-ignore` / `// @ts-expect-error` to a written reason (`@ts-nocheck` is banned). The harness is
under `tsc` because Bun strips types without checking them.

**Lint is zero findings or fail, and has no known-red ledger.** `scripts/lint.ts` runs Oxlint 1.86.0 with
tsgolint (the type-aware engine) once per program (`sync-server/`, `web/`, `shared/`, `scripts/`), with that
program's folder as cwd, because type-aware rules read the tsconfig there: from anywhere else every type is
`any` and the unsafe-* rules find nothing. Every category is on except `style` (oxfmt's); `react` and
`jsx-a11y` run on `web/` only. The rules that are off are `OFF_RULES` (and `TEST_OFF_RULES` for `test/`) in
`scripts/lint-config.ts`, a map from rule to reason: an entry needs a reason that says what in *this repo*
makes the rule inapplicable, and "taste" is not one. A disable comment is
`// oxlint-disable-next-line <rule> -- <why>`: a bare one fails, and so does one whose finding is gone.
`sync-server/test/lint-engine.test.ts` fails if the engine silently stops being type-aware or a program lints
no files.

**Coverage only goes up.** `scripts/coverage-floor.json` holds four numbers, lines and branches for the server suite
(`sync-server/src`, including `server.ts` and `idle-shutdown.ts`, plus the `shared/*.ts` it exercises) and for the page
(`web/src`), each rounded *down* to 0.1%. Below one of them fails the gate, and like lint and format that is never known
red: `check-gate.sh` reads it before `known-red.txt`, and fails a run in which the coverage step never printed its
summary. **A local run above a floor rewrites the file and says `stage scripts/coverage-floor.json`**; with `CI` set
nothing is ever written. The uncovered lines are listed in `.verify/coverage/{server,page}-uncovered.txt`.

**The measurement is deterministic, and keeping it so is part of the job.** A floor that follows a number which moves
between identical runs fails the next run after a lucky one. Two things were wrong and are fixed; do not reintroduce them.
Node's own lcov reporter merges the test processes' V8 ranges unstably (the same suite read 95.2-95.5% of lines and a branch
denominator that drifted by a dozen), so the server side merges the raw ranges with `@bcoe/v8-coverage` and converts once,
the way the page does (`coverage-v8.ts`). And the page has callbacks whose outcome is the machine's speed or the minute the
suite runs at (a frame callback, a 3.5s timer, a rate limiter, a race between a socket frame and a click, `location.reload()`
discarding the counters): each carries a `/* v8 ignore … -- why */` in `web/src/app.ts` saying which. Six runs, three of them
at `HARNESS_CPU_THROTTLE=4`, now give identical counts. If a new run of the same code gives a different number, find the
race and either fix it or ignore it with its reason; do not widen anything.

The page is measured on an *unminified* build (`vite build --minify false` into `web/dist-cov`, which only `test:playback:cov` does) so V8's
block ranges map to real source branches; the gate runs the browser suite a second time on the minified bundle, because
that is what ships. Nothing is measured from nothing: a suite that leaves no data, a measured file no test loaded, a script
that maps to no source, and a file neither included nor excluded all fail. Every exclusion needs a reason: either an
`exclude` entry with a `why` in the floor file, or `/* v8 ignore next -- why */` (also `ignore next N`, `ignore start` /
`ignore stop`, and `node:coverage` for the same) in the source; a bare one fails, and the excluded lines and files are
counted in the summary. `sync-server/test/coverage-floor.test.ts` proves the enforcement (below the floor fails, at it
passes, above it raises, CI never writes, a reasonless exclusion fails). `sync-server/test/server.test.ts` boots the real
`server.ts` against `test/fake-s3.ts` (an in-process S3, via `S3_ENDPOINT`) so its handlers and socket loop run in the gate.
Do not chase a number by editing the floor down: restore the coverage, or exclude with a reason.

**A pre-commit hook runs the gate, so this is a fact rather than an instruction.**
It fires only when `timeline-studio/` is staged and not when every staged path
under it is markdown; override with `git commit --no-verify`. It is NOT in
pre-push, because pre-push here is the publish guard — by the time it runs you
are already shipping — and it is not only in CI, because CI *is* the deploy
workflow: that runs on a push to `main`, `main` is only reached by publishing, so
before the hook nothing on `private/trunk` ever ran the browser suite. It had
been red for several commits (2026-09-19: fifteen failures and a crash) and
nobody could have known.

**`.git/hooks` is per-clone and not version controlled**, which is the one thing
the automation cannot do for itself: on a fresh clone the gate is simply absent.
Run `scripts/install-hooks.sh` once, and any time you want to overwrite it with
the current version.

`known-red.txt` is a ledger, not a mute button: the gate fails on anything red
that is not named there, AND on a name there that has started passing.

**A schema change runs against your real local plans the moment you build it.**
`scripts/local-up.sh` starts the sync server under `tsx watch`, so rebuilding
`shared/*.js` restarts it, and the server upgrades every plan it opens and writes the
result back. The unsaved draft is archived to History first (`before upgrade vN → vM`),
so a wrong rung is one Revert away — but test a new rung before you build it, not after.

**Removing something: keep every rung, write no tombstone.** Migration rungs stay forever;
History holds every version in the schema it was saved in, and each one must still open.
A removed command or field gets NO refusal that names it: it fails like any unknown
command or a misspelt field (`addTask` and the document check in `validate.ts` refuse task
keys `TASK_FIELDS` does not list), so nothing in the code remembers it once its rung is
written. Removing a task field therefore needs a rung that drops it, or every stored plan
still carrying it is refused.

**UI and API are both complete.** Everything you can do on the page must be doable over
the API, and everything the API can do must be reachable on the page — rendering aside.
A change to either side is not finished until the other can do it too. See
[`docs/adr/0008`](docs/adr/0008-the-api-is-the-product.md).

### Verifying the live page from a driven browser

**A backgrounded tab does not run `requestAnimationFrame`, and the arrow layer is
drawn in one.** Chrome suspends rAF entirely in a hidden tab, so `#arrows` stays
empty and unsized at its 300×150 default — which reads exactly like the
dependency arrows being broken. They are not; hover a bar and they appear,
because the hover path calls `drawArrows` directly. `padForPanel` is deferred the
same way.

`drawArrows` sizes `#arrows` from the grid on its FIRST line, so the tell is the
size, not the content: an svg still at 300×150 means the function never ran, and
an svg matching `#grid.offsetWidth` with no paths means it ran and found nothing.
The browser suite checks both, in a foregrounded headless page.

**`shared/schedule.js` and `shared/commands.js` are deliberately NOT bundled** —
see [`docs/adr/0004`](adr/0004-react-behind-a-bundler-shared-code-in-front-of-it.md).
The page imports them from the site root so the browser runs the same bytes the
server hashed, and `/commands.js` stays readable as the protocol reference this
file points you at. If you find yourself making the bundler swallow them, you are
quietly switching off the gate that keeps the two sides honest.

**A library `shared/` calls is vendored, not imported** — the same reason: a bare
`import "pkg"` means nothing to a browser loading `/commands.js`. To add one:

1. `npm --prefix web install --save-exact <pkg>` — `github:owner/repo#sha`, a
   registry version, or a tarball URL (a range like `^5` pins nothing)
2. add `"<import specifier>": "<file>.js"` under `vendor` in `web/package.json`
3. `bun scripts/sync-vendor.ts`

That writes `shared/<file>.js` with the pin and a body hash in its header, links it
from `web/` (which makes it shared to parity, deploy and the dev server) and
un-ignores it in git. `sync-server/test/vendor.test.ts` fails on a stale or
hand-edited copy. To bump one: change the pin, reinstall, re-run step 3.

