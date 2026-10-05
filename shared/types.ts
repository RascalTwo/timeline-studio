// THE DOMAIN, ONCE, FOR BOTH SIDES.
//
// These types were prose and JSDoc until 2026-09-05: `commands.js` carried
// `@typedef` blocks that nothing checked, and `schedule.js` carried none at all.
// The shapes below are those typedefs promoted verbatim — the same fields, the
// same optionality — with the difference that the compiler now enforces them and
// the page, the server and the tests all read the one declaration.
//
// WHY THIS FILE IS IN `shared/`. The scheduler runs in the browser and in the
// Node server, from ONE copy (ADR 0001), and the deploy hashes what ships to the
// bucket against what ships to the image. A second declaration of `Task` on
// either side would be exactly the drift that contract exists to prevent, so the
// types live where the code they describe lives.
//
// The comments here are deliberately thin: every one of these fields is
// explained at length where it is USED — `Task.ref` and `Task.url` in
// `commands.js`, the day-number convention in `schedule.js`. Repeating that here
// would be the second copy this whole arrangement argues against.

/** A task id, a channel-value id, a milestone id. All the same shape. */
export type Id = string

/** The four single-valued channels. `color` is a LIST and has its own command. */
export type ChannelKey = "lane" | "border" | "fill" | "shape"

/** AN INSTANT, as a UTC ISO string — `2026-09-26T08:16:00.000Z`, the shape
 *  `toISOString()` gives. Every recorded or chosen time on a task is one (v6).
 *  They were DAY NUMBERS until then — float days since `doc.start`, the
 *  fraction being the writer's wall clock — and that format hid three bugs:
 *  "the whole day" and "that instant" differed only by being an integer, there
 *  was no zone, and moving `doc.start` moved every recorded fact. The scheduler
 *  still counts in day numbers; `dayNumbers()` in schedule.ts projects these
 *  into them, in the plan's `timeZone`, and nothing else should. */
export type When = string

/** The fields that are `When` on a stored task and day numbers once
 *  projected for the scheduler. The runtime list is `WHEN_FIELDS` in
 *  schedule.ts, typed against this so the two cannot disagree. */
export type WhenField = "notBefore" | "refinedAt" | "due"

/** One comment on a task. `at` and `by` are when and who wrote it — `by` is the
 *  same free-text attribution as a command's `x-timeline-by`; `editedAt` is set
 *  once the text has been changed. */
export interface Comment {
	id: Id
	text: string
	at: When
	by: string
	editedAt?: When
}

/** ONE STRETCH OF WORK, as instants. `stop` is null while it is running. */
export interface Session { start: string; stop: string | null }

export interface Task {
	id: Id
	label: string
	desc?: string
	url?: string
	ref?: string
	lane: Id
	border: Id
	fill: Id
	shape: Id
	color: Id[]
	/** WHOLE MINUTES of lane time, greater than zero (schema v7). A day of work
	 *  is 1440: the scheduler has no working hours. It was a float of DAYS until
	 *  v7, which is how `0.03` — 43.2 minutes nobody meant — got in. */
	dur: number
	deps: Id[]
	ms?: Id
	notBefore?: When
	noQueue?: boolean
	/** PLANNED STRETCHES: what is promised, same shape as `sessions` (what happened) but never running. The scheduler holds
	 *  these times and works around them. See `plannedOf` in schedule.ts. */
	planned?: { start: When; stop: When }[]
	/** REPEATS ON A CALENDAR. Present on every copy of a repeating task; `setRecur` writes it, and finishing a copy
	 *  tops the series back up (see `topUp` in commands.ts). */
	recur?: Recur
	/** THE WORK ACTUALLY DONE, as a list of stretches: what start/stop/setSessions write. Worked time is
	 *  the wall-clock sum. Ordered, non-overlapping, only the last may be running. The only record of
	 *  work (v8, ADR 0016): when it started is the first start, when it finished the last stop. */
	sessions?: Session[]
	/** FINISHED. `finishTask` sets it, `reopenTask` clears it; absent means not finished. A done task
	 *  always has a session and none running. */
	done?: true
	/** WHEN A HUMAN LAST READ THIS TASK AND AGREED WITH IT, as an instant. Absent means nobody has, which is how every task is born.
	 *
	 *  The only field here that describes the READER rather than the work, and
	 *  the only one the applier clears by itself: changing the label, the
	 *  description or the duration voids it, because those three are what a
	 *  sign-off was about. That is what separates it from a checkbox — there is
	 *  no way to change what a task says and leave it looking approved. */
	refinedAt?: When
	/** WHEN THIS TASK WAS FIRST ADDED, and when its WORDING last changed — ISO
	 *  instants, both absent until something sets them.
	 *
	 *  ISO FROM THE START, and the first fields that were: the other task times
	 *  followed in v6 (`When`), for the reason these began that way — moving
	 *  `doc.start` must not move a recorded moment.
	 *
	 *  `updatedAt` MEANS THE SAME THING `refinedAt` BEING CLEARED MEANS: the
	 *  label, the description or the duration actually changed. Rescheduling is
	 *  not editing — moving a task between lanes, drawing a dependency, or
	 *  ticking off the day it finished leaves it untouched, because a field that
	 *  moves on everything cannot distinguish "I rewrote this" from "I worked on
	 *  it". The same three fields, decided in one place: see `edited()` in
	 *  commands.ts.
	 *
	 *  THE VALUE COMES OFF THE COMMAND (`cmd.at`), never off a clock in the
	 *  applier — see the note there. Absent on a task older than the fields
	 *  themselves; the version history is what answers for those. */
	createdAt?: string
	updatedAt?: string
	/** THE CONVERSATION ON A TASK, oldest first — like comments on a GitHub
	 *  issue. Commentary over time (progress, findings, links), as opposed to
	 *  `desc`, which says what the task IS and is what a sign-off covers. So a
	 *  comment never clears `refinedAt` and never moves `updatedAt`. */
	comments?: Comment[]
	/** An instant this task must FINISH by. The
	 *  opposite direction to `notBefore`, which is a floor on starting, and
	 *  distinct from the date the scheduler predicts — the gap between the two is
	 *  the number worth reading. A milestone carries a date for an outcome several
	 *  tasks feed; this is for one task that simply has a deadline. */
	due?: When
	/** `owner` WAS HERE AND IS GONE (2026-09-20), with `setOwner`. It named who
	 *  does a task when that is not you, and it was set on nothing — zero tasks
	 *  in the live plan, beside zero uses of the `noQueue` it was meant to pair
	 *  with. Somebody else's work is still their own task that yours depends on,
	 *  which was never this field's doing, and `noQueue` — the half that keeps
	 *  their days out of your capacity — stays. Their name goes in the title.
	 *
	 *  `dropped` WAS HERE AND IS GONE (2026-09-20). It marked work deliberately
	 *  abandoned — the one piece of progress that cannot be derived, since
	 *  "decided not to" and "never got to" are the same pair of absent actuals.
	 *  Rascal Two retired the concept: work he decides against is DELETED, and the
	 *  version history is the record. The only thing that still reads the flag is
	 *  `scheduleView`, so restoring a version written before this date does not
	 *  resurrect abandoned work as live tasks. */
	/** A key this protocol does not know about survives a round trip instead of
	 *  being silently dropped by the applier. Deliberate, and load-bearing. */
	[k: string]: any
}

/** One value of a channel — a lane, a colour, a border style, a fill, a shape. */
export interface ChannelValue {
	id: Id
	label: string
	/** Lanes only: how many tasks the team can have in flight at once. */
	cap?: number
	/** Lanes only: the short form used where a row label has no room for `label`. */
	short?: string

	// Channel-specific payload. One interface rather than five because a channel
	// value is the same THING everywhere — an id, a label, and whatever that
	// channel draws with — and the page reads them through one set of helpers.
	/** colors: the swatch. */
	color?: string
	/** borders: "none" | "dotted" | "dashed" | "solid". */
	style?: string
	/** fills: the hatch pattern name. */
	pattern?: string
	/** shapes: the bar's silhouette. */
	shape?: string
	[k: string]: any
}

export interface Milestone {
	id: Id
	label: string
	/** ISO date, `YYYY-MM-DD`. */
	date: string
	[k: string]: any
}

/** A document whose tasks are `T`: `Doc` as stored, `DayDoc` as the scheduler
 *  reads it. Generic rather than `Omit`, because the index signature below makes
 *  `Omit<Doc, "tasks">` forget every named field. */
export interface DocOf<T> {
	schemaVersion: number
	tasks: T[]
	/** ISO date the scheduler's day numbers count from. Moving it moves the
	 *  axis, never a recorded time — those are instants (v6). */
	start?: string
	/** IANA zone the plan's days are counted in (`America/Chicago`). Both the
	 *  server and the page read it, so "today" and "which day did this happen"
	 *  have one answer. Every plan has one from v6. */
	timeZone?: string
	/** AUTO-ORDER. When true the server re-runs the reorder search after every
	 *  change that could move a queue and applies the moves itself, as
	 *  "Auto-order", until no single move helps. Callers that must see the
	 *  settled plan pass `settle=1`. A manual queue move stands unless it makes
	 *  the plan worse. */
	autoOrder?: boolean
	/** THE RANKING'S ANSWERS — "which should happen first?", one plan-level ranking over
	 *  unfinished work. Only the answers are stored; the order is derived from them
	 *  (`rankOf` in commands.ts), and Auto-order uses it as a tie-break after dates. Each
	 *  entry is `[pairKey, verdict, implied?]`, written by the rank commands and by
	 *  finishing or removing a task, never by `patchDoc`. Absent means nothing ranked. */
	rankLog?: [string, -1 | 0 | 1, true?][]
	/** WHETHER AN UNADOPTED SUGGESTION STEERS AUTO-ORDER. Absent or true: it does, as a second
	 *  key under the person's own ranking (`rankSuggestion`). False: it is display only. */
	useRankSuggestion?: boolean
	/** A SUGGESTED RANKING — a proposed order (an agent's, or one the person pasted), held apart
	 *  from their own `rankLog` as a BACKDROP under their answers: it orders what they have not
	 *  answered, is never turned into their answers and never discarded; the next one replaces it.
	 *  Only the ORDER is stored (first to happen first); the answers it implies are worked out on
	 *  every read by the ordinary replay with the current dependencies (`suggestedRankOf`), so a
	 *  dependency added or removed afterwards cannot leave it incomplete. `notes` has the reason per
	 *  task. It covers only the tasks it was written for; later tasks have no suggested place.
	 *  Absent means no suggestion. */
	rankSuggestion?: {
		by: string
		at: string
		order: Id[]
		notes: Record<Id, { why: string; toss?: true }>
	}
	title?: string
	lanes?: ChannelValue[]
	colors?: ChannelValue[]
	borders?: ChannelValue[]
	fills?: ChannelValue[]
	shapes?: ChannelValue[]
	milestones?: Milestone[]
	/** 7 slots indexed the way `getUTCDay()` counts — 0 is Sunday. */
	workweek?: number[]
	/** ISO dates nobody works, whatever the weekday. */
	holidays?: string[]
	/** The working window of every working day, `["HH:MM", "HH:MM"]` wall clock in
	 *  `timeZone`, start before end. Absent means the whole day. See ADR 0014. */
	workHours?: [string, string]
	/** The day a week begins on, counted like `getUTCDay()` — 0 is Sunday. Absent means Sunday.
	 *  Where the calendar's week starts and where the timeline draws its week rules. */
	weekStart?: number

	// The rest of PATCHABLE_DOC_KEYS — document-level furniture the page edits in
	// Settings. Listed rather than left to the index signature so a read of
	// `doc.sprint.weeks` is checked instead of falling through to `unknown`.
	order?: number
	sprint?: { weeks: number; start: string }
	/** What a row label says, as an ordered list of channel names + "title". */
	labelParts?: string[]
	/** The display vocabulary: what this plan calls each channel. */
	channelLabels?: Record<string, string>
	/** Which channel value a task gets when it does not name one. */
	defaults?: Record<string, Id>
	arrows?: unknown
	depth?: unknown
	/** The hex a task with an empty colour list is drawn in. Typed rather than
	 *  `unknown` because the channel editor puts it straight into an `<input
	 *  type="color">`, which is a `string` on both sides of the wire. */
	noColor?: string
	/** How many days of finished work the Board's Done column shows. Absent
	 *  means 7; `0` hides the column's cards. See `boardColumns`. */

	[k: string]: any
}

/** A document that has been through `applyMigrations` — which is every document
 *  the PAGE ever holds, because `adopt()` migrates on the way in.
 *
 *  The channel lists and milestones are optional on `Doc` because a document on
 *  the wire may predate them; the ladder's whole job is that they are present
 *  afterwards. Saying so once here is what stops every reader in the page from
 *  proving it again. */
/** The same guarantees as `LoadedDoc`, AS THE PAGE READS IT: its read-only
 *  guard projects the task times to day numbers. */
export type LoadedDayDoc = DayDoc & LoadedExtras
export type LoadedDoc = Doc & LoadedExtras
type LoadedExtras = {
	start: string
	lanes: ChannelValue[]
	colors: ChannelValue[]
	borders: ChannelValue[]
	fills: ChannelValue[]
	shapes: ChannelValue[]
	milestones: Milestone[]
}

/** A working calendar. `isWorking` TAKES THE DAY — see the note on `CAL_ALL`. */
export interface Cal {
	isWorking: (day: number) => boolean
	perWeek: number
	allOn?: boolean
	/** The working window inside each working day, as fractions of it. Absent = 0–1. */
	from?: number
	to?: number
	/** Planned slots, as [start, end, task id] in day numbers: stretches of the working window that belong to their task. */
	blocks?: [number, number, Id][]
}

/** Day number -> the day work starts, keyed by task id. What `sched` returns. */
export type Starts = Record<Id, number>

/** A task AS THE SCHEDULER SEES IT: the `WhenField`s projected to day numbers
 *  and `dur` to days, by `dayNumbers()`. Never stored, never sent. `actualStart`
 *  and `actualEnd` are not stored either: they are read off the sessions
 *  (`actualsOf`), the first start and, once done, the last stop. */
export type DayTask = Omit<Task, WhenField | "planned"> & {
	planned?: { start: number; stop: number }[]
	notBefore?: number; actualStart?: number; actualEnd?: number; refinedAt?: number; due?: number
}
export type Doc = DocOf<Task>
export type DayDoc = DocOf<DayTask>

/** What a caller may send to `addTask`: an id, and as much or as little else as
 *  it actually knows. `withDefaults` fills the channel fields from the plan's
 *  own `defaults` before the task is stored, so a document always holds whole
 *  `Task`s — this type is the WIRE shape, not the stored one. */
export type NewTask = Partial<Task> & { id: Id }

/** THE ENVELOPE FIELD EVERY COMMAND MAY CARRY: an ISO instant saying when the
 *  sender issued it. Only four commands read it — `addTask` for `createdAt`,
 *  and the three that change a task's wording for `updatedAt` — but it belongs
 *  to the envelope rather than to them, because the rule it serves is about how
 *  commands travel and not about what any one of them means.
 *
 *  THE APPLIER MAY NOT READ A CLOCK. `applyCommand` runs in the page, in the
 *  server and in every other client, independently, on the same command; a
 *  timestamp taken inside it would differ in every copy of the document. So the
 *  value is stamped where a command ENTERS the system and is then carried,
 *  unchanged, everywhere it goes. */
type Issued = { at?: string }

/** `n` units between occurrences, counted from `from` (the first one's `notBefore`) rather than from the previous copy, so
 *  a monthly task on the 31st does not drift to the 28th for good. `ahead` is how many copies wait beyond the current one.
 *  `on` says which field `from` was (a task with only a due date repeats on that); `lag` is the days from notBefore to due when it had both, fixed at the start so editing one copy's due does not move the later ones. `series` (the first copy's id) and `i` (this copy's index) are bookkeeping `setRecur` fills in. */
export type Recur = { n: number; unit: "day" | "week" | "month"; ahead: number; series: Id; i: number; from: When; on: "notBefore" | "due"; lag?: number }

export type Command = Issued & (
	| { type: "addTask"; task: NewTask }
	| { type: "removeTask"; id: Id }
	| { type: "renameTask"; id: Id; label: string }
	| { type: "setTaskDesc"; id: Id; desc: string | null }
	| { type: "setTaskUrl"; id: Id; url: string | null }
	| { type: "setTaskRef"; id: Id; ref: string | null }
	| { type: "setDuration"; id: Id; dur: number }
	| { type: "addDep"; id: Id; dep: Id }
	| { type: "removeDep"; id: Id; dep: Id }
	| { type: "setTaskChannel"; id: Id; channel: ChannelKey; value: Id }
	| { type: "setTaskColors"; id: Id; colors: Id[] }
	| { type: "setNotBefore"; id: Id; notBefore: When | null }
	| { type: "setNoQueue"; id: Id; noQueue: boolean }
	| { type: "setPlanned"; id: Id; planned: { start: When; stop: When }[] }
	| { type: "completePlanned"; id: Id; index: number; start?: When; stop?: When }
	| { type: "setRecur"; id: Id; recur: { n: number; unit: Recur["unit"]; ahead?: number } | null }
	| { type: "startTask"; id: Id }
	| { type: "stopTask"; id: Id }
	| { type: "finishTask"; id: Id }
	| { type: "reopenTask"; id: Id }
	| { type: "setSessions"; id: Id; sessions: Session[] }
	| { type: "setRefined"; id: Id; refinedAt: When | null }
	| { type: "setMilestone"; id: Id; ms: Id | null }
	| { type: "setDue"; id: Id; due: When | null }
	| { type: "addComment"; id: Id; comment: { id: Id; text: string; at?: When; by?: string } }
	| { type: "editComment"; id: Id; commentId: Id; text: string }
	| { type: "removeComment"; id: Id; commentId: Id }
	| { type: "moveTaskInLane"; id: Id; toIndex: number }
	| { type: "addRankAnswer"; a: Id; b: Id; verdict: -1 | 0 | 1 }
	| { type: "removeRankAnswer"; a: Id; b: Id }
	| { type: "resetRanking" }
	| { type: "setRankSuggestion"; by?: string; order: { id: Id; why: string; toss?: boolean }[] }
	| { type: "patchDoc"; patch: Record<string, unknown> }
)

/** One archived version, exactly the shape `.history/<id>/NNNN.json` holds. */
export interface Version {
	/** The archive slot this came from — `.history/<id>/NNNN.json`. Assigned by
	 *  the history endpoint from the key, so it is absent on a freshly built
	 *  version and present on every one that has been read back. */
	n?: number
	at: string
	approx?: boolean
	note: string
	doc: Doc
	by?: string
}
