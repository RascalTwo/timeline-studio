// WORK SESSIONS: a task holds the stretches of work actually done. startTask / stopTask write them as
// they happen, setSessions replaces the list to correct one, and worked time (wall-clock) comes off
// what is left to forecast. Sessions are facts, so none of it touches the sign-off.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand, validateCommand } from '../../shared/commands.js'
import { calOf, dayNumbers, endOf, offHours, remainingOf, sched, workChunks } from '../../shared/schedule.js'

const H = 1 / 24
const fixture = (t: any = {}): any => ({
	start: '2026-09-21', timeZone: 'UTC', lanes: [{ id: 'me', label: 'Me', cap: 1 }],
	tasks: [{ id: 't', lane: 'me', dur: 240, deps: [], refinedAt: '2026-09-20T00:00:00.000Z', ...t }],
})
const run = (doc: any, cmd: any) => applyCommand(doc, cmd)
const bad = (doc: any, cmd: any) => validateCommand(doc, cmd)!

test('Given a task, when work starts and stops, then a session is recorded and the sign-off survives', () => {
	const doc = fixture()
	run(doc, { type: 'startTask', id: 't', at: '2026-09-21T09:00:00Z' })
	assert.deepEqual(doc.tasks[0].sessions, [{ start: '2026-09-21T09:00:00.000Z', stop: null }])
	run(doc, { type: 'stopTask', id: 't', at: '2026-09-21T10:30:00Z' })
	assert.equal(doc.tasks[0].sessions[0].stop, '2026-09-21T10:30:00.000Z')
	assert.equal(doc.tasks[0].done, undefined, 'stopping for the night is not finishing')
	assert.ok(doc.tasks[0].refinedAt, 'a fact log does not void a sign-off')
	run(doc, { type: 'startTask', id: 't', at: '2026-09-21T13:00:00Z' })
	assert.equal(doc.tasks[0].sessions.length, 2)
	assert.equal(doc.tasks[0].sessions[0].start, '2026-09-21T09:00:00.000Z', 'a later session does not move the start')
})

test('Given a running or finished task, when work starts or stops wrongly, then it is refused', () => {
	const doc = fixture()
	assert.match(bad(doc, { type: 'stopTask', id: 't', at: '2026-09-21T09:00:00Z' }), /not running/)
	assert.match(bad(doc, { type: 'startTask', id: 't' }), /needs `at`/)
	run(doc, { type: 'startTask', id: 't', at: '2026-09-21T09:00:00Z' })
	assert.match(bad(doc, { type: 'startTask', id: 't', at: '2026-09-21T09:05:00Z' }), /already running/)
	assert.match(bad(doc, { type: 'stopTask', id: 't', at: '2026-09-21T08:00:00Z' }), /before the session started/)
	run(doc, { type: 'finishTask', id: 't', at: '2026-09-21T11:00:00Z' })
	assert.match(bad(doc, { type: 'startTask', id: 't', at: '2026-09-21T12:00:00Z' }), /finished/)
})

test('Given a running session, when the task is finished, then the session stops at the finish', () => {
	const doc = fixture()
	run(doc, { type: 'startTask', id: 't', at: '2026-09-21T09:00:00Z' })
	run(doc, { type: 'finishTask', id: 't', at: '2026-09-21T11:00:00Z' })
	assert.equal(doc.tasks[0].sessions[0].stop, '2026-09-21T11:00:00.000Z')
})

test('Given a forgotten stop, when the sessions are set, then any stop time can be put back', () => {
	const doc = fixture()
	run(doc, { type: 'startTask', id: 't', at: '2026-09-21T09:00:00Z' }) // never stopped: "worked all night"
	run(doc, { type: 'setSessions', id: 't', sessions: [{ start: '2026-09-21T09:00:00Z', stop: '2026-09-21T16:00:00Z' }] })
	assert.deepEqual(doc.tasks[0].sessions, [{ start: '2026-09-21T09:00:00.000Z', stop: '2026-09-21T16:00:00.000Z' }])
	assert.ok(doc.tasks[0].refinedAt)
	assert.match(bad(doc, { type: 'setSessions', id: 't', sessions: [] }), /keeps at least one session/, 'worked-on work cannot be un-worked')
})

test('Given sessions, when they are validated, then they must be in order, apart, and only the last may run', () => {
	const doc = fixture()
	const s = (sessions: any) => bad(doc, { type: 'setSessions', id: 't', sessions })
	const a = { start: '2026-09-21T09:00:00Z', stop: '2026-09-21T10:00:00Z' }
	assert.match(s('x'), /array/)
	assert.match(s([{ start: 'nope', stop: null }]), /ISO instant/)
	assert.match(s([{ start: a.start, stop: '2026-09-21T08:00:00Z' }]), /before its start/)
	assert.match(s([a, { start: '2026-09-21T09:30:00Z', stop: '2026-09-21T11:00:00Z' }]), /overlap/)
	assert.match(s([{ start: a.start, stop: null }, { start: '2026-09-21T12:00:00Z', stop: null }]), /only the last/)
	assert.equal(bad(doc, { type: 'setSessions', id: 't', sessions: [a, { start: '2026-09-21T11:00:00Z', stop: null }] }), null)
	const done = fixture({ done: true, sessions: [a] })
	assert.match(bad(done, { type: 'setSessions', id: 't', sessions: [{ start: a.start, stop: null }] }), /finished task/)
})

// ---- the forecast: what is left of the estimate, from now --------------------------------------------
const forecast = (task: any, now: number) => {
	const d = dayNumbers(fixture(task), now), cal = calOf(d), st = sched(d.tasks, d.lanes!, cal, now, now)
	return { start: st.t, end: endOf(d.tasks[0], st.t, cal) }
}

test('Given an hour worked of a two-hour task, when it is forecast, then an hour remains, from now', () => {
	const f = forecast({ dur: 120, sessions: [{ start: '2026-09-21T09:00:00Z', stop: '2026-09-21T10:00:00Z' }] }, 12 * H)
	assert.ok(Math.abs(f.start - 12 * H) < 1e-9, 'paused, so it is forecast again from its turn: now (ADR 0018)')
	assert.ok(Math.abs(f.end - 13 * H) < 1e-9, `ends an hour after now, got ${f.end / H}h`)
})

test('Given a session still running, when it is forecast, then time so far counts as worked', () => {
	const f = forecast({ dur: 240, sessions: [{ start: '2026-09-21T09:00:00Z', stop: null }] }, 12 * H)
	assert.ok(Math.abs(f.start - 9 * H) < 1e-9, 'running, so the bar still begins when it began')
	assert.ok(Math.abs(f.end - 13 * H) < 1e-9, `3h of 4h worked, so 1h left, got ${f.end / H}h`)
})

test('Given more worked than estimated, when it is forecast, then a minute remains so the bar stays clickable', () => {
	const f = forecast({ dur: 60, sessions: [{ start: '2026-09-21T09:00:00Z', stop: '2026-09-21T12:00:00Z' }] }, 12 * H)
	assert.ok(Math.abs(f.end - (12 * H + 1 / 1440)) < 1e-9, `got ${(f.end - 12 * H) * 1440} minutes past now`)
})

test('Given worked and unworked tasks, when load is totalled, then a worked task counts only what is left', () => {
	const rem = (task: any, now = 12 * H) => remainingOf(dayNumbers(fixture(task), now).tasks[0] as any) * 1440
	const one = [{ start: '2026-09-21T09:00:00Z', stop: '2026-09-21T10:00:00Z' }]
	assert.equal(rem({ dur: 120 }), 120, 'no sessions: the whole estimate')
	assert.ok(Math.abs(rem({ dur: 120, sessions: one }) - 60) < 1e-6, 'an hour worked leaves an hour')
	assert.ok(Math.abs(rem({ dur: 30, sessions: one }) - 1) < 1e-6, 'overrun leaves a minute')
	assert.equal(rem({ dur: 120, done: true, sessions: one }), 120, 'a finished task is not re-estimated')
})

// ---- forecasts stop when the working hours stop, and resume on the other side ---------------------------
test('Given working hours, when a span crosses a night or a weekend, then it splits into work chunks', () => {
	const near = (a: [number, number][], b: [number, number][]) => assert.ok(
		a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i]![0]) < 1e-9 && Math.abs(p[1] - b[i]![1]) < 1e-9), JSON.stringify(a))
	const cal = calOf({ ...fixture(), workHours: ['08:00', '17:00'] } as any)
	near(offHours(15 * H, 1 + 11 * H, cal), [[17 * H, 1 + 8 * H]])
	near(workChunks(15 * H, 1 + 11 * H, cal), [[15 * H, 17 * H], [1 + 8 * H, 1 + 11 * H]])
	near(workChunks(9 * H, 12 * H, cal), [[9 * H, 12 * H]]) // inside one window: not split
	const week = calOf({ ...fixture(), workHours: ['08:00', '17:00'], workweek: [0, 1, 1, 1, 1, 1, 0] } as any)
	near(offHours(4 + 16 * H, 7 + 10 * H, week), [[4 + 17 * H, 7 + 8 * H]]) // Friday 16:00 to Monday 10:00: one gap
	near(offHours(0, 3, calOf(fixture())), [])                                // no working hours, every day works: no gaps
})
