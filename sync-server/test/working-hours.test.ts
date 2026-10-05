// WORKING HOURS: one window per plan, `workHours: ["08:00", "17:00"]`, inside
// the days `workweek` and `holidays` already allow. Absent means the whole day,
// exactly as before. See docs/adr/0014-working-hours.md.
//
// Day numbers throughout, like every scheduler test: day 0 is the plan's start,
// the fraction is the plan zone's wall clock, and `dur` here is in days of work.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCommand } from '../../shared/commands.js'
import { calOf, endOf, orderSignature, sched, snapFwd } from '../../shared/schedule.js'

const H = 1 / 24
const task = (id: string, over: any = {}): any => ({ id, lane: 'me', dur: 1, deps: [], ...over })
const doc = (over: any = {}): any => ({
	start: '2026-09-21', // a Monday
	lanes: [{ id: 'me', label: 'Me', cap: 1 }],
	...over,
})
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`)

test('no workHours schedules exactly as before', () => {
	const d = doc({ tasks: [task('a', { dur: 6 * H }), task('b', { dur: 6 * H })] })
	const st = sched(d.tasks, d.lanes, calOf(d))
	near(st.a, 0); near(st.b, 6 * H)
})

test('a forecast starts at the window and its work only burns inside it', () => {
	const d = doc({ workHours: ['08:00', '17:00'], tasks: [task('a', { dur: 6 * H }), task('b', { dur: 6 * H })] })
	const cal = calOf(d), st = sched(d.tasks, d.lanes, cal)
	near(st.a, 8 * H)
	near(endOf(d.tasks[0], st.a, cal), 14 * H)
	near(st.b, 14 * H)
	near(endOf(d.tasks[1], st.b, cal), 1 + 11 * H) // 3h Mon, 3h Tue from 08:00
})

test('the window sits inside the workweek: Friday evening snaps to Monday 08:00', () => {
	const cal = calOf(doc({ workweek: [0, 1, 1, 1, 1, 1, 0], workHours: ['08:00', '17:00'] }))
	near(snapFwd(4 + 18 * H, cal), 7 + 8 * H)
	near(snapFwd(4 + 3 * H, cal), 4 + 8 * H)  // before the window, same day
	near(snapFwd(4 + 10 * H, cal), 4 + 10 * H) // inside it: untouched
})

test('work that ends exactly at closing hands over to the next opening', () => {
	const d = doc({ workHours: ['08:00', '17:00'], tasks: [task('a', { dur: 9 * H }), task('b', { dur: 1 * H, deps: ['a'] })] })
	const cal = calOf(d), st = sched(d.tasks, d.lanes, cal)
	near(endOf(d.tasks[0], st.a, cal), 17 * H)
	near(st.b, 1 + 8 * H)
})

test('a real start off-hours burns nothing until the window opens (ADR 0014, Q14)', () => {
	const d = doc({ workHours: ['08:00', '17:00'], tasks: [task('a', { dur: 1 * H, actualStart: 22 * H })] })
	const cal = calOf(d), st = sched(d.tasks, d.lanes, cal)
	near(st.a, 22 * H)                            // facts are not snapped
	near(endOf(d.tasks[0], st.a, cal), 1 + 9 * H) // the hour lands Tue 08:00–09:00
})

test('the window is part of what the reorder search reads', () => {
	assert.notEqual(orderSignature(doc({ tasks: [] })), orderSignature(doc({ workHours: ['08:00', '17:00'], tasks: [] })))
})

test('patchDoc takes a same-day window, or null to clear it', () => {
	const ok = (workHours: any) => validateCommand(doc({ tasks: [] }), { type: 'patchDoc', patch: { workHours } })
	assert.equal(ok(['08:00', '17:00']), null)
	assert.equal(ok(null), null)
	for (const bad of [['17:00', '08:00'], ['08:00', '08:00'], ['8', '17'], ['08:00'], '08:00-17:00', ['22:00', '06:00'], ['08:00', '24:30']])
		assert.match(String(ok(bad)), /workHours/, JSON.stringify(bad))
})
