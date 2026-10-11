// SCHEDULER HARNESS — runs the REAL functions out of the page, in node.
//
//   node verify.sched.mjs            (from anywhere — paths are relative to this file)
//
// It runs as the second half of `npm test` in sync-server/, so it cannot rot
// unnoticed again. It used to sit outside every run, which is how it spent a
// while unable to even resolve its own imports.
//
// It EXTRACTS the declarations by name from the page's module script and
// evaluates them; it does not copy them. A copy is a second implementation that
// passes while the real one rots, which is the failure mode this file exists to
// avoid — the scheduler is the one thing in this tool that must not break, and a
// green test measuring a stale duplicate is worse than no test.
//
// It is the FAST loop for anything in `sched()`, `spanOf()` and
// `auditSchedule()`. What it cannot see is the render layer, because there is no
// DOM here — and it cannot see a calendar leaking from the loaded document into
// a fixture either, because in here every calendar is whatever the caller passed.
// Both of those need a browser: `scripts/playback-harness.ts` is where they live
// now, against a stub API and headless Chrome.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as S from "../../shared/schedule.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// THE PAGE'S SCRIPT, WHEREVER IT CURRENTLY LIVES — and it has moved twice in one
// day. It read `web/index.html` and sliced from `<script type="module">` until
// the script was lifted out into `web/src/app.ts`; it then read the tsc output at
// `web/app.js`. Both moves broke it the same way: it threw on the first `declOf`
// before running a single check, which is the "green-by-never-running" failure
// the note below already records from `4e25888`. Three times in one file's
// history, so `npm test` checks the EXIT CODE now, not the log — this failure
// removes a line rather than adding one, which is how the last one was missed.
//
// IT READS THE SOURCE AND STRIPS THE TYPES ITSELF, since 2026-09-05. Reading a
// build output stopped being possible when the bundler arrived: Rollup
// deconflicts the page's wrappers against the imports they wrap (`spanOf`
// becomes `spanOf$1`), rewrites `const` to `var`, and drops every comment — so
// slicing ~30 declarations out by name finds none of them, minified or not.
//
// `stripTypeScriptTypes` is stdlib (`node:module`) and, in `strip` mode,
// overwrites annotations with spaces rather than deleting them: the output is
// byte-for-byte the same length as the input, so comments, line numbers and the
// brace-walking slicer below all still line up with the file on disk. It also
// removes the build-order dependency entirely — there is nothing to build first,
// so there is no way to test yesterday's artefact by accident.
//
// It is still EXTRACTION, not a copy: these are the page's own declarations, out
// of the page's own file. That is the property this harness exists to keep.
const SRC = stripTypeScriptTypes(readFileSync(join(HERE, "../../web/src/app.ts"), "utf8"),
                                 { mode: "strip" });

// The page has two <script>s and only one of them is code. Anchor on the module
// one rather than the first match, or the demo plan's JSON gets parsed as source.
// The whole file is the script now; there is no tag to slice from.
const BODY = SRC;

// WHERE A TOP-LEVEL DECLARATION ENDS. A line-based guess is wrong here — these
// functions carry comment blocks, template literals with `${}` in them, and
// regexes — so this walks characters with just enough of a tokenizer to know
// when a brace is a brace.
//
// IT DOES NOT TOKENIZE REGEX LITERALS, and the line above used to imply it did.
// A regex survives only because its contents happen to mean nothing here; put a
// quote or a backtick inside one — /[&<>"]/ — and the scanner reads it as the
// start of a string, runs off the end, and throws "unterminated declaration"
// before any check runs. `esc` and `mdInline` in app.ts spell those characters
// as \u escapes for exactly this reason. Teaching it regexes properly means
// distinguishing division from a literal, which is why it has not been done. Depth back to zero and then a `;` (or the closing `}`
// of a function statement) is the end.
function endOfDecl(s, i, isFn) {
  let depth = 0;
  const tpl = [];                       // template-literal nesting, one slot per `${`
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    // The literal part of a template is checked FIRST, because in there a `//`
    // is two slashes and an apostrophe is an apostrophe. Only `${` and the
    // closing tick mean anything.
    if (tpl.length && depth === tpl[tpl.length - 1]) {
      if (c === "\\") { i += 2; continue; }
      if (c === "$" && n === "{") { depth++; i += 2; continue; }
      if (c === "`") { tpl.pop(); i++; continue; }
      i++; continue;
    }
    if (c === "/" && n === "/") { i = s.indexOf("\n", i); if (i < 0) return s.length; continue; }
    if (c === "/" && n === "*") { i = s.indexOf("*/", i) + 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < s.length && s[i] !== c) i += s[i] === "\\" ? 2 : 1;
      i++; continue;
    }
    if (c === "`") { tpl.push(depth); i++; continue; }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (tpl.length && depth === tpl[tpl.length - 1] && c === "}") { i++; continue; }
      if (depth === 0 && isFn && c === "}") return i + 1;
    } else if (c === ";" && depth === 0) return i + 1;
    i++;
  }
  throw new Error("unterminated declaration");
}

// Only column-0 matches count, because that is what "top-level" means in this
// file and a same-named local would otherwise win.
function declOf(name) {
  const re = new RegExp(`^(?:function|const|let)\\s+${name}\\b`, "m");
  const m = re.exec(BODY);
  if (!m) throw new Error(`web/src/app.ts has no top-level \`${name}\` — has it been renamed, `
    + `or moved inside another function? Nothing needs building first: this reads `
    + `web/src/app.ts directly.`);
  return BODY.slice(m.index, endOfDecl(BODY, m.index, m[0].startsWith("function")));
}

// `doc` is the loaded document and there is none here. Both `sched()` and
// `auditSchedule()` only reach for it as a DEFAULT argument, and every call in
// this file passes lanes explicitly — which is exactly why those parameters
// exist.
// WHAT MOVED OUT IS IMPORTED, NOT EXTRACTED. `4e25888` moved the scheduler into
// schedule.js and this harness kept looking for it in the page, so it threw on
// `CAL_ALL` before running a single check — green-by-never-running, which is the
// one failure worse than a red suite. Anything that is a real module export is
// now imported below and injected; extraction is only for what still lives ONLY
// in the page. The page's own wrappers are still extracted, so the `cal = CAL`
// defaults ~50 call sites rely on are still the ones under test.
const NAMES = [
  "CAL", "spanOf", "endOf", "snapFwd", "workDaysIn",
  // The `sched` wrapper defaults `today` to `todayD()`, so its chain has to
  // resolve even though every fixture call below opts out with `-Infinity`. A
  // fixture is a dated record with a known answer, not a forecast: floor one
  // against the real clock and the suite starts failing overnight, on nothing.
  "d0", "dayOf", "todayD",
  // The day-number <-> ISO pair, now that a day number can carry a time of day.
  "isoOf", "isoTimeOf",
  // Whether a channel value still has live work under it. `colorsOf` comes too:
  // `valsOf` closes over it for the one multi-valued channel, and extraction is
  // by name, so a dependency left behind throws at call time rather than load.
  "colorsOf", "valsOf",
  "sched", "finishOf", "auditSchedule",
  "REFERENCE", "REFERENCE_FINISH",
  "REFERENCE_WW_CAL", "REFERENCE_WW", "REFERENCE_WW_STARTS", "REFERENCE_WW_FINISH",
  "REFERENCE_HOL_CAL", "REFERENCE_HOL", "REFERENCE_HOL_SPAN",
  "REFERENCE_ACT_CAL", "REFERENCE_ACT", "REFERENCE_ACT_STARTS", "REFERENCE_ACT_FINISH",
  // MOVED HERE FROM THE PAGE, 2026-09-07. This one was asserted ONLY by the
  // browser self-test, so deleting that duplicate would have taken the exempt-work
  // plan's only coverage with it. Everything else the self-test ran was already
  // below; this was not.
  "REFERENCE_NQ", "REFERENCE_NQ_STARTS", "REFERENCE_NQ_FINISH",
  // The graph lens's layout. Pure arithmetic over tasks, so it belongs in the
  // fast loop — and the browser fixture is twelve tasks in a near-straight line,
  // which cannot tangle no matter how the ordering is broken.
  "COL_GAP", "depthsOf", "layoutOf", "countCrossings",
  // The Order chip's two decisions: WHETHER the answer is worth recomputing, and
  // WHERE it is computed. Both are pure given a document — that is why they take
  // one — and both are wrong in a way nothing else would notice: a signature that
  // misses a field leaves a stale suggestion on screen, and a cost estimate that
  // reads low sends a 7-second search to the main thread.
  "orderSig", "reorderUnits",
  // Date mode's row order. Pure given the tasks and their computed starts, so it
  // belongs in the fast loop rather than the browser suite — and it is the one
  // part of that view with an invariant a future edit could silently break.
  "dateRowOrder",
];
// `doc` is a real binding here rather than a stub: `layoutOf` reads `doc.lanes`
// and `doc.tasks` for its tie-breaks, so a test sets it before calling.
// The page imports these under `_`-prefixed names and wraps them; the wrappers
// are what NAMES extracts, so the originals have to be in scope under exactly
// those names for the wrappers to resolve.
const INJECT = {
  DAY: S.DAY, CAL_ALL: S.CAL_ALL, makeCal: S.makeCal, calOf: S.calOf,
  _spanOf: S.spanOf, _endOf: S.endOf, _snapFwd: S.snapFwd,
  _sched: S.sched, _finishOf: S.finishOf, _hopsUp: S.hopsUp, _workDaysIn: S.workDaysIn,
  todayISO: S.todayISO,
  // UNPREFIXED, because `auditSchedule` calls it directly rather than through a
  // wrapper — it needs the same view of the task list that `sched` schedules, or
  // it audits the raw document and contradicts the answer it is checking.
  scheduleView: S.scheduleView, plannedOf: S.plannedOf,
  // `orderSig` is the shared `orderSignature` now — the server's Auto-order asks
  // the same question — so the page's one-line wrapper needs it in scope.
  orderSignature: S.orderSignature,
};
const src = "let doc = null; const setDoc = d => { doc = d; };\n" + NAMES.map(declOf).join("\n\n")
  + `\nreturn { ${NAMES.join(", ")}, CAL_ALL, makeCal, setDoc };`;
const M = new Function(...Object.keys(INJECT), src)(...Object.values(INJECT));

// ---------------------------------------------------------------------------
let fails = 0, checks = 0;
const ok = (cond, what) => { checks++; if (!cond) { fails++; console.log("  FAIL  " + what); } };
const near = (got, want, what) =>
  ok(Math.abs(got - want) < 1e-9, `${what}: got ${got}, expected ${want}`);
const silent = (bad, what) =>
  ok(bad.length === 0, `${what}: audit said ${JSON.stringify(bad)}`);
const group = name => console.log("• " + name);

// ---- the fixtures the page already asserts on every load -------------------
// Duplicated here on purpose: the page's selftest() runs in a browser, and this
// is the loop you can run in a second. Same fixtures, same expected numbers,
// pulled from the same source.
group("REFERENCE — serial lanes, gating, tie-break, a fraction, a losing pin");
{
  const st = M.sched(M.REFERENCE, [], M.CAL_ALL, -Infinity);
  near(M.finishOf(M.REFERENCE, st, M.CAL_ALL), M.REFERENCE_FINISH, "finish");
  silent(M.auditSchedule(M.REFERENCE, st, [], M.CAL_ALL), "REFERENCE");
}

group("REFERENCE_WW — a five-day week, weekends inside tasks, a snap tie-break");
{
  const st = M.sched(M.REFERENCE_WW, [], M.REFERENCE_WW_CAL, -Infinity);
  for (const [id, want] of Object.entries(M.REFERENCE_WW_STARTS)) near(st[id], want, `${id} starts`);
  near(M.finishOf(M.REFERENCE_WW, st, M.REFERENCE_WW_CAL), M.REFERENCE_WW_FINISH, "finish");
  silent(M.auditSchedule(M.REFERENCE_WW, st, [], M.REFERENCE_WW_CAL), "REFERENCE_WW");
}

group("REFERENCE_NQ — work exempt from its lane's queue neither waits nor holds a slot");
{
  const st = M.sched(M.REFERENCE_NQ, [], M.CAL_ALL, -Infinity);
  for (const [id, want] of Object.entries(M.REFERENCE_NQ_STARTS)) near(st[id], want, `${id} starts`);
  near(M.finishOf(M.REFERENCE_NQ, st, M.CAL_ALL), M.REFERENCE_NQ_FINISH, "finish");
  // And the audit has nothing to say about a lane momentarily running three
  // tasks, two of which are not in its queue.
  silent(M.auditSchedule(M.REFERENCE_NQ, st, [], M.CAL_ALL), "REFERENCE_NQ");
}

group("REFERENCE_HOL — a day off on a working weekday");
near(M.spanOf(M.REFERENCE_HOL[0], 0, M.REFERENCE_HOL_CAL), M.REFERENCE_HOL_SPAN, "span");

group("REFERENCE_ACT — a fact beats the calendar, and the audit stays quiet");
{
  const A = M.REFERENCE_ACT, S = M.REFERENCE_ACT_STARTS, C = M.REFERENCE_ACT_CAL;
  const by = Object.fromEntries(A.map(t => [t.id, t]));
  // The scheduler must ARRIVE at the hand-written record, not near it.
  const st = M.sched(A, [], C, -Infinity);
  for (const [id, want] of Object.entries(S)) near(st[id], want, `${id} starts`);
  near(M.finishOf(A, st, C), M.REFERENCE_ACT_FINISH, "finish");
  silent(M.auditSchedule(A, st, [], C), "REFERENCE_ACT");

  // AND THE FIXTURE REALLY IS ILLEGAL, which is the half that stops the silence
  // above being an assertion that cannot fail. One probe per rule.
  const bare = A.map(({ actualStart, actualEnd, ...t }) => t);
  const loud = M.auditSchedule(bare, S, [], C);
  for (const [rule, re] of [["dependency", /waits on/], ["non-working day", /not a working day/]])
    ok(loud.some(m => re.test(m)), `without the actuals the audit should still catch ${rule}: ${JSON.stringify(loud)}`);
  // The other two rules cannot be shown that way, because a span stripped back
  // to `dur` holds `dur` working days by construction — they only exist once
  // `spanOf` reads an actual end. So they are shown against the real fixture.
  for (const id of ["a2", "a4", "a5"])
    ok(Math.abs(M.workDaysIn(S[id], M.spanOf(by[id], S[id], C), C) - by[id].dur) > 1e-6,
       `${id}'s observed span should NOT hold its ${by[id].dur}-day estimate`);
  ok(S.a6 < M.endOf(by.a5, S.a5, C) - 1e-9 && by.a5.lane === by.a6.lane,
     "a5 and a6 should overlap in a lane the capacity says holds one");
  // The branch itself: three calendar days, not the four the estimate walks to.
  near(M.spanOf(by.a4, S.a4, C), 3, "a4's observed span");
  near(M.spanOf(bare.find(t => t.id === "a4"), S.a4, C), 4, "a4's ESTIMATED span, for contrast");
}

// ---- the floor ------------------------------------------------------------
// `today` is passed as a literal, never read off the clock, so this fixture has
// one answer forever. That is the whole reason `sched` takes it as an argument.
group("today floors a forecast, and never touches a fact");
{
  const T = [
    { id: "never", lane: "L", dur: 2, deps: [] },                  // nobody started it
    { id: "began", lane: "M", dur: 2, deps: [], actualStart: 0 },  // really began at day 0
    { id: "after", lane: "N", dur: 1, deps: ["began"] },           // waits on something past
  ];
  const st = S.sched(T, [], S.CAL_ALL, 5);
  near(st.never, 5, "an unstarted task cannot claim to have begun three days ago");
  ok(st.why.never === "today", `and it says why rather than "nothing": got ${st.why.never}`);
  near(st.began, 0, "a recorded start is a fact, and a fact is not moved by the clock");
  ok(st.why.began === "actual", `a fact stays its own reason: got ${st.why.began}`);
  near(st.after, 5, "a dependent of work that ended in the past lands on today, not behind it");

  // THE FALSIFIER, and the case that makes the floor safe rather than merely
  // stricter: on a plan that has not started yet `today` is NEGATIVE, and a
  // negative floor must change nothing at all. If this drifts, every plan dated
  // next month quietly reschedules against a day it has never reached.
  const soon = S.sched(T, [], S.CAL_ALL, -3);
  near(soon.never, 0, "a plan dated in the future schedules exactly as it always did");
  ok(soon.why.never === "free", `and keeps the reason it had: got ${soon.why.never}`);
}

group("a hand-edited file whose finish precedes its start");
{
  const C = M.REFERENCE_ACT_CAL;
  // Nothing in the UI can write this pair; a text editor can. Taking it at face
  // value returns a negative span, which puts a task's end before its own start
  // and lets a dependent be scheduled before its predecessor began.
  const bad = { id: "x1", lane: "X", dur: 3, deps: [], actualStart: 7, actualEnd: 2 };
  const good = { id: "x2", lane: "X", dur: 3, deps: [] };
  near(M.spanOf(bad, 7, C), M.spanOf(good, 7, C), "a reversed pair falls back to the estimate");
  ok(M.endOf(bad, 7, C) > 7, `endOf must not land before the start, got ${M.endOf(bad, 7, C)}`);
  // And it is REPORTED. This is the one check that is not skipped for work that
  // has happened, because it is a question about the file rather than the plan.
  const said = M.auditSchedule([bad], { x1: 7 }, [], C);
  ok(said.some(m => /finished 2 but started 7/.test(m)),
     `the audit should name an impossible pair of dates, said ${JSON.stringify(said)}`);
  // The equal case is a fact since v8: a task finished without being started is one session of no length.
  near(M.spanOf({ ...bad, actualEnd: 7 }, 7, C), 0, "a finish at the start spans nothing");
  ok(!M.auditSchedule([{ ...bad, actualEnd: 7 }], { x1: 7 }, [], C).some(m => /finished/.test(m)),
     "and the audit does not call it incoherent");
}

group("the graph layout untangles a deliberately tangled plan");
{
  // SIX COLUMNS OF SIX, wired so the obvious ordering is the worst one: every
  // task in a column depends on the one in the REVERSED position of the previous
  // column, so declaration order guarantees a full crossing bundle at every step.
  // Plus a long edge from the first column to the last, which is the case the
  // dummy nodes exist for — nothing in the four columns between knows it is there
  // unless it is broken into pieces.
  const W = 6, D = 6, tasks = [];
  for (let d = 0; d < D; d++)
    for (let i = 0; i < W; i++)
      tasks.push({ id: `c${d}r${i}`, lane: "L", dur: 1,
                   deps: d === 0 ? [] : [`c${d - 1}r${W - 1 - i}`] });
  for (let i = 0; i < W; i++) tasks[i].deps = [];
  tasks[tasks.length - 1].deps = [...tasks[tasks.length - 1].deps, "c0r0"];
  M.setDoc({ lanes: [{ id: "L" }], tasks });

  const edgesOf = ts => ts.flatMap(t => (t.deps || []).map(d => ({ data: { source: d, target: t.id } })));
  const edges = edgesOf(tasks);

  // The naive layout this replaced: column by depth, declaration order down each
  // column, nothing reordered and long edges invisible.
  const depth = M.depthsOf(tasks);
  const naive = {}, seen = {};
  for (const t of tasks) {
    const d = depth[t.id];
    seen[d] = (seen[d] || 0);
    naive[t.id] = { x: d * M.COL_GAP, y: seen[d]++ * 62 };
  }
  const before = M.countCrossings(edges, naive);
  const after = M.countCrossings(edges, M.layoutOf(tasks, "").pos);
  ok(before > 30, `the fixture should be genuinely tangled to begin with, got ${before}`);
  ok(after * 4 < before, `the layout should untangle it: ${before} crossings -> ${after}`);
  console.log(`    ${before} crossings laid out naively, ${after} after ordering`);
  // And the long edge really is broken up, which is the mechanism under test.
  const out = M.layoutOf(tasks, "");
  const long = out.chains["c0r0>" + tasks[tasks.length - 1].id];
  ok(long && long.length > 2, `a ${D - 1}-column edge should be routed through bends, got ${JSON.stringify(long)}`);
  // AND THE BENDS LINE UP. Crossing counts say nothing about this — the ordering
  // can be perfect while the coordinate stage leaves a long edge as a staircase —
  // so the thing that stage exists for is asserted directly: a chain of bends all
  // pulling to the same height is what turns five diagonals into one straight
  // line. Half a row of drift is the tolerance; a staircase is several.
  if (long && long.length > 2) {
    const ys = long.slice(1, -1).map(id => out.pos[id].y);
    const spread = Math.max(...ys) - Math.min(...ys);
    ok(spread < 31, `a routed edge should come out straight, its bends span ${Math.round(spread)}px`);
  }
  M.setDoc(null);
}

// THE DESCRIPTION RENDERER IS NOT TESTED HERE ANY MORE, and that is a real
// reduction worth stating rather than quietly leaving a gap.
//
// It used to be thirty hand-rolled lines of pure string-in/string-out, which is
// exactly what this harness is good at: it extracted them from app.ts and threw
// XSS payloads at them. It is now three lines wrapping `marked` and `DOMPurify`,
// and this harness cannot reach it — it evaluates extracted SOURCE with
// `new Function`, so a function whose body depends on two ESM imports and a DOM
// has nothing to run against.
//
// What is left worth asserting is the WIRING — that DOMPurify is actually
// called, and that the target/rel hook fires — and that needs a DOM. Bringing it
// back means jsdom as a dev dependency and an import path this extractor does
// not have. Until then it is verified in the browser against the same payloads.

group("the demo plan schedules without contradicting itself");
{
  // THE DEMO IS THE FIRST THING ANYONE SEES, so it has to be a real plan rather
  // than a plausible-looking file. `sync-server/test/demo.test.ts` covers what it
  // CONTAINS — every task-level command exercised, read out of the protocol so
  // the list cannot go stale. This covers whether it HOLDS TOGETHER, and it lives
  // here because `auditSchedule` is the page's, not shared/'s.
  //
  // Not assertions about the bakery's content. The demo is a story and has to
  // stay free to change as one; pinning "the lease takes a day" would make every
  // retelling a test failure.
  // Projected to day numbers first: the stored times are instants (v6), and
  // `sched` counts in days — the page's guard does the same for every read.
  const demo = S.dayNumbers(JSON.parse(readFileSync(join(HERE, "../../web/demo-plan.json"), "utf8")));
  const cal = S.calOf(demo);
  M.setDoc(demo);
  const st = M.sched(demo.tasks, demo.lanes, cal, -Infinity);
  silent(M.auditSchedule(demo.tasks, st, demo.lanes, cal), "the demo plan");
  ok(Object.keys(st).length === demo.tasks.length, "every demo task was placed");
  M.setDoc(null);
}

// THE `spent` GROUP THAT WAS HERE MOVED TO THE BROWSER SUITE, 2026-09-20. The
// rule it checked — a channel value with no work left stops being offered — is
// still enforced, but `used()` now asks `drawn()` directly instead of calling a
// pure `spent()` helper, because the answer depends on the done and cancelled
// toggles and those are view state this sandbox has no way to set.
//
// NOT REPLACED ONE-FOR-ONE, AND THAT IS A REAL GAP. A browser check was written
// and then withdrawn: proving a chip disappears needs a channel value whose work
// is ENTIRELY over, and the stub plan has two lanes of five or six tasks each,
// so there is no value the suite can empty without inventing one. What still
// covers the rule is indirect — `used()` and `stat()` ask the same `drawn()`
// one line apart, and three checks in playback-harness.ts pin `stat()` against
// both toggles. If this fixture ever grows a single-task lane, the check to
// write is: finish it, the chip goes; tick `done`, the chip comes back.

group("a day number can carry a time of day");
{
  // The document has always stored days as a float - `dur: 0.25` is two hours -
  // so a time of day is the fractional part of a number that was already
  // fractional. These checks pin both halves of that: the old whole-day spelling
  // keeps its exact meaning, and a time survives the round trip the inspector
  // performs on every keystroke.
  M.setDoc({ start: "2026-09-19", lanes: [{ id: "L" }], tasks: [] });
  const close = (a, b, m) => ok(Math.abs(a - b) < 1e-9, `${m}: got ${a}, wanted ${b}`);

  // A BARE DATE IS UNTOUCHED, which is the whole backward-compatibility claim:
  // every plan written before this existed still reads exactly as it did.
  close(M.dayOf("2026-09-19"), 0, "the start date is day 0");
  close(M.dayOf("2026-09-22"), 3, "three calendar days later is day 3");
  close(M.dayOf("2026-09-19T00:00"), 0, "midnight and the bare date are the same number");
  close(M.dayOf("2026-09-19T12:00"), 0.5, "noon is half a day");
  close(M.dayOf("2026-09-20T17:15"), 1 + (17 * 60 + 15) / 1440, "a quarter past five on day 1");

  // THE REGRESSION THIS REPLACED. isoOf used to round, which was invisible while
  // every value was a whole number and prints TOMORROW the moment one is not.
  ok(M.isoOf(0.72) === "2026-09-19",
     `an afternoon on day 0 still belongs to day 0, got ${M.isoOf(0.72)}`);
  ok(M.isoOf(0) === "2026-09-19" && M.isoOf(3) === "2026-09-22", "whole days unchanged");

  // ROUND TRIP. The inspector reads a number out and writes a string back, so a
  // value that does not survive the trip is a field that rewrites itself.
  for (const iso of ["2026-09-19T00:00", "2026-09-19T08:00",
                     "2026-09-21T17:15", "2026-09-30T23:59"])
    ok(M.isoTimeOf(M.dayOf(iso)) === iso,
       `round trip ${iso} came back as ${M.isoTimeOf(M.dayOf(iso))}`);

  // AND A WHOLE DAY STILL EMITS A TIME, because <input type="datetime-local">
  // renders EMPTY when handed a bare date rather than degrading to a date.
  ok(/T\d\d:\d\d$/.test(M.isoTimeOf(6)), `a whole day needs a time too, got ${M.isoTimeOf(6)}`);
  M.setDoc(null);
}

group("edgeless tasks go in a block, not stacked in column 0");
{
  // A SHORT CHAIN PLUS A CROWD THAT DEPENDS ON NOTHING. The crowd is the shape a
  // real plan actually has — a third of the tasks on the one this was measured
  // against — and longest-path layering calls every one of them depth 0, so
  // before the paddock they landed in the same column as the chain's root and
  // buried it. The fixture is deliberately lopsided for that reason: four times
  // as much edgeless work as structure.
  const tasks = [
    { id: "a", lane: "L", dur: 1, deps: [] },
    { id: "b", lane: "L", dur: 1, deps: ["a"] },
    { id: "c", lane: "L", dur: 1, deps: ["b"] },
  ];
  for (let i = 0; i < 12; i++) tasks.push({ id: `o${i}`, lane: "L", dur: 1, deps: [] });
  M.setDoc({ lanes: [{ id: "L" }], tasks });

  const pos = M.layoutOf(tasks, "").pos;
  // NOTHING IS DROPPED. The block moves work out of the spine; it never hides it,
  // and a layout that improved the picture by losing a task would be a lie.
  ok(tasks.every(t => pos[t.id]), "every task still has a position");

  const loose = tasks.filter(t => t.id[0] === "o").map(t => pos[t.id]);
  // THE ASSERTION THAT FAILS ON THE OLD CODE: twelve edgeless tasks in a single
  // column is the wall this exists to break up.
  ok(new Set(loose.map(p => p.x)).size > 1,
     `edgeless tasks should spread across columns, all sat at x=${loose[0].x}`);
  // Below the chain rather than beside or among it, so the part of the picture
  // that has structure is the part at the top of the viewport.
  const spineBottom = Math.max(pos.a.y, pos.b.y, pos.c.y);
  ok(loose.every(p => p.y > spineBottom), "the block sits under the layered graph");
  // And the chain is untouched by any of it: still one column per step, in order.
  ok(pos.a.x < pos.b.x && pos.b.x < pos.c.x, "the chain still reads left to right");
  M.setDoc(null);
}

// ---- suggestReorders: the queue-order checker -------------------------------
// A LOCAL FIXTURE, not one lifted from the page, because this function lives only
// in schedule.js and is imported here rather than extracted. Two lanes: `T` is
// serial and holds a task nothing waits on (`idle`) in front of one that gates
// the other lane (`gate`). That is the exact shape that cost the real plan 32
// days, shrunk to something you can check by hand.
const ORDER_DOC = {
  schemaVersion: 4, title: "order", start: "2026-01-05",
  workweek: [1, 1, 1, 1, 1, 1, 1], holidays: [],
  lanes: [{ id: "T" }, { id: "U" }],
  colors: [{ id: "c", label: "c", color: "#fff" }],
  borders: [{ id: "b", label: "b", style: "none" }],
  fills: [{ id: "f", label: "f", pattern: "solid" }],
  shapes: [{ id: "s", label: "s", shape: "soft" }],
  milestones: [{ id: "m", label: "m", date: "2026-01-10" }],
  tasks: [
    { id: "idle", lane: "T", dur: 5, deps: [], ms: "m", label: "idle", color: ["c"], border: "b", fill: "f", shape: "s" },
    { id: "gate", lane: "T", dur: 5, deps: [], ms: "m", label: "gate", color: ["c"], border: "b", fill: "f", shape: "s" },
    { id: "waiter", lane: "U", dur: 1, deps: ["gate"], ms: "m", label: "waiter", color: ["c"], border: "b", fill: "f", shape: "s" },
  ],
};
const reordered = (doc, lane, from, to) => {
  const slots = doc.tasks.map((t, i) => (t.lane === lane ? i : -1)).filter(i => i >= 0);
  const ids = slots.map(i => doc.tasks[i].id);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  const by = Object.fromEntries(doc.tasks.map(t => [t.id, t]));
  const tasks = doc.tasks.slice();
  ids.forEach((id, k) => { tasks[slots[k]] = by[id]; });
  return { ...doc, tasks };
};
// THE SAME FLOOR `suggestReorders` SCORES WITH. This is the falsifier for the
// promised-vs-delivered check, so it has to be the identical computation —
// measuring an unfloored schedule against a floored promise compares two
// different plans and the agreement it reports would be a coincidence.
const finishDay = doc => {
  const cal = S.calOf(doc);
  const st = S.sched(doc.tasks, doc.lanes, cal, S.todayOf(doc));
  return S.finishOf(doc.tasks, st, cal);
};

group("suggestReorders — finds the idle-task-in-front-of-a-gate shape");
{
  const r = S.suggestReorders(ORDER_DOC);
  const top = r.suggestions[0];
  ok(!!top, "it should find at least one move");
  ok(top && top.lane === "T" && top.id === "idle",
     `the move should be idle out of the front of T, got ${top && top.lane + "/" + top.id}`);

  // THE FALSIFIER, and the only check here that really matters: a suggester that
  // reports a number it cannot deliver is worse than no suggester. Apply the move
  // it named and the plan must actually improve by exactly what it promised.
  const after = reordered(ORDER_DOC, top.lane, top.from, top.to);
  near(finishDay(ORDER_DOC) - finishDay(after), top.gains.finish,
       "promised finish gain vs the gain actually delivered by applying it");
  ok(top.gains.finish > 0, `the fixture should be genuinely improvable, got ${top.gains.finish}`);
  console.log(`    promised ${top.gain}d, delivered ${finishDay(ORDER_DOC) - finishDay(after)}d`);
}

group("suggestReorders — silent on a plan already in the right order");
{
  const best = reordered(ORDER_DOC, "T", 0, 1);          // gate first, idle behind
  const r = S.suggestReorders(best);
  ok(r.suggestions.length === 0,
     `an optimal queue should yield nothing, got ${JSON.stringify(r.suggestions.map(x => x.id))}`);
}

group("suggestReorders — surfaces a move that helps a MILESTONE but not the finish");
{
  // `late` is assigned to no milestone and finishes last either way, so the plan
  // finish cannot move; only the milestone can. A suggester ranking on finish
  // alone would report nothing here — which is exactly how the real plan's
  // 17-day CAB move nearly went unseen.
  const doc = structuredClone(ORDER_DOC);
  doc.milestones.push({ id: "z", label: "z", date: "2026-03-01" });
  // ITS OWN LANE, and that is the point of the fixture rather than an accident:
  // parked in `U` it queues behind `waiter`, so reordering `T` moves it too and
  // the finish changes — which is a different test from the one intended. The
  // finish has to be genuinely immovable for "milestone only" to mean anything.
  doc.lanes.push({ id: "V" });
  doc.tasks.push({ id: "late", lane: "V", dur: 40, deps: [], ms: "z", label: "late",
                   color: ["c"], border: "b", fill: "f", shape: "s" });
  const r = S.suggestReorders(doc);
  const top = r.suggestions[0];
  ok(!!top, "it should still find the move");
  ok(top && top.gains.finish === 0 && top.gains.m > 0,
     `finish should not move while milestone m does, got ${JSON.stringify(top && top.gains)}`);
}

// The clock, pinned to the plan's local midnight for the duration of `fn`. A forecast
// now starts at NOW (918bd57), so a fixture whose answer is "lands exactly on its due
// date" is only true at one instant — midnight — and fails by the time of day at any
// other. Pinning keeps the fixture's arithmetic and stops it depending on when it runs.
const atMidnight = (fn) => {
  const Real = Date, at = Real.parse(S.instantOfDay(0, { start: S.todayISO() }));
  globalThis.Date = class extends Real {
    constructor(...a) { super(...(a.length ? a : [at])); }
    static now() { return at; }
  };
  try { return fn(); } finally { globalThis.Date = Real; }
};

group("suggestReorders — a deadline miss is an objective, not just a readout");
atMidnight(() => {
  // THE CASE THE SEARCH WAS BLIND TO, and it is the commonest plan there is:
  // ONE serial lane, NO milestones. The finish date is invariant under
  // reordering there — same work, one worker, no gaps — so `finish` scores zero
  // on every permutation and the only other objective did not exist. Measured
  // on the real plan on 2026-09-20: 85 tasks, `suggestions: []`, three deadlines
  // being missed by 7.58 days in total, purely because of queue position.
  //
  // `urgent` is last in the queue and due almost immediately; `bulk` in front of
  // it is long and has no deadline at all. Nothing about the finish date changes
  // if they swap — which is the whole point of the fixture.
  //
  // IT STARTS TODAY, and that is load-bearing rather than tidy: `suggestReorders`
  // floors every schedule at `todayOf(doc)`, so a fixture dated January would put
  // day 0 eight months in the past and every deadline on it would already be
  // ancient history. The first draft of this check did exactly that and reported
  // 258 days of tardiness for a two-task plan.
  const doc = { schemaVersion: 4, start: S.todayISO(), milestones: [],
                lanes: [{ id: "L", cap: 1 }], colors: [], borders: [], fills: [], shapes: [],
                workweek: [0, 1, 2, 3, 4, 5, 6],
                tasks: [
                  { id: "bulk", lane: "L", dur: 10, deps: [], label: "bulk",
                    color: [], border: "b", fill: "f", shape: "s" },
                  { id: "urgent", lane: "L", dur: 1, deps: [], due: 2, label: "urgent",
                    color: [], border: "b", fill: "f", shape: "s" },
                ] };
  const r = S.suggestReorders(doc);
  const top = r.suggestions[0];
  ok(r.base.tardy > 0, `the base plan should be late, got ${r.base.tardy}`);
  ok(!!top, "a move that un-lates the urgent task should be found");
  // THE FALSIFIER FOR THE WHOLE TERM: finish must not move, so a suggester
  // scoring only finish — which is what this was until today — finds nothing
  // here and this line fails.
  ok(top && top.gains.finish === 0 && top.gains.tardy > 0,
     `finish should be flat while tardiness improves, got ${JSON.stringify(top && top.gains)}`);
  // ASSERTED BY APPLYING IT, not by naming it. "Move urgent to 0" and "move bulk
  // to 1" are the same permutation, and the search reports the best move PER
  // TASK — so which of the two sorts first is a tie-break, not a claim worth
  // pinning. What matters is that taking the advice removes the lateness.
  const after = doc.tasks.slice();
  after.splice(top.to, 0, after.splice(top.from, 1)[0]);
  ok(S.suggestReorders({ ...doc, tasks: after }).base.tardy === 0,
     `applying the top suggestion should clear the lateness, got ${S.suggestReorders({ ...doc, tasks: after }).base.tardy}`);
});

group("suggestReorders — a deadline met by four minutes is not a good answer");
atMidnight(() => {
  // TARDINESS IS A HINGE AND A HINGE HAS NO SLOPE ON THE SAFE SIDE, which is the
  // whole reason `tight` exists: once nothing is late the search has nothing left
  // to chase, and what it leaves behind is every deadline shaved to the bone.
  // `urgent` here finishes exactly on its due date with a long undated task in
  // front of it — nothing is late, so with no buffer there is nothing to say.
  const plan = (dueBuffer) => ({
    schemaVersion: 4, start: S.todayISO(), milestones: [], dueBuffer,
    lanes: [{ id: "L", cap: 1 }], colors: [], borders: [], fills: [], shapes: [],
    workweek: [0, 1, 2, 3, 4, 5, 6],
    tasks: [
      { id: "bulk", lane: "L", dur: 4, deps: [], label: "bulk",
        color: [], border: "b", fill: "f", shape: "s" },
      // DUE 6, WHICH IS EXACTLY WHEN IT LANDS. Work starts on day 1 here, not day
      // 0 — so `bulk` runs 1→5 and this runs 5→6. On time to the minute, which
      // is the state the whole `tight` term exists to be unhappy about.
      { id: "urgent", lane: "L", dur: 1, deps: [], due: 6, label: "urgent",
        color: [], border: "b", fill: "f", shape: "s" },
    ],
  });
  const none = S.suggestReorders(plan(0));
  ok(none.base.tardy === 0 && none.suggestions.length === 0,
     `nothing is late, so an unbuffered search should stay quiet, got ${JSON.stringify(none.suggestions.map(x => x.id))}`);

  // THE FALSIFIER FOR THE WHOLE TERM: same plan, same dates, a buffer on the
  // document — and now the zero-margin finish is worth moving. A search that
  // ignored `dueBuffer` returns the same nothing here and this line fails.
  const buffered = S.suggestReorders(plan(2));
  ok(buffered.base.tight > 0, `the buffered score should see the tight deadline, got ${buffered.base.tight}`);
  ok(buffered.suggestions.length > 0, "a buffer should make the knife-edge finish worth fixing");
  ok(buffered.suggestions[0].gains.tardy === 0,
     `nothing was late, so the gain must come from margin and not from lateness, got ${JSON.stringify(buffered.suggestions[0].gains)}`);
});

group("suggestReorders — margin is never bought with a real missed deadline");
atMidnight(() => {
  // `tight` and `tardy` are in the same unit, so without a constraint they trade
  // one for one: half a day of breathing room for half a day of genuinely
  // missing a promise, offered as an improvement. A broken promise is a
  // different KIND of thing, so a candidate that increases real lateness is not
  // considered at all — and with a buffer this wide every candidate is tempting.
  const doc = { schemaVersion: 4, start: S.todayISO(), milestones: [], dueBuffer: 30,
                lanes: [{ id: "L", cap: 1 }], colors: [], borders: [], fills: [], shapes: [],
                workweek: [0, 1, 2, 3, 4, 5, 6],
                tasks: [
                  { id: "tight-one", lane: "L", dur: 1, deps: [], due: 2, label: "tight",
                    color: [], border: "b", fill: "f", shape: "s" },
                  { id: "roomy", lane: "L", dur: 1, deps: [], due: 40, label: "roomy",
                    color: [], border: "b", fill: "f", shape: "s" },
                ] };
  const r = S.suggestReorders(doc);
  ok(r.base.tardy === 0, `the fixture should start with nothing late, got ${r.base.tardy}`);
  for (const sg of r.suggestions)
    ok(sg.gains.tardy >= 0,
       `no suggestion may increase real lateness, got ${sg.id} with ${JSON.stringify(sg.gains)}`);
});

group("suggestReorders — work that is over is not scored as late");
{
  // A finished task's end cannot move, so pricing its lateness would add the
  // same constant to every candidate and, worse, would offer moves that claim
  // to rescue history.
  //
  // A `dropped: true` task was the second case here until 2026-09-20, when
  // cancelling was retired. Worth knowing for a plan restored from an old
  // version: `suggestReorders` reads `d.tasks` directly rather than through
  // `scheduleView`, so a legacy abandoned task with a past deadline WILL be
  // scored as late by the search. The chart will not draw it as work, and the
  // first edit to the plan takes it out for good.
  const doc = { schemaVersion: 4, start: S.todayISO(), milestones: [],
                lanes: [{ id: "L", cap: 1 }], colors: [], borders: [], fills: [], shapes: [],
                workweek: [0, 1, 2, 3, 4, 5, 6],
                tasks: [
                  { id: "done-late", lane: "L", dur: 1, deps: [], due: 0, label: "done late",
                    actualStart: 0, actualEnd: 9, color: [], border: "b", fill: "f", shape: "s" },
                ] };
  ok(S.suggestReorders(doc).base.tardy === 0,
     `finished work should not be scored as late, got ${S.suggestReorders(doc).base.tardy}`);
}

group("suggestReorders — a lane past the guard is reported, not silently dropped");
{
  const doc = structuredClone(ORDER_DOC);
  const r = S.suggestReorders(doc, { maxLane: 1 });
  ok(r.skipped.some(x => x.lane === "T"),
     `lane T is over the cap and should be named in skipped, got ${JSON.stringify(r.skipped)}`);
  ok(r.suggestions.length === 0, "and nothing should be suggested from a skipped lane");
}

// ---- laneOrder: which team goes on top -------------------------------------
const LANE_TASK = (id, lane, deps) => ({ id, lane, dur: 1, deps, label: id,
  color: ["c"], border: "b", fill: "f", shape: "s", ms: "m" });
const LANE_DOC = (laneIds, tasks) => ({
  schemaVersion: 4, title: "lanes", start: "2026-01-05",
  workweek: [1, 1, 1, 1, 1, 1, 1], holidays: [],
  lanes: laneIds.map(id => ({ id })),
  colors: [{ id: "c", label: "c", color: "#fff" }],
  borders: [{ id: "b", label: "b", style: "none" }],
  fills: [{ id: "f", label: "f", pattern: "solid" }],
  shapes: [{ id: "s", label: "s", shape: "soft" }],
  milestones: [{ id: "m", label: "m", date: "2026-03-01" }],
  tasks,
});
// THE ORACLE. laneOrder searches; this enumerates. For a fixture this small the
// two must agree exactly, and if the search is ever replaced by something
// cleverer this is what says whether it still finds the floor.
const bruteLaneCost = doc => {
  const by = Object.fromEntries(doc.tasks.map(t => [t.id, t]));
  const w = new Map();
  for (const t of doc.tasks) for (const d of t.deps) {
    const a = by[d].lane, b = t.lane;
    if (a !== b) w.set(a + " " + b, (w.get(a + " " + b) || 0) + 1);
  }
  const E = [...w].map(([k, n]) => { const [a, b] = k.split(" "); return { a, b, n }; });
  const ids = doc.lanes.map(l => l.id);
  let best = Infinity;
  const walk = (rest, cur) => {
    if (!rest.length) {
      const p = Object.fromEntries(cur.map((l, i) => [l, i]));
      best = Math.min(best, E.reduce((s, e) => s + (p[e.a] > p[e.b] ? e.n : 0), 0));
      return;
    }
    for (let i = 0; i < rest.length; i++) walk(rest.slice(0, i).concat(rest.slice(i + 1)), cur.concat(rest[i]));
  };
  walk(ids, []);
  return best;
};

group("laneOrder — a clean flow sorts upstream to the top, and no arrow points up");
{
  // Deliberately typed in backwards: C, B, A for a flow A -> B -> C.
  const doc = LANE_DOC(["C", "B", "A"], [
    LANE_TASK("a1", "A", []), LANE_TASK("b1", "B", ["a1"]), LANE_TASK("c1", "C", ["b1"]),
  ]);
  const r = S.laneOrder(doc);
  ok(r.order.join() === "A,B,C", `expected A,B,C got ${r.order.join()}`);
  near(r.backward, 0, "a graph with no cycle should need no backward arrow");
  ok(r.was > 0, `the fixture should start wrong, it started at ${r.was}`);
}

group("laneOrder — a cycle cannot reach zero, so it minimises instead of throwing");
{
  // A -> B and B -> A, both real. One of them must point up whatever you do.
  const doc = LANE_DOC(["A", "B"], [
    LANE_TASK("a1", "A", []), LANE_TASK("b1", "B", ["a1"]),
    LANE_TASK("a2", "A", ["b1"]),
  ]);
  const r = S.laneOrder(doc);
  ok(r.backward >= 1, "a two-lane cycle must leave at least one arrow pointing up");
  near(r.backward, bruteLaneCost(doc), "search vs brute force on a cyclic graph");
}

group("laneOrder — agrees with brute force on a tangled six-lane graph");
{
  const doc = LANE_DOC(["F", "E", "D", "C", "B", "A"], [
    LANE_TASK("a1", "A", []),            LANE_TASK("b1", "B", ["a1"]),
    LANE_TASK("c1", "C", ["b1", "a1"]),  LANE_TASK("d1", "D", ["c1"]),
    LANE_TASK("e1", "E", ["d1", "b1"]),  LANE_TASK("f1", "F", ["e1", "c1"]),
    LANE_TASK("b2", "B", ["f1"]),        // the back edge that makes it cyclic
    LANE_TASK("c2", "C", ["e1"]),
  ]);
  const r = S.laneOrder(doc);
  near(r.backward, bruteLaneCost(doc), "search vs brute force on six tangled lanes");
  ok(r.backward < r.was, `it should improve on the typed order (${r.was} -> ${r.backward})`);
  console.log(`    six lanes: ${r.was} backward -> ${r.backward} (floor ${bruteLaneCost(doc)})`);
}

group("laneOrder — idempotent, and ties are broken by staying put");
{
  const doc = LANE_DOC(["C", "B", "A"], [
    LANE_TASK("a1", "A", []), LANE_TASK("b1", "B", ["a1"]), LANE_TASK("c1", "C", ["b1"]),
  ]);
  const once = S.laneOrder(doc);
  const settled = { ...doc, lanes: once.order.map(id => ({ id })) };
  const twice = S.laneOrder(settled);
  ok(!twice.changed, `running it on its own output should change nothing, got ${twice.order.join()}`);

  // Two lanes with NOTHING between them must not be shuffled: every order costs
  // the same, so the displacement tie-break has to be what decides, or the button
  // reshuffles unrelated teams every time it is pressed.
  const loose = LANE_DOC(["X", "Y"], [LANE_TASK("x1", "X", []), LANE_TASK("y1", "Y", [])]);
  const lr = S.laneOrder(loose);
  ok(!lr.changed && lr.order.join() === "X,Y",
     `unconnected lanes should stay put, got ${lr.order.join()} changed=${lr.changed}`);
  near(lr.total, 0, "no dependency crosses a lane here");
}

group("a dependency cycle throws, and says so in the words the page prints");
{
  // THE ONLY CYCLE HANDLING IN THE TOOL. shared/commands.js and validate.ts both
  // decline to reject a cycle, each citing the other side: "sched() refuses them
  // loudly when the plan is opened". So this throw is the whole mechanism, and
  // the page's error panel prints `e.message` verbatim — which makes the wording
  // a contract, not an implementation detail.
  const cyc = [
    { id: "a", label: "A", lane: "L", dur: 3, deps: ["b"] },
    { id: "b", label: "B", lane: "L", dur: 3, deps: ["a"] },
  ];
  let msg = null;
  try { M.sched(cyc, [], M.CAL_ALL, -Infinity); } catch (e) { msg = e.message; }
  ok(msg !== null, "a two-task cycle must throw rather than return a schedule");
  ok(/cycle/i.test(msg || ""), `the message must name the cycle, got ${JSON.stringify(msg)}`);

  // A LONGER LOOP IS STILL A LOOP. The guard is a countdown, so a three-hop cycle
  // exercises a different exit from the two-hop one above.
  const three = [
    { id: "a", label: "A", lane: "L", dur: 3, deps: ["c"] },
    { id: "b", label: "B", lane: "L", dur: 3, deps: ["a"] },
    { id: "c", label: "C", lane: "L", dur: 3, deps: ["b"] },
  ];
  let msg3 = null;
  try { M.sched(three, [], M.CAL_ALL, -Infinity); } catch (e) { msg3 = e.message; }
  ok(msg3 !== null && /cycle/i.test(msg3), "a three-task cycle must throw too");

  // AND AN ACYCLIC PLAN MUST NOT. Without this the two checks above pass on a
  // scheduler that throws at everything.
  const fine = [
    { id: "a", label: "A", lane: "L", dur: 3, deps: [] },
    { id: "b", label: "B", lane: "L", dur: 3, deps: ["a"] },
  ];
  let threw = false;
  try { M.sched(fine, [], M.CAL_ALL, -Infinity); } catch { threw = true; }
  ok(!threw, "the same shape without the back-edge must schedule normally");
}

group("orderSig — refetches on what the scheduler reads, and on nothing else");
{
  // Two lanes, one dependency across them: enough that every field below is
  // genuinely live rather than ignored.
  const DOC = () => ({
    start: "2026-01-05", hours: { week: { mon: [["00:00", "24:00"]], tue: [["00:00", "24:00"]], wed: [["00:00", "24:00"]],
                                         thu: [["00:00", "24:00"]], fri: [["00:00", "24:00"]] }, dates: {} },
    lanes: [{ id: "A", label: "A", cap: 1 }, { id: "B", label: "B", cap: 1 }],
    milestones: [{ id: "m", label: "Ship", date: "2026-03-01" }],
    tasks: [{ id: "t1", label: "One", lane: "A", dur: 5, deps: [], ms: "m" },
            { id: "t2", label: "Two", lane: "A", dur: 3, deps: [], ms: "m" },
            { id: "t3", label: "Three", lane: "B", dur: 4, deps: ["t1"], ms: "m" }],
  });
  const sig = M.orderSig;
  ok(sig(DOC()) === sig(DOC()), "same document, same signature");

  // WHAT MUST TRIGGER A REFETCH. Each of these changes the answer to "which order
  // finishes soonest", so a signature that ignores one leaves the chip asserting
  // something that stopped being true.
  const moves = {
    "a duration":        d => { d.tasks[0].dur = 9; },
    "a dependency":      d => { d.tasks[1].deps = ["t1"]; },
    "queue order":       d => { d.tasks = [d.tasks[1], d.tasks[0], d.tasks[2]]; },
    "a lane move":       d => { d.tasks[0].lane = "B"; },
    "lane capacity":     d => { d.lanes[0].cap = 2; },
    "a milestone date":  d => { d.milestones[0].date = "2026-04-01"; },
    "milestone owner":   d => { d.tasks[2].ms = "other"; },
    "the plan start":    d => { d.start = "2026-01-12"; },
    "the working week":  d => { d.hours.week.sat = [["00:00", "24:00"]]; },
    "a holiday":         d => { d.hours.dates = { "2026-01-19": [] }; },
    "working hours":     d => { d.hours.week.mon = [["08:00", "17:00"]]; },
    "a session":         d => { d.tasks[0].sessions = [{ start: "2026-01-08T09:00:00Z", stop: null }]; },
    "finishing":         d => { d.tasks[0].done = true; },
    "a queue exemption": d => { d.tasks[0].noQueue = true; },
    "a not-before pin":  d => { d.tasks[0].notBefore = 12; },
    "a due date":        d => { d.tasks[0].due = 20; },          // the search scores tardiness
    "turning Auto-order on": d => { d.autoOrder = true; },
    // "an abandoned task" was here until 2026-09-20. `dropped` is no longer a
    // field anything can set, so it is no longer an input to the order.
  };
  const base = sig(DOC());
  for (const [what, mutate] of Object.entries(moves)) {
    const d = DOC(); mutate(d);
    ok(sig(d) !== base, `${what} must change the signature`);
  }

  // AND WHAT MUST NOT. A rename or a recolour cannot change which order is best,
  // and refetching on one spends a round trip per keystroke in the inspector.
  const cosmetic = {
    "a task label":      d => { d.tasks[0].label = "Renamed"; },
    "a task colour":     d => { d.tasks[0].color = ["c9"]; },
    "a description":     d => { d.tasks[0].desc = "some prose"; },
    "a lane label":      d => { d.lanes[0].label = "Renamed"; },
    "a milestone label": d => { d.milestones[0].label = "Renamed"; },
    "the plan title":    d => { d.title = "Renamed"; },
  };
  for (const [what, mutate] of Object.entries(cosmetic)) {
    const d = DOC(); mutate(d);
    ok(sig(d) === base, `${what} must NOT change the signature`);
  }
}

group("reorderUnits — predicts the search cost it is used to avoid");
{
  const plan = (lanes, per) => ({ tasks: Array.from({ length: lanes * per }, (_, i) =>
    ({ id: "t" + i, lane: "L" + (i % lanes) })) });
  // sum(lane^2) * tasks. Two lanes of three is 2*9*6 = 108.
  near(M.reorderUnits(plan(2, 3)), 108, "two lanes of three");
  // The guard's shape is what matters: quadratic in the LANE, so splitting the
  // same work across more lanes is cheaper than piling it into one.
  ok(M.reorderUnits(plan(1, 40)) > M.reorderUnits(plan(4, 10)),
     "one long queue must cost more than four short ones holding the same tasks");
  ok(M.reorderUnits({}) === Infinity, "a document with no tasks is never computed locally");
  // The two plans the page was measured on, either side of the 20000 budget: the
  // demo fixture stays local, and the 80-task plan goes to the server. If this
  // flips, the page starts blocking its own main thread for ~400ms a keystroke.
  ok(M.reorderUnits(plan(4, 3)) <= 20000, "a 12-task plan is computed in the page");
  ok(M.reorderUnits(plan(4, 20)) > 20000, "an 80-task plan is sent to the server");
}

// ---------------------------------------------------------------------------
group("dateRowOrder — the flat row order date mode reads top to bottom");
{
  // A FIXTURE BUILT TO BE WRONG. The claim under test is "no dependency arrow
  // points upward", and a plan whose array order already satisfies that turns
  // every check below into one that cannot fail. So this one is listed in
  // near-reverse dependency order on purpose, and the first check proves it is
  // still broken enough to be worth fixing.
  const ROWORDER = [
    { id: "d2", lane: "D", dur: 5, deps: ["b2", "c2"] },
    { id: "d1", lane: "D", dur: 3, deps: ["c1"] },
    { id: "c2", lane: "C", dur: 4, deps: ["a2"] },
    { id: "c1", lane: "C", dur: 2, deps: ["b1"] },
    { id: "b2", lane: "B", dur: 6, deps: ["a3"] },
    { id: "b1", lane: "B", dur: 4, deps: ["a1"] },
    { id: "a3", lane: "A", dur: 3, deps: [] },
    { id: "a2", lane: "A", dur: 5, deps: ["b1"] },
    { id: "a1", lane: "A", dur: 5, deps: [] },
    // SAME START, DIFFERENT END. Both are alone in their lane with no
    // dependency, so both begin on day 0 and only the end tie-break separates
    // them. Without it the 20-day task outranks the 2-day one on nothing.
    { id: "tieLong",  lane: "E", dur: 20, deps: [] },
    { id: "tieShort", lane: "F", dur: 2,  deps: [] },
    // SAME START AND SAME END. Nothing in the sort can separate these, so they
    // are the stability probe: they must come out in the order they went in.
    { id: "twinA", lane: "G", dur: 7, deps: [] },
    { id: "twinB", lane: "H", dur: 7, deps: [] },
    // A RECORDED FACT, before the plan's own origin. "What has already happened"
    // landing at the top is the whole reason this view was asked for.
    { id: "past", lane: "I", dur: 4, actualStart: -10, deps: [] },
  ];
  const st = M.sched(ROWORDER, [], M.CAL_ALL, -Infinity);
  const backward = ord => {
    const p = Object.fromEntries(ord.map((t, i) => [t.id, i]));
    let up = 0;
    for (const t of ROWORDER) for (const dep of t.deps) if (p[dep] > p[t.id]) up++;
    return up;
  };

  // THE GUARD ON EVERY CHECK BELOW. If the fixture stops being scrambled, the
  // zero below stops meaning anything and this is the only thing that says so.
  ok(backward(ROWORDER) >= 3,
     `the fixture's own array order must point at least 3 arrows upward, got ${backward(ROWORDER)}`);

  const ord = M.dateRowOrder(ROWORDER, st, M.CAL_ALL);
  ok(ord.length === ROWORDER.length, "every task must survive the ordering");
  ok(backward(ord) === 0,
     `in date order no dependency may point upward, got ${backward(ord)}`);

  const at = id => ord.findIndex(t => t.id === id);
  ok(at("tieShort") < at("tieLong"),
     "two tasks starting the same day must be split by which finishes first");
  ok(at("twinA") < at("twinB"),
     "two tasks with the same start AND end must keep the order the document had");
  ok(at("past") === 0,
     "work that really started must sit above every task that is still a forecast");

  // A COMPARATOR THAT IS NOT A TOTAL ORDER SORTS DIFFERENTLY ON DIFFERENT
  // ENGINES AND ON DIFFERENT DAYS. Rows that reshuffle between two renders of
  // the same document would be the view lying about what changed.
  ok(JSON.stringify(M.dateRowOrder(ROWORDER, st, M.CAL_ALL).map(t => t.id))
     === JSON.stringify(ord.map(t => t.id)),
     "ordering the same document twice must give the same rows");

  // AND IT MUST NOT MUTATE. `doc.tasks` array order is the queue the scheduler
  // reads; a sort in place would silently rewrite the plan to draw it.
  ok(ROWORDER[0].id === "d2", "the document's own task order must be left alone");
}

// ---------------------------------------------------------------------------
console.log(fails ? `\n${fails} of ${checks} checks FAILED` : `\nok — ${checks} checks`);
process.exit(fails ? 1 : 0);
