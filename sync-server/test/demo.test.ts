// THE DEMO IS THE FIRST THING ANYONE SEES, AND IT ROTS SILENTLY.
//
// `web/demo-plan.json` went 31 commits and two schema versions without being
// touched, and by then it demonstrated none of: url, ref, noQueue,
// dropped, due, actualStart, actualEnd. Nothing failed. Nothing could — it is a
// data file nobody asserts on, and "remember to update the demo" is not a
// mechanism.
//
// WHAT MAKES THIS DIFFERENT FROM A CHECKLIST is where the list comes from.
// `shared/commands.js` already IS the task-level vocabulary — it is the wire
// protocol both halves import, and it cannot drift from what the tool can do.
// So the check reads the command union out of it and demands that the demo
// exercise every command that sets a task field. Add `setTaskWhatever` and this
// goes red until somebody decides whether the demo should show it. That is the
// same bet as the schedule.js byte-parity check: a guarantee that runs, rather
// than a note in a file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SCHEMA, sched, finishOf, calOf, dayNumbers } from '../../shared/schedule.js'
import { invalid } from '../src/validate.js'

const demo = JSON.parse(readFileSync(new URL('../../web/demo-plan.json', import.meta.url), 'utf8'))
const vocabulary = readFileSync(new URL('../../shared/commands.js', import.meta.url), 'utf8')

/** Every command name in the protocol, read from the protocol. */
const COMMANDS = [...new Set([...vocabulary.matchAll(/type:\s*"(\w+)"/g)].map(m => m[1]!))]

/** Which task field each command writes. `null` means "sets no field on a task" —
 *  structural, document-level, or a pure reordering — and is excluded rather than
 *  unlisted, so an unfamiliar command is loud instead of silently skipped. */
const WRITES: Record<string, string[] | null> = {
	addTask: null, removeTask: null, moveTaskInLane: null, patchDoc: null,
	renameTask: ['label'],
	setTaskDesc: ['desc'],
	setTaskUrl: ['url'],
	setTaskRef: ['ref'],
	setDuration: ['dur'],
	addDep: ['deps'], removeDep: ['deps'],
	setTaskChannel: ['lane', 'border', 'fill', 'shape'],
	setTaskColors: ['color'],
	setNotBefore: ['notBefore'],
	setNoQueue: ['noQueue'],
	startTask: ['sessions'], stopTask: ['sessions'], setSessions: ['sessions'],
	finishTask: ['done', 'sessions'],
	reopenTask: null,   // clears `done`; a reopened task is a paused one, which the demo already shows
	setRefined: ['refinedAt'],
	setMilestone: ['ms'],
	setDue: ['due'],
	addComment: ['comments'],
	editComment: ['comments'],
	removeComment: null,
	// The ranking lives on the document (`rankLog`), not on a task; so does a suggestion for it (`rankSuggestion`).
	addRankAnswer: null, removeRankAnswer: null, resetRanking: null,
	setRankSuggestion: null,
	// Writes `recur` (and spawns whole copies of the task), but the demo does not demonstrate it: a series is several dated
	// tasks, and the bakery's fixed dates would age out of it. Decided 2026-10-04; revisit if the demo should show repeating work.
	setRecur: null,
	// Planned stretches are clock times, and the bakery's fixed dates would age out of them.
	setPlanned: null, completePlanned: null,
}

const used = (field: string) =>
	demo.tasks.filter((t: Record<string, unknown>) => {
		const v = t[field]
		return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '' && v !== false
	}).length

test('Given the command vocabulary, when it grows, then this test names the new command', () => {
	const unknown = COMMANDS.filter(c => !(c in WRITES))
	assert.deepEqual(unknown, [],
		`new command(s) in shared/commands.js that this check has never heard of: ${unknown.join(', ')}. ` +
		`Add each to WRITES — with the task field it sets, or null if it sets none — and then decide ` +
		`whether web/demo-plan.json should demonstrate it.`)
})

test('Given the demo plan, when a command writes a task field, then some task uses it', () => {
	const missing = Object.entries(WRITES)
		.filter(([, fields]) => fields)
		.filter(([, fields]) => !fields!.some(f => used(f) > 0))
		.map(([cmd, fields]) => `${cmd} (${fields!.join('/')})`)
	assert.deepEqual(missing, [],
		`web/demo-plan.json demonstrates nothing for: ${missing.join(', ')}. ` +
		`The demo is the first thing anyone sees; a feature absent from it is a feature nobody finds.`)
})

test('Given the demo plan, when it is loaded, then it needs no migration', () => {
	// A seed at an old schema still WORKS — the ladder runs on load — but it means
	// the tracked file and the thing visitors see are different documents, which is
	// exactly the drift reset-demo.sh warns about.
	assert.equal(demo.schemaVersion, SCHEMA)
})

test('Given the demo plan, when a channel is drawn, then it has something to discriminate', () => {
	// The legend refuses a channel under two values, so a one-value channel is a
	// row of the demo that simply does not appear.
	for (const ch of ['lanes', 'colors', 'borders', 'fills', 'shapes', 'milestones'])
		assert.ok((demo[ch] || []).length >= 2, `${ch} has fewer than two values, so it draws no legend row`)
})

test('Given the demo plan, when the document has its own features, then they are shown too', () => {
	// Not derivable from the command vocabulary: these live on the document, and
	// `patchDoc` writes all of them through one command.
	assert.ok(demo.channelLabels?.colors, 'no channelLabels — the "Project" rename is how projects exist at all')
	const week = Object.values(demo.hours?.week || {}) as unknown[][]
	assert.ok(week.some((w) => !w.length), 'no non-working weekday, so no weekend shading')
	assert.ok(Object.values(demo.hours?.dates || {}).some((w) => !(w as unknown[]).length), 'no date off, so the day-off case is never drawn')
	assert.ok(week.some((w) => w.length), 'no working hours, so the off-hours bands are never drawn')
	assert.ok(demo.sprint?.weeks, 'no sprint cadence')
	assert.ok(demo.lanes.some((l: { cap?: number }) => (l.cap ?? 1) > 1), 'no lane with capacity above one')
	assert.ok(demo.tasks.some((t: { color?: unknown[] }) => (t.color || []).length > 1),
		'no task carrying two projects, so the banded bar is never drawn')
})

// ---- and the demo has to be a REAL plan, not just a plausible-looking file ----
// The checks above are about COVERAGE — is each feature present somewhere. They
// would pass on a document that is nonsense, because a task with a `url` and
// no sense satisfies "some task uses url".
//
// These make the demo load-bearing instead: it has to pass the same validator the
// server runs on every write, and it has to schedule without the audit finding a
// contradiction. Edit the bakery into an incoherent state — a finish before its
// own start, a dependency cycle, a task pointing at a channel value you deleted —
// and the suite says so before a visitor sees it.
//
// Deliberately NOT assertions about the bakery's content. The demo is a story and
// has to stay free to change as a story; pinning "the lease takes one day" would
// make every retelling of it a test failure.
test('Given the demo plan, when the server validates it, then it is a legal document', () => {
	assert.equal(invalid(structuredClone(demo)), null)
})

test('Given the demo plan, when it is scheduled, then it lands on a real date', () => {
	// `auditSchedule` is not here to be called: it lives in the page, not in
	// shared/, so the audit half of this runs in verify.sched.mjs, which extracts
	// it. This half is what a node test can honestly assert.
	// Through `dayNumbers`, as every scheduler caller must: the stored times are
	// instants, and `sched` counts in days.
	const d = dayNumbers(demo), cal = calOf(d)
	const st = sched(d.tasks, d.lanes!, cal)
	assert.ok(Number.isFinite(finishOf(d.tasks, st, cal)), 'the demo has no finish date')
	assert.equal(Object.keys(st).length, demo.tasks.length, 'some task never got placed')
})
