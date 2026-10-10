// The domain lives in `types.ts` now — these were `@typedef` blocks in this file
// until 2026-09-05, checked by nothing. Re-exported because the two documents
// that point agents here (AGENTS.md, and the page header) promise this file is
// where the vocabulary is: a reader who follows that pointer should find the
// shapes as well as the appliers.
import type { Task, Doc, Cal, Id, ChannelKey, Command, ChannelValue, Recur } from "./types.js";
// A CYCLE, ON PURPOSE: schedule.ts imports `rankOf` from here. Both sides only call each other from inside functions, never
// while loading, so it resolves; the alternative was a third file for the zone arithmetic and a new thing to serve.
import { dayOfInstant, instantOfDay } from "./schedule.js";
import { flipOfIds, orient, pairKeyOf, rankRows, replay, retireLog, slotsFor, type LogEntry, type RankItem, type Verdict } from "./pairwise.js";
export type { Task, Doc, Cal, Id, ChannelKey, Command, ChannelValue };

// THE COMMAND VOCABULARY — the whole wire protocol, imported by the browser and
// by the sync server so a command one side can send is a command the other side
// can apply, by construction rather than by two files agreeing.
//
// This file is the reason there is no markdown table of commands anywhere. A
// table would be a second copy, and a second copy is the thing that rots — the
// original tool learned that lesson in `agent-recipes.ts` and this is the same
// bet: the only documentation that cannot drift is documentation that runs.
//
// PLAIN JS WITH JSDOC TYPES, and that is the whole reason it is not TypeScript:
// the page is a no-bundler `<script type="module">` and cannot load TS. "Both
// sides import the same file" is the entire point of this module, so the file
// has to be one the browser can actually load. `schedule.js` next door is the
// same shape for the same reason. A `tsc` emit step would have produced a
// generated `commands.js` beside the source — a second artifact that can go
// stale, needing its own parity check, which is exactly the hazard ADR 0001
// exists to describe.
//
// `// @ts-check` above is not decoration. It makes the file typecheck itself
// wherever it is included, so the guarantee travels with the file instead of
// depending on a consumer remembering to set `checkJs` — see the note on the
// `never()` guard below for what that buys.
//
// WHY COMMANDS AND NOT A CRDT is `docs/adr/0001-server-authoritative-command-log.md`.
// The short version, because it is the constraint every decision below answers
// to: array position in `tasks` IS queue position IS a scheduling input, so two
// concurrent reorders merged as STATE produce an interleaving neither person
// chose — plausible-looking and a different finish date. Serialising INTENTS is
// what happens in a room.
//
// WHAT THIS FILE IS NOT: transport, sequencing, storage, auth. No envelope, no
// `seq`, no `by`, and deliberately no plan id — ADR 0002 requires the server to
// resolve which plan a request is for from the token alone, so a command that
// carried a plan id could be aimed at a plan its connection was not issued for.
// It also does not validate the resulting DOCUMENT — that is `invalid()` in the
// original tool's `api.ts`, which the server runs after applying. Everything
// here is a check on whether the COMMAND is well-formed enough to apply at all.
//
// Durations are whole MINUTES of lane time (v7; a day is 1440). Every TIME on a task — `notBefore`, `refinedAt`,
// `due`, each session's `start`/`stop` — is an ISO instant with a zone, stored as UTC
// (schema v6; they were day numbers from `doc.start` until then). The scheduler
// still counts in day numbers, projected from these in `doc.timeZone` by
// `dayNumbers()` in schedule.js — a caller never writes one.
// Channel values are ids pointing into `doc.lanes` / `doc.borders` / `doc.fills`
// / `doc.shapes` / `doc.colors`, never free text.

/** A task id, a channel-value id, a milestone id. All the same shape.
 *  @typedef {string} Id */

/** The four single-valued channels. `color` is a LIST and has its own command.
 *  @typedef {"lane" | "border" | "fill" | "shape"} ChannelKey */

/**
 * @typedef {{
 *   id: Id,
 *   label: string,
 *   desc?: string,
 *   url?: string,
 *   ref?: string,
 *   lane: Id,
 *   border: Id,
 *   fill: Id,
 *   shape: Id,
 *   color: Id[],
 *   dur: number,
 *   deps: Id[],
 *   ms?: Id,
 *   notBefore?: string, noQueue?: boolean,
 *   sessions?: { start: string, stop: string | null }[],
 *   done?: true,
 *   refinedAt?: string,
 *   createdAt?: string,
 *   updatedAt?: string,
 *   [k: string]: unknown
 * }} Task
 *
 * `color` is an ARRAY of `doc.colors` ids; `[]` is legal and means "no system".
 * `dur` is whole MINUTES, above zero (v7) — it was days from schema 4 to 6, weeks before.
 * Zero is refused; see `setDuration` below.
 * `notBefore` and `due` are ISO instants, stored as UTC. `sessions` is the only
 * record of work (v8, ADR 0016): it started at the first start, and a `done` task
 * finished at the last stop. A done task has a session and none running.
 *
 * `refinedAt` is the same kind of instant and answers a different kind of
 * question: WHEN A HUMAN LAST READ THIS TASK AND AGREED WITH IT. Absent means
 * nobody has, which is the state every task is born in. It is the only field
 * here that describes the reader rather than the work — and the only one this
 * applier CLEARS BY ITSELF, whenever a command changes one of the three things
 * a sign-off was about: the label, the description, the duration. That is what
 * makes it trustworthy rather than a checkbox somebody forgot: there is no way
 * to change what a task says and leave it looking approved.
 *
 * `createdAt` and `updatedAt` are ISO instants too, and were before the rest.
 * `updatedAt` moves on exactly what clears `refinedAt` — the label,
 * the description, the duration — so rescheduling a task, or recording the day it
 * finished, is not an edit. Both come off `at`; see `edited()`.
 *
 * `ref` is this task's identifier in whatever tracker the team actually works in.
 * This protocol does not know or care which one: an issue number, a row id in
 * something homegrown, anything — they are all just strings here.
 *
 * It is HALF a link. The other half is the base URL, which is deliberately NOT on
 * this document and never can be (see `PATCHABLE_DOC_KEYS`). That split is the
 * point: a reference names a row in a system it does not identify, so a plan
 * carrying 135 of them still does not say whose tracker they are in. A viewer who
 * already knows supplies the base once and every ref becomes a working link. A
 * plan that leaks leaks identifiers, not an estate.
 *
 * `url` is the one field that leaves this document. It is rendered as an `href`
 * in every viewer's browser, so it is restricted to `http:`/`https:` at the door
 * — see `setTaskUrl` below. Absent means the task links to nothing, which is
 * every task until somebody says otherwise.
 *
 * The index signature is deliberate: a key this protocol does not know about
 * survives a round trip instead of being silently dropped by the applier.
 */

/** @typedef {{ schemaVersion: number, tasks: Task[], [k: string]: unknown }} Doc */

// ---------------------------------------------------------------------------
// THE COMMANDS
//
// TASK-LEVEL OPERATIONS GET NAMED, SEMANTIC COMMANDS, because that is where two
// people actually collide and where the intent has to survive being sequenced
// behind someone else's edit. DOCUMENT-LEVEL SCALARS GET ONE `patchDoc`, because
// two people renaming a plan at the same time is not a scenario worth modelling.
//
//   addTask         appended, which is what "add a task" means: last in that
//                   lane's queue. Anywhere else is `addTask` then
//                   `moveTaskInLane` — two intents, two commands.
//   removeTask      also strips the id from every other task's `deps`. Not a
//                   convenience: a plan whose deps name a task that is not there
//                   is one `invalid()` refuses, so a remove that left them
//                   behind would be a command that cannot be saved.
//   addDep          idempotent. Two people adding the same dependency is a
//                   normal race and it must not produce it twice.
//   setTaskColors   the whole list, last write wins.
//   setTaskRef      the tracker identifier. `null` clears it. NOT a URL and not
//                   validated as one — it is half of one, and the half that
//                   stays here is the half that names nothing on its own.
//   setTaskUrl      `null` clears it, like `setTaskDesc`. It is the ONE string
//                   command with a value rule, because a task's `url` becomes an
//                   `href` in someone else's browser and a plan is shared with
//                   whoever holds the link — so `javascript:` is refused here,
//                   at the only place every writer passes through.
//   setNotBefore    a CONSTRAINT, NOT A POSITION: an instant the scheduler may
//                   push past, never a place on the chart. `null` clears it.
//   finishTask      DONE, at `at`: stops the running session there, or — for work never started — records
//                   a session of no length there, because every finished task has one. `reopenTask` undoes
//                   the flag and keeps the sessions, so a reopened task reads as paused.
//   `setOwner` IS GONE (2026-09-20), and with it `Task.owner`. It named who does
//   a task when that is not you, and it was set on nothing: zero tasks in the
//   live plan, alongside zero uses of the `noQueue` it was supposed to pair
//   with. Somebody else's work is still their own task that yours depends on —
//   that part was never the field's doing — and `setNoQueue`, which is the half
//   that actually keeps their days out of your capacity, is untouched. Their
//   name goes in the title, where it is read.
//
//   setPlanned      PLANNED STRETCHES: what is promised, in the same { start, stop } shape as `sessions` (what happened).
//                   Replaces the list; [] clears it. The scheduler holds those times and works around them.
//   completePlanned `index` happened: moves that stretch into `sessions` (times default to the stretch's, and may be corrected).
//   setDue          the OTHER direction from `setNotBefore`: an instant by which
//                   the task must FINISH. It constrains nothing — the scheduler
//                   ignores it — and exists to be compared against the date the
//                   scheduler computes. `null` clears it.
//   setDropped      REMOVED 2026-09-20. It marked work deliberately abandoned,
//                   the one bit of progress finishing cannot express. The
//                   concept is retired: work decided against is REMOVED with
//                   `removeTask`, and the version history is the record of it
//                   ever having been considered.
//   moveTaskInLane  THE ONE THAT EARNS THE WHOLE DESIGN. `toIndex` is the task's
//                   position AMONG ITS OWN LANE'S TASKS, not an index into
//                   `doc.tasks` — see the applier for why.
//   addRankAnswer   ONE answer to “which should happen first?”: `verdict` -1
//                   means `a` first, 1 means `b`, 0 equal. Replaces any earlier
//                   answer about the same pair. Named, not a `patchDoc` of the
//                   whole log, so two people answering at once both land.
//   removeRankAnswer forgets the answer about a pair, so it is asked again.
//                   Idempotent: the pair may already be gone.
//   resetRanking    forgets every answer.
//   setRankSuggestion  a PROPOSED order (an agent's, or the person's own paste), held apart from the
//                   answers (`doc.rankSuggestion`) as a backdrop: it orders what the person has not
//                   answered, and their answers always win. It never writes `rankLog`, is never
//                   turned into the person's answers and is never discarded — a newer one replaces it.
//   FINISHING OR REMOVING A TASK TAKES IT OUT OF THE RANKING (see `retireRanked`),
//   inside `finishTask` and `removeTask` themselves, so every writer — the page,
//   another person, an agent — gets the same result without having to know.
//   patchDoc        document-level scalars, shallow-merged, last write wins. A
//                   `null` value DELETES the key, so "this plan no longer has
//                   hours" is expressible.
//
// The notes above are the ones that are not obvious from a signature. The
// signatures themselves are below, once — writing them out here as well would be
// the second copy this module exists to argue against.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ type: "addTask", task: Task }
 *         | { type: "removeTask", id: Id }
 *         | { type: "renameTask", id: Id, label: string }
 *         | { type: "setTaskDesc", id: Id, desc: string | null }
         | { type: "setTaskUrl", id: Id, url: string | null }
         | { type: "setTaskRef", id: Id, ref: string | null }
 *         | { type: "setDuration", id: Id, dur: number }
 *         | { type: "startTask", id: Id }
 *         | { type: "stopTask", id: Id }
 *         | { type: "finishTask", id: Id }
 *         | { type: "reopenTask", id: Id }
 *         | { type: "setSessions", id: Id, sessions: { start: string, stop: string | null }[] }
 *         | { type: "setRefined", id: Id, refinedAt: string | null }
 *         | { type: "addDep", id: Id, dep: Id }
 *         | { type: "removeDep", id: Id, dep: Id }
 *         | { type: "setTaskChannel", id: Id, channel: ChannelKey, value: Id }
 *         | { type: "setTaskColors", id: Id, colors: Id[] }
 *         | { type: "setNotBefore", id: Id, notBefore: string | null }
 *         | { type: "setNoQueue", id: Id, noQueue: boolean }
 *         | { type: "setPlanned", id: Id, planned: { start: string, stop: string }[] }
 *         | { type: "completePlanned", id: Id, index: number, start?: string, stop?: string }
 *         | { type: "setRecur", id: Id, recur: { n: number, unit: "day" | "week" | "month", ahead?: number } | null }
 *         | { type: "setMilestone", id: Id, ms: Id | null }
 *         | { type: "setDue", id: Id, due: string | null }
 *         | { type: "addComment", id: Id, comment: { id: Id, text: string, at?: string, by?: string } }
 *         | { type: "editComment", id: Id, commentId: Id, text: string }
 *         | { type: "removeComment", id: Id, commentId: Id }
 *         | { type: "moveTaskInLane", id: Id, toIndex: number }
 *         | { type: "addRankAnswer", a: Id, b: Id, verdict: -1 | 0 | 1 }
 *         | { type: "removeRankAnswer", a: Id, b: Id }
 *         | { type: "resetRanking" }
 *         | { type: "setRankSuggestion", by?: string, order: { id: Id, why: string, toss?: boolean }[] }
 *         | { type: "patchDoc", patch: Record<string, unknown> }}
 *         & { at?: string }} Command
 *
 * `at` IS THE ONE FIELD EVERY COMMAND MAY CARRY, an ISO instant saying when the
 * sender issued it. Optional, ignored by every command but the four that stamp a
 * task (`addTask` for `createdAt`; the three wording commands for `updatedAt`),
 * and it exists because the applier is forbidden from reading a clock: this file
 * runs in the page, in the server and in every other client on the SAME command,
 * so a timestamp taken here would differ in every copy of the document. It is set
 * at the two places a command enters the system — the page`s `emit` and the
 * server`s HTTP `/api/commands` — and never in between. A command arriving over a
 * socket already carries the sender`s value and must keep it, because the sender
 * has already applied it optimistically and never applies the echo.
 */

// WHAT `patchDoc` MAY TOUCH. An allowlist rather than a denylist, because the
// failure mode of getting this wrong is a client silently rewriting something
// structural over the wire and every other client accepting it.
//
// THE REASON IT IS POSITIVE, concretely: a key nobody has thought of yet is
// refused, and a denylist can only refuse what someone remembered to name. The
// case that matters is the capability token. ADR 0002 makes a 128-bit
// `shareToken` the only thing guarding a plan, and it is deliberately stored in
// an S3 sidecar rather than on the document — because the document is broadcast
// to every connected client, round-tripped through save, and archived into
// History, so a token living on it would be handed to everyone who ever opened
// the plan and could not be revoked by reissuing the link. This list is what
// keeps that true against a later caller: `patchDoc({ shareToken })` is rejected
// without this file having to know the field exists.
//
// It bounds writing, not reading. Nothing here can un-broadcast a secret that
// something else already put on the document — the sidecar is what prevents
// that, and this is the second lock rather than the first.
//
// The channel lists are in here, and that is the deliberate compromise: a channel
// list is document-level furniture edited in Settings, so it gets last-write-wins
// like the title does. The cost is real and named in the report — two people
// adding a colour at the same time is a lost update.
/** @type {ReadonlySet<string>} */
/** Longest `notice` the server takes: room for a few lines, not a document. */
export const NOTICE_MAX = 1000;

/** Weekday keys of `hours.week`, in `getUTCDay()` order (0 = Sunday). */
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** WHY A LIST OF WINDOWS CANNOT BE STORED, or null. `[]` is fine (a day off); otherwise each entry is
 *  `["HH:MM", "HH:MM"]` with start before end ("24:00" is a legal end, nothing crosses midnight), and each
 *  starts at or after the one before ends. */
const windowsProblem = (w: any, what: string): string | null => {
  if (!Array.isArray(w)) return `${what} must be a list of ["HH:MM", "HH:MM"] windows ([] for a day off); got ${JSON.stringify(w)}`;
  let prev = -1;
  for (const x of w) {
    const m = Array.isArray(x) && x.length === 2
      && x.map((s: any) => typeof s === "string" && /^\d\d:[0-5]\d$/.test(s) ? +s.slice(0, 2) * 60 + +s.slice(3) : NaN);
    if (!m || m.some(Number.isNaN) || m[1]! > 1440 || m[0]! > 1440)
      return `${what}: every window must be ["HH:MM", "HH:MM"] within one day (end may be "24:00"); got ${JSON.stringify(x)}`;
    if (!(m[0]! < m[1]!)) return `${what}: a window must start before it ends and may not cross midnight; got ${JSON.stringify(x)}`;
    if (m[0]! < prev) return `${what}: windows must ascend and not overlap; ${JSON.stringify(x)} starts before the previous one ends`;
    prev = m[1]!;
  }
  return null;
};

/** "2026-02-30" matches the shape and is not a day. */
const realDate = (iso: string) => { const t = Date.parse(iso + "T00:00:00Z"); return t === t && new Date(t).toISOString().slice(0, 10) === iso; };

/** WHY `hours` CANNOT BE STORED (ADR 0021), or null: `{ week?: { mon: windows, ... }, dates?: { "YYYY-MM-DD": windows } }`. */
export const hoursProblem = (h: any): string | null => {
  if (!h || typeof h !== "object" || Array.isArray(h))
    return `hours must be an object { week, dates } — or null to clear it; got ${JSON.stringify(h)}`;
  for (const k of Object.keys(h)) if (k !== "week" && k !== "dates") return `hours has no ${JSON.stringify(k)}; it holds only week and dates`;
  for (const [part, v] of [["week", h.week], ["dates", h.dates]] as const) {
    if (v === undefined) continue;
    if (!v || typeof v !== "object" || Array.isArray(v))
      return `hours.${part} must be an object of ${part === "week" ? "weekday" : "date"} → windows; got ${JSON.stringify(v)}`;
    for (const [k, w] of Object.entries(v)) {
      if (part === "week" && !(WEEKDAYS as readonly string[]).includes(k))
        return `hours.week has no day ${JSON.stringify(k)}; the keys are ${WEEKDAYS.join(" ")}`;
      if (part === "dates" && !(/^\d{4}-\d\d-\d\d$/.test(k) && realDate(k)))
        return `hours.dates keys must be real "YYYY-MM-DD" dates; got ${JSON.stringify(k)}`;
      const bad = windowsProblem(w, `hours.${part}.${k}`);
      if (bad) return bad;
    }
  }
  return null;
};

export const PATCHABLE_DOC_KEYS = new Set([
  "title", "order", "start", "sprint",
  // THE ONE WORKING CALENDAR (ADR 0021): windows per weekday and per date. Absent is every hour.
  "hours",
  // AUTO-ORDER (2026-09-26): when true, the server settles every lane's queue
  // order after each change that could move it. See `settleRoom` in rooms.ts.
  "autoOrder",
  // WHETHER A SUGGESTED RANKING STEERS AUTO-ORDER (absent = it does). See `rankSuggestion`.
  "useRankSuggestion",
  // THE ZONE THE PLAN'S DAYS ARE COUNTED IN (v6). Changing it moves no recorded
  // time — those are instants — only which day each one falls on.
  "timeZone",
  // WHAT THE ROW LABEL SAYS, as an ordered list of parts. It is on the DOCUMENT
  // and not in the hash with zoom and view mode, and that is the whole point:
  // "Provision application server" appears six times in one plan and is ambiguous
  // to a READER, so a per-viewer setting would leave the shared link carrying the
  // ambiguity and every new reader rediscovering it. `channelLabels` is already
  // document-level display vocabulary; this is the same kind of fact.
  "labelParts",
  // THE DAY A WEEK BEGINS ON, 0 (Sunday) to 6. Display only: the scheduler never reads it.
  "weekStart",
  // THE NOTICE: free text pinned above the chart for everyone with the link. ONE
  // string rather than a line per writer, on purpose: a writer that shares it (the
  // calendar sync, an agent) rewrites only its own line inside it. Display only.
  "notice",
  "lanes", "colors", "borders", "fills", "shapes", "milestones",
  "channelLabels", "defaults", "arrows", "depth", "noColor",
  // HOW MUCH BREATHING ROOM A DEADLINE WANTS, in days. Read only by the reorder
  // search — see `scoreOf` in schedule.ts. It is a per-PLAN judgement rather
  // than a per-reader one (a plan of client deadlines wants more margin than a
  // plan of household chores), which is why it is here and not in the hash with
  // the zoom level.
  "dueBuffer",
  // HOW MANY DAYS OF FINISHED WORK THE BOARD'S DONE COLUMN SHOWS. Per plan for
  // the same reason as `dueBuffer`: a chores plan and a delivery plan want
  // different memory. Absent means 7 — see `boardColumns` in schedule.ts.
  // WHERE THE GRAPH'S NODES WERE PUT BY HAND. `{ [taskId]: {x, y} }`, and absent
  // for every plan nobody has dragged — the computed layout is the default and
  // stays the default.
  //
  // ON THE DOCUMENT rather than in `localStorage` with the zoom and the fold,
  // and that is a deliberate exception to "view state never in the document".
  // The other view state is a preference, remade in a second; an arrangement of
  // eighty nodes is WORK, and work that evaporates when you open the plan on
  // the other machine is work nobody will do twice. Last-write-wins is the
  // right merge for it too: two people cannot meaningfully co-drag one node.
  "graphPos",
]);

// NOT patchable, and neither is an oversight:
//   `tasks`        — every task mutation is a named command. This is the rule the
//                    ADR calls "no exceptions"; a patchable `tasks` reopens the
//                    whole-array write that commands exist to prevent.
//   `schemaVersion` — the migration ladder's, and it runs in the browser.

// ---------------------------------------------------------------------------
// VALIDATION — of the COMMAND, before it is applied.
//
// The line: this rejects a command that cannot be applied or that means nothing.
// It does NOT check that `value` names a real channel entry, that `dep` names a
// real task, or that the plan has no cycle. Those are properties of the resulting
// document and `invalid()` already decides them, on the server, after apply — a
// second copy here would be a second copy of the rules, drifting.
// ---------------------------------------------------------------------------

/** @param {unknown} v @returns {v is string} */
const str = (v: any) => typeof v === "string" && v.length > 0;

/** @param {unknown} v @returns {v is number} */
const num = (v: any) => typeof v === "number" && Number.isFinite(v);

/** AN INSTANT WITH ITS ZONE (schema v6). Any ISO offset is accepted and stored
 *  as `Z`; a string with no zone at all is refused, because "03:16" in nobody's
 *  zone is the ambiguity these fields stopped carrying. Day numbers — what
 *  every one of these was until v6 — are refused with a message that says so.
 *  @param {unknown} v @returns {v is string} */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const when = (v: any) => typeof v === "string" && INSTANT.test(v) && Number.isFinite(Date.parse(v));
/** The one stored shape: `toISOString()`, UTC. Pure — no clock. */
export const normWhen = (v: string) => new Date(Date.parse(v)).toISOString();
const whenMsg = (k: string, v: any) => `${k} must be an ISO instant with a zone — `
  + `"2026-09-26T08:16:00Z" or "2026-09-26T03:16:00-05:00" — or null to clear it`
  + (typeof v === "number" ? ". Day numbers were retired in schema v6." : "");
const WHEN_KEYS = ["notBefore", "refinedAt", "due"] as const;
/** EVERY FIELD A TASK HAS: `Task` in `types.ts`, and the spec's `Task` (a test holds all three equal).
 *  `addTask` refuses anything else, so a misspelt or retired field is an error, never a key nothing reads. */
export const TASK_FIELDS = new Set(["id", "label", "desc", "url", "ref", "lane", "border", "fill", "shape", "color",
  "dur", "deps", "ms", "notBefore", "noQueue", "planned", "recur", "sessions", "done", "refinedAt", "createdAt",
  "updatedAt", "comments", "due"]);

/** THE SESSIONS RULE, for `setSessions` and `addTask`: instants in order, each stopping before the next starts,
 *  only the last one still running. A done task has at least one, and none running: it finished at the last stop. */
const sessionsMsg = (list: any, done: any) => {
  if (!Array.isArray(list)) return "sessions must be an array of { start, stop } — stop is null while it runs";
  let prev = -Infinity;
  for (const [i, s] of list.entries()) {
    if (!s || typeof s !== "object" || !when(s.start)) return `sessions[${i}].start must be an ISO instant with a zone`;
    if (s.stop !== null && !when(s.stop)) return `sessions[${i}].stop must be an ISO instant with a zone, or null while it runs`;
    const a = Date.parse(s.start), b = s.stop === null ? Infinity : Date.parse(s.stop);
    if (a < prev) return `sessions[${i}] starts before the one above it stops — sessions must be in order, cannot overlap, and only the last may still be running`;
    if (b < a) return `sessions[${i}].stop is before its start`;
    prev = b;
  }
  if (!done) return null;
  return !list.length ? "a finished task keeps at least one session — it finished at the last stop"
    : list.some((s: any) => s.stop === null) ? "a finished task cannot have a running session" : null;
};

/** The task's sessions with one more, in time order. */
const withSession = (t: Task, s: { start: string; stop: string | null }) =>
  [...(t.sessions || []), s].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

/** THE PLANNED RULE, for `setPlanned` and `addTask`: promised stretches, in order, not overlapping, each with a real length. Same
 *  shape as a session but never running: a plan has an end. */
const plannedMsg = (list: any) => {
  const bad = sessionsMsg(list, false);
  if (bad) return bad.replace(/sessions/g, "planned");
  const i = list.findIndex((s: any) => s.stop === null || Date.parse(s.stop) <= Date.parse(s.start));
  return i < 0 ? null : `planned[${i}] must end after it starts`;
};

/** A DURATION, schema v7: whole minutes of lane time, above zero. A day is
 *  1440 — there are no working hours. It was a float of days until v7.
 *  @param {unknown} v @returns {v is number} */
const minutes = (v: any) => Number.isInteger(v) && v > 0;

/** @param {unknown} v @returns {v is Id[]} */
const idList = (v: any) => Array.isArray(v) && v.every(str);

/** @param {Doc} doc @param {Id} id @returns {Task | undefined} */
const find = (doc: Doc, id: Id) => doc.tasks.find((t: Task) => t.id === id);

/** The task `validateCommand` already proved is there. TypeScript's `!` has no
 *  JS equivalent, and a cast would assert the thing silently; this asserts it
 *  loudly, which is the right trade for a claim that is only true because the
 *  validator ran first.
 *  @param {Task | undefined} t @returns {Task} */
const must = (t: Task | undefined): Task => {
  if (!t) throw new Error("the task vanished between validate and apply");
  return t;
};

/** The lane-relative order of a lane's tasks, as global indices into `doc.tasks`.
 *  The lane's SLOTS: which positions in the array belong to this queue.
 *  @param {Doc} doc @param {Id} lane @returns {number[]} */
const laneSlots = (doc: Doc, lane: any) =>
  doc.tasks.reduce((out: any, t: Task, i: number) => (t.lane === lane && out.push(i), out),
    /** @type {number[]} */ ([]));

/** Returns a reason the command cannot be applied, or `null` if it can.
 *  `applyCommand` calls this itself — a server does not have to remember to.
 *  @param {Doc} doc @param {Command} cmd @returns {string | null} */
/** A task with the fields a caller could not reasonably know already filled in.
 *
 *  WHY THIS EXISTS. `addTask` needs eight fields and four of them are ids that
 *  must already be in the document's channel lists, so the smallest honest
 *  "add a task" was a read of the plan, four lookups and a guess about which
 *  value means "unset". The page did that inline in its + Task handler; a CLI
 *  wrote it again in Python; anything else driving this over HTTP had to work
 *  it out from `AGENTS.md`. Three copies of one convention, and the copies were
 *  already disagreeing — the page picks the LAST fill (least certain, for work
 *  added mid-meeting) where the script picked the first.
 *
 *  So the rule moves here, into the file both sides already import and the one
 *  an agent is told to read. `{ id, label }` is now a legal task.
 *
 *  `doc.defaults` FIRST, which is the channel editor's "make this the default"
 *  and already exists for exactly this question. Falling back to the first
 *  value of the list, except for `fill`, where the page's convention is the
 *  last one and that convention is worth keeping — a new task is uncosted.
 *
 *  Absent, not merely falsy: a caller who says `color: []` means "no project"
 *  and must not have one invented for them. */
export function withDefaults(doc: Doc, task: any) {
  const pick = (key: string, list: any[], fallback: any) =>
    ((doc as any).defaults || {})[key] ?? (fallback || {}).id;
  const out: any = { ...task };
  const lists: Record<string, any[]> = {
    lanes: (doc as any).lanes || [], borders: (doc as any).borders || [],
    fills: (doc as any).fills || [], shapes: (doc as any).shapes || [],
  };
  if (out.lane === undefined) out.lane = pick("lanes", lists.lanes!, lists.lanes![0]);
  if (out.border === undefined) out.border = pick("borders", lists.borders!, lists.borders![0]);
  if (out.shape === undefined) out.shape = pick("shapes", lists.shapes!, lists.shapes![0]);
  if (out.fill === undefined) out.fill = pick("fills", lists.fills!, lists.fills!.slice(-1)[0]);
  if (out.color === undefined) out.color = [];
  if (out.deps === undefined) out.deps = [];
  // NO DEFAULT DURATION, deliberately. This used to fill an absent `dur` with
  // zero, on the theory that "a bar with no length is visibly something to fill
  // in". It is the opposite of visible: a zero-length bar is easy to miss on a
  // hundred-row chart, and `scheduleView` exempts it from the lane queue, so the
  // plan schedules around work it has been told takes no time. `validateCommand`
  // refuses `addTask` without one instead — an estimate is a claim the caller
  // has to make, not a blank this function can fill for them.
  if (out.label === undefined) out.label = out.id;
  return out;
}

export function validateCommand(doc: Doc, cmd: any) {
  if (!cmd || typeof cmd !== "object") return "command must be an object";
  if (!doc || !Array.isArray(doc.tasks)) return "doc.tasks missing";

  // THE ENVELOPE FIELD, checked before the switch because every command may
  // carry it and none of them owns it. Shape only — a string is all the applier
  // needs, and this document is written by anyone holding the link, so the page
  // treats the value as text to parse rather than as a fact. An unparseable one
  // reads as no date rather than as a wrong one.
  if (cmd.at !== undefined && (typeof cmd.at !== "string" || !cmd.at))
    return "at must be a non-empty ISO timestamp string when present";

  // Read once, before the switch narrows `cmd` past the point where an unknown
  // `type` can still be named in an error message.
  const kind = /** @type {{ type?: unknown }} */ (cmd).type;

  // Every task command names a task, and every one of them fails the same way
  // when it is gone — someone deleted it while the command was in flight, which
  // is a normal race on a shared plan rather than a bug.
  /** @param {unknown} id @returns {string | null} */
  const needsTask = (id: Id) =>
    !str(id) ? "id must be a non-empty string"
      : !find(doc, id) ? `no task ${JSON.stringify(id)} in this plan`
      : null;

  switch (cmd.type) {
    case "addTask": {
      if (!cmd.task || typeof cmd.task !== "object") return "task must be an object";
      if (!str(cmd.task.id)) return "task.id must be a non-empty string";
      if (find(doc, cmd.task.id)) return `a task ${JSON.stringify(cmd.task.id)} is already in this plan`;
      const stray = Object.keys(cmd.task).find(k => !TASK_FIELDS.has(k));
      if (stray) return `task.${stray} is not a task field — the fields are ${[...TASK_FIELDS].join(", ")}`;
      // VALIDATED AS IT WILL BE STORED. The applier fills the channel fields a
      // caller omitted, so checking the raw payload would refuse `{id, label}`
      // for missing exactly the things about to be supplied.
      const t = withDefaults(doc, cmd.task);
      if (typeof t.label !== "string") return "task.label must be a string";
      // A DURATION IS PART OF WHAT A TASK IS, as of 2026-09-20. It used to be
      // optional and `withDefaults` filled the gap with zero; see `setDuration`
      // below for why that was worse than refusing.
      if (t.dur === undefined)
        return "task.dur is required — how many MINUTES this takes. There is no "
          + "default: a duration nobody stated used to become zero, which reads "
          + "as work that takes no time and quietly leaves the lane's queue.";
      if (!minutes(t.dur))
        return `task.dur must be a whole number of MINUTES greater than zero — got ${JSON.stringify(t.dur)}`;
      for (const k of WHEN_KEYS)
        if (t[k] != null && !when(t[k])) return whenMsg(`task.${k}`, t[k]);
      if (t.done !== undefined && t.done !== true) return "task.done must be true, or absent for unfinished work";
      if (t.sessions !== undefined || t.done) {
        const bad = sessionsMsg(t.sessions ?? [], t.done);
        if (bad) return `task.${bad}`;
      }
      if (t.planned !== undefined) {
        const bad = plannedMsg(t.planned);
        if (bad) return `task.${bad}`;
      }
      if (!idList(t.deps)) return "task.deps must be an array of task ids";
      if (!idList(t.color)) return "task.color must be an ARRAY of colour ids";
      for (const k of /** @type {const} */ (["lane", "border", "fill", "shape"]))
        if (!str(t[k])) return `task.${k} must be a non-empty ${k} id`;
      return null;
    }
    case "removeTask":
    case "renameTask":
    case "setTaskDesc":
    case "setTaskUrl":
    case "setTaskRef":
    case "setDuration":
    case "addDep":
    case "removeDep":
    case "setTaskChannel":
    case "setTaskColors":
    case "setNotBefore":
    case "setNoQueue":
    case "setPlanned":
    case "completePlanned":
    case "setRecur":
    case "startTask":
    case "stopTask":
    case "finishTask":
    case "reopenTask":
    case "setSessions":
    case "setRefined":
    case "setMilestone":
    case "setDue":
    case "moveTaskInLane":
    case "addComment":
    case "editComment":
    case "removeComment":
      break;
    case "addRankAnswer":
    case "removeRankAnswer": {
      for (const k of ["a", "b"] as const) {
        if (!str(cmd[k])) return `${k} must be a task id`;
        if (cmd.type === "addRankAnswer") {
          const t = find(doc, cmd[k]);
          if (!t) return `no task ${JSON.stringify(cmd[k])} in this plan`;
          if (t.done) return `${JSON.stringify(cmd[k])} is finished — finished work leaves the ranking`;
        }
      }
      if (cmd.a === cmd.b) return "a and b must be two different tasks";
      if (cmd.type === "addRankAnswer" && ![-1, 0, 1].includes(cmd.verdict))
        return "verdict must be -1 (a first), 1 (b first) or 0 (equal)";
      return null;
    }
    case "resetRanking":
      return null;
    case "setRankSuggestion": {
      if (!str(cmd.by) || !cmd.by.trim()) return "by must say who is suggesting";
      if (!Array.isArray(cmd.order) || cmd.order.length < 2) return "order must list at least two tasks";
      const seen = new Set<Id>();
      for (const row of cmd.order) {
        if (!row || !str(row.id)) return "every order entry needs a task id";
        const t = find(doc, row.id);
        if (!t) return `no task ${JSON.stringify(row.id)} in this plan`;
        if (t.done) return `${JSON.stringify(row.id)} is finished — finished work leaves the ranking`;
        if (seen.has(row.id)) return `${JSON.stringify(row.id)} is listed twice`;
        seen.add(row.id);
        if (typeof row.why !== "string" || !row.why.trim()) return `${JSON.stringify(row.id)} needs a reason (why)`;
        if (row.toss !== undefined && typeof row.toss !== "boolean") return `${JSON.stringify(row.id)}: toss must be true or false`;
      }
      return null;
    }
    case "patchDoc": {
      const p = cmd.patch;
      if (!p || typeof p !== "object" || Array.isArray(p)) return "patch must be an object";
      const keys = Object.keys(p);
      if (!keys.length) return "patch is empty";
      // The one refusal that names a removed key: the three were replaced in place, and a caller still sending them
      // is told where their meaning went instead of being left to guess.
      for (const k of ["workweek", "holidays", "workHours"])
        if (k in p) return `${k} was replaced by hours in schema v10 — send hours: { week: { mon: [["08:00", "17:00"]], ... }, dates: { "2026-12-25": [] } } (see ADR 0021)`;
      for (const k of keys)
        if (!PATCHABLE_DOC_KEYS.has(k))
          return `patchDoc may not touch ${JSON.stringify(k)}`
            + (k === "tasks" ? " — every task mutation is its own command"
              : k === "schemaVersion" ? " — the migration ladder owns that"
              : "");
      if (p.autoOrder != null && typeof p.autoOrder !== "boolean")
        return "autoOrder must be true (the server keeps every queue ordered) or false";
      if (p.useRankSuggestion != null && typeof p.useRankSuggestion !== "boolean")
        return "useRankSuggestion must be true or false";
      if (p.hours != null) {
        const bad = hoursProblem(p.hours);
        if (bad) return bad;
      }
      if (p.notice != null && !(typeof p.notice === "string" && p.notice.length <= NOTICE_MAX))
        return `notice must be text of at most ${NOTICE_MAX} characters, or null to clear it; got ${typeof p.notice === "string" ? `${p.notice.length} characters` : JSON.stringify(p.notice)}`;
      if (p.weekStart != null && !(Number.isInteger(p.weekStart) && p.weekStart >= 0 && p.weekStart <= 6))
        return `weekStart must be a whole number from 0 (Sunday) to 6 (Saturday), or null for Sunday; got ${JSON.stringify(p.weekStart)}`;
      if (p.timeZone != null) {
        try { new Intl.DateTimeFormat("en-US", { timeZone: p.timeZone }); }
        catch { return `timeZone must be an IANA zone name like "America/Chicago" — got ${JSON.stringify(p.timeZone)}`; }
      }
      return null;
    }
    default:
      return `unknown command ${JSON.stringify(kind)}`;
  }

  // Everything below names an existing task; check that once rather than
  // twelve times.
  const gone = needsTask(cmd.id);
  if (gone) return gone;

  // NO `default` HERE, ON PURPOSE. The `string | null` return type is what makes
  // this switch exhaustive: drop a case and the function can fall off the end,
  // which is `TS2366: Function lacks ending return statement`. That is the check,
  // and it survives the move to JSDoc — verified, not assumed.
  switch (cmd.type) {
    case "removeTask":
      return null;
    case "renameTask":
      return typeof cmd.label === "string" ? null : "label must be a string";
    case "setTaskDesc":
      return cmd.desc === null || typeof cmd.desc === "string" ? null
        : "desc must be a string, or null to clear it";
    // AN ALLOWLIST OF SCHEMES, and the only value check in this file that is
    // about safety rather than shape. A `url` is painted as an `href` in every
    // other viewer's browser, so `javascript:` on a task is script execution in
    // the room — and a plan is reachable by anyone holding its link, so "the
    // other writers are trustworthy" is not an assumption available here. The
    // renderer guards too; this is the half that can say WHY it refused.
    // SHAPE ONLY, no scheme rule, because a ref is not a URL — it is pasted into
    // one by a viewer who supplied the other half. The interpolation is
    // `encodeURIComponent`'d at the point of use, so a ref cannot escape the
    // query parameter it lands in whatever it contains. What IS refused is the
    // shape that is never a tracker id and always a mistake: something with a
    // newline in it, or something long enough to be a pasted URL.
    case "setTaskRef": {
      if (cmd.ref === null) return null;
      if (typeof cmd.ref !== "string") return "ref must be a string, or null to clear it";
      if (!cmd.ref.trim()) return "ref must not be blank — pass null to clear it";
      if (cmd.ref.length > 200) return `ref must be under 200 characters — got ${cmd.ref.length}`;
      return /[\n\r\t]/.test(cmd.ref)
        ? "ref must be a single identifier, not a line of text" : null;
    }
    case "setTaskUrl":
      return cmd.url === null ? null
        : typeof cmd.url !== "string" ? "url must be a string, or null to clear it"
        : /^https?:\/\//i.test(cmd.url) ? null
        : "url must start with http:// or https:// — got "
          + JSON.stringify(cmd.url.slice(0, 40));
    // ZERO IS LEGAL, AND IT IS NOT THE SAME CLAIM AS A SHORT TASK. A task that
    // consumes no working time is the right shape for the two things a personal
    // plan is full of: work that is done the moment it is started, and work
    // somebody else is doing. `spanOf` already returns 0 for it and the forward
    // pass already places it; only this guard stood in the way.
    // ZERO IS NOT A DURATION, and refusing it is a return to how this started —
    // `scheduleView` still carries the note that `dur: 0` "was refused by
    // validation until the personal fields landed". It was legalised for a plan
    // where most tasks had no meaningful length; that stopped being true (96 of
    // 100 carry real ones), and the four that did not meant "nobody has
    // estimated this" rather than "this takes no time".
    //
    // IT IS NOT A HARMLESS PLACEHOLDER, which is the reason this is refused
    // rather than tidied up later. `scheduleView` turns any zero-duration task
    // into a `noQueue` one, so it consumes no capacity and delays nothing: the
    // plan computes its dates as though that work does not exist, and says so
    // with a confident date. An unestimated task that is visibly unestimated
    // would be fine. This one is invisible.
    //
    // THE PAGE HAS ALWAYS AGREED. Its duration control floors at one minute and
    // its Add button sends `dur: 1`; no zero has ever come from a human using
    // this tool. Only the API accepted them.
    case "setDuration":
      return minutes(cmd.dur) ? null
        : `dur must be a whole number of MINUTES greater than zero (a day is 1440) — got ${JSON.stringify(cmd.dur)}`;
    case "addDep":
    case "removeDep":
      // Self-dependency is the one document-level rule worth duplicating: it is
      // not a plan `invalid()` would merely reject, it is a command with no
      // meaning, and saying so at the source beats saying so after apply.
      return !str(cmd.dep) ? "dep must be a non-empty task id"
        : cmd.dep === cmd.id ? "a task cannot depend on itself"
        : null;
    case "setTaskChannel":
      return cmd.channel !== "lane" && cmd.channel !== "border"
          && cmd.channel !== "fill" && cmd.channel !== "shape"
        ? `channel must be lane, border, fill or shape — got ${JSON.stringify(cmd.channel)}`
        : !str(cmd.value)
        ? "value must be a non-empty id from that channel's list, not free text"
        : null;
    case "setTaskColors":
      return idList(cmd.colors) ? null
        : "colors must be an ARRAY of colour ids ([] is legal — 'no system')";
    case "setNotBefore":
      return cmd.notBefore === null || when(cmd.notBefore) ? null : whenMsg("notBefore", cmd.notBefore);
    // IT HAD NO CHECK AT ALL until v6: listed in the first switch, missing from
    // this one, so any value — a string, an object — was applied as a sign-off.
    case "setRefined":
      return cmd.refinedAt === null || when(cmd.refinedAt) ? null : whenMsg("refinedAt", cmd.refinedAt);
    // A BOOLEAN, not a tri-state. `notBefore` takes null to clear because absent
    // and zero mean different things there; here absent and false are the same
    // claim — this task queues like everything else — so `false` clears it and
    // there is no third value to get wrong.
    case "setNoQueue":
      return typeof cmd.noQueue === "boolean" ? null
        : "noQueue must be true (this task does not occupy a lane slot) or false";
    // A PLAN IS A CLAIM ABOUT THE FUTURE, so it belongs to work that is still open: a finished task keeps no promises.
    case "setPlanned": {
      const t = must(find(doc, cmd.id));
      return t.done ? "that task is finished — reopen it (reopenTask) before planning it" : plannedMsg(cmd.planned);
    }
    // MOVES A STRETCH INTO THE FACTS: the resulting sessions have to be a legal list (in order, none overlapping).
    case "completePlanned": {
      const t = must(find(doc, cmd.id)), p = t.planned?.[cmd.index];
      if (!p) return `no planned stretch ${JSON.stringify(cmd.index)} on that task`;
      for (const k of ["start", "stop"] as const) if (cmd[k] !== undefined && !when(cmd[k])) return whenMsg(k, cmd[k]);
      return sessionsMsg(withSession(t, { start: cmd.start ?? p.start, stop: cmd.stop ?? p.stop }), false);
    }
    // A RULE NEEDS AN ANCHOR: the first occurrence is the task's own `notBefore`, or its `due` when it has no start. Changing `n` or `unit` on a task that
    // already repeats is refused, because the copies already made were dated by the old rule; `ahead` alone may change.
    case "setRecur": {
      const r = cmd.recur, t = must(find(doc, cmd.id));
      if (r === null) return null;
      if (!Number.isInteger(r.n) || r.n < 1 || r.n > 999) return "recur.n must be a whole number from 1 to 999";
      if (!["day", "week", "month"].includes(r.unit)) return 'recur.unit must be "day", "week" or "month"';
      if (r.ahead !== undefined && !(Number.isInteger(r.ahead) && r.ahead >= 0 && r.ahead <= 30)) return "recur.ahead must be a whole number from 0 to 30";
      if (t.recur) return t.recur.n === r.n && t.recur.unit === r.unit ? null : "this task already repeats on another interval; stop it repeating (recur: null) first";
      return t.notBefore || t.due ? null : "a repeating task needs a notBefore or a due: it is the first occurrence";
    }
    // `at` IS THE MOMENT: the server fills it with now, and the page sends its own clock.
    case "startTask": {
      const t = must(find(doc, cmd.id)), ss = t.sessions || [];
      return !when(cmd.at) ? "startTask needs `at`, the moment work started"
        : t.done ? "that task is finished — reopen it (reopenTask) before starting work on it"
        : ss.some(s => s.stop === null) ? "that task is already running"
        : ss.length && Date.parse(cmd.at) < Date.parse(ss[ss.length - 1]!.stop!) ? "that would start before the last session stopped"
        : null;
    }
    case "stopTask": {
      const open = (must(find(doc, cmd.id)).sessions || []).find(s => s.stop === null);
      return !when(cmd.at) ? "stopTask needs `at`, the moment work stopped"
        : !open ? "that task is not running"
        : Date.parse(cmd.at) < Date.parse(open.start) ? "that would stop before the session started" : null;
    }
    // FINISHED AT `at`, which may not come before the work it ends: the last session's start, or its stop.
    case "finishTask": {
      const t = must(find(doc, cmd.id)), last = (t.sessions || []).slice(-1)[0];
      return !when(cmd.at) ? "finishTask needs `at`, the moment it finished"
        : t.done ? "that task is already finished"
        : last && Date.parse(cmd.at) < Date.parse(last.stop ?? last.start) ? "that would finish before its last session"
        : null;
    }
    case "reopenTask":
      return must(find(doc, cmd.id)).done ? null : "that task is not finished";
    // A TASK THAT HAS BEEN WORKED ON STAYS WORKED ON: the list can be corrected, never emptied. Starting
    // over is a new task (split it), not a deleted history.
    case "setSessions": {
      const t = must(find(doc, cmd.id));
      return Array.isArray(cmd.sessions) && !cmd.sessions.length && t.sessions?.length
        ? "a task that has been worked on keeps at least one session — to start over, split it into a new task"
        : sessionsMsg(cmd.sessions, t.done);
    }
    case "setMilestone":
      return cmd.ms === null || str(cmd.ms) ? null
        : "ms must be a milestone id, or null to clear it";
    // NULL CLEARS, like `notBefore` and unlike `noQueue`. Zero is a real due
    // date — it is `doc.start` — so absence cannot be spelled as a falsy number
    // and needs its own value.
    case "setDue":
      return cmd.due === null || when(cmd.due) ? null : whenMsg("due", cmd.due);
    // COMMENTS. The comment's `id` is chosen by whoever sends it — the applier
    // may not invent one, because every copy of the document must get the same
    // id — and the server fills it (and `at`, `by`) for an API caller that left
    // them out. Text is Markdown, never empty.
    case "addComment": {
      const c = cmd.comment;
      if (!c || typeof c !== "object") return "comment must be an object: { id, text }";
      if (!str(c.id)) return "comment.id must be a non-empty string";
      if ((must(find(doc, cmd.id)).comments || []).some((x: any) => x.id === c.id))
        return `this task already has a comment ${JSON.stringify(c.id)}`;
      if (!str(c.text) || !c.text.trim()) return "comment.text must be non-empty text";
      if (c.at != null && !when(c.at)) return whenMsg("comment.at", c.at);
      if (c.by != null && (typeof c.by !== "string" || c.by.length > 60))
        return "comment.by must be a name of at most 60 characters";
      return null;
    }
    case "editComment":
    case "removeComment": {
      if (!(must(find(doc, cmd.id)).comments || []).some((x: any) => x.id === cmd.commentId))
        return `no comment ${JSON.stringify(cmd.commentId)} on this task`;
      if (cmd.type === "editComment" && (!str(cmd.text) || !cmd.text.trim()))
        return "text must be non-empty — remove the comment instead";
      return null;
    }
    case "moveTaskInLane": {
      const lane = must(find(doc, cmd.id)).lane;
      const n = laneSlots(doc, lane).length;
      return !Number.isInteger(cmd.toIndex) || cmd.toIndex < 0 || cmd.toIndex >= n
        ? `toIndex must be 0..${n - 1} — a position among lane ${JSON.stringify(lane)}'s `
          + `${n} tasks, not an index into doc.tasks`
        : null;
    }
  }
}

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------

// CLEARING A FIELD DELETES THE KEY rather than writing `null`, and that is not
// tidiness. `/save` decides whether to archive a version by comparing the
// serialised document to the newest one, so a `null` where the browser writes
// nothing is a byte difference that puts a spurious entry in the History panel —
// the log a human reads, filling with versions where nothing changed.
/** @param {Task} t @param {string} k */
const clear = (t: Task, k: string) => { delete t[k]; };

/** THE THREE COMMANDS THAT CHANGE WHAT A TASK SAYS, and the two consequences
 *  that follow from that and from nothing else: the sign-off is void, and the
 *  task counts as edited. One function because they are one event — "the wording
 *  changed" — and splitting them is how they would drift apart.
 *
 *  A SIGN-OFF IS ABOUT A PARTICULAR WORDING, so it cannot outlive it. Three
 *  commands change what a reader agreed to — the label, the description, the
 *  duration — and each one calls this instead of remembering the rule.
 *
 *  RESCHEDULING IS NOT EDITING. Everything else a command can do — a lane, a
 *  dependency, a colour, the day work started — leaves `updatedAt` alone, on
 *  purpose. A field that moved on every command would say "touched" when the
 *  question being asked is "rewritten", and ticking a task off would make it
 *  look freshly reworded.
 *
 *  `at` IS THE COMMAND'S OWN TIMESTAMP, and the applier must never reach for a
 *  clock instead. This function runs in the page AND in the server AND in every
 *  other client, independently, on the same command — the room broadcasts
 *  commands, not documents. `Date.now()` here would write a different instant
 *  into each copy of the document, and `/save` decides whether to archive by
 *  comparing serialised documents, so the plan would read as permanently dirty
 *  and mint versions nobody asked for. A missing or non-string `at` stamps
 *  nothing rather than guessing.
 *
 *  ONLY ON A REAL CHANGE. Every one of those three is sent on blur by a
 *  controlled input, so re-focusing a field and tabbing out re-sends the value
 *  it already had; clearing unconditionally would mean looking at a task could
 *  un-approve it. The callers pass the comparison because only they know which
 *  field to compare.
 *
 *  NOT SCOPED TO FINISHED WORK. Editing the description of a task you completed
 *  last week does un-refine it, and the channel simply stops asking about it —
 *  that scoping is a reading decision and lives in the page, not in the
 *  document. One rule here: the words changed, so the approval is void.
 *  @param {Task} t @param {boolean} changed */
const edited = (t: Task, changed: boolean, at: unknown) => {
  if (!changed) return;
  clear(t, "refinedAt");
  if (typeof at === "string") t.updatedAt = at;
};

// REPEATING TASKS (schema-free: `recur` is an optional field every copy carries, and the series is whoever shares `recur.series`).
// There is no template. The NEWEST copy (highest `i`) holds the live rule; finishing any copy, or setting the rule, tops the
// series up until `ahead` copies wait beyond the open one. Nothing is spawned by the clock: a copy nobody finishes stays open and
// overdue and the series stops growing, which is a visible signal rather than a pile of copies. Deleting the newest copy is how
// a series is shortened; `recur: null` ends it.
const seriesOf = (doc: Doc, t: Task) => doc.tasks.filter((c: Task) => c.recur?.series === t.recur!.series);

// WALL-CLOCK ARITHMETIC IN THE PLAN'S ZONE, so a 9:30 task stays at 9:30 across a DST change. Months clamp to the month's last day
// ("the 31st" lands on Feb 28), always from the anchor so the clamp is not remembered.
const shifted = (doc: Doc, from: string, k: number, r: Recur) => {
  const day = dayOfInstant(from, doc), whole = Math.floor(day), frac = day - whole;
  if (r.unit !== "month") return whole + k * r.n * (r.unit === "week" ? 7 : 1) + frac;
  const origin = Date.parse(doc.start + "T00:00:00Z"), d = new Date(origin + whole * 86400000);
  const m = d.getUTCMonth() + k * r.n, last = new Date(Date.UTC(d.getUTCFullYear(), m + 1, 0)).getUTCDate();
  return (Date.UTC(d.getUTCFullYear(), m, Math.min(d.getUTCDate(), last)) - origin) / 86400000 + frac;
};

const topUp = (doc: Doc, t: Task, at: unknown) => {
  const all = seriesOf(doc, t);
  const head = all.reduce((a: Task, b: Task) => (b.recur!.i > a.recur!.i ? b : a));
  const r = head.recur!;
  let open = all.filter((c: Task) => !c.done).length;
  for (let i = r.i + 1; open <= r.ahead; i++, open++) {
    const c: Task = JSON.parse(JSON.stringify(head));   // refinedAt rides along: the copy says exactly what was signed off
    for (const k of ["done", "sessions", "planned", "comments", "updatedAt", "createdAt"]) clear(c, k);   // a copy is planned by hand: the same times would double-book
    let id = `${r.series}-${i}`;
    while (find(doc, id)) id += "_";
    c.id = id;
    c.recur = { ...r, i };
    // Dated from the RULE, never from the head copy's own fields, so a due date edited on one copy stays on that copy.
    const occ = instantOfDay(shifted(doc, r.from, i, r), doc);
    if (r.on === "due") { c.due = occ; clear(c, "notBefore"); }
    else {
      c.notBefore = occ;
      if (r.lag !== undefined) c.due = instantOfDay(dayOfInstant(occ, doc) + r.lag, doc); else clear(c, "due");
    }
    if (typeof at === "string") c.createdAt = at;
    doc.tasks.push(c);
  }
};

/** THE GUARD THAT MAKES THE APPLIER'S SWITCH EXHAUSTIVE, and it is new here
 *  rather than ported, because the TypeScript version did not have it and was
 *  not exhaustive.
 *
 *  `applyCommand` returns void, so a missing case simply falls out of the switch
 *  and the command is silently a no-op — a dropped edit, which is the one
 *  failure this protocol most needs to make impossible. `validateCommand` is
 *  checked for free by its `string | null` return; this one never was. Passing
 *  `cmd` to a `never` parameter is what turns "you forgot a case" into
 *  `TS2345` at the point of the mistake.
 *  @param {never} x @returns {never} */
const never = (x: Task) => {
  throw new Error(`unhandled command in applyCommand: ${JSON.stringify(x)}`);
};

/** Mutates `doc` in place. Throws if the command is malformed — the guard is
 *  here rather than at every call site because the ADR's whole mitigation is
 *  that a mutation outside a command applier fails loudly.
 *  @param {Doc} doc @param {Command} cmd @returns {void} */
export function applyCommand(doc: Doc, cmd: any) {
  const wrong = validateCommand(doc, cmd);
  if (wrong) throw new Error(`bad ${cmd && cmd.type} command: ${wrong}`);

  switch (cmd.type) {
    case "addTask":
      // Appended. Last in its lane's queue is the honest default: a task nobody
      // has placed yet goes at the back of the team's list, and placing it is a
      // separate act with its own command.
      //
      // Through `withDefaults`, so `{id, label}` is a whole task. A caller that
      // sent every field gets its own values back untouched — the fill only
      // reaches keys that are absent.
      {
        const t = withDefaults(doc, cmd.task);
        for (const k of WHEN_KEYS) if (t[k] != null) t[k] = normWhen(t[k]);
        if (t.sessions) t.sessions = t.sessions.map((s: any) => ({ start: normWhen(s.start), stop: s.stop === null ? null : normWhen(s.stop) }));
        if (t.planned) t.planned = t.planned.map((x: any) => ({ start: normWhen(x.start), stop: normWhen(x.stop) }));
        // BORN NOW, unless the caller said otherwise. A task arriving with its
        // own `createdAt` keeps it — that is what an import or a fork restoring
        // a task needs, and rewriting it would date somebody's old work to the
        // moment it was copied.
        if (t.createdAt === undefined && typeof cmd.at === "string") t.createdAt = cmd.at;
        doc.tasks.push(t);
      }
      return;

    case "removeTask": {
      const id = cmd.id;
      retireRanked(doc, id, true);
      doc.tasks = doc.tasks.filter((t: Task) => t.id !== id);
      // The second half of the recipe, and the reason "remove a task" is a
      // command rather than two: leaving a dangling dep produces a plan `/save`
      // refuses, so a client that forgot this line would be broken at save time
      // instead of at the click.
      for (const t of doc.tasks)
        if (t.deps.includes(id)) t.deps = t.deps.filter((d: Id) => d !== id);
      return;
    }

    case "renameTask": {
      const t = must(find(doc, cmd.id));
      edited(t, t.label !== cmd.label, cmd.at);
      t.label = cmd.label;
      return;
    }

    case "setTaskDesc": {
      const t = must(find(doc, cmd.id));
      edited(t, (t.desc ?? null) !== cmd.desc, cmd.at);
      if (cmd.desc === null) clear(t, "desc"); else t.desc = cmd.desc;
      return;
    }

    case "setTaskUrl": {
      const t = must(find(doc, cmd.id));
      if (cmd.url === null) clear(t, "url"); else t.url = cmd.url;
      return;
    }

    case "setTaskRef": {
      const t = must(find(doc, cmd.id));
      // Trimmed on the way in. A ref arrives pasted out of another system's UI
      // about as often as it is typed, and " 1234 " is the same ref.
      if (cmd.ref === null) clear(t, "ref"); else t.ref = cmd.ref.trim();
      return;
    }

    case "setDuration": {
      const t = must(find(doc, cmd.id));
      edited(t, t.dur !== cmd.dur, cmd.at);
      t.dur = cmd.dur;
      return;
    }

    case "setRefined": {
      const t = must(find(doc, cmd.id));
      if (cmd.refinedAt === null) clear(t, "refinedAt");
      else t.refinedAt = normWhen(cmd.refinedAt);
      return;
    }

    case "addDep": {
      const t = must(find(doc, cmd.id));
      // Idempotent on purpose: two people drawing the same arrow is a race the
      // room produces constantly, and the second one must be a no-op rather than
      // a duplicate entry the scheduler then reads twice.
      if (!t.deps.includes(cmd.dep)) t.deps.push(cmd.dep);
      return;
    }

    case "removeDep": {
      const t = must(find(doc, cmd.id));
      const dep = cmd.dep;
      t.deps = t.deps.filter((d: Id) => d !== dep);
      return;
    }

    case "setTaskChannel":
      must(find(doc, cmd.id))[cmd.channel] = cmd.value;
      return;

    case "setTaskColors":
      must(find(doc, cmd.id)).color = cmd.colors.slice();
      return;

    case "setNotBefore": {
      const t = must(find(doc, cmd.id));
      if (cmd.notBefore === null) clear(t, "notBefore"); else t.notBefore = normWhen(cmd.notBefore);
      return;
    }

    // NONE OF THESE TOUCH `refinedAt` OR `updatedAt`: a comment is commentary
    // on the task, not a change to what it says, so there is no `edited()` here.
    case "addComment": {
      const t = must(find(doc, cmd.id));
      const c = cmd.comment;
      (t.comments ||= []).push({ id: c.id, text: c.text, at: normWhen(c.at ?? cmd.at), by: c.by ?? "agent" });
      return;
    }
    case "editComment": {
      const c = must(find(doc, cmd.id)).comments!.find((x: any) => x.id === cmd.commentId)!;   // validated
      if (c.text === cmd.text) return;
      c.text = cmd.text;
      if (cmd.at) c.editedAt = normWhen(cmd.at);
      return;
    }
    case "removeComment": {
      const t = must(find(doc, cmd.id));
      t.comments = t.comments!.filter((x: any) => x.id !== cmd.commentId);
      if (!t.comments.length) clear(t, "comments");
      return;
    }

    case "setDue": {
      const t = must(find(doc, cmd.id));
      if (cmd.due === null) clear(t, "due"); else t.due = normWhen(cmd.due);
      return;
    }

    case "setNoQueue": {
      const t = must(find(doc, cmd.id));
      // Cleared rather than written as `false`, for the same reason the other
      // optional fields are: the default is absence, and a document full of
      // `noQueue: false` archives a version for every task somebody toggled and
      // untoggled again.
      if (cmd.noQueue) t.noQueue = true; else clear(t, "noQueue");
      return;
    }

    case "setPlanned": {
      const t = must(find(doc, cmd.id));
      if (!cmd.planned.length) clear(t, "planned");
      else t.planned = cmd.planned.map((x: any) => ({ start: normWhen(x.start), stop: normWhen(x.stop) }));
      return;
    }
    case "completePlanned": {
      const t = must(find(doc, cmd.id)), [p] = t.planned!.splice(cmd.index, 1);
      if (!t.planned!.length) clear(t, "planned");
      t.sessions = withSession(t, { start: normWhen(cmd.start ?? p!.start), stop: normWhen(cmd.stop ?? p!.stop) });
      return;
    }

    case "setRecur": {
      const t = must(find(doc, cmd.id)), r = cmd.recur;
      // Off ends the whole series: clearing one copy would leave the newest one repeating.
      if (r === null) { for (const c of seriesOf(doc, t)) clear(c, "recur"); return; }
      const ahead = r.ahead ?? 1;
      if (t.recur) { for (const c of seriesOf(doc, t)) c.recur!.ahead = ahead; }
      else {
        const on = t.notBefore ? "notBefore" : "due";
        t.recur = { n: r.n, unit: r.unit, ahead, series: t.id, i: 0, from: t[on]!, on,
          ...(t.notBefore && t.due ? { lag: dayOfInstant(t.due, doc) - dayOfInstant(t.notBefore, doc) } : {}) };
      }
      topUp(doc, t, cmd.at);
      return;
    }

    // SESSIONS ARE FACTS, NOT WORDING: none of these goes through `edited`, so none voids a sign-off.
    // Stopping is not finishing: stopping for the night leaves the task paused, not done.
    case "startTask": {
      const t = must(find(doc, cmd.id));
      (t.sessions ||= []).push({ start: normWhen(cmd.at), stop: null });
      return;
    }
    case "stopTask": {
      const open = must(find(doc, cmd.id)).sessions!.find(s => s.stop === null)!;
      open.stop = normWhen(cmd.at);
      return;
    }
    case "setSessions": {
      const t = must(find(doc, cmd.id));
      if (!cmd.sessions.length) { clear(t, "sessions"); return; }
      t.sessions = cmd.sessions.map((s: any) => ({ start: normWhen(s.start), stop: s.stop === null ? null : normWhen(s.stop) }));
      return;
    }
    // DONE IS NOT BEING WORKED ON: finishing stops the running session at the finish, and work never
    // started gets a session of no length there, so every finished task says when it finished.
    case "finishTask": {
      const t = must(find(doc, cmd.id)), at = normWhen(cmd.at), ss = (t.sessions ||= []);
      // Finishing is what takes work out of the ranking — measured before the flag lands, while the
      // task is still one of the ranked.
      retireRanked(doc, t.id);
      const open = ss.find(s => s.stop === null);
      if (open) open.stop = at;
      else if (!ss.length) {
        // NEVER STARTED, BUT PLANNED: finishing says it happened, so the stretches already under way are the work (clipped to
        // the finish). With none, a session of no length as before.
        const began = (t.planned || []).filter(x => Date.parse(x.start) <= Date.parse(at))
          .map(x => ({ start: x.start, stop: Date.parse(x.stop) < Date.parse(at) ? x.stop : at }));
        ss.push(...(began.length ? began : [{ start: at, stop: at }]));
      }
      clear(t, "planned");   // done keeps no promises: what was not worked is dropped
      t.done = true;
      if (t.recur) topUp(doc, t, cmd.at);
      return;
    }
    case "reopenTask":
      clear(must(find(doc, cmd.id)), "done");
      return;

    case "setMilestone": {
      const t = must(find(doc, cmd.id));
      if (cmd.ms === null) clear(t, "ms"); else t.ms = cmd.ms;
      return;
    }

    case "moveTaskInLane": {
      // THE MOVE IS A PERMUTATION OF THE LANE'S OWN SLOTS. The positions in
      // `doc.tasks` that belong to this lane stay exactly where they are; only
      // which task sits in each of them changes.
      //
      // Two reasons, and the second is the multiplayer one:
      //
      //   1. It is bit-for-bit what `suggestReorders` in `schedule.js` measures,
      //      so a `/reorder` suggestion `{id, to}` IS
      //      `{type:"moveTaskInLane", id, toIndex: to}`. A different definition
      //      of "position N" would make the endpoint's advice mean something
      //      slightly other than what applying it does.
      //
      //   2. It never disturbs another lane's positions, so two people
      //      reordering different teams commute perfectly. A plain global splice
      //      would drag every task it passes over, and two such splices would
      //      interleave — the exact failure the ADR rejected CRDTs to avoid,
      //      reintroduced by the applier.
      const t = must(find(doc, cmd.id));
      const slots = laneSlots(doc, t.lane);
      const order = slots.map((i: number) => doc.tasks[i]);
      const from = order.indexOf(t);
      order.splice(cmd.toIndex, 0, order.splice(from, 1)[0]);
      order.forEach((x: Task, k: string) => { doc.tasks[slots[k]] = x; });
      return;
    }

    case "addRankAnswer": {
      const key = pairKeyOf(cmd.a, cmd.b);
      const log = ((doc as any).rankLog || []).filter(([k]: LogEntry) => k !== key);
      log.push([key, orient(cmd.verdict, flipOfIds(cmd.a, cmd.b))]);
      (doc as any).rankLog = log;
      return;
    }

    case "removeRankAnswer": {
      const key = pairKeyOf(cmd.a, cmd.b);
      setRankLog(doc, ((doc as any).rankLog || []).filter(([k]: LogEntry) => k !== key));
      return;
    }

    case "resetRanking":
      delete (doc as any).rankLog;
      return;

    case "setRankSuggestion":
      doc.rankSuggestion = {
        by: cmd.by.trim(), at: cmd.at ?? "", order: cmd.order.map((r: { id: Id }) => r.id),
        notes: Object.fromEntries(cmd.order.map((r: { id: Id; why: string; toss?: boolean }) =>
          [r.id, r.toss ? { why: r.why.trim(), toss: true as const } : { why: r.why.trim() }])),
      };
      return;

    case "patchDoc":
      for (const [k, v] of Object.entries(cmd.patch)) {
        if (v === null) delete doc[k]; else doc[k] = v;
      }
      return;

    default:
      return never(cmd);
  }
}

// ---------------------------------------------------------------------------
// THE RANKING — “which should happen first?”
//
// ONE PLAN-LEVEL RANKING OVER UNFINISHED WORK, asked a pair at a time and stored as the
// answers only (`doc.rankLog`); the order is derived here, by the same vendored
// @rascaltwo/pairwise-sorter the page asks with, so the page and the server can never
// disagree about it. Auto-order reads it as a tie-break after dates (`scoreOf` in
// schedule.ts): it can reorder work only where the dates do not care.
//
// ARRIVAL ORDER IS NOT QUEUE ORDER, and that is load-bearing. Binary insertion replays
// answers in a fixed order; replayed in `doc.tasks` order — which IS the queue, and which
// Auto-order changes — every move it made would change the replay, strand answers, and
// turn ranked work back into unranked work for it to shuffle again. Creation time is
// stable, and new work arrives last, so each new task costs about log2(n) questions.
// ---------------------------------------------------------------------------

/** The tasks in the ranking — everything not finished — in their stable arrival order.
 *  @param {Doc} doc @returns {Task[]} */
export function rankedTasks(doc: Doc): Task[] {
  return doc.tasks.filter((t: Task) => !t.done)
    .sort((a: Task, b: Task) => ((a.createdAt || "") < (b.createdAt || "") ? -1 : (a.createdAt || "") > (b.createdAt || "") ? 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const asItems = (tasks: Task[]): RankItem[] => tasks.map((t: Task) => ({ key: t.id, title: t.label, tags: [] }));

/** THE PAIRS THE DEPENDENCIES ALREADY ANSWER. A task that waits on another, directly or
 *  through a chain (finished links included), cannot happen first, so asking about the
 *  pair is a question with one possible answer. These are worked out on every read and
 *  never stored: add a dependency and the question disappears, remove it and it comes
 *  back. Keyed by pair; each entry says the prerequisite comes first, marked implied.
 *  ponytail: every related pair, so a long chain is O(n²) entries — derive only the pairs
 *  replay asks about if that ever shows up in a profile. */
function depAnswers(doc: Doc, tasks: Task[]): Map<string, LogEntry> {
  const byId = new Map<Id, Task>(doc.tasks.map((t: Task) => [t.id, t]));
  const ranked = new Set(tasks.map(t => t.id));
  const out = new Map<string, LogEntry>();
  for (const t of tasks) {
    const seen = new Set<Id>(), stack = [...(t.deps || [])];
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d) || d === t.id) continue;
      seen.add(d);
      if (ranked.has(d)) out.set(pairKeyOf(d, t.id), [pairKeyOf(d, t.id), orient(-1, flipOfIds(d, t.id)), true]);
      stack.push(...(byId.get(d)?.deps || []));
    }
  }
  return out;
}

/** The answers the ranking replays: what the dependencies settle, then what the person said
 *  about every other pair. A dependency outranks a stored answer that contradicts it — it is
 *  a fact about the plan, not an opinion. Derived entries come first so an undo takes back
 *  the person's last answer, not one of these. */
export function rankLogOf(doc: Doc, tasks: Task[] = rankedTasks(doc), own: LogEntry[] = doc.rankLog || []): LogEntry[] {
  const deps = depAnswers(doc, tasks);
  return [...deps.values(), ...own.filter(([k]: LogEntry) => !deps.has(k))];
}

/** Where the ranking stands: each placed task's rank (tied tasks share one), the tasks it
 *  has not placed yet, and the next pair it would ask about.
 *  @param {Doc} doc */
export function rankOf(doc: Doc): { rank: Map<Id, number>; unranked: Id[]; next: [Id, Id] | null } {
  return rankFrom(doc, rankedTasks(doc), doc.rankLog || []);
}

/** The ranking of `tasks` from the answers `own` (plus what the dependencies settle). The
 *  person's ranking and a suggestion differ only in which tasks and which answers. */
function rankFrom(doc: Doc, tasks: Task[], own: LogEntry[]): { rank: Map<Id, number>; unranked: Id[]; next: [Id, Id] | null } {
  const items = asItems(tasks), log = rankLogOf(doc, tasks, own);
  const r = replay(items, log);
  // ONE PLACED TASK IS NOT A RANKING. Replay always seats the first task without asking
  // anything, so before any answer it would read as "ranked 1st" and the rest as
  // unranked — a badge one short, and an Inspector calling an unanswered task "1 of n".
  const placed = r.order.length < 2 ? [] : r.order;
  const { rankById } = rankRows(placed, items, log);
  return {
    rank: rankById,
    unranked: [...r.order.filter((i: number) => !placed.includes(i)), ...r.unplaced].map((i: number) => tasks[i]!.id),
    next: r.next ? [tasks[r.next[0]]!.id, tasks[r.next[1]]!.id] : null,
  };
}

/** Take a task out of the ranking without re-asking anything: its answers go, and every
 *  pair the order before settles is filled in as implied (`retireLog`). A no-op on a plan
 *  that has never ranked, so those documents stay byte-for-byte what they were. */
function retireRanked(doc: Doc, id: Id, removing = false): void {
  retireSuggested(doc, id);
  const log = (doc as any).rankLog as LogEntry[] | undefined;
  if (!log || !log.length) return;
  // Replayed WITH the dependency answers, so the order it fills from is the real one — and
  // stored without them, as always.
  // Filtered by what the dependencies settle AFTERWARDS: removing a task cuts its links, and
  // a pair joined only through it is then an implied answer worth keeping.
  const tasks = rankedTasks(doc);
  // Finishing keeps them — a finished link still orders what is on either side of it.
  const after = !removing ? doc : { ...doc, tasks: doc.tasks.filter((t: Task) => t.id !== id)
    .map((t: Task) => ({ ...t, deps: (t.deps || []).filter((d: Id) => d !== id) })) } as Doc;
  const deps = depAnswers(after, tasks.filter(t => t.id !== id));
  setRankLog(doc, retireLog(asItems(tasks), rankLogOf(doc, tasks), [id]).filter(([k]: LogEntry) => !deps.has(k)));
}

/** A finished or removed task leaves the suggestion's order and notes. Nothing else to mend:
 *  its answers are worked out on every read. One task is not an order, so a suggestion left
 *  with fewer than two goes. */
function retireSuggested(doc: Doc, id: Id): void {
  const s = doc.rankSuggestion;
  if (!s || !Object.hasOwn(s.notes, id)) return;
  s.order = s.order.filter((x: Id) => x !== id);
  delete s.notes[id];
  if (s.order.length < 2) delete doc.rankSuggestion;
}

/** THE ANSWERS A SUGGESTION IMPLIES, worked out by the sorter's own insertion: place each task by
 *  binary search, and wherever the search needs a pair nobody has answered, answer it from the
 *  suggested order. Those are exactly the pairs the Rank tab would have put to the person, in the
 *  order it would have put them. It is `replay`'s loop (and `sortIndices`') with the answer given
 *  where `replay` would stop and ask, so it makes one pass instead of starting over after every
 *  answer; `rank-suggestion.test.ts` holds it to the start-over version, which is the plain way to
 *  say what it means.
 *
 *  The dependencies are known answers from the start, so one that contradicts the order is never
 *  asked — a dependency outranks an opinion, mine as much as anybody's — and because this runs on
 *  every read, adding or removing one afterwards cannot leave the suggestion incomplete.
 *
 *  Nothing else goes in: the person's own answers are deliberately not read here. The suggestion is a
 *  backdrop that stands on its own, and they take effect over it where the two meet (`suggestReorders`).
 */
function suggestionLog(doc: Doc): LogEntry[] {
  const place = new Map<Id, number>((doc.rankSuggestion?.order || []).map((id: Id, i: number) => [id, i]));
  const tasks = rankedTasks(doc).filter((t: Task) => place.has(t.id));
  const answers = new Map<string, Verdict>(rankLogOf(doc, tasks, []).map(([k, v]: LogEntry) => [k, v]));
  const fresh: LogEntry[] = [];
  /** The settled verdict between items `a` and `b` (< 0: `a` first), or null. */
  const known = (a: number, b: number): Verdict | null => {
    const ia = tasks[a]!.id, ib = tasks[b]!.id, v = answers.get(pairKeyOf(ia, ib));
    return v === undefined ? null : orient(v, flipOfIds(ia, ib));
  };
  const out: number[] = [];
  for (let n = 0; n < tasks.length; n++) {
    let [lo, hi] = slotsFor(n, out, known);
    while (lo < hi) {
      const mid = (lo + hi) >> 1, o = out[mid]!;
      let v = known(n, o);
      if (v === null) {
        const ia = tasks[n]!.id, ib = tasks[o]!.id, key = pairKeyOf(ia, ib);
        v = place.get(ia)! < place.get(ib)! ? -1 : 1;
        const stored = orient(v, flipOfIds(ia, ib));
        answers.set(key, stored);
        fresh.push([key, stored]);
      }
      if (v < 0) hi = mid; else lo = mid + 1;
    }
    out.splice(lo, 0, n);
  }
  return fresh;
}

/** Where the SUGGESTED ranking stands: each covered task's rank, same reading as `rankOf`.
 *  Empty when there is no suggestion. */
export function suggestedRankOf(doc: Doc): { rank: Map<Id, number>; next: [Id, Id] | null } {
  if (!doc.rankSuggestion) return { rank: new Map(), next: null };
  const tasks = rankedTasks(doc).filter((t: Task) => Object.hasOwn(doc.rankSuggestion!.notes, t.id));
  const { rank, next } = rankFrom(doc, tasks, suggestionLog(doc));
  return { rank, next };
}

/** An empty log is no log: the key is deleted, like every other cleared field. */
function setRankLog(doc: Doc, log: LogEntry[]): void {
  if (log.length) (doc as any).rankLog = log; else delete (doc as any).rankLog;
}
