import type { DayTask as Task, Doc, LoadedDayDoc as LoadedDoc, Cal, Id, Starts, Version, Command, ChannelValue, Hours }
  from "./types.js";
import { DAY, CAL_ALL, makeCal, calOf, SCHEMA, MIGRATIONS, applyMigrations,
         spanOf as _spanOf, endOf as _endOf, snapFwd as _snapFwd,
         sched as _sched, finishOf as _finishOf, hopsUp as _hopsUp,
         laneOrder, suggestReorders, scheduleView, hasCycle, todayISO, boardColumns,
         dayOfInstant, instantOfDay, nowOf, zoneOf, orderSignature, remainingOf, workedOn, offHours, workChunks, plannedOf, actualsOf,
         statusOf, workDaysIn as _workDaysIn } from "./schedule.js";
// THE COMMAND VOCABULARY, IMPORTED RATHER THAN RESTATED. `shared/commands.ts`
// argues its own case at the top of the file and it is the right one: a second
// copy is the thing that rots, and the two copies here would be the browser's
// idea of what a command means and the server's — which is the disagreement the
// whole protocol exists to make impossible.
//
// Page-relative, exactly like `./schedule.js` above, and it lands at the bucket
// root beside it by the same route in scripts/deploy-web.sh. See ADR 0001 on why
// a module shared by the page and the server lives in `shared/`.
import { marked } from "marked";
import DOMPurify from "dompurify";
import { applyCommand, NOTICE_MAX, WEEKDAYS, hoursProblem, rankLogOf, rankOf, rankedTasks, suggestedRankOf } from "./commands.js";
import { Sorter, emptyList, item } from "@rascaltwo/pairwise-sorter";
import "@rascaltwo/pairwise-sorter/element";
import { localReorder } from "./reorder-local.js";
import { flushMount,
         mountMilestoneBar, mountInspector, mountTaskCard, mountLegend, mountWeekEditor, mountArrowEditor,
         mountSwatchWall, mountLabelParts, mountMiniChip, mountChannelEditor, mountSwapEditor,
         mountReorderPanel, mountPastPlans, type PastPlan, type OnPastAnswer, mountHistory, mountPlaybar, mountWho, mountCursors, mountGrid,
         mountPlanName, mountAssistant, mountNotice, mountNoticeEditor,
         mountRecents, mountKeyringSample, mountMentions, mountMentionsSub, mountStylePop,
         mountSchedulerDown, mountWakeSplash, mountImportSummary, mountSelfTestFailed,
         mountPicker, type PickerOption,
         mountFurniture, mountAxis, type Band, type Rule, type AxisLabel,
         mountArrows, type Arrow,
         mountPlanUnopenable, mountGraphUnavailable,
         type MilestoneChip, type InspectorTask, type Chip, type Option,
         type LegendGroup, type LegendItem, type Swatch,
         type ChannelBlock, type ValueControl, type SwapColumn, type SwapRow,
         type HistoryRow, type DeltaPart, type WhoChip, type Cursor,
         type RecentPlan, type Mention,
         type GridLane, type GridRow, type GridBar, type LabelPart } from "./ui/mount.js";

// FOUR HELPERS, INLINED FROM THE VIZ KIT — see the note beside the tokens in
// <head>. Verbatim from ai-setup/skills/viz/kit/viz.js, comments included.

/**
 * `document.querySelector`, shortened. NOT jQuery and not a fragment of one: it
 * returns the raw element, has no methods, wraps nothing, and is one call deep.
 * The `$` name is jQuery's only inheritance here.
 *
 * IT COMPLAINS WHEN IT MISSES, and that is the whole reason this is no longer a
 * one-liner. A selector that matches nothing used to return `null` in silence,
 * which is exactly how the dependency-cycle diagnosis spent 13 days writing
 * itself into `#verdict` and `#verdictsub` after both were deleted — see
 * `sync-server/test/selectors.test.ts` for the incident.
 *
 * A THROW WAS THE OBVIOUS ALTERNATIVE AND IS THE WRONG ONE. Plenty of callers
 * legitimately ask for something optional, and a throw inside a render path
 * blanks a client's chart to protect against a typo. `console.error` is loud
 * where it matters and harmless where it does not: `scripts/playback-harness.ts`
 * asserts "no page errors", so a stale selector reached by ANY covered
 * interaction — including one built at runtime, which no source scan can see —
 * now fails CI. The static guard covers the literal ones; this covers the rest.
 *
 * THE RETURN TYPE IS `any`, DELIBERATELY, AND IT IS THE FIRST INCREMENT RATHER
 * THAN THE DESTINATION. Measured on 2026-09-05: `Element | null` is the honest
 * type and costs a null check at ~140 call sites; `HTMLElement` looks better and
 * took the file from 46 errors to 271, because 188 call sites read `.value`,
 * `.checked` or `.selectedIndex`, which live on the INPUT subtypes rather than on
 * `HTMLElement`. `$` is polymorphic — the caller knows what it asked for and the
 * signature cannot — so the correct fix is a generic parameter plus an annotation
 * at each site that needs one, and that is 188 edits in a tool holding live
 * client plans.
 *
 * GENERIC, WITH A DEFAULT, because `$` is polymorphic and the caller is the only
 * one who knows what it asked for. `HTMLElement` covers the common case; a site
 * that needs an input subtype names it on the receiving declaration and the
 * parameter is inferred from there. `any` was here first and was wrong: it made
 * every property read through this helper unchecked, which is most of the DOM
 * code in the file.
 *
 * @template {Element} [T=HTMLElement]
 * @param {string} sel
 * @param {Document|Element} [root]
 * @returns {T}
 */
const $ = <T extends Element = HTMLElement>(sel: string, root: Document|Element = document): T => {
  const el = root.querySelector(sel);
  if (!el) console.error(`[$] no element matches ${sel} — a selector has gone stale`);
  return ((el as unknown) as T);
};

/**
 * A `data-*` attribute this page wrote itself, read back. `DOMStringMap` values
 * are `string | undefined` and every one of these sites just rendered the
 * attribute in the same template literal it is now reading — so the absence the
 * type describes cannot happen here.
 *
 * A CAST RATHER THAN `?? ""`, deliberately: `+undefined` is `NaN` and `+""` is
 * `0`, so the tidier-looking default would silently turn a missing attribute
 * into a real index. Types must not change what the code does.
 *
 * @param {HTMLElement} el
 * @param {string} k
 * @returns {string}
 */
const ds = (el: HTMLElement, k: string): string => el.dataset[k] as string;

/**
 * `$` with the type parameter filled in for form controls — not a fourth idea,
 * the same one specialised. JSDoc has no syntax for passing a type argument at a
 * call site, so a named specialisation is how `$<HTMLInputElement>(...)` gets
 * spelled in a file with no build step.
 *
 * `HTMLInputElement` covers `value`, `checked`, `disabled`, `select()`,
 * `setSelectionRange` and `placeholder`, which is every form property this page
 * reads. A `<select>` shares all of them; the two spots that want
 * `selectedIndex` or `options` say `HTMLSelectElement` on their own declaration.
 *
 * @param {string} sel
 * @param {Document|Element} [root]
 * @returns {HTMLInputElement}
 */
/**
 * The task with this id. Every caller passes an id the page put there itself —
 * `sel`, a drag target, a chip's `data-id` — so a miss is a BUG, not a state the
 * caller should be made to handle, and `Task | undefined` at 70 read sites was
 * asking each of them to prove something established once when the id was set.
 *
 * Same posture as `$`: complain loudly, do not throw. A missing task in a render
 * path would blank a client's chart; the console error and the browser suite's
 * "no page errors" assertion catch it without that cost.
 *
 * @see must() in shared/commands.ts, which makes the same argument server-side.
 */
const taskById = (tid: Id): Task => {
  // NOT `taskById` — the sweep that introduced this helper rewrote every
  // `doc.tasks.find(x => x.id === …)` into a call to it, including the one in its
  // own body. Zero type errors; infinite recursion. The browser suite caught it.
  const t = doc.tasks.find(x => x.id === tid);
  if (!t) console.error(`[taskById] no task ${tid} — an id outlived its task`);
  return t as Task;
};

const $f = (sel: string, root: Document|Element = document): HTMLInputElement =>
  $<HTMLInputElement>(sel, root);

/**
 * All of them, as an array, typed. `querySelectorAll` yields `NodeListOf<Element>`
 * — and `Element` has no `dataset` and no `onclick`, which is every one of the 40-odd
 * places this file reaches for a collection and then wires it up. Same generic
 * shape as `$`: `HTMLElement` by default, name a subtype on the receiving
 * declaration when a site needs one.
 *
 * An array rather than a NodeList so `map`/`filter`/`find` work without a spread
 * at each site.
 *
 * @template {Element} [T=HTMLElement]
 * @param {string} sel
 * @param {Document|Element} [root]
 * @returns {T[]}
 */
const $$ = <T extends Element = HTMLElement>(sel: string, root: Document|Element = document): T[] =>
  ((Array.from(root.querySelectorAll(sel)) as unknown) as T[]);

/**
 * `$` for the things that legitimately may not be there — and saying so is the
 * point. A banner that is removed if present, a popover that only exists while
 * the inspector is open: those are absences by design, and `$`'s alarm would
 * report them forever until somebody learned to ignore it.
 *
 * The split is the discipline the `#verdictsub` incident was missing. `$` now
 * means "this must exist" and complains when it does not; `$opt` means "it may
 * not" and is silent. Neither is a guess, which is what the single permissive
 * helper forced every reader to make.
 *
 * @template {Element} [T=HTMLElement]
 * @param {string} sel
 * @param {Document|Element} [root]
 * @returns {T | null}
 */
const $opt = <T extends Element = HTMLElement>(sel: string, root: Document|Element = document): T | null =>
  ((root.querySelector(sel) as unknown) as T | null);

/**
 * The element an event happened on. `e.target` is `EventTarget | null`, which is
 * true and useless: every listener in this file is on the document or an element,
 * so the target is an element whenever the handler runs at all. One narrowing
 * here beats fifteen casts at the call sites.
 * @param {Event} e
 * @returns {HTMLElement}
 */
const tgt = (e: Event): HTMLElement => e.target as HTMLElement;
// WHERE A LETTER IS JUST A LETTER. A bare-key binding that fires while somebody
// is naming a task is not a shortcut, it is a typo generator.
const inField = (e: Event) => {
  const el = tgt(e);
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || "") || el.isContentEditable;
};
// ...AND WHERE ENTER AND SPACE ALREADY MEAN SOMETHING. The browser presses a
// focused button with both, so claiming them at the document level would take
// the keyboard away from every control on the page to give it to one.
const onControl = (e: Event) => !!tgt(e).closest("button, a, [role=button], summary");

/**
 * The FORM CONTROL an event came from — `tgt` for the handlers that read a
 * value. Split from `tgt` rather than widening it, because the two say different
 * things: `tgt(e).closest(...)` works on anything the pointer touched, while
 * `fieldOf(e).value` is a claim that this listener is on an input, a select or a
 * textarea. It always is; every caller is an `oninput`, an `onchange` or an
 * `onkeydown` bound to a control. Keeping them separate means the claim is
 * visible at the call site instead of hidden in one over-wide helper.
 *
 * @param {Event} e
 * @returns {HTMLInputElement}
 */
const fieldOf = (e: Event): HTMLInputElement => e.target as HTMLInputElement;

// `esc()` USED TO LIVE HERE, and its absence is the shape of the React port.
// It existed for one reason — this file assembled HTML as strings — and there is
// no longer a single `innerHTML =` in it. Every `createElement` that remains is
// either a container React renders into or a node nobody sees: the canvas behind
// `measureText`, the throwaway div `fontOf` reads a computed font from, and the
// `<a>` a download is triggered through.

// TWO SEGMENTS, SPLIT ON THE FIRST `&`: `#<token>&<payload>`. The share token is
// a capability (ADR 0002) and it is never parsed — sliced off and handled
// verbatim, because code that does not deserialize a value cannot drop it. That
// makes "a mangled fragment cannot cost you the only key to the plan" structural
// rather than a convention someone has to remember. There is no picker and no
// `/list` to recover from, so it has to be structural.
//
// `&` is a safe delimiter: `encodeURIComponent` never emits one and a base64url
// token cannot contain one. No `&` at all means a bare token, or a tokenless
// link — the demo, and every link that predates the token.
const hashParts = () => {
  const raw = location.hash.slice(1), i = raw.indexOf("&");
  if (i >= 0) return { tok: raw.slice(0, i), json: raw.slice(i + 1) };
  // NO `&`, SO IT IS ONE SEGMENT — BUT WHICH ONE? Reading it as a payload is
  // right for every link that predates the token, and catastrophic for
  // `#<token>` with nothing after it: the capability is silently read as a
  // malformed payload, discarded, and the person is looking at a page that
  // cannot say what went wrong. That bare shape is exactly what a human writes
  // by hand, so it will happen.
  //
  // The two cannot collide: a payload is `JSON.stringify` of an object put
  // through `encodeURIComponent`, so it always begins `%7B`, and `%` is not in
  // the base64url alphabet. Nothing is both.
  //
  // BASE64URL-22, NOT HEX-32, and the difference is a real bug this line shipped
  // with. `mintShareToken()` in scripts/migrate-to-s3.ts is 16 crypto-random
  // bytes as base64url — 22 characters of `[A-Za-z0-9_-]`. This tested
  // `/^[0-9a-f]{32}$/`, so a REAL token failed the test, was read as malformed
  // view state and silently discarded: exactly the capability loss the
  // two-segment fragment exists to prevent. Both sides were individually
  // reasonable and nothing connected them, which is why the format is now
  // normative in docs/adr/0002-capability-tokens-no-sso.md — if it ever changes
  // it changes there first, and every shape test follows.
  return /^[A-Za-z0-9_-]{22}$/.test(raw) ? { tok: raw, json: "" } : { tok: "", json: raw };
};

// WHAT THE FRAGMENT IS FOR, and it is a short list: the capability, and a
// one-shot inbox.
//
// IT USED TO HOLD VIEW STATE — twelve scalars (collapsed lanes, zoom, view mode,
// row mode, compare version, focus mode, graph group-by, inspector fold, top-bar
// fold, lurk, show-effort) written back to the address bar on
// every interaction. That is gone, deliberately. Every one of those already had
// a plain variable; the hash was persistence bolted on top, and it bought a
// deep-link nobody asked for at the price of an address bar that changed while
// you clicked and a rule nobody could state about WHICH bits of the view were
// sticky. A refresh now resets the view, like a refresh does.
//
// The one thing the fragment still carries besides the token is `kr` — a keyring
// arriving in a shared link. It is read once and struck immediately; see the note
// over the keyring for why it must never become sticky.
const inbox = () => {
  try { return JSON.parse(decodeURIComponent(hashParts().json) || "{}"); }
  catch { return {}; }
};

/** Back to the bare capability. The only writer of the fragment there is. */
const clearInbox = () => location.replace("#" + hashParts().tok);

/** The capability, or "" for a tokenless link. Never parsed, never stored. */
const shareToken = () => hashParts().tok;

// A CHANGE OF TOKEN IS A CHANGE OF PLAN, AND THE PAGE HAS TO RELOAD FOR IT.
//
// The token lives in the fragment, so pasting someone else's link into a tab
// that already has a plan open navigates nothing — the browser fires
// `hashchange` and that is all. The page went on rendering plan A on plan A's
// socket while every HTTP call from that moment carried plan B's token: History,
// Save and Revert all aimed at a plan that was not on screen. It is easy to hit
// by accident, because pasting a link into the address bar of the tab you
// already have open is what people do.
//
// ONLY THE TOKEN SEGMENT COUNTS. The other segment is the keyring inbox, which
// is absorbed and cleared in place — so a reload on any fragment change would
// reload the page in the middle of reading it. This compares the one thing that
// addresses a plan and ignores the one that does not.
let hashToken = shareToken();
addEventListener("hashchange", () => {
  if (shareToken() !== hashToken) {
    hashToken = shareToken();
    location.reload();
    return;
  }
  // SAME PLAN, NEW FRAGMENT — and one thing in there still has to be read.
  // Pasting a keyring link into a tab that already has that plan open changes
  // nothing but the fragment, so there is no reload and `adopt` never runs
  // again. That is the ordinary way this link gets used ("here, this one sets
  // the base"), and without this it silently did nothing: the URL kept the `kr`
  // and the references stayed unlinked. Everything else in the fragment is view
  // state this tab is already the author of, so `kr` is the only key worth
  // re-reading here.
  if (inbox().kr) absorbKeyring();
});

// THE SCHEDULER AND THE MIGRATION LADDER MOVED OUT, to schedule.js, so the backend
// can answer the two questions that used to need a browser: what a plan lands on,
// and whether a document is current. See the header there for why a second copy
// on the server was the wrong answer.
//
// THE CALENDAR STAYS A PAGE-LEVEL GLOBAL, and these six wrappers restore the
// `cal = CAL` default that ~50 call sites below are written against. The module
// takes it explicitly because it has no page to read a global off. Six one-line
// wrappers is cheaper than touching fifty call sites, and it keeps this
// extraction honest: nothing below here had to change.
const spanOf   = (t, s, cal = CAL) => _spanOf(t, s, cal);
const endOf    = (t, s, cal = CAL) => _endOf(t, s, cal);
const snapFwd  = (d, cal = CAL) => _snapFwd(d, cal);
// `today` defaults the same way `cal` does, and for the same reason the module
// refuses to: the page has a clock and a current document, the module has
// neither. Pass `-Infinity` to opt out — the self-test does, so a reference plan
// keeps its hardcoded answer no matter what day it is run on.
// `now` follows it: whoever opts out of the floor opts out of the cap on
// recorded work too, and everyone else gets the clock.
const sched    = (tasks, lanes = (doc && doc.lanes) || [], cal = CAL, today = nowD(),
                  now = today === -Infinity ? Infinity : nowD()) =>
  _sched(tasks, lanes, cal, today, now);
const finishOf = (tasks, st, cal = CAL) => _finishOf(tasks, st, cal);
// Only the UPWARD walk moved. `verdict()` has to answer "what does this milestone
// wait on" with the same walk the chart uses, or the API and the chips disagree
// about the one number anybody reads. `hopsDown` stays below with the rest.
const hopsUp   = (tid, max = Infinity) => _hopsUp(doc.tasks, tid, max);

let CAL: Cal = CAL_ALL;




// How much working time a stretch of calendar actually contains, in days (shared, beside `spanOf`, whose inverse it is).
const workDaysIn = (start, span, cal = CAL, own?: Id) => _workDaysIn(start, span, cal, own);


// ---- WHICH ONE IS ACTUALLY HOLDING IT -------------------------------------
// A task waiting on five things is waiting on ONE of them; the other four
// finished earlier and are irrelevant to its date. The chart shows this — the
// arrows are there — but a list of five chips does not, and "which of these do we
// go and fix" is the question that gets asked out loud.
//
// SLACK IS THE ANSWER, and it is a subtraction the scheduler has already done the
// hard part of: how long after that dependency finished did this task actually
// start. Zero means it is the one pinning you. Twelve days means it was done a
// fortnight before you needed it.
//
// Read against the UNSHIFTED schedule on purpose. ALAP alignment slides the
// drawn picture as late as the tightest milestone allows, equally, so measuring
// on drawn positions would report the same slack plus a constant — and worse,
// would change every number when someone edits an unrelated milestone.
// ---- THE FLAT ROW ORDER, for date mode ------------------------------------
// Team mode's rows are the document's own array order, grouped by lane, because
// there a row's position IS the queue position the scheduler reads. Date mode
// makes the vertical axis mean time instead, so the position is derived and the
// queue is not visible — which is why every gesture that edits it goes dead over
// in `move()` and `startConstrain()`.
//
// SORTED BY START, WHICH IS THE WHOLE POINT rather than a detail of ungrouping.
// A dependency's predecessor starts strictly earlier than it does (durations are
// > 0), so ordering by start cannot leave an arrow pointing upward — you read the
// plan downward and the work flows downward with it. Measured on the plan this
// was built for: grouped by team leaves 24 of 181 arrows pointing up, flat in
// array order leaves 45 — WORSE than the grouping it replaces — and this leaves
// none. The one exception is a recorded `actualStart` that contradicts its own
// dependency, which is a plan stating two incompatible facts, not a sort bug.
//
// Then by end, so two tasks beginning the same morning are split by which one
// finishes first rather than by nothing. Then by nothing at all: `sort` is
// stable, so a genuine tie keeps the array order the document already had, and
// the rows do not reshuffle between two renders of the same plan.
//
// It COPIES before sorting. `doc.tasks` order is a scheduling input, so sorting
// it in place would silently rewrite the plan in order to draw it.
const dateRowOrder = (tasks, starts, cal = CAL) =>
  [...tasks].sort((a, b) => starts[a.id] - starts[b.id]
                         || endOf(a, starts[a.id], cal) - endOf(b, starts[b.id], cal));

const taskOf = tid => taskById(tid);
const laneLabel = lid => ((doc.lanes || []).find(l => l.id === lid) || {}).label || lid;
const slackUp = (t, d) => st[t.id] - endOf(taskOf(d), st[d]);
const slackDown = (t, u) => st[u] - endOf(t, st[t.id]);
// The binding constraint is often NOT a dependency — a full lane holds a task
// with no arrow pointing at it, and that is exactly the case where a chip list
// showing nothing but slack is at its most misleading.
// TIGHTEST, NOT ZERO. On a five-day week the binding dependency usually does NOT
// land exactly on the start: it finishes on a Friday, the task snaps to Monday,
// and the slack reads as a day that belongs to the calendar rather than to that
// dependency. Testing for zero therefore marks nothing at all on precisely the
// plans that have a working week — which was the first thing this reported, on a
// task whose tightest upstream read "+1 day" with nothing flagged.
const upSlack = t => t.deps.map(d => [d, slackUp(t, d)]).sort((a_, b_) => a_[1] - b_[1]);
const bindingDeps = t => {
  // Only when a dependency is what the scheduler actually chose. A task held by a
  // full lane has a tightest upstream too, and calling it the bottleneck would
  // send someone to shorten a task that would change nothing.
  if (st.why[t.id] !== "deps" || !t.deps.length) return new Set();
  const s = upSlack(t), lo = s[0][1];
  return new Set(s.filter(([, v]) => v <= lo + 1e-9).map(([d]) => d));
};
// "Am I the one holding it up" is a question about THAT task's decision, not
// about the gap between us — a transitive descendant can start the instant this
// one ends and still be waiting on something else entirely.
const pinsDown = (t, u) => {
  const ut = taskOf(u);
  return !!ut && ut.deps.includes(t.id) && bindingDeps(ut).has(t.id);
};
// HELD BY, AS DATA RATHER THAN AS A SENTENCE. This was generated prose, and prose
// is the wrong shape for it twice over: you have to read the whole line to find
// the two facts inside it, and a sentence reads as something the tool INFERRED
// when every part of it is something the scheduler computed. Same values, in the
// same chip vocabulary the three rows above already use — a key, a value, and a
// name you can click.
// IT RETURNS DATA NOW, and the paragraph above always said it should. It built
// chip MARKUP until the React port, which meant this — the one place that
// explains why a bar sits where it does — was a string only the inspector's
// `innerHTML` could accept. Same values, same chip vocabulary, as objects.
const heldBy = (t): Chip[] => {
  const gap = st.whyGap[t.id];
  // The working-day snap is its own fact, not a clause. It applies to every case,
  // including the one where a dependency is what held it.
  const cal: Chip[] = gap ? [{ k: "cal", label: "working day", tag: `+${calStr(gap)}`, ghost: true }] : [];
  const who = st.whyWho[t.id];
  switch (st.why[t.id]) {
    case "deps": return cal;                 // the chip marked "pinning" above is the answer
    case "lane": return [
      // WHICH QUEUE, ONLY WHEN THERE IS A CHOICE OF QUEUE. On a one-lane plan
      // "queue · Me" names the only lane there is, which is the same empty
      // gesture as a filter chip that selects everything. The chip that carries
      // the actual answer — what is ahead of it — is the `who` one below.
      ...(((doc.lanes || []).length > 1)
        ? [{ k: "queue", label: "queue", tag: laneLabel(t.lane), ghost: true }] : []),
      ...(who ? [{ k: "who", id: who, label: name(who),
                   tag: `until ${fmtAt(endOf(taskOf(who), st[who]))}` }] : []),
      ...cal];
    case "notBefore": return [{ k: "nb", label: "not before", tag: fmtAt(t.notBefore), ghost: true }, ...cal];
    // NOTHING HOLDS WORK THAT HAS STARTED. This was a "started Sep 28" chip — the
    // Started field again, under a label that said something was holding it, and
    // with `fmt` rounding a 3pm start into the next day.
    case "actual": return [];
    case "slot": return [{ k: "nb", label: "planned", tag: fmtAt(t.planned[0].start), ghost: true }];
    // The reason that used to read "nothing". Naming the date rather than just
    // saying "today" is the point: the chip has to be legible in a screenshot
    // taken a week later, and "today" in one is a date nobody can recover.
    case "today": return [{ k: "today", label: "not started",
                            tag: `no earlier than ${fmtAt(nowD())}`, ghost: true }, ...cal];
    case "free": return [{ k: "free", label: "nothing", ghost: true }, ...cal];
    default: return [];
  }
};
const slackTag = (v, pin) => pin ? "pinning" : `+${calStr(v)}`;

// Arrows are redrawn on their own, without a full render(), so hovering a bar is
// cheap: a full render rebuilds 24 rows and would run on every pointer move
// across the chart. `focus` is the task whose relationships to colour — the
// hovered one if there is one, otherwise the selected one.
// FOUR relationships, and the encoding is two-dimensional on purpose: HUE is the
// direction (upstream vs downstream) and DASH is the distance (one hop vs the
// rest of the chain). The previous scheme spent a third hue — amber — on
// "further upstream" and then left the whole downstream side sharing one green,
// so green was answering two questions at once while amber answered half of one.
// Same rule in both directions now, and each direction reads as one colour.
//
// DEFAULTS, NOT CONSTANTS. `doc.arrows` overrides any of them, edited in
// Settings, so a plan can carry its own convention — the same reason the teams,
// colours, borders and fills are data rather than an enum.
const ARROWS = [
  { k:"direct",    label:"Waits on this directly",       color:"#58a6ff", dash:false },
  { k:"trans",     label:"…and what those wait on",      color:"#58a6ff", dash:true  },
  { k:"down",      label:"Unblocked when this finishes", color:"#3fb950", dash:false },
  { k:"downtrans", label:"…and what those unblock",      color:"#3fb950", dash:true  },
];
const arrowStyle = k => ({ ...ARROWS.find(a => a.k === k),
                           ...(((doc && doc.arrows) || {})[k] || {}) });

// HOW FAR THE CHAIN LIGHTS UP, and it is two numbers rather than one because
// hovering and selecting are not the same act. A hover is a glance you did not
// commit to — you are sweeping the pointer across the chart and want to know
// what each bar touches, so lighting the whole transitive closure paints half
// the chart on every pointer move and answers nothing. A click is deliberate:
// you have picked THAT task and are willing to read what comes back.
//
// So the defaults are asymmetric on purpose — 1 hop on hover, 2 on click — and
// both are data on the plan, like the styles above, because how deep is "too
// deep" is a property of the plan's shape. Twelve tasks in a line can afford
// everything; sixty in a mesh cannot afford three.
//
// The limit is on the ARROWS ONLY. The ⊙ chain-focus lens and the inspector's
// transitive-dependency list are still unbounded, and deliberately: those are
// answers to "show me the whole chain", asked once, on purpose. This is a
// question about what the pointer is allowed to shout while you move it.
const DEPTH_DEFAULT = { hover: 1, click: 2 };
const DEPTH_STEPS = [1, 2, 3, 4, 5, "all"];
// "all" rather than a big number, so an exported plan says what it means. It is
// the only non-numeric value, and `Number("all")` is NaN — falsy — which is what
// turns it into Infinity here without a second branch.
const depthOf = mode => {
  const v = ((doc && doc.depth) || {})[mode];
  return v === undefined ? DEPTH_DEFAULT[mode] : (Number(v) || Infinity);
};

// `mode` says which of the two depth budgets applies — "hover" for the transient
// pointer preview, "click" for whatever is selected. It defaults to "click"
// because that is the resting state: every call that is not a pointerenter is
// redrawing the selection.
function drawArrows(focus, mode = "click") {
  const grid = $("#grid"), svg = $("#arrows");
  if (!grid || !svg) return;
  // NOT scrollWidth — THAT IS A RATCHET. This svg is a child of #grid, so sizing
  // it from #grid's scroll extent means a too-wide svg keeps the extent too wide,
  // which sizes the svg wide again. It could only ever grow. Nothing showed while
  // PPD was a constant and the extent never had a reason to shrink; zoom out from
  // two weeks to the whole plan and the chart still scrolled 18000px into blank
  // space. offsetWidth is the width #grid was TOLD, so it cannot be fed by this.
  svg.setAttribute("width", String(grid.offsetWidth));
  svg.setAttribute("height", String(grid.offsetHeight));
  const parts: Arrow[] = [];
  // PAINTED LAST, so it cannot be overdrawn. SVG has no z-index — document order
  // IS stacking order — and edges are emitted in task order, so a wide pinning
  // line pushed early was being partly covered by ordinary ones crossing it. The
  // one line the eye is meant to find was the one most likely to be underneath.
  const pins: Arrow[] = [];
  // AN EDGE IS CLASSIFIED BY WHICH HOP OF THE WALK IT IS, counting outward from
  // the focused task. Edge `d -> t` sits at level `hops(t) + 1` going upstream:
  // you travel from the focus out to `t`, and this edge is the next step.
  //
  // The earlier rule — colour an edge when BOTH its ends are in the reachable set
  // — is the same thing when nothing is limited, and WRONG the moment something
  // is. Two tasks can both be one hop from the focus AND depend on each other, so
  // the edge between them passed a "both ends within 1 hop" test while being
  // unmistakably the second hop of a chain on screen. That is not theoretical:
  // hovering a task with seven direct dependencies that reference each other drew
  // seven solid lines and NINE dashed ones at a setting that says "direct only".
  // The control promised one thing and the chart did another.
  //
  // Past the budget a path is not removed, only left at the muted opacity every
  // unrelated dependency already draws. An arrow that VANISHED at depth 3 would
  // read as "there is nothing there" — a different claim, and a false one.
  const max = focus ? depthOf(mode) : 0;
  const up   = focus ? hopsUp(focus, max)   : new Map();
  const down = focus ? hopsDown(focus, max) : new Map();
  // WHICH LINE IS THE ONE ACTUALLY HOLDING IT. The inspector has marked a chip
  // "pinning" since the scheduler started recording which term of its Math.max
  // won; the chart drew every dependency identically, so the answer was a click
  // away from a picture that had it.
  //
  // WIDTH, because the other two channels are spoken for AND are per-plan data:
  // hue is direction, dash is distance. A third category would collide with a
  // plan's own convention and need a legend entry. Pinning is not a category —
  // it is binary and sparse, at most one edge upstream — so it wants emphasis,
  // and thicker-means-more-important needs no teaching.
  //
  // It cannot collide with the dashed tier either: `bindingDeps` only ever names
  // a task's OWN dependencies, so a pinning edge is always a direct one, always
  // already solid, always already the 2.5 tier. This widens that tier and leaves
  // the other two alone.
  const ft = focus ? taskOf(focus) : null;
  const bindUp = ft ? bindingDeps(ft) : new Set();
  for (const t of doc.tasks) for (const d of t.deps) {
    // `.el` CAN BE NULL FOR A FRAME. `POS` is filled while the view model is built
    // and its elements arrive with React's refs, which land on commit — so an
    // arrow draw scheduled before that commit sees entries with no element yet.
    // Skipping the edge is right: the next draw, scheduled from the grid's own
    // paint effect, has them.
    const a = POS[d], b = POS[t.id];
    if (!a || !b || !a.el || !b.el) continue;
    // Upstream wins a tie, matching the order the four styles are declared in.
    // A task cannot be both without a cycle, and sched() refuses those outright.
    //
    // ZERO, NOT INFINITY, for "this edge is not on that side at all". Infinity was
    // the obvious sentinel and it is the wrong one: `max` is itself Infinity at
    // the "the whole chain" setting, `Infinity <= Infinity` is true, and every
    // unrelated edge in the plan passed the budget test and came out dashed blue.
    // A sentinel that compares equal to the limit is not a sentinel.
    const u = up.has(t.id) ? up.get(t.id) + 1 : 0;
    const w = down.has(d)  ? down.get(d)  + 1 : 0;
    const kind = !focus ? ""
      : u && u <= max ? (u === 1 ? "direct" : "trans")
      : w && w <= max ? (w === 1 ? "down"   : "downtrans") : "";
    const s = kind ? arrowStyle(kind) : null;
    // Direct upstream = `d -> focus`, so ask the focus which of its deps binds.
    // Direct downstream = `focus -> t`, so ask whether t is held by the focus
    // rather than by something else it also waits on.
    const pinning = kind === "direct" ? bindUp.has(d)
                  : kind === "down"   ? pinsDown(ft, t.id)
                  : false;
    const x1 = a.x + a.w, y1 = a.el.offsetTop + 13, x2 = b.x, y2 = b.el.offsetTop + 13;
    (pinning ? pins : parts).push({
      key: `${pinning ? "pin" : "e"}:${parts.length}:${pins.length}`,
      d: `M${x1} ${y1} H${(x1+x2)/2} V${y2} H${x2}`,
      // No `esc()` any more: a colour is 32 unverified characters off the wire
      // and this used to be interpolated into markup. It is an attribute value
      // now, so there is nothing to escape.
      stroke: s ? s.color : "var(--muted)",
      width: !s ? 1 : s.dash ? 1.8 : pinning ? PIN_WIDTH : 2.5,
      dash: !!(s && s.dash), opacity: s ? 1 : .28, pin: !!pinning,
    });
  }
  mountArrows(svg, [...parts, ...pins]);
}

// The editor for the above. A live sample line rather than a colour chip alone,
// because "dashed" is a property of the line and a swatch cannot show it.
// THE WORKING CALENDAR, one editor (ADR 0021): windows per weekday and per date, both in `doc.hours`.
// Neither writes anything but the document, so "unsaved changes" notices them
// the same way it notices every other edit: by the doc no longer matching its
// saved copy. An edit the server would refuse (overlapping windows, a start
// after its end) is flashed here instead of sent.
function weekEditor() {
  const host = $opt("#wwedit");
  if (!host) return;
  const h = doc.hours || {}, today = todayISO(doc);
  const week = WEEKDAYS.map(k => h.week?.[k] || []);
  const put = (hours: Hours) => {
    const bad = hoursProblem(hours);
    if (bad) flash(bad, true); else emit({ type: "patchDoc", patch: { hours } });
  };
  mountWeekEditor(host, {
    week, anyHours: week.some(w => w.length), today,
    // PAST OVERRIDES STAY IN THE DOCUMENT as history: they are not listed, and every write below spreads them back in.
    dates: Object.entries(h.dates || {}).filter(([iso]) => iso >= today).sort(([a], [b]) => a < b ? -1 : 1),
    onWeek: (i, w) => put({ ...h, week: { ...h.week, [WEEKDAYS[i]!]: w } }),
    onDate: (iso, w) => {
      const dates = { ...h.dates };
      if (w) dates[iso] = w; else delete dates[iso];
      put({ ...h, dates });
    },
    weekStart: doc.weekStart ?? 0,
    onWeekStart: v => emit({ type: "patchDoc", patch: { weekStart: v } }),
  });
}

function arrowEditor() {
  const box = $opt("#arrowedit");
  if (!box) return;
  // The WHOLE `arrows` map goes over: `patchDoc` shallow-merges the document, so a
  // write nested one level down would not survive the wire.
  const set = (k: string, patch: Record<string, unknown>) => {
    const one: any = { ...arrowStyle(k), ...patch };
    delete one.label; delete one.k;
    emit({ type: "patchDoc", patch: { arrows: { ...(doc.arrows || {}), [k]: one } } });
  };
  mountArrowEditor(box, {
    arrows: ARROWS.map(a => { const s = arrowStyle(a.k);
      return { k: a.k, label: a.label, color: s.color, dash: !!s.dash }; }),
    onColor: (k, color) => set(k, { color }),
    onDash: (k, dash) => set(k, { dash }),
  });
  // STILL IMPERATIVE, on purpose. `#dhover` and `#dclick` are two `<select>`s
  // declared in the markup, not containers — React would own their `<option>`s
  // while the markup owned the element the change fires on, which is the split
  // ownership `mount.tsx` exists to keep out. Two dropdowns rebuilt from the
  // document cost nothing and lose no caret; they move when their panel does.
  depthEditor();
}

// The two depth budgets. A <select> rather than a number input on purpose: the
// useful range is single digits and one of the values is not a number at all, so
// a dropdown needs no clamping, no "what does 0 mean", and no way to type 47.
//
// Rebuilt from the document on every render rather than set once, so it agrees
// with a plan that was just imported, forked or swapped underneath it.
function depthEditor() {
  for (const m of ["hover", "click"]) {
    const host = $opt("#d" + m + "host");
    if (!host) continue;
    const now = depthOf(m);
    mountPicker(host, {
      id: "d" + m,
      value: String(now === Infinity ? "all" : now),
      options: DEPTH_STEPS.map((v): PickerOption => ({
        value: String(v),
        label: v === 1 ? "1 hop — direct only" : v === "all" ? "the whole chain" : `${v} hops`,
      })),
      // Numbers stay numbers in the saved document; only "all" is a string. An
      // exported plan reading `"depth": { "hover": 1, "click": "all" }` explains
      // itself to whoever opens the file next.
      onPick: v => emit({ type:"patchDoc", patch: { depth: { ...(doc.depth || {}),
                            [m]: v === "all" ? "all" : +v } } }),
    });
  }
}

// A BORDER IS A BORDER STYLE. Thickness was tried and rejected: 1/2/3px is not
// separable on a projector, which is the only screen that matters here. Style is
// — none / dotted / dashed / solid are distinguishable at a glance and at any
// size, and the ordering happens to read as "firming up toward production".
//
// Fully data-driven: each entry in doc.borders names its own style, so the
// channel can be repurposed for anything with a handful of values.
//
// Border COLOUR is deliberately NOT offered. Every hue here is spoken for —
// blue is upstream and selection, green downstream and today, red the deadline —
// and a rim hue sits directly against the fill hue, where adjacent colours fuse
// instead of reading separately.
// THIS LIST IS NEARLY AT ITS CEILING, and that is worth saying plainly so nobody
// spends an afternoon rediscovering it. CSS offers ten border-styles; the other
// five (`hidden`, `groove`, `ridge`, `inset`, `outset`) derive their appearance
// by lightening and darkening the border COLOUR, and at 2px of near-white on a
// dark bar they render as a thinner solid or as nothing at all. They are not
// options here, they are traps.
//
// Thickness was tried and rejected (see below) — 1/2/3px is not separable on a
// projector, which is the only screen that matters.
//
// The only genuinely new values available are SIDE-SELECTIVE ones: a rim that
// exists on two sides instead of four is a different silhouette rather than a
// different texture, so it survives being small.
// Two axes, deliberately kept apart: the first five are WHICH TEXTURE on all four
// sides, the last six are WHICH SIDES in plain solid. Crossing them (a dashed
// left-and-top) is 5x6 = 30 values nobody can hold in their head, and the point
// of an enum is that you can point at a bar and say which one it is.
const BORDER_STYLES = ["none", "dotted", "dashed", "solid", "double",
                       "top", "bottom", "left", "right", "rails", "caps"];
function borderCss(bid) {
  const b = (doc.borders || []).find(x => x.id === bid);
  // TWO ways to mean "no border", and both used to render as a bright 2px solid
  // — identical to prod, which is the loudest value on the ramp:
  //   * the task has no border assigned at all (`border: null`, e.g. dev work
  //     that is not environment-specific). This fell through to the `solid`
  //     fallback, so every unassigned task was wearing prod's styling.
  //   * the border IS assigned, to a value whose style is "none".
  // Both now render nothing at all. `box-sizing: border-box` is set globally, so
  // dropping the border does not resize the bar — the fill just reaches the edge.
  if (!bid || !b) return "border:none";
  return rimCss(BORDER_STYLES.includes(b.style as any) ? b.style : "solid");
}

// Style name -> CSS, with no document lookup, so the swatch wall can render every
// value in BORDER_STYLES including the ones no plan currently uses. Kept separate
// from borderCss precisely so the reference and the chart cannot disagree: there
// is one function that knows what "rails" looks like.
//
// A DECLARATION LIST, not a value, because `rails` and `caps` are two sides rather
// than four and there is no shorthand that says so. Both call sites take a whole
// `style` attribute, which is also why this sets `border:none` first — a stale rim
// from a previous render would otherwise survive the side-specific ones.
const SIDES = { top:["top"], bottom:["bottom"], left:["left"], right:["right"],
                rails:["top","bottom"], caps:["left","right"] };
function rimCss(style) {
  if (style === "none") return "border:none";
  const rim = `2px ${SIDES[style] ? "solid" : style} rgba(255,255,255,.92)`;
  const sides = SIDES[style];
  return sides ? "border:none;" + sides.map(d => `border-${d}:${rim}`).join(";")
               : `border:${rim}`;
}

// SHAPE is the silhouette of the bar, and it is the last visual channel this
// chart had left — position and length are the dates (load-bearing, never
// decorate with them), hue is the system, the rim is the environment, the
// texture is the confidence, and opacity belongs to the filter.
//
// OPT-IN, UNLIKE THE OTHER CHANNELS. A plan with no `doc.shapes` gets no Shape
// group in the legend and every bar renders exactly as it did before this
// existed. Seeding one would be imposing a meaning nobody asked for on every
// plan already on disk, and an empty channel taking a slot in the legend is four
// pixels of nothing next to four channels that mean something.
// `square` is gone. 0px vs 4px of corner on an 18px bar is not a difference you
// can name across a room, and the fix — rounding `soft` harder — walks it into
// `pill` at 9px. A channel value nobody can identify is worse than one fewer.
// Two families again, for the same reason the borders have two. The first five
// are pure `border-radius` — the rim survives around the curve, so every border
// style still reads exactly. The last six are `clip-path` silhouettes, which draw
// their own rim (see `.core` in the stylesheet) because a CSS border cannot
// follow a diagonal.
const SHAPES = ["soft", "pill", "oval", "roundleft", "roundright",
                "slant", "trapezoid", "chevron", "chevronback", "diamond", "notch"];
const POINTED = new Set(["slant", "trapezoid", "chevron", "chevronback", "diamond", "notch"]);
const shapeDef = (sid: Id): ChannelValue | undefined =>
  (doc.shapes || []).find(x => x.id === sid);
const shapeOf = t => {
  const s = (shapeDef(t.shape) || {}).shape;
  return SHAPES.includes(s as any) ? s : "soft";
};
// The border STYLE name a task resolves to, which the pointed-shape rim needs
// and the CSS border path does not (it goes through rimCss instead).
const borderStyleOf = t => {
  const b = (doc.borders || []).find(x => x.id === t.border);
  return !t.border || !b ? "none" : (BORDER_STYLES.includes(b.style as any) ? b.style : "solid");
};

// FILL is the third channel, and also data. `pattern` picks how the bar body is
// drawn.
// `edges` is gone: it was a white rule top and bottom, which is the border
// channel's `rails` drawn two pixels further in — the same mark in two channels,
// and the one collision worth deleting rather than living with.
//
// The diagonals are now a symmetric 2x2 — both directions, both densities —
// because "sparse and dense" was available in one direction only, which made
// the channel feel arbitrary rather than systematic. `dense` was renamed to
// `hatchdense` in that pass; nothing on disk used it.
const FILL_PATTERNS = ["solid",
  "underline", "overline", "midline",                       // where a bright rule sits
  "hatch", "hatchdense", "backslash", "backslashdense",     // diagonals: direction x density
  "cross", "vertical", "dots", "fade"];                     // non-directional texture
// NO `|| fills[0]` ANY MORE. That fallback drew a task with no fill AS the first
// value while the legend counted it as none of them — the bar said "known" and
// the tally said nothing did. Since v3 every task carries a real fill, so there is
// nothing to fall back FROM; the bare `{}` is left as the shape a hand-edited file
// gets, and it renders as plain solid rather than impersonating a value.
const fillDef = (fid: Id): Partial<ChannelValue> =>
  (doc.fills || []).find(x => x.id === fid) || {};
// What an unassigned task gets, per channel — an ID, deliberately, so reordering
// values with the ↑/↓ buttons cannot silently change which one means "not
// applicable". Position in these lists already means something else (the border
// ramp reads dev -> prod down the list), which is exactly why this is not "the
// first one". Only set where a plan actually HAS a not-applicable value.
const defaultOf = (key: string): Id | undefined => ((doc && doc.defaults) || {})[key];
// ONE BUILDER FOR A SHAPE SWATCH, shared by the legend and the channel editor.
// They drew the same markup twice and so carried the same bug twice.


function hopsDown(tid, max = Infinity) {
  const seen = new Map([[tid, 0]]);
  let front = new Set([tid]);
  for (let d = 1; d <= max && front.size; d++) {
    const next = new Set();
    for (const t of doc.tasks)
      if (!seen.has(t.id) && t.deps.some(x => front.has(x))) { seen.set(t.id, d); next.add(t.id); }
    front = next;
  }
  return seen;
}
// The set-shaped views, for the callers that only ask "is it in the chain at all"
// — the ⊙ chain-focus lens and the inspector's transitive list. Both are
// unbounded on purpose: they answer "show me the whole chain", asked once, on
// purpose. Dropping the focus itself keeps the old contract, where a task was
// never its own ancestor.
const drop = (m, tid) => { m.delete(tid); return new Set(m.keys()); };
const ancestorsOf   = tid => drop(hopsUp(tid), tid);
const descendantsOf = tid => drop(hopsDown(tid), tid);

// WHAT IS FILTERED, AND WHAT IS "THIS CHAIN" — asked in one place, because there
// are two views now. The legend filter and the ⊙ chain lens are properties of the
// SESSION rather than of the timeline, so a second lens has to reach the same
// answers or it is a separate tool wearing the same toolbar.
// The text box is folded in HERE rather than beside each caller, so it obeys the
// same two lenses as every chip: dim greys what does not match, isolate drops it.
// A search that hid rows while the legend dimmed them would be a third lens, and
// the comment above is the argument against having one.
const isFiltering = () => {
  // A VALUE THAT NO LONGER EXISTS IS NOT A FILTER — it is an empty chart with no
  // chip on screen to explain itself. `focus` holds ids, and deleting the value
  // they name takes away the only control that could clear them: the × on a
  // milestone chip sits on the chip you filter with, and someone ELSE in the room
  // deleting one arrives with no warning at all. Same dangling-reference class as
  // `sel` and `chainFocus`, healed in the one place that asks "is anything
  // filtered", because an id nothing answers to is not something to filter by.
  for (const c of FILTER_CHANNELS)
    for (const v of focus[c])
      if (!chVals(c).some(x => x.id === v)) focus[c].delete(v);
  return !!queryText() || FILTER_CHANNELS.some(c => focus[c].size);
};
const matchesFilter = t => matchesQuery(t) && FILTER_CHANNELS.every(c =>
  !focus[c].size || valsOf(t, c).some(v => focus[c].has(v)));
// A chain focus whose task has been deleted must not leave a view showing one
// node forever — same class of dangling reference as `sel`.
const chainMembers = () => {
  if (chainFocus && !doc.tasks.some(t => t.id === chainFocus)) chainFocus = null;
  return chainFocus
    ? new Set([chainFocus, ...ancestorsOf(chainFocus), ...descendantsOf(chainFocus)]) : null;
};

// ---- THE GUARD ------------------------------------------------------------
// `doc` IS A PROXY, AND EVERY WRITE THROUGH IT THROWS. This is ADR 0001's named
// mitigation, and it is the reason the remaining mutation sites can be converted
// one at a time instead of all in one breath-holding commit.
//
// The argument, from the ADR: every mutation must be a command, with NO
// exceptions — because array position in `tasks` is queue position is a
// SCHEDULING INPUT. So a write that skips the command log does not merely fail
// to reach the other people in the room. It leaves two documents that disagree
// about a DATE while both look entirely plausible, which is the exact failure
// this tool exists to prevent. It is also the same shape that killed undo in the
// original tool: a snapshot needed at 28 mutation sites, and missing one broke
// it silently.
//
// SILENTLY is the whole problem, so a missed site is made loud instead: it
// throws where it happens, on the first click, naming itself.
//
// COMMANDS ARE APPLIED TO THE RAW DOCUMENT, never through the proxy — see
// `emit`. So there is no "writes are open now" flag, and therefore no window
// during which a stray write somewhere else could ride through on someone
// else's permission. The set trap simply always throws, and the one legitimate
// writer reaches past it by construction.
const RAW = new WeakMap();      // proxy  -> the object it wraps
const PROXIED = new WeakMap();  // object -> its one proxy

// Named at the point of failure rather than carried down as a path string,
// because a path would mean building a string on every property READ — and a
// render reads thousands.
const refuse = (t, k) => new Error(
  (Array.isArray(t) ? `doc.tasks[${String(k)}]`
    : t && typeof t.id === "string" && typeof t.dur === "number"
      ? `task ${JSON.stringify(t.id)}.${String(k)}`
    : t && Array.isArray(t.tasks) ? `doc.${String(k)}`
    : `.${String(k)} on an object inside the document`)
  + " was written directly, outside a command. Every mutation must be a command"
  + " (ADR 0001) — this site has not been converted yet. Build a Command from"
  + " shared/commands.ts and put it through emit().");

// Lazy, and cached one proxy per object so identity is stable: code that reads
// the same task twice still finds the two reads equal.
const WHEN_KEY = new Set(["notBefore", "refinedAt", "due"]);
// Cached, because the chart reads these thousands of times a render and `Intl`
// is not free. Keyed by origin and zone as well: a swapped-in history version
// can have either differ.
const DAYNUM = new Map<string, number>();
const dayNum = (iso: string) => {
  const d = rawDoc(), key = `${d.start}|${zoneOf(d)}|${iso}`;
  let n = DAYNUM.get(key);
  if (n === undefined) DAYNUM.set(key, n = dayOfInstant(iso, d));
  return n;
};
/** A duration in days as the whole minutes a command carries (v7). Never below
 *  one minute: zero is refused. */
const mins = (days: number) => Math.max(1, Math.round(days * 1440));
/** A day number as the instant a command carries. The inverse of the guard. */
const whenOf = (n: number | null | undefined) => n == null ? null : instantOfDay(n, rawDoc());

function guard(v) {
  if (v === null || typeof v !== "object") return v;
  const had = PROXIED.get(v);
  if (had) return had;
  const p = new Proxy(v, {
    // FUNCTIONS ARE HANDED BACK UNBOUND ON PURPOSE. `doc.tasks.find(...)` then
    // runs with `this` set to this proxy, so the elements it hands the callback
    // are guarded too. Bind them to the raw array instead — the obvious way to
    // stop `push` tripping over its own bookkeeping — and every array method
    // becomes a hole straight through the guard. The price is that
    // `doc.tasks.push(...)` throws in here, which is correct: that is an
    // unconverted mutation site announcing itself.
    // THE FIVE TASK TIMES READ AS DAY NUMBERS. They are stored as instants
    // (schema v6) and every reader in this file does arithmetic on them, so the
    // guard — the one door every read already goes through — projects them,
    // in the plan's zone, via `dayNumbers`' own conversion. Writes never see
    // this: the applier and `structuredClone` take `rawDoc()`, and anything that
    // sends a time converts it back with `whenOf`.
    // And `dur`, stored in whole minutes since v7, reads in DAYS — the unit
    // every reader here and the scheduler count in. `mins` converts back.
    get: (t, k) => {
      // `worked` and `resume` are not stored: what `dayNumbers` adds to a task being worked on, so the
      // forecast spends what is left of the estimate instead of all of it.
      if (k === "worked" || k === "resume") return workedOn(t as any, rawDoc(), nowD())?.[k];
      // `actualStart` and `actualEnd` are not stored either (v8): the first start and, once done, the last stop.
      if (k === "actualStart" || k === "actualEnd") { const v = actualsOf(t as any)[k]; return v == null ? undefined : dayNum(v); }
      // `planned` reads as day-number stretches, like the times beside it; `sessions` stay instants.
      if (k === "planned") { const v = (t as any).planned; return v ? v.map((s: any) => ({ start: dayNum(s.start), stop: dayNum(s.stop) })) : v; }
      const v = Reflect.get(t, k);
      return typeof v === "string" && WHEN_KEY.has(k as string) ? dayNum(v)
        : k === "dur" && typeof v === "number" ? v / 1440 : guard(v);
    },
    set: (t, k) => { throw refuse(t, k); },
    deleteProperty: (t, k) => { throw refuse(t, k); },
    defineProperty: (t, k) => { throw refuse(t, k); },
  });
  PROXIED.set(v, p); RAW.set(p, v);
  return p;
}

/** The unguarded document, for the two callers entitled to it: the command
 *  applier, and anything that must hand the document to `structuredClone` —
 *  which refuses a Proxy outright with a DataCloneError, so this is a
 *  correctness requirement rather than an optimisation. */
const rawDoc = () => (doc && RAW.get(doc)) || doc;
/** A task's planned stretches as STORED (instants), for the commands that write the list whole; the guard reads them as day numbers. */
const storedPlanned = (id: Id): { start: string; stop: string }[] => rawDoc().tasks.find((x: any) => x.id === id)?.planned || [];

// ---- state ----------------------------------------------------------------
// `doc` IS NULLABLE FOR ONE WINDOW ONLY — between boot and the first `welcome`
// frame, and on the failed-load path where the toolbar is disabled precisely
// because there is no document. Everything else in this file runs after a plan
// is on screen.
//
// Typed non-nullable with that window guarded rather than `Doc | null` with 170
// assertions: the existing `if (!doc) return` checks still compile and still run,
// so the guard survives, while the type stops demanding a proof at every read
// that the code already established once at the top of the call.
let doc: LoadedDoc = null as unknown as LoadedDoc, id: string | null = null, st: Starts = {},
    sel: Id | null = null, linking: Id | null = null;
// THE LAST `error` FRAME, kept so the "could not open this plan" panel can print
// the server's own answer instead of guessing at a revoked token. A flash times
// out and that panel does not, so without this the one sentence that said WHY
// had already vanished by the time somebody read the one that said WHAT.
let lastServerError = "";
// WHICH WAY THE ARMED LINK POINTS. `linking` names one end; without this it was
// always the same end — the armed task was the BLOCKER and the next click was
// made to wait for it. Saying the opposite meant going to the other task and
// arming it from there, which is a navigation to express a direction.
//
// NAMED FOR THE RELATIONSHIP, NOT FOR THE ARROW. "from"/"to" is how the old
// button read and nobody reads an arrow the same way twice; these are the words
// the dependency rows in the panel already use.
let linkDir: "blocks" | "waits" = "blocks";
/** ARM THE MODE, BOTH HALVES OF IT. On the timeline you finish a link by
 *  clicking the second task; on the graph you can also DRAG between the two,
 *  and that gesture is armed rather than always-on so a plain drag keeps meaning
 *  "move this node". That arming used to live in the toolbar button's handler
 *  and nowhere else, so it left with it — this is where it went. */
const armLink = (dir: "blocks" | "waits") => {
  linkDir = dir;
  linking = sel;
  if (cyEh) { if (linking) cyEh.enableDrawMode(); else cyEh.disableDrawMode(); }
  inspector();
};
// `viewing` IS GONE, along with the Open button it labelled. It said which saved
// version the working document came from, which was only ever a state this tab
// could get into — the room never moved, so the label described a private
// fiction and the edits made under it applied to the live plan from a stale
// base. History is look-and-compare now; the way to act on an old version is to
// fork it, which lands somewhere the room is not.
// The newest archived version's metadata — note and timestamp, never its document.
let lastSave: { n: number; at: string; note?: string; by?: string } | null = null;
let POS: Record<Id, any> = {}, SHIFT = 0, BINDING: any = null;
// ---- the comparison, and why it is no longer stored ------------------------
// This was a BASELINE: `doc.baseline`, one per plan, frozen by a button and
// written into the document. The argument for storing it was precise and worth
// keeping, because most of it survived:
//
//   A COMPARISON MUST NOT TRACK CURRENT STATE. That is its entire job. One that
//   silently recomputed would always show zero variance and look like good news,
//   which is worse than having none.
//
// What changed is where an immutable past state comes from. When that rule was
// written the only way to have one was to freeze a copy, and the only place to
// put the copy was the document. Now every Save archives the whole document, so
// the plan's own history IS a list of immutable past states — and the rule is
// satisfied by pointing at one rather than by copying it. The comment this
// replaces even named the condition: "Many is a list, a picker, a comparison
// mode and a different, larger tool. Reopen it when there is a meeting that
// needs the other." History is the list and the picker.
//
// So the comparison is now a LENS, not a field:
//   - the source is a saved version, which cannot drift because it cannot change
//   - it lives in memory, and its identity lives in the URL hash beside the other
//     eight keys of view state, so a reload keeps it and the document stays clean
//   - there is no "one of them and no undo" any more; switching is free, and the
//     last destructive confirm in the tool goes with it
//
// STILL DERIVED IN ISO DATES, not day numbers. Every other coordinate counts from
// `doc.start`, which is editable — and now the two documents being compared can
// have DIFFERENT start dates, which makes day numbers not merely fragile but
// meaningless across the pair. A comparison is a claim about dates.
//
// And it still records the DRAWN extent, shift included, because what it is a
// record of is the chart people looked at. Comparing today's shifted bar against
// an unshifted snapshot would report variance for work that never moved.
let CMP: { n: number; at: string; approx?: boolean; note?: string;
           tasks: Record<Id, [string, string]> } | null = null;   // { n, at, approx, note, tasks: {id: [startISO, endISO]} }
// Playback view state, declared up here with its sibling lens rather than beside
// its own functions: `emit` guards on it and is defined earlier in this module,
// so a declaration further down would leave that guard reading a name in its
// temporal dead zone if anything ever emitted during module evaluation.
// See startPlayback() for what this is and why it closes the socket.
let PLAY: {
  v: Version[]; i: number; playing: boolean; timer: any; live: Doc | null;
  cmp: typeof CMP; stats: any[];
  /** Milestone dates off the NEWEST save, measured once when playback starts. */
  targets: { label: string; at: number }[];
} | null = null;

const baseOf = t => {
  const v = CMP && CMP.tasks[t.id];
  return v ? { a: dayOf(v[0]), b: dayOf(v[1]) } : null;
};
const cmpLabel = () => CMP ? `save #${CMP.n}${CMP.note ? ` · "${CMP.note}"` : ""}` : "";
// THE VARIANCE IS ON THE START, not on the duration, because the question a
// baseline is asked in a meeting is "has this moved". A task can also have got
// longer or shorter, which the two extents show directly — the number here names
// the one thing two bars side by side are hardest to read off.
// TWO NUMBERS, because a bar can move without changing length and change length
// without moving, and saying only the first would report "on the plan of record"
// for a bar that had since doubled. The two extents show both directly; this
// names them, which is what a number is for next to a picture.
const varianceStr = (t, base) => {
  const d = st[t.id] + shiftOf(t) - base.a;
  const len = spanOf(t, st[t.id]) - (base.b - base.a);
  // A MINUTE, not zero: the baseline is kept to the minute, and a start at "now"
  // is not, so a task that has not moved read "starts 0 min earlier".
  const moved = Math.abs(d) < MINUTE ? "starts where the comparison put it"
              : d > 0 ? `starts ${calStr(d)} later than the comparison`
                      : `starts ${calStr(-d)} earlier than the comparison`;
  return moved + (Math.abs(len) < MINUTE ? ""
                : len > 0 ? `, and runs ${calStr(len)} longer` : `, and runs ${calStr(-len)} shorter`);
};
// LEFT PLUS WIDTH, NOT `endOf(t, shifted)`, and the difference is not academic —
// it shipped wrong. A bar's WIDTH comes from the span measured at the UNSHIFTED
// start, while its LEFT edge is shifted; asking the calendar again from the
// shifted start is a different question, and it gets a different answer the
// moment a holiday sits between the two. On a real plan with a five-day week,
// seven days off and slack to slide into, 11 of 38 bars were recorded 4-11px
// longer or shorter than the bar anybody had actually looked at — a comparison
// reporting movement at the instant it was taken. `finShown` in renderInner()
// carries this same note, and this function was written three commits later
// without it. It applies to a version derived here for exactly the same reason.
// THE STRIPS ARE A PROPERTY OF A RENDER, NOT OF A DOCUMENT, which is the whole
// reason this is not three lines. They need `st` and `SHIFT`, and only
// renderInner() fills those — SHIFT in particular is the ALAP alignment, a
// drawing choice made against the tightest milestone. So deriving them for an
// archived version means pointing the globals at that version and running one
// real render pass, then putting everything back.
//
// Reusing the pipeline rather than transcribing the alignment maths is the point:
// a second copy of that calculation is a second copy that can disagree, and the
// note above captureBaseline's ancestor records what that cost last time — 11 of
// 38 bars recorded 4-11px off the bar anybody had actually looked at.
//
// Synchronous throughout, so the browser never paints the intermediate state, and
// the caller renders immediately after. Returns null rather than a wrong answer if
// that version will not schedule.
function stripsFrom(d) {
  const heldDoc = doc, heldSt = st, heldShift = SHIFT, heldCal = CAL, heldCmp = CMP;
  try {
    // CMP off during the pass: the throwaway render would otherwise try to draw
    // the OLD comparison against the version being measured.
    CMP = null;
    doc = guard(applyMigrations(structuredClone(d)));
    st = {};
    renderInner();
    // renderInner bails early on a dependency cycle, leaving `st` as it found it —
    // which is why it is emptied first. Same-lineage plans share task ids, so
    // "did anything get scheduled" is not a safe enough question on its own.
    if (!doc.tasks.length || doc.tasks.some(t => st[t.id] == null)) return null;
    const tasks = {};
    for (const t of doc.tasks) {
      const a = st[t.id] + shiftOf(t);
      // WITH THE CLOCK. Dates alone came back as midnight, so comparing against the
      // very save on screen said a 3pm task "starts 15 hrs later".
      tasks[t.id] = [isoTimeOf(a), isoTimeOf(a + spanOf(t, st[t.id]))];
    }
    return tasks;
  } catch { return null; }
  finally { doc = heldDoc; st = heldSt; SHIFT = heldShift; CAL = heldCal; CMP = heldCmp; }
}

// Resolve a version number to a live comparison. Null clears it. The hash carries
// only the NUMBER — the strips are re-derived on load, because caching a few KB of
// dates in a URL to save one synchronous render is a copy that can go stale.
async function applyCompare(n) {
  if (n == null) { CMP = null; render(); return; }
  // ONE VERSION, ASKED FOR BY NUMBER. This read the entire archive and searched
  // it for `n` — every document in the plan's history, to paint one of them.
  const v = await store.version(n).catch(() => null);
  if (!v) {
    CMP = null; render();
    return flash(`save #${n} is not in this plan's history`, true);
  }
  const tasks = stripsFrom(v.doc);
  if (!tasks) {
    CMP = null; render();
    return flash(`save #${n} will not schedule, so there is nothing to compare against`, true);
  }
  CMP = { n: v.n, at: v.at, approx: v.approx, note: v.note, tasks };
  render();
}
// THE SHIFT IS PER TASK, AND FOR MOST PLANS THAT IS THE SAME NUMBER TWICE.
// Right-alignment slides the picture as late as the tightest milestone allows,
// which is a drawing choice about where UNSTARTED work sits inside its slack.
// Work that has already begun has neither slack nor a choice: it is on the date
// it happened, and sliding it would draw a bar somewhere the world disagrees
// with. So a pinned task gets no shift at all.
//
// The whole-week quantum keeps applying to the tail and has nothing to preserve
// here: it exists so a slide leaves every task on the weekday its span was
// measured from, and a pinned task's span comes from its own two dates.
const shiftOf = t => (t.actualStart == null ? SHIFT : 0);
// CHAIN FOCUS — a third lens, and the only one that is not a legend filter. Set
// to a task id by the 👁 in the inspector, it hides everything the selected task
// is not connected to in either direction: its dependencies, theirs, what it
// unblocks, and what those unblock. "Which rows do these lines touch" is the
// question a room asks constantly and the arrows alone answer badly once the
// chart is twenty rows tall.
//
// Deliberately NOT folded into `focus`: the legend channels are attributes of a
// task (its team, its colour), and this is a relationship between tasks. They
// compose — an isolated chain can still be filtered to prod — so they stay two
// independent predicates rather than one overloaded set.
let chainFocus: Id | null = null;
// FOCUS: per-channel sets of values to show. Empty set = that channel imposes no
// filter. Semantics chosen deliberately:
//   within a channel  OR   ("prod or QA")
//   across channels   AND  ("prod AND networking")
// which is what makes "show me the prod networking work" a two-click question.
//
// Clicking a value ISOLATES it rather than hiding it — first click narrows to
// that one, further clicks widen. That matches what people reach for ("click the
// thing I want to see") instead of the inverted click-to-hide model, which reads
// backwards until you have clicked four things.
//
// It DIMS, it does not remove: the rows stay put, so nothing reflows under the
// pointer, and — more importantly — filtering is a VIEW. It never touches the
// schedule, and a filtered chart still shows the same dates as an unfiltered one.
// TWO LENSES, AND THEY ANSWER DIFFERENT QUESTIONS.
//
//   dim      every row stays; the rest go grey. You keep the context — where the
//            prod work sits relative to everything else, and the fact that there
//            IS everything else. This is the right default in a meeting, because
//            a chart that silently drops rows can be argued with dishonestly.
//   isolate  the rest are removed. The subset becomes its own short chart, which
//            is what you want when the answer is "just show me the networking"
//            and eighteen other rows are noise on a projector.
//
// NEITHER TOUCHES THE SCHEDULE. A bar sits at the same x in both modes, and the
// milestone verdicts do not move, because filtering is a view and the dates are
// not a function of what you happen to be looking at. Asserted in the suite.
//
// Isolate is done at RENDER time rather than by hiding rows after the fact. A
// hidden row still has a position, so class-toggling would leave dependency
// arrows pointing into empty space and lane headers announcing teams with
// nothing under them. Skipping them while building means POS only ever holds
// rows that exist, and everything downstream is right for free.
let focusMode = "dim";        // "dim" | "isolate"
// Whether legend chips carry each value's total duration as well as its count.
// OFF by default: it is the half of the stat that is also in the tooltip, and the
// half that doubles the chip width. A view preference, so it rides in the hash
// beside `fm` rather than touching the document.
let showEffort = false;
// FINISHED WORK IS OFF BY DEFAULT, and this is the switch that puts it back.
//
// `readyOf` answers null for anything started, `dueOf` answers null for anything
// finished or dropped, and `used` drops a channel value once all its work is
// hidden — three places already agreeing that a forward-looking question should not
// be answered about history. All three were about CHIPS; the canvas kept drawing
// every completed task anyway, so the plan grew a tail of work nobody can act on.
//
// A VIEW PREFERENCE, so it lives here with the isolate lens rather than in the
// document: "I do not want to look at what I already did" is a statement about
// the reader, and the plan still contains every task either way.
let showDone = false;
// WHICH KIND OF OVER, or null for work still live. There is only one kind now —
// cancelling was retired on 2026-09-20 and work decided against is deleted — but
// the shape stays, because `drawn` below reads it and a future second kind of
// "over" would slot straight back in.
const overKind = t => t.done ? "done" : null;
// Finished or abandoned - the same phrase `dueOf` uses, kept identical on purpose
// so there is one definition of "this is over" rather than three.
const isOver = t => overKind(t) !== null;
// A DEFAULT YIELDS TO AN EXPLICIT REQUEST, which is the whole of why this is a
// function and not a `showDone` read. Picking the Done status chip IS the reader
// asking for finished work, and the gate ran after the filter regardless — so it
// narrowed to the done tasks and then hid every one of them. That is exactly the
// chip `used()` refuses to draw for every other channel: a control whose only
// outcome is an empty chart.
//
// ONE PER STATE, NOT ONE FOR ANY STATUS PICK. Picking Done is a request for
// finished work and picking Cancelled is a request for abandoned work; neither is
// a request for the other, and a single "any status pick yields" rule would have
// turned either chip into both.
//
// This pair used to be one function with a note explaining that it could not
// cover dropped work, because "a task abandoned before it started is `todo`" and
// yielding on a status pick would have turned Not started into "not started,
// plus the ones I gave up on". Giving cancelled its own STATUS value is what
// retired that: `statusOf` answers "dropped" now, so the chip that asks for it
// is the chip that gets it.
const drawDone = () => showDone || focus.status.has("done");
// THE STATUS VALUES THAT ADD ROWS RATHER THAN NARROWING THEM, named once so the
// two places that have to rebuild for them cannot fall out of step with
// `drawDone` above. A set of one, since cancelling went.
const GATED_STATUS = new Set(["done"]);
// IS THIS TASK DRAWN AT ALL. One predicate, because the four places that used to
// write `drawOver() || !isOver(t)` by hand are four chances to forget the second
// toggle — and the legend counts, added later, would have been the fifth.
//
const drawn = t => overKind(t) === null || drawDone();
const CHANNELS = ["lanes", "colors", "borders", "fills", "shapes"];
const FIELD = { lanes:"lane", colors:"color", borders:"border", fills:"fill", shapes:"shape" };

// STATUS IS A CHANNEL YOU CANNOT EDIT, which is why it is not in CHANNELS.
// `CHANNELS` does double duty: it lists what can be FILTERED, and it lists what
// is DATA — `doc[c]` value lists, the id-uniqueness pool, the ⚙ channel editor,
// the graph's group-by picker. Status is derived from two dates and has no
// `doc.status`, so a sixth entry there would put an uneditable pseudo-channel
// into an editor and mint ids against a list that does not exist. The split is
// the same idea `LABEL_CHANNELS` already uses: one list per job.
//
// MILESTONES ARE THE THIRD CASE THIS SPLIT HAS TO HOLD: filterable, and real
// document data (`doc.milestones`, so `chVals` answers for them with no change),
// but not a VISUAL channel. There is no `FIELD` entry because a milestone is not
// a way a bar is drawn — it is a date the bar is measured against — so it has no
// swatch to put in the legend and nothing for the ⚙ editor to restyle. Listing it
// in `CHANNELS` would put it in that editor and in the graph's group-by picker,
// both of which are questions about how a task LOOKS.
const FILTER_CHANNELS = [...CHANNELS, "status", "milestones", "ready", "refined", "risk"];
// The four states, and the ONLY place their order and labels are written down.
// Order is the order work moves through them, so the chips read left to right as
// a lifecycle rather than as an alphabet.
const STATUS = [
  { id:"todo",    label:"Not started" },
  { id:"running", label:"Running" },
  { id:"paused",  label:"Paused" },
  { id:"done",    label:"Done" },
];
// DERIVED, NEVER STORED, and by the shared `statusOf` — the same four `readiness()` returns
// (ADR 0016): the done flag, else a session open, else sessions, else none.
// WHAT COULD BE PICKED UP THIS MORNING — and deliberately NOT another value of
// STATUS, which is the obvious shape and the wrong one. Those four are read off
// recorded facts (the sessions, the done flag) and are mutually exclusive.
// This is read off the SCHEDULE — dependencies, the not-before, the lane queue,
// the calendar — and it is orthogonal: a task is not "not started OR ready", it
// is not started AND one of these. Making it a fourth chip would mean a ready
// task stopped counting as not-started, and the status counts would quietly
// stop adding up to the plan.
//
// So it is its own channel, which costs nothing: the legend, the dim/isolate
// lenses, the graph, the filter summary and "show everything" are all generic
// over FILTER_CHANNELS and pick it up for free.
//
// `st.why` IS THE ANSWER ALREADY. The scheduler records, per task, which input
// decided its start, and `today` (or `free`, its zero-origin twin in Elapsed)
// means nothing in the plan wanted this task later — the calendar alone moved
// it. That is the definition of startable, and the inspector's "waits for
// nothing" line is the same fact said in words. Anything else — deps, notBefore,
// lane — names a real thing still in the way.
const READY = [
  { id:"ready",   label:"Ready now" },
  // THE LAST THING THAT CAN HOLD A TASK, and it is not in the schedule at all.
  // "Ready now" meant every dependency done, the date passed, the team free —
  // and said nothing about whether anybody had read the task. Rascal Two: "things
  // that say ready now are not actually ready because they have not been
  // refined". Ranked AFTER every scheduling reason on purpose: this chip is only
  // shown when refining is the ONE thing in the way, which is the same
  // one-reason discipline `why` already applies.
  { id:"raw",     label:"Needs refining" },
  // ONE CHIP PER REASON, and the ids ARE the scheduler's own words so there is
  // nothing to translate. "Waiting" used to be all three of these, which made
  // the commonest state in a one-lane plan unreadable: 42 tasks said they were
  // waiting when nothing was wrong with any of them — they were simply in the
  // queue behind each other. The scheduler had the distinction the whole time
  // (`why` picks exactly one of deps/notBefore/lane) and the legend threw it
  // away. It also records WHO holds the slot, in `whyWho`, which this still
  // drops — a chip cannot carry it, but the inspector could.
  { id:"deps",      label:"Blocked" },
  { id:"notBefore", label:"Not before" },
  { id:"lane",      label:"Queued" },
];
const readyOf = t => {
  // Started or finished tasks are in NEITHER. "Ready" is about work not yet
  // begun; offering it for something already underway would be a chip that
  // cannot be acted on, and lumping those into "waiting" would be false.
  if (statusOf(t) !== "todo") return null;
  const w = st.why?.[t.id];
  // Before the first schedule, or after one that threw, there is no answer —
  // and inventing a reason would put every task in the plan under a chip that
  // is describing the absence of a computation.
  if (w === undefined) return null;
  // A START THAT HAS ALREADY COME holds nothing, whatever decided it — see
  // `readiness()`, which makes the same comparison for the API.
  if (w !== "today" && w !== "free" && !(st[t.id] <= nowD() + 1e-9)) return w;
  // THE SCHEDULE HAS NOTHING LEFT TO SAY, so the only remaining question is
  // whether anyone has agreed with what the task actually says. Mirrored in
  // `readiness()` in shared/schedule.ts — an agent asking the server what is
  // ready has to get the answer the chart is showing.
  return t.refinedAt == null ? "raw" : "ready";
};

// ---- refined, the other derived channel -----------------------------------
// WHETHER A HUMAN HAS READ THIS AND AGREED WITH IT, in its current wording. The
// document stores one date; everything else is read off it, which is the same
// bet `statusOf` and `readyOf` make and it pays the same way: there is no flag
// to forget to flip. `shared/commands.ts` clears `refinedAt` whenever a command
// changes the label, the description or the duration, so the state cannot lie.
const REFINED = [
  { id:"refined",   label:"Refined" },
  { id:"unrefined", label:"Unrefined" },
];
// NULL FOR WORK THAT IS OVER, exactly as `dueOf` and `readyOf` answer null for
// it. "Do I trust this description" is a question about work you might still
// act on; asking it of thirty finished tasks would open the Unrefined chip at a
// number nobody is going to work through. The DATE stays on a finished task, so
// a sign-off it already had survives being completed.
const refinedOf = t => isOver(t) ? null : t.refinedAt != null ? "refined" : "unrefined";
// The value list a channel offers. Data channels answer from the document;
// status answers from the constant above, because its values are not the plan's
// to define. Used by the legend and the filter chip summary — NOT by the editor
// or the id pool, which are `CHANNELS` questions and stay that way.
// WHETHER A DEADLINE IS IN TROUBLE — which is a different question from when it
// falls, and the one worth a chip.
//
// THIS WAS A CALENDAR READING AND IT ANSWERED NOTHING. Overdue / Due within a
// week / Due later bucketed by how far away the DATE was, so a task missing by
// three days and six tasks with comfortable margin all sat together under "Due
// within a week" — the same number as before, with none of the meaning. It could
// not tell you the one thing you would act on.
//
// SO IT IS SCORED AGAINST THE SCHEDULE INSTEAD, which is the whole point of
// having a scheduler: `due` is what you promised, `endOf(st)` is what the plan
// says will happen, and the gap between them is the only interesting number.
//
// AND THE THRESHOLD IS NOT ARBITRARY ANY MORE. "A week" was a constant somebody
// picked; "tight" is measured against `doc.dueBuffer`, the same margin the
// reorder search optimises for. Change the buffer and this moves with it,
// because they are one question asked twice — once by the optimiser deciding
// what to do about it, once here saying what is left.
//
// WHICH IS ALSO WHY IT SURVIVED. The Order chip fixes what ORDER can fix; on a
// plan whose deadlines are physically unreachable — five tasks due at 08:00
// tomorrow in one serial queue — it converges, reports nothing to do, and is
// telling the truth. This is the reading that says the rest out loud.
//
// FINISHED AND ABANDONED WORK IS NOT AT RISK. Leaving a done task under
// "overdue" would make the chip a count of history rather than of work to do,
// which is the same mistake `readyOf` avoids by answering null for anything
// already started. Comfortable work answers null too: a value nothing is in is
// not offered, so the group shrinks to the states the plan is actually in.
const RISK = [
  { id: "overdue", label: "Overdue" },
  { id: "miss",    label: "Will miss" },
  { id: "tight",   label: "Tight" },
];
const riskOf = t => {
  if (t.due == null || t.actualEnd != null) return null;
  // Before the first schedule there is no computed end to compare against, and
  // inventing one would put every dated task under a chip describing the
  // absence of a computation — the same guard `readyOf` makes.
  const at = st[t.id];
  if (at === undefined) return null;
  // AGAINST NOW, the instant the NOW rule is drawn at — not midnight. Deadlines
  // have a clock since v6; against midnight, something due at 9am read "will miss"
  // all afternoon instead of "overdue".
  if (t.due < nowD()) return "overdue";
  const spare = t.due - endOf(t, at);
  if (spare < 0) return "miss";
  return spare < (+doc.dueBuffer || 0) ? "tight" : null;
};
const chVals = c => c === "status" ? STATUS : c === "ready" ? READY
                  : c === "refined" ? REFINED
                  : c === "risk" ? RISK : (doc[c] || []);

let focus = Object.fromEntries(FILTER_CHANNELS.map(c => [c, new Set()]));

// FREE-TEXT FILTER. Not a channel — it has no fixed value set, so it cannot be a
// set of picked ids — but it composes with them by ANDing in `matchesFilter`,
// which is the same relationship the channels have with each other.
// Title AND description, because "the thing about the rates migration" is as
// often in the note as in the name. Case-insensitive substring, deliberately not
// a regex: this is a box people type two words into during a meeting.
let query = "";
const queryText = () => query.trim().toLowerCase();
const matchesQuery = t => {
  const q = queryText();
  return !q || `${t.label || ""} ${t.desc || ""}`.toLowerCase().includes(q);
};
// Systems and their colours are data. `subjects` is an ordered list so a plan can
// declare as many as it needs, each carrying its own hex.
const colorDef = (id: Id): ChannelValue | undefined =>
  (doc.colors || []).find(x => x.id === id);
// WHAT A TASK WITH NO SYSTEM LOOKS LIKE, and it is data now rather than a hex
// buried in a fallback. Colour is the one channel where "none" is a real state
// — `[]` is the honest bottom of a list — so it is the one channel that cannot
// express its own neutral as a VALUE the way the others do. Every other channel
// gets its default look by keeping one value and styling it; this one needed
// somewhere to put the same idea, and this is it.
const NO_COLOR = "#8aa0bd";
const noColor = () => ((doc && doc.noColor) || NO_COLOR);
const colorOf = id => (colorDef(id) || {}).color || noColor();

// COLOUR IS THE ONE CHANNEL THAT IS A LIST, and that asymmetry is the point
// rather than an inconsistency waiting to be tidied up. A task has ONE owning
// team, ONE environment and ONE confidence — but it can genuinely touch two
// systems, and a shared server belongs to both applications sitting on it.
//
// Without this you encode the overlap as its own value ("Rates API & MOAuth"),
// which is a combinatorial trap: three systems have three possible pairs, four
// have eleven, and every one is hand-maintained and invisible to a filter for
// either half of it. This is why colour, alone, is `[id, id]`.
//
// It is NOT offered on the other channels because they have nowhere to draw it.
// A 1px rim cannot be half dotted and half solid legibly, and the fill patterns
// already own the bar's interior texture. Colour has the room; nothing else does.
//
// Tolerant of the pre-v2 string on purpose: the migration rewrites documents on
// load, but a hand-edited file or a half-applied paste should render rather than
// throw, and one normaliser is cheaper than guarding every read site.
const colorsOf = t => t.color == null ? [] : Array.isArray(t.color) ? t.color : [t.color];
// The values a task presents to a given channel's filter. Single-valued channels
// answer with a one-element list so every caller can use the same `.some()`.
// Milestones answer through `msOf`, never `t.ms`, so a task that was never
// assigned one falls to the first milestone HERE exactly as it does in the chip's
// own task count and in the verdict. A filter that disagreed with the number
// printed on the chip you clicked would be worse than no filter at all.
const valsOf = (t, ch) => ch === "colors" ? colorsOf(t)
                        : ch === "status" ? [statusOf(t)]
                        : ch === "ready" ? [readyOf(t)]
                        : ch === "refined" ? [refinedOf(t)]
                        : ch === "risk" ? [riskOf(t)]
                        : ch === "milestones" ? [msOf(t)]
                        : [t[FIELD[ch]]];

// BORDER STYLING IS DERIVED FROM POSITION IN doc.borders, so a plan with two
// values, or five, gets a correct ramp with no code change.
//
// The channel is named after what it IS (a border), not what this plan happens
// to use it for (environments). That is the difference between a chart and a
// studio: someone whose second dimension is risk-owner, or funding source, or
// team, can use it without every label in the UI lying to them.
//
// LABW is measured, not chosen — and now measured per render rather than once by
// hand. It was a flat 430: sized to clear the longest label any shipped plan had,
// which meant every plan with shorter names paid for that headroom as a dead
// strip down the left of the screen. The gutter is the one part of this chart
// that does not scroll, so a pixel wasted there is a pixel of timeline you have
// to go looking for.
//
// 430 stays as the CEILING, and the old finding is why: at 300 the longest labels
// clipped by up to 81px and at 390 by 20 (verify's layout audit catches that; a
// screenshot does not, since text-overflow:ellipsis looks deliberate). Past the
// ceiling a name still ellipsizes, which remains the intended failure — the full
// text is in the bar's tooltip, and a name too long for the column is usually a
// name too long to read out loud.
// PIXELS PER DAY. It was 54 per week, and 54/7 kept every bar exactly the width
// it was when the base unit changed — that migration moved nothing on screen.
// It is no longer a constant, for an unrelated reason:
// PPD IS DERIVED FROM HOW MUCH TIME YOU ASKED TO SEE. It was 54/7 forever — a
// week is 54px — and the whole plan simply overflowed into #chart's scroller.
// That is still what "Whole plan" means, it just no longer needs a magic number:
// one rule, `pixels available / days in view`, covers every setting including
// that one. ROW stays fixed; this is a horizontal zoom and rows are not time.
const ROW = 26;
let PPD = 54 / 7, LO = 0;
// THE FINEST RULE THE LAST RENDER DREW, in days. Published for the same reason
// `PPD` and `LO` are: the corner readout is a pointer handler and runs long
// after the render that decided this. It answers one question — IS THE CHART
// SHOWING TIMES — and a value >= 1 means it is not. Not derived a second time
// in the handler on purpose: the whole point is that the readout and the axis
// change resolution on the same tick, and two copies of the ladder would be two
// places to disagree about when that is.
let TICK_STEP = 7;

// THE GRIP'S HIT COST, and it must match `.grip` in the stylesheet above: 8px
// wide, pulled 3px past the bar's right edge, so it sits on GRIP_ON_BAR px of the
// bar itself. A bar shorter than three times that is mostly handle — the ×3 is
// what leaves two thirds of a short bar clickable, which is the whole point.
const GRIP_ON_BAR = 8 - 3;
const GRIP_MIN_BAR = GRIP_ON_BAR * 3;

// THE EYE MARK needs a bar it can sit in the middle of. Same reasoning as the
// grip threshold and a different number, because this one is not a hit target —
// a glyph that does not fit just looks like a smudge, so it is dropped and the
// outline carries the meaning on its own. The outline works at ANY width, which
// is why it is the primary marker and this is the extra.
const EYE_MIN_BAR = 20;

// A CONSTANT ON PURPOSE, FOR NOW. The four arrow styles are per-plan data in
// `doc.arrows` and this probably belongs there too — but it is being tried before
// it is believed, and adding a settings row for something that may not survive
// contact is how a Settings tab fills up with abandoned experiments. Promote it
// if it stays. 2.5 is the width of a direct edge, so this is 2x that.
const PIN_WIDTH = 5;
// null = the whole plan. Otherwise a number of DAYS to fit in the window, which
// is what the picker is named in — "3 months" is a thing you can ask for, and a
// zoom percentage is not. Pinch writes a fraction into it, so it is a free
// number rather than one of the four the picker offers; VIEW is whatever ended
// up on screen, which is the thing both the picker and the pinch have to read.
// zoomDays is what is DRAWN, after snapping. zoomRaw is what the gestures have
// actually asked for, before it. They have to be separate or the snap becomes a
// trap: a pinch step smaller than the snap tolerance gets pulled back to the same
// preset every time, and the zoom cannot be moved off a preset at all. Real
// trackpads emit exactly those small steps, which is how this was found.
let zoomDays: number | null = null, zoomRaw: number | null = null, VIEW = 0, SPAN_DAYS = 1;
// Which teams are folded, and how far. lane id -> "t" (one row per track) or
// "1" (one row, whatever it takes). View state, like the isolate lens and the
// zoom: "I do not care what that team is doing right now" is a statement about
// the reader, not about the plan, and it has no business in the document.
let COLLAPSED = new Map<Id, string>();
let LABW = 430;

// The lane header's text in ONE place, because the column is now sized to fit it
// and a header the measurer has not seen is a header that clips.
function laneHeadText(lane) {
  const own = doc.tasks.filter(t => t.lane === lane.id);
  const load = own.reduce((s, t) => s + remainingOf(t), 0);
  const cap = Math.max(1, Math.floor(lane.cap || 1));
  // A CAPACITY THAT CANNOT BIND IS NOT A CAPACITY. `∥99` on a six-task lane reads
  // as a number somebody chose for a reason, when all it means is "this lane is
  // not a queue" — the digits are noise, and picking 99 over 40 over 1000 is
  // arbitrary. At or above the task count no queue can ever form, so say THAT.
  const unlimited = cap >= own.length;
  // `∥2` rather than "2 at a time". The words were four times the width of the
  // number for a fact most lanes do not carry at all, in a header that is already
  // competing with the label gutter. The parallel bars say "these run alongside
  // each other", which is what capacity means, and the full sentence is one hover
  // away on the header's own tooltip.
  return `${lane.label}  (${durStr(load)}${cap > 1 ? ` · ∥${unlimited ? "∞" : cap}` : ""})`;
}
const laneHeadTitle = lane => {
  const cap = Math.max(1, Math.floor(lane.cap || 1));
  const n = doc.tasks.filter(t => t.lane === lane.id).length;
  if (cap > 1 && cap >= n) return `${lane.label} runs everything in parallel \u2014 it is not a queue`;
  return cap > 1 ? `${lane.label} can run ${cap} tasks at a time`
                 : `${lane.label} runs one task at a time`;
};

// Measured with canvas, NOT offsetWidth, and that is load-bearing: reading layout
// part-way through a rebuild is the exact bug documented over render() — the
// document is momentarily short, the browser clamps scrollTop, and the clamp
// survives. measureText touches no layout at all, so it is safe to call from
// inside renderInner. The font is read once per class from a throwaway element,
// so the CSS stays the single source of truth for it.
/** Never null in a browser that can run this page; asserted once here rather
 *  than guarded at both call sites. @type {CanvasRenderingContext2D} */
const measureCtx = (document.createElement("canvas").getContext("2d") as any);
const fontCache = {};
function fontOf(cls) {
  if (fontCache[cls]) return fontCache[cls];
  const p = Object.assign(document.createElement("div"), { className: cls });
  p.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0";
  document.body.append(p);
  const cs = getComputedStyle(p);
  // Built from the longhands rather than the `font` shorthand: the shorthand
  // comes back empty when letter-spacing or text-transform are in play, which
  // both .lane-head and .rowlabel use.
  const f = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  p.remove();
  return (fontCache[cls] = f);
}
function labelColumnWidth() {
  const wid = (txt, cls) => {
    measureCtx.font = fontOf(cls);
    // .lane-head is uppercased by CSS and letter-spaced; measure what is actually
    // painted, not what is in the data, or the widest row clips by exactly the
    // difference.
    const t = cls === "lane-head" ? txt.toUpperCase() : txt;
    return measureCtx.measureText(t).width + (cls === "lane-head" ? t.length * 0.06 * 12 : 0);
  };
  let w = 0;
  // +18 for the arrow and its gap on any row carrying one. Measured as part of
  // the row rather than added to the column at the end: a plan where only a
  // short row has a link should not widen the gutter for the long one.
  for (const t of doc.tasks)
    w = Math.max(w, wid(rowLabelText(t), "rowlabel") + (linkOf(t) ? 18 : 0));
  // No lane heads in date mode, so measuring them would reserve a gutter for
  // text nothing is going to paint. The rows themselves are already right:
  // `rowLabelText` composes the team chip too, which is the whole reason the
  // renderer and the measurer share one composer.
  if (ROWMODE !== "date")
    for (const l of doc.lanes) w = Math.max(w, wid(laneHeadText(l), "lane-head"));
  // +12 clears .rowlabel's own padding-right, +14 is breathing room so the
  // longest label is not jammed against the first bar.
  // 430 IS STILL THE CEILING FOR A PLAIN PLAN — the clipping audit that produced
  // it has not stopped being true. But a plan that asks for chips has asked for a
  // wider gutter by definition, and holding it at 430 would ellipsize away the
  // thing that was just switched on. So the ceiling lifts, capped at 45% of the
  // window: past that the gutter is eating the chart, and the chart is the data.
  const ceiling = labelParts().length > 1 || ROWMODE === "date"
    ? Math.max(430, Math.round((($("#chart") || {}).clientWidth || 1200) * 0.45))
    : 430;
  return Math.round(Math.min(ceiling, Math.max(140, w + 26)));
}
// ALL DATE MATH IS UTC, and that is a correctness fix rather than a style
// preference. Parsed as local time, `start + 112 days of milliseconds` crosses
// the Nov 1 DST boundary and lands an hour early — which rendered Dec 2 as
// "Dec 1", off by a day. Worse, `deadline - start` came
// out as 14.006 weeks instead of 14, so the squash plan reported six thousandths
// of a week of slack instead of "exactly on the deadline, zero slack" — the one
// sentence the whole chart exists to say. UTC has no DST, so the arithmetic is
// exact and the ms shortcut is safe again.
const d0 = () => new Date(doc.start + "T00:00:00Z");
// THE TIME COORDINATE IS DAYS. It was weeks, and weeks is the wrong atom for a
// delivery plan: one day is 1/7, which is not representable in binary, so a
// chain of them accumulates error and "does this milestone make it" ends up
// riding on an epsilon. (The three 1e-9 tolerances in auditSchedule are the
// fossil of that.) Integer days compare exactly.
//
// Hours live INSIDE the day, not instead of it: `hours` narrows each working
// day to windows (ADR 0014, 0021), and the fraction of a day number is its wall clock.
//
// The BASE unit is not the DISPLAY unit — see durStr. Plans are still discussed
// in weeks, and the chart still says so wherever a week is the natural scale.
// A DAY NUMBER FROM EITHER A DATE OR A DATE AND A TIME — the scheduler's unit,
// which is what the Inspector's pickers speak. Stored times are instants since
// v6 (ADR 0010); this reads a picker's value on the plan zone's wall clock, and
// `whenOf` turns the result into the instant a command carries.
//
// THE TIME IS A WALL-CLOCK LABEL ON A DAY and is added as a fraction, never put
// through `Date`. The date half is parsed at UTC midnight exactly as it always
// was, so a plan does not shift by a day when it is opened in another zone;
// running the time half through a local-time Date would reintroduce precisely
// the drift that `T00:00:00Z` is there to prevent.
const dayOf = iso => {
  const [date, time] = String(iso).split("T");
  const base = (Date.parse(date + "T00:00:00Z") - +d0()) / DAY;
  if (!time) return base;
  const [h, m] = time.split(":");
  return base + ((+h || 0) * 60 + (+m || 0)) / 1440;
};
// `todayISO` is imported: the scheduler needs the same answer to draw its floor
// that this needs to draw the line, and two of them would drift by a time zone.
// `todayD` stays here because it is doc-RELATIVE — it reads `d0()`, so it is
// already correct for whichever document is swapped in (see `statsOf`).
const todayD = () => dayOf(todayISO(rawDoc()));

// DURATIONS ARE HOURS, both directions (ADR 0014).
//
// The scheduler counts in DAYS, and the page reads `dur` in days through the
// guard (the document has stored whole minutes since v7 — see `mins`). Once a
// plan has working hours, "a day" of work is ambiguous — 24h, or one window? —
// so there is no `d`: `8h`, `1h30m`, `45m`. A bare number is refused rather than
// guessed at, and so is `3d`.
//
// FLOAT DRIFT IS NOT A REASON TO AVOID THIS, measured rather than assumed:
// twenty-four one-hour tasks chained end to end land on 0.9999999999999996, an
// error of 4e-16 against an audit tolerance of 1e-6. Ten orders of magnitude of
// headroom.
const parseDur = (v: string) => {
  const m = String(v).trim().match(/^(?:([0-9]*\.?[0-9]+)\s*h)?\s*(?:([0-9]*\.?[0-9]+)\s*m)?$/i);
  if (!m || (m[1] == null && m[2] == null)) return null;
  const d = (m[1] ? parseFloat(m[1]) / 24 : 0) + (m[2] ? parseFloat(m[2]) / 1440 : 0);
  return isFinite(d) ? d : null;
};

// The inverse, picking the unit a person would have used. Rounded to a minute,
// because the stored value came from `n/24` and printing 1.9999999999999998h
// would make the field look broken on every reopen.
const fmtDur = (d: number) => {
  if (!(d > 0)) return "0";
  const mins = Math.round(d * 1440), h = Math.floor(mins / 60), m = mins % 60;
  return h && m ? `${h}h${m}m` : h ? `${h}h` : `${m}m`;
};

// ---- markdown ---------------------------------------------------------------
// TWO DEPENDENCIES, DELIBERATELY. This was thirty hand-rolled lines and the
// argument for them was real while the requirement was "paragraphs and inline
// code": no sanitiser needed, because escaping every character before writing a
// tag means nothing the user typed can become an element.
//
// The requirement moved. Asked for CommonMark/GFM — tables, fenced blocks,
// nested lists, task lists, reference links — a hand-rolled subset stops being
// a few lines and becomes a bad markdown parser we own. `marked` settled those
// edge cases years ago and `DOMPurify` is what sanitising HTML is FOR; writing
// either badly is worse than importing both. Weight is not the argument either
// way: cytoscape alone is larger than the two of them together.
//
// THE SECURITY PROPERTY MOVED WITH IT. It used to be "nothing can become an
// element". It is now "DOMPurify decides what may be an element", which is a
// weaker guarantee on paper and a far better one in practice, because that
// decision is audited by people who do only that.
marked.use({ gfm: true, breaks: true });

// LINKS OPEN AWAY AND CANNOT REACH BACK. `target=_blank` without
// `rel=noopener` hands the opened page a reference to this one — and this page
// holds the plan's capability token in its fragment. DOMPurify strips `target`
// by default, so it is added back here, with the `rel` that makes it safe,
// rather than by allowing the attribute through unexamined.
DOMPurify.addHook("afterSanitizeAttributes", node => {
  if ("target" in node) {
    (node as Element).setAttribute("target", "_blank");
    (node as Element).setAttribute("rel", "noopener noreferrer");
  }
});

const mdHtml = (src: string) =>
  DOMPurify.sanitize(marked.parse(String(src || ""), { async: false }) as string,
                     { ADD_ATTR: ["target"] });

const msOf = t => t.ms || (doc.milestones[0] || {}).id;

// A milestone is not met until every task assigned to it AND everything those
// tasks wait on is done — a milestone whose own tasks are quick but whose
// predecessors are not has not been met, and reporting only the assigned tasks
// would flatter it.
function milestoneFinish(mid) {
  const own = doc.tasks.filter(t => msOf(t) === mid);
  if (!own.length) return null;
  const all = new Set(own.map(t => t.id));
  for (const t of own) for (const a of ancestorsOf(t.id)) all.add(a as Id);
  return Math.max(...[...all].map(id => {
    const t = taskById(id);
    return t ? endOf(t, st[t.id]) : 0;
  }));
}
// FLOORED: the day a moment is IN. It rounded, which put anything from noon on
// into the next day ("really ran Oct 3 — Oct 2"). Whole days are unchanged. A
// value with a clock that means to show it goes through `fmtAt` / `fmtEndAt`.
const fmt = d => new Date(+d0() + Math.floor(d + 1e-9) * DAY)
  .toLocaleDateString("en-US", { month:"short", day:"numeric", timeZone:"UTC" });
// THE DAY WORK STOPPED, not the boundary after it. A finish is an EXCLUSIVE end,
// so a task worked through Friday finishes at Saturday — which was invisible
// while every day was a working day and reads as nonsense the moment they are
// not: "work ends Jan 23" under a shaded Jan 23 is the chart contradicting its
// own picture, which is the one thing it is built not to do. The last moment of
// work is always inside the preceding day, so that is the day to name.
const fmtEnd = d => fmt(Math.ceil(d - 1e-9) - 1);
// THE INSPECTOR'S "starts … · ends …". The start is FLOORED to its day — `fmt`
// rounds, so a task started at 3pm said it started tomorrow, after its own end.
// And the clock always, because a date alone said nothing about an hour's work —
// "Sep 27 · Sep 28" for something that runs 4:49pm to 8:49am. On one day the
// end drops the date it would only repeat: "Sep 27 3:18pm" · "4:18pm".
const clkOn = (d: number, day: number) => clockStr(Math.round((d - day) * 1440));
const startsEnds = (s: number, e: number) => {
  const sd = Math.floor(s + 1e-9), ed = Math.ceil(e - 1e-9) - 1;
  return { startsText: `${fmt(sd)} ${clkOn(s, sd)}`,
           endsText: sd === ed ? clkOn(e, ed) : `${fmt(ed)} ${clkOn(e, ed)}` };
};
/** A moment, "Sep 27 3:18pm" — floored to its day, never rounded into the next. */
const fmtAt = (d: number) => { const day = Math.floor(d + 1e-9); return `${fmt(day)} ${clkOn(d, day)}`; };
/** An END, "Dec 14 5pm" — named on the day the work stops, like `fmtEnd`, so an
 *  end at midnight is that day's 24:00 rather than the next day's 0:00. */
const fmtEndAt = (d: number) => { const day = Math.ceil(d - 1e-9) - 1; return `${fmt(day)} ${clkOn(d, day)}`; };
// WEEKS WHEN IT IS WEEKS, DAYS WHEN IT IS NOT. Storing days does not mean
// reciting them: "21 d" is a worse answer than "3 wks" to anyone planning a
// quarter, and "3 d" is a better answer than "0.4 wks" to anyone planning a
// week. So the unit follows the number rather than the schema — a whole number
// of weeks reads as weeks, anything else reads as days.
//
// This is also why the change of base unit left most of the chart's language
// alone: a plan whose durations were all whole weeks says exactly what it said
// before, and only the tasks that could not be said in weeks — the reason for
// the change — start speaking days.
//
// TWO UNITS, SO TWO FORMATTERS. A duration is WORKING days and slack to a
// milestone is CALENDAR days, and while every day is a working day those are the
// same number and one function was right for both. They are about to come apart,
// and `durStr(slack)` would then format a calendar quantity in working weeks.
//
// Slack stays calendar deliberately: "nine days before Nov 18" is a fact about
// the DATE, and restating it in working days would answer a question nobody
// asked and understate the wall-clock room. So the unit is a decision at each
// call site rather than an accident of there being only one function.
const weekStr = (d, per) => {
  // BELOW A DAY, SAY SO. Rounding to a tenth of a day turned every sub-day
  // duration into the literal string "0 days": the scheduler had the number and
  // every surface threw it away. The ladder already climbed UP to weeks when the
  // number was weeks; this is the same idea downward. Display only — the base
  // unit is still days, and `d` is still a day-number everywhere else.
  const a = Math.abs(d);
  if (a > 1e-9 && a < 1) {
    const mins = d * 1440;
    if (a < 1 / 24) return `${Math.round(mins)} min`;
    const h = Math.round(mins / 6) / 10;
    return `${h} ${Math.abs(h) === 1 ? "hr" : "hrs"}`;
  }
  const n = Math.round(d * 10) / 10;
  if (n !== 0 && per > 0 && n % per === 0) { const w = n / per; return `${w} ${Math.abs(w) === 1 ? "wk" : "wks"}`; }
  return `${n} ${Math.abs(n) === 1 ? "day" : "days"}`;
};
// The elapsed axis's rungs. Same shape as the duration ladder: minute, quarter
// hour, hour, day, week, month — the intervals a human already thinks in.
// WHICH CLOCK THIS MACHINE KEEPS. Read once, from the platform, rather than
// hardcoded — `resolvedOptions().hour12` follows the OS setting (on a Mac,
// Settings › General › Date & Time › 24-hour time). Chrome reads ICU data at
// process start, so a change needs a browser restart, not a reload.
//
// THE FORMATTING IS STILL ARITHMETIC, deliberately. `toLocaleTimeString` would
// also apply the machine's TIME ZONE, and a day number here is a wall-clock
// label on a day that never passes through `Date` — on a machine in
// America/Chicago it renders an 18:00 tick as "01:00 PM", five hours from the
// data it labels. So the locale decides the FORMAT and nothing decides the
// value.
const HOUR12 = (() => {
  try { return !!new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12; }
  catch { return false; }
})();
// "6pm", not "6:00 PM": an axis tick pays for every character, and the minutes
// are noise on the hour. They come back the moment there are any.
const clockStr = (mins: number) => {
  const h = Math.floor(mins / 60), m = mins % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (!HOUR12) return `${p2(h)}:${p2(m)}`;
  const h12 = h % 12 === 0 ? 12 : h % 12, sfx = h < 12 ? "am" : "pm";
  return m === 0 ? `${h12}${sfx}` : `${h12}:${p2(m)}${sfx}`;
};

// THE HOUR A FRACTION OF A DAY FALLS IN, floored. Two callers: the corner
// readout under the pointer, and the caption on the NOW rule. Floored because
// both name the hour you are IN rather than the one you are nearest — at 13:59
// you are still inside 1pm — and `clockStr` because everything with a clock face
// on this chart has to agree about what 13:00 looks like on a 12-hour machine.
const fmtHour = frac => clockStr(Math.floor(frac * 24) * 60);

const REL_STEPS = [1/1440, 5/1440, 15/1440, 30/1440, 1/24, 2/24, 6/24, 12/24,
                   1, 2, 7, 14, 28, 91, 182, 365];
// THE LABEL HAS TO OUT-RESOLVE THE STEP, which `calStr` does not: it rounds to a
// tenth of a day, so five-minute ticks two days in all read "+2.3 days" — three
// identical labels next to each other, which is worse than none. Below a day of
// spacing the offset is spelled out as days plus a clock, so consecutive rules
// always differ. At a day or coarser the duration ladder is exactly right.
const relLabel = (w, step) => {
  if (Math.abs(w) < 1e-9) return "start";
  const sign = w < 0 ? "\u2212" : "+", a = Math.abs(w);
  if (step >= 1) return sign + calStr(a);
  const d = Math.floor(a + 1e-9), mins = Math.round((a - d) * 1440);
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  return `${sign}${d ? d + "d " : ""}${hh}:${String(mins % 60).padStart(2, "0")}`;
};
// WORK — durations, loads, totals — in hours, never days (ADR 0014): with working
// hours set, a "day" of work would mean one window, and the display would argue
// with the input, which only takes hours.
const durStr = d => {
  const mins = Math.round(d * 1440);
  if (Math.abs(mins) < 60) return `${mins} min`;
  const h = Math.round(mins / 6) / 10;
  return `${h} ${Math.abs(h) === 1 ? "hr" : "hrs"}`;
};
const calStr = d => weekStr(d, 7);           // CALENDAR days — slack, dates, wall clock
// The inverse of dayOf, for putting a day number back into a native date input.
// FLOOR, NOT ROUND. Identical for every whole day, which was every value this
// function had ever seen — but a day number carrying a time of day reaches it
// now, and rounding 0.72 up to 1 would print TOMORROW's date for work done at
// five in the afternoon.
const isoOf = d => new Date(+d0() + Math.floor(d + 1e-9) * DAY).toISOString().slice(0, 10);

// THE SAME NUMBER, SHAPED THE WAY `datetime-local` WANTS IT. It always emits a
// time, even a midnight one, because an <input type="datetime-local"> handed a
// bare date renders EMPTY — it does not fall back to a date picker, it drops the
// value silently, which would read as "this task has no deadline" on every task
// that has one.
const isoTimeOf = d => {
  const mins = Math.min(1439, Math.round((d - Math.floor(d + 1e-9)) * 1440));
  const pad = n => String(n).padStart(2, "0");
  return `${isoOf(d)}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
};

// NOW, rather than the start of today. `todayD()` is midnight, which is the
// right FLOOR for a forecast and the wrong CEILING for "you cannot have started
// this in the future" — because at five in the afternoon every honest timestamp
// recorded today is already greater than midnight today.
// IN THE PLAN'S ZONE, not the browser's (v6): the chart's days are the plan's
// days, so "now" has to be measured on the same clock or the line and the bars
// disagree for anybody looking from elsewhere. Whole minutes, as it always was.
const nowD = () => Math.floor(nowOf(rawDoc()) * 1440 + 1e-6) / 1440;

// ---- rendering ------------------------------------------------------------
// SCROLL IS PRESERVED ACROSS EVERY REBUILD — a backstop, not the fix.
//
// The bug: any click or edit made while scrolled down threw you to the top of
// the page, which makes the tool unusable in the meeting it exists for. The
// ROOT CAUSE was a layout read inside the row loop (see `pos[t.id]` below):
// it forced a flush while the grid was half-rebuilt, the document was briefly
// short, the browser clamped scrollTop, and the clamp survived the rows added
// afterwards. Deferring that read fixes it at source.
//
// This wrapper is kept anyway, and it is not redundant — bisected 2026-08-13,
// each of the two fixes independently makes the regression check pass, so this
// catches any FUTURE mid-render measurement someone adds without noticing. It
// lives here rather than at the call sites because renderInner() has early
// returns. Both axes: #chart is its own horizontal scroller and loses
// scrollLeft the same way.
// THE ONE ERROR THE CHART CANNOT DRAW AROUND. `sched()` throws on a dependency
// cycle, and nothing anywhere else rejects one: `shared/commands.js` and
// `sync-server/src/validate.ts` BOTH say so deliberately, on the grounds that
// "sched() refuses them loudly when the plan is opened". This is that refusal,
// so it is the only cycle handling in the tool and it has to work.
//
// It did not. This wrote to `#verdict` and `#verdictsub`, the big verdict block
// that was replaced by the per-milestone chips — two elements that no longer
// exist. `$` returns null, so the one sentence naming the cause was thrown away,
// and what a human got instead was a blank chart under twenty-six lines of
// `auditSchedule` output saying every task in the plan "starts undefined". The
// scheduler had diagnosed it correctly and the diagnosis went nowhere.
//
// NOT `flash`. A cycle is not an event that scrolls past; the plan cannot be
// scheduled until someone removes an arrow, and until then every date on screen
// is absent rather than wrong. Same persistent panel that boot and selftest()
// use, for the reason stated at boot: something upstream is wrong and the page
// cannot answer the question it was opened to answer.
//
// ONE NODE, REPLACED. render() runs on every keystroke, so appending here would
// stack a panel per character typed.

/** A ONE-SHOT BANNER'S HOST NODE. Made here rather than in `ui/`, because React
 *  owns containers and making one is not rendering — the same division `#cursors`
 *  is on. Reused if it is already there: `render()` runs on every keystroke, so
 *  appending would stack a panel per character typed. */
function bannerHost(id: string, tone: "danger" | "accent") {
  let el = $opt("#" + id) as HTMLElement | null;
  if (!el) {
    el = Object.assign(document.createElement("div"), { id, className: "panel" });
    el.style.cssText = `border-color:var(--${tone});margin:10px;padding:10px`;
    document.body.prepend(el);
  }
  return el;
}

let schedErr = "";
function schedulerDown(msg) {
  schedErr = msg || "";
  if (!msg) { $opt("#schedfail")?.remove(); return; }
  mountSchedulerDown(bannerHost("schedfail", "danger"), msg);
}

// The Rank tab's state — declared ahead of `render()`, which reads it; see "the ranking".
let rankSorter: Sorter | null = null;
let rankSig = "";
let orderTab: "moves" | "rank" | "past" = "moves";

function render() {
  // THE SCROLL RESTORE IS GONE, and this is the observation that removed it.
  //
  // `render()` used to save `window.scrollY` and `#chart.scrollLeft` and put them
  // back by hand, because rebuilding every row shortened the document for an
  // instant, the browser clamped scrollTop, and the clamp survived — "clicking
  // anything jumps me to the top". Reconciling does not shorten the document, so
  // it should have been dead code, but the only evidence was an ELEVEN ROW
  // fixture whose chart barely scrolls (scrollLeft clamped to 15px) — evidence
  // that cannot reach the case the lines were written for.
  //
  // The browser suite now runs the case: 135 rows, zoomed to the narrowest preset
  // so the chart is genuinely wider than its window, scrolled 900px down and
  // 400px across, through a render caused by SOMEBODY ELSE'S command. It holds,
  // with the two lines deleted. That is the check to look at if this ever comes
  // back — not this comment.
  renderInner();
  // AFTER the rebuild, and every time. Peers' cursors are stored in chart
  // coordinates, so a zoom, a fold or a scroll moves where they belong on screen
  // without anybody having moved — the pixels are ours to recompute.
  drawPresence();
  // THE ONE CHOKE POINT. Every path that changes the plan ends here, so hooking
  // render is the only way the Order chip cannot be missed by a new command. It
  // is a debounce and a string compare — the round trip only happens when
  // something the scheduler reads actually moved. See scheduleNudge().
  scheduleNudge();
  // The Rank tab follows the plan the same way: a remote answer, a finished task or a
  // new one re-opens its sorter on the document as it now is.
  if (orderTab === "rank" && !$("#reorder").hidden) rankPanel();
  if (orderTab === "past" && !$("#reorder").hidden) pastPanel();
}

// A RULE AT NOW GOES STALE; A RULE AT MIDNIGHT DID NOT. That is the one cost of
// moving it, and it is worth naming rather than discovering: the line is only
// ever as current as the last render, and a plan sitting open on a second
// monitor renders when somebody edits it and otherwise not at all.
//
// ONLY WHILE THE CHART IS DRAWING TIME. Below an hour a tick is at least 60px
// (MIN_TICK_PX), so a minute is about a pixel and a minute's cadence is the
// right one. At day zoom or coarser a minute is far under a pixel, so there is
// nothing to redraw and this does nothing — which is most of the time, and is
// why this is not a render loop.
//
// NOT IN A HIDDEN TAB either. Chrome throttles the timer there anyway, and the
// page already takes the view that a tab nobody is looking at should stop doing
// things on its own (see the `visibilitychange` that clears your cursor).
//
// `reschedule()` keys on `nowD()`, the forecast floor, so each tick re-dates the
// unstarted work too — one schedule a minute, and only at hour zoom.
setInterval(() => {
  if (doc && TICK_STEP < 1 && !document.hidden) render();
}, 60_000);

// THE SCHEDULE IS NOT A FUNCTION OF THE VIEW, and `renderInner` recomputed it on
// every render anyway — 15.5ms of the ~58ms a zoom step costs on a 124-row plan
// (measured 2026-09-19), spent re-deriving dates that could not have moved,
// because all that changed was pixels-per-day. Zoom, fold, the isolate lens,
// every legend tick and every hover preview land here.
//
// THE KEY IS `orderSig()` PLUS THE TWO THINGS IT DOES NOT LIST. It exists for the
// reorder panel and covers every scheduler input but one — today, which the
// not-before floor is measured from. `dropped` was the other, and was missing
// from `orderSig` itself rather than from this key; see the note in there. It is
// passed `doc` rather than left to default to
// `rawDoc()`, because playback renders a HISTORICAL document and the live one's
// signature would sit still while you stepped through it.
//
// A WRONG KEY IS A SILENTLY WRONG CHART, so the list is what the scheduler READS
// rather than what looks like it ought to matter: `shared/schedule.js` touches
// id, lane, dur, ms, deps, noQueue, notBefore, actualStart, actualEnd, dropped,
// the lanes, the calendar and today. Teach the scheduler a new field and this key
// has to learn it in the same commit.
let schedKey: string | null = null, schedVal: Starts | null = null, schedFail = "";
function reschedule() {
  const key = orderSig(doc) + "|" + nowD(); // the floor is now: a new minute, a new schedule
  if (key !== schedKey) {
    schedKey = key; schedFail = ""; schedVal = null;
    try { schedVal = sched(doc.tasks) as unknown as Starts; } catch (e: any) { schedFail = e.message; }
  }
  // ON A THROW, `st` IS LEFT EXACTLY AS IT WAS FOUND — which is load-bearing, not
  // tidiness. `stripsFrom` empties `st`, renders a cloned version and reads
  // "did everything get a date?" as its cycle test; handing it the last good
  // schedule would answer yes for a plan that never scheduled, because
  // same-lineage versions share task ids.
  if (schedVal) st = schedVal;
  return schedFail;
}
function renderInner() {
  CAL = calOf(doc);
  let err = reschedule();
  const grid = $("#grid"), svg = $("#arrows");
  // `.nomatch` belongs in this list: it is built by render like everything else,
  // so leaving it out meant every empty intermediate state stacked another copy
  // of the message, and they were still sitting there once rows came back.
  // NOTHING TO SWEEP ANY MORE, and the removal of this line is the whole shape of
  // the change. It used to clear `.gl,.gl-lab,.nwd` before rebuilding them by
  // hand; those are React's now and live in `#furniture`, so removing them here
  // throws `NotFoundError: The node to be removed is not a child of this node`
  // the moment the reconciler gets there first — which is exactly what the
  // sentence this replaced warned about `.row` and `.lane-head`, one region late.
  // `.gl-lab` had no producer at all by then; it was being swept and never made.
  mountArrows(svg, []);
  // Clears itself on the way past when there is no error, so removing the
  // offending dependency takes the panel down without anything else having to
  // remember to.
  schedulerDown(err);
  if (err) return;

  const fin = finishOf(doc.tasks, st);

  // ---- ALAP alignment, bound by the TIGHTEST milestone ----------------------
  // This targeted the LAST milestone until 2026-08-13, and that was a real bug:
  // adding a later milestone (an incentive date in January) right-aligned the
  // whole plan to it, pushing every task 6.3 weeks out and straight through the
  // November change-approval line that all of that work was assigned to. The chart
  // showed work finishing a month and a half after its own deadline while
  // cheerfully reporting slack.
  //
  // The right rule: shift as late as possible without blowing ANY milestone, so
  // the binding one is whichever has the least slack. A milestone with no work
  // assigned constrains nothing and is excluded — otherwise adding an empty
  // future milestone would drag the plan, which is how the bug looked.
  const msSlacks = doc.milestones
    .map(m => ({ m, f: milestoneFinish(m.id) }))
    .filter(x => x.f != null)
    .map(x => ({ m: x.m, slack: dayOf(x.m.date) - x.f! }));
  const slack = msSlacks.length ? Math.min(...msSlacks.map(x => x.slack)) : 0;
  BINDING = msSlacks.length
    ? msSlacks.reduce((a, b) => (b.slack < a.slack ? b : a)).m.id : null;
  const DLW = Math.max(fin, ...doc.milestones.map(m => dayOf(m.date)));
  // The alignment rule, same as render.py: if it fits, right-align to the
  // deadline so the bars show the LATEST responsible start; if it does not,
  // left-align from today and let the overrun run past the deadline line.
  // A TRANSLATION IS ONLY FREE WHEN EVERY DAY IS ALIKE.
  //
  // The shift slides the whole picture right without rescheduling it, which is
  // sound while any two days are interchangeable. They stop being: a task's span
  // depends on which weekday it STARTS on — three working days from Monday is
  // three calendar days and the same three from Friday is five — so sliding by
  // an arbitrary number of days would draw bars at widths their positions no
  // longer justify, and could land a start on a Saturday the scheduler just
  // refused.
  //
  // A multiple of SEVEN moves every task to the same weekday it already had, so
  // every span is identical and no start moves onto a non-working day. The cost
  // is up to six days of alignment precision, given up in the safe direction:
  // the chart shows work starting slightly earlier than it strictly had to.
  //
  // And this is the one branch the working week could not be expressed without.
  // With no non-working days there is nothing to preserve, and quantising there
  // would re-align every plan written before this by up to six days for no
  // reason at all. The milestone chips keep reporting the TRUE slack — that is
  // the fact, and the alignment is only a drawing choice.
  //
  // WHAT THIS SCALAR MEANS SINCE ACTUALS: it is the shift available to the
  // UNSTARTED tail. Every read of it goes through `shiftOf`, which hands a
  // pinned task 0 — the drawing choice only exists where there is a choice.
  const quantum = CAL.allOn ? 1 : 7;
  SHIFT = Math.max(0, Math.floor(slack / quantum + 1e-9) * quantum);
  // ---- horizontal extent -----------------------------------------------
  // LO is the chart's left edge in weeks and is usually 0, but not always: move
  // the start date later than today and todayD() goes NEGATIVE, which used to
  // place the TODAY line at a negative offset — i.e. inside the row-label
  // gutter, on top of the labels. The origin is now whatever the chart has to
  // show, so everything slides right instead of colliding.
  // SPRINT LENGTH STAYS IN WEEKS in the document, because that is what a sprint
  // IS — nobody says "a 14 day sprint". It converts to the day coordinate here,
  // at the one boundary that needs it, rather than being stored in the base unit
  // and translated back for every person who reads it.
  // SPRINTS ARE OPTIONAL. A plan with no `sprint` is not on a cadence, and drawing
  // one at a silent 3-week default invented a rhythm nobody declared. Absent now
  // means absent: no rules, no S-numbers, and no pull on the chart's origin.
  const hasSprint = !!(doc.sprint && doc.sprint.weeks);
  const sprintDays = 7 * Math.max(0.25, (doc.sprint?.weeks) || 3);
  const sprint0 = dayOf((doc.sprint?.start) || doc.start);
  const msW = doc.milestones.map(m => dayOf(m.date));
  // Snapped OUT to whole months at both ends. Purely presentational — it changes
  // no dates and no arithmetic — but a chart that begins mid-August and stops
  // three days into January reads as though the plan were cropped. Rounding down
  // to the 1st of the first month and up to the 1st of the month after the last
  // means every month on screen is a whole month, and the month rules become
  // real boundaries rather than wherever the data happened to start.
  const dayOfDate = t_ => (t_ - +d0()) / DAY;
  const asDate = d => new Date(+d0() + Math.floor(d + 1e-9) * DAY); // the day it is IN
  const floorMonth = w => { const d = asDate(w);
    return dayOfDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };
  const ceilMonth  = w => { const d = asDate(w);
    return dayOfDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); };
  // AND AN ACTUAL START CAN BE NEGATIVE, which nothing else here can be. Every
  // start `sched()` computes is at or after day 0 by construction, so until work
  // could be recorded as having already happened there was no way for a bar to
  // want the left of the origin. Work that really began before the plan's start
  // date renders behind the row-label gutter unless the origin makes room for
  // it — which is the same collision `todayD()` going negative already caused.
  // A MONTH BUFFER IS A CALENDAR AFFORDANCE. It exists so month rules land on
  // real boundaries; with no month rules it is just empty space before the work.
  const originOf = [0, ...msW, ...doc.tasks.map(t => t.actualStart ?? 0)];
  if (!isRel()) originOf.push(todayD());
  if (hasSprint && !isRel()) originOf.push(sprint0);
  const rawLO = Math.min(...originOf);
  LO = isRel() ? rawLO : floorMonth(rawLO);
  // `fin + shift` was right while every bar moved by the same amount. It is now
  // an over-estimate whenever the plan's LAST work is pinned — the chart would
  // reserve a month of empty calendar for a slide that bar is not taking.
  //
  // Spelled out as left-plus-width rather than as `endOf(t, shifted)`, because
  // that is what the bars below are: the width comes from the UNSHIFTED span, so
  // asking the calendar again from the shifted start would answer a different
  // question the moment a holiday sits between the two. With no actuals anywhere
  // this is `fin + SHIFT` exactly, which is what makes the change a no-op.
  const finShown = Math.max(...doc.tasks.map(t => st[t.id] + shiftOf(t) + spanOf(t, st[t.id])));
  const span = isRel() ? Math.max(finShown, ...msW)
                       : ceilMonth(Math.max(finShown, todayD(), ...msW));
  // Isolate only bites when something is actually filtered; with no filter set
  // the two modes render identically, so flipping the toggle on an unfiltered
  // chart does nothing visible — which is correct, and stops the control looking
  // broken when someone tries it before choosing anything.
  // Asked through the hoisted helpers, so the graph lens cannot come to a
  // different opinion about what "filtered" or "this chain" means. Two views
  // disagreeing about that is the same shape of bug as the five ✎ buttons that
  // read as the code having been written twice.
  const filtering = isFiltering();
  const matches = matchesFilter;
  const chain = chainMembers();
  // ONE LENS, TWO FILTERS. `isolate` used to govern the legend only, and
  // chain focus always removed rows whatever it said — so the same tick-box meant
  // "dim" for one question and nothing at all for the other. Both now read it:
  // dim greys what is not in the chain, isolate drops it, exactly as for a legend
  // pick. The chain is still a different QUESTION from the legend (a relationship
  // between tasks, not an attribute of one); it is no longer a different LENS.
  const isolating = focusMode === "isolate" && (filtering || !!chain);
  const inFilter = t => (!chain || chain.has(t.id)) && (!filtering || matches(t));
  const visible = t => focusMode !== "isolate" || inFilter(t);

  LABW = labelColumnWidth();
  // One measurement, of the SCROLLER rather than its contents — #chart's width
  // comes from its parent, so this is stable no matter what state the grid is in
  // mid-rebuild. Bars keep their existing 8px minimum, so zooming out far enough
  // to make a day sub-pixel still leaves something to click.
  const avail = Math.max(120, $("#chart").clientWidth - LABW - 8);
  // A DAY WAS THE FLOOR IN THREE PLACES and a minute-scale plan hit all of them:
  // the chart could not be asked to show less than one day, so a 30-minute step
  // was permanently sub-pixel no matter how far you zoomed. The atom is what it
  // always was; the viewport is simply allowed to be smaller than one now.
  SPAN_DAYS = Math.max(1 / 1440, span - LO);
  VIEW = Math.max(1 / 1440, zoomDays || SPAN_DAYS);
  PPD = avail / VIEW;
  const X = w => LABW + (w - LO) * PPD;

  milestoneBar();

  grid.style.width = X(span) + "px";
  grid.style.setProperty("--labw", LABW + "px");
  // STATE THE WIDTH, DO NOT LET IT BE INFERRED. #grid had no width of its own, so
  // the scroller's extent came from whatever its absolutely-positioned children
  // happened to overflow by — and that region did not shrink back when the scale
  // did. Zoom in to two weeks, zoom out to the whole plan, and the chart still
  // scrolled 18000px into blank space it no longer had anything to draw in.
  //
  // The width is not a mystery: it is the gutter plus the span at the current
  // scale, both of which are right here. Saying it outright also makes the
  // scrollbar honest at every zoom level for free.
  grid.style.width = (LABW + (span - LO) * PPD) + "px";

  // ---- the axis ----------------------------------------------------------
  // A REAL BLOCK ELEMENT AT THE TOP OF THE FLOW, not labels pinned above the
  // grid with a negative `top`. The first version did the latter and they were
  // invisible: `#chart` sets `overflow-x:auto`, and per spec a non-visible value
  // on one axis computes the other to `auto` too — so `overflow-y` was silently
  // scrollable and clipped everything above y=0. Nothing errored, nothing failed
  // the layout audit; the labels simply were not there. Keep the axis in flow.
  // COLLECTED, THEN HANDED OVER. Every number below is a pixel this function
  // computed from `X()`, `LO`, `PPD` and `LABW` — the components take none of
  // them, so nothing drawn here can disagree with the bars it sits behind.
  const labels: AxisLabel[] = [];
  const at = (x: number, y: number, cls: string, text: string, color?: string) => {
    labels.push({ key: `${cls}:${labels.length}`, left: x, top: y, cls, text, color });
  };
  const bands: Band[] = [];
  const rules: Rule[] = [];
  const rule_ = (left: number, cls: string, color?: string) =>
    rules.push({ key: `${cls}:${rules.length}`, left, cls, color });
  // NON-WORKING DAYS, and only when the plan has any — a calendar week draws
  // nothing and stays pixel-identical to every chart made before this existed.
  // Appended before the rules and the rows so it paints underneath all of them.
  //
  // One band per RUN of non-working days rather than one per day: a weekend is
  // one shape because it reads as one gap, and a holiday touching a weekend is
  // one longer gap, which is exactly what it feels like to the people in it.
  //
  // WORKING HOURS (ADR 0014, 0021) shade the rest of each working day the same way, at
  // every zoom, and merge with the days off around them: Friday 17:00 to Monday
  // 08:00 is one band, because it is one stretch nobody is working. A gap between
  // two windows of a day is a band of its own. With no hours there is nothing to shade.
  {
    let a = NaN, b = NaN;
    const off = (x: number, y: number) => {
      if (Math.abs(x - b) < 1e-9) { b = y; return; }
      if (b > a) bands.push({ left: X(a), width: (b - a) * PPD });
      a = x; b = y;
    };
    for (let d = Math.floor(LO); d < span; d++) {
      let pos = d;
      for (const [wa, wb] of CAL.win(d)) { if (wa > pos - d) off(pos, d + wa); pos = d + wb; }
      if (pos < d + 1) off(pos, d + 1);
    }
    off(NaN, NaN);
  }

  // Months, walked as calendar months rather than every-4.3-weeks so the labels
  // land on the 1st and match a calendar someone holds up in the meeting.
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const s0 = d0();
  const rule = (w, lab, cls = "mon") => { at(X(w), 22, cls, lab); rule_(X(w), cls); };
  if (isRel()) {
    // TICK SPACING COMES FROM THE VIEW, not the data — the same ladder `durStr`
    // walks. Zoomed to an hour you get minutes; zoomed to the plan you get weeks.
    // Aim for at most a dozen rules: more than that and they are texture.
    const step = REL_STEPS.find(x => (VIEW / x) <= 12) ?? REL_STEPS[REL_STEPS.length - 1];
    TICK_STEP = step;
    for (let k = Math.ceil(LO / step - 1e-9); ; k++) {
      const w = k * step;
      if (w > span + 1e-9) break;
      rule(w, relLabel(w, step));
    }
  } else {
    // MONTHS ARE ALWAYS DRAWN, whatever the zoom, and they are the MAJOR rule.
    // They are few, they are what you navigate by, and losing them when you zoom
    // in is how a chart stops telling you where you are.
    const months: number[] = [];
    const edge = asDate(LO);                                      // the left edge, on a month boundary
    rule(LO, MON[edge.getUTCMonth()]); months.push(LO);
    for (let y = edge.getUTCFullYear(), m = edge.getUTCMonth() + 1; ; m++) {
      if (m > 11) { m = 0; y++; }
      const w = dayOfDate(Date.UTC(y, m, 1));
      if (w > span) break;
      rule(w, MON[m]); months.push(w);
    }

    // AND A FINER RULE UNDERNEATH, chosen by the same question the relative
    // ladder asks: what is the finest spacing that keeps the count near a dozen.
    // Two things make this ladder different from that one, and neither is
    // cosmetic. A MONTH IS NOT A LENGTH — 28 to 31 days — which is why months are
    // walked above rather than stepped here. And A WEEK HAS TO LAND ON A MONDAY,
    // not on every seventh day from `doc.start`, or the lines fall mid-week and
    // mean nothing to anybody.
    // AN HOUR IS THE FLOOR, and it is a judgement rather than a limit. The
    // windowing made minutes affordable — the ladder ran to 1min at ~11 nodes —
    // and they were not worth having: a plan whose smallest unit of work is
    // fifteen minutes does not need a chart that can point at 7:30, and the ticks
    // just crowd the hour you were actually reading.
    //
    // Below an hour the finest rung simply keeps applying, so zooming further
    // spreads the hourly ticks apart instead of subdividing them. Put the sub-hour
    // steps back in this array and the rest of the ladder needs no changes.
    const CAL_STEPS = [1 / 24, 2 / 24, 3 / 24, 6 / 24, 12 / 24, 1, 7];
    // PIXELS, NOT A COUNT. This asked "are there at most a dozen of these",
    // which is the wrong question twice over: a dozen rules is crowded on a
    // narrow window and sparse on a wide one, and the number that decides
    // whether a label is readable is how far apart they are, not how many there
    // are. So the ladder now picks the finest step whose spacing clears a label
    // width — which is the same thing as "as many as can actually fit".
    //
    // 60px because the widest label this draws is a date like "Sep 21" at ~44px,
    // and two of them touching is unreadable before it is crowded.
    const MIN_TICK_PX = 60;
    let step = CAL_STEPS.find(x => x * PPD >= MIN_TICK_PX);

    // ONLY WHERE YOU ARE LOOKING, PLUS ROOM TO SCROLL INTO. Ticks used to be
    // built across the whole grid, which is why the ladder could never reach an
    // hour: an hourly tick over a sixty-day plan is 1,440 nodes, a minute one is
    // 86,000, and the cost is ~0.2ms each on every render.
    //
    // Almost all of them were off screen. The window is what the scroller shows
    // plus two screenfuls either side — enough that ordinary scrolling never
    // outruns it — and a scroll that travels further rebuilds when it settles.
    const el = $opt("#chart");
    const seen = el && el.clientWidth ? el.clientWidth / PPD : VIEW;
    const at0 = el ? LO + (el.scrollLeft - LABW) / PPD : LO;
    const winLo = Math.max(LO, at0 - seen * 2);
    const winHi = Math.min(span, at0 + seen * 3);
    // THE LOOP COVERS THE WHOLE GRID, NOT THE WINDOW — rules are drawn once per
    // render and scrolling does not redraw, so every rule the scroller can reach
    // has to exist now. At a one-minute spacing over a sixty-day plan that is
    // eighty-six thousand of them.
    //
    // A BACKSTOP, NOT THE MECHANISM ANY MORE. The window is what keeps the count
    // down; this only catches the case where even five screenfuls is a lot — a
    // very wide monitor at a very fine step. Measured cost, for whoever moves it:
    // an ~80ms floor from the rows plus roughly 0.2ms a node, so 400 is invisible,
    // 1,089 is 194ms and 8,733 is 1.8 seconds.
    if (step != null)
      while (step != null && (winHi - winLo) / step > 400)
        step = CAL_STEPS[CAL_STEPS.indexOf(step) + 1];
    // AFTER the backstop, not before: that loop is what actually decides how
    // fine the drawn rules are, and a readout keyed to the step this WANTED
    // would offer an hour on a chart showing days. `undefined` is "nothing fit
    // at all", which is the coarsest case there is.
    TICK_STEP = step ?? 7;

    if (step != null) {
      // THE PLAN'S `weekStart`, Sunday when unset — the same answer the calendar's
      // week gives, so a week rule and a calendar week never disagree.
      const dow = asDate(0).getUTCDay();                 // 0 Sun .. 6 Sat
      const wk0 = ((doc.weekStart ?? 0) - dow + 7) % 7;   // first week-start day on or after day 0
      const base = step === 7 ? wk0 : 0;              // week starts, or midnights
      const pad = (n: number) => String(n).padStart(2, "0");
      // WHERE THE WEEK TURNS OVER, at any step finer than a week. A run of days
      // is a wall of identical marks without it; the eye needs somewhere to
      // count from, which is the same job the month rule does one level up.
      const weekStart = (w: number) =>
        step! < 7 && Math.abs(((w - wk0) % 7 + 7) % 7) < 1e-9;
      const label = w => {
        const mins = Math.round((w - Math.floor(w + 1e-9)) * 1440);
        // THE LABEL HAS TO OUT-RESOLVE THE STEP, the same rule `relLabel` states.
        // At six-hour spacing four rules in a row read 00:00 06:00 12:00 18:00
        // and then repeat the next day; giving the midnight one the date instead
        // means consecutive rules always differ.
        if (step! < 1 && mins !== 0)
          // 24-HOUR, AND HARDCODED — not read from the machine, and deliberately
          // not formatted through `toLocaleTimeString`. Two reasons, and the
          // second is the load-bearing one:
          //
          //   * On an axis it is two characters shorter than "6:00 PM", cannot be
          //     misread at a glance, and sorts the way it reads.
          //   * A day number here is a WALL-CLOCK LABEL ON A DAY — `dayOf` adds
          //     the time as a fraction and never puts it through `Date`, so the
          //     plan does not shift when it is opened in another zone. Formatting
          //     through the locale would reintroduce exactly that: on a machine in
          //     America/Chicago, `toLocaleTimeString` renders this tick's 18:00 as
          //     "01:00 PM", and the axis would disagree with the data by five
          //     hours. Detection is one line and is not the hard part.
          return clockStr(mins);
        // ONLY THE WEEK START CARRIES THE MONTH — at every step, not just at a
        // day. It used to be day-steps only, which made zooming IN add context
        // rather than refine it: "5" became "Oct 5" the moment half-day ticks
        // appeared beside it. A midnight tick now names its day, and says which
        // month only where the month is in question.
        return step! >= 7 || weekStart(w)
          ? fmt(w)
          : String(asDate(w).getUTCDate());
      };
      for (let k = Math.ceil((winLo - base) / step - 1e-9); ; k++) {
        const w = base + k * step;
        if (w > winHi + 1e-9) break;
        // A minor rule sitting on a month boundary would draw the month twice, in
        // two weights, a pixel apart.
        if (w >= LO && !months.some(m => Math.abs(m - w) < 1e-9))
          rule(w, label(w), weekStart(w) ? "wk" : "sub");
      }
    }
  }
  // Sprint cadence and origin are both data. Walk back from the declared sprint
  // start so a sprint boundary lands correctly even when the chart begins before
  // it, and number the sprints from that origin rather than from the left edge.
  const firstK = Math.floor((LO - sprint0) / sprintDays);
  for (let k = firstK; hasSprint && !isRel(); k++) {
    const w = sprint0 + k * sprintDays;
    if (w > span) break;
    if (w >= LO) {
      rule_(X(w), "spr");
      at(X(w) + 5, 40, "spr", "S" + (k + 1));
    }
  }
  // TODAY, then one line per milestone. Milestone lines are drawn from the data,
  // so adding a milestone adds a line with no further wiring.
  // NOW, NOT MIDNIGHT. This was `todayD()`, which is a date with no time, so the
  // rule stood at 00:00 of the current day — up to twenty-four hours left of
  // where you are actually standing, and at any zoom drawing hours that is the
  // whole reason nothing in progress lined up with it. `nowD()` is the same
  // number plus the wall clock, and its own comment already drew this
  // distinction: midnight is the right FLOOR for a forecast and the wrong
  // CEILING for where you are.
  //
  // The scheduler's floor is `nowD()` too since 2026-09-27 (FORECASTS START NOW
  // in shared/schedule.ts). `todayD()` stays midnight for what is about the DAY:
  // the TODAY band, "today" labels, the Done window.
  //
  // The caption carries the time only where the chart is drawing time, on the
  // same `TICK_STEP` test the corner readout uses — a screenshot zoomed to
  // months does not want an hour on it, and one zoomed to hours is unreadable
  // without it.
  const now = nowD();
  const flags = isRel() ? []
    : [[now, "today",
        `NOW ${fmt(Math.floor(now))}${TICK_STEP < 1 ? " · " + fmtHour(now - Math.floor(now)) : ""}`,
        "var(--good)", false]];
  for (const m of doc.milestones) {
    const w = dayOf(m.date), f = milestoneFinish(m.id);
    const cls = f == null ? "empty" : (w - f > 1e-9 ? "ok" : w - f < -1e-9 ? "late" : "tight");
    flags.push([w, "deadline ms-" + cls,
                `${m.label.toUpperCase()} ${isRel() ? "+" + calStr(w) : fmt(w)}`,
                cls === "late" ? "var(--danger)" : cls === "tight" ? "var(--warn)" : "var(--good)", true]);
  }
  for (const [w, cls, lab, col, right] of flags) {
    rule_(X(w), String(cls), col ? String(col) : undefined);
    // Milestone labels are right-aligned so a line near the end of the chart
    // cannot push its own label off the edge.
    labels.push({ key: `flag:${labels.length}`, left: X(w) + (right ? -5 : 5), top: 2,
                  cls: "flag", text: String(lab), color: String(col), right: !!right });
  }
  mountAxis($("#axis"), labels);
  mountFurniture($("#furniture"), { bands, rules });

  POS = {};
  // ONE GROUP PER TEAM, OR ONE GROUP FULL STOP. Date mode is a single unheaded
  // group holding every visible task in `dateRowOrder`.
  //
  // THE ROWS ARE REACT'S NOW (ui/Grid.tsx) and everything above still is not: the
  // gridlines, the non-working bands and the milestone flags are `position:
  // absolute` against `#grid`, so they span it whatever the rows do, and the axis
  // is in flow above them. What React owns is `#rows`, and the clear at the top of
  // this function no longer sweeps `.row`/`.lane-head` because it would be
  // deleting nodes the reconciler is still holding.
  const laneVMs: GridLane[] = [];
  for (const lane of (ROWMODE === "date" ? [null] : doc.lanes)) {
    // In isolate mode the filtered-out rows are never built, and `continue` on an
    // empty lane removes the team's header too — so you do not get a heading
    // announcing a team with nothing under it.
    // `shown` is `visible` plus the done gate. They are separate questions: the
    // isolate lens is about what you FILTERED to, this is about whether finished
    // work is worth drawing at all — so it applies in dim mode too, where
    // `visible` is always true and every row gets built.
    const shown = t => visible(t) && drawn(t);
    const rows = lane ? doc.tasks.filter(t => t.lane === lane.id && shown(t))
                      : dateRowOrder(doc.tasks.filter(t => shown(t)), st);
    if (!rows.length) continue;
    // FOLDING IS A STATEMENT ABOUT A TEAM, so date mode has nothing to key it off
    // and no header to click. The Map is left as it is rather than cleared —
    // flipping back to Team mode should find your folds where you left them.
    const mode = lane && COLLAPSED.get(lane.id), folded = !!mode;
    // HOW MANY TRACKS THE WORK ACTUALLY NEEDS, which is not the lane's capacity: a
    // cap-3 team that never ran three at once needs two, and the fold should show
    // what happened rather than reserve space for a claim nobody made. Computed
    // even when expanded, because it decides how many fold states this lane HAS.
    const track: Record<Id, number> = {}; const ends: number[] = [];
    for (const t of [...rows].sort((x_, y_) => st[x_.id] - st[y_.id])) {
      let k = ends.findIndex(e => e <= st[t.id] + 1e-9);
      if (k < 0) { k = ends.push(0) - 1; }
      ends[k] = endOf(t, st[t.id]);
      track[t.id] = k;
    }
    const tracks = Math.max(1, ends.length);
    // "1" squeezes every track into one row; "t" gives each its own full-height
    // one. They coincide at a single track, so a serial lane never reaches the
    // squeezed state.
    const flat = mode === "1" || tracks === 1;

    let head: GridLane["head"] = null;
    // ONE LANE IS NOT A GROUPING. The head exists to say which of several
    // groups a run of rows belongs to; with a single lane it repeats the same
    // word above every task and spends a row doing it. That is the normal shape
    // of a personal plan — one lane, capacity one, meaning "me" — and the
    // fold control goes with it, because there is nothing to fold away to.
    //
    // `doc.lanes.length`, not "how many lanes have work in them": a second,
    // empty lane is one the plan still means to use, and hiding the heads until
    // something lands in it would make the chart reshuffle on the first task.
    if (lane && (doc.lanes || []).length > 1) {
      // THREE STATES WHERE THERE ARE THREE PICTURES, TWO WHERE THERE ARE TWO.
      // Expanded -> one row per track -> one row flat -> expanded. A lane whose
      // work never overlaps has nothing between the last two, so it cycles back.
      const next = !mode ? (tracks > 1 ? "t" : "1") : mode === "t" ? "1" : undefined;
      const nextLabel = next === "t" ? `Fold into ${tracks} rows`
        : next === "1" ? (tracks > 1 ? "Squeeze into one row" : "Fold into one row")
        : "Unfold — every task on its own row";
      head = {
        laneId: lane.id, width: LABW, next,
        text: (!mode ? "▾ " : mode === "t" ? "▸ " : "▪ ") + laneHeadText(lane),
        title: nextLabel + "\n" + laneHeadTitle(lane),
      };
    }

    // ---- one bar --------------------------------------------------------
    const barOf = (t): GridBar => {
      const fd = fillDef(t.fill);
      const pat = "pat-" + (fd.pattern || "solid");
      const cols = colorsOf(t);
      const barW = Math.max(spanOf(t, st[t.id]) * PPD, 8);
      const sname = shapeOf(t), pointed = POINTED.has(sname as any);
      const base = baseOf(t);
      const est = (() => {
        if (t.actualStart == null || t.actualEnd == null) return null;
        const estEnd = endOf({ ...t, actualStart: null, actualEnd: null } as any, t.actualStart);
        const at = (estEnd - t.actualStart) * PPD;
        const over = estEnd < t.actualEnd - 1e-9, early = estEnd > t.actualEnd + 1e-9;
        return {
          // A WHISKER WHEN IT LANDS OUTSIDE. Finishing early puts the tick past
          // the bar's right edge, where a lone mark in whitespace is attached to
          // nothing; the leader is the range-bar idiom and needs no legend.
          lead: early ? { left: barW, width: Math.max(at - barW, 0) } : null,
          tick: {
            cls: "esttick" + (over ? " over" : early ? " early" : ""), left: at,
            title: over ? `Estimated to end ${fmtEndAt(estEnd)} — ran ${calStr(t.actualEnd - estEnd)} over`
              : early ? `Estimated to end ${fmtEndAt(estEnd)} — finished ${calStr(estEnd - t.actualEnd)} early`
              : `Finished exactly on the estimate`,
          },
        };
      })();
      // THE DEADLINE, ON THE BAR. `due` was real data reachable three ways — the
      // inspector field, the slack readout beside it, and the DEADLINE chips —
      // and drawn nowhere, so the one view that answers WHEN could not show it.
      //
      // Same shape as the estimate tick directly above, deliberately: a thin rule
      // on the bar rather than a new channel, and a dashed leader when it lands
      // off the end, because a lone mark in whitespace is attached to nothing.
      // Same guard as `dueOf` and `dueSlack` too — finished or abandoned work has
      // no deadline any more, and a marker on it would be a count of history.
      const dueMark = (() => {
        if (t.due == null || t.actualEnd != null) return null;
        const at = (t.due - (st[t.id] + shiftOf(t))) * PPD;
        const over = endOf(t, st[t.id], CAL) - t.due;
        const late = over > 1e-9;
        return {
          lead: at > barW ? { left: barW, width: at - barW, late } : null,
          tick: { cls: "duetick" + (late ? " late" : ""), left: at,
                  title: late ? `Due ${fmtAt(t.due)} — misses by ${calStr(over)}`
                              : `Due ${fmtAt(t.due)} — ${calStr(-over) || "0 days"} to spare` },
        };
      })();
      // WORK STOPS WHEN THE WORKING HOURS STOP, and resumes on the other side. `spanOf` spends a forecast only
      // inside the window, so the bar that covers it is the calendar span, night included; the FORECAST part
      // (unfinished work, from now on) is drawn without the nights and weekends. What already happened is
      // wall clock and is never cut. A task that has been worked on draws what was worked instead of one bar:
      // a segment per session (gaps are the time it sat), then the forecast as work chunks, `fc`, the same
      // solid look: hatching is the fill channel and means something else. The bar itself stays, faint, as the
      // click target and the overall span.
      const barLeft = X(st[t.id] + shiftOf(t)), sessions = t.sessions || [];
      const segs = (() => {
        const now = nowD(), a0 = st[t.id] + shiftOf(t), b0 = a0 + spanOf(t, st[t.id]);
        const f0 = t.actualEnd == null ? Math.max(a0, now) : b0;        // where the forecast part begins
        const out: { cls: string; left: number; width: number }[] = [];
        const put = (cls: string, a: number, b: number) =>
          out.push({ cls, left: X(a) - barLeft, width: Math.max(X(b) - X(a), 2) });
        if (sessions.length) {
          for (const x of sessions) put("wseg" + (x.stop == null ? " run" : ""), dayNum(x.start), x.stop == null ? now : dayNum(x.stop));
          if (f0 < b0) for (const [a, b] of workChunks(f0, b0, CAL, t.id)) put("wseg fc", a, b);
        } else if (f0 < b0) for (const [a, b] of offHours(f0, b0, CAL, t.id)) put("wgap", a, b);
        return out;
      })();
      return {
        id: t.id,
        cls: "bar" + (sel === t.id ? " sel" : "") + (t.notBefore != null ? " pin" : "")
             + (chainFocus === t.id ? " eyed" : "") + (sessions.length ? " hasw" : ""),
        left: barLeft,
        width: barW,
        segs,
        ...(folded && flat && tracks > 1
            ? { height: 18 / tracks, top: 4 + track[t.id] * (18 / tracks) } : {}),
        label: t.label || t.id,
        colorsAttr: cols.join(" "),
        // `border:none` on the rim layer explicitly: `.shape` carries a faint 1px
        // border by default, and with border-box sizing that pushed the core's
        // 2px inset to 3px of visible rim — a hairline of the wrong colour under
        // the rim it was supposed to be replaced by.
        shapeCls: "shape sh-" + sname + (pointed ? " rim-" + borderStyleOf(t) : " fillbody " + pat),
        shapeStyle: pointed ? { border: "none" } : cssObj(borderCss(t.border)),
        coreCls: pointed ? "core fillbody sh-" + sname + " " + pat : null,
        bodyColor: String(colorOf(cols[0])),
        // Band 0 is the bar's own background; each extra colour covers its slice
        // of the interior. They carry the SAME pattern class, so hatch and
        // underline read across the whole bar rather than stopping at a boundary.
        bands: cols.slice(1).map((c, k) => ({
          cls: "band " + pat,
          left: ((k + 1) / cols.length * 100) + "%",
          right: ((cols.length - 1 - (k + 1)) / cols.length * 100) + "%",
          color: String(colorOf(c)),
        })),
        estLead: est?.lead ?? null,
        estTick: est?.tick ?? null,
        dueLead: dueMark?.lead ?? null,
        dueTick: dueMark?.tick ?? null,
        grip: barW >= GRIP_MIN_BAR,
        // WHICH TASK THE CHAIN IS AROUND. Without this the eye button changes the
        // whole chart and says nothing about what it was pointed at.
        eye: chainFocus === t.id && barW >= EYE_MIN_BAR,
        title: `${t.label || t.id}\n${durStr(t.dur)} · starts ${fmtAt(st[t.id] + shiftOf(t))}`
          + (t.notBefore != null ? `\ncannot start before ${fmtAt(t.notBefore)}` : "")
          // calStr, not durStr: elapsed and observed are WALL CLOCK, and `dur` on
          // the line above is WORK. Getting that backwards is easy and silent.
          + (t.actualStart == null ? ""
             : t.actualEnd != null
               ? `\nreally ran ${fmtAt(t.actualStart)} — ${fmtEndAt(t.actualEnd)} · ${calStr(t.actualEnd - t.actualStart)}`
               : `\nstarted ${fmtAt(t.actualStart)} · ${calStr(nowD() - t.actualStart)} elapsed`)
          + (base ? `\nplan of record ${fmt(base.a)} — ${fmtEnd(base.b)} · ${varianceStr(t, base)}` : "")
          + `\n${cols.map(c => (colorDef(c) || {} as any).label || c).join(" + ") || "no system"}`
          + ` · ${t.border || "no border"} · ${fd.label || "—"}`
          + (t.desc ? `\n${t.desc}` : "")
          + (t.ref ? `\n${t.ref}` : "") + (linkOf(t) ? `\n${linkOf(t)}` : ""),
      };
    };

    // ---- the strip, and only where there is room to draw it -------------
    // ONE STRIP, ONE MEANING PER CHART: with a comparison on, the strip is where
    // that version put this bar; with none it is elapsed. Elapsed loses on
    // purpose — it is already readable as the gap between the bar's left edge and
    // the TODAY line, where an older version's position is readable from nowhere.
    //
    // NOT IN THE SQUEEZED FOLD, which divides the bar height between tracks so
    // the 4px underneath is not there any more.
    const room = !(folded && flat && tracks > 1);
    const stripOf = (t) => {
      const base = baseOf(t);
      const inProgress = t.actualStart != null && t.actualEnd == null;
      if (!room || !(base || inProgress)) return null;
      const [a_, b_] = base ? [base.a, base.b] : [t.actualStart, nowD()]; // elapsed runs to NOW
      return { cls: base ? "baseline" : "elapsed",
               left: X(a_), width: Math.max((b_ - a_) * PPD, 2) };
    };

    const labelOf = (t): GridRow["label"] => ({
      // Struck through when both dates are in: status is DERIVED, so this reads
      // off the same two fields the scheduler does and cannot disagree with them.
      done: t.actualStart != null && t.actualEnd != null,
      // READ OFF THE SAME `sel` THE BAR READS, one line above its own use in
      // `barOf`. The name and the bar cannot disagree about which task is
      // selected, because there is nothing for them to disagree with.
      sel: sel === t.id,
      // The tooltip carries the WHOLE thing, untruncated — the ellipsis is the
      // intended failure only because this is one hover away. The ref is named
      // even when it does not resolve: that is the state where a human most needs
      // to see it, because it is the one where they look it up by hand.
      title: rowLabelText(t) + (t.desc ? "\n" + t.desc : "")
             + (t.ref ? "\n" + t.ref : "") + (linkOf(t) ? "\n" + linkOf(t) : ""),
      parts: rowLabelParts(t).map((part: any): LabelPart => ({
        text: part.text, title: !!part.title, tip: part.tip,
      })),
      link: linkOf(t) || null,
    });

    const vmRows: GridRow[] = [];
    if (folded) {
      // ONE row reused by every bar in the lane, rather than one row each — the
      // lane head IS the label, so no per-task name.
      for (let k = 0; k < (flat ? 1 : tracks); k++) {
        const mine = rows.filter(t => flat || track[t.id] === k);
        if (!mine.length && !flat) { vmRows.push({ key: `${lane!.id}:t${k}`, cls: "row",
          taskId: "", taskIds: [], label: null, bars: [], strips: [] }); continue; }
        vmRows.push({
          key: `${lane!.id}:t${k}`,
          cls: "row" + (flat && tracks > 1 ? " thin" : ""),
          // `data-task` is the LAST task on the row, which is what the imperative
          // version left behind by assigning it once per task. Kept, not fixed.
          taskId: mine.length ? mine[mine.length - 1]!.id : "",
          taskIds: mine.map(t => t.id),
          label: null,
          bars: mine.map(barOf),
          strips: mine.map(stripOf).filter(Boolean) as GridRow["strips"],
        });
      }
    } else {
      for (const t of rows) {
        const strip = stripOf(t);
        vmRows.push({
          key: t.id, cls: "row", taskId: t.id, taskIds: [t.id],
          label: labelOf(t), bars: [barOf(t)], strips: strip ? [strip] : [],
        });
      }
    }
    // NO `offsetTop` ANYWHERE IN HERE. Reading it while the grid is half-rebuilt
    // forces a layout flush against a momentarily short document, the browser
    // clamps scrollTop, and the clamp survives everything after it. That was the
    // real cause of "clicking anything jumps me to the top". The element is
    // stashed by the reconciler's ref and measured once, later.
    for (const t of rows)
      POS[t.id] = { x: X(st[t.id] + shiftOf(t)), w: spanOf(t, st[t.id]) * PPD, el: null };

    laneVMs.push({ key: lane ? lane.id : "__date__", head, rows: vmRows });
  }

  // What the done gate took out of THIS filter — not the plan's whole history,
  // which is the legend's number and a different question.
  const hiddenOver = doc.tasks.filter(t => !drawn(t) && inFilter(t)).length;
  mountGrid($("#rows"), {
    lanes: laneVMs,
    // TWO WAYS THE CHART GOES BLANK, AND THEY NEED DIFFERENT SENTENCES. The AND
    // message was the only one, and it is wrong whenever the done gate is what
    // emptied the grid — "nothing matches" while the Done chip beside it reads 54
    // is the chart calling the legend a liar. The gate is checked first because it
    // is the more specific answer, and it is not gated on `isolating`: it drops
    // rows in dim mode too, where `visible` is always true.
    nomatch: !laneVMs.some(l => l.rows.some(r => r.bars.length))
      ? (hiddenOver
          ? `${hiddenOver} finished task${hiddenOver === 1 ? " matches" : "s match"}, `
            + `and finished work is not drawn — tick \u201Cdone\u201D in the legend to see ${hiddenOver === 1 ? "it" : "them"}.`
          : isolating
          ? "Nothing matches all of those at once — filters combine with AND across "
            + "teams, colours, borders and fills. Widen one, or use “show everything”."
          : null)
      : null,
    registerRow: (ids, el) => { for (const id of ids) if (POS[id]) POS[id].el = el; },
    // THE NEXT STATE IS DECIDED WHERE `tracks` IS KNOWN, not recomputed here. A
    // first attempt worked it out from the lane's visible task COUNT, which is a
    // different number: a lane with six serial tasks has one track and two fold
    // states, and counting tasks would have offered it three.
    onFold: (laneId, next) => {
      next ? COLLAPSED.set(laneId, next) : COLLAPSED.delete(laneId);
      render();
    },
    onPick: pick,
    onHeat: (tid, on) => {
      // A BAR ON ITS WAY OUT. A removal (yours, or somebody else's over the
      // socket) updates `doc` before React takes the bar off screen, and a pointer
      // resting there fires one last enter for a task that no longer exists.
      // There is nothing to light up; asking `drawArrows` would only log the miss.
      if (!doc.tasks.some(t => t.id === tid)) return;
      const el = POS[tid] && POS[tid].el && POS[tid].el.querySelector(".bar");
      if (el) el.classList.toggle("hot", on);
      drawArrows(on ? tid : sel, on ? "hover" : "click");
    },
    // AFTER THE COMMIT, because the arrows measure the row elements. The rAF at
    // the end of this function still fires and is still correct when nothing in
    // the grid changed; this one is what makes the FIRST paint draw them.
    // AFTER THE COMMIT, because both of these read the row elements: the arrows
    // measure `offsetTop` off them, and the dim classes are set ON them.
    onPainted: () => {
      const chain = chainMembers();
      const act = isFiltering() || !!chain;
      applyDim(act, t => (!chain || chain.has(t.id)) && matchesFilter(t));
      requestAnimationFrame(() => drawArrows(sel));
    },
    onBarDown: (e, tid) => startConstrain(e, taskById(tid)),
    onGripDown: (e, tid) => startDrag(e, taskById(tid)),
  });

  // dependency arrows, drawn after layout so offsetTop is real
  requestAnimationFrame(() => drawArrows(sel));
  // THE OTHER LENS IS REDRAWN FROM THE SAME RENDER, so a legend tick, an edit or
  // a selection reaches both. renderInner() runs in full either way — it is what
  // computes `st`, the milestone verdicts and the legend, none of which belong to
  // the timeline — and only the chart's own DOM goes unseen while it is hidden.
  if (VIEW_MODE === "graph") drawGraph();
  if (VIEW_MODE === "board") drawBoard();
  if (VIEW_MODE === "calendar") drawCal();

  syncZoomPicker();
  legend();
  // SEPARATELY FROM legend(), which used to call it. `applyFilter()` redraws the
  // legend now, and it runs on every legend chip click — so leaving the channel
  // editor on that path would rebuild `#chedit` by `innerHTML` under anyone with
  // Settings open, taking the caret out of the field they were typing in. The
  // editor depends on the document, not on the filter, so this is its home.
  channelEditor();
  weekEditor();
  arrowEditor();
  swatchWall();
  swapEditor();
  applyFilter();
  { const b_ = doc.milestones.find(m => m.id === BINDING) || doc.milestones[0];
    const f_ = b_ ? milestoneFinish(b_.id) : null;
    const sl = f_ == null || !b_ ? null : dayOf(b_.date) - f_;
    const col = sl == null ? "var(--muted)" : sl > 1e-9 ? "var(--good)" : sl < -1e-9 ? "var(--danger)" : "var(--warn)";
    mountMiniChip($("#mini"), {
      title: doc.title || id || "", milestone: (b_ || {} as any).label || "", tone: col,
      verdict: sl == null ? "—" : sl > 1e-9 ? `${calStr(sl)} to spare`
             : sl < -1e-9 ? `misses by ${calStr(-sl)}` : "exactly on time",
    }); }
  $f("#start").value = doc.start;
  ($f("#autoorder") as HTMLInputElement).checked = doc.autoOrder === true;
  // MOUNTED, NOT ASSIGNED. `.value = doc.title` on a focused input moves the
  // caret to the end whenever the string differs — which, mid-keystroke, it always
  // did. That is what `emit`'s `keep` selector was putting back.
  mountPlanName($("#renamepop"), {
    value: doc.title || "",
    onChange: v => emit({ type: "patchDoc", patch: { title: v } }),
    onDone: () => renamePop(false),
  });
  mountNotice($("#notice"), {
    text: doc.notice || "", html: mdHtml(doc.notice || ""), storeKey: `ts-notice-hidden:${id}`,
    onEdit: () => { openSettings("plan"); $f("#noticeedit")?.focus(); },
  });
  mountNoticeEditor($("#noticeedit-host"), {
    value: doc.notice || "", max: NOTICE_MAX,
    onChange: v => emit({ type: "patchDoc", patch: { notice: v } }),
  });
  $f("#sprintw").value = String((doc.sprint || { weeks: 0 }).weeks ?? 0);
  $f("#sprint0").value = (doc.sprint || {}).start || doc.start;
  // NAMING WHAT YOU ARE MEASURING AGAINST IS THE POINT. A chart wearing strips
  // with nothing on screen saying where they came from is the drift the old
  // stored baseline was trying to avoid, arrived at from the other direction.
  const missing = CMP ? doc!.tasks.filter(t => !CMP!.tasks[t.id]).length : 0;
  $("#cmpchip").hidden = !CMP;
  $("#cmpname").textContent = CMP ? `vs ${cmpLabel()}` : "";
  $("#cmpchip").title = !CMP ? "" :
    `Every bar's strip shows where ${cmpLabel()} put it.`
    + (missing ? `  ${missing} task${missing === 1 ? " was" : "s were"} added since and `
        + `${missing === 1 ? "draws" : "draw"} no strip.` : "");
  $("#dirty").textContent = unsavedStr();
  // Follows `chainFocus` rather than remembering its own last click, so the
  // inspector's chain button and this select can never disagree about what is
  // on screen.
  if ($("#gscope")) $f("#gscope").value = chainFocus ? "chain" : "all";
  // Built from the plan, like the zoom picker: a channel under two values cannot
  // group anything, which is the same rule the legend and the inspector already
  // apply. Lanes are offered first because a team is the grouping most people
  // reach for, and Colour usually turns out to be the one that reads.
  const gg = $opt("#ggrouphost");
  if (gg) {
    const opts_ = CHANNELS.filter(c_ => ((doc[c_] || []).length) >= 2);
    if (!opts_.includes(GRAPH_GROUP)) GRAPH_GROUP = "";
    mountPicker(gg, {
      id: "ggroup", value: GRAPH_GROUP,
      options: [{ value: "", label: "Nothing" },
                ...opts_.map((c_): PickerOption => ({ value: c_, label: chLabel(c_) }))],
      onPick: v => { GRAPH_GROUP = v; drawGraph(); },
    });
  }
  inspector();
}

// Toggling classes rather than re-rendering: this runs on every pointer move
// across the legend, and a full render rebuilds every row.
/** THE ROW CLASSES, SPLIT OUT BECAUSE THEY NEED THE ELEMENTS TO EXIST.
 *
 *  `POS[id].el` is filled by React's refs, which land on commit — and `render()`
 *  calls `applyFilter()` BEFORE that commit, so every `el` is still null and the
 *  loop silently does nothing. That is not theoretical: after the grid moved to
 *  React, chain focus dimmed no rows at all. Clicking a legend chip still worked,
 *  because that path calls `applyFilter` on its own without a full render and the
 *  refs from the previous commit are still there — so the bug hid behind the
 *  half of the feature that happened to be fine.
 *
 *  The grid asks for this again from its paint effect, once the rows exist. */
function applyDim(active: boolean, ok: (t: any) => boolean) {
  for (const t of doc.tasks) {
    const el = POS[t.id]?.el;
    if (el) el.classList.toggle("dim", active && !ok(t));
  }
}

function applyFilter(preview?: any) {
  // THE CHAIN DIMS TOO. This only ever knew about the legend, which was fine while
  // chain focus removed its rows outright — there was nothing left to grey. In dim
  // mode the rest are on screen, so if this ignored the chain the eye button would
  // appear to do nothing at all.
  const chain = chainMembers();
  // TWO ACTIVES, AND THE ARROWS ONLY OBEY ONE. `legendActive` is a filter on task
  // ATTRIBUTES, where fading the lines is right: they join rows you have just
  // said you are not looking at. A focused chain is the opposite — it is DEFINED
  // by those lines, and "which rows do these lines actually touch" is the whole
  // question the eye answers. Folding the chain into one flag dropped the arrow
  // layer to 13% the moment you pressed it, which read as the lines being gone,
  // and took hover-preview's arrows down with it.
  const legendActive = isFiltering() || !!preview;
  const active = legendActive || !!chain;
  const ok = t => {
    if (chain && !chain.has(t.id)) return false;
    if (preview) return valsOf(t, preview.ch).includes(preview.id);
    // Asked through the hoisted predicate rather than re-inlined, so the text box
    // and the status chips reach here without a fourth copy of this expression.
    return matchesFilter(t);
  };
  applyDim(active, ok);
  const svg = $("#arrows"); if (svg) svg.classList.toggle("dim", legendActive);
  // THE GRAPH DIMS FROM THE SAME PREDICATE, and is REPAINTED rather than rebuilt
  // for exactly the reason the rows above are toggled rather than re-rendered:
  // this runs on every pointer move across the legend, and relaying out a graph
  // per pointer event is not a thing you can do. Hover-preview therefore works in
  // the graph too, for free, which is the payoff for the filter having always
  // been a view rather than a query.
  if (cy) {
    const by = Object.fromEntries(doc.tasks.map(t => [t.id, t]));
    cy.batch(() => cy.nodes().forEach(n_ => {
      const t = by[n_.id()];
      n_.data("dim", t && active && !ok(t) ? 1 : 0);
    }));
    const host = $("#cy");
    if (host?.dataset.graph) {
      const g = JSON.parse(host.dataset.graph);
      g.dim = cy.nodes().filter(n_ => n_.data("dim")).length;
      host.dataset.graph = JSON.stringify(g);
    }
  }
  // THE TWO CHIP ROWS ARE REDRAWN, NOT POKED — and only when the picked set can
  // actually have changed.
  //
  // This function used to reach into `#legend` and `#msbar` and toggle `.on` on
  // every chip by hand, with a note saying the real render functions "cannot be
  // called from here" because they rebuild live `<input>`s and this runs on every
  // pointer move across the legend. That was true of functions whose only move was
  // `innerHTML =`. React owns both rows now, so asking for them again is a
  // className diff on the chips that changed and nothing at all on the rest — the
  // caret in a half-typed milestone name stays where it is.
  //
  // A PREVIEW CHANGES NEITHER ROW. Hovering a legend chip dims BARS; it does not
  // touch `focus`, `chainFocus` or the query, so there is nothing for either row
  // to say differently. Skipping them keeps a pointer move across the legend at
  // exactly the cost it had before.
  // The board has no per-card dim hook like the graph's; a filter change on it
  // is a redraw, which is cheap for a list of cards. Hover previews skip it.
  if (VIEW_MODE === "board" && !preview) drawBoard();
  if (VIEW_MODE === "calendar" && !preview) drawCal();
  if (!preview) { legend(); milestoneBar(); }
}

// ---- inspector ------------------------------------------------------------
/** THE INSPECTOR'S VIEW OF ONE TASK — everything it shows, as strings and booleans.
 *  One function because two places show it: the Inspector itself, and the Rank tab's
 *  cards, which show the same content read-only so "which should happen first?" is
 *  answered with everything you would read about the task anyway — and so the two
 *  cannot drift apart. */
function inspectorTaskOf(tid: Id | null): InspectorTask | null {
  const t = tid ? taskById(tid) : null;
  const byStart = (x, y) => (st[x] ?? 0) - (st[y] ?? 0);
  // A channel under two values draws no control: one value is not a choice, and
  // every pixel this panel takes is a pixel of plan. `null` is that absence.
  const many = (list): Option[] | null => (list || []).length < 2
    ? null : (list || []).map(x => ({ id: x.id, label: x.label }));

  // THE WHOLE VIEW MODEL IS BUILT HERE, beside the scheduler wrappers it needs.
  // `Inspector.tsx` is presentation and gets strings and booleans, so it cannot
  // compute a date and therefore cannot disagree with the chart about one.
  if (!t) return null;
  {
    // `ancestorsOf`/`descendantsOf` walk an untyped graph and hand back `unknown`;
    // these are task ids, and everything downstream treats them as such.
    const trans  = ([...ancestorsOf(tid!)] as Id[]).filter(d => !t.deps.includes(d)).sort(byStart);
    const blocks = ([...descendantsOf(tid!)] as Id[]).sort(byStart);
    const bind = bindingDeps(t);
    const gap = st.whyGap[t.id];
    return {
      id: t.id,
      label: t.label || t.id,
      desc: t.desc || "",
      ref: t.ref || "",
      refPlaceholder: refExample() || "id in your tracker",
      url: t.url || "",
      hasLink: !!linkOf(t),
      linkTitle: linkOf(t) ? "Link: " + linkOf(t)
                           : "Link this task to a page — an issue, a doc, a runbook",
      refBaseSet: !!KEYRING.refBase,
      refTestUrl: refUrl(t) || null,
      dur: fmtDur(t.dur),
      descHtml: mdHtml(t.desc || ""),
      // RAW, not through the guard's day-number projection: a comment's times
      // are instants to print, not scheduler inputs.
      comments: ((rawDoc().tasks.find(x => x.id === t.id) || {}).comments || []).map(c => ({
        id: c.id, by: c.by, text: c.text, html: mdHtml(c.text),
        when: whenAbs(c.at), edited: c.editedAt ? whenAbs(c.editedAt) : null })),
      // THE TASK AS THE CHART DRAWS IT, in miniature. Built from the same
      // functions `barOf` uses — shape, rim, fill pattern, colour bands — so the
      // panel cannot show you one thing while the bar shows another. Four
      // channels answered at a glance, in the space of a full stop.
      swatch: (() => {
        const cols = colorsOf(t), sname = shapeOf(t), pointed = POINTED.has(sname as any);
        const pat = "pat-" + (fillDef(t.fill).pattern || "solid");
        return {
          cls: "shape sh-" + sname + (pointed ? " rim-" + borderStyleOf(t) : " fillbody " + pat),
          style: pointed ? { border: "none" } : cssObj(borderCss(t.border)),
          coreCls: pointed ? "core fillbody sh-" + sname + " " + pat : null,
          color: String(colorOf(cols[0])),
          bands: cols.slice(1).map((c, k) => ({
            cls: "band " + pat,
            left: ((k + 1) / cols.length * 100) + "%",
            right: ((cols.length - 1 - (k + 1)) / cols.length * 100) + "%",
            color: String(colorOf(c)),
          })),
        };
      })(),
      lane: t.lane, lanes: many(doc.lanes),
      colors: (doc.colors || []).length < 2 ? null : (doc.colors || []).map(x => ({
        id: x.id, label: x.label, color: x.color as string, on: colorsOf(t).includes(x.id),
      })),
      colorSummary: colorsOf(t).map(c => (colorDef(c) || {} as any).label || c).join(", ") || "—",
      border: t.border, borders: many(doc.borders),
      fill:   t.fill,   fills:   many(doc.fills),
      shape:  t.shape,  shapes:  many(doc.shapes),
      // UNDER TWO MILESTONES THERE IS NOTHING TO PICK EITHER. With none there is
      // no list; with one, `msOf` already falls every task to it, so the control
      // could only ever set what is already set. Same rule as every other channel.
      ms: msOf(t), milestones: many(doc.milestones),
      notBefore:   t.notBefore   == null ? "" : isoTimeOf(t.notBefore),
      noQueue: !!t.noQueue,
      recur: t.recur ? { n: t.recur.n, unit: t.recur.unit, ahead: t.recur.ahead } : null,
      planned: (t.planned || []).map((x, i) => ({ start: isoTimeOf(x.start), stop: isoTimeOf(x.stop),
                                                   unconfirmed: x.stop <= nowD() ? pastPlanOf(t, i) : null })),
      due:     t.due == null ? "" : isoTimeOf(t.due),
      // SLACK, COMPUTED HERE beside the schedule like every other date on the
      // panel — the component is presentation only and cannot be allowed to
      // disagree with the chart about a date. Silent for a task with no deadline
      // and for one already finished or abandoned, because "3 days to spare" on
      // work nobody is going to do is noise dressed as reassurance.
      dueSlack: (() => {
        if (t.due == null || t.actualEnd != null) return null;
        const over = endOf(t, st[t.id], CAL) - t.due;
        return over > 1e-9
          ? { text: `misses by ${calStr(over)}`, tone: "danger" as const }
          : { text: `${calStr(-over) || "0 days"} to spare`, tone: "good" as const };
      })(),
      done: !!t.done,
      sessions: (t.sessions || []).map(x => ({ start: isoTimeOf(dayOfInstant(x.start, rawDoc())),
        stop: x.stop == null ? "" : isoTimeOf(dayOfInstant(x.stop, rawDoc())) })),
      // WALL CLOCK, so a session still running counts up to this moment.
      worked: (t.sessions || []).length ? `${durStr((t.sessions || []).reduce((m, x) =>
        m + ((x.stop == null ? Date.now() : Date.parse(x.stop)) - Date.parse(x.start)) / 864e5, 0))} of ${durStr(t.dur)}` : "",
      refinedAt: t.refinedAt == null ? "" : isoTimeOf(t.refinedAt),
      // ABSOLUTE, in the viewer's own locale and zone: these are ISO instants, so
      // unlike a day number there is no zone trap in `toLocaleString`. It said
      // "3 days ago" until 2026-09-26 — Rascal Two wanted the time, not the distance.
      // Absent on anything older than the fields themselves, which reads as
      // nothing rather than as a date the plan does not actually know.
      touched: [
        t.createdAt ? "added " + whenAbs(t.createdAt) : null,
        t.updatedAt ? "edited " + whenAbs(t.updatedAt) : null,
      ].filter(Boolean).join(" · "),
      todayISO: isoTimeOf(nowD()),
      zone: zoneOf(rawDoc()),
      chainOn: chainFocus === tid,
      // THE QUEUE ARROWS GO DEAD IN DATE MODE, and say why on hover rather than
      // just greying out. Their whole meaning is "move this row", and in date
      // mode the row's position is an answer, not somewhere you can put it.
      // AUTO-ORDER DOES NOT LOCK THE QUEUE. It only moves a task when that is a
      // strict improvement, so a hand-made order that is as good as any stays;
      // one that makes something later or late gets re-settled. Said on hover.
      queueDisabled: ROWMODE === "date",
      queueTitle: live => ROWMODE === "date"
        ? "Rows are ordered by date — switch Rows to Team to change this team's queue"
        : doc.autoOrder === true ? live + " — Auto-order keeps it unless it makes the plan worse"
        : live,
      // fmtEnd, not fmt: the Finished field above holds the last day WORKED, and
      // this line sat one control away naming the exclusive boundary after it.
      // Two dates a day apart claiming to be the same fact is the chart
      // contradicting itself.
      ...startsEnds(st[t.id] + shiftOf(t), endOf(t, st[t.id] + shiftOf(t))),
      // Quoted in CALENDAR space, the same space the tick is drawn in, so the
      // number and the mark cannot tell two stories.
      est: (() => {
        if (t.actualStart == null || t.actualEnd == null) return null;
        const estEnd = endOf({ ...t, actualStart: null, actualEnd: null } as any, t.actualStart);
        const d = t.actualEnd - estEnd;
        if (Math.abs(d) < 1e-9) return { tone: "muted" as const, text: "finished exactly on the estimate" };
        return d > 0
          ? { tone: "danger" as const, text: `ran ${calStr(d)} over the estimate, which said ${fmtEnd(estEnd)}` }
          : { tone: "good" as const, text: `finished ${calStr(-d)} early — the estimate said ${fmtEnd(estEnd)}` };
      })(),
      variance: !CMP ? null : (bl_ => ({
        title: `Against ${cmpLabel()}`,
        text: bl_ ? varianceStr(t, bl_) : "not in that version — added since",
      }))(baseOf(t)),
      labels: {
        lanes: chLabel("lanes"), colors: chLabel("colors"), borders: chLabel("borders"),
        fills: chLabel("fills"), shapes: chLabel("shapes"),
      },
      // Tightest first: the top of this list is the one to go and shorten.
      deps: upSlack(t).map(([d, sl]: [Id, number]): Chip => {
        const pin = bind.has(d);
        return {
          id: d, label: name(d), tag: slackTag(sl, pin), pin, removable: true,
          title: (pin
            ? "This is what is holding this task where it is — shorten this and this task moves left"
              + (gap ? `. The ${calStr(gap)} gap is the calendar, not this task: it `
                     + `finished on a non-working day.` : "")
            : `Finished ${calStr(sl)} before this task needed it, so shortening it changes nothing here`)
            + " · click to select it",
        };
      }),
      heldBy: heldBy(t),
      // A QUEUE IS NOT A BLOCK, and "held by" read as one: the task ahead in the
      // lane is not in this one's way, it is simply first.
      heldLabel: st.why[t.id] === "lane" ? "queued behind" : "held by",
      trans: trans.map((d): Chip => ({
        id: d, label: name(d), ghost: true, title: "Hover to find it · click to select it", k: "tr:" + d,
      })),
      blocks: blocks.map(d => [d, slackDown(t, d), pinsDown(t, d)] as [Id, number, boolean])
        .sort((x_, y_) => x_[1] - y_[1])
        .map(([d, sl, pin]): Chip => ({
          id: d, label: name(d), ghost: true, pin, tag: slackTag(sl, pin), k: "dn:" + d,
          title: (pin
            ? "THIS task is what is holding that one — finish sooner and it moves with you"
            : `Starts ${calStr(sl)} after this finishes, and something else decides its date`)
            + " · click to select it",
        })),
      // A DASH, NOT A SENTENCE. This used to append "— it only waits for its own
      // lane's queue", which restated in prose what the HELD BY chips beside it
      // already say as data, and made the shortest row on the panel the wordiest.
      // The house glyph for "no value" everywhere else is an em dash.
      noDepsHint: "—",
      depColors: { direct: arrowStyle("direct").color, trans: arrowStyle("trans").color,
                   down: arrowStyle("down").color },
      rank: (() => {
        if (t.actualEnd != null) return "";
        const r = rankOf(rawDoc()), n = r.rank.size + r.unranked.length;
        const at = r.rank.get(t.id);
        const mine = at === undefined ? "not ranked yet" : `${at} of ${n}`;
        // A suggestion's place is shown beside theirs, marked as not theirs.
        const sg = suggestedRankOf(rawDoc()).rank, sat = sg.get(t.id);
        return sat === undefined ? mine : `${mine} · ≈ ${sat} of ${sg.size} suggested`;
      })(),
    };
  }
}

function inspector() {
  const box = $("#insp");
  // A selection can outlive the task it points at: Revert restores an older task
  // list, and anything selected that is no longer in it leaves `sel` dangling.
  // The inspector then read `.label` off undefined and threw — an uncaught error
  // on every subsequent render, which in a meeting looks like the tool freezing.
  // Guarded here rather than at any one call site so it covers every path that
  // can remove a task, not just the one that was noticed.
  if (sel && !doc.tasks.some(t => t.id === sel)) sel = null;
  if (linking && !doc.tasks.some(t => t.id === linking)) linking = null;
  // Nothing selected and not linking -> no panel at all, rather than a panel
  // saying nothing. It is pinned over the chart, so empty-but-present would be
  // stealing screen from the thing it describes.
  box.hidden = !sel && !linking;
  box.classList.toggle("folded", inspSize === 0);
  box.classList.toggle("full", inspSize === 2);

  const t = sel ? taskById(sel) : null;
  const task = inspectorTaskOf(sel);

  // The one contradiction the two actual dates cannot rule out is a FUTURE
  // start, which reads as in-progress work nobody has begun. So it is refused at
  // entry, and the refusal names the field that does want a future date: an
  // intention to start next Tuesday is a `notBefore`, not a fact.
  const refuseFuture = (d: number, what: string) => {
    if (d <= nowD() + 1e-9) return false;
    flash(`${what} cannot be in the future — “Not before” is where an intention goes.`, true);
    render(); return true;
  };
  // A CHIP IS A POINTER TO A ROW, so make it behave like one. Reading a name in a
  // list and then hunting for that row by eye is the slow half of every "why is
  // this waiting?" — hover lights the bar up where it actually is, and click goes
  // there. Reuses drawArrows rather than inventing a second highlight.
  const hot = (tid: Id, on: boolean) => {
    const el = tid && POS[tid] && POS[tid].el && POS[tid].el.querySelector(".bar");
    if (el) el.classList.toggle("hot", on);
    drawArrows(on ? tid : sel, on ? "hover" : "click");
  };

  mountInspector(box, {
    task,
    linkingFrom: linking ? name(linking) : null,
    linkingDir: linkDir,
    size: inspSize,
    onFold: () => {
      inspSize = (inspSize + 1) % 3;
      // RESET THE HIGH-WATER MARK, and only here. `padForPanel()` only ever grows
      // the reservation, on purpose — it stops the page twitching as the panel
      // changes height from one selection to the next. Folding is a deliberate
      // request for that space back.
      padHigh = 0;
      inspector();
    },
    // ONE COMMAND PER KEYSTROKE, deliberately: "it shows up on the bar as you
    // type" is half the point of this field, and `renameTask` is last-write-wins
    // so a burst of them collapses to whatever was typed. NO `keep` SELECTOR —
    // React reuses the <input>, so there is no caret to put back.
    onName: v => emit({ type: "renameTask", id: t!.id, label: v }),
    // CAPTURED ONCE PER TASK. The id guard used to be load-bearing for a second
    // reason as well: every keystroke rebuilt the panel and handed focus back, so
    // this fired again mid-word and the "before" crept forward to a half-typed
    // name. The field survives a render now, so `focus` means focus.
    onNameFocus: () => {
      if (!renameBefore || renameBefore.id !== t!.id) renameBefore = { id: t!.id, label: t!.label };
    },
    // STILL DEFERRED, and no longer for the reason it was written. A rebuild used
    // to remove the focused input, which fires `blur`, so every keystroke looked
    // like leaving the field and opened the mentions dialog in front of someone
    // still typing. That cannot happen now — but `renderInbound` can still hand
    // focus back after a peer's command lands, so checking where the caret
    // actually ended up stays the honest test.
    onNameSettled: () => setTimeout(() => {
      if (document.activeElement !== $opt("#lab")) renameSettled(t!.id);
    }),
    // `null` CLEARS THE KEY rather than storing "" — an emptied description leaves
    // no trace for the save-time diff to see, which is what keeps History honest.
    onDesc: v => emit({ type: "setTaskDesc", id: t!.id, desc: v || null }),
    // THE PAGE NAMES ITS OWN COMMENTS: id, time and author travel on the command,
    // so the copy this tab applies first is the copy everyone else gets.
    onAddComment: text => emit({ type: "addComment", id: t!.id,
      comment: { id: "c-" + Math.random().toString(36).slice(2, 10), text, at: new Date().toISOString(), by: ME } }),
    onEditComment: (cid, text) => emit({ type: "editComment", id: t!.id, commentId: cid, text }),
    onRemoveComment: cid => emit({ type: "removeComment", id: t!.id, commentId: cid }),
    // The clamp is about what this control may express, not what the plan may
    // hold — the command vocabulary's own rule is `dur > 0`.
    // A MINUTE IS THE FLOOR, not zero: this field is how you say how long
    // something takes, and "no time at all" is not an answer to that question.
    // The DOCUMENT still holds zero — an imported task or one an agent added
    // without a duration — and the plan reads it as consuming no working time;
    // this control simply will not write one. (It used to point at the `dropped`
    // and owner controls for that, and both are gone.) Unparseable input leaves
    // the value alone rather than silently becoming a minute.
    onDur: v => { const d = parseDur(v); if (d != null) emit({ type: "setDuration", id: t!.id, dur: mins(d) }); else inspector(); },
    onLane: v => emit({ type: "setTaskChannel", id: t!.id, channel: "lane", value: v }),
    onColors: ids => emit({ type: "setTaskColors", id: t!.id, colors: ids }),
    onChannel: (ch, v) => emit({ type: "setTaskChannel", id: t!.id, channel: ch, value: v }),
    // A MILESTONE IS NOT A CHANNEL and has its own command: "belongs to no
    // milestone" is a real state, and `setTaskChannel` may not carry an empty value.
    onMilestone: v => emit({ type: "setMilestone", id: t!.id, ms: v || null }),
    // Typed dates are NOT dropped when they stop binding, unlike dragged ones:
    // "it can't begin before Sept 1" stays true even while a dependency happens
    // to be pushing the task past September anyway.
    // READ AT CLICK TIME, not at render time — see `nowISO` on InspectorProps.
    nowISO: () => isoTimeOf(nowD()),
    // The picker shows the plan zone's wall clock (`isoTimeOf`), so its value is
    // read back on the same clock and sent as the instant it names.
    onNotBefore: iso => emit({ type: "setNotBefore", id: t!.id, notBefore: iso ? whenOf(dayOf(iso)) : null }),
    onNoQueue: v => emit({ type: "setNoQueue", id: t!.id, noQueue: v }),
    // PLANNED STRETCHES ARE WRITTEN WHOLE (setPlanned replaces the list), from the stored instants, in time order.
    onPlanAdd: () => {
      const was = storedPlanned(t!.id), last = was.length ? dayNum(was[was.length - 1]!.stop) : -Infinity;
      const s = Math.max(Math.ceil(nowD() * 24) / 24, last);   // the next whole hour (or when the last stretch ends), for as long as the estimate
      const list = [...was, { start: whenOf(s)!, stop: whenOf(s + t!.dur)! }]
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      emit({ type: "setPlanned", id: t!.id, planned: list });
    },
    onPlanned: (i, which, v) => {
      if (!v) return;                                  // a stretch needs both ends; × removes it
      emit({ type: "setPlanned", id: t!.id, planned: storedPlanned(t!.id).map((x, j) => j !== i ? x : { ...x, [which]: whenOf(dayOf(v))! }) });
    },
    onPlannedRemove: i => void emit({ type: "setPlanned", id: t!.id, planned: storedPlanned(t!.id).filter((_, j) => j !== i) }),
    onPlannedDone: i => void emit({ type: "completePlanned", id: t!.id, index: i }),
    onPastAnswer: answerPast,
    onRecur: r => emit({ type: "setRecur", id: t!.id, recur: r as any }),
    onDue: iso => emit({ type: "setDue", id: t!.id, due: iso ? whenOf(dayOf(iso)) : null }),
    onRef: v => emit({ type: "setTaskRef", id: t!.id, ref: v.trim() || null }),
    // A BARE HOST GETS `https://` PUT ON IT. "wiki.example.com/plan" is what a
    // person pastes half the time, and the alternative is refusing it with a
    // message about schemes — correct, and an argument with someone who did
    // nothing wrong. `://` rather than just a colon, so "example.com:8080/x" is
    // read as the host:port it is.
    onUrl: v => { const s_ = v.trim(); emit({ type: "setTaskUrl", id: t!.id,
      url: !s_ ? null : /^[a-z][a-z0-9+.-]*:\/\//i.test(s_) ? s_ : "https://" + s_ }); },
    // NO PARTNER FIELD AND NO ORDERING RULE: a sign-off is one instant and answers
    // to nothing else. The only check is that you cannot have read it in the future.
    onRefined: iso => {
      if (!iso) return void emit({ type: "setRefined", id: t!.id, refinedAt: null });
      const d = dayOf(iso);
      if (refuseFuture(d, "A refinement date")) return;
      emit({ type: "setRefined", id: t!.id, refinedAt: whenOf(d) });
    },
    onStartTask: () => void emit({ type: "startTask", id: t!.id }),
    onStopTask: () => void emit({ type: "stopTask", id: t!.id }),
    // SESSIONS ARE THE RECORD (ADR 0016): finishing stamps now, and a time typed wrong is fixed in the stretches below.
    onFinishTask: () => void emit({ type: "finishTask", id: t!.id }),
    onReopenTask: () => void emit({ type: "reopenTask", id: t!.id }),
    // ONE FIELD OF ONE SESSION, the rest sent back exactly as stored. The inputs show minutes, so
    // rebuilding the list from what is on screen would quietly round every other time in it.
    onSession: (i, which, v) => {
      if (which === "start" && !v) return;             // a start cannot be empty; × removes the stretch
      emit({ type: "setSessions", id: t!.id, sessions: (t!.sessions || []).map((x, j) =>
        j !== i ? x : { ...x, [which]: v ? whenOf(dayOf(v)) : null }) });
    },
    onRemoveSession: i => void emit({ type: "setSessions", id: t!.id, sessions: (t!.sessions || []).filter((_, j) => j !== i) }),
    // Toggles, and re-targets when a different task is selected — so tracing a
    // chain is click-a-bar, click-the-eye, repeat, rather than clear-then-set.
    onChain: () => { chainFocus = chainFocus === sel ? null : sel; render(); },
    onDup: () => dup(sel),
    onMove: dir => move(sel, dir),
    onDelete: () => del(sel),
    onDismiss: () => { sel = null; render(); },
    onStartLink: () => armLink("blocks"),
    onStartLinkWaits: () => armLink("waits"),
    // Same one line Escape runs, reachable without knowing Escape runs it.
    onCancelLink: () => { linking = null; if (cyEh) cyEh.disableDrawMode(); inspector(); },
    onGo: tid => {
      hot(tid, false); pick(tid);
      // AFTER the render, and in a frame of its own: render() restores scroll on
      // both axes, so scrolling from inside it would be undone immediately. A
      // dependency is often off the right-hand edge, which is the whole reason
      // this scrolls at all.
      requestAnimationFrame(() => POS[tid]?.el?.querySelector(".bar")
        ?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" }));
    },
    onRemoveDep: d => emit({ type: "removeDep", id: t!.id, dep: d }),
    onChipHover: hot,
    onPainted: padForPanel,
  });
}

// Reserve exactly as much bottom padding as the pinned panel actually occupies,
// so the last row of the last lane can always be scrolled clear of it. Measured
// after layout, because the panel's height depends on the content just written
// into it.
//
// Scroll is held across the change: shrinking the padding (when the panel is
// dismissed) shortens the document, and the browser would clamp scrollTop — the
// same clamp that used to throw the page to the top on every click.
// THE RESERVED SPACE NEVER SHRINKS. It used to track the panel exactly, so
// dismissing it shortened the document — and if you were scrolled down into the
// chart, the browser clamped scrollTop and the whole page lurched upward for no
// reason you could see. The same clamp, in the same place, as the render bug
// documented over render(); this was the last path still triggering it.
//
// High-water mark rather than a fixed guess, because the panel's height depends
// on how many dependency chips a task has and no constant is right for both a
// task with none and one with fifteen. Costs a strip of empty page under the
// chart, buys a layout that never moves under the pointer.
// Folded-ness is a VIEW preference, so it survives re-renders and reloads the way
// the control bar's does. It is not on the document: which panel you had folded is
// not a fact about the plan.
// 0 folded, 1 the strip, 2 the full task. Was a boolean; the third size is what
// makes a long description readable without giving up the chart, which is the
// whole reason the strip was worth keeping.
// STARTS AT THE SMALLEST. A freshly clicked task should answer "which one is
// this" and cost nothing else; opening it is a second, deliberate click.
let inspSize = 0;
let padHigh = 24;
function padForPanel() {
  requestAnimationFrame(() => {
    // MEASURES THE SAME THING, MOVES A DIFFERENT LEVER. This used to pad the
    // BODY, which was right while the window was the scroller. The chart is the
    // scroller now, so padding the body would leave the horizontal scrollbar
    // underneath the inspector — the exact complaint this whole change answers.
    // `--insph` is read by `#chart`'s bottom margin instead.
    //
    // Still monotonic, for the reason it always was: letting it shrink makes the
    // chart resize under the pointer every time the panel changes height.
    // NO LONGER MONOTONIC. It used to only ever grow, to stop the chart resizing
    // under the pointer as the panel changed height by a few pixels. That was
    // right while the panel had one size; with three, a visit to the full view
    // would have left the chart permanently short after folding back down.
    // The sizes are deliberate now, so the reservation tracks the real height.
    const b = $("#insp");
    padHigh = b.hidden ? 0 : b.offsetHeight + 22;
    document.documentElement.style.setProperty("--insph", padHigh + "px");
  });
}

// Re-render without stealing the caret: render() rebuilds the inspector, which
// would blur the field being typed into after every keystroke.
function renderKeepFocus(selector) {
  const a = (document.activeElement as any), pos = a && a.selectionStart;
  render();
  const n = $(selector);
  if (n) { const fn = (n as HTMLInputElement);
           fn.focus({ preventScroll: true }); if (pos != null && fn.setSelectionRange) fn.setSelectionRange(pos, pos); }
}

// ---- reorder within a team -------------------------------------------------
// Swaps with the nearest neighbour in the SAME lane, skipping over other lanes'
// tasks in between — doc.tasks is one flat list, so the neighbour is rarely the
// adjacent array element.
//
// This is not cosmetic. The lane is a serial queue and the scheduler breaks ties
// by array position, so moving a task up is literally "do this one first". It
// changes the dates whenever two tasks are both ready at the same moment — which
// is every server build, since none of them has a dependency.
//
// When it does NOT move the dates, that is the honest answer rather than a bug:
// something upstream is pinning that task's start, so its place in the queue is
// not what is holding it up.
// THIS IS THE ONE ADR 0001 EXISTS FOR. A reorder is the
// mutation a CRDT cannot merge without inventing an interleaving neither person
// chose — plausible-looking, and a different finish date. So it goes over the
// wire as an INTENT and the server serialises it.
//
// `toIndex` IS LANE-RELATIVE, not an index into `doc.tasks`, and the difference
// is the whole point: the applier permutes only the array slots that already
// belong to this lane, so two people reordering two different teams commute
// perfectly. A global splice would drag every task it passed over. It is also
// bit-for-bit what `suggestReorders` measures, so a `/reorder` suggestion
// `{id, to}` IS this command.
function move(tid, dir) {
  const t = taskById(tid);
  if (!t) return;
  // NOT IN DATE MODE, where the row order is derived from the schedule and the
  // queue is not on screen. The command would still be correct and the dates
  // would still move, but the gesture is positional — you push a row and the row
  // does not go where you pushed it — so it reads as the tool ignoring you. The
  // buttons are `disabled` too; this is the guard for Alt+arrow, which is not.
  if (ROWMODE === "date") {
    flash("Queue order is not on screen in date mode — switch Rows to Team to reorder.");
    return;
  }
  const queue = doc.tasks.filter(x => x.lane === t.lane);
  const to = queue.findIndex(x => x.id === tid) + dir;
  if (to < 0 || to >= queue.length) { flash("Already " + (dir < 0 ? "first" : "last") + " in its team."); return; }
  const before = finishOf(doc.tasks, st);
  if (!emit({ type: "moveTaskInLane", id: tid, toIndex: to })) return;
  const after = finishOf(doc.tasks, st);
  if (Math.abs(after - before) < 1e-9)
    flash("Moved — no date change; something upstream is holding that task, not the queue.");
}

// ---- add / delete ---------------------------------------------------------
// A FREE TASK ID, AND THE RANDOMNESS IS THE POINT rather than a shortcut.
//
// `+ Task` and Duplicate both used to count upwards from the local document —
// `new-1`, `new-2` — which is a correct answer to the wrong question. The
// document this tab holds is not the only writer: two people clicking `+ Task`
// in the same second scan two copies of the same plan, compute the same free id,
// and the second one is refused by the server with "a task 'new-3' is already in
// this plan". It is a race, so it is not fixable by looking harder at the local
// copy — the id has to be one nobody else was going to compute.
//
// Six characters of base36 is about 31 bits, which makes a collision between two
// simultaneous clicks a non-event rather than the normal case. The scan is kept
// so the local answer is still definitively free; it is now a belt rather than
// the mechanism. `Math.random` and not `crypto`: an id is a name, not a
// capability — ADR 0002 is emphatic about that distinction for PLAN ids and it
// holds here for the same reason.
const freeTaskId = base => {
  let id_;
  do { id_ = `${base}-${Math.random().toString(36).slice(2, 8)}`; }
  while (doc.tasks.some(t => t.id === id_));
  return id_;
};

function add() {
  // New task lands in the selected task's lane — "add another networking task"
  // is the common case, and it saves a trip to the Team dropdown.
  const cur = taskById(sel!);
  const lane = cur ? cur.lane : doc.lanes[0].id;
  const cols = cur ? colorsOf(cur) : [((doc.colors || [])[0] || {}).id].filter(Boolean);
  const id_ = freeTaskId("new");
  // A task added mid-meeting is by definition one nobody has costed, so it
  // starts as a guess rather than quietly inheriting the credibility of the
  // rows around it.
  // EVERY FIELD IS ANSWERED, because since v3 there is no unanswered. With nothing
  // selected there is nobody to inherit from, so it falls to the plan's
  // not-applicable value — NOT to borders[0], which is "dev" in every plan here
  // and would have a brand-new task claiming an environment nobody put it in.
  // `addTask` APPENDS — last in that lane's queue, which is what "add a task"
  // means. Putting it anywhere else is a second intent and a second command.
  // ONLY WHAT THIS GESTURE MEANS, and nothing the plan can answer for itself.
  // The fallbacks that used to be written out here — `defaultOf("borders") ||
  // doc.borders[0]`, and the last fill because a task added mid-meeting is
  // uncosted — now live in `withDefaults` in `shared/commands.js`, where the
  // HTTP API applies them too. Three copies of that rule had already drifted:
  // this one took the LAST fill and a CLI took the first.
  //
  // What stays is the part that is about the gesture rather than the document:
  // a new task INHERITS from whatever was selected, because adding one while
  // looking at another almost always means "another like this".
  if (!emit({ type:"addTask", task: { id:id_, lane, color:[...cols], dur:mins(1), label:"New task",
                   ...(cur ? { border: cur.border, shape: cur.shape, ms: msOf(cur) }
                           : { ms: (doc.milestones[0] || {}).id }) } })) return;
  sel = id_; render();
  const lab = ($opt("#lab") as HTMLInputElement|null);
    if (lab) { lab.focus({ preventScroll: true }); lab.select(); }
}

// ---- duplicate --------------------------------------------------------------
// A copy primitive rather than a split operation, which is the right call: split
// has to guess what you meant (halve the duration? which half keeps the
// dependents? does the second half inherit the first's predecessors?) and every
// guess is wrong for somebody. Copy once, edit twice.
//
// WHAT IT COPIES: everything stored ON the task, including `deps` — the copy
// waits for the same things the original does.
//
// WHAT IT DELIBERATELY DOES NOT COPY: the links pointing AT the original. Those
// live on other tasks, so rewiring them is a side effect beyond "duplicate this
// task", and it is the difference between the two uses this serves — splitting
// one task in half (you probably DO want the dependents to wait for both) versus
// stamping out a similar task (you almost certainly do not). Guessing would make
// one of those silently wrong, so it says what it left alone instead.
//
// Inserted directly after the original rather than appended: array order is lane
// order is queue order, so appending would drop the copy to the bottom of the
// team's queue and quietly change the schedule.
function dup(tid) {
  const i = doc.tasks.findIndex(x => x.id === tid);
  if (i < 0) return;
  if (!onAPlan()) return;
  // RAW, because the copy is SENT: through the guard its times read as day
  // numbers, and a command carries instants.
  const src = rawDoc().tasks[i];
  const id_ = freeTaskId(src.id);
  // deps AND color are copied by value. Both are arrays, and a spread would hand
  // the copy the ORIGINAL's array — two tasks sharing one list is a bug that only
  // shows up the day something edits it in place.
  // NOT THE WORK: a copy is how a task is started over (ADR 0016), so it begins with no sessions and not done.
  const { sessions: _s, done: _d, ...rest } = src;
  const copy = { ...rest, id: id_, deps: [...src.deps], color: [...colorsOf(src)],
                 label: (src.label || src.id) + " (2)" };
  // TWO INTENTS, ONE BATCH. `addTask` appends, then the copy is moved into place
  // directly after the original — the vocabulary has no "insert at" on purpose,
  // and `toIndex` is lane-relative, so this is the copy's position among its own
  // lane's tasks rather than an index into `doc.tasks`.
  //
  // THEY GO TOGETHER OR NOT AT ALL. As two separate commands the second could be
  // refused, or the socket could drop between them, and the copy would be left at
  // the BOTTOM of the team's queue — array position is queue position is a
  // scheduling input (ADR 0001), so "duplicate this task" would silently have
  // rescheduled the lane in a way nobody asked for and nothing on screen explains.
  // `POST /api/commands` commits a batch all-or-nothing.
  const queue = doc.tasks.filter(x => x.lane === copy.lane);
  // Measured before the append and used after it: the copy lands last, so the
  // original's index is the same in both, and `to` is the slot just after it.
  // Equal to the post-append length minus one means it is already there.
  const to = queue.findIndex(x => x.id === tid) + 1;
    const cmds: any[] = [{ type:"addTask", task: copy }];
  if (to < queue.length) cmds.push({ type:"moveTaskInLane", id: id_, toIndex: to });
  const waiting = doc.tasks.filter(t => t.deps.includes(tid)).length;
  // NO OPTIMISTIC APPLY, for the reason spelled out over `swapChannels`: an HTTP
  // command carries no session ref, so the server broadcasts the batch to
  // everyone INCLUDING us and applying it here too would apply it twice. The copy
  // appears when the frames land, and `selectMade` waits for it.
  call("commands", { cmds })
    .then(() => {
      selectMade(id_);
      flash(waiting
        ? `Copied. ${waiting} task(s) still wait on the original only — link them to the copy if you are splitting.`
        : "Copied. Same prerequisites; nothing waits on it yet.");
    })
    // The server's own message, verbatim — same rule as `rollback`.
    .catch(err => flash(err.message, true));
}

// SELECTING SOMETHING A BATCH MADE. A command sent over HTTP has no optimistic
// apply, so the task does not exist at the moment the response resolves — it
// arrives on the broadcast frame, which is a different connection with no
// ordering guarantee against the response. `inspector()` drops a `sel` naming a
// task it cannot find, so setting it early would silently do nothing.
//
// One latch, consumed by whichever frame brings the task in. It is a single
// value rather than a queue because there is one thing on screen to select.
let selectOnArrival: Id | null = null;
function selectMade(tid) {
  if (!doc || !doc.tasks.some(t => t.id === tid)) { selectOnArrival = tid; return; }
  selectOnArrival = null;
  sel = tid;
  render();
  const lab = ($opt("#lab") as HTMLInputElement|null);
  if (lab) { lab.focus({ preventScroll: true }); lab.select(); }
}

function del(tid) {
  const t = taskById(tid); if (!t) return;
  // Dependents are the trap: dropping a task while another still names it in
  // `deps` leaves sched() reading `by[d].dur` off undefined. Strip the id
  // everywhere, and say how many edges went with it — silently deleting a
  // dependency someone argued for is worse than refusing to delete at all.
  const orphans = doc.tasks.filter(x => x.deps.includes(tid)).length;
  // IT SAYS "for everyone" NOW, because that is what changed underneath it. This
  // confirm was written for a tool where a delete sat in your tab until you
  // pressed Save; the removal is a command the server applies and broadcasts the
  // moment you say yes, so it is off everybody's chart before you have let go of
  // the mouse. There is no undo — only Revert, which is a room-wide discard of
  // everything unsaved and not a way to take one delete back.
  if (!confirm(`Delete "${t.label || tid}"?` +
      (orphans ? `\n\n${orphans} other task(s) wait on it — those dependencies are removed too.` : "")
      + `\n\nThis happens immediately, for everyone looking at this plan.`)) return;
  // `removeTask` STRIPS THE ID FROM EVERY OTHER TASK'S `deps` ITSELF — that is
  // half of what the command means, because a plan naming a task that is gone is
  // one `invalid()` refuses to store.
  if (!emit({ type:"removeTask", id: tid })) return;
  sel = null; render();
  flash(`deleted "${t.label || tid}"` + (orphans ? ` and ${orphans} dependency link(s)` : ""));
}
const name = tid => (taskById(tid) || {}).label || tid;

// COUNT AND WEEKS, ALWAYS TOGETHER. "Nine tasks" and "nine weeks of work" are
// different answers to different questions and a room asks both in the same
// breath, so nothing here reports one without the other.
const sumOf = (ts, noun?) => `${ts.length} ${noun ?? `task${ts.length === 1 ? "" : "s"}`} · ${
  durStr(ts.reduce((a, t) => a + remainingOf(t), 0))}`;

// AND HOW MUCH OF IT IS STILL AHEAD OF YOU. `sumOf` counts the document, which
// includes everything already finished — on a plan half-done that headline is a
// number about the past, and the only way to get the one that matters was to
// switch the Done channel off and read the other card.
//
// A SECOND LINE RATHER THAN A MODE, and that is the decision worth keeping. A
// mode is state you have to remember you are in, and a screenshot of one cannot
// be read: "30 days" of what? Both numbers are also real questions asked in the
// same breath — how big is this, and how much is left — which is the same
// argument `sumOf` already makes for never reporting a count without its
// duration. The total staying put is load-bearing besides: the `vs <version>`
// line sits in this card, and a denominator that shrank as you finished work
// would make a comparison against a saved version meaningless.
//
// IN PROGRESS COUNTS AS LEFT. `statusOf` has four values, not two, and a task you are
// halfway through is not one you have finished.
//
// NULL WHERE IT WOULD ONLY REPEAT THE FIRST LINE — nothing done yet, or an empty
// list. Same rule the Selected card already follows by being absent when the
// filter is wide open, and for the same reason: a card saying one thing twice
// makes a reader look for the difference.
const leftOf = ts => {
  const left = ts.filter(t => statusOf(t) !== "done");
  return left.length === ts.length ? null
       : left.length ? sumOf(left, "left")
       // The goal state, and it arrives eventually. "0 left · 0 days" beside a
       // total of 89 reads like something broken rather than like finishing.
       : "all done";
};

function milestoneBar() {
  const bar = $opt("#msbar");
  if (!bar) return;
  const unranked = unrankedCount(), rankedN = rankedTasks(rawDoc()).length;
  const badge = $opt("#otab-unranked");
  if (badge) { badge.hidden = !unranked; badge.textContent = String(unranked); }
  const pastN = pastPlans().length, pastBadge = $opt("#otab-pastn");
  if (pastBadge) { pastBadge.hidden = !pastN; pastBadge.textContent = String(pastN); }
  // What the current filter (and any chain focus) actually selects. The legend's
  // OR-within / AND-across semantics mean this one card answers every "how many
  // are X and Y" combination without a stats panel existing at all.
  const chain = chainFocus && doc.tasks.some(t => t.id === chainFocus)
    ? new Set([chainFocus, ...ancestorsOf(chainFocus), ...descendantsOf(chainFocus)]) : null;
  const picked = doc.tasks.filter(t => (!chain || chain.has(t.id)) && matchesFilter(t));
  const crit = [
    // `chVals`, not `doc[c]`, so a status pick reads "Done" here instead of the
    // raw id — the summary is the one place the filter explains itself.
    ...FILTER_CHANNELS.flatMap(c => [...focus[c]].map(v =>
      (chVals(c).find(x => x.id === v) || {}).label || v)),
    ...(queryText() ? [`matching “${query.trim()}”`] : []),
    ...(chain ? [`chain of “${name(chainFocus)}”`] : []),
  ];
  // EVERY DERIVED NUMBER IS COMPUTED HERE, not in the component. `MilestoneBar`
  // is presentation and takes no domain type but `Id`, so it cannot compute a
  // date and therefore cannot disagree with the chart about one — the whole
  // reason the scheduler has one copy (ADR 0001) applied one level down.
  const chips: MilestoneChip[] = doc.milestones.map(m => {
    const w = dayOf(m.date), f = milestoneFinish(m.id);
    const sl = f == null ? null : w - f;
    return {
      id: m.id,
      label: m.label,
      date: m.date,
      tone: sl == null ? "empty" : sl > 1e-9 ? "ok" : sl < -1e-9 ? "late" : "tight",
      verdict: sl == null ? "no work assigned"
        : sl > 1e-9 ? `${calStr(sl)} to spare`
        : sl < -1e-9 ? `misses by ${calStr(-sl)}` : "exactly on time",
      ends: f == null ? "—" : "work ends " + fmtEndAt(f),
      tasks: doc.tasks.filter(t => msOf(t) === m.id).length,
      binding: m.id === BINDING && doc.milestones.length > 1,
      on: focus.milestones.has(m.id),
    };
  });
  const sug = nudge ? (nudge.suggestions || []) : [];
  // Lanes the search declined to look at. Empty on this path now that the page
  // lifts the cap, but the server fallback still has one — and a skip nobody can
  // see is the bug this chip was just fixed for.
  const skipped: { tasks: number }[] = nudge ? (nudge.skipped || []) : [];
  // A MILESTONE IS DOCUMENT FURNITURE, so editing one is a `patchDoc` — and it
  // sends the WHOLE list, because `patchDoc` shallow-merges the document and a
  // write nested inside one entry would not survive the wire.
  const patchMs = (mid: Id, patch: Record<string, unknown>) => emit({ type:"patchDoc", patch: { milestones:
    doc.milestones.map(m => m.id === mid ? { ...m, ...patch } : { ...m }) } });
  mountMilestoneBar(bar, {
    chips,
    whole: sumOf(doc.tasks),
    wholeLeft: leftOf(doc.tasks),
    compare: CMP ? cmpLabel() : null,
    // The card is a duplicate of "Whole plan" when nothing is picked, so it is
    // absent rather than empty.
    selected: crit.length
      ? { total: sumOf(picked), left: leftOf(picked), criteria: crit.join(" · ") }
      : null,
    lastSave: lastSave ? { ago: agoStr(lastSave.at), note: lastSave.note || null } : null,
    // SHOWN WHILE IT IS WORKING, TOO. `nudgeCount()` alone hid the chip until an
    // answer existed, which was right when the answer took 23 seconds on somebody
    // else's machine — there was nothing useful to say about a request in flight
    // to a server. Now it runs here and takes about two seconds, and two seconds
    // of nothing is how a reader concludes a panel is broken.
    //
    // ...AND ONCE IT HAS AN ANSWER, WHATEVER THE ANSWER IS. `nudgeCount()` hid
    // the chip whenever the search had nothing to suggest, which made three
    // different states look identical from outside: not run, run and found
    // nothing, and declined to run. The one state a passive nudge was designed
    // to stay quiet about is the middle one — but paying for the other two with
    // the same silence is what sent the author looking for a control that was
    // never going to appear. A chip that says "nothing to improve" is one line
    // of chrome and answers the question every time it is asked.
    // AUTO-ORDER TAKES THE QUESTION AWAY: the server settles the order after
    // every change, so there is no advice to give and no chip to show.
    // ALWAYS THERE while there is anything to rank (Rascal Two, 2026-09-26): the ranking is
    // an input to the order that only a person can give, so the chip that opens it must
    // not depend on whether the date search has advice. Its badge counts the unfinished
    // tasks the ranking has not placed yet.
    // AUTO-ORDER TAKES THE DATE QUESTION AWAY — the server settles the order after every
    // change — so there the chip speaks only for the ranking.
    // AND WHILE A PAST PLAN WAITS FOR AN ANSWER (ADR 0020), whatever the search says: that question is the person's too.
    order: rankedN < 2 && !pastN && (doc.autoOrder === true || (!nudge && !nudgeBusy)) ? null
      : doc.autoOrder === true || (!nudge && !nudgeBusy) ? {
      headline: doc.autoOrder === true ? "Auto-order on" : "Review",
      detail: pastN ? `${pastN} past plan${pastN === 1 ? "" : "s"} · Review` : unranked ? `${unranked} unranked · Rank` : "ranked · Review",
      // BUSY UNTIL THE FIRST SEARCH ANSWERS, with Auto-order off: the date advice is
      // coming, and a chip that looks settled before it arrives reads as "nothing to
      // move". A search that failed says nothing, as before, so it stops spinning.
      stale: false, busy: doc.autoOrder !== true && !PLAY && nudgeSig === "" && !nudgeFailed,
      ms: null, unranked, past: pastN,
    } : {
      headline: sug.length ? `${sug.length} row${sug.length === 1 ? "" : "s"} could move`
                           : skipped.length ? "Not searched"
                           : nudge?.lanes?.changed ? "Teams out of order"
                           : "Order looks fine",
      detail: sug.length ? (sug[0].ranked ? (sug[0].paused ? "puts paused work first · Review" : sug[0].suggested ? "matches the suggested order · Review" : "matches your ranking · Review") : `best saves ${calStr(sug[0].gain)} · Review`)
                         : skipped.length
                           ? `${skipped[0].tasks} rows in one team · Review`
                         : nudge?.lanes?.changed ? "a team sits above one it waits on · Review"
                         // NOT "shortens" ANY MORE. The search scores lateness as
                         // well as the finish date now, so a plan can be perfectly
                         // short and still be missing three deadlines — and this
                         // line was the sentence claiming otherwise.
                         : "no move improves the plan · Review",
      stale: nudgeDirty,
      busy: nudgeBusy,
      // `Infinity` means the search could not be done here at all and the server
      // answered — there is no local duration to size a bar with.
      ms: lastReorderMs != null && isFinite(lastReorderMs) ? lastReorderMs : null,
      unranked, past: pastN,
    },
    // NO `keep` SELECTOR ON THE LABEL ANY MORE. It named a control to re-focus
    // after the rebuild every keystroke caused; React reuses the same <input>,
    // so the caret never leaves it. A refusal still puts the document's own text
    // back, because the component is controlled and `emit` applied nothing.
    onLabel: (mid, value) => patchMs(mid, { label: value }),
    onDate:  (mid, value) => patchMs(mid, { date: value }),
    onDelete: delMilestone,
    // Same two lenses as the legend: dim greys the rest, isolate drops them and
    // therefore has to rebuild the rows.
    onPick: mid => {
      focus.milestones.has(mid) ? focus.milestones.delete(mid) : focus.milestones.add(mid);
      focusMode === "isolate" ? render() : applyFilter();
    },
    onAdd: addMilestone,
    onOpenHistory: openHistory,
    onOpenReorder: openReorder,
    onRecheckOrder: recheckOrder,
  });
}

// ---- is this plan in the right order? --------------------------------------
// A PASSIVE NUDGE, AND IT HAD TO BE ONE. Both halves of "which order" were
// already written and neither was reachable from the chart: `laneOrder` had a
// button buried in Settings -> Channels that you had to know existed, and
// `suggestReorders` had nothing at all. So the chart could be weeks wrong with
// every duration and every dependency correct, and say nothing.
//
// It is a chip, not a notification, and it applies nothing. See the note on the
// panel markup and the longer one in schedule.js: the objective function knows
// finish dates and does not know why a spike is where it is.
//
// COMPUTED ON THE SERVER, which is the only reason this is affordable. The cost
// is O(lane^2) full schedules per lane, and that is not a figure of speech —
// measured on this scheduler, a 4x20 plan is 570ms and a 4x40 plan is 7.3s. On
// the main thread that is not a slow nudge, it is a frozen tab, and no amount of
// debouncing fixes a synchronous seven seconds. `/api/reorder` already returns
// exactly this (both axes, one call) and already runs the same shared scheduler,
// so the work happens where a long answer costs nobody a dropped frame.
//
// `laneOrder` is the exception and stays local: it is a search over lanes, not
// tasks, and it is sub-millisecond on any plan anyone has built. It comes back
// in the same response anyway; computing it here as well would be a second
// implementation of nothing.
let nudge: any = null;          // the last answer, or null for "nothing to say"
let nudgeStale = "";       // the moved task's LABEL while the answer on screen is
                           // known to be out of date; "" means the panel is live. It
                           // held a sentence with markup in it until the React port.
let nudgeSig = "";         // the plan that answer belongs to
let nudgeTimer = 0, nudgeBusy = false, nudgeFailed = false;
// THE PLAN HAS MOVED SINCE THE ANSWER ON SCREEN WAS COMPUTED, and on an expensive
// plan we are NOT going to recompute it just because somebody dragged a bar. See
// `scheduleNudge`.
let nudgeDirty = false;
// RUN TO CONVERGENCE, one measured move at a time.
//
// `onApply`'s note is the objection to beat, and it is a good one: every entry
// in the list was scored against the order that was current when the list was
// built, so the SECOND one is already describing a plan that no longer exists.
// Applying the list wholesale would take nine stale opinions on trust.
//
// This does not do that. It applies the current TOP suggestion, waits for the
// recompute, and then applies whatever is top of the NEW list — so every move is
// measured against the order it actually lands on, which is exactly the
// guarantee clicking Apply nine times by hand gives. The only thing being
// automated is the clicking.
let applyAll = false, applied = 0;
// A CAP, BECAUSE "GAIN > 0" IS NOT THE SAME AS "CONVERGES". Two moves can each
// improve on the order in front of them and swap back and forth; nothing in the
// scorer forbids it. A recompute is 1.5-4s here, so an unbounded loop is minutes
// of unasked-for edits to a shared document. It stops and says so instead.
const APPLY_MAX = 40;
/** A recompute the user asked for, which is allowed to be expensive. */
let nudgeForce = false;
// THE ANSWER ON SCREEN IS KNOWN TO BE OUT OF DATE. Applying a move invalidates
// every remaining suggestion — each was measured against the order that was
// current when the list was built — so between the click and the new answer the
// panel is showing numbers that are already wrong.
//
// It used to handle that by throwing the answer away, which made the panel fall
// back to its empty state: "Nothing to move — every queue is already in the order
// that finishes soonest", with "Recomputing the rest..." inserted directly above
// it. Two claims, one of them false, and the false one is the reassuring one. On
// a plan big enough to compute server-side that is a visible pause spent reading
// that the work is done.
//
// So the rows stay, greyed and unclickable, and say what they are.

// ONLY WHAT THE SCHEDULER READS. Renaming a task or recolouring it cannot change
// which order is best, and hashing the whole document would spend a round trip
// on every keystroke in the inspector. A field missed here costs a stale chip,
// never a wrong move: applying re-reads the live document and the answer is
// recomputed straight after.
const orderSig = (d = rawDoc()) => orderSignature(d);   // shared: the server's Auto-order asks the same question

// WHAT THE SEARCH WILL COST, in the only unit that predicts it: one full
// schedule per (from, to) pair per lane, and a schedule is linear in the plan.
// So `sum(lane_size^2) * tasks` — and measured on this scheduler that lands
// within a factor of two of ~300 units per millisecond across the whole range
// worth caring about (3.4k units = 12ms, 16k = 52ms, 44k = 152ms).
const reorderUnits = (d = rawDoc()) => {
  if (!d || !d.tasks) return Infinity;
  const per: Record<string, number> = {};
  for (const t of d.tasks) per[t.lane] = (per[t.lane] || 0) + 1;
  return Object.values(per).reduce((a: number, n: any) => a + n * n, 0) * d.tasks.length;
};
// ~65ms at 300 units/ms. Above this the answer is worth having and not worth
// blocking a keystroke for, so it goes to the server instead.
const LOCAL_BUDGET = 20000;
/** How long the last search took ON THIS MACHINE, in ms. `Infinity` means it
 *  could not be done here at all and the server answered instead. */
let lastReorderMs: number | null = null;
/** Under this, the panel keeps itself current instead of asking to be asked.
 *  Above it, an edit marks the answer stale — the behaviour every plan used to
 *  get, now reserved for the devices that need it. */
const AUTO_MS = 3000;
/** Something has to give up before a reader concludes the panel is broken.
 *  Twenty times slower than a current laptop is 41s on the real plan. */
const LOCAL_TIMEOUT_MS = 45000;

/** Debounced. Small plans are computed here, big ones on the server, and the
 *  fixture — which has no token to ask with — is therefore still covered as long
 *  as it stays small, which is what a fixture is for. */
function scheduleNudge() {
  clearTimeout(nudgeTimer);
  // NEVER DURING PLAYBACK. Two reasons, and the second is the expensive one.
  //
  // A queue-order suggestion about an ARCHIVED document is advice nobody can
  // take: the version is read-only and `emit` refuses while playing, so the
  // panel would offer a move that cannot be made.
  //
  // And it is not free to ask. `orderSig()` changes on every version, so
  // stepping through a history would fire one of these per save — and on a plan
  // past LOCAL_BUDGET each is a `/api/reorder` that occupies the server for a
  // minute and a half (measured, 2026-09-05). Playback is a read; it must not
  // cost the room anything.
  if (PLAY || doc?.autoOrder === true) return;   // the server does this search itself
  nudgeTimer = setTimeout(async () => {
    const sig = orderSig();
    if (nudgeBusy || sig === nudgeSig) return;
    const local = reorderUnits() <= LOCAL_BUDGET;
    // ONCE PER SESSION ON AN EXPENSIVE PLAN, NOT ONCE PER EDIT.
    //
    // This function is called from `render()`, which is every edit. On a plan
    // small enough to answer locally that is free and the panel stays live. On a
    // plan that has to ask the server it is not: measured on the real 135-task
    // plan, one answer is 23 SECONDS of a single worker thread. Firing that after
    // every drag means five bars moved in a meeting is five of them queued back
    // to back, and the last answer describes a plan five edits old.
    //
    // Nobody noticed before 2026-09-07 because every one of those requests timed
    // out at the gateway and the answer was discarded. Making it work is what
    // made the waste visible.
    //
    // So: the first answer of a session is computed, and after that an edit marks
    // the answer STALE rather than replacing it. The chip says so and offers to
    // check again. Queue order is not something that changes under you — it
    // changes because you changed it — so "the advice you are looking at predates
    // your last edit" is a true and useful thing to say, and much cheaper than
    // pretending to be live.
    // MEASURED, NOT PREDICTED, and that is the change. This used to ask
    // `reorderUnits() <= LOCAL_BUDGET` — a cost MODEL with a hand-tuned constant
    // — and route a plan over the line to a server that took 23 seconds over it.
    // The model was not even wrong: it says ~300 units/ms and the browser
    // measures 211. What was wrong was the destination.
    //
    // So the page runs it here, in a thread, and remembers how long THIS machine
    // took. A device that answers in under `AUTO_MS` gets a fresh answer after
    // every edit; a slower one keeps the old behaviour of marking the answer
    // stale and offering to check again. Nobody has to predict anything: the
    // first run is the measurement.
    if (lastReorderMs != null && lastReorderMs > AUTO_MS && !nudgeForce && nudge) {
      nudgeDirty = true;
      milestoneBar();
      if (!$("#reorder").hidden) reorderPanel();
      // STALE, BUT NOT UNTIL YOU CLICK. The search runs in a worker, so what a
      // slow plan cannot afford is not one run but one run PER EDIT. So it
      // waits for the edits to stop — `QUIET_MS` with no change to what the
      // scheduler reads — or for you to leave the tab, whichever comes first.
      // Only a CHANGED plan resets the wait; a render for a selection does not.
      // Already away (an agent editing while you are in another tab): nobody is
      // mid-burst, and a hidden tab's timers are throttled anyway, so go now.
      if (document.hidden || !document.hasFocus()) { recheckIfStale(); return; }
      if (sig !== quietSig) {
        quietSig = sig;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(recheckIfStale, QUIET_MS) as unknown as number;
      }
      return;
    }
    nudgeForce = false;
    clearTimeout(quietTimer);
    // WHAT WAS ASKED ABOUT, taken before the work. On a slow plan a run is
    // seconds long, and an edit landing inside it must not be marked answered.
    const asked = orderSig();
    let moved = false;
    nudgeBusy = true;
    milestoneBar();                       // the chip says it is working
    try {
      // THIS MACHINE FIRST. Measured on the real 135-task plan through the same
      // `/schedule.js`: 1.8s in a browser, 23s on the server — which is not a
      // slow function but the smallest container AWS sells, a quarter of one
      // core, against a laptop sitting idle. It holds until the client is about
      // thirteen times slower than a current laptop.
      //
      // BOTH ROUTES RETURN THE SAME SHAPE — the worker assembles exactly what
      // `/reorder` assembles — so the fallback needs no second reader.
      try {
        // NO LANE CAP ON THIS PATH. `suggestReorders` skips any lane over 40 by
        // default — a guard against a quadratic search, written when the search
        // ran on the server. Off the main thread that constant is the wrong
        // shape of protection: it is a PREDICTION, and this file already threw
        // out the other prediction (`LOCAL_BUDGET`) for the same reason. The
        // real guard is `LOCAL_TIMEOUT_MS`, which measures instead of guessing.
        //
        // WHAT IT COST TO LEARN THIS: a one-lane 81-task plan — the author's own
        // — was silently never searched, and the chip that would have said so
        // only renders when there is a suggestion, so the feature read as "your
        // plan is already optimal" for weeks. Measured after lifting the cap:
        // 1.36s in node for that plan, against a 45s ceiling.
        //
        // THE SERVER FALLBACK KEEPS ITS 40. It is reached only when this path
        // already failed or timed out — precisely the plan you would not want to
        // hand a shared worker unbounded — and it reports what it skipped, which
        // the chip now shows.
        const got = await localReorder(rawDoc(), 8, LOCAL_TIMEOUT_MS, Infinity);
        nudge = got.out;
        lastReorderMs = got.ms;
      } catch {
        // A DEVICE TOO SLOW, A THREAD THAT DIED, OR A PLAN THAT WILL NOT
        // SCHEDULE. All three are answered the same way, and the server is still
        // there — it is just no longer the default.
        lastReorderMs = Infinity;
        nudge = (!shareToken() || id === "demo") ? null : await call("reorder?limit=8");
      }
      // THE ANSWER DESCRIBES THE PLAN THAT WAS ASKED ABOUT, so that is the
      // signature it is filed under. If an edit landed mid-flight the two differ,
      // and filing it under the current plan would mark a stale answer fresh —
      // on a plan where one run is tens of seconds, that edit would never be
      // checked. `moved` sends it round again instead.
      nudgeSig = asked;
      nudgeFailed = false;
      moved = orderSig() !== asked;
    } catch {
      // A nudge that cannot be computed says nothing. It is an optional opinion
      // about the plan, not a feature anyone is waiting on, so a failed fetch
      // must not put an error banner over someone's chart.
      nudge = null;
      nudgeFailed = true;
    } finally {
      nudgeBusy = false;
      nudgeStale = "";
      nudgeDirty = false;
      // THE WHOLE ROW, NOT JUST THE CHIP. `reorderChip()` used to splice one
      // node in and out of `#msbar` by hand — `querySelector('.ms.reord')?.remove()`
      // then `appendChild` — because rebuilding the row would have destroyed the
      // live <input>s in every milestone chip. React owns that container now, so
      // the honest call is "draw the row again" and the reconciler touches the one
      // card that changed.
      milestoneBar();
      if (!$("#reorder").hidden) reorderPanel();
      // THE NEXT MOVE, NOW THAT THERE IS A FRESH ANSWER TO PICK IT FROM. Driven
      // from here rather than from a timer in the panel: this is the one place
      // that knows an answer has actually arrived, and a loop that guessed at
      // the timing would be applying stale advice again by another route.
      if (applyAll) applyNextSuggestion();
      // EDITED WHILE IT RAN: go round again, which on a slow plan means "stale,
      // and wait for quiet". Only after a real answer — a failure has not
      // stamped `nudgeSig`, and retrying on that would loop.
      else if (moved) scheduleNudge();
    }
  }, 700);
}

/** How long a slow plan waits after the last edit before re-checking by itself. */
const QUIET_MS = 10000;
let quietTimer = 0, quietSig = "";
/** Re-check only if the answer on screen is known to be out of date, so it is
 *  free to call from every blur. */
function recheckIfStale() {
  if (nudgeDirty && !nudgeBusy && !PLAY) recheckOrder();
}
// LEAVING THE TAB IS THE BEST TIME TO RUN IT — nobody is waiting on the answer
// and nobody is about to invalidate it.
addEventListener("blur", recheckIfStale);
document.addEventListener("visibilitychange", () => { if (document.hidden) recheckIfStale(); });

/** One step of Apply all: take the best move on the CURRENT list, or stop. */
function applyNextSuggestion() {
  if (!applyAll) return;
  const sg = (nudge?.suggestions || [])[0];
  if (!sg) return stopApplyAll(applied ? `Applied ${applied} move${applied === 1 ? "" : "s"} — nothing left to improve.`
                                       : "Nothing to apply.");
  if (applied >= APPLY_MAX)
    return stopApplyAll(`Stopped after ${APPLY_MAX} moves. There is still advice on the list — `
                        + "press Apply all again if that is what you want.");
  applied++;
  applyOneSuggestion(sg);
}

function stopApplyAll(msg?: string) {
  applyAll = false; applied = 0;
  if (msg) flash(msg);
  milestoneBar();
  if (!$("#reorder").hidden) reorderPanel();
}

/** The body of a single Apply, shared by the button and the loop so the two
 *  cannot drift into applying moves by different rules. */
function applyOneSuggestion(sg: any) {
  if (!emit({ type: "moveTaskInLane", id: sg.id, toIndex: sg.to })) { stopApplyAll(); return; }
  // `nudgeSig` is what forces the recompute; the answer itself is KEPT so the
  // panel has something to grey out instead of collapsing to "nothing to move".
  nudgeSig = "";
  nudgeStale = sg.label;
  // A LOOP MAY NOT WAIT FOR THE "ask me again" GATE. On a device slower than
  // `AUTO_MS` an edit marks the answer stale instead of recomputing, which would
  // stall Apply all on its first move — so each step asks for the recompute the
  // way the Check again button does.
  if (applyAll) nudgeForce = true;
  reorderPanel();
  scheduleNudge();
}

// LANE ORDER IS ADVICE ABOUT WHERE A TEAM'S BLOCK SITS, and date mode has no
// team blocks — so there it is a button that reorders something you cannot see,
// and a count that inflates the chip offering it. ONE predicate, because the
// chip and the panel both ask and a version of this that only silenced the panel
// would leave a chip advertising a row that is not there.
//
// The TASK suggestions stay live, and that is not an inconsistency with the
// dead ↑/↓ buttons. Those are positional — you push a row and it does not go
// where you pushed it. A suggestion is semantic: it says "saves 12 days", and
// its whole effect is the dates moving, which is the one thing date mode shows
// better than team mode does.
/** WHAT A SUGGESTION ACTUALLY BUYS, named from the term that improved most.
 *  A milestone id falls through to the milestone's own label, because the score
 *  carries one entry per milestone and they are the plan's words, not ours. */
function gainPhrase(gains: Record<string, number>): string {
  let key = "", best = -Infinity;
  for (const [k, v] of Object.entries(gains || {})) if (v > best) { best = v; key = k; }
  if (key === "finish") return "the plan finishes sooner";
  if (key === "tardy") return "a deadline stops being missed";
  if (key === "tight") return "breathing room before a deadline";
  const m = (doc.milestones || []).find(x => x.id === key);
  return m ? `${m.label} lands sooner` : "a better order";
}

/** WHAT THE "check again" CONTROL DOES. `nudgeSig` is cleared so the guard at the
 *  top of `scheduleNudge` does not decide the answer is already current, and
 *  `nudgeForce` says this one was asked for rather than triggered by an edit. */
function recheckOrder() {
  nudgeSig = "";
  nudgeForce = true;
  scheduleNudge();
  milestoneBar();
  if (!$("#reorder").hidden) reorderPanel();
}

const laneSortOffered = () =>
  ROWMODE !== "date" && !!(nudge && nudge.lanes && nudge.lanes.changed);
const nudgeCount = () => (nudge ? (nudge.suggestions || []).length + (laneSortOffered() ? 1 : 0) : 0);

// ---- the review panel ------------------------------------------------------
function reorderPanel() {
  const body = $opt("#reorder-body");
  if (!body) return;
  // `nudgeStale` was a sentence with `<b>` in it, built here and assigned through
  // `innerHTML`. It is the moved task's name now, and the panel says the sentence.
  mountReorderPanel(body, {
    empty: !nudgeCount(),
    staleAfter: nudgeStale || null,
    outOfDate: nudgeDirty,
    onRecheck: recheckOrder,
    laneSort: laneSortOffered() ? { was: nudge.lanes.was, backward: nudge.lanes.backward } : null,
    suggestions: (nudge?.suggestions || []).map((sg: any) => ({
      id: sg.id, label: sg.label, from: sg.from, to: sg.to,
      after: sg.after ? (name(sg.after) || sg.after) : null,
      worsens: !!sg.worsens,
      // A RANKING MOVE CHANGES NO DATE: its number is ranked pairs put in order.
      gain: sg.ranked ? `${sg.ranked} pair${sg.ranked === 1 ? "" : "s"}` : calStr(sg.gain),
      // WHICH OBJECTIVE THE NUMBER IS. There is one term in this score per
      // question the plan can be asked, and "+0.72d" means something different
      // for each of them — days off the finish date, days of lateness removed,
      // days of breathing room bought, or a milestone pulled in. One bare
      // number for four meanings was survivable while there were two.
      bought: sg.ranked ? (sg.paused ? "puts paused work first — no date changes" : sg.suggested ? "matches the suggested order — no date changes" : "matches your ranking — no date changes") : gainPhrase(sg.gains),
    })),
    skipped: (nudge?.skipped || []).map((k: any) => ({ lane: laneLabel(k.lane), tasks: k.tasks })),
    onSortLanes: () => { applyLaneOrder(); closeReorder(); },
    // ONE MOVE, THEN ASK AGAIN — still true of a single click. Every entry was
    // measured against the order that was current when the list was built, so
    // the second one on the list is already talking about a plan that no longer
    // exists. Apply all does not break that rule; it re-reads the list after
    // every move rather than walking down a stale one.
    onApply: i => {
      const sg = nudge.suggestions[i];
      if (sg) applyOneSuggestion(sg);
    },
    applying: applyAll ? applied : null,
    onApplyAll: () => { applyAll = true; applied = 0; applyNextSuggestion(); },
    onStopApplyAll: () => stopApplyAll(applied
      ? `Stopped. ${applied} move${applied === 1 ? "" : "s"} applied and kept.`
      : "Stopped."),
  });
}

/** WHICH TEAM GOES ON TOP, applied. Shared by the Settings button and the Order
 *  panel — see the note beside `#sortlanes`. Cheap enough to recompute at the
 *  moment of the click rather than trusting the number the panel drew, which may
 *  be a few seconds old by the time anyone reads it. */
function applyLaneOrder() {
  if (!onAPlan()) return;
  // The RAW document: laneOrder structuredClones what it is given, and
  // structuredClone refuses a Proxy outright. See rawDoc().
  const r = laneOrder(rawDoc());
  if (!r.changed) {
    flash(r.total
      ? `Already in the best order — ${r.backward} of ${r.total} dependencies point up, and no arrangement does better.`
      : "Nothing to sort by: no dependency crosses a team.");
    return;
  }
  const by = Object.fromEntries(doc.lanes.map(l => [l.id, l]));
  emit({ type:"patchDoc", patch: { lanes: r.order.map(id => ({ ...by[id] })) } });
  flash(`Sorted: dependencies pointing up ${r.was} of ${r.total} -> ${r.backward}.`);
}

// ---- the ranking -------------------------------------------------------------
// "WHICH SHOULD HAPPEN FIRST?", asked a pair at a time with @rascaltwo/pairwise-sorter's
// own elements. Only the ANSWERS are stored (`doc.rankLog`); the order is derived from
// them by `rankOf` in commands.js — the same library, vendored there — so this tab, the
// server and Auto-order can never disagree about it. This sorter is a view onto that
// log: an answer here becomes `addRankAnswer`, an undo or a delete `removeRankAnswer`,
// and anything that changes the ranked tasks or their answers re-opens it.
const rankSigOf = () => {
  const d = rawDoc();
  return JSON.stringify([rankedTasks(d).map(t => [t.id, t.label]), rankLogOf(d)]);
};
/** The sorter's list: the ranked tasks in the arrival order `rankOf` replays in,
 *  identified by task id (`key`) so a rename keeps every answer. */
const rankList = () => {
  const d = rawDoc();
  // WITH WHAT THE DEPENDENCIES SETTLE, so a pair where one task waits on the other is never
  // asked — see `rankLogOf`. Those arrive marked implied and are never sent back.
  return { ...emptyList("Rank"), log: rankLogOf(d),
           items: rankedTasks(d).map(t => item(t.label || t.id, "", [], "", [], t.id)) };
};

/** What the sorter holds that the document does not, as commands. */
function pushRankAnswers() {
  if (!rankSorter) return;
  const theirs = new Map<string, number>(((rawDoc() as any).rankLog || []).map(([k, v]: [string, number]) => [k, v]));
  // An implied answer the document does not hold is one the dependencies worked out.
  const mine = new Map(rankSorter.list.log.filter(([k, , implied]) => !implied || theirs.has(k)).map(([k, v]) => [k, v]));
  const pair = (k: string) => k.split("\u0001") as [Id, Id];
  for (const [k, v] of mine) if (theirs.get(k) !== v) {
    const [a, b] = pair(k);
    emit({ type: "addRankAnswer", a, b, verdict: v } as Command);
  }
  for (const k of theirs.keys()) if (!mine.has(k)) {
    const [a, b] = pair(k);
    emit({ type: "removeRankAnswer", a, b } as Command);
  }
  rankSig = rankSigOf();
}

/** WHAT THE AI THINKS OF EACH TASK IN THE PAIR ON SCREEN, drawn under its card while the person
 *  answers pairs themselves: where a suggestion put it, and why. The side it ranks higher
 *  gets a visibly different box. It informs; the answer is theirs, and the suggestion needs no other
 *  controls on the page — it orders the queue beneath their answers by itself. Inline styles, because
 *  the card lives in the sorter's shadow root and the page's stylesheet does not reach it. Built with
 *  `textContent`: the reasons are somebody else's words. */
function aiNote(key: Id | undefined, box: HTMLElement) {
  const d = rawDoc(), s = d.rankSuggestion, q = rankSorter?.question;
  if (!s || !key || !q) return;
  const items = rankSorter!.list.items;
  const here = [q.a, q.b].find(i => items[i]?.key === key), other = [q.a, q.b].find(i => i !== here);
  const { rank } = suggestedRankOf(d);
  const mine = rank.get(key), theirs = other === undefined ? undefined : rank.get(items[other]!.key as Id);
  if (mine === undefined) return;
  const preferred = theirs !== undefined && mine < theirs;
  const note = document.createElement("div");
  note.className = "rk-ai";
  note.dataset["preferred"] = preferred ? "1" : "0";
  note.style.cssText = "margin-top:8px;padding:8px 10px;border-radius:6px;font-size:13px;line-height:1.4;" + (preferred
    ? "border:2px solid var(--pw-accent);background:color-mix(in srgb, var(--pw-accent) 18%, transparent)"
    : "border:1px solid var(--pw-border);background:transparent");
  const head = document.createElement("div");
  head.textContent = `${s.by === ME ? "You" : "AI"}: #${mine} of ${rank.size}`;
  head.style.fontWeight = "600";
  const why = document.createElement("div");
  why.textContent = s.notes[key]?.why || "";
  why.style.color = "var(--pw-muted)";
  note.append(head, why);
  box.after(note);
}

/** A BOX TO SUGGEST AN ORDER FROM THE PAGE: one task per line, first to happen first — its id or its exact
 *  title, then optionally " — a reason". The person's own order versus a suggested one: this is how a person
 *  writes the second kind (an agent sends `setRankSuggestion` itself). Nothing happens to their answers; it
 *  becomes the backdrop beneath them. A line that matches no task stops the whole thing and is named. */
function suggestBox(): HTMLElement {
  const top = document.createElement("div");
  top.id = "rk-top";
  const box = document.createElement("details");
  box.id = "rk-suggest"; box.className = "rk-suggest";
  const mk = (tag: string, text = "") => { const e = document.createElement(tag); if (text) e.textContent = text; box.append(e); return e; };
  mk("summary", "Suggest an order…");
  mk("p", "One task per line, first to happen first: its id or its exact title, then optionally “ — why”. " +
    "It orders what you have not answered; your own answers always win.").className = "hint";
  const ta = mk("textarea") as HTMLTextAreaElement;
  ta.id = "rk-suggest-text"; ta.rows = 6;
  const go = mk("button", "Suggest") as HTMLButtonElement;
  go.id = "rk-suggest-go";
  go.onclick = () => {
    const tasks = rankedTasks(rawDoc());
    type Stored = (typeof tasks)[number];
    const byId = new Map<string, Stored>(tasks.map(t => [t.id, t]));
    const byTitle = new Map<string, Stored>(tasks.map(t => [(t.label || "").trim().toLowerCase(), t]));
    const find = (x: string) => byId.get(x.trim()) ?? byTitle.get(x.trim().toLowerCase());
    const order: { id: Id; why: string }[] = [], lost: string[] = [];
    for (const raw of ta.value.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      // The whole line may be a title (which can hold colons and dashes); otherwise the task ends at the first
      // spaced dash or colon that leaves a task on its left, and the rest is the reason.
      let task = find(line), why = "";
      for (const m of line.matchAll(/\s[—–-]\s|:\s/g)) {
        if (task) break;
        task = find(line.slice(0, m.index));
        if (task) why = line.slice(m.index! + m[0].length).trim();
      }
      if (task) order.push({ id: task.id, why: why || "suggested order" }); else lost.push(line);
    }
    if (lost.length) return flash(`No such task: ${lost.slice(0, 3).join(" | ")}${lost.length > 3 ? " …" : ""}`, true);
    if (order.length < 2) return flash("Suggest at least two tasks.", true);
    emit({ type: "setRankSuggestion", by: ME, order });
    ta.value = ""; box.open = false;
  };
  // THE ONE CONTROL A SUGGESTION HAS: whether it steers Auto-order (`useRankSuggestion`, on unless the plan
  // says false). Shown only while there is a suggestion to steer with; `syncSteer` keeps it true to the plan.
  const steer = document.createElement("label");
  steer.id = "rk-steer-row"; steer.className = "rk-steer"; steer.hidden = true;
  const check = document.createElement("input");
  check.type = "checkbox"; check.id = "rk-steer";
  check.onchange = () => emit({ type: "patchDoc", patch: { useRankSuggestion: check.checked } });
  steer.append(check, " Use the suggested order to arrange Auto-order");
  top.append(box, steer);
  return top;
}

/** Make the switch say what the plan says, and show it only while there is a suggestion. */
function syncSteer() {
  const row = $opt("#rk-steer-row"), box = $opt<HTMLInputElement>("#rk-steer");
  if (!row || !box) return;
  const d = rawDoc();
  row.hidden = !d.rankSuggestion;
  box.checked = d.useRankSuggestion !== false;
}

/** The suggestion the Rank tab last drew, so the pair on screen is redrawn when it changes. */
let suggSig = "";
function redrawOnSuggestion() {
  syncSteer();
  const s = rawDoc().rankSuggestion, sig = s ? `${s.by}|${s.at}|${s.order.join(",")}` : "";
  if (sig !== suggSig) { suggSig = sig; ($opt("#rank-body pairwise-compare") as any)?.render?.(); }
}

function rankPanel() {
  const body = $("#rank-body");
  if (!rankSorter) {
    body.innerHTML = `<div class="rk-grid">
      <div><div class="hint" style="margin:0 0 8px">Which of these should happen first? Answer with
        <b>←</b> / <b>→</b>, or <b>↓</b> if they are equal. Auto-order uses the result only to
        break ties once the dates are equal — it never makes anything later.</div>
        <pairwise-compare></pairwise-compare><pairwise-progress style="margin-top:12px"></pairwise-progress></div>
      <div class="rk-side"><h3>Your ranking so far</h3><pairwise-ranking></pairwise-ranking>
        <details><summary>Your answers</summary><pairwise-conflicts></pairwise-conflicts></details></div>
    </div>`;
    body.prepend(suggestBox());
    const cmp = body.querySelector("pairwise-compare") as any;
    // EACH SIDE IS THE TASK AS THE INSPECTOR SHOWS IT, read-only — see TaskCard.tsx.
    cmp.renderItem = (it: { key?: string; title: string }, box: HTMLElement) => {
      const task = inspectorTaskOf(it.key ?? null);
      if (task) mountTaskCard(box, task); else box.textContent = it.title;
      aiNote(it.key, box);
    };
    // An item's ✎ opens the real Inspector on that task.
    body.addEventListener("pairwise-edit", e => {
      const key = rankSorter?.list.items[(e as CustomEvent).detail.index]?.key;
      if (key) { closeReorder(); pick(key); }
    });
    rankSorter = new Sorter(rankList());
    rankSig = rankSigOf();
    rankSorter.addEventListener("change", pushRankAnswers);
    for (const el of body.querySelectorAll("pairwise-compare, pairwise-progress, pairwise-ranking, pairwise-conflicts"))
      (el as any).sorter = rankSorter;
    redrawOnSuggestion();
    return;
  }
  const sig = rankSigOf();
  if (sig !== rankSig) { rankSig = sig; rankSorter.open(rankList()); }
  redrawOnSuggestion();
}

/** How many unfinished tasks the ranking has not placed yet. */
const unrankedCount = () => rankOf(rawDoc()).unranked.length;

// ---- past plans (ADR 0020) ---------------------------------------------------
// A PLANNED STRETCH THAT IS OVER, ON A TASK THAT IS NOT FINISHED, IS A QUESTION: did it happen? The clock never answers it
// (ADR 0017), so it waits here, oldest first, as soon as it ends. Page only, existing commands, nothing stored.
const pastPlanOf = (t: Task, index: number): PastPlan => {
  const x = t.planned![index]!, day = Math.floor(x.start + 1e-9);
  return { id: t.id, index, label: t.label, when: `${fmtAt(x.start)} – ${clkOn(x.stop, day)}`,
           start: isoTimeOf(x.start), stop: isoTimeOf(x.stop), meeting: String(t.ref || "").startsWith("gcal:") };
};
const pastPlans = (): PastPlan[] => {
  const now = nowD();
  return doc.tasks.filter(t => !t.done).flatMap(t => (t.planned || []).flatMap((x, i) => x.stop <= now ? [{ t, i, at: x.start }] : []))
    .sort((a, b) => a.at - b.at).map(({ t, i }) => pastPlanOf(t, i));
};
/** An answer, as the commands the Inspector's own controls send. Finishing drops the task's later stretches too. */
const answerPast: OnPastAnswer = (p, a, times) => {
  const id = p.id;
  if (a === "delete") { if (emit({ type: "removeTask", id })) flash(`deleted "${p.label || id}"`); return; }
  if (a === "keep") return void emit({ type: "setPlanned", id, planned: storedPlanned(id).filter((_, j) => j !== p.index) });
  const at = times ? { start: whenOf(dayOf(times.start))!, stop: whenOf(dayOf(times.stop))! } : {};
  if (emit({ type: "completePlanned", id, index: p.index, ...at }) && a === "finished") emit({ type: "finishTask", id });
};
const pastPanel = () => mountPastPlans($("#past-body"), { plans: pastPlans(), onAnswer: answerPast,
                                                          active: orderTab === "past" && !$("#reorder").hidden });

function showOrderTab(tab: "moves" | "rank" | "past") {
  orderTab = tab;
  for (const k of ["moves", "rank", "past"] as const) $(`#otab-${k}`).setAttribute("aria-selected", String(tab === k));
  $("#reorder-body").hidden = tab !== "moves";
  $("#rank-body").hidden = tab !== "rank";
  $("#past-body").hidden = tab !== "past";
  if (tab === "moves") reorderPanel(); else if (tab === "rank") rankPanel();
  pastPanel();   // every time, so its keys follow whether it is on screen
}
$("#otab-moves").onclick = () => showOrderTab("moves");
$("#otab-rank").onclick = () => showOrderTab("rank");
$("#otab-past").onclick = () => showOrderTab("past");

// A PAST PLAN WAITING IS WHY THE CHIP IS THERE, so it opens on it. Otherwise: WITH AUTO-ORDER ON there is no advice to
// review — the server takes it — so the chip opens on the ranking, the one input to the order that is still yours to give.
const openReorder = () => {
  $("#reorder").hidden = false;
  showOrderTab(pastPlans().length ? "past" : doc.autoOrder === true ? "rank" : orderTab);
};
const closeReorder = () => { $("#reorder").hidden = true; pastPanel(); };
$("#reorder-close").onclick = closeReorder;
$("#reorder").onclick = e => { if (tgt(e).id === "reorder") closeReorder(); };

// ---- channel editor --------------------------------------------------------
// The channel DEFINITIONS were only editable by hand-editing JSON on disk, which
// makes "customisable" a lie in a tool you drive in a meeting. Clicking the ✎ on
// a legend group opens its list here: rename, restyle, add, remove.
//
// The legend is the editor's own affordance on purpose — the legend is already
// the place you look to learn what a channel means, so it is the place you
// expect to change it.
const CH = {
  // "Lanes", not "Teams". Every other channel is named after what it IS visually
  // — colour, border, fill, shape — and carries whatever meaning the plan gives
  // it. This one was named after one plan's meaning, which quietly made it the
  // exception to the whole design and made "swap two channels" read as nonsense
  // the moment Teams was one of them.
  lanes:   { label:"Lanes",  add:() => ({ id:uid("t"), label:"New lane", cap:1 }) },
  colors:  { label:"Color",  add:() => ({ id:uid("c"), label:"New", color:"#7f8fa6" }) },
  borders: { label:"Border", add:() => ({ id:uid("b"), label:"New", style:"solid" }) },
  fills:   { label:"Fill",   add:() => ({ id:uid("f"), label:"New", pattern:"solid" }) },
  shapes:  { label:"Shape",  add:() => ({ id:uid("s"), label:"New", shape:"soft" }) },
  // NO `add`, because there is nothing to add — the three states are derived and
  // fixed. It is here only so `chLabel("status")` has a default to fall back to,
  // and a plan may still rename it (a plan whose actuals mean "delivered" can say
  // so). Nothing iterates `CH` itself, so an entry without `add` reaches no editor.
  status:  { label:"Status" },
  // Same deal as `status`: derived, fixed, no `add`, here so `chLabel` has a
  // default and a plan can still rename it.
  ready:   { label:"Ready" },
  // The fourth. Derived and fixed like the three above it, and here for the same
  // reason: `chLabel` reads `.label` off undefined otherwise.
  refined: { label:"Refined" },
  // AND `due` IS THE THIRD. Every pseudo-channel needs an entry here or
  // `chLabel` reads `.label` off undefined and takes the whole legend down with
  // it — which is exactly what adding this filter did before the entry existed.
  // NOT "Deadline" ANY MORE: it reports whether a deadline is in trouble, not
  // when it falls, and the old name had people reading it as a calendar.
  risk:    { label:"Risk" },
};
// `taken` is for callers that mint a BATCH before writing any of it to the doc —
// without it every call in the batch sees the same document and returns the same
// id. Default empty, so the one-at-a-time callers are unchanged.
// WHAT THIS PLAN CALLS EACH CHANNEL. `CH[key].label` names the RENDERING —
// Lanes, Color, Border, Fill, Shape — which is the right default precisely
// because it claims no meaning. But a plan does have a meaning for each, and
// "COLOR" in the legend when everyone in the room says "project" is a small tax
// paid on every glance.
//
// Optional and per-plan, so a document that never sets one is unchanged, and the
// fallback is the rendering's own name rather than an empty heading.
const chLabel = key => ((doc && doc.channelLabels) || {})[key] || CH[key].label;

// WHICH CHANNELS CAN APPEAR IN A ROW LABEL. `lanes` is deliberately absent: the
// lane is the row you are already in, under a header that names it, so a lane
// chip is the one part guaranteed to tell you something you can see without it.
// `shapes` is absent for the same reason it has one entry called "none" — no
// shipped plan gives it meaning.
const LABEL_CHANNELS = ["borders", "colors", "fills"];
// `title` is a part like any other, which is what makes "put the environment
// BEFORE the name" fall out of reordering a list rather than needing a separate
// prefix/suffix idea. It cannot be removed, only moved.
const labelParts = () => {
  const want = Array.isArray(doc && doc.labelParts) ? doc.labelParts : [];
  const ok = (want || []).filter((k: string) => k === "title" || LABEL_CHANNELS.includes(k as any));
  return ok.includes("title") ? ok : [...ok, "title"];
};
// A CHANNEL VALUE WHOSE LABEL IS "none" RENDERS AS NOTHING. That is not a special
// case for `b1`; it is taking the data at its word. The default border on this
// plan is literally labelled "none", so the six tasks carrying it have no
// environment to state, and printing the id would be the only way to get "b1" on
// screen — which is what the whole feature exists to avoid.
const chipText = (t, key) => {
  const list = doc[key] || [];
  const lab = id => { const e = list.find(x => x.id === id); return e && e.label; };
  // `color` is a LIST — a task can belong to several applications — so this one
  // joins rather than looks up. The others are a single id.
  const vals = key === "colors" ? (t.color || []).map(lab)
                                : [lab(key === "borders" ? t.border : t.fill)];
  return vals.filter(v => v && v !== "none").join("+");
};
// ONE COMPOSER, read by the renderer AND the measurer. They were already two
// call sites for one string and the column is sized from what it measures, so a
// part the measurer has not seen is a part that clips.
// WHICH TEAM, once the row is no longer sitting under a heading that says so.
// `short` because "IAM approvals" is four times the width of "dev" for the same
// job, in a gutter that is already competing with the chart. Falls back to the
// label, so a plan that never sets one still reads — just wider.
const laneShort = (lid: Id) => {
  const l: Partial<ChannelValue> = (doc.lanes || []).find(x => x.id === lid) || {};
  return l.short || l.label || lid;
};
// DATE MODE ONLY, AND NOT A `labelParts` ENTRY. In team mode the answer is the
// heading directly above the row, which is why `LABEL_CHANNELS` leaves `lanes`
// out; making it configurable would mean a settings row that only does anything
// in one view, and a view preference stored in the document.
const rowLabelParts = t => [
  ...(ROWMODE === "date"
      ? [{ title: false, text: laneShort(t.lane), tip: laneLabel(t.lane) }] : []),
  ...labelParts().map(k =>
    k === "title" ? { title: true, text: t.label || t.id }
                  : { title: false, text: chipText(t, k) }),
].filter(p => p.text);
const rowLabelText = t => rowLabelParts(t).map(p => p.text).join(" · ");
// ---------------------------------------------------------------------------
// THE KEYRING — what this viewer knows that the plan deliberately does not.
//
// It holds `refBase`, the tracker URL a task's `ref` is pasted into. It is NOT on
// the document and there is no command that can put it there: `PATCHABLE_DOC_KEYS`
// is an allowlist, so the field is refused by default rather than by anybody
// remembering to refuse it. That is the whole security property of the ref
// design — the plan carries a bare reference, which names a row in a system it does
// not identify, and the estate name lives only in the browsers of people who
// already know it.
//
// WHY IT IS NOT STICKY IN THE FRAGMENT. The URL is the thing people copy to each
// other to share the PLAN, so anything that lingers there is in every share. A
// `refBase` that survived one render would be in the next screenshot, the next
// screenshare and the next forwarded chat message. So the fragment is an INBOX,
// not a home: a keyring arriving in a link is absorbed into localStorage and
// struck from the address bar in the same turn (`absorbKeyring`), and only an
// explicit "copy link with keyring" ever puts one back.
//
// PER PLAN, not per browser. Two plans can live in two trackers, and a stale base
// silently resolving refs against the wrong estate is worse than no link.
//
// NOT A SECRET STORE. base64url below is transport hygiene — it keeps `{`, `"`
// and `/` out of a fragment that already splits on `&` — and buys nothing else.
// Anyone holding the link holds the base.
const KEYRING_KEYS = ["refBase"];
let KEYRING: Record<string, any> = {};
const keyringKey = () => "ts:keyring:" + (id || "-");
const b64u = {
  enc: o => btoa(unescape(encodeURIComponent(JSON.stringify(o))))
              .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: s => JSON.parse(decodeURIComponent(escape(
              atob(s.replace(/-/g, "+").replace(/_/g, "/")))))
};
/** Keep only keys we know, and only strings. A link is untrusted input. */
const cleanKeyring = o => Object.fromEntries(
  KEYRING_KEYS.filter(k => o && typeof o[k] === "string" && o[k].trim())
              .map(k => [k, o[k].trim()]));

function loadKeyring() {
  try { KEYRING = cleanKeyring(JSON.parse(stored(keyringKey()) || "{}")); }
  catch { KEYRING = {}; }
  return KEYRING;
}
function saveKeyring(next) {
  KEYRING = cleanKeyring(next);
  remember(keyringKey(), JSON.stringify(KEYRING));
}

/** Take a keyring out of the fragment, store it, and strike it from the bar.
 *  Called after `adopt` — the store is keyed by plan id, so it has to know one. */
function absorbKeyring() {
  loadKeyring();
  const got0 = inbox().kr;
  if (!got0) return;
  let got = null;
  try { got = cleanKeyring(b64u.dec(got0)) as any; } catch { got = null; }
  // Struck whether or not it parsed — a fragment that survived one render is a
  // tracker host sitting in the address bar of a tab someone will screenshare.
  clearInbox();
  if (!got || !Object.keys(got).length) return flash("that link carried no usable settings", true);
  saveKeyring({ ...KEYRING, ...(got as object) });
  flash("link settings applied to this plan in this browser");
  render();
}

/** A REFERENCE THIS PLAN ALREADY USES, for the two places that want to show the
 *  shape of one: the inspector's placeholder and the Settings sample.
 *
 *  BORROWED FROM THE DATA RATHER THAN INVENTED, because an invented one has to
 *  pick a tracker, and the shape of a reference names the tracker — so a made-up
 *  example would announce which one this team uses to anyone reading over their
 *  shoulder, before they had typed a character. That is the same leak the
 *  ref/base split exists to close, wearing different clothes.
 *
 *  A real one is the more useful hint anyway: it shows the shape THIS plan's
 *  references actually take, so the next one you type matches the last twenty.
 *  Falls back to nothing, and the callers supply neutral wording for that.
 *
 *  `find`, so it costs nothing on a plan with no references and stops at the
 *  first on a plan with hundreds. */
const refExample = () => {
  const t = (doc && doc.tasks || []).find(x => x.ref);
  return t ? t.ref : "";
};

/** The other half of a `ref`. `{ref}` if the base says where, appended if not. */
const refUrl = t => {
  const base = KEYRING.refBase, r = t && t.ref;
  if (!base || !r) return null;
  const enc = encodeURIComponent(r);
  return base.includes("{ref}") ? base.split("{ref}").join(enc) : base + enc;
};

// THE ONLY PLACE AN `href` IS DECIDED, and it re-checks what `setTaskUrl`
// already checked. Not belt-and-braces for its own sake: the command vocabulary
// guards what is WRITTEN through it, and a document can arrive by other doors —
// `addTask` carries a whole task object, and a plan can be forked or imported
// wholesale from JSON. Those doors reach the renderer without passing
// `setTaskUrl`, so the renderer is where the rule has to be true. A `javascript:`
// url renders as no link at all rather than as a link that runs it.
// A TASK'S OWN `url` WINS over its `ref`. The ref is the systematic link every
// task gets from the tracker; the url is the one somebody set by hand on this
// task specifically, so it is the more deliberate of the two and it is the one
// that should survive a keyring being configured later.
const httpOnly = u => (/^https?:\/\//i.test(u || "") ? u : null);
const linkOf = t => httpOnly(t && t.url) || httpOnly(refUrl(t));

const uid = (pre: string, taken: any[] = []): string => { let n = 1, v: string;
  const all = CHANNELS.flatMap(c => doc[c] || []).map(x => x.id).concat(taken);
  do { v = pre + n++; } while (all.includes(v)); return v; };

// ---- swapping what a channel MEANS ----------------------------------------
// The whole design is that a channel is a rendering, not a meaning: `doc.colors`
// is a list of labels that happen to be drawn as hues, and nothing in the code
// knows they are systems. The payoff for that discipline is this operation —
// move "dev / QA / prod" off the border and onto the fill, and the tasks come
// with it.
//
// WHAT MOVES IS THE LABEL AND THE ASSIGNMENT. Styles stay with the channel: a
// value landing on `fills` needs a fill pattern because that is what a fill is.
// So the mapping the user supplies is `label -> style in the destination`, which
// is exactly the question they were already asking out loud ("map dev to the
// underline, QA to hatch").
//
// NOTHING IS MERGED. Two labels may be given the same destination style, and
// they stay two separate values that happen to render identically — the legend,
// the filter and the counts still tell them apart. Merging them would destroy
// which-task-was-which irreversibly, and the warning "you will not be able to
// tell these apart on the chart" is a fair price where "we threw away your data"
// is not.
const STYLE = {
  lanes:   { key:null,      opts:null },              // a lane is a row group; no style to pick
  colors:  { key:"color",   opts:null },              // any hex, so a colour input rather than a list
  borders: { key:"style",   opts:BORDER_STYLES },
  fills:   { key:"pattern", opts:FILL_PATTERNS },
  shapes:  { key:"shape",   opts:SHAPES },
};
const PALETTE = ["#5aa9f0","#b98bf0","#d9a95c","#5fc9a3","#e0797f","#8fd15a","#e0b84f","#7f8fa6"];

// The destination style each value would get if nobody touched the mapping:
// position for position, wrapping when the destination's enum is shorter. That
// wrap IS the granularity loss, surfaced rather than prevented.
const defaultStyle = (toKey, i) => {
  const o = STYLE[toKey].opts;
  if (toKey === "colors") return PALETTE[i % PALETTE.length];
  if (!o) return null;
  // Skip "none"/"solid" at index 0 where a channel has a deliberate no-op value,
  // so a default mapping never silently renders a value as nothing.
  const usable = o.filter(v => v !== "none");
  return usable[i % usable.length];
};

// Applies the swap. `styleFor[ch][valueId]` is the style that value takes in the
// OTHER channel.
function swapChannels(a, b, styleFor) {
  if (!onAPlan()) return;
  // A BATCH-AWARE ID MINTER. `uid()` checks the ids currently IN the document,
  // which is correct for the one-at-a-time "+ Add" it was written for and wrong
  // here: this mints a whole list before assigning any of it, so every call saw
  // the same document and handed back the same id. Three values all became "f1",
  // every task pointed at it, and the legend cheerfully reported all 12 tasks
  // under all three — a swap that looked plausible and had destroyed the mapping.
  const minted: any[] = [];
  const freshId = (pre: string) => { const v = uid(pre + "s", minted); minted.push(v); return v; };
  const build = (from, to) => (doc[from] || []).map((v, i) => {
    const out = { id: freshId(to[0]), label: v.label };
    const k = STYLE[to].key;
    if (k) out[k] = (styleFor[from] || {})[v.id] ?? defaultStyle(to, i);
    if (to === "lanes") (out as any).cap = 1;              // capacity is a property of a lane, not of a meaning
    return out;
  });
  const newA = build(b, a), newB = build(a, b);
  // Index-parallel with the source lists, so remapping is a lookup rather than a
  // search by label — labels are not unique and never have been.
  const mapAB = Object.fromEntries((doc[a] || []).map((v, i) => [v.id, newB[i].id]));
  const mapBA = Object.fromEntries((doc[b] || []).map((v, i) => [v.id, newA[i].id]));
  const fa = FIELD[a], fb = FIELD[b];
  const take = (t, ch, map) => {
    const vals = valsOf(t, ch).map(v => map[v]).filter(Boolean);
    return vals;
  };
  const moved = doc.tasks.map(t => [take(t, a, mapAB), take(t, b, mapBA)]);
  // A LANE IS THE ONE CHANNEL THAT CANNOT BE EMPTY. Rows are built by walking
  // lanes and collecting their tasks, so a task with no lane renders nowhere at
  // all — it would vanish from the chart while still counting toward every total,
  // which is the most alarming possible outcome of a button labelled "swap".
  // Every other channel tolerates nothing: a null border draws no rim, a null
  // fill and shape fall back, an empty colour list draws the default grey.
  // ...and the server's `invalid()` says the same of border, fill and shape: each
  // must name a value in its own list. So "no value" has no representation in ANY
  // single-valued channel and they all floor to the first one. Only `colors` can
  // legitimately come out empty, which is why it never reaches here.
  const floor = (ch, list) => (list[0] || {}).id;
  // THE ONE OPERATION THAT WILL NOT GO DOWN THE SOCKET, and the asymmetry is
  // worth stating rather than leaving to be discovered.
  //
  // A swap replaces both channels' value lists AND repoints every task at the new
  // ids, and there is no order in which those are separate commands. The server
  // runs `invalid()` after each one, and it refuses a task whose lane/border/fill/
  // shape is not in the matching list — so lists-first orphans every task, and
  // tasks-first names ids that do not exist yet. Either way the FIRST command is
  // rejected and the swap cannot happen at all.
  //
  // `POST /api/commands` takes a batch and is ALL OR NOTHING: each command is
  // checked against the document as the batch has built it so far, `invalid()`
  // runs ONCE at the end, and nothing is broadcast until the whole thing commits.
  // The socket frame carries a single command, so the batch goes over HTTP.
  //
  // NO OPTIMISTIC APPLY, deliberately. An HTTP command carries no session ref, so
  // the server broadcasts the batch to everyone INCLUDING us; applying it here as
  // well would apply it twice. The chart moves when the frames land.
  const one = (t, ch, vals, list) => ch === "colors"
    // A list channel keeps the list; a single-valued one takes the first, which
    // is where a multi-colour task loses its extra colours. Warned about before
    // this runs, not discovered afterwards.
    ? { type:"setTaskColors", id: t.id, colors: vals }
    : { type:"setTaskChannel", id: t.id, channel: FIELD[ch], value: vals[0] ?? floor(ch, list) };
  const cmds = [
    { type:"patchDoc", patch: { [a]: newA, [b]: newB } },
    ...doc.tasks.flatMap((t, i) => {
      const [toB, toA] = moved[i];
      return [one(t, b, toB, newB), one(t, a, toA, newA)];
    }),
  ];
  call("commands", { cmds })
    // NOT "Revert undoes it if you had saved" any more. Revert is a room-wide
    // discard of everything unsaved, not a personal undo — so it would take this
    // swap back along with whatever anyone else has done since the last save,
    // for everybody at once. Naming the version is the useful part; what to do
    // about it is a decision, not a hint.
    .then(() => flash(`Swapped ${chLabel(a)} and ${chLabel(b)} for everyone in this plan.`
      + (lastSave ? ` Save #${lastSave.n} still has it the old way.` : "")))
    // The server's own message, verbatim — same rule as `rollback`.
    .catch(err => flash(err.message, true));
}

// ---- the swatch wall ------------------------------------------------------
// GENERATED FROM THE ENUMS, never hand-listed. A hand-kept reference of "here are
// all the fill patterns" is wrong the day someone adds the twelfth one, and wrong
// silently — which is the same failure the legend was built to avoid by rendering
// through the same functions the bars use. This does the same thing one level up:
// it walks SHAPES, FILL_PATTERNS and BORDER_STYLES, so adding a value to any of
// them makes it appear here with no second edit.
//
// Drawn as REAL BARS, not as 28x16 chips. A shape is a silhouette and a border is
// a rim, and neither reads honestly at swatch size — the question being answered
// is "what will this look like on my chart", so it is answered with the thing
// that goes on the chart, at a plausible width.
//
// Independent axes, not combinations: 7 shapes x 12 fills x 7 borders is 588
// bars, and nobody has ever learned anything from the 588th.
function swatchWall() {
  const box = $opt("#swatchwall"); if (!box) return;
  mountSwatchWall(box, [
    { title: "Shape", note: `${SHAPES.length} values`,
      cells: SHAPES.map(s => ({ label: s, cls: "sh-" + s })) },
    { title: "Fill", note: `${FILL_PATTERNS.length} values`,
      cells: FILL_PATTERNS.map(x => ({ label: x, cls: "sh-soft pat-" + x })) },
    // rimCss, the same function the bars go through — one place knows what "rails"
    // looks like, so the reference cannot disagree with the chart.
    { title: "Border", note: `${BORDER_STYLES.length} values`,
      cells: BORDER_STYLES.map(b_ => ({ label: b_, cls: "sh-soft", style: cssObj(rimCss(b_)) })) },
  ]);
}

// The mapping table. Held outside the render so picking a style for one value
// does not reset the eleven you already picked — `render()` rebuilds this panel
// like everything else, and the swap has not happened yet.
let swapPick: Record<string, unknown> = {};
let swapA = "borders", swapB = "fills";
function swapEditor() {
  const box = $opt("#swapmap"); if (!box) return;
  // WHICH TWO CHANNELS, HELD HERE RATHER THAN IN THE DOM. These used to read
  // their own `<select>.value` back out to decide what to draw, so the panel's
  // state was whatever the two elements happened to be showing. A controlled
  // dropdown cannot do that — and it should not have to.
  const a = swapA, b = swapB;
  const chans = CHANNELS.map((c): PickerOption => ({ value: c, label: chLabel(c) }));
  const pick = (id: string, value: string, set: (v: string) => void) => {
    const host = $opt("#" + id + "host");
    if (host) mountPicker(host, { id, value, options: chans,
      onPick: v => { set(v); swapPick = {}; swapEditor(); } });
  };
  pick("swapa", a, v => { swapA = v; });
  pick("swapb", b, v => { swapB = v; });
  $f("#swapgo").disabled = a === b;
  if (a === b) { mountSwapEditor(box, { columns: null, onPick: () => {} }); return; }

  // One column per direction. Reading it as "these labels are moving there, and
  // this is what they will look like" is the entire job of this panel.
  const side = (from: string, to: string): SwapColumn => {
    const list = (doc[from] || []) as any[], k = STYLE[to].key, o = STYLE[to].opts;
    const heading = `${chLabel(from)} → ${chLabel(to)}`;
    if (!list.length) return { from, heading, rows: [], warnings: [],
      empty: `${chLabel(from)} has no values; nothing moves this way.` };
    const cur = (v: any, i: number) => (swapPick[from] || {} as any)[v.id] ?? defaultStyle(to, i);
    const rows: SwapRow[] = list.map((v, i) => ({
      id: v.id, label: v.label,
      control: to === "colors" ? { kind: "color", value: cur(v, i) }
             : !k ? { kind: "own" }
             : { kind: "pick", value: cur(v, i), opts: o as string[] },
    }));
    // Duplicate destination styles are allowed and called out. This is the
    // "you're going to lose some granularity" case, and it is the only one — the
    // values still exist, still filter and still count, they just look alike.
    const used = list.map(cur);
    const dupes = [...new Set(used.filter((x, i) => x != null && used.indexOf(x) !== i))];
    const multi = doc.tasks.filter(t => colorsOf(t).length > 1).length;
    const warnings: SwapColumn["warnings"] = [];
    if (dupes.length) warnings.push({ key: "dupes", parts: [
      `${dupes.length === 1 ? "Two or more values" : "Several values"} will draw as `,
      ...dupes.flatMap((d, i) => i ? [", ", { b: String(d) }] : [{ b: String(d) }]),
      " — you will not be able to tell them apart on the chart. They stay separate values, "
      + "so the legend, the filter and the counts still can.",
    ] });
    if (from === "colors" && multi) warnings.push({ key: "lost", parts: [
      `${multi} task(s) carry more than one ${chLabel("colors")}. ${chLabel(to)} holds one value, `
      + `so only the first survives.`] });
    if (from === "lanes" && (doc.lanes || []).some(l => (l.cap || 1) > 1))
      warnings.push({ key: "caps", parts: [
        "“at once” capacity belongs to a lane, not to a meaning — it does not travel, and the "
        + "schedule will change accordingly."] });
    return { from, heading, rows, empty: null, warnings };
  };

  mountSwapEditor(box, {
    columns: [side(a, b), side(b, a)],
    // Held outside the render so picking a style for one value does not reset the
    // eleven you already picked — the swap has not happened yet.
    onPick: (from, vid, value) => {
      swapPick[from] = { ...(swapPick[from] || {} as any) };
      (swapPick[from] as any)[vid] = value;
      swapEditor();
    },
  });
}

// ALL FOUR CHANNELS AT ONCE, not one at a time. The one-at-a-time version needed
// a mode variable, an unfold row in the top bar, and a second click on the same ✎
// to put it away — three moving parts to save vertical space that a modal has in
// abundance. Inside Settings the whole thing is just a list, and the state it
// used to need is gone.
//
// Index attributes stay per-channel-scoped where they are already unique to one
// channel (`data-cap` is lanes-only, `data-s` borders-only, and so on); only the
// ones every channel emits carry a `key:index`.
// ONE SWATCH BUILDER PER CHANNEL, and every surface that draws a style goes
// through it — the picker button, the grid inside it, and the legend. Drawn by
// the rules the chart uses, so a preview cannot disagree with a bar.
// HOW A CHANNEL VALUE IS DRAWN, as data. It was `styleSwatch`, which returned
// markup, and it is gone: the legend, the channel editor's style button and the
// style popover all render this through `<Key>`. One shape, three call sites, and
// it goes through `rimCss` and the `pat-`/`sh-` classes the bars use — so the
// reference cannot disagree with the chart.
const swatchOf = (key: string, v: any): Swatch =>
    key === "borders" ? { style: cssObj(rimCss(v || "solid")) }
  : key === "fills"   ? { cls: `pat-${v || "solid"}` }
  : key === "shapes"  ? { shape: SHAPES.includes(v) ? v : "soft" }
  : { hidden: true };

// The grid of styles. One shared popover rather than one per row: there is only
// ever one open, and `position:fixed` keeps it clear of the settings card, which
// scrolls — the same clip that swallowed the colour picker.
function stylePop(key: string, i: number, btn: HTMLElement) {
  const pop = $("#stylepop"), field = STYLE[key].key;
  const cur = doc[key][i][field];
  mountStylePop(pop, (STYLE[key].opts as string[]).map(v => ({
    v, on: v === cur, swatch: swatchOf(key, v),
  })), v => {
    // The whole channel list: `patchDoc` is a shallow merge, so a write into one
    // entry has to travel as the list that contains it.
    emit({ type: "patchDoc", patch: { [key]: doc[key].map((x, n) =>
      n === i ? { ...x, [field]: v } : { ...x }) } });
    pop.hidden = true;
  });
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  // Below the button, or above it when there is no room below — a grid of eleven
  // textures is tall enough to run off the bottom of a laptop screen.
  const below = innerHeight - r.bottom > pop.offsetHeight + 12;
  pop.style.top = (below ? r.bottom + 6 : r.top - pop.offsetHeight - 6) + "px";
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + "px";
}
const closeStylePop = () => { const p = $("#stylepop"); if (p) p.hidden = true; };

// WHICH CHANNELS CAN HAVE A NOT-APPLICABLE VALUE. Not lanes — every task has to
// sit in a queue, and "no lane" is not a thing a row can be. Not colours — that
// channel says it with an empty list, which is why it is the one that needed a
// configurable neutral hue instead.
const CAN_DEFAULT = new Set(["borders", "fills", "shapes"]);

// THE ROW LABEL, AS A LIST YOU ORDER. Checkboxes alone would have needed a
// separate "before or after the name?" control; making `title` an entry you can
// move answers that with the same gesture, and stops short of the template engine
// nobody asked for — there is no separator to configure and no per-lane override.
function labelPartsEditor() {
  const box = $opt("#labelparts");
  if (!box) return;
  const on = labelParts();
  const nameOf = (k: string) => k === "title" ? "Title" : chLabel(k);
  const write = (next: string[]) => emit({ type: "patchDoc", patch: { labelParts: next } });
  // A PREVIEW, because the list is an abstraction and the gutter is the thing.
  // Longest label in the plan: the question people actually have is not "what does
  // it say" but "how much room does it need".
  const sample = doc.tasks.slice().sort((x_, y_) =>
    rowLabelText(y_).length - rowLabelText(x_).length)[0];
  mountLabelParts(box, {
    on: on.map((k: string) => ({ k, name: nameOf(k) })),
    off: LABEL_CHANNELS.filter(k => !on.includes(k)).map(k => ({ k, name: nameOf(k) })),
    sample: sample ? rowLabelText(sample) : null,
    onToggle: (k, enabled) => write(enabled ? [...on, k] : on.filter((x: string) => x !== k)),
    onMove: (k, dir) => {
      const i = on.indexOf(k), j = i + dir;
      if (i < 0 || j < 0 || j >= on.length) return;
      const next = on.slice(); next.splice(j, 0, next.splice(i, 1)[0]);
      write(next);
    },
  });
}

function channelEditor() {
  const box = $opt("#chedit");
  if (!box) return;
  // Whole list again, every time: `patchDoc` shallow-merges the document, so a
  // write nested inside one entry would not survive the wire.
  const list = (k: string) => (doc[k] || []) as any[];
  const patchList = (k: string, at: number, f: (x: any) => any) =>
    emit({ type: "patchDoc", patch: { [k]: list(k).map((x, n) => n === at ? f(x) : { ...x }) } });

  const control = (key: string, x: any, i: number): ValueControl =>
      key === "lanes"  ? { kind: "lane", cap: x.cap || 1, short: x.short || "", shortPlaceholder: x.label }
    : key === "colors" ? { kind: "color", color: x.color || "#7f8fa6" }
    : STYLE[key].opts  ? { kind: "style", swatch: swatchOf(key, x[STYLE[key].key]) }
    : { kind: "none" };

  mountChannelEditor(box, {
    channels: CHANNELS.map((key): ChannelBlock => ({
      key,
      label: chLabel(key),
      drawnAs: CH[key].label.toLowerCase(),
      canDefault: CAN_DEFAULT.has(key),
      defaultNoun: chLabel(key).toLowerCase(),
      noColor: key === "colors" ? noColor() : undefined,
      canSort: key === "lanes",
      values: list(key).map((x, i) => ({
        id: x.id, label: x.label, control: control(key, x, i),
        used: doc.tasks.filter(t => valsOf(t, key).includes(x.id)).length,
        isDefault: defaultOf(key) === x.id,
      })),
    })),
    // NO `keep` SELECTORS ON ANY OF THESE THREE. They were `oninput` text fields
    // in a panel rebuilt by `innerHTML` on every keystroke, so each one had to
    // name itself to `emit` so the caret could be handed back. React keeps the
    // <input>, so there is nothing to hand back.
    onChannelLabel: (key, v) => emit({ type: "patchDoc",
      patch: { channelLabels: { ...(doc.channelLabels || {}), [key]: v } } }),
    onValueLabel: (key, i, v) => patchList(key, i, x => ({ ...x, label: v })),
    onCap: (i, v) => patchList("lanes", i, x => ({ ...x, cap: Math.max(1, Math.floor(+v || 1)) })),
    // BLANK REMOVES THE KEY rather than storing "", so a cleared box means "use
    // the label" in the document as well as on screen.
    onShort: (i, v) => patchList("lanes", i, x => {
      const { short: _drop, ...rest } = x;
      return v.trim() ? { ...rest, short: v.trim() } : rest;
    }),
    onColor: (i, v) => patchList("colors", i, x => ({ ...x, color: v })),
    onStyle: (key, i, btn) => stylePop(key, i, btn),
    onNoColor: v => emit({ type: "patchDoc", patch: { noColor: v } }),
    // A toggle: click the marked one to say this plan has no not-applicable value.
    onDefault: (key, i) => {
      const vid = list(key)[i].id;
      const defaults = { ...(doc.defaults || {}) };
      if (defaults[key] === vid) delete defaults[key]; else defaults[key] = vid;
      emit({ type: "patchDoc", patch: { defaults } });
    },
    onMove: (key, i, dir) => {
      const l = list(key), j = i + dir;
      if (j < 0 || j >= l.length) return;
      const next = l.map(x => ({ ...x }));
      [next[i], next[j]] = [next[j], next[i]];
      emit({ type: "patchDoc", patch: { [key]: next } });
    },
    onRemove: (key, i) => delChannelValue(key, i),
    // TWO DOORS, ONE ACT. The Order chip's panel offers the same sort, because
    // Settings → Channels → Team is not where anyone looks to find out that their
    // teams are upside down. Both call `applyLaneOrder`; neither restates the patch.
    onSortLanes: applyLaneOrder,
    // `|| []` because a channel's array is OPTIONAL on a document — shapes are
    // opt-in, and no plan written before they existed has one. "+ Add" used to push
    // into that missing array, so it threw on the one channel you would need it for
    // most: the empty one.
    onAdd: key => emit({ type: "patchDoc", patch: { [key]: [...list(key), CH[key].add()] } }),
  });
}
const SING = { lanes:"lane", colors:"color", borders:"border", fills:"fill", shapes:"shape" };

// NO CHANNEL CAN BE EMPTIED, and since v3 that has a reason it did not have
// before. It used to read as an arbitrary "keep at least one value" — which is
// what made deleting the last shape feel like a bug, because it was one: the
// guard was protecting nothing anybody could name.
//
// Now every task points at a real value in every channel, so the last value is
// not arbitrary at all: it is what every task in the plan is currently pointing
// AT. Removing it would leave 37 tasks pointing at nothing, which is exactly the
// state v3 exists to abolish.
//
// The way to stop using a channel is to take it DOWN to one value, not to zero —
// at one value it draws no legend group and no inspector control, so it costs a
// row in Settings and nothing anywhere else.
function delChannelValue(key, i) {
  if (!onAPlan()) return;
  const list = doc[key], v = list[i], field = SING[key];
  if (list.length === 1)
    return flash(`Every task points at a “${chLabel(key)}” value, so this one cannot go. `
               + `A channel at one value already draws nothing outside Settings.`, true);
  const used = doc.tasks.filter(t => valsOf(t, key).includes(v.id));
  // Reassigning beats orphaning: a task pointing at a deleted colour would fall
  // back to a default and quietly stop being counted where the user expects.
  // The plan's not-applicable value is the better target than "the next one along"
  // where there is one — moving an orphan to "prod" because prod happened to be
  // first in the list is the same relabelling the v3 migration refused to do.
  const dflt = defaultOf(key);
  const to = (dflt && dflt !== v.id ? dflt : (list.find(x => x.id !== v.id) || {}).id);
  // TWO DIFFERENT SENTENCES, BECAUSE TWO DIFFERENT THINGS HAPPEN — and they are
  // spelled out separately rather than folded into one nested ternary, which is
  // what let the colour wording drift out of step with the colour behaviour.
  //
  // COLOUR IS A LIST. Deleting one of a task's several just drops it — a shared
  // server tagged Rates API + MOAuth must not be silently re-tagged because one
  // of the two was retired — and a task left with none lands on `[]`, which is a
  // real state ("touches no system"), not a hole to be filled. That is what makes
  // retiring a combined value clean: tick the two real colours on its tasks, then
  // delete it and it just goes.
  //
  // EVERY OTHER CHANNEL IS TOTAL, so its tasks have to land on something real.
  const nm = id_ => (list.find(x => x.id === id_) || {}).label;
  const orphans = key === "colors" ? used.filter(t => colorsOf(t).length === 1) : used;
  const consequence = !used.length ? ""
    : key === "colors"
      ? `\n\n${used.length} task(s) carry it` + (orphans.length
          ? `, and ${orphans.length} of those carry nothing else — those end up with no `
            + `${chLabel(key).toLowerCase()} at all.`
          : ` alongside another colour — they just lose this one.`)
      : `\n\n${used.length} task(s) use it — they move to "${nm(to)}".`;
  if (!confirm(`Remove "${v.label}"?`
      + (defaultOf(key) === v.id
         ? `\n\nIt is this plan's "not applicable" value, so clearing a task's `
           + `${chLabel(key).toLowerCase()} will stop being offered.` : "")
      + consequence)) return;
  // THE TASKS MOVE OFF THE VALUE FIRST, AND THEN THE VALUE GOES. The order is
  // forced, not stylistic: the server runs `invalid()` after every command and it
  // refuses a task pointing at a value that is not in its channel's list — so
  // dropping the value first would have the very first command rejected.
  //
  // AND ALL OF IT COMMITS AT ONCE. These used to be N+1 separate commands, each
  // sequenced and broadcast on its own. Anything that stopped the sequence
  // part-way — one rejection, or the socket dropping mid-delete — left the tasks
  // reassigned and the value still in the list, or worse the other way round:
  // a plan in a state nobody chose, on everybody's screen, with no record of what
  // was meant. A batch is checked command-by-command against the document as it
  // builds, `invalid()` runs once at the end, and nothing is broadcast unless the
  // whole thing commits.
  const cmds = used.map(t => key !== "colors"
    ? { type:"setTaskChannel", id: t.id, channel: field, value: to }
    // Colour is the exception and stays one: emptying a task's list is a real
    // state ("touches no system"), not a hole to be filled.
    : { type:"setTaskColors", id: t.id, colors: colorsOf(t).filter(c => c !== v.id) });
  const patch = { [key]: list.filter(x => x.id !== v.id) };
  // A designation that points at a value nobody can see is invisible state, which
  // is the failure this whole rung is about. Drop it with the value.
  if (defaultOf(key) === v.id) { const d2 = { ...(doc.defaults || {}) }; delete d2[key];
    (patch as any).defaults = d2; }
  cmds.push({ type:"patchDoc", patch } as any);
  // NO OPTIMISTIC APPLY — see `swapChannels`. The chart moves when the frames land.
  call("commands", { cmds })
    .then(() => flash(`Removed "${v.label}"`
      + (used.length ? ` — ${used.length} task(s) updated.` : "")))
    // The server's own message, verbatim — same rule as `rollback`.
    .catch(err => flash(err.message, true));
}

function addMilestone() {
  let n = 1, mid; do { mid = "ms" + n++; } while (doc.milestones.some(m => m.id === mid));
  // Defaults four weeks past the last one — a new milestone should not silently
  // land in the past and paint the whole board red.
  const last = [...doc.milestones].sort((a, b) => dayOf(a.date) - dayOf(b.date)).slice(-1)[0];
  const base = last ? Date.parse(last.date + "T00:00:00Z") : +d0();
  emit({ type:"patchDoc", patch: { milestones: [...doc.milestones,
    { id: mid, label: "New milestone",
      date: new Date(base + 28 * DAY).toISOString().slice(0, 10) }] } });
}

function delMilestone(mid) {
  if (!onAPlan()) return;
  const orphan = doc.tasks.filter(t => msOf(t) === mid);
  // NULL WHEN THIS IS THE LAST ONE. A plan with no milestones is a real shape,
  // not a broken one: `ms` is nullable on the wire, `invalid()` accepts an empty
  // list, and every reader here already guards for it — `BINDING` goes null, the
  // slack shift goes 0, and the chart simply draws no deadline line. A standing
  // plan that is never "done" has nothing to be measured against, and the old
  // guard forced it to carry a date it did not mean.
  const fallback = doc.milestones.find(m => m.id !== mid)?.id ?? null;
  const m = doc.milestones.find(x => x.id === mid);
  if (!confirm(`Delete "${m!.label}"?` + (orphan.length
      ? `\n\n${orphan.length} task(s) are assigned to it — they ${fallback
          ? `move to "${doc.milestones.find(x => x.id === fallback)!.label}"`
          : "are no longer measured against anything"}.` : ""))) return;
  // Tasks move off it FIRST, then it goes — `invalid()` refuses a task naming a
  // milestone that is not in `doc.milestones`, so the other order has the server
  // reject the first command. Never leave a task pointing at a milestone that is
  // gone: msOf() would fall back to the first one silently and the counts would
  // quietly stop adding up.
  //
  // ONE BATCH, for the same reason as `delChannelValue`: as separate commands a
  // failure part-way leaves tasks reassigned to a milestone they were never meant
  // to be measured against, with the one they were meant for still on the chart.
  const cmds = [
    ...orphan.map(t => ({ type:"setMilestone", id: t.id, ms: fallback })),
    { type:"patchDoc", patch: { milestones: doc.milestones.filter(x => x.id !== mid) } },
  ];
  // NO OPTIMISTIC APPLY — see `swapChannels`. The chart moves when the frames land.
  call("commands", { cmds })
    .then(() => flash(`Deleted "${m!.label}"`
      + (orphan.length ? ` — ${orphan.length} task(s) ${fallback ? "moved" : "unassigned"}.` : "")))
    // The server's own message, verbatim — same rule as `rollback`.
    .catch(err => flash(err.message, true));
}

// Rendered rather than hardcoded in the HTML so the systems row tracks
// doc.colors — a model with a different set gets a correct legend for free.
// CSS TEXT -> A STYLE OBJECT, because React's `style` prop is not a string.
// `borderCss` and `rimCss` return declaration LISTS ("border:none;border-top:…"),
// which is the right shape for the two places that set a whole `style` attribute
// imperatively — the bar in the row loop, and the swatch wall. Converting at the
// one React call site is a smaller change than giving those functions a second
// return type. If more of the page moves over, invert it: return the object and
// let the imperative callers do `Object.assign(el.style, …)`.
const cssObj = (decls: string): any => Object.fromEntries(
  decls.split(";").filter(Boolean).map(d => {
    const i = d.indexOf(":");
    return [d.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase()), d.slice(i + 1).trim()];
  }));

// ONE DEFINITION OF "PUT IT ALL BACK", because there are two ways to ask for it
// now and a second copy would drift. The button clears the three ways rows go
// missing — the chips, the text box and the chain focus. `toggles` additionally
// puts the three VIEW switches back, which the button deliberately does not:
// "show everything" is a statement about what is filtered, and done / effort /
// isolate are statements about how what is left gets drawn.
function showEverything(toggles = false) {
  const hadChain = !!chainFocus, wasIsolate = focusMode === "isolate";
  // Same reason as the legend's `onPick`: dropping a Done or Cancelled pick takes
  // rows AWAY, and a repaint cannot un-draw a row. Read before the clear, or
  // there is nothing left to read.
  const hadGate = [...focus.status].some(id => GATED_STATUS.has(String(id)));
  for (const c of FILTER_CHANNELS) focus[c].clear();
  query = ""; const qEl = $f("#q"); if (qEl) qEl.value = "";
  chainFocus = null;
  if (toggles) { showDone = false; showEffort = false; focusMode = "dim"; }
  // A full render when rows have to come BACK, a repaint when only the dimming
  // moved — `applyFilter` alone would un-dim rows that are not there.
  if (toggles || wasIsolate || hadChain || hadGate) render(); else applyFilter();
}

function legend() {
  // EVERY LEGEND ENTRY CARRIES ITS OWN COUNT AND WEEKS. This replaced a single
  // hardcoded fill tally in the plan chip ("3 known · 3 estimated · 31 guessed"),
  // which answered one channel's worth of "how many are there?" and left the
  // other three unanswered. Putting the number on the swatch answers it for every
  // channel at once, in the place you already look to find out what a colour
  // means — and it costs no new panel, no new control, no new state.
  //
  // "Tasks that CARRY this value", not "tasks whose value IS this" — a task with
  // two systems is counted under both, which is what "how many touch Rates API"
  // means. The consequence is that the Colour column sums to MORE than the plan's
  // task count, and that is stated on the group heading rather than left to look
  // like an arithmetic bug.
  //
  // WHAT IS LEFT, NOT WHAT THERE EVER WAS. A chip reading 34 on a project with 28
  // finished tasks is answering a question nobody asks — the legend is a filter
  // bar, and every number on it is read as "how much of this is still ahead of
  // me". `drawn` rather than a fresh predicate: `used()` two screens down decides
  // which chips exist from the same answer, so a surviving chip counting rows
  // that are not on the chart was the one place this file disagreed with itself.
  //
  // THE EFFORT NUMBER MATTERED MORE THAN THE COUNT. The same line sums `dur`, so
  // "2.1 days of work" beside a chip was quoting days already worked as days
  // still to do.
  //
  // THE CHIP COUNTS WHAT IS DRAWN, which is `drawn` and not a rule of its own.
  // It shipped for an hour as a flat "never count finished or cancelled work",
  // and the toggles are what killed that: tick `done` and the chart fills with
  // history while the chip beside it insists there are seven — the chart calling
  // the legend a liar, which is the exact failure the empty-chart notice below
  // was written to avoid. So there is ONE definition of what is on screen and
  // every number is read off it.
  //
  // EXCEPT THE STATUS CHIPS, WHICH COUNT THEIR OWN STATE. Gating those on `drawn`
  // makes Done and Cancelled read 0 on a plan with thirty finished tasks, because
  // the thing they count is the thing the gate is hiding — and a chip reading 0 is
  // a control that looks dead, when clicking it is precisely how you ask for those
  // rows. The gate does not apply to the question "how many are there".
  const stat = (key: string, vid: Id) => {
    const gate = key === "status" ? () => true : drawn;
    const ts = doc.tasks.filter(t => gate(t) && valsOf(t, key).includes(vid));
    return { count: ts.length, effort: durStr(ts.reduce((a, t) => a + remainingOf(t), 0)) };
  };
  // A CHANNEL WITH FEWER THAN TWO VALUES CARRIES NO INFORMATION, so it shows no
  // UI. If every task in the plan is "prod", the border is not telling you which
  // ones are — it is telling you there is only one kind, which the absence of the
  // group says just as well and in no space at all.
  //
  // This was already true of shapes, as a special case ("a group heading with no
  // values under it is a control that looks broken"). It is the same argument at
  // one value as at zero, so it is the rule for every channel rather than a
  // carve-out for the opt-in one. The values are still in ⚙ → Channels, which is
  // where you go to add the second one that makes the axis mean something.
  const USEFUL = 2;
  const groups: LegendGroup[] = [];
  const grp = (title: string, key: string,
               vals: { id: Id; label: string; swatch: Swatch }[], note?: string,
               min = USEFUL) => {
    if (vals.length < min) return;
    groups.push({ key, title, note, items: vals.map((v): LegendItem => ({
      id: v.id, label: v.label, swatch: v.swatch, on: focus[key]?.has(v.id) ?? false, ...stat(key, v.id),
    })) });
  };
  // NO SWATCH for the groups whose values are not a visual encoding of anything.
  const none: Swatch = { hidden: true };
  // COUNTED OVER THE SAME POPULATION THE CHIPS ARE. This note compares their sum
  // against a task total, so when the chips stopped counting finished work the
  // total had to stop too — otherwise the sentence is arithmetic that does not
  // check out, on the one line whose whole job is explaining the arithmetic.
  const left = doc.tasks.filter(drawn);
  const shared = left.filter(t => colorsOf(t).length > 1).length;

  // VALUES NOTHING IS IN ARE NOT OFFERED, the same rule `status` has always
  // used two groups down and for the same reason: a chip that filters to zero
  // tasks is a control whose only outcome is an empty chart. Combined with
  // `grp`'s two-value floor it also answers the commoner complaint — a plan
  // using one lane, or one border, stops carrying a row of legend that
  // discriminates nothing.
  //
  // THE ⚙ EDITOR STILL LISTS EVERY VALUE. This is the legend, which is a
  // filter; managing the channel is a different job and a different surface,
  // so an empty lane is invisible here and still editable there.
  // ...AND NEITHER ARE VALUES WITH NOTHING LEFT TO DO. A project whose every task
  // is finished or dropped is a chip that can only ever filter the chart down to
  // history, which is the same "control whose only outcome is useless" argument
  // one step further along.
  //
  // EXCEPT THE ONE YOU ARE STANDING ON. If the value is currently filtered, it
  // keeps its chip whatever its state — pulling it out from under an active
  // filter would remove the only control that could clear it, which is the
  // dangling-reference shape `isFiltering` already heals for deleted values.
  //
  // ...AND `drawn` IS WHAT DECIDES BOTH HALVES NOW. This was two clauses — the
  // value has tasks, and none of them are over — which is exactly
  // "does anything with this value survive the gates", once the gates can be
  // opened. With `done` ticked, a project whose work is all finished has rows on
  // the chart again, so it needs its chip back to filter them with; the old form
  // left the rows drawn and the control gone.
  const used = (ch: string, vals: any[]) =>
    vals.filter(v => focus[ch]?.has(v.id)
                  || doc.tasks.some(t => drawn(t) && valsOf(t, ch).includes(v.id)));

  grp(chLabel("lanes"), "lanes",
    used("lanes", doc.lanes || []).map(l => ({ id: l.id, label: l.label, swatch: none })));
  grp(chLabel("colors"), "colors",
    used("colors", doc.colors || []).map(x => ({ id: x.id, label: x.label,
      swatch: { style: { backgroundColor: x.color } } })),
    shared ? `${shared} unfinished task${shared === 1 ? " carries" : "s carry"} more than one colour, so these `
           + `counts add up to more than the ${left.length} tasks on the chart. That is the point of them.`
           : undefined);
  // Swatches render through the SAME functions the bars use, so the legend cannot
  // drift from the chart when environments are added or reordered.
  grp(chLabel("borders"), "borders",
    used("borders", doc.borders || []).map(e => ({ id: e.id, label: e.label,
      swatch: { style: cssObj(borderCss(e.id)) } })));
  grp(chLabel("fills"), "fills",
    used("fills", doc.fills || []).map(f => ({ id: f.id, label: f.label,
      swatch: { cls: `pat-${f.pattern || "solid"}` } })));
  grp(chLabel("shapes"), "shapes",
    used("shapes", doc.shapes || []).map(s => ({ id: s.id, label: s.label,
      swatch: { shape: SHAPES.includes(s.shape as any) ? s.shape! : "soft" } })));
  // STATES NOBODY IS IN ARE NOT OFFERED. `grp` already refuses a group under two
  // values, and this feeds it only the states that exist in the plan — so a plan
  // where nothing has been started shows no Status group at all, rather than three
  // chips of which two are empty and the third isolates 100% of the chart.
  grp(chLabel("status"), "status",
    STATUS.filter(s => doc.tasks.some(t => statusOf(t) === s.id))
      // NO SWATCH. See the note where the four `.k.st-*` rules used to live: a
      // legend swatch is a miniature of the bar, and status does not paint one.
      .map(s => ({ id: s.id, label: s.label, swatch: none })),
    "Read off the actual start and finish dates — not a field anyone sets.");
  // ONE VALUE IS ENOUGH HERE, and it is the only channel that gets that. The
  // two-value floor is right everywhere else — a channel with one value
  // discriminates nothing — but this one starts its life at one value and that
  // value is "Unrefined", on every task in the plan. Hiding it would mean you
  // cannot find the unrefined work until you have refined something, and you
  // cannot refine something you cannot find. It disappears again the moment
  // both values are gone, which is when everything live has been signed off —
  // the same "nothing left to do" rule `used()` applies to every other chip.
  grp(chLabel("refined"), "refined",
    REFINED.filter(r => doc.tasks.some(t => refinedOf(t) === r.id))
      .map(r => ({ id: r.id, label: r.label, swatch: none })),
    "Whether somebody has read this task and agreed with its title, description "
    + "and duration. Changing any of those three clears it — the sign-off was "
    + "about that wording. Finished and cancelled work is neither.", 1);
  grp(chLabel("ready"), "ready",
    READY.filter(r => doc.tasks.some(t => readyOf(t) === r.id))
      .map(r => ({ id: r.id, label: r.label, swatch: none })),
    "Not started, nothing in the plan holding it back — every dependency done, "
    + "its earliest date passed, its team free — and refined. Read off the "
    + "schedule and the sign-off, not a field anyone sets; the inspector says "
    + "which of them is in the way.");
  // A plan whose deadlines are all comfortable shows no group at all, which is
  // the right silence: this reading exists to name trouble, and no trouble is a
  // sentence better said by an absent chip than by a row of zeroes.
  //
  // ONE VALUE IS ENOUGH. The whole point is the case where exactly one state is
  // occupied — three tasks overdue and nothing else amiss is the most urgent a
  // plan ever gets, and the two-value floor would have hidden it behind a rule
  // about how many buckets happen to be full.
  grp(chLabel("risk"), "risk",
    RISK.filter(r => doc.tasks.some(t => riskOf(t) === r.id))
      .map(r => ({ id: r.id, label: r.label, swatch: none })),
    "Whether a deadline is in trouble, which is not the same as when it falls. "
    + "Overdue means the date has gone; Will miss means the schedule lands after "
    + "it; Tight means it lands inside the margin this plan asks for — the same "
    + "margin the Review panel is trying to buy you. Work with comfortable room is "
    + "in none of them, and finished work is in none of them either.", 1);

  mountLegend($("#legend"), {
    groups,
    isolate: focusMode === "isolate",
    effort: showEffort,
    showDone,
    clear: {
      shown: isFiltering() || !!chainFocus,
      // Chain focus is the other way rows go missing, so the button says so
      // rather than promising something it is about to only half do.
      label: chainFocus ? "show everything (chain focused)" : "show everything",
    },
    // Preview is suppressed once isolate is actually HIDING things. Previewing by
    // hiding would reflow the whole chart on every pointer move across the legend,
    // and previewing by dimming cannot show a row that is not rendered — so it
    // would answer the question with an empty grey chart. Until a subset is
    // committed the two modes are identical and preview works normally.
    canPreview: () => focusMode !== "isolate" || (!chainFocus && !isFiltering()),
    onPreview: (ch, id) => applyFilter({ ch, id }),
    onPreviewEnd: () => applyFilter(),
    onPick: (ch, id) => {
      focus[ch].has(id) ? focus[ch].delete(id) : focus[ch].add(id);
      // Dim can repaint in place; isolate has to rebuild the rows it removed.
      //
      // ...AND SO DOES A DONE OR CANCELLED PICK, in either lens. Those two chips
      // are not only filters: `drawDone` yields to them, so
      // picking one asks for rows that are not in the DOM at all, and
      // `applyFilter` can only grey what is already drawn. Picking Done on a
      // plan with the done toggle off greyed nine rows and produced no tenth —
      // the chip said 54 and the chart stayed empty, which is the exact "chart
      // calling the legend a liar" this file keeps having to fix. Unpicking is
      // the same move in reverse, so it takes the same branch.
      focusMode === "isolate" || (ch === "status" && GATED_STATUS.has(id))
        ? render() : applyFilter();
    },
    // Only the legend changes, so this redraws the legend rather than the chart —
    // unlike `isolate`, which decides which rows exist.
    onEffort: v => { showEffort = v; legend(); },
    // A FULL RENDER, not `legend()`: this one adds and removes rows, so the chart
    // has to be rebuilt rather than repainted. Same branch the isolate lens takes.
    onShowDone: v => { showDone = v; render(); },
    onIsolate: v => { focusMode = v ? "isolate" : "dim"; render(); },
    // The text box and the chain focus are the other two ways rows go missing, so
    // "show everything" empties those too or it is a button making a promise it
    // does not keep. All of that lives in `showEverything` now, shared with C.
    onClear: () => showEverything(),
  });
}

// ---- edits ----------------------------------------------------------------

// ONE PLACE THAT DRAWS A DEPENDENCY, because there are now two gestures that do
// it — click-link-click on either view, and dragging a handle between two nodes
// on the graph — and the cycle check below is the kind of thing that gets
// duplicated once and then fixed in only one of the copies.
//
// `tid` waits for `depId`. Returns whether the document changed, so a caller
// that has its own cleanup (the graph has a ghost edge to remove) can tell a
// refusal from a no-op.
function linkTasks(tid, depId) {
  if (!tid || !depId || tid === depId) return false;
  const t = taskById(tid);
  if (!t || t.deps.includes(depId)) {
    // `addDep` is idempotent by design — two people drawing the same arrow is a
    // race a room produces constantly — so this check is a courtesy rather than
    // the correctness argument it used to be.
    return false;
  }
  // THE CYCLE CHECK STAYS, AND STAYS IN FRONT. It used to apply the edit and undo
  // it on failure; now it runs on a throwaway copy BEFORE the command is emitted,
  // because a command is not a local edit to take back — send it and everyone in
  // the room has it. And the server will not catch this one: `invalid()`
  // deliberately does not look for cycles (that would be a second copy of the
  // scheduler on that side of the wire), so a cycle would be accepted,
  // broadcast, and turn every connected chart into the "⚠" verdict at once.
  const trial = structuredClone(rawDoc());
  applyCommand(trial, { type: "addDep", id: tid, dep: depId });
  // ASK THE GRAPH, NOT THE SCHEDULE. This ran `sched` and caught the throw
  // until a three-task cycle got through on a real plan: one of its members was
  // already finished, so it was seeded into the schedule rather than placed,
  // the forward pass never got stuck, and nothing threw. `hasCycle` reads the
  // edges themselves and cannot be fooled by a task the scheduler skipped.
  if (hasCycle(trial.tasks)) { flash("That would create a cycle.", true); return false; }
  emit({ type: "addDep", id: tid, dep: depId });
  return true;
}

function pick(tid) {
  if (linking) {
    // THE ONE LINE THE SECOND BUTTON IS FOR. `linkTasks(waiter, blocker)`, and
    // which of the two the armed task is depends on which button armed it.
    linkDir === "blocks" ? linkTasks(tid, linking) : linkTasks(linking, tid);
    linking = null; sel = tid; render(); return;
  }
  // CLICKING THE SAME TASK AGAIN GROWS THE PANEL. Two ways through the cycle
  // then: the button in the panel's corner, or just clicking the thing you are
  // already looking at — which is where your pointer already is, and which works
  // identically from a bar, a row label or a graph node because all three arrive
  // here. Selecting a DIFFERENT task leaves the size alone: reading descriptions
  // at full size and clicking the next task should not fold the panel.
  if (sel === tid) inspSize = (inspSize + 1) % 3;
  else sel = tid;
  render();
}

function startDrag(e, t) {
  e.preventDefault(); e.stopPropagation();
  // A FINISHED BAR'S WIDTH IS ITS OBSERVED SPAN, so the grip would edit `dur` and
  // change nothing on screen — a control that moves and does not move anything.
  // The estimate stays in the plan as a record of what was thought, not as
  // something to keep tuning once the answer is in.
  if (t.actualStart != null && t.actualEnd != null) {
    flash("That work is done — the bar is how long it actually took. Clear “Finished” to re-estimate.");
    return;
  }
  const x0 = e.clientX, s0 = st[t.id], sp0 = spanOf(t, s0), dur0 = t.dur;
  const move = ev => {
    // SNAP TO WHOLE DAYS. It used to snap to half-weeks, which was the finest
    // thing the old base unit could say — and the reason a one-day task was not
    // expressible at all. A day is now both the atom and the granularity, so a
    // live drag lands on a number someone can say out loud without rounding it
    // in their head first.
    //
    // PIXELS ARE CALENDAR, `dur` IS WORK. Adding the dragged distance straight
    // onto the duration was right only while those were the same quantity: drag
    // a bar's edge across a weekend now and it would claim two days of work that
    // nobody is going to do. So the pointer says where the END goes and the
    // answer is how much WORK fits between the start and there.
    //
    // The visible consequence is that the edge STICKS through non-working days
    // and then jumps — honest rather than smooth, and the same call the body
    // drag already makes when it hands back a pin the scheduler would not
    // honour. With the non-working days shaded it explains itself: the edge is
    // parked over days that cannot take any work.
    const span = Math.max(0, sp0 + (ev.clientX - x0) / PPD);
    // A SUB-DAY TASK DRAGS IN MINUTES. Flooring every drag at one whole day
    // turned a 29-minute step into a 1-day step on the first mousemove — a 50x
    // inflation, sequenced and persisted, from jitter. Day-scale tasks are
    // unaffected: unit is 1 for them, so this is the old expression exactly.
    const unit = t.dur < 1 ? 1 / 1440 : 1;
    const v = Math.max(unit, Math.round(workDaysIn(s0, span, CAL, t.id) / unit) * unit);
    // LOCAL ONLY WHILE THE BUTTON IS DOWN. The bar tracks the pointer exactly as
    // it always did; what changed is that the room hears about it once, on
    // release, instead of once per day crossed. See `preview`.
    if (v !== t.dur) preview({ type:"setDuration", id: t.id, dur: mins(v) });
  };
  const up = () => {
    removeEventListener("pointermove", move); removeEventListener("pointerup", up);
    const v = t.dur;
    // A drag that ended where it started is not an edit. This also covers a
    // preview a mid-drag rollback already took back.
    if (v === dur0) return;
    preview({ type:"setDuration", id: t.id, dur: mins(dur0) });
    emit({ type:"setDuration", id: t.id, dur: mins(v) });
  };
  addEventListener("pointermove", move); addEventListener("pointerup", up);
}

// DRAG THE BODY -> "it can't begin before <date>". The ask this answers was
// literally "let me drag the bar left and right", and the reason it is a
// constraint rather than a stored position is in the note over sched().
//
// Left is not symmetric with right, and that asymmetry is the feature:
//   * drag RIGHT -> a real constraint, honoured by every future reschedule.
//   * drag LEFT, past the earliest the plan allows -> the bar stops dead and
//     says what is holding it. There is no clamping code for this — the
//     scheduler simply ignores a floor it is already past, so the bar cannot
//     move and the refusal is the schedule's, not the UI's.
//   * drag LEFT, but still later than feasible -> lowers the constraint, and
//     clears it entirely once it stops binding. An inert constraint is worse
//     than none: it is invisible stored state that does nothing until some
//     unrelated edit makes it bite.
//
// A drag of under 4px is a click, and is left alone so selecting a bar still
// works. Past that, render() replaces the element under the pointer, so no
// click event follows and no suppression flag is needed.
function startConstrain(e, t) {
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY, w0 = st[t.id], had = t.notBefore ?? null, shift0 = SHIFT;
  const fin0 = finishOf(doc.tasks, st);
  // WHERE THE TASK SAT IN ITS QUEUE BEFORE THE GESTURE. `moveTaskInLane`'s
  // `toIndex` is an absolute lane-relative position, so a whole drag — however
  // many rows it crossed, in whichever direction — is expressible as ONE command
  // naming where it ended up. This is the position that command replaces, and the
  // one the preview is rewound to before it goes.
  const idx0 = doc.tasks.filter(x => x.lane === t.lane).findIndex(x => x.id === t.id);
  // The axis is decided once, on the first 4px of movement, and then held for
  // the rest of the drag. Deciding it per pointermove instead lets a drag flip
  // between retiming and reordering while the mouse is down, which in a meeting
  // looks exactly like the tool having a seizure.
  let axis: "x" | "y" | null = null, rows = 0, stuck = 0;
  const move = ev => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    // Select on the first real movement. Without this the inspector keeps
    // showing whatever was selected before, so its Not-before field describes a
    // different task than the bar under the pointer — and the normal click that
    // would have selected it never arrives, because the first render() of the
    // drag removes the element the pointer went down on.
    if (!axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return;
      axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
      sel = t.id;
    }
    // ---- VERTICAL: reorder within the team's queue ---------------------------
    // One swap per row crossed, applied against how many have been applied
    // already, so dragging back up undoes them one at a time instead of
    // reordering by the total distance travelled.
    //
    // This is the ↑/↓ buttons under a gesture, not a new concept: the lane is a
    // serial queue and the scheduler breaks ties by array position, so dragging
    // a bar up its lane is literally "do this one first". It cannot cross into
    // another team — a bar has no meaning in a lane that is not its own — so the
    // drag simply stops at the ends of the queue.
    // A FOLDED LANE HAS NO ROWS TO DRAG BETWEEN. The queue order is still real and
    // still reorderable with the inspector's arrows; what is missing is the space
    // that made the gesture mean anything, and 26px of travel would otherwise
    // reorder a queue you cannot see move.
    // A STARTED TASK HAS NO CONSTRAINT TO SET. Its start is seeded rather than
    // solved for, so a `notBefore` on it would be stored state that does nothing
    // — and the bar would sit still while you dragged it, which looks exactly
    // like the tool ignoring you. Said in `up()`, once per drag rather than once
    // per pointermove. The vertical half still works: row order is real.
    if (axis === "x" && t.actualStart != null) return;
    // A FOLDED LANE, OR A VIEW WITH NO QUEUE IN IT. Same reason both times: the
    // rows the gesture would move through are not on screen, so 26px of travel
    // would reorder a queue nobody can watch move. Said once in `up()`.
    if (axis === "y" && (COLLAPSED.has(t.lane) || ROWMODE === "date")) return;
    if (axis === "y") {
      const want = Math.round(dy / ROW);
      while (rows !== want) {
        const dir = want > rows ? 1 : -1;
        // LANE-RELATIVE, exactly like the up/down buttons. This used to walk
        // `doc.tasks` for the next element in the same lane and swap the two by
        // hand; that IS `moveTaskInLane` by one place. Routing both paths through
        // the one command is what keeps them agreeing on what "one place earlier
        // in the queue" means, so the shared helper they used to need is gone.
        const queue = doc.tasks.filter(x => x.lane === t.lane);
        const to = queue.findIndex(x => x.id === t.id) + dir;
        if (to < 0 || to >= queue.length) { stuck = dir; break; }
        // Local only. One command naming the final position goes on release —
        // see `preview`, and `idx0` for why one command says the whole drag.
        if (!preview({ type:"moveTaskInLane", id: t.id, toIndex: to })) break;
        rows += dir;
      }
      return;
    }
    // QUARTER HOURS. This was whole days, from when a start constraint was a
    // DATE; since v6 it is an instant, and rounding to days made a 1pm task jump
    // to the next morning on the first pixel — and put an hour out of reach.
    //
    // AND IT SNAPS FORWARD, or it silently vanishes. The rule below hands a pin
    // back whenever the scheduler placed the task later than it — on the
    // argument that then the floor is not what is holding it — and snapping
    // makes that true of EVERY weekend drop, so dropping a pin on a Saturday
    // would look exactly like the drag having done nothing. Moving the pin
    // itself puts it on a date work could actually begin, which is the only
    // thing a start constraint has ever meant, and leaves that rule untouched.
    const w = snapFwd(Math.round((w0 + dx / PPD) * 96) / 96), prev = t.notBefore ?? null;
    const next = w > 0 ? w : null;
    if (next === prev) return;
    // Local only, once per step crossed instead of one command per step crossed.
    // The inert-constraint rule below used to run here too, which made a single
    // leftward drag worth two commands per pointermove; it is a property of where
    // the task LANDED, so it is decided once, in `up()`.
    preview({ type:"setNotBefore", id: t.id, notBefore: whenOf(next) });
  };
  const up = () => {
    removeEventListener("pointermove", move); removeEventListener("pointerup", up);
    if (!axis) return;
    if (axis === "y") {
      // THE WHOLE DRAG, AS ONE COMMAND. Rewind the preview to where the room
      // still thinks this task is, then name the position it ended at.
      const to = doc.tasks.filter(x => x.lane === t.lane).findIndex(x => x.id === t.id);
      if (to >= 0 && to !== idx0) {
        preview({ type:"moveTaskInLane", id: t.id, toIndex: idx0 });
        emit({ type:"moveTaskInLane", id: t.id, toIndex: to });
      }
      // Same honest answer the ↑/↓ buttons give: a reorder that changes no date
      // means the queue was not what was holding that task.
      if (ROWMODE === "date")
        flash("Rows are ordered by date here — switch Rows to Team to reorder the queue.");
      else if (!rows) { if (stuck) flash("Already " + (stuck < 0 ? "first" : "last") + " in its team."); }
      else if (Math.abs(finishOf(doc.tasks, st) - fin0) < 1e-9)
        flash("Moved — no date change; something upstream is holding that task, not the queue.");
      return;
    }
    if (t.actualStart != null) {
      flash("That work has already started — its date is a fact, not a constraint.");
      return;
    }
    // WHERE THE PIN ACTUALLY SETTLES, decided once. Ask the scheduler rather than
    // pre-computing the feasible start: it already knows, it has just scheduled
    // the preview, and its answer stays right when moving this task reshuffles
    // the lane queue underneath it. If it placed the task later than the floor,
    // the floor is not what is holding it — and an inert constraint is worse than
    // none, because it is invisible stored state that does nothing until some
    // unrelated edit makes it bite.
    const want = t.notBefore ?? null;
    const settled = (want != null && st[t.id] > want + 1e-9) ? null : want;
    if (want !== had) preview({ type:"setNotBefore", id: t.id, notBefore: whenOf(had) });
    if (settled !== had) emit({ type:"setNotBefore", id: t.id, notBefore: whenOf(settled) });
    if (t.notBefore != null) {
      // The ALAP shift is recomputed from slack, so pushing a task on the
      // binding chain spends slack and slides everything ELSE left instead of
      // moving this bar. That is not a glitch to hide — it is the plan telling
      // you what the constraint cost, and the verdict line has already moved.
      const spent = shift0 - SHIFT;
      flash(`cannot start before ${fmtAt(t.notBefore)}`
        + (Math.abs(spent) > 1e-9 ? ` — plan re-aligned, ${calStr(Math.abs(spent))} of slack ${spent > 0 ? "spent" : "returned"}` : ""));
    } else if (had != null) {
      flash("start constraint cleared — as early as the plan allows again");
    } else {
      // `endOf`, NOT `start + dur`. This was the last surviving copy of the
      // assumption the working week was supposed to have deleted everywhere —
      // it lived in a MESSAGE rather than in the scheduler, so no assertion
      // covered it and the demo's all-on calendar made the two agree. On any
      // five-day plan it failed to recognise the dependency that was actually
      // holding the task and fell through to blaming the team's queue: a
      // confident answer, and the wrong one.
      const by = Object.fromEntries(doc.tasks.map(x => [x.id, x]));
      const d = t.deps.find(d_ => Math.abs(endOf(by[d_], st[d_]) - st[t.id]) < 1e-9);
      flash(`can't start before ${fmtAt(st[t.id])} — `
        + (d ? `waiting on ${name(d)}` : "its team's queue is busy until then"));
    }
  };
  addEventListener("pointermove", move); addEventListener("pointerup", up);
}

// THERE IS NO `beforeunload` GUARD, AND REMOVING IT WAS THE FIX rather than a
// regression. It was written when the tab WAS the only place unsaved work lived
// — plans were files and nothing autosaved, so closing mid-meeting threw the
// afternoon away. None of that is true now: every edit is a command the server
// applied and persisted into `data/<id>.json`, so closing this tab loses
// literally nothing. Worse, it was armed off `clean`, a per-browser snapshot, so
// a COLLEAGUE'S edit made Chrome refuse to close YOUR tab over work you never
// did and that was already durable in S3. A dialog that is wrong three times
// running is a dialog people learn to dismiss without reading.
//
// Save still matters, and it is not this — it writes a version with a NOTE, and
// the note is the only description of a change a human ever gets. That is worth
// a prompt in front of a deliberate act, never in front of closing a tab.

function flash(m: string, bad?: boolean) {
  const el = $("#msg"); el.textContent = m; el.className = bad ? "err" : "dirty";
  setTimeout(() => { if (el.textContent === m) el.textContent = ""; }, 3500);
}

// ---- rename propagation ----------------------------------------------------
// A task's name gets COPIED into other tasks — "Approve Rates API migration" is
// another task's name with a verb in front — and nothing kept the two honest. So
// a rename left the plan asserting a name that no longer existed anywhere, which
// is the same class of failure as a stored `status` disagreeing with its dates:
// two copies of one fact, and no rule about which one is right.
//
// FIXED AT THE MOMENT DRIFT IS CREATED, not by making names derived. The obvious
// alternative was a template syntax (`Approve <%= dep.label %>`), and it was
// rejected: it forks every read of `label` into stored-vs-rendered, so the chart,
// exports, History diffs, the text filter and the agent API would each have to
// pick one, and an agent reading the document would see something different from
// what the room sees. Plain strings are what keeps all of those the same thing.
//
// It also means this is one-way and one-shot: it fixes mentions as they go stale,
// and does nothing about mentions that were already stale before it existed.
let renameBefore: { id: Id; label: string } | null = null;

// THE FLOOR ON THE OLD NAME. A one- or two-character name matches most of the
// plan, and a dialog listing ninety rows is not a preview of anything. Long
// enough to be a name rather than an initial; the tick-boxes handle the rest.
const MENTION_MIN = 3;

const mentionsOf = (oldName, newName, exceptId) => {
  const out: any[] = [];
  for (const t of doc.tasks) {
    // The renamed task itself is not a mention of its own old name.
    if (t.id === exceptId) continue;
    for (const field of ["label", "desc"]) {
      const v = t[field];
      // Case-SENSITIVE, and every occurrence in the string, not just the first.
      // These names are copy-pasted, so an exact match is what people mean; a
      // loose match would silently rewrite text the preview said it would not.
      if (typeof v !== "string" || !v.includes(oldName)) continue;
      out.push({ id: t.id, field, to: v.split(oldName).join(newName), from: v });
    }
  }
  return out;
};

function mentionsPanel(oldName, newName, hits) {
  const n_ = k => `${k} mention${k === 1 ? "" : "s"}`;
  mountMentionsSub($("#mentions-sub"), { newName, count: hits.length });
  // Everything starts ticked; the dialog is "untick what should keep the old
  // wording", not "pick what to change".
  const on = hits.map(() => true);
  const picked = () => hits.filter((_, i) => on[i]);
  const paint = () => {
    mountMentions($("#mentions-list"), {
      oldName, newName,
      // SPLIT, NOT SPLICED. The component puts the marks BETWEEN the pieces, so
      // nothing anybody typed is interpolated into markup — which is what the old
      // "escape first, then split on the escaped needle" dance was buying.
      mentions: hits.map((h, i): Mention => ({
        id: h.id, where: h.field === "label" ? "name" : "note",
        parts: String(h.from).split(oldName), checked: on[i],
      })),
      onToggle: (i, v) => { on[i] = v; paint(); sync(); },
    });
  };
  const sync = () => {
    const k = picked().length;
    $("#mentions-apply").textContent = k ? `Update ${n_(k)}` : "Nothing selected";
    $f("#mentions-apply").disabled = !k;
  };
  paint();
  sync();
  $("#mentions").hidden = false;
  $("#mentions-close").onclick = $("#mentions-skip").onclick = closeMentions;
  $("#mentions-apply").onclick = () => {
    const sel = picked();
    closeMentions();
    if (!sel.length) return;
    // ONE BATCH, which is atomic server-side — so this is one History entry and
    // one line in the room rather than nine separate edits landing one by one in
    // front of whoever else is looking at the chart.
    call("commands", { cmds: sel.map(m => m.field === "label"
      ? { type:"renameTask",  id: m.id, label: m.to }
      : { type:"setTaskDesc", id: m.id, desc: m.to || null }) })
      .then(() => flash(`Updated ${n_(sel.length)} of “${oldName}”.`))
      // The server's own message, verbatim — same rule as `rollback`.
      .catch(err => flash(err.message, true));
  };
}
const closeMentions = () => { $("#mentions").hidden = true; };

// Called when the name field is LEFT, not as it is typed. `oninput` fires per
// keystroke and re-renders, so `onchange` is unreliable here: the re-render hands
// back a fresh input whose value already matches the document, and blurring that
// fires nothing. `onblur` always fires, and "I have finished renaming" is exactly
// what leaving the field means.
function renameSettled(tid) {
  const b = renameBefore; renameBefore = null;
  if (!b || b.id !== tid) return;
  const now = (taskById(tid) || {}).label || "";
  if (now === b.label || b.label.trim().length < MENTION_MIN) return;
  const hits = mentionsOf(b.label, now, tid);
  if (hits.length) mentionsPanel(b.label, now, hits);
}

// ---- new / fork ------------------------------------------------------------
// Both write to the server IMMEDIATELY rather than leaving an unsaved plan in
// the tab. A forked plan that exists only in memory has no id, so it has no URL
// — and a plan with no URL is a plan nobody can reach, including the person who
// just made it, the moment they refresh.
const slug = s_ => (s_ || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "").slice(0, 40) || "plan";


// MIGRATIONS[i] takes a doc at version i and returns it at version i+1.
// Index 0 is a hole: docs start at v1, so a v0->v1 rung would exist only to be
// tripped over.


// ---- THE STORE ------------------------------------------------------------
// ONE STORE. THE SERVER. NEVER A SECOND ONE.
//
// This tool used to run in two worlds: a machine with the Bun backend, where
// plans are JSON files you can diff and back up, and a static host with no
// backend at all, where the only durable place was the browser. A probe at boot
// picked one and a control in Settings switched between them.
//
// Both are gone, because the document is no longer this tab's to hold. The
// server is authoritative — it sequences everyone's edits — so a store the
// browser could write on its own would be a second truth with no way to merge it
// back. The old warning still names the failure exactly, it is just settled a
// different way now: two writable stores means every Save has to answer "which
// one is truth", and the failure is quiet and horrible — you edit, you Save, the
// browser copy takes it, and the file on the server silently does not change.
// There is one store, always, with no fallback and nothing to choose.

// ---- HISTORY --------------------------------------------------------------
// A plan's past is a SIDECAR, never a field on the document. In the document it
// would make every plan read as permanently unsaved (that answer is a string
// comparison against the last save), send the migration ladder walking through
// nested old documents, and rewrite the entire archive on every save.
//
// One snapshot site, and this is the whole reason history is allowed here where
// undo was not: it hangs off Save and nowhere else. Undo needed a push at 28
// mutation sites and two features shipped without one. You cannot add an edit
// and forget to snapshot it, because snapshotting is not per-edit.
//
// The archive is UNBOUNDED. It used to be gzipped and capped at 200 versions,
// because localStorage has a ~5MB budget; on the server these are 16KB files and
// a ceiling would be solving a problem only the browser had.

// A version's headline numbers. d0(), dayOf() and fmtEnd() all read the global
// `doc` — the entire date system is anchored to the OPEN plan's start date — so
// asking them about an old version means pointing the global at it for one
// synchronous computation and putting it back. Nothing can observe the swap:
// there is no await inside. The alternative is threading a doc argument through
// d0, dayOf, calOf, fmt and every one of their call sites for the same answer.
function statsOf(d) {
  const held = doc;
  try {
    if (!d || !d.tasks || !d.tasks.length) return { tasks: 0, at: null };
    // THE LADDER RUNS HERE TOO, and leaving it out was a real hole rather than a
    // tidiness point. Opening a version migrates it — that is what adopt() does
    // on every load path — so a row that scheduled the STORED document answered a
    // different question than the chart it claims to agree with. Silently and
    // plausibly: a pre-v4 document holds durations in weeks, so a six-week task
    // schedules as six DAYS and the row shows a date that is merely wrong rather
    // than obviously broken. Nothing on disk hits this today; an archive imported
    // from an older export does, and every entry here does the day SCHEMA moves.
    d = applyMigrations(structuredClone(d));
    // Guarded like the live one: a measurement pass that WROTE to the version it
    // is measuring is a bug worth hearing about, not one worth permitting
    // because the document is a throwaway.
    doc = guard(d);
    const cal = calOf(d);
    const tasks = doc.tasks;   // through the guard: day numbers, which `sched` counts in
    const fin = finishOf(tasks, sched(tasks, d.lanes, cal), cal);
    // ABSOLUTE, not the day number. Day numbers are relative to each version's own
    // start date, so two versions that moved their start would compare as equal
    // while landing weeks apart.
    return { tasks: d.tasks.length, ends: fmtEndAt(fin),
             at: Date.parse(d.start + "T00:00:00Z") + fin * DAY };
  } catch {
    // A restored plan can hold a cycle the current code refuses. That is a row
    // that reads "—", not a panel that fails to open.
    return { tasks: (d && d.tasks && d.tasks.length) || 0, at: null };
  } finally { doc = held; }
}

// EVERY PATH IS RELATIVE. The base URL is the page's own URL, so one deployment
// serves any number of plans with nothing about an origin configured anywhere.
//
// THIS IS LOAD-BEARING, NOT AN ACCIDENT. It was briefly replaced with a configurable
// absolute sync URL, on the assumption that a page on CloudFront and a server on the
// ALB had to be two origins. They do not: one distribution fronts both, default
// behaviour to S3 and `api/*` to the ALB, so the page and the API share an origin and
// these paths resolve with nothing configured. Making them absolute would mean the
// deployed page carries its server's hostname — a page that must be rebuilt to be
// redeployed — and would drag in CORS, a preflight on every POST, and a config
// mechanism, to buy nothing.
//
// FOR WHOEVER ADDS THE WEBSOCKET: derive its URL from `location.origin`, not from
// a base-URL constant. private-tldraw does `SYNC_HTTP.replace(/^http/, 'ws')`,
// which only works because it HAS a base URL; there is none here and there must
// not be one, so the same-origin equivalent is
// `location.origin.replace(/^http/, "ws")`. Copying tldraw's line verbatim against
// an absent constant yields "" — a WebSocket to nowhere, at runtime, with no
// build-time complaint.
//
// THERE IS NO `list()`, AND THERE MUST NOT BE ONE. An endpoint that enumerates
// plans hands anyone holding one valid link the ids of every other plan — and
// the id is not the capability, the link is. Ids are human-meaningful by design
// and become filenames, so `eadvantage-member-api` is guessable on the first try
// by anyone who knows the client. See docs/adr/0002-capability-tokens-no-sso.md.
// WHO YOU ARE, WHICH IS WHATEVER YOU SAY. ADR 0002 removed the identity
// provider that could have answered this, so attribution is a self-chosen label
// prefilled with a random handle — NOTHING VERIFIES IT, on either side. It rides
// on save attribution, on the `hello` frame, on every presence update, and it is
// what the who-is-here strip and the cursor labels show. Read a name in this tool
// as a courtesy, never as a claim: anyone in the room can type anyone's.
//
// It is remembered per-browser, because a random handle that changes on every
// reload makes the History panel a list of strangers who were all you.
const NAME_KEY = "ts:me", COLOR_KEY = "ts:mecolor";
const WHO_COLORS = ["#5aa9f0","#b98bf0","#d9a95c","#5fc9a3","#e0797f","#8fd15a","#e0b84f","#7f8fa6"];
const stored = k => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

let ME = stored(NAME_KEY).slice(0, 60) || "guest-" + Math.random().toString(36).slice(2, 7);
remember(NAME_KEY, ME);
// A colour of your own, kept separately from the name so changing what you are
// called does not change which cursor on the chart is yours mid-meeting.
const MY_COLOR = /^#[0-9a-f]{6}$/i.test(stored(COLOR_KEY)) ? stored(COLOR_KEY)
  : WHO_COLORS[Math.floor(Math.random() * WHO_COLORS.length)];
remember(COLOR_KEY, MY_COLOR);
/** A stable colour for a peer that sent none — anything is better than every
 *  unlabelled cursor being the same grey. */
const hueOf = s => WHO_COLORS[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % WHO_COLORS.length];

// EVERY CALL CARRIES THE TOKEN AS A HEADER AND NAMES NO PLAN. Both halves are
// ADR 0002, and neither is stylistic.
//
// The token is a header rather than a query parameter because a query string
// lands in CloudFront and ALB access logs, and with the capability in the URL
// that is the capability in the logs. The fragment never reaches a server at
// all, which is why it lives there and is copied onto each request by hand.
//
// AND THERE IS NO `id` PARAMETER ANYWHERE BELOW. The server resolves which plan
// a request is for from the token alone. If a request could carry both a token
// and an id the server honoured, one valid token would read every plan by
// varying the id — the enumeration the whole model forbids, arriving through the
// back door. So the page cannot ask for a plan it was not given a key to, by
// construction rather than by discipline.
/** WAKE THE SERVER BEFORE THE FIRST REQUEST, ONCE.
 *
 *  The sync server scales itself to zero after IDLE_SHUTDOWN_MINUTES and nothing
 *  else brings it back — so without this, an idle app stayed down and the "it may
 *  still be waking" message below was false: reloading would not have helped,
 *  because no reload was asking anything to wake.
 *
 *  `wake` is a RELATIVE path, routed to the wake Lambda by a CloudFront behavior,
 *  for the same reason `api/` is: this page has no build step, so there is nowhere
 *  to bake a Function URL, and same-origin means no CORS preflight in front of the
 *  one request whose whole job is to be quick.
 *
 *  Fired once and awaited by every call, so the wake is ISSUED before the first
 *  request leaves — but it is not waited ON. Waking returns as soon as the desired
 *  count is set; the task still needs ~30-90s, so the first call after a cold start
 *  will still fail and the page will still say so. The difference is that now it is
 *  telling the truth, and the reload it suggests will work.
 *
 *  Failure here is deliberately swallowed. A wake that does not happen degrades to
 *  exactly the old behaviour; it must never be the reason a request was not tried. */
let wakePromise: Promise<unknown> | null = null;
const wake = () => (wakePromise ??= fetch("wake", { method: "POST" }).catch(() => {}));

/** WAKE THE SERVER AND WAIT FOR IT, SAYING SO WHILE IT HAPPENS.
 *
 *  The old behaviour on a cold visit was a red panel reading "the plan could not
 *  be loaded ... reload in a moment", which was both alarming and wrong: nothing
 *  was broken, the server was simply parked at zero and needed ~30-90s. Telling
 *  somebody their client's delivery plan may have been revoked, when the truth is
 *  "hold on", is the worst possible reading of a normal state.
 *
 *  Returns once the service reports a running task, or once it has clearly given
 *  up. It never throws: a wake that fails must fall through to the socket attempt
 *  and the existing error path, not replace them with a new failure.
 *
 *  The banner only appears if the server is actually cold. A warm visit -- the
 *  common one -- sees nothing at all and pays one extra round trip. */
async function wakeAndWait() {
  const poke = () => fetch("wake", { method: "POST" })
    .then(r => r.json()).catch(() => null);

  let r = await poke();
  // Unreachable, or already up: nothing to show, nothing to wait for.
  if (!r || r.running > 0 || r.status === "ready") return;

  const box = bannerHost("wakesplash", "accent");

  // ~2 minutes. A Fargate cold start is 30-90s; past that something is wrong and
  // the socket attempt plus the real error panel are a better answer than a
  // progress bar that never ends.
  const DEADLINE = Date.now() + 120000;
  const started = Date.now();
  const paint = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    const pct = Math.min(97, Math.round((Date.now() - started) / 90000 * 100));
    mountWakeSplash(box, { up: false, secs, pct });
  };
  paint();
  const tick = setInterval(paint, 1000);

  try {
    while (Date.now() < DEADLINE) {
      await new Promise(f => setTimeout(f, 3000));
      r = await poke();
      if (r && (r.running > 0 || r.status === "ready")) {
        // The task is up, but the load balancer still has to see it pass a health
        // check before it will route anything. Connecting the instant the count
        // flips lands on a 503 and looks exactly like the failure this replaced.
        mountWakeSplash(box, { up: true, secs: 0, pct: 100 });
        await new Promise(f => setTimeout(f, 2500));
        return;
      }
    }
  } finally {
    clearInterval(tick);
    box.remove();
  }
}

async function call(path: string, body?: unknown) {
  await wake();
  const r = await fetch("api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-timeline-token": shareToken(),
      "x-timeline-by": ME,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // The server's own message, verbatim, wherever it sent one — `validateCommand`'s
  // or `invalid()`'s words are the only ones that can tell somebody what to fix.
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path} failed (${r.status})`);
  return j;
}

/** IS THERE A PLAN TO SEND TO. The batch path goes over HTTP with the token read
 *  out of the URL, so — unlike `emit` — it cannot be aimed at a room this tab
 *  happens to still be joined to; the token names the plan on screen or there is
 *  no token at all. The one case left is the fixture, which has neither, and
 *  which would otherwise ask the server for the plan named by an empty capability
 *  and get back "no such plan": a true sentence about a question nobody asked. */
const onAPlan = () => shareToken() && id !== "demo" ? true
  : (flash("The demo is a fixture, not a plan — nothing here is sent anywhere. "
         + "Fork it and the copy is yours to edit.", true), false);

// ---- WHAT THE SERVER DOES NOT HAVE ----------------------------------------
// Not oversights, and not TODOs to route around by finding the nearest endpoint
// that answers — that would be actively dangerous pointed anywhere. `/api/save`
// takes neither an id nor a document; it archives whatever plan the TOKEN names.
// So aiming a "create" at it would quietly archive the plan you are LOOKING at
// under the new plan's note and then show you the same plan back.
//
// WRITING A WHOLE ARCHIVE (Import restoring a plan's past) is the one still
// missing. The archive is append-only through /api/save, so an imported plan
// arrives with the single version /plan/new writes for it and its old history
// stays in the file. Said out loud at the import site rather than dropped.
//
// CREATING A PLAN IS NO LONGER ON THIS LIST. `POST /api/plan/new` mints the id
// and the share token together — see the route header in server.ts for why the
// token comes back in the response BODY and nowhere else.
const noRoute = what => { throw new Error(
  `${what} is not available: the command server has no endpoint for it. `
  + `Nothing was written.`); };

const serverStore = {
  /** The live shared draft — what everyone in the room is looking at right now.
   *  The socket's `welcome` is the normal way in; this is the re-sync path. */
  async plan() { return call("plan"); },
  /** Archive the LIVE document as the next version. The document is not sent:
   *  every edit reached the room as a command already, so the server is the one
   *  holding the thing being archived. */
  async save(note) { return call("save", { note }); },
  async history() { return (await call("history")).versions || []; },
  /** The newest save's metadata and nothing else — one stored object, not the
   *  archive. `meta=1` alone only trims the RESPONSE; the server still has to
   *  read every version to find the notes inside them. */
  async lastSave() { return ((await call("history?meta=1&last=1")).versions || [])[0] || null; },
  /** One version, by number. The whole archive used to be read to find it. */
  async version(n) { return call("version?n=" + n); },
  async setNote(n, note) { await call("histnote", { n, note }); },
  async revert(n) { return call("revert", { n }); },
  /** New, Fork and Import, which are one operation differing only in what
   *  document you supply — New supplies none and gets the server's starter.
   *
   *  THE ID IS THE SERVER'S TO CHOOSE, and the response says which one it used.
   *  The page used to slug a title itself and probe `idTaken` in a loop for a
   *  free one; both halves are gone, because the probe was the existence oracle
   *  ADR 0002 refuses to answer and it failed OPEN when the backend was asleep.
   *
   *  Returns `{ id, shareToken }`. The token is the ONLY way back to what was
   *  just made — there is no `/list` — so a caller that drops it has lost the
   *  plan. Never log it. */
  // A NEW plan is counted in this browser's zone; a forked or imported one
  // carries its own, and the server ignores this for those.
  async create(title, doc_, note) { return call("plan/new", { title, doc: doc_, note,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }); },
  async putHistory() { noRoute("Writing a whole archive"); },
};

const store = serverStore;

// ---- THE ROOM -------------------------------------------------------------
// The socket, the optimistic apply, and the rollback. Frame-for-frame the other
// half of `ServerFrame` in sync-server/src/room.ts, which is the contract.
let sock: WebSocket | null = null, sockEpoch: string | null = null, sockSeq = 0,
    sessionId: string | null = null, joined = false, sockPlanId: string | null = null;
let backoff = 500;

// ---- WHAT "UNSAVED CHANGES" MEANS, AND WHOSE IT IS ------------------------
// It is the ROOM'S, not this tab's. This used to be `clean` — a string of the
// document as this browser last saw it stored — and a per-browser snapshot
// cannot answer a question about a shared plan. A colleague's edit marked YOUR
// tab dirty; their Save did not clear it; and it armed a tab-close guard over
// work that was already durable in S3. Three people looking at one plan got
// three different answers about one plan.
//
// The server's sequence number is the shared answer. Every command in this room
// gets one, in order, off the same wire everyone else is on — so `sockSeq` and
// `savedSeq` are numbers every tab computes identically, and the indicator stops
// being an opinion.
//
// WHAT IT CANNOT SEE, said out loud rather than papered over. The `saved` frame
// carries no sequence number of its own (see ServerFrame in room.ts), so this
// reads OUR seq at the moment the frame arrives — a command sequenced during the
// save's S3 round trip is counted as saved when it was not. And it starts
// counting from where we JOINED, so a room that was already dirty before we
// arrived reads as clean until the next edit. Both err towards saying nothing,
// which is the right direction of error now that closing the tab loses nothing.
let savedSeq = 0;
// Who has changed the plan since that save, and how much. `cmd` frames carry
// `by`, and this is the only reason Revert can name whose work it is about to
// throw away instead of asking "are you sure?" about an unnamed quantity.
const sinceSave = new Map();

const unsavedCount = () => (doc && id !== "demo" ? Math.max(0, sockSeq - savedSeq) : 0);

/** Whose work is in it, in the order they first touched it, with ours named as
 *  "you" — the one substitution worth making, because "guest-k3f9q's changes"
 *  is not how anybody thinks about their own edits. */
function unsavedBy() {
  const names = [...sinceSave.keys()].map(n => n === ME ? "you" : n);
  return names.length <= 1 ? names.join("")
    : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

const unsavedStr = () => {
  const n = unsavedCount();
  if (!n) return "";
  const who = unsavedBy();
  return `${n} unsaved change${n === 1 ? "" : "s"}${who ? ` · ${who}` : ""}`;
};

const countChange = by => { const n = by || "someone"; sinceSave.set(n, (sinceSave.get(n) || 0) + 1); };

/** `render()`, but the caret survives it. `renderKeepFocus` wants the selector of
 *  the control to restore, which the edit's own handler knows and an inbound
 *  frame does not — so it is derived from whatever happens to be focused. Every
 *  field this matters for has an id (`#lab`, `#desc`, `#dur`, `#title`), because
 *  the inspector is built from a template literal; anything without one gets a
 *  plain render, which is what it got before. */
function renderInbound() {
  const a = document.activeElement;
  if (a && a.id && a !== document.body) renderKeepFocus("#" + CSS.escape(a.id));
  else render();
}
// ---- PRESENCE -------------------------------------------------------------
// EVERYONE ELSE IN THIS ROOM, AND WHERE THEY ARE POINTING.
//
// NOT COMMANDS, AND NEVER SEQUENCED. The room keeps presence out of the replay
// buffer on purpose (see PRESENCE in sync-server/src/room.ts): a cursor moves
// tens of times a second, so sequencing it would burn the 1024-entry log in under
// a minute and cost every reconnecting client its optimistic state — to replay
// pointer positions that are stale by the time they land. It is never persisted
// either, or a cursor would be archived into History and read back tomorrow as if
// somebody were still there. Nothing below goes near `emit`.
//
// A CURSOR IS `{day, laneRow}` IN CHART COORDINATES, NEVER PIXELS. Everybody has
// their own zoom, their own scroll position and their own folded lanes, so a
// pixel from one screen means nothing on another — it would put a colleague's
// pointer over a different task, confidently, which is worse than not drawing it.
// `day` counts from `doc.start` and may be fractional or negative, exactly like
// `notBefore`; `laneRow` counts rows from the top of the grid in the same units.
//
// The honest limit of `laneRow`: folding is per-tab view state, so a peer who has
// collapsed a lane you have open has fewer rows above the same task and their
// cursor lands a row or two off. Rows are what the wire format offers, the drift
// is bounded by how much folding differs, and the alternative — sending a task id
// — cannot express pointing at the gap between two of them, which is most of what
// pointing at a chart is for.
const peers = new Map();

// HERE AND NOT ON THE DOCUMENT. Whether you are showing yourself is a property
// of this tab in this session — the same kind of thing as the zoom and the
// isolate lens — so it rides in the fragment and touches no plan. It is also why
// it survives a reload: closing a laptop mid-meeting and coming back visible is
// exactly the surprise this exists to prevent.
let LURK = false;

/** Presence goes down the socket and nowhere else. Silent when there is no room
 *  to tell — the fixture has no socket, and a queued cursor would be a lie by the
 *  time one existed. Silent while lurking too: the server drops these anyway
 *  (there is no presence entry to patch), so sending them would be twenty
 *  frames a second asking to be ignored. */
function sendPresence(patch) {
  if (LURK || !joined || !sock || sock.readyState !== WebSocket.OPEN) return;
  sock.send(JSON.stringify({ type: "presence", ...patch }));
}

// RATE-LIMITED, BECAUSE A POINTER IS NOT AN EDIT. `pointermove` fires per frame
// or faster; 20/s is past the point anybody can see the difference and it keeps a
// room of six people from spending a socket each on mouse jitter. The LAST
// position always goes — the trailing timer sends whatever the pointer settled
// on, so a cursor never parks somewhere it has already left.
const CURSOR_MS = 50;
let curAt = 0, curTimer = 0, curNext: any = null;
function sendCursor(c) {
  curNext = c;
  const wait = CURSOR_MS - (Date.now() - curAt);
  if (wait <= 0) { curAt = Date.now(); sendPresence({ cursor: curNext }); return; }
  if (!curTimer) curTimer = setTimeout(() => {
    curTimer = 0; curAt = Date.now(); sendPresence({ cursor: curNext });
  }, wait);
}

/** A pointer event in the chart's own units. The inverse of the `X()` render
 *  uses, read off `#grid`'s box so the horizontal scroll is already accounted
 *  for — the box moves with the scroller, the numbers do not. */
function chartCursor(e) {
  const g = $("#grid");
  if (!g || !doc) return null;
  const r = g.getBoundingClientRect();
  return { day: LO + (e.clientX - r.left - LABW) / PPD, laneRow: (e.clientY - r.top) / ROW };
}

/** One person, as a chip. Yours is dashed and clickable; theirs is a label. */
/** The one chip that is yours, and its two titles. It is drawn LOCALLY rather
 *  than from the roster, so it is still here while lurking — and it has to be, or
 *  the one state you can forget you are in is the one with no indicator. */
const myChip = (): WhoChip => ({
  name: ME, color: MY_COLOR, mine: true, lurking: LURK,
  title: LURK
    ? "You are hidden: no cursor, no chip in anyone else's roster, and you are not "
      + "in the viewer count. Your EDITS still carry this name — this hides a "
      + "pointer, not an author.\nClick to change the name."
    : "This is the name on your saves and your cursor. Click to change it.\n"
      + "Nothing verifies it — it is a label, not a claim.",
});

function renameMe() {
  const v = prompt("Show up as:", ME);
  if (v == null) return;
  ME = String(v).trim().slice(0, 60) || ME;
  remember(NAME_KEY, ME);
  sendPresence({ name: ME });
  drawPresence();
}

function drawWho() {
  const el = $opt("#who");
  if (!el) return;
  // Nothing to be present IN until a room has let us in. The fixture must never
  // show a roster: there is no room, and one person alone in a plan is not news.
  el.hidden = !joined;
  mountWho(el, !joined ? [] : [myChip(), ...[...peers.values()].map((p): WhoChip => ({
    name: p.name || "someone", color: p.color || hueOf(p.sessionId), mine: false, lurking: false,
    title: (p.name || "someone") + " has this plan open. Names are self-chosen and unverified.",
  }))], renameMe);
}

function drawCursors() {
  const g = $opt("#grid");
  if (!g) return;
  // The layer is created once and then belongs to React. `renderInner` clears the
  // grid by removing `.row,.lane-head,…` by selector, so it is not swept up with
  // the rows — which is what lets the pointers survive a render they did not
  // cause.
  let layer = g.querySelector("#cursors") as HTMLElement | null;
  if (!layer) { layer = document.createElement("div"); layer.id = "cursors"; g.append(layer); }
  // THE GRAPH LENS HAS NO DAY AXIS, so a chart coordinate has nowhere to land on
  // it. Drawing them at the timeline's scale over a force layout would put five
  // pointers in the top-left corner and call it multiplayer.
  const off = VIEW_MODE === "graph" || VIEW_MODE === "board" || VIEW_MODE === "calendar" || !doc;
  mountCursors(layer, off ? [] : [...peers.values()].flatMap((p): Cursor[] => p.cursor ? [{
    key: p.sessionId,
    name: p.name || "someone",
    color: p.color || hueOf(p.sessionId),
    // THEIR CHART POSITION, OUR SCALE. This is the whole point of sending days
    // and rows: `PPD`, `LO` and `LABW` are ours, so their pointer lands on the
    // same TASK on our screen however differently we are zoomed.
    left: LABW + (p.cursor.day - LO) * PPD,
    top: p.cursor.laneRow * ROW,
  }] : []));
}

/** Both halves, together, because both are answers to "who else is here" and a
 *  strip that disagrees with the cursors is worse than either alone. */
function drawPresence() { drawWho(); drawCursors(); }
// ref -> the optimistic command still awaiting the server's answer.
const pending = new Map();
let refN = 0;

// ---- WHAT A REJECTION UNDOES, AND WHAT IT MUST NOT ------------------------
// A REJECTION UNDOES YOUR COMMAND. IT MUST NOT UNDO ANYONE ELSE'S.
//
// This used to keep a whole-document clone per pending command and restore it —
// exact for the command it covered, and wrong about everything that had happened
// since. A peer's `cmd` frame lands in the window between our emit and the
// server's `rejected`, gets applied here, and the restore throws it away. It is
// not recoverable either: `sockSeq` has already moved past that command, so no
// resume replays it and the tab silently disagrees with the room about a plan
// nobody can see is wrong. That is the exact failure mode ADR 0001 exists to
// prevent, reintroduced by the error path.
//
// So the rollback point is a snapshot plus a JOURNAL rather than a snapshot
// alone. `journalBase` is the document as it stood before the FIRST unacknowledged
// command; `journal` is every command applied locally since, ours and theirs, in
// the order they were applied. Undoing one is replaying the journal from the base
// with that one entry left out — which keeps every other command, whoever sent it,
// and keeps them in the order the room applied them.
//
// It is live only while something is unacknowledged. With nothing pending there
// is nothing to undo, so the base is dropped and the ordinary path costs one
// `pending.size` check.
let journalBase: Doc | null = null;
const journal: any[] = [];

/** Nothing of ours is in flight any more, so there is nothing to undo. */
const clearPending = () => { pending.clear(); journal.length = 0; journalBase = null; };

/** Apply an inbound command, and record it if a rollback might have to replay
 *  past it. Anything applied locally while we hold an unacknowledged command has
 *  to be in the journal, or undoing ours would drop it. */
function applyInbound(cmd) {
  applyCommand(rawDoc(), cmd);
  if (pending.size) journal.push({ ref: null, cmd });
}

/** A RENAME IS THE ONE EDIT "PLANS YOU HAVE OPENED" CAN SEE — whoever made it.
 *  The entry is keyed by the token, so this keeps the name in the list the name
 *  the plan actually has, rather than the one it had the first time it was
 *  opened. Called after the command is applied, so `doc.title` is the new one. */
const renamed = cmd => {
  if (cmd.type === "patchDoc" && "title" in cmd.patch) rememberPlan();
};

function wsURL() {
  // DERIVED FROM THE PAGE'S OWN URL, and the long note over `call` above says
  // why there is no base-URL constant to derive it from instead. private-tldraw
  // writes `SYNC_HTTP.replace(/^http/, "ws")`, which works only because it HAS
  // a base URL; copied verbatim against an absent constant it yields "", which
  // is a WebSocket to nowhere — at runtime, with nothing complaining at build
  // time. One URL object handles the origin, the page-relative path and the
  // scheme together.
  const u = new URL("api/connect", location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

/** Open the room and resolve once the server has answered — with `welcome`, with
 *  `resume`, or with the `error` that means this token names no plan. Boot awaits
 *  this, so it must settle either way. */
function connect() {
  return new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(undefined); } };
    // CLOSE THE ONE WE ALREADY HAVE FIRST. Assigning over `sock` orphans the old
    // socket without closing it: the server still holds that session, so the
    // room's `viewers` climbs 1 → 2 → 3 with one person in it, the plan never
    // reaches zero sessions and the service never scales to zero. It is also
    // visible from inside the tab, which is how it was found — every orphan is
    // still receiving broadcasts and still running onFrame, so ONE successful
    // edit came back as several `cmd` frames and got applied more than once.
    // `sock = null` before close() so this socket's own onclose sees it has been
    // superseded and does not start a reconnect loop.
    if (sock) { const old = sock; sock = null; try { old.close(); } catch {} }
    const s = new WebSocket(wsURL());
    sock = s;
    s.onopen = () => {
      backoff = 500;
      // `since` ONLY WHEN NOTHING IS IN FLIGHT, and that condition is the whole
      // subtlety of reconnecting. A resume replays every command the server
      // sequenced while we were away. If we still hold an optimistic command
      // that was accepted just before the socket dropped, that command is BOTH
      // already in our document and in the replay — and applying it twice is
      // exactly the silent divergence all of this exists to prevent. With
      // nothing pending the replay is unambiguous. Otherwise we ask for nothing,
      // and taking the whole document IS the instruction: `welcome` means
      // discard anything you have not seen acknowledged.
      s.send(JSON.stringify({
        type: "hello", token: shareToken(), name: ME, color: MY_COLOR, lurk: LURK,
        ...(sockEpoch && !pending.size ? { since: { epoch: sockEpoch, seq: sockSeq } } : {}),
      }));
    };
    s.onmessage = ev => {
      try { onFrame(JSON.parse(ev.data)); }
      catch (e) { flash(e.message || String(e), true); }
      done();
    };
    s.onerror = () => done();
    s.onclose = () => {
      if (sock !== s) return;              // already superseded by a newer socket
      sock = null;
      done();
      // Only reconnect to a room we were actually let into. Retrying a token the
      // server refused would be an infinite loop against a closed door.
      if (!joined) return;
      flash("connection lost — reconnecting…", true);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
  });
}

// A HIDDEN TAB LEAVES THE ROOM, and comes back when it is looked at. An open
// socket is an open room, and the idle shutdown counts open rooms — so one
// forgotten background tab kept the service up all night. HIDDEN, NOT UNFOCUSED
// OR UNTOUCHED: a plan on a second monitor or a shared screen is still being
// read, and must stay live. The wait is so a quick tab switch costs nothing.
// Leaving is the same deliberate leave playback does; coming back is its rejoin,
// woken first because the service may have parked while we were away.
const HIDDEN_LEAVE_MS = 5 * 60_000;
let hiddenTimer = 0, leftHidden = false;
function leaveWhileHidden() {
  if (!document.hidden || PLAY || !joined || !sock) return;
  // NOTHING IN FLIGHT: an edit still waiting on its ack would come back as a
  // rollback. Try again shortly rather than never.
  if (pending.size || applyAll) { hiddenTimer = setTimeout(leaveWhileHidden, 10_000) as unknown as number; return; }
  const old = sock; sock = null; try { old.close(); } catch {}
  joined = false; leftHidden = true;
}
document.addEventListener("visibilitychange", () => {
  clearTimeout(hiddenTimer);
  if (document.hidden) hiddenTimer = setTimeout(leaveWhileHidden, HIDDEN_LEAVE_MS) as unknown as number;
  else if (leftHidden) { leftHidden = false; (async () => { await wakeAndWait(); await connect(); })(); }
});

function onFrame(f) {
  switch (f.type) {
    // FULL STATE. The server decided we cannot be resumed, and that decision
    // MEANS discard every optimistic edit we have not seen acknowledged — it is
    // not our call, which is why there is no flag on the frame to get wrong.
    case "welcome":
      sessionId = f.sessionId; sockEpoch = f.epoch; sockSeq = f.seq; joined = true; sockPlanId = f.id;
      // We have seen no save in this room, so this is where the count starts.
      // See `savedSeq` for why an understatement is the acceptable error here.
      savedSeq = f.seq; sinceSave.clear();
      clearPending();
      peers.clear();
      for (const p of f.presence) peers.set(p.sessionId, p);
      adopt(f.doc, f.id);
      drawPresence();
      // THE LENS YOU LEFT IT IN. Restored here rather than at boot because the
      // key is per plan and the plan id arrives with this frame — reading it
      // any earlier keys off an empty string and every plan shares one answer.
      //
      // Only away from the default, so a plan never opened in another lens
      // costs nothing and the timeline stays the thing you get by default.
      { const want = stored(viewKey());
        if (want && want !== VIEW_MODE && VIEW_MODES.includes(want)) setView(want); }
      return;

    // The replay path. Nothing here can be one of ours-but-unacknowledged: we
    // only asked to resume with nothing pending, and the server filters to
    // commands after the sequence number we gave it.
    // A resume is the same room and the same epoch, so `savedSeq` is still
    // measured in the same units and is deliberately left alone. The replayed
    // commands count towards the tally like any others.
    case "resume":
      sessionId = f.sessionId; sockEpoch = f.epoch; joined = true; sockPlanId = f.id;
      for (const e of f.commands) { applyInbound(e.cmd); countChange(e.by); }
      sockSeq = f.seq;
      renderInbound();
      return;

    case "cmd":
      sockSeq = f.seq;
      // Counted BEFORE the ref check below, because our own edits are unsaved
      // changes too — the frame that comes back carrying our ref is the server
      // confirming a change to the shared plan, not a private one.
      countChange(f.by);
      // Ours, echoed back carrying the ref we sent. The optimistic copy already
      // IS this command, so retiring it is the entire job — applying it again
      // would apply it twice. Everyone else gets this frame without a ref.
      // The render still has to happen — `#dirty` just changed — and it has to
      // be the focus-keeping one: this frame lands WHILE you are typing, since
      // it is the acknowledgement of the keystroke before last.
      if (f.ref && pending.delete(f.ref)) {
        // Acknowledged, so it can never be rolled back — its journal entry stops
        // being ours and simply stays in the replay as one more thing that
        // happened. With nothing left in flight there is nothing to replay for.
        if (!pending.size) { journal.length = 0; journalBase = null; }
        renamed(f.cmd);
        renderInbound(); return;
      }
      applyInbound(f.cmd);
      renamed(f.cmd);
      // Something a batch of ours made may have just arrived — see `selectMade`.
      if (selectOnArrival) { renderInbound(); selectMade(selectOnArrival); return; }
      // A PEER'S EDIT MUST NOT STEAL YOUR CARET. This was a plain `render()`,
      // which rebuilds the inspector and therefore replaces the field you are
      // typing into — so two people could not both work while one of them was
      // in a text box. Our OWN edits already went through `renderKeepFocus`
      // (see `emit`'s `keep`); this is the same protection for inbound frames,
      // which is where it was missing.
      renderInbound();
      return;

    case "rejected":
      return rollback(f.ref, f.error);

    // A whole-document replacement, announced. Deliberately not a Command — see
    // `replaceDoc` in room.ts for why bolting a `setDoc` command on would reopen
    // the whole-array write commands exist to prevent.
    case "reverted":
      sockEpoch = f.epoch; sockSeq = f.seq; clearPending();
      // The room now holds an archived version, and the draft it discarded was
      // archived on the way past (`revertRoom` saves before it replaces), so
      // nothing here is unsaved. The revert itself broadcasts no `saved` frame —
      // it saves through rooms.ts rather than through the /save route — so
      // `lastSave` is stale until this asks again.
      savedSeq = f.seq; sinceSave.clear();
      adopt(f.doc, id);
      flash(`${f.by} reverted this plan to save #${f.from}${f.note ? ` — "${f.note}"` : ""}`);
      return;

    case "saved":
      lastSave = { n: f.n, at: f.at, note: f.note, by: f.by };
      // ANYONE'S SAVE CLEARS IT, which is the whole point — the plan is saved or
      // it is not, and it is not a fact about who pressed the button. `snapshot:
      // false` means the document was identical to the newest version and no
      // entry was added, which still means the archive is current.
      savedSeq = sockSeq; sinceSave.clear();
      // Broadcast to everyone INCLUDING the saver, so our own save would flash
      // twice — save() has already said so with the detail only it has.
      if (f.by !== ME) flash(`${f.by} saved #${f.n}${f.note ? ` — "${f.note}"` : ""}`);
      render();
      return;

    // PRESENCE IS RECEIVED AND NOT DRAWN, deliberately. Cursors and the
    // who-is-here strip are their own piece of work; dropping the frames on the
    // floor until then would mean whoever builds it starts with no idea whether
    // the transport beneath it works. So the roster is kept correct and nothing
    // reads it yet.
    // PRESENCE IS DRAWN AND NEVER LOGGED. It reaches the chips and the cursor
    // layer directly — never `countChange`, never the journal, never a render of
    // the document, because none of it is a change to the plan.
    case "presence": peers.set(f.presence.sessionId, f.presence); drawPresence(); return;
    case "left":     peers.delete(f.sessionId); drawPresence(); return;

    // Frame-level failure — a malformed frame, or a token naming no plan. The
    // server closes the socket itself on the second one.
    case "error": lastServerError = f.error; flash(f.error, true); return;

    default: console.warn("[room] unhandled frame", f);
  }
}

/** Apply a command locally for instant feedback and send it. Returns false when
 *  nothing went — there was no room to send to, or our own copy of the
 *  vocabulary refused the command before it ever left. */
function emit(cmd: Command) {
  // NOTHING IS EMITTED FROM PLAYBACK, and this is the belt to the braces. The
  // controls that build commands are disabled while the transport is up, but
  // "disabled every button" is a claim about a list somebody has to keep
  // complete — a keyboard shortcut, a drag handler or a new control added later
  // would each be a way past it. This is the one function every local command
  // goes through, so refusing here cannot be forgotten. `doc` is an archived
  // document right now; a command computed against it and applied to the live
  // plan is precisely the time machine `forkVersion` exists to prevent.
  // A REFUSED EDIT MUST NOT LEAVE ITS TEXT ON SCREEN. When this function says no,
  // the character that was refused is still sitting in the box, the document does
  // not contain it, and the field is the only thing on screen claiming otherwise.
  // Re-rendering puts back what the plan actually says.
  //
  // IT NO LONGER NEEDS TO BE TOLD WHICH FIELD. This took a `keep` selector,
  // threaded through the command layer from each `oninput` call site, so the caret
  // could be handed back after the rebuild that a refusal caused. Every one of
  // those fields is a controlled React input now: the value it shows IS the
  // document, so a refusal that changes nothing re-renders to the same string and
  // the caret never moves. `#title` was the last, and the reason it needed the
  // selector at all was different from the panels' — it was never rebuilt, but
  // `renderInner` assigned `.value` on every render, and assigning a different
  // string to a focused input moves the caret to the end.
  const refuse = () => { render(); return false; };
  // PLACED BELOW `refuse`, NOT ABOVE IT, AND THAT IS NOT A STYLE CHOICE. This
  // guard sat at the top of the function and called `refuse()` ten lines before
  // its `const` — inside the temporal dead zone, so the one path that was
  // supposed to be the backstop threw `ReferenceError: Cannot access 'refuse'
  // before initialization` instead of refusing. The browser suite passed anyway,
  // because it only ever clicked controls that PLAY_FROZEN had disabled, and a
  // disabled control never reaches `emit`. Found by `tsc` on the first run over
  // this file (TS2448), which is the entire argument for checking it.
  if (PLAY) {
    flash("you are watching history — exit playback to edit this plan", true);
    return refuse();
  }
  if (!sock || sock.readyState !== WebSocket.OPEN) {
    flash("not connected to this plan — your edit was not sent", true);
    return refuse();
  }
  // THE SOCKET MUST BELONG TO THE DOCUMENT ON SCREEN. Checking only that *a*
  // socket is open was the hole: `adopt` swaps the document without touching the
  // connection, so any path that changes what you are looking at — the demo
  // doors, a pasted link with another plan's token, opening a History version —
  // left commands flowing into the room the tab happened to still be joined to.
  // Task commands died on unknown ids, which looked like the system working;
  // every `patchDoc` field landed silently on a plan the user could not see.
  // The room's identity is the server's own `id` from `welcome`/`resume`, not
  // anything derived here, so the two cannot drift.
  if (sockPlanId && id && sockPlanId !== id) {
    flash(`this tab is showing "${id}" but is connected to "${sockPlanId}" — `
        + `nothing was sent. Reload to open the plan you are looking at.`, true);
    return refuse();
  }
  // NORMALISED TO ITS WIRE FORM BEFORE ANYTHING SEES IT, and this is load-bearing
  // twice over. A payload built by reading the document comes back carrying
  // Proxies — every read through `doc` is guarded — and putting one INTO the raw
  // document would make the next `structuredClone` here throw DataCloneError,
  // which is the rollback point failing rather than the edit. It also means the
  // copy we apply locally is byte-for-byte the copy the server applies, instead of
  // two different inputs to the same applier diverging in a way nobody could
  // reproduce.
  cmd = JSON.parse(JSON.stringify(cmd));
  const raw = rawDoc();
  // THE ROLLBACK POINT, and a whole clone rather than a derived inverse. ~28KB
  // is nothing beside the round trip it covers, and it is exact: an inverse
  // command would be a second implementation of every applier, written to be
  // right about cases nobody will exercise until they matter.
  //
  // TAKEN ONCE PER RUN OF UNACKNOWLEDGED COMMANDS, not once per command. It is
  // the base the journal replays from, so it has to predate everything the
  // journal holds — see the note over `journalBase`.
  if (!pending.size) { journalBase = structuredClone(raw); journal.length = 0; }
  // WHEN THIS COMMAND WAS ISSUED, stamped HERE and nowhere later. The applier is
  // shared with the server and every other client and must not read a clock, so
  // the one moment a command can be timestamped is the moment it is created —
  // before we apply it optimistically and before it goes on the wire, so our
  // copy and everybody else's are stamped with the same instant. See `edited()`
  // in commands.ts.
  cmd.at = new Date().toISOString();
  try { applyCommand(raw, cmd); }
  catch (e) {
    // applyCommand validates before it applies, so nothing is half-written. This
    // is our copy of the vocabulary refusing — the command was built wrong here,
    // rather than rejected over there.
    flash(e.message, true);
    return refuse();
  }
  const ref = String(++refN);
  pending.set(ref, cmd);
  journal.push({ ref, cmd });
  sock.send(JSON.stringify({ type: "cmd", ref, cmd }));
  // `keep` names the control being typed into. An `oninput` handler that
  // re-rendered plainly would throw focus away on every keystroke.
  render();
  return true;
}

// ---- A GESTURE IS ONE EDIT, NOT ONE PER PIXEL -----------------------------
// APPLIED HERE AND SENT NOWHERE, for the length of a drag.
//
// `startDrag` and `startConstrain` used to `emit` on every pointermove that
// changed the value. A zoomed-in drag across a month is ~30 commands — each one
// sequenced, broadcast to everyone in the room, and pushed into the 1024-entry
// replay buffer that reconnect depends on. Twenty seconds of somebody fiddling
// with a bar in a meeting evicts the log every other tab would have resumed from,
// and 29 of those 30 commands describe a duration nobody ever meant to set.
//
// The preview is the same applier the command log uses, so what you see while
// dragging is exactly what the committed command produces — there is no second
// rendering path to disagree with the first.
//
// AND IT IS TAKEN BACK BEFORE THE REAL COMMAND GOES. Every command previewed
// this way sets an ABSOLUTE value (`setDuration`, `setNotBefore`, and
// `moveTaskInLane`'s `toIndex`), so the gesture's whole effect is expressible as
// one command with the final value — and reverting to the value the room agreed
// on before emitting is what keeps `emit`'s rollback base honest. Leave the
// preview applied and the journal's base would already contain a change the
// server has never heard of.
//
// It is deliberately NOT journaled. Nothing has been sent, so there is nothing
// to roll back; and a rejection arriving mid-drag replays the journal over the
// preview, which drops it — after which `up()` sees the value it started with
// and correctly emits nothing.
function preview(cmd) {
  try { applyCommand(rawDoc(), JSON.parse(JSON.stringify(cmd))); }
  catch { return false; }
  render();
  return true;
}

// WHEN THE SERVER SAYS NO. The words shown are the server's own —
// `validateCommand`'s or `invalid()`'s message, verbatim. A friendlier one
// written here would be a second copy of the rules, and the only message that
// can actually tell someone what to fix is the one the rules produced.
function rollback(ref, error) {
  flash(error, true);
  if (!pending.delete(ref)) return;  // already discarded by a welcome
  // REPLAY THE JOURNAL WITHOUT THE REFUSED COMMAND. Everything else in it stays,
  // in the order it was applied — including every peer edit that landed while
  // this command was in flight, which a restore of a pre-emit snapshot would
  // have thrown away with no way to get it back (see `journalBase`).
  //
  // Commands still in flight are replayed too: they are still our best guess at
  // what the room holds, and each one gets its own answer. Only the one the
  // server named is dropped.
  const rest = journal.filter(e => e.ref !== ref);
  const next = structuredClone(journalBase);
  try { for (const e of rest) applyCommand(next as Doc, (e as any).cmd); }
  catch {
    // A LATER COMMAND DEPENDED ON THE REFUSED ONE — a task it added, a value it
    // created — so the journal no longer describes a document that can exist.
    // There is nothing to reconstruct locally and guessing is what this whole
    // path exists to avoid, so ask the server what the plan actually is. That
    // answer contains the peer edits too, which is the property that matters.
    clearPending();
    resync();
    return;
  }
  // Synchronously, so a rejected edit does not sit on screen looking accepted
  // while a round trip decides its fate.
  doc = guard(next);
  journal.length = 0;
  // Nothing of ours is in flight any more, so there is nothing left to undo and
  // the base is dead weight. Otherwise the journal carries on from the same base,
  // one entry shorter.
  if (pending.size) journal.push(...rest); else journalBase = null;
  render();
}

async function resync() {
  try {
    const j = await store.plan();
    sockSeq = j.seq; sockEpoch = j.epoch;
    adopt(j.doc, j.id);
  } catch (e) {
    flash("lost track of this plan — reload the page. (" + (e.message || e) + ")", true);
  }
}

// "IS THIS ID ALREADY A PLAN?" IS NO LONGER A QUESTION THIS PAGE ASKS, and the
// whole `idTaken` probe that used to answer it is gone rather than fixed.
//
// It existed to find a free name for a plan the page was about to create, back
// when the page chose the name. The server chooses it now (`claimId` in
// create.ts writes under the key or steps over it, atomically, and returns the
// id it used), so there is nothing left to predict and nothing to probe.
//
// Two reasons not to bring it back. It was an existence oracle ADR 0002 refuses
// to answer — one valid link probing for every other plan's id, and ids are
// human-meaningful by design. And it failed OPEN: it read ANY error as "free",
// so a sleeping or 503-ing backend made every id read as free, and the confirm
// that was meant to prevent an overwrite only ever fired on the *taken* answer.
// A collision during a cold start walked straight past the guard.
//
// It also broke the three buttons that called it. New, Fork and Import all hit
// its refusal first, so every one of them failed with a message about checking
// whether an id was free — naming an operation the user had not asked for, in
// front of a create that the server could in fact do.

// ---- EXPORT / IMPORT ------------------------------------------------------
// A plain file of plain JSON on purpose: it is the format the plans are already
// in, it survives email and chat, and a human can read it when something has
// gone wrong.
//
// ONE SCOPE NOW, NOT TWO. "Export all" wrote every plan in the store into one
// bundle, and it could not survive the loss of `list()`: writing out every plan
// means naming every plan, which is exactly the enumeration the capability model
// exists to prevent. Export is per-plan. Import still READS a bundle, because
// files the old tool wrote are still out there and still worth opening; nothing
// here writes one any more.

// Takes a Blob or a string of JSON. The image export hands it the former; giving
// it its own copy of the anchor dance would be a second place for "how this
// browser saves a file" to be written down.
function download(name, data) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    data instanceof Blob ? data : new Blob([data], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// HISTORY RIDES ALONG, in both scopes. Otherwise "export everything" is a backup
// that quietly drops the past of every plan in it — and at 25x the whole archive
// is a few KB, so carrying it costs nothing worth counting.
//
// A single plan keeps its plain-document shape with `history` bolted on, rather
// than becoming a bundle of one: dropping an exported file straight into data/
// still has to work, and a stray key the store ignores is a cheaper price than a
// file that no longer looks like a plan. `adopt` strips it on the way in.
async function exportOne() {
  if (!doc) return;
  const history = id === "demo" ? [] : await store.history().catch(() => []);
  download(`${id}.json`, JSON.stringify(history.length ? { ...rawDoc(), history } : rawDoc(), null, 1));
  flash(`exported ${id}.json` + (history.length ? ` with ${history.length} versions` : ""));
}

// ---- EXPORT AS AN IMAGE ---------------------------------------------------
// The one thing a share link cannot do: put the plan in front of someone who is
// not going to open a browser — a slide, a status email, a ticket comment. It is
// an export, so it lives with the other one.
//
// TWO VIEWS, TWO ANSWERS. The graph is already a canvas and can be asked for its
// own pixels. The timeline is DOM and has to be re-rendered through an SVG
// foreignObject, which is a technique with a long tail of edge cases — hence a
// library rather than fifteen lines of it here. Fetched on first press for
// exactly the reason cytoscape is: a session that never asks for an image should
// not pay for the code that makes one, and a failure must report itself in the
// bar rather than take the plan down with it.
let shotLib: any = null, shotFailed = false;

async function viewImage() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (VIEW_MODE === "board") throw new Error("the board has no image export — switch to Timeline or Graph");
  if (VIEW_MODE === "calendar") throw new Error("the calendar has no image export — switch to Timeline or Graph");
  if (VIEW_MODE === "graph") {
    if (!cy) throw new Error("the graph is not drawn");
    // `full`, not the viewport. Pan and zoom are how you READ this view, never a
    // claim about the plan, so framing the image with them would be exporting a
    // scroll position. No `scale`: cytoscape already multiplies by the device
    // pixel ratio, so a retina screen gets a retina image and asking for more
    // just makes a file nobody needed.
    return cy.png({ output: "blob-promise", full: true, bg });
  }
  if (!shotLib && !shotFailed) {
    // @ts-ignore — a CDN URL import has no local declarations, by design: this
  // page has no bundler and fetches the library at runtime.
  try { shotLib = await import("https://esm.sh/html-to-image@1.11.13"); }
    catch (e) { shotFailed = true; console.warn("html-to-image did not load:", e); }
  }
  if (!shotLib) throw new Error("the image library could not be loaded");
  // #grid, NOT #chart. #chart is the horizontal scroller, so capturing it crops
  // the plan at the window edge, and a bar sliced in half is a worse artefact
  // than no image. #grid is the timeline at its full width, however far it runs.
  const blob = await shotLib.toBlob($("#grid"), { backgroundColor: bg });
  if (!blob) throw new Error("nothing was drawn");
  return blob;
}

// COPY FIRST, DOWNLOAD AS THE FALLBACK, because the destination is nearly always
// a paste. The Blob goes to ClipboardItem as a PROMISE rather than being awaited
// first, and that is load-bearing: Safari only permits a clipboard write begun by
// the click still on the stack, and awaiting the render loses that claim. A
// browser that refuses the write anyway still hands over the image, as a file.
async function shootView(asFile) {
  const png = viewImage();
  const name = `${(doc?.title || id || "plan").replace(/[^\w.-]+/g, "-")}-${todayISO()}.png`;
  if (!asFile) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return flash("image copied to the clipboard");
    } catch (e) { console.warn("clipboard write refused:", e); }
  }
  try { download(name, await png); flash(`saved ${name}`); }
  catch (e) { flash(`could not make an image: ${e.message}`, true); }
}

// Accepts either shape — a single plan or a bundle — because whoever sends you a
// file will not have read the docs, and both are obvious on inspection.
async function importFile(file) {
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { return flash("that file is not JSON", true); }
  const plans = parsed && typeof parsed.plans === "object" && parsed.plans ? parsed.plans
    : Array.isArray(parsed?.tasks) ? { [slug(parsed.title) || "imported"]: parsed }
    : null;
  if (!plans) return flash("that file is not a timeline plan or a plan bundle", true);

  let skipped = 0;
  const made: any[] = [];
  for (const [pid, raw] of Object.entries(plans)) {
    let d;
    // Migrate on the way IN. An imported file is the most likely thing in the
    // whole tool to be old — it has been sitting in someone's downloads folder.
    // `now`: an imported task was added to THIS plan now (the v4 -> v5 rung).
    try { d = applyMigrations(structuredClone(raw) as Doc, undefined, undefined, { now: new Date().toISOString() }); }
    catch (e) { flash(`${pid}: ${e.message}`, true); skipped++; continue; }
    if (!Array.isArray(d.tasks)) { skipped++; continue; }
    // The archive travels beside the plan in a bundle and attached to it in a
    // single-plan file. Either way it comes off the document before the document
    // is stored, or the plan's first version would carry its own past inside it.
    const hist = (parsed.history && parsed.history[pid]) || (raw as any).history || null;
    delete d.history;
    // NOTHING IS OVERWRITTEN AND NOTHING IS ASKED. There used to be a confirm
    // here — `"<id>" already exists here. OK to overwrite it` — and it described
    // an act this tool cannot perform: `claimId` writes under a free key or steps
    // over a taken one, and a taken id is never read, never written and never
    // resolved. An import always lands on a NEW plan with a NEW capability, which
    // is also why the id in the file is only a suggestion for the name.
    try {
      made.push(await store.create(d.title || pid, d, `imported from a file as "${pid}"`));
      // The old archive stays in the file. /api/save is append-only and takes no
      // document, so there is no route that could write a plan's past — the
      // imported plan starts at version 1 and says so.
      if (Array.isArray(hist) && hist.length)
        flash(`${pid}: the document was imported; its ${hist.length} archived `
            + `version(s) were not — there is no route that can write a plan's past.`, true);
    }
    catch (e) { flash(`${pid}: ${e.message}`, true); skipped++; }
  }
  // WHERE THE LINKS GO, AND WHY A BULK IMPORT CANNOT JUST NAVIGATE. Each plan
  // got its own freshly minted capability, and there is no `/list` and no picker
  // — so a token this page drops is a plan nobody can reach again, including the
  // person who just imported it. Navigating to the first one would strand every
  // other one at the moment the page unloads.
  //
  // One plan is the ordinary case and goes where you would expect. More than one
  // gets a panel of links instead, which does not time out like `flash` does,
  // because it is the only copy of those capabilities that exists anywhere a
  // human can see.
  if (made.length === 1) {
    location.hash = made[0].shareToken;
    location.reload();
    return;
  }
  if (made.length > 1) {
    mountImportSummary(bannerHost("importsummary", "accent"),
      { made, skipped, base: location.origin + location.pathname });
    return;
  }
  flash(`imported nothing` + (skipped ? `, skipped ${skipped}` : ""), true);
}

// FORK AND NEW DO NOT ASK FOR A NOTE — the act already names itself, and a text
// box in front of "New" is friction for a sentence nobody would write.
//
// THE NEW PLAN HAS ITS OWN CAPABILITY, so this cannot end by adopting a document
// in place: the socket, every HTTP call and the History panel are all addressed
// by the token in the fragment, and the one that was just minted is the only way
// back to what was created. So the tab GOES THERE. `location.hash` then reload,
// rather than a same-page swap, because a swap would leave the tab connected to
// the old plan's room — the exact hole `emit`'s room check exists to catch.
async function saveAs(newDoc, wantTitle, note) {
  let made;
  try { made = await store.create(wantTitle, newDoc, note); }
  catch (e) { flash(e.message || "could not create", true); return null; }
  location.hash = made.shareToken;
  location.reload();
  return made.id;
}

async function fork() {
  if (!doc) return;
  const copy = JSON.parse(JSON.stringify(rawDoc()));   // raw: the guard would serialise day numbers
  copy.title = (doc.title || "Plan") + " — copy";
  // `order` was the picker's sort position, and there is no picker — but it is
  // still a field of the schema, so a fork takes the end slot rather than
  // inheriting the source's and the number keeps meaning what it says.
  copy.order = 99;
  await saveAs(copy, copy.title, `forked from "${doc.title || id}"`);
}

// NOTHING IS DISCARDED HERE, so nothing is confirmed. This used to ask "Discard
// unsaved changes?" off `clean`, which was wrong twice: New does not touch the
// plan you are on, and that plan's edits are already durable on the server
// whether or not anyone has pressed Save.
//
// THE STARTER DOCUMENT IS THE SERVER'S NOW, and this page no longer carries a
// copy. Two descriptions of one shape had already started to disagree — the
// page's went to disk with no `schemaVersion` at all, which the migration ladder
// reads as v1 and then runs three upgrades over, including the one that
// multiplies every duration by seven. `starter()` in create.ts is built, stamped
// and validated in the same place, so a starter that is wrong fails loudly at
// creation rather than quietly at whatever someone does next.
async function newPlan() { await saveAs(undefined, "New plan", "created"); }

// THE DEMO NEEDS A ROUTE BACK, and it used to be a hardcoded entry the picker
// appended after the store's list — the fixture lives beside index.html rather
// than in the store, so nothing that enumerated plans could ever see it. With
// the picker gone the routes are the ? door and arriving with no plan
// in the URL at all, which is the normal first visit.

// ---- load / save ----------------------------------------------------------
async function load(newId) {
  // THE SOCKET IS THE LOAD PATH, and `newId` is not consulted: the token names
  // the plan (ADR 0002) and the id in the hash is a display hint. `welcome`
  // carries the document, the sequence number and the room's epoch in ONE frame,
  // so taking the document from a separate GET would mean two answers to "what
  // is this plan right now" with a gap in between for them to differ across —
  // and the gap is where somebody else's edit lands. adopt() happens in onFrame.
  //
  // WAKE BEFORE THE SOCKET, because the socket cannot wake anything. `call()`
  // wakes too, but nothing on this path goes through it: a cold page load reaches
  // connect() directly, which was the one case the wake had to cover and the one
  // case it missed.
  await wakeAndWait();
  await connect();
}

// THE DEMO IS A PLAN, NOT A SECOND RENDERER. It used to be an inline document
// this page could adopt without a socket — which meant the front door showed a
// chart whose every edit was silently discarded, because `loadDemo` closed the
// connection on purpose so the fixture could not write into a real room. That
// bought instant first paint and cost the one claim this tool makes: that the
// numbers on screen are real and shared.
//
// It is now `demo-bakery`, reached by DEMO_TOKEN like any other plan, and its
// starting state is `web/demo-plan.json` — one tracked copy, seeded into the
// plan by `scripts/reset-demo.sh` and forked by the interaction suite. Same
// bakery, one source, and nothing renders it except the real load path.
// One place where a document becomes THE document, whatever it was fetched from
// — a file, the demo, and later an import or the browser store. Every load path
// has to reset the same five things, and the bug when one forgets is subtle: an
// undo stack surviving a plan switch will happily paste the previous plan's
// tasks over this one.
function adopt(newDoc, newId) {
  // EVERY load path runs the ladder — file, browser, demo, import. That is the
  // whole reason this function exists in one piece.
  try { newDoc = applyMigrations(newDoc); }
  catch (e) { flash(e.message, true); return; }
  // A document can arrive with `history` attached — that is how a single-plan
  // export carries an archive through a file, and how one dropped into data/ by
  // hand would. It must not survive onto the live document, or the next Save
  // writes the archive into the plan and every save after it carries the lot.
  delete newDoc.history;
  // THE COMPARISON SURVIVES A RE-ADOPT OF THE SAME PLAN and dies on a different
  // one. Revert and opening a version both come through here, and losing your
  // comparison every time you Revert would make it unusable in the one place it
  // is for. A version number from another plan's archive means nothing.
  if (newId !== id) CMP = null;
  // GUARDED HERE, which is the one place a document becomes THE document — so
  // there is no path by which an unguarded one gets installed. See the guard.
  doc = guard(newDoc); id = newId; sel = null; linking = null;
  // THE TOKEN IS THE ADDRESS; THE ID IS NOT IN THE URL. Writing it here was left
  // over from when an id addressed a plan. It addresses nothing now (ADR 0002 —
  // the token names the plan, and the boot path already treats `wanted` as a
  // label), so all it did was make every shared link carry a human-meaningful
  // name: `#<token>&{"id":"eadvantage-member-api"}` tells anyone who sees the URL
  // — in a screenshare, a chat, a bug report — which client and project it is.
  // The token is supposed to be the only thing in there, and now it is: with the
  // view state gone there is no writer that could reintroduce one.
  //
  // AFTER the id is set, because the keyring is stored per plan and `keyringKey`
  // needs one. This is also what strikes an absorbed `kr` from the URL, so a
  // fragment that arrived carrying anything at all leaves here holding only the
  // token.
  absorbKeyring();
  // Opening a plan is what puts it in "plans you have opened". Here rather than
  // at the load sites because every one of them ends up here — welcome, resync
  // and revert alike — and a list that missed one of those would be missing the
  // only link back to a plan somebody was just looking at.
  rememberPlan();
  render();
  // Fire and forget: the "last change" line it feeds is not worth making every
  // plan switch wait on a second round trip.
  refreshLastSave().then(render);
}

// One version's metadata, and no document anywhere — not over the wire and not
// out of the bucket either, which it used to be: this asked for the whole
// archive's metadata and then used the last entry. It feeds one readout:
// what the last change WAS, which is the question you ask on opening a plan you
// have not seen since Friday. (It was `countHistory` until this rename: it used
// to count versions against the browser store's ceiling, and kept the name for a
// while after it stopped counting anything.)
async function refreshLastSave() {
  lastSave = null;
  if (!doc || id === "demo") return;
  try {
    lastSave = await store.lastSave();
  } catch { /* a plan with no archive yet is not an error */ }
}

// "3 hours ago" beats a timestamp for the only question being asked, which is
// whether this is where you left it. Coarse on purpose: nobody needs minutes
// after the first hour, and a line that keeps changing draws the eye for nothing.
// A MINUTE, in days: the floor for durations and for comparing two times as "the same".
const MINUTE = 1 / 1440;
const whenAbs = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: zoneOf(rawDoc()) });
const agoStr = iso => {
  const ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d_ = Math.floor(h / 24);
  return d_ < 30 ? `${d_} day${d_ === 1 ? "" : "s"} ago` : `${Math.floor(d_ / 30)} months ago`;
};

async function save(note) {
  // THE DEMO IS A FIXTURE, NOT A PLAN, and saving it produced a file the tool
  // could never open again: `load()` short-circuits on that id before it ever
  // reaches the store, so the copy was unreachable by construction. Twelve tasks
  // of dead data filed in among the real plans.
  //
  // Refused rather than silently forked: "Save" that quietly writes somewhere
  // else under a name you did not choose is a worse surprise than being told no,
  // and Fork is right there doing exactly that, on purpose.
  if (id === "demo")
    return flash("The demo is a fixture, not a plan — Fork it and the copy is yours to save.", true);
  let r;
  // THE DOCUMENT IS NOT SENT. Every edit reached the room as a command already,
  // so the server is holding the thing being archived — and a document posted
  // from here would be a second opinion about what the plan currently is, from
  // the one participant whose copy is not authoritative.
  try { r = await store.save(note); }
  catch (e) { return flash(e.message || "save failed", true); }
  // The `saved` broadcast does this too, for everyone in the room including us —
  // but it is a frame and this is a response, and nothing orders the two. Doing
  // it here as well means the indicator clears when the save is known to have
  // happened rather than when a frame happens to land.
  savedSeq = sockSeq; sinceSave.clear();
  await refreshLastSave();
  flash("saved " + id + ".json"
    // Saying so matters: a Save that deliberately added no version looks exactly
    // like one that failed to, from the history panel.
    + (r && r.snapshot === false ? " — nothing changed, so no new version" : ""));
  render();
}

$("#autoorder").onchange = e => emit({ type:"patchDoc", patch: { autoOrder: (e.target as HTMLInputElement).checked } });
$("#start").onchange = e => { if (fieldOf(e).value) emit({ type:"patchDoc", patch: { start: fieldOf(e).value } }); };
$("#sprintw").onchange = e => {
  // BLANK OR ZERO MEANS NO CADENCE, and that is a real answer rather than a
  // missing one — most process maps are not run in sprints at all.
  const v = +fieldOf(e).value;
  emit({ type:"patchDoc", patch: v > 0
    ? { sprint: { ...(doc.sprint || {}), weeks: Math.max(0.5, v) } }
    : { sprint: null } });
};
$("#sprint0").onchange = e => { if (fieldOf(e).value) emit({ type:"patchDoc",
  patch: { sprint: { ...(doc.sprint || {}), start: fieldOf(e).value } } }); };
// ---- PLANS YOU HAVE OPENED ------------------------------------------------
// THE HANDLE IS THE TOKEN, because that is the only thing that addresses a plan
// (ADR 0002). The id is a display hint and reaches nothing; storing it instead
// would produce a list of names none of which can be opened.
//
// Which makes this list a bag of capabilities in localStorage, and worth saying
// out loud rather than discovering: anything that can read this origin's storage
// can read and write every plan in it. That is not a new exposure — the same
// tokens are already in this browser's history and address bar — but it is the
// reason there is no sync, no server side to this, and no export button on it.
//
// It is per-browser and it is a CONVENIENCE. There is no `/list` and there must
// not be one (an endpoint that enumerates plans hands anyone with one valid link
// the ids of every other), so this cannot be recovered, cannot be shared, and is
// not a backup. Losing it loses nothing the link does not still open; losing the
// link loses the plan.
const RECENT = "ts:recent";
const RECENT_MAX = 12;

/** Read and normalise. Tolerates anything at all in the key — a shape from an
 *  older build, a half-written value, a browser that refuses storage — because a
 *  convenience list that throws would take the home screen down with it. Bad
 *  entries are dropped rather than repaired: there is nothing here worth
 *  guessing at. */
function readRecent() {
  let parsed;
  try { parsed = JSON.parse(localStorage.getItem(RECENT) || "[]"); }
  catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    // THE SHAPE TEST IS THE TOKEN'S, and it is the normative one from ADR 0002 —
    // 22 characters of base64url. An entry whose handle is not a token cannot be
    // opened, so it is not an entry.
    const tok = raw.tok;
    if (typeof tok !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(tok)) return [];
    return [{
      tok,
      title: typeof raw.title === "string" ? raw.title : "",
      ts: typeof raw.ts === "number" && isFinite(raw.ts) ? raw.ts : 0,
    }];
  }).sort((a, b) => b.ts - a.ts).slice(0, RECENT_MAX);
}

/** Record the plan on screen, most recent first, one entry per token. Called on
 *  every adopt and on every title change, so the name in the list is the name the
 *  plan actually has rather than the one it had the first time it was opened. */
function rememberPlan() {
  const tok = shareToken();
  if (!tok || !doc || id === "demo") return;
  const title = String(doc.title || id || "");
  const kept = readRecent().filter(e => e.tok !== tok);
  try {
    localStorage.setItem(RECENT,
      JSON.stringify([{ tok, title, ts: Date.now() }, ...kept].slice(0, RECENT_MAX)));
  } catch { /* storage full or refused — the list is a convenience, not the plan */ }
}

function drawRecents() {
  const list = $opt("#recents"), block = $opt("#recents-block");
  if (!list || !block) return;
  const entries = readRecent();
  block.hidden = !entries.length;
  mountRecents(list, entries.map((e: any): RecentPlan => ({
    tok: e.tok,
    title: e.title || "Untitled plan",
    ago: e.ts ? agoStr(new Date(e.ts).toISOString()) : "",
  })), openToken);
}

/** GO TO A PLAN, WHICH IS ALWAYS A RELOAD. The token lives in the fragment, so
 *  changing it navigates nothing on its own — and the page has to rebuild around
 *  a different socket, a different room and a different archive. `saveAs` takes
 *  the same two steps after a create, and for the same reason. */
function openToken(tok) {
  location.hash = tok;
  location.reload();
}

// ---- the front door -------------------------------------------------------
// IT IS THE HOME SCREEN NOW, not a first-visit introduction, and the rule that
// decides when it opens changed with it: it used to be "have you been here
// before", and it is "are you looking at a plan". Somebody arriving with no
// token in the URL has not opened anything — there is nothing behind this card
// but the fixture — so dismissing it once and then being dropped on a demo
// forever was the tool losing the one screen that could take them somewhere.
//
// The old argument still holds where it applied: a modal that interrupts is one
// people learn to dismiss without reading. This one does not interrupt anything.
// A link to a plan opens the plan, arriving with nothing opens this over the
// demo, and `?` opens it on purpose.
const showLanding = () => { drawRecents(); $("#landing").hidden = false; };
const hideLanding = () => { $("#landing").hidden = true; };
$("#help").onclick = showLanding;

// THE SHARED DEMO PLAN, AND THE ONE TOKEN THAT BELONGS IN THIS FILE. Every other
// token is a client's delivery schedule and must never be written down (ADR 0002);
// this one addresses a plan that exists to be opened by strangers and broken by
// them, and it is published in the page precisely so a first-time visitor lands
// somewhere real. Do not put a second one here.
//
// THE DOORS USED TO OPEN THE FIXTURE, which was right when the fixture was the
// only plan a stranger could reach and wrong the moment it stopped being
// editable: it is disconnected, so every gesture the walkthrough demonstrates
// comes back "not connected to this plan — your edit was not sent". A tour of a
// tool that refuses everything it teaches is worse than no tour. The fixture
// stays as the no-token fallback, which is the job it can still do.
const DEMO_TOKEN = "demoBakeryPublic012345";
$("#door-demo").onclick = () => openToken(DEMO_TOKEN);
$("#door-new").onclick = async () => { hideLanding(); await newPlan(); };
$("#landing").onclick = e => { if (tgt(e).id === "landing") hideLanding(); };
addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("#landing").hidden) { hideLanding(); e.stopPropagation(); }
}, true);

// ---- settings + rename ----------------------------------------------------
// The tab is remembered across opens, because the thing you were last editing is
// overwhelmingly the thing you are coming back to.
let setTab = "plan";
function showTab(tab) {
  setTab = tab;
  $$("[data-tab]", $("#settings")).forEach(b =>
    b.classList.toggle("on", b.dataset.tab === tab));
  $$("[data-panel]", $("#settings")).forEach(p =>
    p.hidden = p.dataset.panel !== tab);
}
// THE LINK BASE IS PAINTED FROM STORAGE EVERY TIME THE PANEL OPENS, not held in
// the markup. The keyring can change underneath this tab — a link absorbed in
// another tab of the same browser writes the same localStorage key — and a box
// still showing what it said last time is a box lying about what your links do.
function paintKeyring() {
  const box = $opt("#refbase"); if (!box) return;
  (box as HTMLInputElement).value = KEYRING.refBase || "";
  const s = $opt("#krsample");
  if (!s) return;
  const sample = (doc && doc.tasks || []).find(t => t.ref);
  mountKeyringSample(s, {
    base: KEYRING.refBase || "",
    ref: sample ? sample.ref! : null,
    url: sample ? refUrl(sample) : null,
  });
  // A real reference from this plan, so the box shows the shape in use rather
  // than one this tool made up and implied a tracker with.
  const ph = $f("#refbase");
  if (ph && refExample()) ph.placeholder = `https://example.com/…/{ref}  (e.g. ${refExample()})`;
}

function openSettings(tab?: string) {
  $("#settings").hidden = false;
  paintKeyring();
  showTab(tab || setTab);
  // Back to the top: a tall panel left scrolled from last time opens looking like
  // it is missing its heading.
  requestAnimationFrame(() => { const c = $("#settings .set-card"); if (c) c.scrollTop = 0; });
}
const closeSettings = () => { $("#settings").hidden = true; closeStylePop(); };

// `onchange`, so a half-typed base never briefly becomes every task's link.
$("#refbase").onchange = e => {
  const v = fieldOf(e).value.trim();
  // A base is pasted into an `href`. Same rule as `url`, refused at the same
  // door, for the same reason — except this one is refused per browser rather
  // than per room, because nobody else can be hurt by it.
  if (v && !/^https?:\/\//i.test(v)) {
    flash("the link base must start with http:// or https://", true);
    return paintKeyring();
  }
  saveKeyring({ ...KEYRING, refBase: v });
  paintKeyring();
  render();
  flash(v ? "reference links on for this plan, in this browser" : "reference links off");
};

// THE ONLY THING THAT EVER PUTS A KEYRING BACK IN A URL. Everywhere else the
// fragment is an inbox — see the note over the keyring. Deliberate, one button,
// and it says in the panel what the link carries.
$("#krcopy").onclick = async () => {
  if (!KEYRING.refBase) return flash("set a link base first", true);
  const url = location.origin + location.pathname
    + "#" + shareToken() + "&" + encodeURIComponent(JSON.stringify({ kr: b64u.enc(KEYRING) }));
  try {
    await navigator.clipboard.writeText(url);
    flash("link copied — it opens the plan AND sets the link base");
  } catch {
    // Clipboard refused (permissions, or not a user gesture Safari believes in).
    // Showing the URL is strictly better than a failure toast: it is still one
    // select-and-copy away, and the alternative is a dead button.
    flash("could not reach the clipboard — the link is in the box above", true);
    $f("#refbase").value = url;
    $f("#refbase").select();
  }
};
$("#cog").onclick = () => openSettings();
$$("[data-tab]", $("#settings")).forEach(b =>
  b.onclick = () => showTab(b.dataset.tab));

const openWall = () => { $("#wall").hidden = false; };
const closeWall = () => { $("#wall").hidden = true; };
$("#wall-close").onclick = closeWall;
$("#wall").onclick = e => { if (tgt(e).id === "wall") closeWall(); };
$("#door-styles").onclick = () => { hideLanding(); openWall(); };
$("#swapgo").onclick = () => {
  const a = swapA, b = swapB;
  if (a === b) return;
  // Confirm rather than trust the undo: this rewrites every task's assignment in
  // two channels at once, and "I clicked the wrong pair" is a thing to catch
  // before it happens rather than after everyone in the room has seen it.
  if (!confirm(`Swap ${chLabel(a)} and ${chLabel(b)}?\n\n`
    + `${(doc[a] || []).length} value(s) move to ${chLabel(b)}, ${(doc[b] || []).length} move to `
    + `${chLabel(a)}, and all ${doc.tasks.length} tasks follow their meaning.\n\n`
    + `There is no undo. Save first if you might want it back.`)) return;
  swapChannels(a, b, swapPick);
  swapPick = {};
};
$("#set-close").onclick = closeSettings;
$("#settings").onclick = e => { if (tgt(e).id === "settings") closeSettings(); };

const renamePop = open => {
  $("#renamepop").hidden = !open;
  // `$opt`, because the field is React's now and does not exist before the first
  // render — this function is reachable from a keydown that could arrive first.
  const el = $opt("#title") as HTMLInputElement | null;
  if (open && el) { el.focus(); el.select(); }
};
$("#renamebtn").onclick = () => renamePop($("#renamepop").hidden);
// Light-dismiss: anywhere outside the popover and its own button. Bound on the
// document rather than the chart, because the popover overhangs the milestone
// bar and the legend too.
addEventListener("pointerdown", e => {
  if (!$("#renamepop").hidden && !tgt(e).closest(".popwrap")) renamePop(false);
  if (!$("#savepop").hidden && !tgt(e).closest(".popwrap")) savePop(false);
  const cp = $opt("#colrpop");   // only exists while the inspector is open
  if (cp && !cp.hidden && !tgt(e).closest(".popwrap")) cp.hidden = true;
  const up = $opt("#urlpop");
  if (up && !up.hidden && !tgt(e).closest("#urlpop") && !tgt(e).closest("#urlbtn"))
    up.hidden = true;
  const sp = $("#stylepop");
  if (sp && !sp.hidden && !tgt(e).closest("#stylepop") && !tgt(e).closest(".stylebtn"))
    sp.hidden = true;
});
// LIGHT-DISMISS FOR THE SELECTION, the way Escape already does it: a click that
// did nothing closes the Inspector. "Did nothing" is asked of the element rather
// than guessed from where it sits — a click lands on something that DOES
// something if it or an ancestor is a control, or carries a click handler of its
// own, whether set imperatively (`onclick`, the board's cards) or by React
// (`onClick` on a plain div, like the milestone cards). Everything else is
// background. Not during a drag (4px, the chart's own test), not while linking,
// not while a modal is up — a modal's backdrop is its own to dismiss, and the
// chart already deselects on its own empty space.
const INTERACTIVE = "button, a, input, select, textarea, label, summary, [contenteditable]," +
  " [role=button], [role=tab], [role=link], [role=checkbox], [role=option], [role=menuitem]," +
  " #insp, #chart, #cy, .popwrap";
// A node React manages carries React's own no-op `onclick` (on the containers it
// mounts into — #msbar and #legend — as a Safari tap workaround), so for those
// only the React `onClick` prop counts.
const hasClick = (n: any) => {
  const keys = Object.keys(n);
  const react = keys.some(k => k.startsWith("__reactContainer$") || k.startsWith("__reactProps$"));
  return (!react && typeof n.onclick === "function") ||
    keys.some(k => k.startsWith("__reactProps$") && n[k] && typeof n[k].onClick === "function");
};
let bgDown: [number, number] | null = null;
addEventListener("pointerdown", e => { bgDown = [e.clientX, e.clientY]; }, true);
addEventListener("click", e => {
  if (sel == null || linking || PLAY) return;
  if (bgDown && Math.max(Math.abs(e.clientX - bgDown[0]), Math.abs(e.clientY - bgDown[1])) >= 4) return;
  if ([$("#mentions"), $("#wall"), $("#reorder"), $("#hist"), $("#settings")].some(el => el && !el.hidden)) return;
  for (let n = tgt(e) as HTMLElement | null; n && n !== document.body; n = n.parentElement)
    if (n.matches(INTERACTIVE) || hasClick(n)) return;
  sel = null; chainFocus = null; render();
});
$("#view").onchange = e => setView(fieldOf(e).value);
$("#rowmode").onchange = e => setRowMode(fieldOf(e).value);
// Same branch the legend chips take: dim can repaint in place, isolate has to
// rebuild the rows it removed. Escape clears, because a filter you cannot get out
// of without finding the mouse is the one that gets left on by accident.
$("#q").oninput = e => {
  query = fieldOf(e).value;
  focusMode === "isolate" ? render() : applyFilter();
};
$("#q").onkeydown = e => {
  if (e.key !== "Escape" || !query) return;
  e.stopPropagation();          // Esc also closes panels; this one is handled here.
  query = ""; fieldOf(e).value = "";
  focusMode === "isolate" ? render() : applyFilter();
};
// THE SCOPE CONTROL WRITES `chainFocus` — the SAME state the inspector's chain
// button sets, not a second one. Two controls over one piece of state is fine;
// two pieces of state meaning the same thing is what this file has a scar about.
$("#gscope").onchange = e => {
  if (fieldOf(e).value === "chain") {
    if (!sel) { flash("Select a task first — a chain needs something to be the chain OF."); 
                fieldOf(e).value = "all"; return; }
    chainFocus = sel;
  } else chainFocus = null;
  render();
};
$("#gfit").onclick = () => cy && cy.fit(undefined, 40);
$("#tfit").onclick = fitTimeline;
// `null` DELETES the key — `patchDoc` treats a null value as a removal — so a
// plan nobody has arranged carries no `graphPos` at all rather than an empty
// object, and the computed layout is visibly the default again.
$("#garrange").onclick = () => {
  if (!doc || !doc.graphPos) return;
  emit({ type: "patchDoc", patch: { graphPos: null } });
};
// ---- the history panel ----------------------------------------------------
// One row per save, newest first, and the three numbers that answer "what was it
// before" without opening anything: how many tasks, when it landed, and what
// changed against the save under it. The finish date is not a stored field — it
// is recomputed per row by the same scheduler the chart uses, so a row cannot
// disagree with what opening that row would show you.
const fmtWhen = e => {
  if (!e.at) return "—";
  const d = new Date(e.at);
  // The ≈ is on the entries whose date was reconstructed rather than recorded —
  // the seven plans folded in at the start had no timestamps to keep. An archive
  // that silently claims to know something it does not is worse than one that
  // admits the gap, and it costs one character.
  return e.approx
    ? "≈ " + d.toLocaleDateString("en-US", { month:"short", day:"numeric" })
    : d.toLocaleDateString("en-US", { month:"short", day:"numeric" }) + ", "
      + d.toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit" });
};
// PARTS, NOT MARKUP. The finish delta is coloured — `up` for a later finish, `dn`
// for an earlier one, because later is worse — and that used to arrive as a
// `<span>` in a string only `innerHTML` could accept.
const hDelta = (cur, prev): DeltaPart[] => {
  if (!prev) return [{ text: "first version" }];
  const out: DeltaPart[] = [];
  const dt = cur.tasks - prev.tasks;
  out.push({ text: dt ? `${dt > 0 ? "+" : "−"}${Math.abs(dt)} task${Math.abs(dt) === 1 ? "" : "s"}`
                      : "±0 tasks" });
  // Compared as absolute dates, not day numbers — see statsOf. Later is worse.
  if (cur.at != null && prev.at != null) {
    // IN THE UNIT IT MOVED BY. Whole days called a six-hour slip "same finish".
    const dd = (cur.at - prev.at) / DAY;
    out.push(Math.abs(dd) < 1 / 1440 ? { text: "same finish" }
      : { text: `${dd > 0 ? "+" : "−"}${calStr(Math.abs(dd))}`, cls: dd > 0 ? "up" : "dn" });
  }
  return out;
};

const closeHistory = () => { $("#hist").hidden = true; };

async function openHistory() {
  $("#hist").hidden = false;
  const list = $("#hist-list");
  const draw = (props: Parameters<typeof mountHistory>[1]) => mountHistory(list, props);
  const noop = { onNote: () => {}, onCompare: () => {}, onPlay: () => {}, onFork: () => {} };
  draw({ rows: null, error: null, ...noop });
  let v: Version[] = [];
  try { v = await store.history(); }
  catch (e: any) { draw({ rows: null, error: e.message || "could not read history", ...noop }); return; }
  // WHAT THIS PANEL CAN AND CANNOT DO, said accurately. The line it replaces —
  // "nothing is overwritten until you Save, and Revert brings you back to what is
  // stored" — described the single-writer tool this was built from. Both halves
  // are now false: an edit reaches everyone the moment you make it, and Revert
  // moves the whole room rather than this tab.
  $("#hist-sub").textContent = v.length
    ? `${v.length} save${v.length === 1 ? "" : "s"} of "${doc.title || id}", newest first. `
      + `Click a note to write one. Versions are read-only — Compare paints one under the `
      + `live chart, and Fork copies one into a new plan of its own, which is the way to `
      + `pick work back up out of the past without moving everybody else. `
      + `Play runs them in order on the chart — that one takes you out of the room `
      + `while it plays, and puts you back when you exit.`
    : id === "demo"
      ? "The demo is a fixture, not a plan, so Save refuses it and it has no history. Fork it and the copy keeps one."
      : "No versions yet. Every Save from here on adds one.";

  const stats = v.map(e => statsOf(e.doc));
  // NEWEST FIRST on screen, oldest first in `v` — the deltas are "since the save
  // before this one", so they have to be computed in chronological order and the
  // list reversed afterwards, not the other way round.
  const rows: HistoryRow[] = v.map((e, i): HistoryRow => ({
    n: e.n!, when: fmtWhen(e), note: e.note || "",
    tasks: `${stats[i].tasks} task${stats[i].tasks === 1 ? "" : "s"}`,
    lands: stats[i].at == null ? "—" : "lands " + stats[i].ends,
    delta: hDelta(stats[i], i ? stats[i - 1] : null),
    comparing: !!CMP && CMP.n === e.n,
    isNow: i === v.length - 1,
  })).reverse();

  const props = {
    rows, error: null,
    onNote: async (n: number, note: string) => {
      try { await store.setNote(n, note); flash("note saved"); }
      catch (e: any) { flash(e.message || "could not save that note", true); }
    },
    onFork: (n: number) => forkVersion(v.find(x => x.n === n)),
    // PLAY FROM HERE, per row, because "what changed after the thing I remember"
    // is the question people actually bring to this panel.
    onPlay: (n: number) => startPlayback(v, v.findIndex(x => x.n === n)),
    onCompare: async (n: number) => {
      await applyCompare(CMP && CMP.n === n ? null : n);
      // Redrawn rather than patched: which row says "Comparing" is derived from
      // `CMP`, so the panel is asked again instead of being edited in place.
      draw({ ...props, rows: rows.map(r => ({ ...r, comparing: !!CMP && CMP.n === r.n })) });
      flash(CMP ? `comparing against ${cmpLabel()}` : "comparison off");
    },
  };
  draw(props);
  const all = $opt("#hist-play-all");
  if (all) (all as HTMLElement).onclick = () => startPlayback(v, 0);
}

// THE SANCTIONED WAY TO ACT ON AN OLD VERSION, and it replaces `openVersion`.
//
// Open adopted the version into this tab and emitted nothing. The server and
// everyone else stayed exactly where they were, so the tab silently showed a
// document the room was not on — and the next edit was a command computed
// against that stale base and applied to the LIVE plan. It looked like a
// time machine and was a way to write yesterday's numbers into today's plan.
//
// Forking is the honest version of the same wish. The version is copied into a
// plan of its own with its own capability, which is somewhere you can work
// without moving anybody, and the plan you came from is untouched. `/revert` is
// still there for "put the room back", and it says so.
async function forkVersion(e) {
  if (!e) return;
  // THE LADDER RUNS ON THE WAY OUT, same as `statsOf` does for the numbers in
  // this panel. An archived document is the most likely thing in the tool to be
  // old, and the server refuses anything that is not schemaVersion 4 — so an
  // unmigrated fork would fail at the door with a message about a schema, for a
  // version this panel is happily drawing a finish date for.
  let d;
  // `now`: a task the ladder has to date was added to the NEW plan now.
  try { d = applyMigrations(structuredClone(e.doc), undefined, undefined, { now: new Date().toISOString() }); }
  catch (err) { return flash(err.message, true); }
  delete d.history;
  d.title = `${d.title || id} — from save #${e.n}`;
  // `order` was the picker's sort position; there is no picker, but the field
  // still means what it says, so a copy takes the end slot.
  d.order = 99;
  flash(`forking save #${e.n}…`);
  await saveAs(d, d.title, `forked from save #${e.n} of "${doc.title || id}"`
    + (e.note ? ` — "${e.note}"` : ""));
}

// ---------------------------------------------------------------------------
// PLAYBACK — the third thing you can do with the archive, after Compare and Fork.
//
// Compare is a lens over ONE version. Fork copies one OUT to a plan of its own.
// Playback is a lens over ALL of them: it puts each saved document on the chart
// in turn, through the same renderer, so the bars you watch move are the bars
// this tool would have drawn that day. Nothing here writes anything.
//
// IT TAKES YOU OUT OF THE ROOM, AND THAT IS THE DESIGN.
//
// The first sketch swapped the global `doc` and left the socket up. That does not
// work and the reason is worth keeping: `rawDoc()` dereferences the global, and
// every inbound `cmd` frame goes through it — so a teammate's edit arriving while
// you watched save #12 would have been applied to save #12. On exit you would
// either lose their edit or write an archived document over the live one. It is
// the same failure `forkVersion` describes: "a way to write yesterday's numbers
// into today's plan". `stripsFrom` escapes it ONLY by being synchronous, which a
// thing you watch cannot be.
//
// So playback closes the socket. There is no room to corrupt, no frame to
// misapply, and no refactor of the render pipeline needed. Leaving is honest
// besides: you are not in two times at once, and the bar says so. On exit
// `connect()` re-joins and the server replays whatever you missed — that path
// exists already, because networks drop.
//
// The one precondition is `pending`: entering with an unacknowledged command
// would put a resume and an optimistic edit in the same window, which is the
// double-apply `connect()`'s `since` note exists to prevent. Refuse instead.
//
// `PLAY` itself is declared next to `CMP`; see the note there.

const PLAY_FROZEN = ["#add", "#save", "#revert", "#renamebtn", "#shot"];

async function startPlayback(list, from) {
  if (PLAY) return;
  if (pending.size)
    return flash("finish sending your current edit before playing history", true);
  let v = list;
  if (!v) { try { v = await store.history(); } catch (e) { return flash(e.message, true); } }
  if (!v || v.length < 2) return flash("there is nothing to play yet — save twice first", true);

  // DELIBERATE LEAVE, not a drop. `sock = null` first so this socket's own
  // `onclose` sees it has been superseded and does not start the reconnect loop
  // that would put us straight back in the room we are trying to leave.
  if (sock) { const old = sock; sock = null; try { old.close(); } catch {} }
  joined = false;

  PLAY = { v, i: Math.max(0, Math.min(v.length - 1, from ?? 0)),
           playing: false, timer: null as any, live: doc as any, cmp: CMP as any,
           // Measured ONCE, here, rather than per frame: `statsOf` schedules a
           // whole document, and re-running 65 of them on every step would make
           // the transport stutter to redraw a strip that cannot change.
           // `statsOf` takes a DOCUMENT, not a history entry — `v.map(statsOf)`
           // hands it `{n, at, note, doc}`, whose `.tasks` is undefined, so every
           // version measures as unschedulable and the strip silently draws
           // nothing. Same call shape as openHistory's, deliberately.
           stats: v.map(e => statsOf(e.doc)),
           // Off the NEWEST save, measured once for the same reason the stats are.
           targets: ((v.at(-1)!.doc.milestones || [])
             .map(m => ({ label: m.label, at: Date.parse(m.date + "T00:00:00Z") }))
             .filter(m => Number.isFinite(m.at))) };
  CMP = null;                              // one lens at a time
  closeHistory();
  document.body.classList.add("playing");
  $("#playbar").hidden = false;
  for (const s of PLAY_FROZEN) { const el = $f(s); if (el) el.disabled = true; }
  showVersion(PLAY!.i);
  flash(`playing ${v.length} saves — you have left the room while you watch`);
}

// ---- THE ARC: where every save thought the plan would land -------------------
//
// The chart answers "what did this version look like". It cannot answer "was this
// version better than the one before it", because you only ever see one at a
// time — and that question is the reason anybody opens history. The arc is that
// second altitude: one point per save, height is the forecast finish, so three
// weeks of work reads as a shape rather than as sixty-five charts you have to
// hold in your head.
//
// IT COSTS NOTHING TO COMPUTE. `statsOf` already runs over every version to fill
// the History panel's "lands Oct 9" column, and it returns `at` as ABSOLUTE
// epoch milliseconds precisely so versions that moved their own start date still
// compare — see its note. So this is a second reading of a number the panel is
// already showing, not a second scheduler.
// The geometry — the x per save, the y per forecast date, the padding a click
// reads back through — now lives in `ui/Playbar.tsx`, in one copy. It was three:
// `drawArc` laid the shape out and stashed its closures on the session so
// `moveArcHead` could shift a retained <circle> by `setAttribute`, and the click
// handler re-derived the same padding again.

/** The whole transport, from the session. Called on every step rather than
 *  poking six elements by hand — the arc is ten SVG nodes and a 900ms tick is not
 *  a budget worth a cache. */
function paintPlaybar() {
  if (!PLAY) return;
  const e = PLAY.v[PLAY.i];
  mountPlaybar($("#playbar"), {
    versions: PLAY.v.map(x => ({ n: x.n! })),
    stats: PLAY.stats.map((s2: any) => (s2 && s2.at != null ? s2.at : null)),
    targets: PLAY.targets,
    i: PLAY.i,
    playing: PLAY.playing,
    when: fmtWhen(e) + (e.by ? ` · ${e.by}` : ""),
    note: e.note || null,
    onExit: () => stopPlayback(),
    onPlayPause: () => playPause(),
    onStep: n => { playPause(false); playStep(n); },
    onSeek: i => { playPause(false); showVersion(i); },
  });
}

/** Put one archived document on the chart. The ladder runs on the way out for
 *  the same reason `forkVersion` runs it: an archived document is the most
 *  likely thing here to predate the current schema. */
function showVersion(i) {
  if (!PLAY) return;
  PLAY.i = i;
  const e = PLAY.v[i];
  try { doc = guard(applyMigrations(structuredClone(e.doc))); }
  catch (err) { stopPlayback(); return flash(`save #${e.n} will not open: ${err.message}`, true); }
  paintPlaybar();
  render();
}

function stopPlayback() {
  if (!PLAY) return;
  clearTimeout(PLAY.timer);
  doc = PLAY.live as LoadedDoc;                         // the live document, untouched throughout
  CMP = PLAY.cmp;
  PLAY = null;
  document.body.classList.remove("playing");
  $("#playbar").hidden = true;
  for (const s of PLAY_FROZEN) { const el = $f(s); if (el) el.disabled = false; }
  render();
  // REJOIN, and let the server decide what we missed. Nothing was pending when
  // we left and nothing could become pending while we were away, so `hello`
  // carries `since` and the replay is unambiguous.
  //
  // WAKE FIRST, for the same reason the cold-load path does: "the socket cannot
  // wake anything". Playback is the FIRST thing in this tool that deliberately
  // holds the socket shut for an unbounded stretch, so it is the first thing that
  // can outlive the idle shutdown — watch a long history for an hour and the
  // service parks itself while you are out of the room. Reconnecting straight
  // into a scaled-to-zero service drops into the backoff loop and shows
  // "connection lost — reconnecting…" over a plan that is perfectly fine.
  // `wakeAndWait` is silent when the server is warm, which is the common case.
  (async () => {
    await wakeAndWait();
    await connect();
    flash("back in the room");
  })();
}

function playStep(n) {
  if (!PLAY) return;
  const i = PLAY.i + n;
  if (i < 0 || i >= PLAY.v.length) return playPause(false);
  showVersion(i);
}

function playPause(on?: boolean) {
  if (!PLAY) return;
  PLAY.playing = on ?? !PLAY.playing;
  clearTimeout(PLAY.timer);
  paintPlaybar();
  if (!PLAY.playing) return;
  if (PLAY.i >= PLAY.v.length - 1) showVersion(0);
  const tick = () => {
    if (!PLAY || !PLAY.playing) return;
    if (PLAY.i >= PLAY.v.length - 1) return playPause(false);
    showVersion(PLAY.i + 1);
    PLAY.timer = setTimeout(tick, 900);
  };
  PLAY.timer = setTimeout(tick, 900);
}

$("#histbtn").onclick = openHistory;
$("#hist-close").onclick = closeHistory;
$("#hist").onclick = e => { if (tgt(e).id === "hist") closeHistory(); };

$("#exportone").onclick = exportOne;
// Alt for the file, plain click for the clipboard — the modifier is the rarer
// want, and it is in the title attribute because nothing else here advertises it.
$("#shot").onclick = ev => shootView(ev.altKey || ev.shiftKey);
// NEITHER OF THESE CONFIRMS ANY MORE, and that is the change. Both used to throw
// away the only record of what was said last time — "there is one baseline, and
// no undo". Nothing is thrown away by pointing somewhere else.
$("#cmpoff").onclick = () => { applyCompare(null); flash("comparison off"); };
// A RECONNECT, BECAUSE PRESENCE IS CREATED AT `hello`. The alternative is a
// second way to mutate a room from the client, and joining is already the one
// place that decides whether you exist in it. Cheap: the socket resumes from the
// sequence number it already holds, so nothing is refetched and nothing is lost.
$("#lurk").onchange = e => {
  LURK = fieldOf(e).checked;
  // Their copy of us goes stale the moment we stop being in their roster, and a
  // parked pointer left behind would be the exact ghost this feature removes.
  if (LURK) sendCursor(null);
  connect();
  flash(LURK ? "hidden — you are reading this plan without appearing in it"
             : "visible again");
  drawPresence();
};
$("#importbtn").onclick = () => $("#importfile").click();
// Cleared after each pick so choosing the SAME file twice still fires a change
// event — otherwise a re-import after an edit silently does nothing.
$("#importfile").onchange = async e => {
  const f = fieldOf(e).files?.[0];
  fieldOf(e).value = "";
  if (f) await importFile(f);
};
$("#collapse").onclick = () => {
  const t = $("#top"); t.classList.toggle("collapsed");
  $("#collapse").textContent = t.classList.contains("collapsed") ? "⌄" : "⌃";
  $("#collapse").title = t.classList.contains("collapsed") ? "Show the control bar" : "Collapse the control bar";
  render();          // the chart can use the reclaimed height
};
$("#newplan").onclick = newPlan;
$("#fork").onclick    = fork;
$("#add").onclick   = add;
// THE PLAN CHAT (ui/Assistant.tsx, agent.ts): a local model with tools, running in this page. Its writes go
// through `call("commands")`, the batch path every other multi-edit uses.
// `rawDoc()`, not `doc`: the chat reads and writes the wire units (minutes, ISO instants). The guarded
// `doc` projects `dur` into days and times into day numbers, which the agent then showed the model and
// sent back in undo commands (a 15-minute task's undo arrived as dur 0.0104 and was refused).
mountAssistant($("#assist"), { getDoc: () => rawDoc(), call, canEdit: () => !PLAY && !!shareToken() && id !== "demo",
  // `selectMade`'s latch without its focus grab: the task may still be in flight, and focus stays in the chat.
  openTask: tid => { if (!doc.tasks.some(t => t.id === tid)) { selectOnArrival = tid; return; } sel = tid; render(); } });
$("#assistbtn").onclick = () => window.dispatchEvent(new Event("assistant:toggle"));
// 🎲 A RANDOM TASK FROM WHAT THE LENS LETS THROUGH. Same three tests render() calls `inFilter`
// plus `drawn`, so a legend pick, the find box or a chain focus narrows the pool in dim mode
// too (dimmed rows are on screen but filtered out). Selects, as a click would, and scrolls to it.
$("#dice").onclick = () => {
  const chain = chainMembers(), filtering = isFiltering();
  const pool = doc.tasks.filter(t => drawn(t) && (!chain || chain.has(t.id)) && (!filtering || matchesFilter(t)));
  const t = pool[Math.floor(Math.random() * pool.length)];
  if (!t) { flash("nothing on screen to pick"); return; }
  sel = t.id; render();
  requestAnimationFrame(() => POS[t.id]?.el?.querySelector(".bar")
    ?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" }));
};
addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); window.dispatchEvent(new Event("assistant:toggle")); }
});
// `#link` — "Link dependency" in the toolbar — WAS HERE AND IS GONE (2026-09-20).
// It armed the same mode as the panel's buttons and could not say which
// direction it meant, because it had no room to: one control for a relationship
// with two ends. The panel now has "Waits for…" and "Blocks…", named after the
// dependency rows they fill, and it is where the dependency chips already live —
// so the toolbar button was a second way in that was strictly less clear than
// the first. Its graph-arming half moved to `armLink` below, which is the only
// part of it that was doing work nothing else did.
// THE NOTE NEVER STANDS BETWEEN YOU AND A SAVE. This tool gets driven live in
// front of a room, so a box you must clear before your work is written is the
// wrong trade: the field opens focused, Enter saves, Esc cancels, and empty is a
// fine answer you can fill in later from the panel. And an unchanged plan saves
// on the first click without asking — there is nothing to annotate when the save
// is going to be deduped anyway.
const savePop = open => {
  $("#savepop").hidden = !open;
  if (open) { $f("#savenote").value = ""; $f("#savenote").focus(); }
};
const doSave = () => { const n = $f("#savenote").value.trim(); savePop(false); save(n); };
$("#save").onclick = () => {
  if (!$("#savepop").hidden) return doSave();          // a second click means "yes, that one"
  if (id === "demo" || !unsavedCount()) return save(undefined);
  savePop(true);
};
$("#savenote").onkeydown = e => {
  if (e.key === "Enter") { e.preventDefault(); doSave(); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); savePop(false); }
};
// REVERT MEANS "DISCARD THE UNSAVED CHANGES", AND IT MOVES THE WHOLE ROOM.
//
// It used to be `load(id)`, which was the single-writer tool's meaning: throw
// away this tab's buffer and re-read the file. There is no buffer now — every
// edit went to the server as it was made — so re-reading could only ever show
// you the same document back, and it did so by opening a SECOND socket without
// closing the first (see `connect`). Clicking it therefore did nothing visible
// and leaked a session per click.
//
// What it does now is `/api/revert` at the newest archived version, which is
// exactly "put the plan back the way it was saved". The server archives the
// draft it is discarding first, so this is recoverable — but it happens to
// EVERYONE looking at the plan, at once, so it names what it is throwing away
// and who did it before it asks.
$("#revert").onclick = async () => {
  if (!doc) return;
  if (id === "demo") return flash("The demo is a fixture, not a plan — there is nothing stored to go back to.", true);
  if (!lastSave) await refreshLastSave();
  if (!lastSave) return flash("This plan has no saved version to go back to.", true);
  const n = unsavedCount(), who = unsavedBy();
  if (!n) return flash(`Nothing to discard — this plan is as it was saved at #${lastSave.n}.`);
  if (!confirm(`Discard ${n} unsaved change${n === 1 ? "" : "s"}${who ? ` by ${who}` : ""}?\n\n`
    + `This plan goes back to save #${lastSave.n}${lastSave.note ? ` — "${lastSave.note}"` : ""}, `
    + `for EVERYONE looking at it right now, not just this tab.\n\n`
    + `What is being discarded is archived first, so it can be reverted back to.`)) return;
  try { await store.revert(lastSave.n); }
  catch (e) { flash(e.message || "could not revert", true); }
  // No render and no adopt here: the server broadcasts `reverted` to everyone
  // INCLUDING us, and `onFrame` is the one place that lands. Doing it twice is
  // how a document and a room start to disagree.
};
// A CLICK THAT TRAVELLED IS A DRAG, NOT A BACKGROUND CLICK. Deselecting here is
// right for a genuine click on empty chart, and wrong for the tail of a gesture.
// A drag that changes nothing never re-renders, so the element the pointer went
// down on survives and the browser dispatches a click at the common ancestor —
// which is this. The effect was that being told WHY a gesture was refused also
// shut the panel you would have acted on, and the actuals work added two more
// ways to reach it. Distance is the honest test, at the same 4px startConstrain
// already uses to decide a drag has begun.
let downAt: any = null;
// CAPTURE PHASE, and that is the whole fix rather than a tidy-up. The distance
// test below needs the origin of every gesture, and this ran on the BUBBLE — so
// the two handlers that stop propagation to claim a drag, `startDrag` on the grip
// and the chips' own clicks, meant `downAt` was never recorded for exactly the
// gestures it exists to measure. It went unnoticed while the rows were rebuilt on
// every render: the element the pointer went down on was destroyed, the click had
// nowhere coherent to land, and the deselect did not fire by accident. React keeps
// the row, so the click now reliably reaches here — and a 90px grip drag was
// reading as a click on empty chart and clearing the selection.
$("#chart").addEventListener("pointerdown", e => { downAt = [e.clientX, e.clientY]; }, true);
$("#chart").onclick = e => {
  const travelled = downAt
    && Math.max(Math.abs(e.clientX - downAt[0]), Math.abs(e.clientY - downAt[1])) >= 4;
  downAt = null;
  if (!linking && !travelled) { sel = null; render(); }
};

// WHAT DAY AM I POINTING AT. The axis labels months, the sprint rules label
// sprints, and between them a bar's left edge was a pixel you had to estimate
// against the nearest tick — worse the further you zoom in, because the ticks do
// not get denser as the days get wider.
//
// It reads out in the gutter's corner, which is the one piece of chrome already
// pinned to the left edge and otherwise empty. Weekday first, because on a
// five-day week the weekday is half the answer — and a day nobody works says
// WHY, since "Nov 26 · day off" and "Nov 28 · weekend" are different facts and
// the shaded band alone cannot tell you which.
const fmtDay = d => new Date(+d0() + Math.round(d) * DAY)
  .toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric", timeZone:"UTC" });
// AND THE HOUR, ONCE THE CHART IS DRAWING HOURS. A day was the whole answer
// while a day was the finest thing on screen; zoomed past that it became the
// least useful moment to be told only the date, because the pointer is now
// somewhere specific inside a day the chart is happy to draw and the readout
// would not say where.
//
// `TICK_STEP < 1` is the axis's own test for whether a tick gets a clock face,
// so the readout gains the hour on exactly the render the axis does — one zoom
// notch, both change, no window where they describe the chart differently.
//
// AN HOUR, FLOORED, AND NO MINUTES. `CAL_STEPS` stops at an hour deliberately —
// its comment explains that minutes were affordable and not worth having — so a
// minute here would point at a precision no tick on the chart draws, and the
// readout would be claiming to resolve something the picture cannot. Floored
// rather than rounded because it names the hour you are STANDING IN: at 13:59
// you are still inside 1pm, and rounding would put 2pm over a pointer that has
// not reached it.
//
// `fmtHour` lives up beside `clockStr` — the TODAY rule's caption needs it too,
// and that is built in the render, which runs long before this line.
$("#chart").addEventListener("pointermove", e => {
  const el = $("#chart"), gut = el.querySelector(".axgut");
  if (!gut) return;
  const x = e.clientX - el.getBoundingClientRect().left + el.scrollLeft;
  if (x < LABW) { gut.textContent = ""; return; }     // over the gutter itself
  const at = LO + (x - LABW) / PPD;
  const d = Math.floor(at);
  const off = !CAL.isWorking(d), h = at - d;
  gut.textContent = fmtDay(d)
    + (TICK_STEP < 1 ? " · " + fmtHour(h) : "")
    + (off ? (doc.hours?.dates?.[isoOf(d)] ? " · day off" : " · weekend")
      : !CAL.win(d).some(([wa, wb]) => h >= wa && h < wb) ? " · off hours" : "");
});
$("#chart").addEventListener("pointerleave", () => {
  const gut = $("#chart").querySelector(".axgut");
  if (gut) gut.textContent = "";
});

// ---- YOUR CURSOR, FOR EVERYONE ELSE ---------------------------------------
// A SEPARATE LISTENER FROM THE DAY READOUT ABOVE, deliberately: that one returns
// early when there is no axis gutter and when the pointer is over the label
// column, and both of those are places a colleague still wants to see you.
// Folding the two together would have made where your cursor is broadcast depend
// on where a tooltip happens to be useful.
//
// LEAVING THE CHART CLEARS IT rather than parking the last position. A pointer
// that stays where you left it reads as somebody looking at a task they walked
// away from ten minutes ago, and in a meeting that is a wrong answer to "what is
// Sam looking at?".
$("#chart").addEventListener("pointermove", e => sendCursor(chartCursor(e)));
$("#chart").addEventListener("pointerleave", () => sendCursor(null));
// Same argument for a tab nobody is looking at, and it is the common case: three
// people leave a plan open all afternoon and three stale cursors sit on the chart
// claiming attention nobody is paying.
addEventListener("blur", () => sendCursor(null));
document.addEventListener("visibilitychange", () => { if (document.hidden) sendCursor(null); });

// ZOOM AROUND A FIXED POINT. render() restores the old scrollLeft, which is
// right for every other rebuild and wrong for this one: the pixel it points at
// means a different date once the scale moves. So the date under the anchor is
// read before and put back after.
//
// The anchor is the argument because the two gestures disagree about it. The
// picker has no position, so it keeps the middle of the view — that is what you
// were looking at. A pinch has a very definite position, and zooming away from
// your own fingers is the thing that makes trackpad zoom feel broken.
function setZoom(days: number, anchorClientX?: number) {
  const el = $("#chart"), r = el.getBoundingClientRect();
  const ax = anchorClientX == null ? el.clientWidth / 2 : anchorClientX - r.left;
  const day = LO + (el.scrollLeft + ax - LABW) / PPD;
  zoomRaw = days;
  zoomDays = snapZoom(days);
  // NOT `Math.round`. Whole days were the only zoom that existed, so rounding was
  // free; now any sub-day zoom rounds to "0", which reads back as falsy and drops
  // the zoom on reload. Six places keeps a one-minute view (0.000694) intact.
  // FLUSHED, because the very next line reads the scale this render establishes.
  // `root.render()` only SCHEDULES a commit, so an unflushed render left the
  // scroll correction computing against the OLD PPD; the browser then painted a
  // frame at the new scale with the old offset, and a pinch came out as the whole
  // chart jumping left and right. Measured before this fix: a 28px backward jolt
  // mid-gesture, intermittent precisely because whether React's commit beat this
  // assignment depended on how busy the frame was.
  flushMount(render);
  el.scrollLeft = LABW + (day - LO) * PPD - ax;
}
// FIT: THE ZOOM THE PICKER CANNOT NAME. "Plan" frames every task; the presets
// frame a fixed span. Neither frames WHAT YOU FILTERED TO, which is the thing
// you actually want after ticking a legend value down to eight tasks out of a
// hundred and thirty.
//
// IT READS `POS`, WHICH IS THE POINT. POS is rebuilt every render and holds one
// entry per row that was actually drawn — filtered-out rows are skipped while
// building, never added and then hidden — so "visible" needs no second
// definition here that could drift from the one render() already used. Pixels
// rather than day numbers, so the inverse of `X()` turns them back.
//
// NOT ROUTED THROUGH `setZoom`, deliberately: that snaps to the nearest preset
// within 5%, which is right for a pinch and wrong for this. Snapping a fit to
// "1 month" would frame something other than what was asked for, which is the
// one thing this button must not do.
function fitTimeline() {
  const ids = Object.keys(POS);
  if (!ids.length) return;
  let lo = Infinity, hi = -Infinity;
  for (const id of ids) { const p = POS[id]; lo = Math.min(lo, p.x); hi = Math.max(hi, p.x + p.w); }
  const from = LO + (lo - LABW) / PPD, to = LO + (hi - LABW) / PPD;
  // A HAIRLINE OF MARGIN, and a floor under it: a set of zero-duration tasks all
  // on one day has `to === from`, and fitting a zero-wide span would divide by
  // zero and hand PPD an Infinity. One minute is the same floor the zoom picker
  // and `setZoom` already clamp to.
  const pad = Math.max((to - from) * 0.02, 1 / 1440);
  const want = Math.max(1 / 1440, (to - from) + pad * 2);
  zoomRaw = want;
  // AT OR BEYOND THE WHOLE PLAN IS "Plan", not a custom span that happens to
  // equal it - so fitting an unfiltered chart leaves the picker reading its own
  // preset rather than a number.
  zoomDays = want >= SPAN_DAYS ? null : want;
  // Flushed for the same reason as `setZoom` — the scroll below is computed from
  // the PPD this render establishes, and scheduling it is not applying it.
  flushMount(render);
  // THE LEFT EDGE OF THE CHART IS NOT THE LEFT EDGE OF THE WINDOW. The label
  // column is `LABW` px of sticky overlay sitting on top of the scroller, so
  // scrolling the first bar to viewport x=0 files it neatly UNDERNEATH the
  // labels. `setZoom` gets this right for free because its anchor is a real
  // pointer position; this one has to say where it wants the bar to land, and
  // that is just right of the labels.
  //
  // Found by measuring: in GRID coordinates the fit looked perfect — the bars
  // spanned 96% of the drawable width — while three of four were invisible on
  // screen. Grid coordinates cannot see the overlay.
  $("#chart").scrollLeft = (from - pad - LO) * PPD;
}

// THE THREE SPANS WORTH NAMING. A sprint is per-plan data, so this cannot be
// static markup — the option means 3 weeks in one plan and 2 in another, and a
// picker that said "1 sprint" while showing someone else's sprint would be the
// same lie as a chart titled for a date it does not land on.
//
// Sorted widest-first so the list reads in one direction whatever a plan's sprint
// length is: at five weeks a sprint is wider than a month, and the order should
// follow the spans rather than the names.
const zoomPresets = () => [
  { days: SPAN_DAYS, label: "Plan", whole: true },
  { days: 30, label: "1 month" },
  ...(doc.sprint?.weeks ? [{ days: 7 * doc.sprint.weeks, label: "1 sprint" }] : []),
  { days: 1, label: "1 day" },
  { days: 1 / 24, label: "1 hour" },
  { days: 1 / 96, label: "15 min" },
].sort((a, b) => b.days - a.days);

// WITHIN 5% OF A NAMED SPAN IS THAT SPAN. A pinch lands on 29.97, never on 30, so
// an exact match never fired and the picker read "30 days" while sitting next to
// an option that said 1 month — the control disagreeing with itself about the
// thing it was showing. Snapping also makes the presets magnetic on a trackpad,
// which is the behaviour anyone who has dragged a guide already expects.
const snapZoom = d => {
  if (d == null) return null;
  const hit = zoomPresets().find(z => Math.abs(d - z.days) <= z.days * 0.05);
  return hit ? (hit.whole ? null : hit.days) : d;
};

// Rebuilt from the presets, plus a spare that reports the span you are actually
// looking at when a pinch left you between them — more useful than a "Custom"
// that says nothing, and the same kind of answer the named options give.
// Keyed so a render that changes nothing does not rebuild the list underneath an
// open dropdown.
function syncZoomPicker() {
  const host = $opt("#zoomhost"); if (!host) return;
  // IN THE CALENDAR, ZOOM IS HOW MANY HOURS FILL THE WINDOW; a pinch between presets reads back as its own value.
  if (VIEW_MODE === "calendar") {
    const hit = CAL_ZOOMS.find(h => Math.abs(h - calHours) < 1e-6);
    mountPicker(host, {
      id: "zoom",
      value: hit ? String(hit) : "custom",
      options: [...CAL_ZOOMS.map((h): PickerOption => ({ value: String(h), label: `${h} hours` })),
                ...(hit ? [] : [{ value: "custom", label: `${Math.round(calHours)} hours` }])],
      onPick: v => { if (v !== "custom") setCalHours(+v); },
    });
    return;
  }
  const ps = zoomPresets();
  // Zero is "Plan" here too, or the picker reads "0 days" while showing the whole
  // chart — the control disagreeing with itself, which is what `snapZoom` exists
  // to prevent one case of.
  const cur = zoomDays || SPAN_DAYS;
  const hit = ps.find(z => Math.abs(cur - z.days) < 1e-6);
  mountPicker(host, {
    id: "zoom",
    value: hit ? (hit.whole ? "" : String(hit.days)) : "custom",
    options: [...ps.map((z): PickerOption => ({ value: z.whole ? "" : String(z.days), label: z.label })),
              ...(hit ? [] : [{ value: "custom", label: `${Math.round(cur)} days` }])],
    onPick: v => { if (v !== "custom") setZoom(+v || 0); },   // "custom" is a readout, not a setting
  });
}

// PINCH. On a Mac trackpad a pinch arrives as a wheel event with ctrlKey set —
// that is the platform's own signal, not a heuristic — and ctrl+wheel on a mouse
// means the same thing to anyone who has zoomed anything else. preventDefault
// stops the browser zooming the whole page instead.
//
// Plain two-finger scrolling is left completely alone: #chart is already a
// horizontal scroller, so panning was native before any of this.
// SCROLLING FAR ENOUGH REBUILDS THE AXIS. Ticks are built for the window plus
// two screenfuls either side, so ordinary scrolling is already covered and this
// never fires. Travel past that margin and the ladder has to be regenerated —
// there is nothing drawn out there.
//
// ON SETTLE, NOT DURING. A render is ~80ms; running one per scroll frame would
// be far worse than the blank margin it is fixing. 140ms after you stop is below
// the threshold where you would go looking for the ticks, and a scroll that
// stays inside the margin costs one comparison per settle.
let scrollRebuild = 0, scrollBuiltAt = -1e9, scrollBuiltSeen = 0;
$("#chart").addEventListener("scroll", () => {
  clearTimeout(scrollRebuild);
  scrollRebuild = setTimeout(() => {
    const el = $("#chart");
    const seen = el.clientWidth / PPD;
    const at0 = LO + (el.scrollLeft - LABW) / PPD;
    // Only when the view has left the ground the last build covered.
    if (Math.abs(at0 - scrollBuiltAt) < seen * 1.5 && seen === scrollBuiltSeen) return;
    scrollBuiltAt = at0; scrollBuiltSeen = seen;
    render();
  }, 140) as unknown as number;
}, { passive: true });

// ONE RENDER PER FRAME, NOT ONE PER EVENT. `setZoom` rebuilds the axis and every
// row synchronously, and a trackpad pinch emits wheel events faster than that
// costs: measured at 14.3ms per event across 138 rows, against a 16.7ms frame
// budget. Twenty events of a single pinch blocked the main thread for 287ms, so
// the chart could not paint a frame in the middle of the gesture it was
// answering — which is what "flickery, jittery, a glitch fest" actually was.
//
// The accumulator steps from the PENDING value when there is one, so events
// arriving inside the same frame compound exactly as they did when each got its
// own render. The gesture is unchanged; only the number of repaints is.
let zoomWant: { days: number; x: number } | null = null, zoomRAF = 0;
$("#chart").addEventListener("wheel", e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  // Stepped from the RAW span, never from what is on screen — stepping from the
  // drawn value means every step starts from the preset it just snapped to and
  // gets snapped straight back. A week filling the window is as far in as a
  // day-atom chart can justify, and the whole plan is as far out as there is
  // anything to show; snapZoom turns that outer end into "Plan" on its own.
  // `|| SPAN_DAYS`, NOT `== null`. "Plan" arrives from the picker as
  // `setZoom(+"" || 0)` — a literal zero, not a null — so the null check let a
  // zero through as a real span. Multiplying it kept it zero, which clamped to the
  // one-minute floor: one pinch after choosing "Plan" and the chart slammed from
  // the whole plan to sixty seconds. Zero and absent mean the same thing here.
  const base = zoomWant ? zoomWant.days : (zoomRaw || SPAN_DAYS);
  zoomWant = { days: Math.min(SPAN_DAYS, Math.max(1 / 1440, base * Math.exp(e.deltaY * 0.01))),
               x: e.clientX };
  if (zoomRAF) return;
  zoomRAF = requestAnimationFrame(() => {
    zoomRAF = 0;
    const w = zoomWant; zoomWant = null;
    if (w) setZoom(w.days, w.x);
  });
}, { passive: false });

// ---- driving the chart without a mouse ------------------------------------
// PAN AND ZOOM AS BUTTONS. Every way of moving this chart was a gesture — sideways
// scroll to pan, ctrl+wheel to zoom — which is fine until you want one precise
// step, or you are on a mouse with no horizontal wheel, or the gesture is fighting
// you. These drive the same two primitives the gestures do: `setZoom` for scale
// and `scrollLeft` for position. No new behaviour, just a surface that can be
// aimed.
//
// ZOOM WALKS THE PRESET LADDER rather than multiplying by some factor, so the
// buttons land on the same named spans the picker offers and the two controls
// always agree about where you are.
// HALVE OR DOUBLE, off the RAW span. The first version walked the picker's preset
// ladder, which reads sensibly and behaves terribly: with sprints off that ladder
// is Plan, 1 month, 1 day, 1 hour, 15 min, so one press of "zoom in" went from a
// month to a day — a 30x jump. The presets exist to NAME spans a person asks for,
// not to space them evenly.
//
// Off `zoomRaw` rather than `zoomDays` for the reason the wheel handler already
// gives: stepping from the drawn value means every step starts from the preset it
// just snapped to and gets snapped straight back, so the zoom cannot leave one.
// `snapZoom` still makes the named spans magnetic on the way past.
const zoomStep = (dir: number) => {
  // Same zero-is-not-null trap as the wheel handler above.
  const base = zoomRaw || SPAN_DAYS;
  setZoom(Math.min(SPAN_DAYS, Math.max(1 / 1440, base * (dir < 0 ? 0.5 : 2))));
};
// Six tenths of a window, which is the page-scroll idiom: enough to be a real
// move, little enough to keep something you were looking at on screen.
const panStep = (dir: number) => {
  const el = $("#chart");
  el.scrollBy({ left: dir * el.clientWidth * 0.6, behavior: "smooth" });
};
$("#panl").onclick = () => panStep(-1);
$("#panr").onclick = () => panStep(1);
$("#zoomin").onclick = () => zoomStep(-1);
$("#zoomout").onclick = () => zoomStep(1);
// FOLDED BY DEFAULT. Rascal Two asked for them tucked away: a permanent four-button
// cluster is toolbar rent paid every session for a control used occasionally.
$("#navtoggle").onclick = () => {
  const pad = $("#navpad");
  pad.hidden = !pad.hidden;
  $("#navtoggle").classList.toggle("on", !pad.hidden);
};
addEventListener("keydown", e => {
  // PLAYBACK OWNS THE KEYBOARD while the transport is up and nothing is layered
  // over it — the chart is a film and these are its controls. It returns rather
  // than falling through, so a stray arrow cannot reach the handler that MOVES A
  // TASK: `emit` would refuse that, but refusing is a message somebody has to
  // read, and not arriving is quieter. The modal check keeps Escape meaning
  // "close this dialog" when one is open over the film, which is what it means
  // everywhere else in this handler.
  const layered = [$("#mentions"), $("#wall"), $("#reorder"), $("#hist"), $("#settings")]
    .some(el => el && !el.hidden);
  if (PLAY && !layered && !/^(INPUT|TEXTAREA)$/.test(tgt(e).tagName || "")) {
    if (e.key === "Escape") { e.preventDefault(); stopPlayback(); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); playPause(false); playStep(-1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); playPause(false); playStep(1); return; }
    if (e.key === " ") { e.preventDefault(); playPause(); return; }
    return;
  }
  // Escape peels one layer at a time — the modal, then the popover, then the
  // selection — rather than tearing the lot down at once. Chain focus goes with
  // the selection because it is a property of it.
  if (e.key === "Escape") {
    // Topmost layer, and it peels first: it is the only one that appeared without
    // being asked for, so it is the one Escape most obviously means.
    if (!$("#mentions").hidden) { closeMentions(); return; }
    if (!$("#wall").hidden) { closeWall(); return; }
    if (!$("#reorder").hidden) { closeReorder(); return; }
    if (!$("#hist").hidden) { closeHistory(); return; }
    if (!$("#settings").hidden) { closeSettings(); return; }
    if (!$("#savepop").hidden) { savePop(false); return; }
    if (!$("#renamepop").hidden) { renamePop(false); return; }
    linking = null; sel = null; chainFocus = null; render();
  }
  // STILL NO TASK-LEVEL SHORTCUTS, and the paragraph this replaces is the reason
  // the three below are the three. ⌘D duplicated and Alt+arrow moved a row up or
  // down the queue; both went because an undiscoverable binding that EDITS a
  // scheduling input is a trap rather than a feature.
  //
  // WHAT CHANGED IS THE TEST, NOT THE VERDICT. The objection was never "no keys",
  // it was "no key nobody can find, on a gesture that writes". F and C write
  // nothing — they reframe and they unfilter, both view state, both undone by
  // pressing them again — and each one is printed on the face of the button it
  // presses, which is the one place somebody looking for it would look. Enter and
  // Space are not a shortcut at all: they are the activation contract every
  // focusable control on the web already owes, and this one was not paying it.
  if (layered || !$("#landing").hidden) return;
  if (e.metaKey || e.ctrlKey || e.altKey || inField(e)) return;
  // WHATEVER VIEW IS UP, FIT WHAT THAT VIEW CAN SEE. Each view already has a
  // button that knows how; this only decides which one to press, so the key
  // cannot drift from what the button does.
  if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    if (VIEW_MODE === "graph") $("#gfit").click(); else if (VIEW_MODE === "calendar") calFit(); else fitTimeline();
    return;
  }
  // ← → STEP THE CALENDAR by its span, a day or a week.
  if (VIEW_MODE === "calendar" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault(); calStep(e.key === "ArrowLeft" ? -1 : 1); return;
  }
  // C FOR CLEAR, and it goes further than the button beside it on purpose: the
  // ask was "reset the filters AND the toggles", which is the whole of the view
  // rather than the half a filter owns.
  if (e.key === "c" || e.key === "C") {
    e.preventDefault();
    showEverything(true);
    // A KEY THAT CHANGES NOTHING VISIBLE HAS TO SAY SO. Press it on an unfiltered
    // plan and every pixel stays where it was, which reads as a dead key rather
    // than as "there was nothing to clear".
    flash("filters and view toggles cleared");
    return;
  }
  // I FOR ISOLATE, and it passes the same test F and C pass: view state, undone
  // by pressing it again, and printed on the face of the control it presses —
  // which is why the toggle had to stop being called "hide the rest" first. A
  // key named for a label nobody can say is a key nobody can find.
  if (e.key === "i" || e.key === "I") {
    e.preventDefault();
    focusMode = focusMode === "isolate" ? "dim" : "isolate";
    // A full render, not a repaint: this one adds and removes rows. Same branch
    // the checkbox takes.
    render();
    // THE RULE C ESTABLISHED ONE BLOCK UP, and this key needs it more. Isolate
    // only bites once something is picked (`isolating` is gated on `filtering ||
    // chain`), so on an unfiltered plan it is a real mode change with nothing to
    // show for it — the one case where a key genuinely looks broken. So the
    // message says what the mode is AND what it is waiting for.
    flash(focusMode !== "isolate"
      ? "isolate off — every row drawn, non-matches greyed"
      : isFiltering() || chainFocus
      ? "isolate on — showing only what you picked"
      : "isolate on — pick a chip, a search or a chain to narrow to");
    return;
  }
  // ENTER AND SPACE ADVANCE THE SELECTED TASK — the same cycle a second click
  // performs, through the same function, so the panel cannot open to one size
  // for the mouse and another for the keyboard.
  //
  // BOUND HERE RATHER THAN ON THE ROW because `sel` is the one piece of state all
  // three views share. A graph node is painted on a canvas and cannot hold focus
  // at all, so a handler that lived on the row would have left the graph with no
  // keyboard whatsoever — which is the failure being fixed, one view along. The
  // row has its OWN handler as well (ui/Grid.tsx), for the case where the row is
  // what is focused; `onControl` keeps the two from both firing.
  if ((e.key === "Enter" || e.key === " ") && sel && !linking && !onControl(e)) {
    e.preventDefault();
    pick(sel);
  }
});

// ---------------------------------------------------------------------------
// THE GRAPH LENS — what waits on what.
//
// The timeline answers WHEN, and it answers it with the two encodings this file
// calls load-bearing: position and length are the dates. That is also its limit.
// Every other channel is spent — hue is the system, the rim is the environment,
// the texture is the confidence, opacity belongs to the filter, and shape was
// what was left — so a question the timeline cannot already answer needs new
// GEOMETRY rather than another channel. "What waits on what" is that question:
// on a plan of any size the arrows cross the whole chart, which is why the depth
// budgets and the chain lens had to exist at all.
//
// It is a LENS, not a second tool. Same document, same schedule, same selection,
// same legend filter, same chain focus, same inspector.
//
// IT CAN WRITE ONE THING, and only one: dragging between two nodes adds a
// dependency (ADR 0007). This paragraph used to end "nothing here writes to the
// plan and nothing here can move a date", and the second half is still true and
// still the important half — position here is not time, so there is no gesture
// that edits a duration, a start or a deadline. What changed is that the
// question this view answers is "what is in the way", and on a personal plan the
// answer is usually a dependency nobody has drawn yet.
//
// WHAT IT GIVES UP, stated rather than discovered: position stops meaning time.
// That is the whole trade, and it is why this is a deliberate detour rather than
// a default — the two views cannot share a mental model, so the switch is a
// switch rather than a split screen.
let VIEW_MODE = "timeline";
// WHAT A ROW'S POSITION MEANS. "team" is the input — grouped by lane, array
// order, and moving a row moves the queue. "date" is the output — one flat list
// ordered by when work starts, so the vertical axis is time and you read the
// plan downward. View state like the zoom and the fold, never the document.
let ROWMODE = "team";
// ELAPSED IS THE TIMELINE WITH NO CALENDAR. Same scheduler, same bars, same
// document — the axis stops asking what date it is and counts from the plan's
// own origin instead. A process map has no meaningful dates: it is "+30 min,
// then +2 days", and every absolute date on it is noise that also drifts,
// because an unpinned task is floored at today and today keeps moving.
function isRel() { return VIEW_MODE === "relative"; }
let cy: any = null, cyLib: any = null, cyFailed = false, cyRegistered = false;
// The edge-drawing gesture's handle, kept so `drawGraph` can rebuild the graph
// without leaking one behind per repaint.
let cyEh: any = null;
// Which channel, if any, the columns are banded by. View state, like the rest.
let GRAPH_GROUP = "";

// LOADED ON FIRST USE, not at boot. The timeline is the default and works with no
// network at all; making every page load fetch a graph library for a view most
// sessions never open would be a tax on the common case. A failure is reported in
// the panel rather than thrown, because losing the graph must not take the
// timeline down with it.
// A LOCAL PACKAGE, LAZILY. This imported from esm.sh until the plan became the
// place someone's whole task list lives, at which point "the graph needs the
// internet" stopped being a reasonable thing for a local instance to say — the
// rest of the stack runs against a local S3 server and has no such
// dependency. A bare dynamic `import()` of a dependency keeps every word of the
// paragraph above true: Vite code-splits it, so the timeline still boots without
// fetching a graph library, and the chunk now comes from the same origin as the
// page instead of a CDN.
//
// NOT the ADR 0004 exception. That is about `shared/`, where the browser must
// run the same BYTES the server hashed; cytoscape is an ordinary dependency
// nobody compares across two pipelines, so bundling it is just bundling.
async function ensureCy() {
  if (cyLib || cyFailed) return cyLib;
  try {
    const [core, edgehandles] = await Promise.all([
      import("cytoscape"),
      import("cytoscape-edgehandles"),
    ]);
    cyLib = core.default;
    // Registering twice throws, and `ensureCy` is awaited from more than one
    // place — the guard above only holds once `cyLib` is assigned, which is
    // after this line on the first call.
    if (!cyRegistered) { cyLib.use(edgehandles.default); cyRegistered = true; }
  } catch (e) { cyFailed = true; console.warn("cytoscape did not load:", e); }
  return cyLib;
}

// HOW DEEP IN THE CHAIN A TASK SITS — the LONGEST path from something that waits
// on nothing, not the shortest. Breadth-first depth is the obvious choice and the
// wrong one: it puts a task in the first column that can reach it, so an edge
// from a long chain into a short one points BACKWARDS on screen. Longest-path
// layering guarantees every edge points the same way, which is the entire
// readability argument for drawing this as columns.
//
// Guarded against a cycle, for the same reason `hopsUp` walks iteratively: a
// cycle here would blow the stack before `sched()` got the chance to report it
// as the dependency cycle it is.
function depthsOf(tasks) {
  const by = Object.fromEntries(tasks.map(t => [t.id, t]));
  const depth = {}, open = {};
  const walk = id => {
    if (depth[id] !== undefined) return depth[id];
    if (open[id]) return 0;
    open[id] = 1;
    const ds = (by[id].deps || []).filter(d => by[d]);
    depth[id] = ds.length ? 1 + Math.max(...ds.map(walk)) : 0;
    open[id] = 0;
    return depth[id];
  };
  for (const t of tasks) walk(t.id);
  return depth;
}

// Positions are COMPUTED and the layout is `preset`. A force-directed layout
// settles somewhere different on every render — a chart that rearranges itself
// when you tick a legend value is one you have to re-read each time — and a
// layered-layout library is a dependency for arithmetic that is nine lines.
//
// Within a column the order is lane, then array position. Both already mean
// something here: a lane is a team, and array order IS the queue order the
// scheduler breaks ties by. So the columns read top-to-bottom the way the
// timeline's rows do, which is the cheapest thing that makes two views feel like
// one tool.
const COL_GAP = 250, ROW_GAP = 62;

// WHERE EVERYTHING GOES. Columns are the longest path; this decides the order
// WITHIN each column, which is the whole readability problem.
//
// THE FIRST VERSION SORTED EACH COLUMN BY THE AVERAGE ROW OF WHAT IT WAITS ON —
// the barycentre heuristic — and it left 137 crossings on a 38-task plan. The
// reason is structural rather than a matter of tuning: an edge spanning four
// columns is INVISIBLE to the three columns it passes over. Nothing in them knows
// it is there, nothing leaves room for it, and it is free to slice through every
// node between its ends. Sorting harder cannot fix an edge nobody can see.
//
// So long edges are broken into DUMMY nodes, one per column crossed. Now every
// edge in the layered graph spans exactly one column, every intermediate column
// contains a placeholder that participates in its own ordering, and the ordering
// reserves a row for the edge to travel along. This is the middle step of the
// standard layered-drawing method, and it is the step that was missing rather
// than an optimisation on top.
//
// AND THE EDGES ARE DRAWN THROUGH THE DUMMIES, which is not a detail. Reserving
// a lane and then drawing the edge straight from end to end — which is what the
// first attempt at this did — optimises a model the picture does not follow: the
// measured crossings went from 137 to 134 and the chart looked identical, because
// every long edge ignored the corridor that had just been cleared for it. Each
// one is a chain of segments now, so what is optimised and what is drawn are the
// same thing.
function layoutOf(tasks, groupBy) {
  // AN ORPHAN IS NOT PART OF THE PICTURE THIS DRAWING MAKES. A layered graph says
  // "this waits on that". A task with no edge in either direction says nothing,
  // and longest-path layering puts every one of them in column 0, because column
  // 0 is where depth 0 lives. On a real plan that is most of the chart — 37 of
  // 103 on the plan this was measured against — so the column that should read
  // as "nothing is blocking these" becomes a fifty-node wall, and the dependency
  // structure the graph exists to show is squeezed into the columns beside it.
  //
  // NO LAYOUT ALGORITHM FIXES THIS, which is worth writing down because the
  // obvious response to "the graph looks bad" is to reach for one. dagre, elk
  // and this code all agree that a node with no edges has depth 0; swapping the
  // engine reproduces the same wall. The fix is to stop handing the layered
  // stage work that has no layer.
  //
  // They are still drawn — dropping a real task to flatter the picture would be
  // a lie — just in their own block underneath. See the paddock at the end.
  const inSet = new Set(tasks.map(t => t.id));
  const linked = new Set();
  for (const t of tasks)
    for (const d of (t.deps || []).filter(x => inSet.has(x))) { linked.add(t.id); linked.add(d); }
  const loose = tasks.filter(t => !linked.has(t.id));
  tasks = tasks.filter(t => linked.has(t.id));

  const depth = depthsOf(tasks);
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  const laneAt = Object.fromEntries(doc.lanes.map((l, i) => [l.id, i]));
  const seq = Object.fromEntries(doc.tasks.map((t, i) => [t.id, i]));
  const maxD = Math.max(0, ...tasks.map(t => depth[t.id]));
  const layers: Id[][] = Array.from({ length: maxD + 1 }, () => []);
  for (const t of tasks) layers[depth[t.id]].push(t.id);

  // The layered graph: real nodes, dummy nodes, and only ever one-column hops.
  const down = {}, up = {}, real = new Set(tasks.map(t => t.id)), chains = {};
  const link = (a, b) => { (down[a] ||= []).push(b); (up[b] ||= []).push(a); };
  let dn = 0;
  for (const t of tasks)
    for (const d of (t.deps || []).filter(x => byId[x])) {
      const path: Id[] = [d];
      let prev = d;
      for (let L = depth[d] + 1; L < depth[t.id]; L++) {
        const id = "~" + (dn++);
        layers[L].push(id); link(prev, id); path.push(id); prev = id;
      }
      link(prev, t.id); path.push(t.id);
      chains[d + ">" + t.id] = path;
    }

  // BAND, when asked for: a task's value in some channel, as a column-independent
  // group it may not leave. Ordering then happens inside each band. A dummy
  // inherits the band of the edge it belongs to, so a long edge travels inside
  // its own band instead of cutting across every other one.
  const bandOf = {};
  if (groupBy) {
    const vals = (doc[groupBy] || []).map(v => v.id);
    for (const t of tasks) bandOf[t.id] = Math.max(0, vals.indexOf(valsOf(t, groupBy)[0]));
    // Dummies take the band of their source, walking forward so a chain is set
    // before anything reads it.
    for (let L = 0; L <= maxD; L++)
      for (const id of layers[L])
        for (const b of down[id] || []) if (!real.has(b)) bandOf[b] = bandOf[id] ?? 0;
  }
  const band = id => (groupBy ? (bandOf[id] ?? 0) : 0);
  // Ties break the way the timeline's rows already do: team, then queue order.
  const tie = id => real.has(id) ? [laneAt[byId[id].lane] ?? 99, seq[id]] : [99, 1e9];

    const at: Record<string, number> = {};
  const reindex = () => layers.forEach(L => L.forEach((id, i) => { at[id] = i; }));
  layers.forEach(L => L.sort((a, b) =>
    band(a) - band(b) || tie(a)[0] - tie(b)[0] || tie(a)[1] - tie(b)[1]));
  reindex();

  // THE MEDIAN of a node's neighbours in the fixed column, not the mean. Both are
  // standard and the median is the better of the two in practice — a mean is
  // dragged around by one distant neighbour, which is exactly the case a long
  // chain produces. A node with no neighbours in that direction holds its place
  // rather than being swept to an end.
  const med = (id, adj) => {
    const ps = (adj[id] || []).map(x => at[x]).filter(v => v !== undefined).sort((a, b) => a - b);
    if (!ps.length) return at[id];
    const m = ps.length >> 1;
    return ps.length % 2 ? ps[m] : (ps[m - 1] + ps[m]) / 2;
  };
  // REINDEXED AFTER EVERY LAYER, not after the whole sweep. A sweep is a chain of
  // decisions — column 2 is ordered against the column 1 that was just fixed —
  // and reindexing at the end instead means every column after the first reads
  // positions that are one sweep out of date. It looks like it works, because
  // the numbers still move; they just stop going down.
  const sortLayer = (L, adj) => {
    const key = new Map(layers[L].map(id => [id, med(id, adj)]));
    layers[L].sort((a, b) => band(a) - band(b) || (key.get(a) - key.get(b))
      || tie(a)[0] - tie(b)[0] || tie(a)[1] - tie(b)[1]);
    layers[L].forEach((id, i) => { at[id] = i; });
  };
  // Crossings BETWEEN ADJACENT COLUMNS, which is what the sweeps can actually
  // move. The geometric count the view reports is the honest user-facing number;
  // this one is the objective being optimised, and they fall together.
  const cross = () => {
    let n = 0;
    for (let L = 0; L < maxD; L++) {
      const es: [number, number][] = [];
      for (const a of layers[L]) for (const b of down[a] || []) es.push([at[a], at[b]]);
      for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++)
        if ((es[i][0] - es[j][0]) * (es[i][1] - es[j][1]) < 0) n++;
    }
    return n;
  };

  // SWEEP DOWN, SWEEP UP, KEEP THE BEST — never just the last. A sweep is a
  // heuristic and is perfectly capable of making things worse; without the
  // snapshot the layout would depend on which iteration happened to be last,
  // which is the non-determinism `preset` exists to avoid.
  let best = layers.map(L => [...L]), bestN = cross();
  for (let pass = 0; pass < 16 && bestN > 0; pass++) {
    for (let L = 1; L <= maxD; L++) sortLayer(L, up);
    let n = cross();
    if (n < bestN) { bestN = n; best = layers.map(L => [...L]); }
    for (let L = maxD - 1; L >= 0; L--) sortLayer(L, down);
    n = cross();
    if (n < bestN) { bestN = n; best = layers.map(L => [...L]); }
  }
  best.forEach((L, i) => { layers[i] = L; });
  reindex();

  // ---- and then WHERE, vertically ------------------------------------------
  // Straight down the column in the order just decided, and that is the whole
  // stage. It is written here because the obvious next step is to add a real
  // coordinate-assignment pass — pull each node towards the median of its
  // neighbours so long edges come out horizontal — and I built one, measured it,
  // and deleted it. It left the crossings exactly unchanged (69 and 34 on the two
  // real plans) and made the drawing HALF AS TALL AGAIN: 14 rows to 24, and 11 to
  // 16. Straightening long edges means reserving a clear lane for each, and the
  // real work gets shoved apart to make the room.
  //
  // If that stage comes back it needs to be the proper one (Brandes-Köpf, which
  // balances rather than prioritises) and it needs to beat these numbers, which
  // are recorded in `data-graph` on every draw precisely so it can be checked.
  //
  // A DUMMY IS A GAP, NOT A ROW: it has to take vertical space or the edge it
  // stands for has nowhere to travel, and it must not take a whole one or a
  // column carrying six long edges is six rows taller than it has work in.
  /** @type {Record<string, {x:number,y:number}>} */ const pos = {};
  for (let L = 0; L <= maxD; L++) {
    let y = 0;
    for (const id of layers[L]) {
      pos[id] = { x: L * COL_GAP, y };
      y += real.has(id) ? ROW_GAP : ROW_GAP * 0.42;
    }
  }
  // THE PADDOCK — the edgeless tasks, in a block under the graph. SQUARED OFF
  // rather than laid in a row or a column: thirty-seven of them in a single line
  // is the same unreadable wall, only turned on its side. Grouped the same way
  // the columns are when a grouping is on, so scanning it reads like the rest of
  // the chart rather than like a leftovers bin.
  //
  // It sits below rather than beside because the layered part is the part with
  // structure, and structure should be the thing at the top of the viewport.
  if (loose.length) {
    let bottom = 0;
    for (const k in pos) bottom = Math.max(bottom, pos[k].y);
    bottom += ROW_GAP * 2;
    const cols = Math.max(1, Math.ceil(Math.sqrt(loose.length)));
    const vals = groupBy ? (doc[groupBy] || []).map(v => v.id) : null;
    const rank = t => vals ? Math.max(0, vals.indexOf(valsOf(t, groupBy)[0])) : 0;
    loose.sort((a, b) => rank(a) - rank(b)
      || (laneAt[a.lane] ?? 99) - (laneAt[b.lane] ?? 99) || seq[a.id] - seq[b.id]);
    loose.forEach((t, i) => {
      pos[t.id] = { x: (i % cols) * COL_GAP, y: bottom + Math.floor(i / cols) * ROW_GAP };
    });
  }
  return { pos, chains };
}

// The nodes and edges themselves. Everything visual is read through the same
// functions the timeline uses, so a plan cannot look like two different plans.
// HOW FAR FROM ACTIONABLE, in three steps rather than the two the `ready` chip
// carries. The chip answers "can I start this"; on the graph the useful question
// is the one the picture is already showing — how deep behind a gate a thing
// sits — so "blocked by work that is itself ready" and "blocked by a chain" get
// different weight. A task whose blockers are all moving is nearly yours; one
// four layers back is not worth reading today.
//
// FINISHED COUNTS AS CLEARED, which is the same rule `sched` uses. Two
// definitions of "this no longer holds anything up" would eventually disagree.
function tierOf(t, by) {
  if (t.actualEnd != null) return "done";
  if (t.actualStart != null) return "doing";
  const cleared = (d) => {
    const x = by[d];
    return !x || x.actualEnd != null;
  };
  const blockers = (t.deps || []).filter(d => !cleared(d));
  if (!blockers.length) return "ready";
  return blockers.every(d => {
    const x = by[d];
    return x && (x.actualStart != null || !(x.deps || []).some(dd => !cleared(dd)));
  }) ? "next" : "deep";
}

function graphElements(tasks, groupBy) {
  const { pos, chains } = layoutOf(tasks, groupBy);
  const shown = new Set(tasks.map(t => t.id));
  // Over the WHOLE document, not the filtered list: a task's blocker may be
  // filtered off screen, and a hidden blocker still blocks.
  const byAll = Object.fromEntries(doc.tasks.map(t => [t.id, t]));
  // A HAND-PLACED NODE WINS OVER THE COMPUTED ONE. `layoutOf` still runs for
  // everything — a task added after somebody arranged the graph has to land
  // somewhere sensible rather than at the origin — and this overrides only the
  // nodes actually dragged. "Arrange" clears the whole map and hands the picture
  // back to the layout.
  const placed = (doc && doc.graphPos) || {};
  const nodes = tasks.map(t => ({
    data: {
      id: t.id,
      label: t.label || t.id,
      // The same hue the bar wears, through the same function — a second colour
      // table would be a second thing to keep in step.
      fill: colorOf(colorsOf(t)[0]),
      // Status is derived from the two dates here as everywhere else.
      state: t.actualStart == null ? "todo" : t.actualEnd == null ? "doing" : "done",
      tier: tierOf(t, byAll),
      dim: isFiltering() && !matchesFilter(t) ? 1 : 0,
    },
    // A COPY, because cytoscape writes `x`/`y` back onto whatever object it is
    // handed as a node moves — and `placed[t.id]` is an object INSIDE the
    // document. Passing it directly let the renderer mutate the doc outside a
    // command, which the ADR 0001 guard catches and reports on every drag.
    position: placed[t.id] ? { ...placed[t.id] } : (pos[t.id] || { x: 0, y: 0 }),
  }));
  // A BEND IS A NODE WITH NOTHING TO SAY. Invisible, unclickable, and present only
  // so the edge through it has somewhere to be. `events: no` matters: a stray
  // 1px target between two real nodes would swallow clicks aimed at neither.
  const bends: any[] = [], edges: any[] = [];
  for (const t of tasks)
    for (const d of (t.deps || []).filter(x => shown.has(x))) {
      const key = d + ">" + t.id;
      // A HAND-PLACED ENDPOINT VOIDS THE ROUTING. The bend path is a statement
      // about the COMPUTED layout — "this edge crosses column 2, so give it
      // somewhere to bend" — and dragging either end makes that statement
      // false. The bends stay where the layout put them, so the edge leaves the
      // node you just moved, doubles back to where the router still thinks it
      // is, and then turns for the target: a dogleg pointing at nothing.
      //
      // Straight is the honest line between two positions somebody chose. It
      // may cross another edge, which is a price worth paying for an arrow that
      // goes where it looks like it goes.
      const path = (placed[d] || placed[t.id]) ? [d, t.id] : (chains[key] || [d, t.id]);
      for (let k = 1; k < path.length - 1; k++)
        bends.push({ data: { id: path[k], bend: 1 }, position: pos[path[k]], classes: "bend" });
      for (let k = 0; k < path.length - 1; k++)
        edges.push({ data: {
          id: key + "#" + k, source: path[k], target: path[k + 1],
          // The LOGICAL edge, carried on every segment: highlighting asks about a
          // dependency, and a dependency may now be four elements on screen.
          edge: key, last: k === path.length - 2 ? 1 : 0 } });
    }
  return { nodes: [...nodes, ...bends], edges };
}

// HOW TANGLED IS IT, ACTUALLY. "This looks like chaos" is a real complaint and a
// useless brief, so the layout gets a number: how many pairs of drawn edges cross
// each other on screen. Geometric rather than the usual adjacent-layer inversion
// count, because what makes a picture unreadable is the crossings you can SEE,
// including the ones made by an edge that skips four columns.
//
// O(E²) and unapologetic: sixty-five edges is two thousand pairs, and this runs
// once per layout rather than per frame.
function countCrossings(edges, pos) {
  const seg = edges.map(e => [pos[e.data.source], pos[e.data.target], e.data.source, e.data.target]);
  const side = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  let n = 0;
  for (let i = 0; i < seg.length; i++) for (let j = i + 1; j < seg.length; j++) {
    const [p1, p2, s1, t1] = seg[i], [p3, p4, s2, t2] = seg[j];
    if (!p1 || !p2 || !p3 || !p4) continue;
    // Edges that meet at a node are not a crossing, they are a fan.
    if (s1 === s2 || s1 === t2 || t1 === s2 || t1 === t2) continue;
    if (side(p1, p2, p3) * side(p1, p2, p4) < 0 && side(p3, p4, p1) * side(p3, p4, p2) < 0) n++;
  }
  return n;
}

// The edge colours are the timeline's own, read through `arrowStyle`, so a plan
// carrying its own convention carries it into both views: blue is upstream,
// green is downstream, and everything unrelated stays out of the way.
function graphStyle() {
  const up = arrowStyle("direct").color, down = arrowStyle("down").color;
  return [
    { selector: "node", style: {
        "background-color": "data(fill)", "label": "data(label)",
        "color": "#e6edf3", "font-size": "11px",
        "text-valign": "center", "text-halign": "center", "text-wrap": "wrap",
        "text-max-width": "132px", "text-outline-width": 2, "text-outline-color": "#0d1117",
        "shape": "round-rectangle", "width": 150, "height": 42,
        "border-width": 2, "border-color": "#30363d" } },
    // DONE-NESS IS TYPOGRAPHY HERE TOO, for the reason it is on the row label:
    // every other channel already means something.
    { selector: 'node[state = "done"]', style: { "text-decoration": "line-through", "opacity": 0.6 } },
    { selector: 'node[state = "doing"]', style: { "border-color": "#e6edf3", "border-width": 3 } },
    // READINESS IS THE RIM, and it is the one channel the graph had spare. Hue
    // is still the project, typography is still done-ness, opacity is still the
    // filter — so "how far from actionable" gets the border, which on a node is
    // the equivalent of the bar's rim on the timeline.
    //
    // Only `ready` is loud. The point of the view is to find what can be picked
    // up, and a palette that shouted equally at all three tiers would be a
    // picture with no answer in it. `deep` recedes instead.
    { selector: 'node[tier = "ready"]', style: { "border-color": "#3fb950", "border-width": 3 } },
    { selector: 'node[tier = "next"]', style: { "border-color": "#9e6a03" } },
    { selector: 'node[tier = "deep"]', style: { "border-color": "#30363d", "opacity": 0.75 } },
    { selector: "node[dim = 1]", style: { "opacity": 0.15 } },
    { selector: "node.sel", style: { "border-color": "#58a6ff", "border-width": 4 } },
    { selector: "node.bend", style: {
        "width": 1, "height": 1, "opacity": 0, "background-opacity": 0,
        "label": "", "events": "no" } },
    { selector: "edge", style: {
        "width": 1.5, "line-color": "#30363d", "target-arrow-color": "#30363d",
        "target-arrow-shape": "none", "curve-style": "bezier", "arrow-scale": 0.9 } },
    // The arrow goes on the LAST segment only — one dependency, one arrowhead,
    // however many columns it had to cross to get there.
    { selector: "edge[last = 1]", style: { "target-arrow-shape": "triangle" } },
    { selector: "edge.up", style: { "line-color": up, "target-arrow-color": up, "width": 2.5, "z-index": 10 } },
    { selector: "edge.down", style: { "line-color": down, "target-arrow-color": down, "width": 2.5, "z-index": 10 } },
  ];
}

function drawGraph() {
  const host = $("#cy");
  if (!host) return;
  if (cyFailed) {
    mountGraphUnavailable(host);
    return;
  }
  if (!cyLib) return;
  const chain = chainMembers();
  // THE SAME LENS AS THE TIMELINE — which this comment already claimed and the
  // code did not do. It read the chain focus and ignored the legend entirely, so
  // `isolate` dropped rows on the chart and did nothing whatever on the
  // graph: the one view where 100 nodes actually needs cutting down was the one
  // view that would not cut down. Same predicate as render()'s `visible` now,
  // expressed against the same two helpers, so the two views cannot drift into
  // disagreeing about what is on screen.
  //
  // This cannot orphan an arrow: `graphElements` already drops any edge whose
  // source is not in `shown`, because a filtered-out blocker was always possible
  // through the chain lens. Isolating by legend is the same case arriving by a
  // different door.
  const tasks = doc.tasks.filter(t => drawn(t)
    && (focusMode !== "isolate"
        || ((!chain || chain.has(t.id)) && (!isFiltering() || matchesFilter(t)))));
  const els = graphElements(tasks, GRAPH_GROUP);
  // PAN AND ZOOM SURVIVE A REBUILD, the way render() preserves scrollLeft. Every
  // legend tick rebuilds this, and a lens that reframed itself on each one would
  // lose you the thing you were looking at — the same argument the zoom handler
  // makes about the centre of the view.
  const keep = cy ? { pan: cy.pan(), zoom: cy.zoom() } : null;
  // The gesture holds listeners and a ghost node of its own; destroying the
  // graph without it leaks one per repaint, and this repaints on every legend
  // tick.
  if (cyEh) { try { cyEh.destroy(); } catch { /* already gone with the graph */ } cyEh = null; }
  if (cy) { cy.destroy(); cy = null; }
  cy = cyLib({
    container: host,
    elements: [...els.nodes, ...els.edges],
    style: graphStyle(),
    layout: { name: "preset" },
    wheelSensitivity: 0.2,
    boxSelectionEnabled: false,
    autounselectify: true,
  });
  // A NODE IS A ROW. Clicking it does what clicking a bar does, so the inspector
  // is the same inspector and every edit reaches the same document.
  cy.on("tap", "node", ev => pick(ev.target.id()));
  cy.on("tap", ev => { if (ev.target === cy && !linking) { sel = null; render(); } });
  // ON `dragfree`, NOT ON `drag`. The drag event fires per frame, and a command
  // per frame would be a hundred document writes and a hundred broadcasts to
  // draw one node three inches to the left.
  //
  // The WHOLE map every time rather than one entry, because `patchDoc` is a
  // shallow merge on doc keys: sending `{ graphPos: { [id]: p } }` would replace
  // the map with a single node's position and throw away every other placement.
  cy.on("dragfree", "node", ev => {
    const n = ev.target;
    if (n.data("bend")) return;
    const p = n.position();
    emit({ type: "patchDoc", patch: { graphPos: {
      ...((doc && doc.graphPos) || {}),
      [n.id()]: { x: Math.round(p.x), y: Math.round(p.y) },
    } } });
  });
  // DRAG A HANDLE FROM ONE NODE TO ANOTHER TO SAY "THIS WAITS FOR THAT". The
  // header above calls this lens read-only, and that was true until the plan
  // became the place a whole task list lives: the question you ask a dependency
  // graph is "what is in the way", and the answer is very often "nothing yet,
  // because I have not drawn it". Clicking link-then-two-nodes already worked
  // here; this is the gesture the picture invites.
  //
  // DIRECTION MATCHES THE ARROW. An edge is drawn from the thing waited ON to
  // the thing waiting, which is how `graphElements` builds every other edge, so
  // dragging source→target reads the same way round as the arrowheads already
  // on screen.
  //
  // Bends are not endpoints — they are 1px invisible nodes that exist so an edge
  // has somewhere to bend, and letting one be a source would offer a dependency
  // on a drawing artefact.
  if (cy.edgehandles) {
    cyEh = cy.edgehandles({
      // SNAP OFF, AND DRAW MODE OFF UNTIL ASKED. With snapping on, the gesture
      // arms itself whenever the pointer is over a node — which is exactly
      // where you press to MOVE one, so dragging a node drew an edge instead of
      // moving it and a hand-arranged graph was impossible to make.
      //
      // Edge-drawing now lives behind "Link dependency", the affordance that
      // already means "I am about to say what waits on what" for the
      // click-link-click gesture. One mode, two ways to finish it, and plain
      // drag is unambiguously "move this node".
      snap: false,
      hoverDelay: 120,
      // NOT `taskById`, WHICH SHOUTS. Edgehandles asks this about its own
      // temporary handle node as well as about real ones, and `taskById` logs
      // "an id outlived its task" for anything it cannot find — so hovering
      // filled the console with errors about a node the gesture invented.
      // A plain lookup answers the actual question: are both ends tasks?
      canConnect: (src, tgt) => {
        const a = doc.tasks.find(t => t.id === src.id());
        const b = doc.tasks.find(t => t.id === tgt.id());
        return !!a && !!b && a.id !== b.id && !(b.deps || []).includes(a.id);
      },
      // The preview edge only — the real one arrives from the server like every
      // other edit, so it is removed on completion either way.
      edgeParams: () => ({ data: { ghost: 1 } }),
    });
    cyEh.disableDrawMode();
    if (linking) cyEh.enableDrawMode();
    cy.on("ehcomplete", (_ev, src, tgt, added) => {
      added.remove();
      // Finishing the gesture ends the mode, the way clicking the second task
      // does — `linking` is a one-shot intent in both directions, so leaving
      // draw mode armed would turn the next drag into another dependency.
      if (linkTasks(tgt.id(), src.id())) { linking = null; render(); }
    });
  }
  if (keep) { cy.zoom(keep.zoom); cy.pan(keep.pan); }
  else cy.fit(undefined, 40);
  paintGraphSelection();
  // Counted as the PLAN sees them — real tasks and real dependencies — not as the
  // renderer does. A dependency crossing four columns is four elements on screen
  // and one fact in the document, and the number a reader is checking is the fact.
  const n = els.nodes.filter(x => !x.data.bend).length;
  const e = new Set(els.edges.map((x: any) => x.data.edge)).size;
  // THE TANGLE IS ON THE LABEL, next to the counts. Whether banding helps depends
  // entirely on the plan — grouping this one by application came out a quarter
  // shorter for the same crossings, and grouping it by team more than tripled
  // them, because work flows ACROSS teams and banding by team fights the
  // structure. A control whose effect you cannot see is a control you cannot use,
  // and this tool already puts `count·weeks` on every legend value.
  const x = countCrossings(els.edges, Object.fromEntries(cy.nodes().map(q => [q.id(), { ...q.position() }])));
  $("#ghint").textContent = (chain
    ? n + " of " + doc.tasks.length + " tasks — the chain around “" + name(chainFocus) + "”"
    : n + " task" + (n === 1 ? "" : "s") + ", " + e + " dependenc" + (e === 1 ? "y" : "ies"))
    + " · " + x + " crossing" + (x === 1 ? "" : "s");
  // THE VIEW SAYS WHAT IT DREW, because a canvas cannot be asked. Every other
  // surface in this tool is DOM and can be interrogated directly — a bar has a
  // class, a chip has a data attribute — and cytoscape paints pixels, so a
  // verification run has nothing to hold on to and nothing to fail on. This is
  // not a hook for the tests: it is the view stating its own result, in the same
  // spirit as the `count·weeks` on every legend value, and it is what the
  // walkthrough and any future debugging read too.
  host.dataset.graph = JSON.stringify({
    n, e, sel: sel && els.nodes.some(x => x.data.id === sel) ? sel : null,
    dim: els.nodes.filter(x => x.data.dim).length,
    done: els.nodes.filter(x => x.data.state === "done").length,
    doing: els.nodes.filter(x => x.data.state === "doing").length,
    // The readiness tiers, for the same reason every other number here is
    // reported: the rim colour that carries them is a pixel, and a pixel cannot
    // be asserted on.
    tiers: ["ready", "next", "deep"].reduce((a: any, k) => {
      const c = els.nodes.filter(x => x.data.tier === k).length;
      if (c) a[k] = c;
      return a;
    }, {}),
    bends: els.nodes.filter(x => x.data.bend).length,
    // How tall the picture is, in rows. A layout can trade crossings for a page
    // of white space and call it an improvement, so both numbers are reported.
    rows: Math.round((Math.max(...els.nodes.map(x => x.position.y))
                    - Math.min(...els.nodes.map(x => x.position.y))) / ROW_GAP),
    chain: !!chain, cols: 1 + Math.max(0, ...els.nodes.map(x => Math.round(x.position.x / COL_GAP))),
    cross: x,
    // WHERE ONE NODE IS ON SCREEN, in container pixels after pan and zoom. The
    // same argument as every other number here — a canvas cannot be asked where
    // it drew something — with one extra caller: the drag gesture can only be
    // tested by a real drag, and a real drag needs a coordinate. Hard-coding one
    // in the test asserts the layout instead of the gesture, and breaks the day
    // a fixture gains a task.
    // TWO OF THEM, not one: the drag that MOVES a node needs a start point, and
    // the drag that LINKS two needs a start and an end. Rendered pixels, after
    // pan and zoom, so a caller can aim at them directly.
    grab: (() => {
      const ns = cy.nodes().filter((q: any) => !q.data("bend"));
      return ns.slice(0, 2).map((n: any) => {
        const r = n.renderedPosition();
        return { id: n.id(), x: Math.round(r.x), y: Math.round(r.y) };
      });
    })(),
  });
}

// Selection is repainted rather than rebuilt, for the reason `drawArrows` is
// separate from `render()`: it runs on every click, and a rebuild would re-lay-out
// the whole graph to move one border.
function paintGraphSelection() {
  if (!cy) return;
  cy.batch(() => {
    cy.nodes().removeClass("sel");
    cy.edges().removeClass("up down");
    if (!sel || !cy.getElementById(sel).length) return;
    cy.getElementById(sel).addClass("sel");
    // Both directions, and UNBOUNDED rather than depth-limited. This lens IS
    // "show me the whole chain", asked once and on purpose, which is exactly the
    // carve-out the arrow depth budgets already name for themselves.
    const up = ancestorsOf(sel), down = descendantsOf(sel);
    // Read off the LOGICAL edge, not the segment: a long dependency is several
    // elements now and all of them have to light up together.
    cy.edges().forEach(ed => {
      const [s_, t_] = (ed.data("edge") || "").split(">");
      if (t_ === sel || (up.has(t_) && (up.has(s_) || s_ === sel))) ed.addClass("up");
      else if (s_ === sel || (down.has(s_) && (down.has(t_) || t_ === sel))) ed.addClass("down");
    });
  });
}

// Switching is a VIEW change, so it lives in the hash beside the zoom, the
// isolate lens and the fold states — a link to the graph should reopen as the
// graph. It never touches the document.
// THREE MODES, TWO RENDERERS. `relative` is the timeline with the calendar taken
// out, so it shares every branch below with `timeline` and differs only in what
// the axis says. Only `graph` swaps the renderer.
// SWITCHING RE-ANCHORS THE SCROLL, because 106 rows have just been reshuffled
// and the raw offset now points at something unrelated. A selected task means
// you are mid-thought about that task and it should still be in front of you;
// nothing selected means you are reading the plan, and the plan starts at the
// top.
const ROW_MODES = ["team", "date"];
function setRowMode(mode) {
  ROWMODE = ROW_MODES.includes(mode) ? mode : "team";
  $f("#rowmode").value = ROWMODE;
  render();
  // render() repaints the CHIP but not the open panel behind it, so switching
  // with the reorder panel up left a live "Sort teams" button in the one view
  // that has no team blocks to sort — the exact stale advice this mode was
  // supposed to stop offering.
  reorderPanel();
  const el = sel && POS[sel] && POS[sel].el;
  if (el) el.scrollIntoView({ block: "center" });
  else $("#chart").scrollTop = 0;
}

// ---- calendar lens ----------------------------------------------------------
// WHAT IS ON MY DAY, OR MY WEEK: the three kinds of time a task has, on a
// wall-clock grid in the plan's zone. Sessions are what happened (solid),
// planned stretches what is promised (tinted, bordered), and the forecast is
// where the scheduler expects the rest of the work to go — the same
// `workChunks` the timeline draws as `wseg fc`, grey with a stripe of the
// project colour so colour means "this is real" and grey "the scheduler's guess".
//
// READ-ONLY. A click picks the task like a bar or a card does; every edit stays
// in the Inspector. Filters act as on the board (dim fades, isolate removes),
// and the Done toggle gates finished tasks as on the timeline (`drawn`).
// Colour bands and the fill pattern are drawn; border and shape are not, because
// a block's outline already says which kind of time it is.
type CalKind = "session" | "planned" | "computed";
type CalPiece = { t: any; kind: CalKind; a: number; b: number; col?: number; ncol?: number };
const CAL_ZOOMS = [24, 16, 12, 8, 4];               // hours that fill the window
let calSpan: "day" | "week" = stored("calspan") === "day" ? "day" : "week";
let calHours = +stored("calhours") || 16;
let calAnchor: number | null = null;                 // a day in the span shown; null follows today
let calShown = "";                                   // the days last drawn, to keep the scroll across redraws
const calDays = () => {
  const at = calAnchor ?? Math.floor(nowD());
  if (calSpan === "day") return [at];
  const dow = new Date(+d0() + at * DAY).getUTCDay();
  const first = at - ((dow - (doc.weekStart ?? 0) + 7) % 7);
  return Array.from({ length: 7 }, (_, i) => first + i);
};
/** Every piece of time a task has, in day numbers. */
function calPieces(t): CalPiece[] {
  const out: CalPiece[] = [], now = nowD();
  for (const s of t.sessions || []) out.push({ t, kind: "session", a: dayNum(s.start), b: s.stop == null ? now : dayNum(s.stop) });
  if (!t.done) for (const p of t.planned || []) out.push({ t, kind: "planned", a: p.start, b: p.stop });
  // The forecast, as the timeline's bar computes it — unless the task is held at its planned stretches.
  const pl = plannedOf(t);
  if (t.actualEnd == null && st[t.id] != null && !(pl && Math.abs(st[t.id] - pl[0]!.start) < 1e-9)) {
    const a0 = st[t.id] + shiftOf(t), b0 = a0 + spanOf(t, st[t.id]), f0 = Math.max(a0, now);
    if (f0 < b0) for (const [a, b] of workChunks(f0, b0, CAL, t.id)) out.push({ t, kind: "computed", a, b });
  }
  return out;
}
// Google's layout: a run of transitively overlapping pieces shares the width in columns.
function calColumns(ps: CalPiece[], minLen: number) {
  ps.sort((p, q) => p.a - q.a || q.b - p.b);
  let run: CalPiece[] = [], ends: number[] = [], runEnd = -Infinity;
  const flush = () => { for (const p of run) p.ncol = ends.length; run = []; ends = []; };
  for (const p of ps) {
    const b = Math.max(p.b, p.a + minLen);           // what it occupies on screen, not in time
    if (p.a >= runEnd) flush();
    let c = ends.findIndex(e => e <= p.a + 1e-9);
    if (c < 0) { c = ends.length; ends.push(0); }
    ends[c] = b; p.col = c; run.push(p); runEnd = Math.max(runEnd, b);
  }
  flush();
}
function drawCal() {
  const host = $("#cal"), head = $("#calhead"), body = $("#calbody");
  const days = calDays(), now = nowD(), pxh = Math.max(body.clientHeight, 240) / calHours;
  const chain = chainMembers();
  const MIN = 15 / 1440, TICK = 1 / 1440;            // a block is at least 15 minutes tall; under a minute is a tick
  const el = (tag: string, cls = "", text = "") => {
    const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
  };
  const dayLabel = (d: number) => new Date(+d0() + d * DAY).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  $("#caltitle").textContent = days.length === 1 ? dayLabel(days[0]!) : `${dayLabel(days[0]!)} – ${dayLabel(days[6]!)}`;
  // Each piece cut at midnight into the days it touches.
  const perDay = new Map<number, CalPiece[]>(days.map(d => [d, []]));
  for (const t of doc.tasks) {
    if (!drawn(t)) continue;
    const match = (!chain || chain.has(t.id)) && (!isFiltering() || matchesFilter(t));
    if (!match && focusMode === "isolate") continue;
    for (const p of calPieces(t)) for (let d = Math.floor(p.a + 1e-9); d < p.b - 1e-9 || d === Math.floor(p.a + 1e-9); d++)
      perDay.get(d)?.push({ ...p, a: Math.max(p.a, d), b: Math.min(p.b, d + 1) });
  }
  head.replaceChildren(el("div", "calgut"), ...days.map(d => {
    const h = el("div", "caldh" + (d === Math.floor(now) ? " today" : ""), dayLabel(d));
    h.onclick = () => { calAnchor = d; setCalSpan("day"); };
    h.title = "Show this day";
    return h;
  }));
  const hours = el("div", "calgut");
  for (let h = 1; h < 24; h++) { const l = el("div", "calhl", clockStr(h * 60)); l.style.top = h * pxh + "px"; hours.append(l); }
  const cols = days.map(d => {
    const col = el("div", "calday");
    col.style.setProperty("--pxh", pxh + "px");
    const shade = (a: number, b: number) => { if (b > a) { const s = el("div", "caloff"); s.style.top = a * 24 * pxh + "px"; s.style.height = (b - a) * 24 * pxh + "px"; col.append(s); } };
    let pos = 0;
    for (const [wa, wb] of CAL.win(d)) { shade(pos, wa); pos = wb; }
    shade(pos, 1);
    if (d === Math.floor(now)) { const n = el("div", "calnow"); n.style.top = (now - d) * 24 * pxh + "px"; n.title = "Now"; col.append(n); }
    const ps = perDay.get(d)!;
    calColumns(ps, MIN);
    for (const p of ps) {
      const t = p.t, tick = p.b - p.a < TICK, cs = colorsOf(t);
      const match = (!chain || chain.has(t.id)) && (!isFiltering() || matchesFilter(t));
      const e = el("div", `calev ${p.kind} pat-${fillDef(t.fill).pattern || "solid"}` + (tick ? " tick" : "")
        + (sel === t.id ? " sel" : "") + (match ? "" : " dim"));
      e.style.setProperty("--c", String(colorOf(cs[0])));
      e.style.top = (p.a - d) * 24 * pxh + 1 + "px";
      e.style.height = tick ? "3px" : Math.max((p.b - p.a) * 24 * pxh, 15 / 60 * pxh) - 2 + "px";
      e.style.left = `calc(${(p.col! / p.ncol!) * 100}% + 2px)`;
      e.style.width = `calc(${100 / p.ncol!}% - 4px)`;
      e.title = `${t.label || t.id}\n${{ session: "Worked", planned: "Promised", computed: "Forecast" }[p.kind]} ${clkOn(p.a, d)}–${clkOn(p.b, d)}`;
      e.dataset.id = t.id;
      e.onclick = () => pick(t.id);
      // Every colour, as the timeline's bands: across the block, or down the stripe of a forecast.
      if (p.kind === "computed") {
        const s = el("div", "stripe");
        s.style.background = cs.length > 1 ? `linear-gradient(${cs.map((c, i) => `${colorOf(c)} ${i / cs.length * 100}% ${(i + 1) / cs.length * 100}%`).join(",")})` : "var(--c)";
        e.append(s);
      } else for (let k = 1; k < cs.length; k++) {
        const b = el("div", "band " + `pat-${fillDef(t.fill).pattern || "solid"}`);
        b.style.left = k / cs.length * 100 + "%"; b.style.right = "0"; b.style.background = String(colorOf(cs[k]));
        e.append(b);
      }
      if (!tick && (p.b - p.a) * 24 * pxh >= 14) e.append(el("span", "", t.label || t.id));
      col.append(e);
    }
    return col;
  });
  const grid = el("div", "calgrid");
  grid.style.height = 24 * pxh + "px";
  grid.append(hours, ...cols);
  // KEEP THE SCROLL across redraws (every inbound command lands here); a new set of days
  // opens an hour before now on today, at the start of the working day otherwise.
  const opens = Math.min(...days.map(d => CAL.win(d)[0]?.[0] ?? 0));   // the earliest window opening among the shown days
  const key = days.join(",") + "|" + calHours, keep = key === calShown ? body.scrollTop : null;
  calShown = key;
  body.replaceChildren(grid);
  body.scrollTop = keep ?? (days.includes(Math.floor(now)) ? Math.max(0, (now % 1) * 24 - 1) : opens * 24) * pxh;
  host.classList.toggle("day", days.length === 1);
}
function setCalSpan(span: "day" | "week") {
  calSpan = span; remember("calspan", span);
  $f("#calspan").value = span;
  calShown = ""; drawCal();
}
function calStep(n: number) {
  calAnchor = (calAnchor ?? Math.floor(nowD())) + n * (calSpan === "day" ? 1 : 7);
  calShown = ""; drawCal();
}
/** F: bring the selected task's next piece into view (its last one if all are past), else today. */
function calFit() {
  const t = sel != null ? doc.tasks.find(x => x.id === sel) : null;
  const ps = t ? calPieces(t).sort((p, q) => p.a - q.a) : [];
  const p = ps.find(x => x.b >= nowD()) ?? ps.at(-1);
  calAnchor = p ? Math.floor(p.a + 1e-9) : null;
  calShown = ""; drawCal();
  if (p) $("#calbody").scrollTop = Math.max(0, (p.a % 1) * 24 - 1) * ($("#calbody").clientHeight / calHours);
}
function setCalHours(h: number, anchorY?: number) {
  const body = $("#calbody"), y = anchorY ?? body.clientHeight / 2;
  const at = (body.scrollTop + y) / (body.clientHeight / calHours);   // the hour under the pointer
  calHours = Math.min(24, Math.max(2, h)); remember("calhours", String(calHours));
  drawCal();
  body.scrollTop = at * (body.clientHeight / calHours) - y;
  syncZoomPicker();
}
$("#calspan").onchange = e => setCalSpan(fieldOf(e).value === "day" ? "day" : "week");
$("#calprev").onclick = () => calStep(-1);
$("#calnext").onclick = () => calStep(1);
$("#caltoday").onclick = () => { calAnchor = null; calShown = ""; drawCal(); };
// PINCH, as on the timeline: a trackpad pinch is ctrl+wheel, and so is a mouse zoom.
let calWheel = 0;
$("#calbody").addEventListener("wheel", e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const y = e.clientY - $("#calbody").getBoundingClientRect().top;
  calWheel = calWheel || calHours;
  calWheel = Math.min(24, Math.max(2, calWheel * Math.exp(e.deltaY * 0.01)));
  requestAnimationFrame(() => { if (calWheel) { setCalHours(calWheel, y); calWheel = 0; } });
}, { passive: false });
addEventListener("resize", () => { if (VIEW_MODE === "calendar") drawCal(); });

const VIEW_MODES = ["timeline", "relative", "graph", "board", "calendar"];
// WHICH LENS YOU WERE LAST LOOKING THROUGH, per plan and per browser.
//
// View state, so localStorage rather than the document — the same side of that
// line as the zoom and the fold, and the opposite side from `graphPos`, which
// is an arrangement somebody built rather than a preference.
//
// PER PLAN, because the answer is not a habit: a delivery schedule is a
// timeline and a personal task list is mostly the graph, and one global setting
// would have each plan opening in the other one's lens. Keyed off the plan id
// for the same reason the keyring is.
const viewKey = () => "view:" + (sockPlanId || "");
async function setView(mode) {
  VIEW_MODE = VIEW_MODES.includes(mode) ? mode : "timeline";
  remember(viewKey(), VIEW_MODE);
  $f("#view").value = VIEW_MODE;
  // ROWS AND A DAY AXIS ARE THE TIMELINE'S; the graph and the board have neither.
  const noAxis = VIEW_MODE === "graph" || VIEW_MODE === "board" || VIEW_MODE === "calendar";
  $("#chart").hidden = noAxis;
  $("#graph").hidden = VIEW_MODE !== "graph";
  $("#board").hidden = VIEW_MODE !== "board";
  $("#cal").hidden = VIEW_MODE !== "calendar";
  calShown = "";   // a hidden scroller forgets its offset, so re-open at now
  $("#calspanwrap").hidden = VIEW_MODE !== "calendar";
  // The calendar zooms too, in hours rather than days (see syncZoomPicker).
  $("#zoomwrap").hidden = noAxis && VIEW_MODE !== "calendar";
  $("#tfit").hidden = noAxis;
  $("#navtoggle").hidden = noAxis;
  // The pad follows the mode, but never re-opens itself: leaving graph view
  // should not unfold a cluster you had put away.
  if (noAxis) $("#navpad").hidden = true;
  $("#rowmodewrap").hidden = noAxis;
  if (VIEW_MODE === "graph") { await ensureCy(); drawGraph(); }
  else {
    if (cy) { cy.destroy(); cy = null; }
    // TIMELINE AND RELATIVE SHARE A RENDERER, so swapping between them changes
    // nothing until it runs again. The graph path repainted implicitly by
    // building a whole new canvas; this one has to ask.
    render();
  }
}

// ---- kanban lens ------------------------------------------------------------
// COLUMNS COME FROM `boardColumns`, which is `readiness()` sorted — so a card
// sits where /api/ready says it does and the page cannot hold a second opinion.
// Filters behave as on the graph: dim fades, isolate removes. `showDone` is not
// consulted; the Done column's own look-back (`doneWin`, a view setting) is its filter.
//
// DRAGGING A CARD IS THE ONLY WRITE, and each drop is a real session event stamped
// with the current instant — the same commands as the Inspector's start, stop,
// finish and reopen, which are also the keyboard route to them. ADR 0009 says why
// this lens may write when the graph may not; ADR 0016 what each drop writes.
// WHEN, IN ABSOLUTES: "2:32pm" today, "Sep 24 2:32pm" any other day, on the
// plan zone's clock like the rest of the chart. It had a date-only branch for
// whole-day values; v6 retired those, so every time has a clock.
const whenStr = (d: number) => {
  const day = Math.floor(d + 1e-9);
  const clock = clockStr(Math.min(1439, Math.round((d - day) * 1440)));
  return day === todayD() ? clock : `${fmt(day)} ${clock}`;
};
// WHERE A FINISHED TASK SITS IN THE DONE COLUMN, as the divider above it says it:
// near days by name, older ones by week, then by month. Counted in the plan's
// days (`todayD`), like everything else on the board. Near buckets name the day,
// so a card under one only needs its time; far ones need the date.
const doneBucket = (end: number) => {
  const day = Math.floor(end + 1e-9), ago = todayD() - day;
  const at = new Date(+d0() + day * DAY);
  if (ago <= 0) return { label: "Today", near: true };
  if (ago === 1) return { label: "Yesterday", near: true };
  if (ago <= 6) return { label: "Last " + at.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }), near: true };
  if (ago <= 13) return { label: "Last week", near: false };
  if (ago <= 20) return { label: "Two weeks ago", near: false };
  const thisYear = new Date(+d0() + todayD() * DAY).getUTCFullYear() === at.getUTCFullYear();
  return { label: at.toLocaleDateString("en-US", { month: "long", ...(thisYear ? {} : { year: "numeric" }), timeZone: "UTC" }), near: false };
};
// THREE COLUMNS, BECAUSE THERE ARE THREE STATES YOU CAN SET. Why a task is not
// started yet is the scheduler's opinion, so Not started is one drop target,
// grouped under the Ready filter's own chips — "Blocked" means what it means
// there (waiting on a dependency), and a task merely in its lane's queue says
// "Queued" rather than posing as blocked.
const BOARD_COLS = [["todo", "Not started"], ["doing", "In progress"], ["done", "Done"]] as const;
type BoardCol = typeof BOARD_COLS[number][0];
// WHERE A CARD IS, finer than its column: In progress is two groups, and a drop between them is a stop or a start.
type BoardSpot = "todo" | "running" | "paused" | "done";
const IN_PROGRESS = [["running", "Running now"], ["paused", "Paused"]] as const;
let boardDrag: { id: Id; from: BoardSpot } | null = null;
let doneWin = 7;   // the Done column's look-back, per viewer, not saved
function drawBoard() {
  const host = $("#board");
  // The RAW document: `readiness()` structuredClones it, and a Proxy refuses. See rawDoc().
  const cols = boardColumns(rawDoc(), doneWin);
  const byId = Object.fromEntries(doc.tasks.map(t => [t.id, t]));
  const chain = chainMembers();
  // WHAT A DROP WRITES, as session events stamped at drop time (a board left open overnight must not stamp
  // yesterday). There is no way back to Not started: a task that has a session keeps it (split it to start over).
  //   → Running now   starts a session (reopening first, from Done)
  //   → Paused        stops the running one; from Not started, a session of no length; from Done, reopens
  //   → Done          finishes: stops the running session, or writes one of no length for work never started
  // REORDERING INSIDE NOT STARTED: a card dropped on another card goes directly
  // above or below it IN ITS TEAM'S QUEUE — one `moveTaskInLane`, the same
  // command the Inspector's arrows send. Refused (no drop cursor) across teams,
  // because each team is its own queue. Allowed under Auto-order: the server
  // re-settles after it, and keeps the order unless it makes the plan worse.
  // `moveTaskInLane` removes the task and reinserts it at `toIndex` among the
  // rest of its lane, so "above T" is T's index in that rest.
  const canReorder = (dId: Id, tId: Id) => dId !== tId && byId[dId]?.lane === byId[tId]?.lane;
  const reorder = (dId: Id, tId: Id, above: boolean) => {
    const rest = doc.tasks.filter(x => x.lane === byId[dId].lane && x.id !== dId).map(x => x.id);
    const at = rest.indexOf(tId);
    if (at >= 0) emit({ type: "moveTaskInLane", id: dId, toIndex: above ? at : at + 1 });
  };
  const clearMarks = () => host.querySelectorAll(".drop-above, .drop-below")
    .forEach(x => x.classList.remove("drop-above", "drop-below"));
  const drop = (t, from: BoardSpot, to: BoardSpot) => {
    const id = t.id;
    if (to === "done") return void emit({ type: "finishTask", id });
    if (from === "done") emit({ type: "reopenTask", id });
    if (to === "running") emit({ type: "startTask", id });
    else if (from === "running") emit({ type: "stopTask", id });
    else if (from === "todo") { emit({ type: "startTask", id }); emit({ type: "stopTask", id }); }
  };
  // Which In progress group a drop lands in: below the Paused divider is paused.
  const spotAt = (col: HTMLElement, key: BoardCol, y: number): BoardSpot => key !== "doing" ? key
    : y >= (col.querySelector(".divider.paused") as HTMLElement).getBoundingClientRect().top ? "paused" : "running";
  const canDrop = (to: BoardSpot) => boardDrag != null && boardDrag.from !== to && to !== "todo";
  const el = (tag: string, cls: string, text = "") => {
    const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; return e;
  };
  // A NAME, set apart from the yellow reason around it: the reason is the
  // scheduler's word, the name is the thing you would go and look at.
  const who = (id: Id) => el("span", "ahead", (byId[id] || {}).label || id);
  // `above` is the cards already drawn in this group, nearest last.
  const card = (r, key: "blocked" | "ready" | "running" | "paused" | BoardCol, col: BoardCol, above: Id[]) => {
    const t = byId[r.id];
    const match = (!chain || chain.has(t.id)) && (!isFiltering() || matchesFilter(t));
    if (!match && focusMode === "isolate") return null;
    const c = el("div", "card" + (sel === t.id ? " sel" : "") + (match ? "" : " dim"));
    c.style.setProperty("--c", colorOf(colorsOf(t)[0]));
    c.onclick = () => pick(t.id);
    c.draggable = true;
    c.ondragstart = e => { boardDrag = { id: t.id, from: col === "doing" ? key as BoardSpot : col }; e.dataTransfer!.effectAllowed = "move"; };
    c.ondragend = () => { boardDrag = null; clearMarks(); host.querySelectorAll(".over").forEach(x => x.classList.remove("over")); };
    // A card in the SAME column is a place in the queue; anything else falls
    // through to the column's own drop, which changes the task's state.
    if (col === "todo") {
      const above = (e: DragEvent) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2;
      c.ondragover = e => {
        if (!boardDrag || boardDrag.from !== col || !canReorder(boardDrag.id, t.id)) return;
        e.preventDefault(); e.stopPropagation();
        clearMarks(); c.classList.add(above(e) ? "drop-above" : "drop-below");
      };
      c.ondragleave = () => c.classList.remove("drop-above", "drop-below");
      c.ondrop = e => {
        if (!boardDrag || boardDrag.from !== col || !canReorder(boardDrag.id, t.id)) return;
        e.preventDefault(); e.stopPropagation(); clearMarks();
        reorder(boardDrag.id, t.id, above(e));
        boardDrag = null;
      };
    }
    c.append(el("div", "", t.label || t.id));
    const meta = el("div", "meta");
    if (key === "blocked") {
      const why = el("span", "why");
      const ahead = st.whyWho?.[t.id];
      if (r.waitingOn === "deps" && r.blockedBy.length) {
        why.append("waits on ");
        r.blockedBy.forEach((x, i) => why.append(...(i ? [", "] : []), who(x)));
      } else if (r.waitingOn === "lane" && ahead) {
        // WHAT IS AHEAD, ONLY WHEN YOU CANNOT SEE IT. On a one-lane plan the
        // card ahead is nearly always the one directly above, and sixty cards
        // naming their neighbour is noise; an arrow per card of distance says
        // the same thing. Past a handful, or in another group or column, the
        // name is the only way to find it.
        const up = above.length - above.lastIndexOf(ahead);
        why.append("queued behind ", above.includes(ahead) && up <= 5
          ? el("span", "ahead", "↑".repeat(up)) : who(ahead));
      } else why.append(
        r.waitingOn === "deps" ? "waits on work that ends today"
        : r.waitingOn === "lane" ? "queued"
        : r.waitingOn === "notBefore" ? `not before ${fmtAt(t.notBefore)}`
        : r.waitingOn === "unrefined" ? "needs refining"
        : r.waitingOn || "unscheduled");
      meta.append(why);
    }
    // BOTH WORDS FOR WHEN, clock first: the distance goes stale on a board nobody redraws, the clock does not.
    // Running reads off when work began, paused off when the last session stopped (the time the Paused group
    // is for), done off the finish. The group dividers already say which, so no word in front.
    const ss = t.sessions || [];
    if (col === "doing") {
      const iso = key === "paused" ? ss.at(-1)?.stop : ss[0]?.start;
      if (iso) meta.append(`${whenStr(dayNum(iso))}, ${agoStr(iso)}`);
    }
    if (key === "done") {
      const day = Math.floor(t.actualEnd! + 1e-9), ago = ss.at(-1)?.stop;
      // NO "done" in front: the column already says it. Near days drop the date: the divider names the day.
      meta.append(`${doneBucket(t.actualEnd!).near
        ? clockStr(Math.min(1439, Math.round((t.actualEnd! - day) * 1440))) : fmt(day)}${ago ? `, ${agoStr(ago)}` : ""}`);
    }
    if (meta.childNodes.length) c.append(meta);
    return c;
  };
  // EACH COLUMN IS ITS OWN SCROLLER, and it is rebuilt below — on a pick, and on
  // every inbound command — so its scroll is carried across or it snaps to the top.
  const scrolls = [...host.children].map(c => c.scrollTop);
  host.replaceChildren(...BOARD_COLS.map(([key, title]) => {
    const col = el("div", "col");
    // THE GROUPS, in the Ready filter's words but nearest-to-startable first:
    // a queued task only needs its turn, a blocked one needs other work done.
    // `readiness()` says "unrefined" where the chip id is "raw"; anything the
    // chips do not name still gets a group, so no card can fall out of the column.
    const groups = new Map<string, any[]>(["ready", "raw", "lane", "notBefore", "deps"].map(g => [g, []]));
    if (key === "todo") {
      cols.ready.forEach(r => groups.get("ready")!.push(r));
      for (const r of cols.blocked) {
        const g = r.waitingOn === "unrefined" ? "raw" : r.waitingOn || "unscheduled";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(r);
      }
    }
    const gLabel = (g: string) => READY.find(x => x.id === g)?.label ?? g;
    const n = key === "todo" ? cols.ready.length + cols.blocked.length
      : key === "doing" ? cols.running.length + cols.paused.length : cols[key].length;
    const h = el("h3", "", `${title} · ${n}`);
    // EVERY COUNT ON THE HEADER LINE, Ready now even at zero — an empty Ready is the news.
    if (key === "todo") h.append(el("span", "counts", [...groups]
      .filter(([g, rs]) => g === "ready" || rs.length).map(([g, rs]) => `${gLabel(g)} ${rs.length}`).join(" · ")));
    if (key === "done") {
      // THE WINDOW IS YOURS, NOT THE PLAN'S: a look back is not an edit, so it is
      // held here and forgotten on reload (back to 7). It was a `patchDoc` until
      // 2026-09-26, and every click rewrote the plan for everyone.
      const n = el("input", "") as HTMLInputElement;
      n.type = "number"; n.min = "0"; n.value = String(doneWin);
      n.title = "Days of finished work to show — just for you, and back to 7 when you reload";
      n.onchange = () => { const v = Math.floor(+n.value);
        if (Number.isFinite(v) && v >= 0) { doneWin = v; drawBoard(); } };
      h.append(" over the last", n, "days");
    }
    col.append(h);
    // A drop onto the place a card came from means nothing, so it is not offered; nor is Not started, once begun.
    col.ondragover = e => { if (!canDrop(spotAt(col, key, e.clientY))) return; e.preventDefault(); col.classList.add("over"); };
    col.ondragleave = e => { if (!col.contains(e.relatedTarget as Node)) col.classList.remove("over"); };
    col.ondrop = e => {
      e.preventDefault(); col.classList.remove("over");
      const to = spotAt(col, key, e.clientY);
      if (canDrop(to)) drop(byId[boardDrag!.id], boardDrag!.from, to);
      boardDrag = null;
    };
    // One `above` per group: a card ahead in another group is "somewhere else".
    const add = (rows, k) => { const above: Id[] = [];
      rows.forEach(r => { const c = card(r, k, key, above); if (c) { col.append(c); above.push(r.id); } }); };
    if (key === "todo") for (const [g, rs] of groups) {
      if (!rs.length) continue;
      col.append(el("div", "divider", `${gLabel(g)} · ${rs.length}`));
      add(rs, g === "ready" ? "ready" : "blocked");
    } else if (key === "done") {
      // DIVIDERS BY WHEN, each with its count; a bucket with nothing in it never
      // appears. The rows arrive newest first, so each bucket is one run.
      const runs: [string, any[]][] = [];
      for (const r of cols.done) {
        const label = doneBucket(byId[r.id].actualEnd!).label;
        if (runs.at(-1)?.[0] === label) runs.at(-1)![1].push(r); else runs.push([label, [r]]);
      }
      for (const [label, rs] of runs) { col.append(el("div", "divider", `${label} · ${rs.length}`)); add(rs, key); }
    } else if (key === "doing") for (const [g, label] of IN_PROGRESS) {
      // BOTH DIVIDERS ALWAYS, even over nothing: each is where a drop lands in its group.
      col.append(el("div", "divider " + g, `${label} · ${cols[g].length}`));
      add(cols[g], g);
    } else add(cols[key], key);
    return col;
  }));
  [...host.children].forEach((c, i) => { c.scrollTop = scrolls[i] ?? 0; });
}

// ---- self-test --------------------------------------------------------------
// WHY UNIT TESTS ARE RUNNING IN A BROWSER, which is the first thing anyone asks
// and the thing this comment used to leave out. The scheduler cannot disagree
// with itself; the question is not whether it is CORRECT — `verify.sched.mjs` and
// `sync-server/test/` settle that at build time, against the code in the repo.
// The question this answers is WHICH SCHEDULER THIS BROWSER LOADED, and it is a
// real question because the two halves ship separately and cache separately:
//
//     index.html      no-cache                     revalidated every load
//     /assets/*.js    max-age=31536000, immutable  hashed, so it cannot be stale
//     /schedule.js    max-age=300, UNHASHED        at the bucket root
//
// See `scripts/deploy-web.sh`. `shared/schedule.js` is deliberately NOT bundled
// (ADR 0004) so the browser runs the same bytes the server hashed — and the price
// of that is a five-minute window after every deploy in which the entrypoint is
// fresh, the hashed bundle it names is fresh, and the `/schedule.js` that bundle
// imports can still be the previous one. New page, old scheduler, every date on
// screen quietly computed by code this build never tested.
//
// NOTHING ELSE IN THE STACK CAN SEE THAT. `assert-shared-parity.sh` proves the
// bucket's copy matches the image's; `smoke.sh` proves the shipped bundle still
// IMPORTS the file rather than having inlined it. Neither knows which bytes a
// given browser actually got. This does, because the expected answers below are
// hand-computed IN THE BUNDLE and run through the separately fetched scheduler —
// so the two disagreeing is precisely what it measures. The browser suite
// provokes it by serving a one-token-wrong `/schedule.js`.
//
// IT TESTS THE SCHEDULER, NOT YOUR DATA — and that is a correction. It used to
// assert the exact finish week and date of each shipped plan, which meant every
// legitimate edit (moving a start date, retiming a task) lit up a red banner
// claiming the tool was broken. A check that cries wolf on correct behaviour is
// worse than no check: it trains you to ignore it on the day it is right.
//
// Two parts, neither of which the plans can invalidate:
//   1. fixed synthetic plans with hand-computed answers, exercising the things
//      that can actually break — serial lanes, dependency gating, the array-order
//      tie-break, the working week, actuals, exempt work, and the migration
//      ladder's sequencing;
//   2. a structural audit of whatever is loaded: no task starts before a thing it
//      waits on has finished, and no lane runs two tasks at once.
//
// A WARNING, NOT A TAKEDOWN. The chart still draws. A reader who is told the
// dates may be wrong needs the dates in front of them to check against.
const REFERENCE = [
  { id:"a1", lane:"A", dur:2,   deps:[] },
  { id:"a2", lane:"A", dur:1,   deps:[] },          // same lane -> queues behind a1
  { id:"b1", lane:"B", dur:1,   deps:["a1"] },      // gated by a1, ties with a2
  { id:"b2", lane:"B", dur:0.5, deps:["b1"] },      // fractional, to catch rounding
  // Ready from the start and free of dependencies, so ONLY the constraint can
  // hold it: it must lose every tie-break to the rest of lane B, leave the lane
  // idle from 3.5 to 5, and land exactly on 5.
  { id:"b3", lane:"B", dur:1,   deps:[], notBefore:5 },
];
const REFERENCE_FINISH = 6;

// THE SAME SCHEDULER, ON A WEEK THAT HAS HOLES IN IT. The plan above covers
// serial lanes, dependency gating, the array-order tie-break, fractional
// durations and a constraint that must lose every tie — and it covers all of it
// on a calendar where every day is alike, so it would pass unchanged through a
// change that broke non-working time entirely. This is that missing half.
//
// Day 0 is a MONDAY, which is what `dow0: 1` says, so the weekends fall on days
// 5-6, 12-13, and the numbers below can be read off a real week.
const REFERENCE_WW_CAL = makeCal([[], [[0,1]], [[0,1]], [[0,1]], [[0,1]], [[0,1]], []], new Map(), 1);   // Monday to Friday, the whole day
const REFERENCE_WW = [
  { id:"w1", lane:"W", dur:3,   deps:[] },                  // Mon-Wed, no weekend inside it
  { id:"w2", lane:"W", dur:3,   deps:[] },                  // queues to Thu, so it crosses one
  { id:"w5", lane:"Y", dur:1.5, deps:[], notBefore:4 },      // a FRACTION split by a weekend
  { id:"w3", lane:"X", dur:1,   deps:[], notBefore:5 },      // pinned to a SATURDAY -> Monday
  // THE TIE-BREAK THAT ONLY EXISTS BECAUSE OF SNAPPING, and it is declared in
  // this order deliberately. Saturday and Sunday are different numbers until
  // they both become Monday; zA is pinned LATER than zB and must still go first,
  // because once both snap to 7 the array order is all that separates them. Snap
  // after choosing a winner instead of inside the estimate and these swap.
  { id:"zA", lane:"Z", dur:1,   deps:[], notBefore:6 },
  { id:"zB", lane:"Z", dur:1,   deps:[], notBefore:5 },
  { id:"w4", lane:"X", dur:0.5, deps:["w3"] },              // fraction on a plain working day
];
const REFERENCE_WW_STARTS = { w1:0, w2:3, w5:4, w3:7, zA:7, zB:8, w4:8 };
const REFERENCE_WW_FINISH = 9;

// A HOLIDAY IS THE SAME QUESTION ASKED OF A DATE. Wednesday is a working weekday
// and still not a working day, which is the whole point of the second list.
const REFERENCE_HOL_CAL = makeCal([[], [[0,1]], [[0,1]], [[0,1]], [[0,1]], [[0,1]], []], new Map([[2, []]]), 1);
const REFERENCE_HOL = [{ id:"h1", lane:"H", dur:3, deps:[] }];
const REFERENCE_HOL_SPAN = 4;

// WHAT HAPPENED, NOT WHAT IS FORECAST. Every fixture above describes a plan the
// scheduler is free to solve; this one describes work that has already been
// done, and it is here because reality breaks all four audit rules on purpose.
// Same five-day week as REFERENCE_WW — day 0 is a Monday, so the weekends fall
// on days 5-6 and 12-13 and the numbers below read off a real calendar.
//
// It is also the ONLY fixture whose starts are hand-written rather than solved
// for, and that is the point: `REFERENCE_ACT_STARTS` is where the work really
// landed. The audit is run against it directly — it must have nothing to say —
// and `sched()` is separately required to arrive at exactly the same map.
const REFERENCE_ACT_CAL = makeCal([[], [[0,1]], [[0,1]], [[0,1]], [[0,1]], [[0,1]], []], new Map(), 1);   // Monday to Friday, the whole day
const REFERENCE_ACT = [
  { id:"a1", lane:"A", dur:3, deps:[] },
  // BEGUN BEFORE ITS DEPENDENCY ALLOWED, and it took four days rather than the
  // one it was estimated at. Two rules broken at once — the dependency and the
  // "a span holds exactly `dur` working days" invariant — and both are facts.
  { id:"a2", lane:"B", dur:1, deps:["a1"], actualStart:1, actualEnd:5 },
  // The successor is still a FORECAST, so it is still audited, and it follows
  // from a2's ACTUAL end. That end is a Saturday, so a3 snaps to the Monday —
  // exactly what a forecast should do with a date nobody works.
  { id:"a3", lane:"B", dur:1, deps:["a2"] },
  // WORK REALLY DID START ON A SATURDAY. A scheduler that moves this to Monday
  // is inventing a date, which is the failure this whole tool is built against.
  { id:"a4", lane:"C", dur:2, deps:[], actualStart:5, actualEnd:8 },
  // A TEAM REALLY DID RUN TWO AT ONCE, in a lane whose capacity says it cannot.
  { id:"a5", lane:"D", dur:1, deps:[], actualStart:2, actualEnd:8 },
  { id:"a6", lane:"D", dur:1, deps:[], actualStart:3, actualEnd:4 },
];
const REFERENCE_ACT_STARTS = { a1:0, a2:1, a3:7, a4:5, a5:2, a6:3 };
const REFERENCE_ACT_FINISH = 8;

// WORK THAT DOES NOT OCCUPY THE TEAM, which is the one thing no fixture above
// contains — and that omission is exactly how the audit shipped counting exempt
// tasks against a lane's capacity for three days. Every reference plan here
// audits a world where `noQueue` does not exist, so the flag could not fail one.
//
// Lane N is left at the default capacity of 1 (these plans pass no lanes at all),
// and the claim is BOTH HALVES of the exemption, which is why n4 is here:
//   - n2 and n3 do not WAIT for a slot, so they start at 0 rather than queueing
//     behind n1 at 2 and 3;
//   - and they do not HOLD one, so n4 — which does queue — follows n1 alone and
//     starts at 2 rather than being pushed to 4 by work it does not compete with.
// The audit is then required to have nothing to say about a lane momentarily
// running three tasks, two of which are not in its queue.
const REFERENCE_NQ = [
  { id:"n1", lane:"N", dur:2, deps:[] },
  { id:"n2", lane:"N", dur:1, deps:[], noQueue:true },
  { id:"n3", lane:"N", dur:1, deps:[], noQueue:true },
  { id:"n4", lane:"N", dur:1, deps:[] },
];
const REFERENCE_NQ_STARTS = { n1:0, n2:0, n3:0, n4:2 };
const REFERENCE_NQ_FINISH = 3;

function auditSchedule(tasks, start, lanes = (doc && doc.lanes) || [], cal = CAL) {
  // THROUGH THE SAME LENS `sched` USED. Every rule below re-derives the
  // scheduler's own constraints from the document and checks the answer against
  // them, so it has to be looking at the same task list — abandoned work with
  // its duration zeroed, its lane slot released and its edges cut. Auditing the
  // raw document instead made this accuse a correct schedule the moment anything
  // was dropped: the original duration said a dependent started too early, and
  // the original lane membership said a capacity-one lane was running two.
  tasks = scheduleView(tasks);
  const by = Object.fromEntries(tasks.map((t: Task) => [t.id, t]));
  const bad: string[] = [];
  // A FORECAST IS AUDITED; A FACT IS REPORTED. Every rule below asks whether a
  // plan is POSSIBLE, and none of them is a question you can ask of work that
  // has already happened: a task really can start before the thing it waited on
  // finished, a team really can run three at once, someone really does work a
  // Saturday, and an observed span holds exactly as many working days as it
  // holds — which is the whole reason for recording it. So a task with an
  // `actualStart` is excluded from all four, including the capacity sweep, and
  // that is not leniency: a check that fires on every honest plan is one you
  // stop reading, and then it cannot tell you about the forecast either.
  // A planned task is a promise about the calendar, not a forecast: it can start before something it waits on has ended
  // (the slack chip says so) and sits outside working hours without the scheduler being wrong.
  const forecast = t => t.actualStart == null && !plannedOf(t);
  for (const t of tasks) {
    // A DOCUMENT CAN BE INCOHERENT IN A WAY A PLAN CANNOT, and that is a
    // different question from the four below. Those ask whether a plan is
    // POSSIBLE and are rightly silent about work that has already happened; this
    // asks whether the FILE agrees with itself, which is worth asking of
    // everything. Nothing in the UI can produce it. A hand-edited file can, and
    // an unnoticed one draws an estimate where two dates contradict each other.
    // A finish AT the start is not on this list: it is a task finished without being started (v8), one session of no length.
    if (t.actualStart != null && t.actualEnd != null && t.actualEnd < t.actualStart)
      bad.push(`${t.id} finished ${t.actualEnd} but started ${t.actualStart}`);
    if (!forecast(t)) continue;
    for (const d of t.deps) {
      const end = endOf(by[d], start[d], cal);
      if (end > start[t.id] + 1e-9) bad.push(`${t.id} starts ${start[t.id]} but waits on ${d} which ends ${end}`);
    }
    // A start constraint is as much a scheduling fact as a dependency, so it is
    // audited the same way: silently ignoring one would put a bar to the left of
    // its own pin marker, which is precisely the "invisible state" failure.
    if (t.notBefore != null && start[t.id] < t.notBefore - 1e-9)
      bad.push(`${t.id} starts ${start[t.id]} but cannot start before ${t.notBefore}`);
    // NON-WORKING TIME, AUDITED THE SAME WAY. The first rule catches a snap that
    // went the wrong way or not at all. The second is the one that earns its
    // place: it is the single assertion that fails if spanOf is wrong in ANY
    // direction, and it is what "cannot start or end on a non-working day" was
    // really trying to say — the end takes care of itself, because a walk that
    // only ever spends working days cannot stop on a day it refused to spend.
    if (!cal.isWorking(start[t.id]))
      bad.push(`${t.id} starts ${start[t.id]}, which is not a working day`);
    else {
      const h = start[t.id] - Math.floor(start[t.id]);
      if (!cal.win(start[t.id]).some(([wa, wb]) => h >= wa - 1e-9 && h < wb - 1e-9))
        bad.push(`${t.id} starts ${start[t.id]}, outside working hours`);
    }
    const held = workDaysIn(start[t.id], spanOf(t, start[t.id], cal), cal, t.id);
    if (Math.abs(held - t.dur) > 1e-6)
      bad.push(`${t.id} spans ${held} working days but its duration is ${t.dur}`);
  }
  // Overlap is only a fault BEYOND the lane's capacity now. Sweep the start/end
  // events and check the running count never exceeds it.
  for (const l of [...new Set(tasks.map(t => t.lane))]) {
    const cap = Math.max(1, Math.floor((lanes.find(x => x.id === l) || {}).cap || 1));
    const ev: [number, number, Id][] = [];
    // AND AN EXEMPT TASK IS NOT IN THE QUEUE, so it cannot be over it. `noQueue`
    // means the task neither waits for a slot nor holds one; this sweep has to
    // ask the same question `sched` asked or it reports a violation the
    // scheduler never made — nine access requests raised in one sitting read as
    // nine developers, and the banner accuses a plan that is exactly right.
    for (const t of tasks.filter(t => t.lane === l && forecast(t) && !t.noQueue)) {
      ev.push([start[t.id], 1, t.id], [endOf(t, start[t.id], cal), -1, t.id]);
    }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);      // ends before starts at a tie
    let run = 0;
    for (const [, delta, id] of ev) {
      run += delta;
      if (run > cap) { bad.push(`lane ${l}: ${run} tasks at once (capacity ${cap}) at ${id}`); break; }
    }
  }
  return bad;
}

// `migrationSelftest()` WAS HERE, and it is `sync-server/test/migrations.test.ts`
// now — nine checks on the same synthetic ladder, run at build time instead of in
// every reader's browser. The claim is unchanged and worth restating: what ruins
// data is the sequencing, not any one migration. A ladder applied out of order,
// or one that stops early and stamps the document current anyway, is worse than
// one that fails, because it looks like it worked.


function selftest() {
  // ONLY THE LOADED PLAN. Everything else this used to run — four reference plans
  // with hand-computed answers, and a synthetic migration ladder — was a
  // duplicate of `verify.sched.mjs` and `sync-server/test/migrations.test.ts`,
  // which assert the same constants at build time against the code in the repo.
  //
  // The one thing the in-page copies added was catching a browser that had loaded
  // a STALE `/schedule.js`: the file is not bundled (ADR 0004) and carried
  // `max-age=300` unhashed at the bucket root, so for five minutes after a deploy
  // a fresh page could pair with the previous scheduler. That is prevented now
  // rather than detected — `scripts/deploy-web.sh` serves it `no-cache`, like
  // index.html — so the duplicates have no job left and are gone.
  //
  // WHAT REMAINS IS NOT A TEST. It audits the document that actually loaded, for
  // a schedule that violates its own constraints: a task starting before
  // something it waits on has finished, or a lane running two tasks at once.
  // That is a claim about DATA, which varies, rather than about code, which does
  // not — the case a hand-edited import or a bad migration produces.
  const bad: string[] = [];

  // ONLY IF A PLAN ACTUALLY LOADED. `doc` is null when a named plan failed to open,
  // which is a normal state now that the backend can be asleep — and auditing it
  // threw, so a network error rendered as "Scheduler check failed: Cannot read
  // properties of null". That accuses the one component that was working, and it
  // buried the real message.
  // AND ONLY IF IT SCHEDULED. Same failure one step along: when `sched()` throws,
  // `st` holds nothing usable, so auditing against it reports "starts undefined"
  // for every task — twenty-six lines accusing the whole document of a fault that
  // belongs to one dependency, and burying the sentence that names it.
  // `schedulerDown` is already saying the true thing on screen.
  if (doc && !schedErr) {
    try { bad.push(...auditSchedule(doc.tasks, st, undefined, CAL)); }
    catch (e) { bad.push("loaded plan: " + e.message); }
  }

  // A WARNING, NOT A TAKEDOWN. The chart still draws: a reader told the dates may
  // be wrong needs the dates in front of them to check against.
  if (bad.length) {
    mountSelfTestFailed(bannerHost("selftestfail", "danger"), bad);
  }
  console.log(bad.length ? "SELFTEST FAILED: " + bad.join("; ")
                         : "selftest ok — loaded plan internally consistent");
}

// BOOT. Three ways in, in priority order:
//   an id in the hash — THE ONLY WAY TO REACH A REAL PLAN. There is no list to
//                    consult and no "first plan" to fall back to: the link is the
//                    capability, so a URL naming no plan reaches no plan.
//   nothing        — the demo. Not an edge case any more but the normal arrival:
//                    it is what a stranger sees, and it costs them nothing.
// THE VIEW STARTS AT ITS DEFAULTS, EVERY LOAD. These used to be restored from
// the fragment; a refresh now resets them, which is what a refresh is for.
if ($("#lurk")) $f("#lurk").checked = LURK;
$f("#rowmode").value = ROWMODE;

// `wanted` is a LABEL ONLY — what the failure panel below calls the plan it
// could not open. The token is what addresses it (ADR 0002), and a normal link
// carries no id at all, so this is very often undefined and that is fine.
const wanted = null;
// THE TOKEN IS WHAT DECIDES, NOT THE ID. This used to branch on an id in the
// fragment, which was right while an id addressed a plan and is wrong now that a
// capability does (ADR 0002). Branching on `wanted` would have sent every link
// anyone actually sends straight to the demo fixture.
//
// `wanted` survives as a LABEL: it is what the failure panel below names, and
// nothing addresses a plan with it.
// ARRIVED WITH NOTHING -> THE DOOR PAINTS FIRST, THE DEMO ARRIVES BEHIND IT.
// The landing card is static markup, so it is on screen in one frame. The demo
// plan behind it is a real plan on a backend that scales to zero and takes
// 30-90s to wake (see iac/wake), and awaiting that before showing anything would
// put a minute and a half of blank page in front of every first-time visitor —
// which is the one moment this tool cannot afford to look broken.
//
// So: show the door, adopt the demo token, and let the load run. The wake is
// already in flight by the time the card is readable, so the wait is spent
// reading rather than staring, and by the time somebody dismisses the card the
// chart is usually there.
//
// `location.replace`, and `hashToken` updated in the same tick: this is
// correcting a URL that named no plan, not navigating, so it must not add a
// back-button step — and the `hashchange` listener reloads the page whenever the
// token changes out from under it, which is exactly what this is doing on
// purpose. Setting `hashToken` synchronously is what tells it this one is ours.
const tokenless = !shareToken();
if (tokenless) {
  showLanding();
  // The second segment is CARRIED OVER, not dropped. It is the keyring inbox now
  // (it used to be view state), and a tokenless link can carry one — adopting the
  // demo token must not throw away the thing the link was sent to deliver.
  const payload = hashParts().json;
  location.replace("#" + DEMO_TOKEN + (payload ? "&" + payload : ""));
  hashToken = shareToken();
}
await load(wanted);
// THE CHROME IS SHOWN ONCE IT HAS STOPPED MOVING. See `body.booting` in the
// stylesheet for what this is hiding and why reserving space was the worse fix.
//
// Unconditional, and after the `await` rather than inside the success path: a
// plan that could not be opened still has to show its error panel, and a boot
// that threw still has to show the toolbar it left behind. The timer is the
// backstop for a `load` that never settles at all — better a page that shifts
// than a page that stays blank.
const reveal = () => document.body.classList.remove("booting");
setTimeout(reveal, 4000);
reveal();
// A NAMED PLAN THAT WILL NOT LOAD MUST NEVER FALL BACK TO THE FIXTURE. This line
// used to fall back to the inline fixture, to spare a mistyped link an empty
// grid under a flash that clears itself after three seconds. That was wrong, and
// scale-to-zero is what makes it dangerous rather than merely untidy: a sleeping
// or 503-ing backend is now a NORMAL state, so the common path became "open your
// real plan, watch an error disappear, and end up looking at twelve tasks of
// invented bakery data" — with the hash rewritten to `demo`, so a refresh could
// not even recover the link. A plausible wrong chart in a meeting is the worst
// failure this tool has; an empty grid is merely unhelpful.
//
// No 404-vs-503 branch on purpose. "Never substitute the fixture for a plan
// somebody named" is one rule with no way to get it wrong, and the case it gives
// up — a genuinely mistyped id — is better served by this panel anyway.
if (!doc) {
  // Deliberately NOT `flash`: this one must not time out. It is the same panel
  // the scheduler self-test uses, for the same reason — something upstream is
  // wrong and the page cannot answer the question it was opened to answer.
  // `wanted` is only a display hint and a link is not obliged to carry one, so
  // it can legitimately be absent while a token is present.
  mountPlanUnopenable(bannerHost("planfail", "danger"), wanted || "that plan", lastServerError);
  // AND THE TOOLBAR MUST NOT OUTLIVE THE DOCUMENT. Every one of these reads
  // `doc`, and `doc` is null on this path — so `+ Task` threw an uncaught
  // TypeError into a console nobody has open and did nothing on screen, which
  // reads as a broken button rather than as the plan that never opened. Two of
  // them are worse than dead: Save and Revert would have gone to the server
  // under a token it has already refused.
  //
  // `New` and `?` stay live on purpose. Neither needs a document, and New is the
  // one way forward from here for somebody whose link is simply wrong.
  for (const s of ["#add", "#save", "#revert", "#histbtn", "#renamebtn", "#cog",
                   "#view", "#rowmode", "#zoom", "#collapse"]) {
    const el = $f(s); if (el) el.disabled = true;
  }
}
selftest();
// The hash carries the version NUMBER; the strips are re-derived here rather than
// cached in the URL, and applyCompare clears the key if that version has gone.
// Only when the plan we landed on is the plan the hash named: a version number is
// meaningless against a different plan's archive, and landing on the demo instead
// is a normal thing to happen to a link someone forwarded wrong.

// THE HOME SCREEN OPENS WHEN THERE IS NO PLAN. Someone who arrived on a link
// came for that plan, not for an introduction to the tool — and someone who
// arrived on nothing has no plan at all, so the home screen IS what they came
// for, every time and not just the first. The verification suite is unaffected:
// it arrives on a scratch plan's token, which is a link to a plan like any
// other, so this never opens over the UI it is asserting on.
// "DID THEY ARRIVE ON A LINK TO A PLAN" — and it is the TOKEN that answers it,
// never `wanted`: the normal shared link is `#<token>` and nothing else, so
// `wanted` is always null now and gating on it would open this on top of
// somebody's real plan, mid-meeting, exactly for the people it is least meant
// for.
// `tokenless` rather than `!shareToken()`: by now the hash HAS a token, because
// the block above adopted the demo's. The question this asks is "did they arrive
// on a link to a plan", and the answer was decided before we rewrote the URL.
if (tokenless) showLanding();
