// THE TIME OF DAY SURVIVES THE WIRE. Since v6 every date on a task has a clock,
// and the scheduler counts in day numbers whose fraction IS that clock. An API
// field that rounds or truncates one to a whole day tells an agent something
// false: "on time" for an hour late, "this morning" for late afternoon.
//
// v4 fixtures (day numbers) so the times are exact; `readiness` and `verdict`
// migrate them on the way in. Work is pinned far past today with `notBefore`,
// so the numbers do not depend on the day the suite runs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readiness, verdict } from '../../shared/schedule.js'

const task = (id: string, over: any = {}): any => ({
	id, label: id, lane: 'me', border: 'b1', fill: 'f1', shape: 's1', color: [], dur: 1, deps: [], ...over,
})
const fixture = (tasks: any[], milestones: any[] = []): any => ({
	schemaVersion: 4, title: 'T', start: '2026-09-21', timeZone: 'UTC',
	lanes: [{ id: 'me', label: 'Me', cap: 1 }],
	borders: [{ id: 'b1', label: 'plain', style: 'solid' }],
	fills: [{ id: 'f1', label: 'known', pattern: 'solid' }],
	shapes: [{ id: 's1', label: 'bar', shape: 'soft' }],
	colors: [], milestones, tasks,
})
const DAY100 = '2026-12-30' // 2026-09-21 + 100 days

test('Given work that starts at 3pm, when readiness is asked for, then starts and ends carry the clock', () => {
	const doc = fixture([task('pm', { notBefore: 100.625, dur: 1 / 24, noQueue: true })]) // 15:00, one hour
	const r = (readiness(doc) as any[]).find((x) => x.id === 'pm')
	assert.equal(r.starts, `${DAY100}T15:00:00.000Z`)
	assert.equal(r.ends, `${DAY100}T16:00:00.000Z`)
})

test('Given a milestone missed by hours, when the verdict is asked for, then byDays says by how much', () => {
	const doc = fixture([task('late', { notBefore: 100, dur: 1.25, ms: 'm', noQueue: true })], // ends day 101 06:00
		[{ id: 'm', label: 'M', date: '2026-12-31' }])                                        // day 101
	const m = (verdict(doc) as any).milestones.find((x: any) => x.id === 'm')
	assert.equal(m.met, false)
	assert.equal(m.byDays, 0.25, 'six hours late is a quarter day, not zero')
	assert.equal(m.finish, '2026-12-31T06:00:00.000Z')
})

test('Given 4pm with working hours 8–5, when a 2h task due at 5pm is forecast, then it starts now and is late', async () => {
	const { mock } = await import('node:test')
	mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-21T16:00:00Z') }) // Monday 4pm, plan zone UTC
	try {
		const doc = { ...fixture([task('pm', { dur: 2 / 24, due: 17 / 24 })]), workHours: ['08:00', '17:00'] }
		const r = (readiness(doc) as any[]).find((x) => x.id === 'pm')
		// Not 8am: that morning has gone. One hour fits before closing, the other opens tomorrow.
		assert.equal(r.starts, '2026-09-21T16:00:00.000Z')
		assert.equal(r.ends, '2026-09-22T09:00:00.000Z')
		assert.ok(r.slackDays < 0, `late, not "7 hrs to spare" (got ${r.slackDays})`)
	} finally { mock.timers.reset() }
})
