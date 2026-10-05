// PAUSED WORK GOES BACK IN THE QUEUE (ADR 0018). Found 2026-10-04 on the calendar:
// one running task and three paused ones on a one-lane plan all forecast their
// remainders from the same minute, because every started task was seeded at its
// first session and forecast from now. Each test fails on the code before the fix.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { applyCommand } from '../../shared/commands.js'
import { CAL_ALL, SCHEMA, endOf, sched, suggestReorders } from '../../shared/schedule.js'

const lane = [{ id: 'me', label: 'Me', cap: 1 }]
const cal = CAL_ALL as any
const NOW = 0.5
const t = (id: string, over: any = {}): any =>
	({ id, label: id, lane: 'me', border: 'b', fill: 'f', shape: 's', color: [], deps: [], dur: 0.3, ...over })
// As `dayNumbers` projects them: started at `at`, 0.1 worked, forecast floor now.
const running = (id: string, over: any = {}) =>
	t(id, { sessions: [{ start: 'x', stop: null }], actualStart: 0.4, worked: 0.1, resume: NOW, ...over })
const paused = (id: string, over: any = {}) =>
	t(id, { sessions: [{ start: 'x', stop: 'y' }], actualStart: 0.1, worked: 0.1, resume: NOW, ...over })

test('Given a running and a paused task on a one-lane plan, when scheduled, then the paused remainder waits for the running one', () => {
	const ts = [running('run'), paused('held'), t('next', { dur: 0.1 })]
	const st = sched(ts, lane, cal, NOW, NOW)
	assert.equal(st.run, 0.4, 'running work keeps its real start')
	assert.ok(Math.abs(st.held - endOf(ts[0], st.run, cal)) < 1e-9, `paused starts when the lane frees: ${st.held}`)
	assert.ok(Math.abs(endOf(ts[1], st.held, cal) - (st.held + 0.2)) < 1e-9, 'and spends only what is left')
	assert.ok(st.next >= endOf(ts[1], st.held, cal) - 1e-9, 'unstarted work behind it in the row order waits for it')
})

test('Given a paused task below unstarted work in the lane, when scheduled, then the row order decides', () => {
	const st = sched([t('first', { dur: 0.1 }), paused('held')], lane, cal, NOW, NOW)
	assert.equal(st.first, NOW)
	assert.ok(Math.abs(st.held - (NOW + 0.1)) < 1e-9, `${st.held}`)
})

test('Given paused work that skips the queue or waits on unfinished work, when scheduled, then it forecasts from now', () => {
	const st = sched([running('run'), paused('agent', { noQueue: true }), t('later', { dur: 5 }), paused('early', { deps: ['later'], lane: 'other' })],
		[...lane, { id: 'other', label: 'Other', cap: 1 }], cal, NOW, NOW)
	assert.equal(st.agent, NOW, 'noQueue never holds or waits for a slot')
	assert.equal(st.early, NOW, 'starting it already overrode what it waits on')
})

// A stored plan for the reorder search, its clock pinned at 10:30 Chicago.
const plan = (tasks: any[]): any => ({ schemaVersion: SCHEMA, title: 'p', start: '2026-09-21', timeZone: 'America/Chicago',
	lanes: [{ id: 'me', label: 'Me', cap: 1 }], borders: [{ id: 'b', label: 'b', style: 'solid' }], fills: [{ id: 'f', label: 'f', pattern: 'solid' }],
	shapes: [{ id: 's', label: 's', shape: 'soft' }], colors: [], milestones: [], tasks })
const held = (over: any = {}) => t('held', { dur: 240, sessions: [{ start: '2026-09-23T13:00:00Z', stop: '2026-09-23T14:00:00Z' }], ...over })
const reorder = (doc: any) => {
	mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-23T15:30:00Z') })
	try { return suggestReorders(doc) } finally { mock.timers.reset() }
}
const rankFirst = (doc: any, a: string, b: string) => applyCommand(doc, { type: 'addRankAnswer', a, b, verdict: -1 } as any)

test('Given a deadline stuck behind paused work, when Auto-order searches, then it moves the urgent task ahead', () => {
	// Its memo keyed orders by unstarted tasks only, so moving a row past a paused one looked like no change at all.
	const r = reorder(plan([held(), t('urgent', { dur: 60, due: '2026-09-23T17:00:00Z' })]))
	assert.ok(r.base.tardy > 0, 'late as ordered')
	assert.ok(r.suggestions.some((s: any) => s.gain > 0), JSON.stringify(r.suggestions))
})

// PAUSED BEFORE UNSTARTED (ADR 0019): a key between the dates and the person's ranking.
test('Given paused work below unstarted work, when Auto-order searches, then it moves the paused task up', () => {
	const [s] = reorder(plan([t('fresh', { dur: 60 }), held()])).suggestions
	// Either row may move; both leave held on top.
	assert.ok(s && s.paused && s.gain === 0 && (s.id === 'held' ? s.to === 0 : s.to === 1), JSON.stringify(s))
})

test('Given a deadline that paused work would make late or tight, when Auto-order searches, then the dates win', () => {
	assert.deepEqual(reorder(plan([t('urgent', { dur: 60, due: '2026-09-23T17:00:00Z' }), held()])).suggestions, [])
})

test('Given a ranking that puts unstarted work first, when Auto-order searches, then paused work still goes first', () => {
	const doc = plan([t('fresh', { dur: 60 }), held()]); rankFirst(doc, 'fresh', 'held')
	assert.equal(reorder(doc).suggestions[0]?.paused, true, 'paused outranks the ranking')
	const done = plan([held(), t('fresh', { dur: 60 })]); rankFirst(done, 'fresh', 'held')
	assert.deepEqual(reorder(done).suggestions, [], 'and the ranking cannot undo it')
})

test('Given two paused tasks, when Auto-order searches, then the ranking orders them', () => {
	const doc = plan([held(), held({ id: 'other', label: 'other' })]); rankFirst(doc, 'other', 'held')
	const [s] = reorder(doc).suggestions
	assert.ok(s && !s.paused && s.ranked === 1, JSON.stringify(s))
})
