// What a personal plan needs that a client delivery plan never did: `due` and
// `noQueue`.
//
// A DURATION OF ZERO WAS THE THIRD, and it was refused again on 2026-09-20 —
// it turned out to mean "nobody estimated this" far more often than "this takes
// no time", and it hid, because a zero-duration task leaves the lane queue. The
// scheduler still handles one, and the tests below still cover that, because
// fifty-odd archived versions were written while it was legal and they have to
// stay readable. What changed is that no command can write one any more. See `CONTEXT.md` for what each one means
// and `docs/adr/0005-one-plan-holds-everything.md` for why they live on this
// document rather than in a second tool.
//
// `owner` WAS IN THIS LIST and was deleted on 2026-09-20, set on zero tasks in
// the live plan. The two tests below kept their shape on purpose: somebody
// else's work is still their own task that yours depends on, and `noQueue` is
// still what keeps their days out of your capacity. Only the label moved — from
// a field to the title, which is where a name is read.
//
// The fixture is invented, like every other one here.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand, validateCommand, withDefaults, type Doc, type Task } from '../../shared/commands.js'
import { calOf, hasCycle, readiness, sched, scheduleView, verdict } from '../../shared/schedule.js'

// v4 FIXTURES with day numbers: `sched` takes them as they are, and `readiness`
// migrates them to v6 on the way in, which is itself part of what is tested.
const task = (id: string, over: any = {}): any => ({
	id,
	label: id,
	lane: 'me',
	border: 'b1',
	fill: 'f1',
	shape: 's1',
	color: [],
	dur: 1,
	deps: [],
	...over,
})

// ONE LANE, CAPACITY ONE — a person, not a team. That is the shape these fields
// exist for, and it is also the shape that makes a queue bug visible: with one
// slot, anything that wrongly holds the lane delays everything after it.
const fixture = (tasks: any[]): any => ({
	schemaVersion: 4,
	title: 'Personal',
	start: '2026-09-21', // a Monday, so no weekend snapping muddies the numbers
	lanes: [{ id: 'me', label: 'Me', cap: 1 }],
	borders: [{ id: 'b1', label: 'plain', style: 'solid' }],
	fills: [{ id: 'f1', label: 'known', pattern: 'solid' }],
	shapes: [{ id: 's1', label: 'bar', shape: 'soft' }],
	colors: [],
	milestones: [],
	tasks,
})

const run = (doc: any) => sched(doc.tasks, doc.lanes, calOf(doc))



test('Given dropping a task, when the plan is scheduled, then its dependents keep the edge for later', () => {
	const doc = fixture([task('a', { dropped: true }), task('b', { deps: ['a'] })])

	run(doc)

	// `sched` runs on the live document on every keystroke, so trimming deps in
	// place would make dropping a task quietly delete dependencies — and undropping
	// it would not bring them back.
	assert.deepEqual(doc.tasks.find((t: any) => t.id === "b")!.deps, ["a"])
})

test('Given a chain of zero-duration tasks, when the plan is scheduled, then all are placed in order on one day', () => {
	const doc = fixture([
		task('c', { dur: 0, deps: ['b'] }),
		task('a', { dur: 0 }),
		task('b', { dur: 0, deps: ['a'] }),
	])

	const st = run(doc)

	assert.equal(st.a, 0)
	assert.equal(st.b, 0)
	assert.equal(st.c, 0)
})

test("Given somebody else's task, exempt from the queue, when the plan is scheduled, then it does not delay your own work", () => {
	const doc = fixture([
		task('theirs', { label: "Divya's review", dur: 20, noQueue: true }),
		task('mine', { dur: 1 }),
	])

	const st = run(doc)

	// Waiting on a person is a task you depend on, not a second blocking concept —
	// but their twenty days must not eat your one capacity slot.
	assert.equal(st.mine, 0)
})

test('Given work that waits on a person, when they are still going, then your dependent task waits too', () => {
	const doc = fixture([
		task('divya-reviews', { label: 'Divya reviews it', dur: 3, noQueue: true }),
		task('merge-it', { deps: ['divya-reviews'] }),
	])

	const st = run(doc)

	assert.equal(st['divya-reviews'], 0)
	assert.equal(st['merge-it'], 3, 'the dependency still blocks, exemption is only about capacity')
})


test('Given a plan of ordinary tasks, when the scheduler view is taken, then it is the same array', () => {
	const doc = fixture([task('a'), task('b', { deps: ['a'] })])

	// The common case pays nothing: no clone, no allocation, same reference.
	assert.equal(scheduleView(doc.tasks), doc.tasks)
})

test('Given a zero-duration task behind a full lane, when the plan is scheduled, then it does not wait for a slot', () => {
	const doc = fixture([
		task('long', { dur: 14 }),
		task('quick', { dur: 0 }),
	])

	const st = run(doc)

	// A lane's capacity rations working TIME, and this consumes none — so queuing
	// it behind a fortnight of unrelated work made a deadline read "misses by 11
	// days" when the task was four days late and could be done this morning.
	//
	// NO COMMAND CAN BUILD THIS DOCUMENT ANY MORE, and the behaviour still has to
	// be right: it is what an archived version written before 2026-09-20 looks
	// like when somebody reverts to it or forks it. The fixture is constructed
	// directly for that reason.
	assert.equal(st.long, 0)
	assert.equal(st.quick, 0, 'work that takes no time does not queue')
})

test('Given a zero-duration task, when it is scheduled, then it still respects its dependencies', () => {
	const doc = fixture([task('first', { dur: 3 }), task('then', { dur: 0, deps: ['first'] })])

	const st = run(doc)

	// Exemption is about CAPACITY only. A dependency is a statement about order
	// and survives it — the falsifier being a zero-duration task jumping in front
	// of the work it waits on.
	assert.equal(st.then, 3)
})


test('Given the new commands, when they are validated, then good values pass and bad ones are named', () => {
	const doc = fixture([task('t')])

	assert.equal(validateCommand(doc, { type: 'setDue', id: 't', due: '2026-09-01T17:00:00Z' }), null)
	assert.equal(validateCommand(doc, { type: 'setDue', id: 't', due: '2026-09-01T12:00:00-05:00' }), null, 'any offset')
	assert.equal(validateCommand(doc, { type: 'setDue', id: 't', due: null }), null)
	assert.match(validateCommand(doc, { type: 'setDue', id: 't', due: 'friday' })!, /ISO instant/)
	assert.match(validateCommand(doc, { type: 'setDue', id: 't', due: '2026-09-01T17:00' })!, /with a zone/,
		'a wall-clock time in nobody\'s zone is the ambiguity v6 removed')
	assert.match(validateCommand(doc, { type: 'setDue', id: 't', due: 12 as any })!, /retired in schema v6/,
		'a day number is refused by name, so an agent on the old docs knows why')

	assert.match(validateCommand(doc, { type: 'setDuration', id: 't', dur: 0 })!, /greater than zero/,
		'zero is not a duration — it reads as work that takes no time and leaves the queue')
	assert.match(validateCommand(doc, { type: 'setDuration', id: 't', dur: -1 })!, /greater than zero/)
	assert.equal(validateCommand(doc, { type: 'setDuration', id: 't', dur: 1 }), null,
		'a minute is a duration; the floor is above zero, not at some useful size')
	assert.match(validateCommand(doc, { type: 'setDuration', id: 't', dur: 43.2 })!, /whole number of MINUTES/,
		'v7: a fraction of a minute is the decimal-guess bug, refused at the door')
})

test('Given null, when a new field is set to it, then the key is removed rather than written as null', () => {
	const doc = fixture([task('t')])
	const t = () => doc.tasks[0]!

	for (const [cmd, key] of [
		[{ type: 'setDue', id: 't', due: '2026-09-01T17:00:00.000Z' }, 'due'],
		[{ type: 'setNotBefore', id: 't', notBefore: '2026-09-01T17:00:00.000Z' }, 'notBefore'],
	] as const) {
		applyCommand(doc, cmd)
		assert.equal(t()[key], cmd[key as keyof typeof cmd])
		applyCommand(doc, { ...cmd, [key]: null })
		// A document full of explicit nulls archives a version every time somebody
		// set a value and cleared it again.
		assert.ok(!(key in t()), `${key} is absent, not null`)
	}

})

test('Given a cycle through a finished task, when the graph is asked, then it is still a cycle', () => {
	// THE EXACT SHAPE THAT GOT THROUGH. `a` is done, so `sched` seeds it from its
	// actuals and never places it — the forward pass never runs out of
	// candidates, never throws, and the page's old guard (run `sched`, catch the
	// throw) concluded there was no cycle. Three edges later the document was
	// cyclic, saved and broadcast, and the chart drew as though nothing had
	// happened.
	const doc = fixture([
		task('a', { deps: ['c'], actualStart: 0, actualEnd: 1 }),
		task('b', { deps: ['a'] }),
		task('c', { deps: ['b'] }),
	])

	assert.equal(hasCycle(doc.tasks), true, 'the edges say cycle')
	// The falsifier, stated as the thing that used to be true: scheduling it does
	// NOT throw, so anything relying on that throw is unsound.
	assert.doesNotThrow(() => run(doc), 'and the scheduler is perfectly happy')
})


test('Given an acyclic plan, when the graph is asked, then it says so', () => {
	const doc = fixture([task('a'), task('b', { deps: ['a'] }), task('c', { deps: ['a', 'b'] })])

	// A diamond is not a cycle, and a walk that marks "visited" without
	// distinguishing "on the current path" would call it one.
	assert.equal(hasCycle(doc.tasks), false)
})

test('Given a dependency naming a task that is not here, when the graph is asked, then that is not a cycle', () => {
	const doc = fixture([task('a', { deps: ['ghost'] })])

	// A different fault, and `invalid()` already refuses it. Reporting it as a
	// cycle would send someone looking for a loop that does not exist.
	assert.equal(hasCycle(doc.tasks), false)
})

test('Given a self-dependency, when the graph is asked, then it is a cycle', () => {
	const doc = fixture([task('a', { deps: ['a'] })])

	assert.equal(hasCycle(doc.tasks), true)
})

test('Given a task with an id, a label and a duration, when it is added, then the plan fills the rest', () => {
	const doc = fixture([])

	// THE WHOLE POINT OF THE AGENT SURFACE. `addTask` used to need eight fields,
	// four of them ids that must already exist in the document, so "add a task"
	// meant reading the plan and making four lookups. That rule was written out
	// three times — the page's + Task handler, a CLI, and whatever else drove
	// the HTTP API — and the copies had already drifted.
	// A DURATION IS THE ONE THING THE PLAN WILL NOT ANSWER FOR YOU (2026-09-20).
	// It used to be filled with zero, which is how four unestimated tasks ended
	// up scheduled as though they cost nothing.
	assert.match(validateCommand(doc, { type: 'addTask', task: { id: 't', label: 'Do it' } })!,
		/task.dur is required/)

	assert.equal(validateCommand(doc, { type: 'addTask', task: { id: 't', label: 'Do it', dur: 2 } }), null)
	applyCommand(doc, { type: 'addTask', task: { id: 't', label: 'Do it', dur: 2 } })

	const t = doc.tasks[0]!
	assert.equal(t.lane, 'me')
	assert.equal(t.border, 'b1')
	assert.equal(t.shape, 's1')
	assert.deepEqual(t.color, [])
	assert.deepEqual(t.deps, [])
	assert.equal(t.dur, 2, 'the caller said how long, because nothing else can')
})

test('Given an archived document that still holds a zero, when it is scheduled, then it is handled rather than refused', () => {
	// THE REASON THE BAN IS AT THE COMMAND LAYER AND NOT IN `invalid()`. Fifty-odd
	// versions were saved while zero was legal. A document rule would make every
	// one of them unrevertable and unforkable — the archive would stop being an
	// archive to protect a rule about new writes.
	const doc = fixture([task('old', { dur: 0 }), task('new', { dur: 2 })])
	const st = run(doc)
	assert.equal(st.old, 0, 'it still schedules')
	assert.match(validateCommand(doc, { type: 'setDuration', id: 'old', dur: 0 })!, /greater than zero/,
		'but nothing can put another one there')
})

test('Given a caller that supplied a field, when defaults are applied, then its value survives', () => {
	const doc = fixture([])

	const t = withDefaults(doc, { id: 't', label: 'x', dur: 3, color: [], deps: ['nope'] })

	// The falsifier: a fill that overwrote what it was given would silently
	// rewrite every task the page adds, since the page still sends all of them.
	assert.equal(t.dur, 3)
	assert.deepEqual(t.deps, ['nope'])
	// And absent is not the same as empty — `color: []` means "no project" and
	// must not have one invented for it.
	assert.deepEqual(t.color, [])
})

test('Given a plan whose channel has a stated default, when a task is added, then that default wins', () => {
	const doc = fixture([])
	doc.borders = [{ id: 'b1', label: 'first', style: 'solid' }, { id: 'b2', label: 'second', style: 'dotted' }]
	;(doc as any).defaults = { borders: 'b2' }

	assert.equal(withDefaults(doc, { id: 't' }).border, 'b2',
		'`doc.defaults` is the channel editor already answering this question')
})

test('Given a plan, when readiness is asked for, then the API says what the chart says', () => {
	// `refinedAt` ON THE ONE THAT IS SUPPOSED TO BE READY. Since 2026-09-20 ready
	// means two things — the schedule is clear AND a human has read the task and
	// agreed with it — so an unrefined task is not ready however free its lane
	// is. Without this line `first` is `false`, which is the assertion that
	// caught the contract change rather than letting it ship quietly.
	const doc = fixture([
		task('first', { dur: 1, refinedAt: 0 }),
		task('second', { deps: ['first'] }),
		task('parallel', { dur: 1 }),
	])

	const r = readiness(doc) as any[]
	const by = Object.fromEntries(r.map((x) => [x.id, x]))

	// THE VIOLATION THIS CLOSES (ADR 0008): `sched` computes all of this and hangs
	// it off its result with `Object.defineProperty`, so it is non-enumerable and
	// vanishes through JSON. A cold agent had to fetch the scheduler and run it.
	assert.equal(by.first.ready, true)
	assert.equal(by.second.ready, false)
	assert.equal(by.second.waitingOn, 'deps')
	assert.deepEqual(by.second.blockedBy, ['first'])
	// Resource-blocked, not dependency-blocked: one lane of capacity one, and
	// `first` is in it. An empty `blockedBy` with a reason is the useful half.
	assert.equal(by.parallel.ready, false)
	assert.equal(by.parallel.waitingOn, 'lane')
	assert.deepEqual(by.parallel.blockedBy, [])
	// A SCHEDULING REASON OUTRANKS AN UNREAD TASK. `second` is unrefined too, and
	// still reports `deps` — refining it would change nothing while `first` is in
	// the way, so naming the sign-off there would send someone to do the one
	// thing that cannot help.
	assert.equal(by.second.waitingOn, 'deps')
})

test('Given a task nothing in the schedule is holding, when nobody has refined it, then it is not ready', () => {
	// THE OTHER HALF OF "READY". Everything the scheduler knows about this task
	// is clear — no dependency, no not-before, a free lane — and it is still not
	// something to pick up, because nobody has read it and agreed with what it
	// says. This is the case the whole refined/raw feature exists for, and the
	// endpoint has to give the answer the chart gives or an agent and a human
	// disagree about the same task.
	const doc = fixture([task('unread', { dur: 1 })])
	const by = Object.fromEntries((readiness(doc) as any[]).map((x) => [x.id, x]))

	assert.equal(by.unread.ready, false)
	assert.equal(by.unread.waitingOn, 'unrefined')
	// Not blocked BY anything — the list stays empty, the way it does for a task
	// held by its lane. `waitingOn` is the useful half.
	assert.deepEqual(by.unread.blockedBy, [])

	// And refining it is the only thing that changes.
	doc.tasks[0]!.refinedAt = 0
	const after = Object.fromEntries((readiness(doc) as any[]).map((x) => [x.id, x]))
	assert.equal(after.unread.ready, true)
	assert.equal(after.unread.waitingOn, null)
})

test('Given work already underway, when readiness is asked for, then it declines to answer', () => {
	// `gone`, a task with the retired `dropped` flag, was a third case here until
	// 2026-09-20. Cancelling is gone from the protocol; the only thing that still
	// reads the flag is `scheduleView`, so that it cannot resurrect abandoned work
	// out of an old saved version — and `readiness` is not that place.
	const doc = fixture([
		task('doing', { actualStart: 0 }),
		task('done', { actualStart: 0, actualEnd: 1 }),
	])

	const by = Object.fromEntries((readiness(doc) as any[]).map((x) => [x.id, x]))

	// `null`, not `false`. "Can I pick this up" is not a question about work that
	// is already underway, and `false` would read as blocked.
	for (const id of ['doing', 'done']) assert.equal(by[id].ready, null, id)
	assert.equal(by.doing.status, 'paused', 'a start with no sessions upgrades to a session of no length')
	assert.equal(by.done.status, 'done')
})

test('Given a deadline, when readiness is asked for, then slack is signed the way a human reads it', () => {
	const doc = fixture([task('late', { dur: 5, due: 2 }), task('fine', { dur: 1, due: 30, noQueue: true })])

	const by = Object.fromEntries((readiness(doc) as any[]).map((x) => [x.id, x]))

	assert.ok(by.late.slackDays < 0, 'negative is late')
	assert.ok(by.fine.slackDays > 0, 'positive is time to spare')
})

test('Given a deadline missed by under an hour, when readiness is asked for, then slack still says late', () => {
	// Whole days hid it: `Math.round(-0.03)` is 0, which reads as on time. Pinned
	// far past today with `notBefore` so the numbers are exact on any run date.
	const doc = fixture([
		task('close', { dur: 1, notBefore: 100, due: 100.97, noQueue: true }),  // misses by ~43 min
		task('spare', { dur: 1, notBefore: 200, due: 201.6, noQueue: true }),   // 14.4 h to spare
	])

	const by = Object.fromEntries((readiness(doc) as any[]).map((x) => [x.id, x]))

	assert.ok(by.close.slackDays < 0, `late by minutes is still late (got ${by.close.slackDays})`)
	assert.equal(by.spare.slackDays, 0.6)
})

// ---- v6: instants at the door -----------------------------------------------

test('Given setRefined, when it is validated, then it is checked like every other time', () => {
	// It had NO check before v6 — any value at all was applied as a sign-off.
	const doc = fixture([task('t')])
	assert.equal(validateCommand(doc, { type: 'setRefined', id: 't', refinedAt: '2026-09-26T08:00:00Z' }), null)
	assert.match(validateCommand(doc, { type: 'setRefined', id: 't', refinedAt: { yes: true } as any })!, /ISO instant/)
})

test('Given an offset, when a time is applied, then it is stored as UTC', () => {
	const doc = fixture([task('t')])
	applyCommand(doc, { type: 'setDue', id: 't', due: '2026-09-26T03:16:00-05:00' })
	assert.equal(doc.tasks[0].due, '2026-09-26T08:16:00.000Z')
})

test('Given a time zone, when it is patched, then only a real one is accepted', () => {
	const doc = fixture([])
	assert.equal(validateCommand(doc, { type: 'patchDoc', patch: { timeZone: 'Europe/London' } }), null)
	assert.match(validateCommand(doc, { type: 'patchDoc', patch: { timeZone: 'Mars/Olympus' } })!, /IANA/)
})
