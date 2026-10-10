// PLANNED STRETCHES: `planned` on a task is what is promised, in the same { start, stop } shape as `sessions` (what happened).
// The scheduler holds those times in wall-clock time and works the rest of the plan around them; the clock never turns a plan
// into work, only the user does (`completePlanned`, `finishTask`). Scheduler tests count in day numbers like the others: day 0 is
// the plan's start (a Monday), the fraction is the zone's wall clock. Command tests use instants.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand, validateCommand } from '../../shared/commands.js'
import { calOf, endOf, plannedOf, sched, spanOf, workDaysIn } from '../../shared/schedule.js'
import { hoursOf } from './hours-fixture.js'

const H = 1 / 24
const task = (id: string, over: any = {}): any => ({ id, lane: 'me', dur: 1, deps: [], ...over })
const doc = (tasks: any[]): any => ({ start: '2026-09-21', hours: hoursOf(['08:00', '17:00']), lanes: [{ id: 'me', label: 'Me', cap: 1 }], tasks })
const run = (tasks: any[], today?: number) => {
	const d = doc(tasks), cal = calOf(d), st = sched(d.tasks, d.lanes, cal, today)
	return { st, end: (id: string) => endOf(d.tasks.find((t: any) => t.id === id), st[id]!, cal) }
}
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`)
const at = (day: number, from: number, to: number) => ({ start: day + from * H, stop: day + to * H })
// Tue 13:00-15:00, with a full day of work (9h) that would otherwise run straight through it.
const meeting = (over: any = {}) => task('m', { dur: 2 * H, planned: [at(1, 13, 15)], ...over })

test('Given a planned task, when work would run through it, then it holds its time and the work flows around it', () => {
	const { st, end } = run([task('w', { dur: 9 * H, notBefore: 1 }), meeting()])
	near(st.m, 1 + 13 * H); near(end('m'), 1 + 15 * H)
	near(st.w, 1 + 8 * H); near(end('w'), 2 + 10 * H)   // 5h before, 4h after the 2h gap
})

// The page's audit ("spans X working days but its duration is Y") and its grip drag both read a span back as work.
test('Given work that flows around a planned task, when its span is read back as working time, then it holds exactly its duration', () => {
	const d = doc([task('w', { dur: 9 * H, notBefore: 1 }), meeting()]), cal = calOf(d), st = sched(d.tasks, d.lanes, cal)
	const held = (i: number, id: string) => workDaysIn(st[id]!, spanOf(d.tasks[i], st[id]!, cal), cal, id)
	assert.ok(Math.abs(held(0, 'w') - 9 * H) < 1e-6, `w holds ${held(0, 'w')}`)   // the audit's own tolerance: workDaysIn rounds to 1e-6
	assert.ok(Math.abs(held(1, 'm') - 2 * H) < 1e-6, `m holds ${held(1, 'm')}`)   // its own slot is not in its way
})

test('Given the same task without a plan, then it queues like anything else', () => {
	const { st } = run([task('w', { dur: 9 * H, notBefore: 1 }), meeting({ planned: undefined, notBefore: 1 + 13 * H })])
	near(st.w, 1 + 8 * H)
	assert.ok(st.m >= 2 - 1e-9)   // behind the day of work, nowhere near 13:00 Tuesday
})

test('Given a stretch that straddles closing time, then it lasts its wall-clock length, not start plus duration', () => {
	const { st, end } = run([meeting({ planned: [at(1, 16.5, 18.5)] })])
	near(st.m, 1 + 16.5 * H); near(end('m'), 1 + 18.5 * H)
})

test('Given something that waits on a planned task, then it starts when the last stretch ends', () => {
	const { st } = run([meeting({ planned: [at(1, 9, 10), at(1, 13, 15)] }), task('after', { dur: 1 * H, deps: ['m'] })])
	near(st.after, 1 + 15 * H)
})

test('Given two stretches, then the task spans both and other work uses the gap between them', () => {
	const { st, end } = run([meeting({ planned: [at(1, 9, 10), at(1, 13, 15)] }), task('w', { dur: 3 * H, notBefore: 1 + 9 * H })])
	near(st.m, 1 + 9 * H); near(end('m'), 1 + 15 * H)
	near(st.w, 1 + 10 * H); near(end('w'), 1 + 13 * H)   // 3h of work: 10-13 fits the gap exactly
})

test('Given a planned task whose dependency ends after it starts, then the plan stays put and the dependency flows around it', () => {
	const { st, end } = run([task('p', { dur: 20 * H }), meeting({ deps: ['p'] })])
	near(st.m, 1 + 13 * H)
	assert.ok(end('p') > st.m)
})

test('Given a plan that lapsed unstarted, then the task is ordinary work again, forecast from now', () => {
	const { st } = run([meeting()], 3)   // today is Thursday: the Tuesday stretch is over
	assert.ok(st.m >= 3 - 1e-9)
})

test('Given a planned task already worked on, then it is ordinary work but its stretches still block others', () => {
	// worked 8-8:30, paused: half an hour left, forecast from 9:00; its 13-15 stretch is still promised
	const m = meeting({ dur: 1 * H, sessions: [{ start: '2026-09-22T13:00:00Z', stop: '2026-09-22T13:30:00Z' }], resume: 1 + 9 * H, worked: 0.5 * H, actualStart: 1 + 8 * H })
	assert.equal(plannedOf(m), null)
	const { st, end } = run([m, task('w', { dur: 9 * H, notBefore: 1 })], 1 + 9 * H)   // now is 9:00
	near(st.m, 1 + 9 * H); near(end('m'), 1 + 9.5 * H)   // paused, so queued again from 9:00 (ADR 0018)
	near(end('w'), 2 + 11.5 * H)   // 3.5h before the stretch, 2h after it on Tuesday, 3.5h on Wednesday
})

test('Given a done task, then its planned stretches hold nothing', () => {
	const d = doc([meeting({ done: true, sessions: [{ start: '2026-09-22T18:00:00Z', stop: '2026-09-22T20:00:00Z' }] })])
	assert.equal((calOf(d) as any).blocks, undefined)
})

// ---- commands -------------------------------------------------------------------------------------------------------

const fixture = (over: any = {}): any => ({
	schemaVersion: 10, title: 'T', start: '2026-01-01', timeZone: 'America/Chicago',
	lanes: [{ id: 'me', label: 'Me', cap: 1 }], borders: [{ id: 'b', label: 'b', style: 'solid' }], fills: [{ id: 'f', label: 'f', pattern: 'solid' }],
	shapes: [{ id: 's', label: 's', shape: 'soft' }], colors: [], milestones: [],
	tasks: [{ id: 'a', label: 'A', lane: 'me', border: 'b', fill: 'f', shape: 's', color: [], dur: 120, deps: [], createdAt: '2026-01-01T00:00:00Z', ...over }],
})
const P = (a: string, b: string) => ({ start: `2026-10-06T${a}:00Z`, stop: `2026-10-06T${b}:00Z` })

test('Given setPlanned, then stretches must be in order, apart, and each have a real end; [] clears', () => {
	const d = fixture()
	const bad = (planned: any) => String(validateCommand(d, { type: 'setPlanned', id: 'a', planned }))
	assert.match(bad('x'), /array/)
	assert.match(bad([{ start: '2026-10-06T18:00:00Z', stop: null }]), /must end after it starts/)
	assert.match(bad([P('18:00', '18:00')]), /must end after it starts/)
	assert.match(bad([P('18:00', '20:00'), P('19:00', '21:00')]), /planned\[1\] starts before the one above it stops/)
	applyCommand(d, { type: 'setPlanned', id: 'a', planned: [{ start: '2026-10-06T13:00:00-05:00', stop: '2026-10-06T15:00:00-05:00' }] })
	assert.deepEqual(d.tasks[0].planned, [P('18:00', '20:00')].map((x) => ({ start: x.start.replace(':00Z', ':00.000Z'), stop: x.stop.replace(':00Z', ':00.000Z') })))
	applyCommand(d, { type: 'setPlanned', id: 'a', planned: [] })
	assert.ok(!('planned' in d.tasks[0]))
})

test('Given a finished task, then it cannot be planned', () => {
	const d = fixture({ done: true, sessions: [P('18:00', '19:00')] })
	assert.match(String(validateCommand(d, { type: 'setPlanned', id: 'a', planned: [P('20:00', '21:00')] })), /finished/)
})

test('Given completePlanned, then the stretch moves into the sessions, times defaulting to its own and correctable', () => {
	const d = fixture({ planned: [P('18:00', '20:00'), P('22:00', '23:00')] })
	applyCommand(d, { type: 'completePlanned', id: 'a', index: 0, start: '2026-10-06T18:05:00Z', stop: '2026-10-06T20:10:00Z' })
	assert.deepEqual(d.tasks[0].sessions, [{ start: '2026-10-06T18:05:00.000Z', stop: '2026-10-06T20:10:00.000Z' }])
	assert.deepEqual(d.tasks[0].planned, [P('22:00', '23:00')])
	applyCommand(d, { type: 'completePlanned', id: 'a', index: 0 })
	assert.equal(d.tasks[0].sessions.length, 2)
	assert.ok(!('planned' in d.tasks[0]))   // an empty list is cleared, not kept
})

test('Given completePlanned, then it is refused when the session would overlap one that happened, or the stretch is not there', () => {
	const d = fixture({ planned: [P('18:00', '20:00')], sessions: [P('19:00', '19:30')] })
	assert.match(String(validateCommand(d, { type: 'completePlanned', id: 'a', index: 0 })), /cannot overlap/)
	assert.match(String(validateCommand(d, { type: 'completePlanned', id: 'a', index: 3 })), /no planned stretch/)
})

test('Given finishTask on a never-started planned task, then the stretches already under way become the work, clipped to the finish', () => {
	const d = fixture({ planned: [P('18:00', '20:00'), P('21:00', '22:00')] })
	applyCommand(d, { type: 'finishTask', id: 'a', at: '2026-10-06T19:00:00Z' })
	assert.deepEqual(d.tasks[0].sessions, [{ start: '2026-10-06T18:00:00Z', stop: '2026-10-06T19:00:00.000Z' }])
	assert.ok(d.tasks[0].done && !('planned' in d.tasks[0]))   // the later stretch was never worked: dropped
})

test('Given finishTask with nothing under way yet, then it is a session of no length, as before', () => {
	const d = fixture({ planned: [P('18:00', '20:00')] })
	applyCommand(d, { type: 'finishTask', id: 'a', at: '2026-10-06T10:00:00Z' })
	assert.deepEqual(d.tasks[0].sessions, [{ start: '2026-10-06T10:00:00.000Z', stop: '2026-10-06T10:00:00.000Z' }])
	assert.ok(!('planned' in d.tasks[0]))
})

test('Given a repeating task with planned stretches, then its copies are not planned (the same times would double-book)', () => {
	const d = fixture({ notBefore: '2026-10-06T18:00:00Z', planned: [P('18:00', '20:00')] })
	applyCommand(d, { type: 'setRecur', id: 'a', recur: { n: 1, unit: 'week' }, at: '2026-10-01T00:00:00Z' })
	assert.ok(d.tasks[0].planned && !d.tasks[1].planned)
})

test('Given addTask with planned, then it is validated and normalised like sessions', () => {
	const d = fixture()
	const task = { id: 'n', label: 'N', dur: 60, planned: [{ start: '2026-10-06T13:00:00-05:00', stop: '2026-10-06T14:00:00-05:00' }] }
	applyCommand(d, { type: 'addTask', task, at: '2026-10-01T00:00:00Z' })
	assert.equal(d.tasks[1].planned[0].start, '2026-10-06T18:00:00.000Z')
	assert.match(String(validateCommand(d, { type: 'addTask', task: { ...task, id: 'm', planned: [P('20:00', '19:00')] } })), /task\.planned/)
})
