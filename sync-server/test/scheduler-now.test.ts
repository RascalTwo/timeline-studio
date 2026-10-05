// "NOW" IN THE SCHEDULER — three fixes from 2026-09-26, each found on a real
// one-lane plan that had finished work all morning and still showed nothing
// Ready. Each test is written so the code before the fix fails it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calOf, instantOfDay, readiness, sched, todayISO, todayOf } from '../../shared/schedule.js'

const lane = [{ id: 'me', label: 'Me', cap: 1 }]
const t = (id: string, over: any = {}): any =>
	({ id, label: id, lane: 'me', border: 'b', fill: 'f', shape: 's', color: [], deps: [], dur: 1, ...over })

test('Given finished work recorded as lasting past now, when the lane is scheduled, then it frees at now', () => {
	// Done from 0.1 to 0.9 (a whole-day-style end), and it is now 0.5.
	const st = sched([t('done', { actualStart: 0.1, actualEnd: 0.9 }), t('next')], lane, calOf({} as any), 0, 0.5)
	assert.equal(st.next, 0.5, 'the lane is free the moment the record says the work is done, capped at now')
	// Without a `now`, nothing is capped — the reference plans are unchanged.
	assert.equal(sched([t('done', { actualStart: 0.1, actualEnd: 0.9 }), t('next')], lane, calOf({} as any), 0).next, 0.9)
})

test('Given noQueue work in progress, when the lane is scheduled, then it holds nothing', () => {
	// An agent's own task, started, exempt from the queue. It held the human's
	// lane for its whole estimate because the actuals pass ignored the flag.
	const st = sched([t('agent', { noQueue: true, actualStart: 0.2, dur: 5 }), t('mine')], lane, calOf({} as any), 0)
	assert.equal(st.mine, 0)
})

test('Given a queue whose head could start before now, when readiness is asked, then the head is Ready now', () => {
	// The lane freed ten minutes ago. `why` still says "lane" — the queue decided
	// the start — but that start is in the past, so nothing holds the task.
	// (Within twenty minutes of midnight the finished task sits yesterday and the
	// old code passes too; the assertion still holds.)
	const doc: any = {
		schemaVersion: 6, start: todayISO({ timeZone: 'America/Chicago' }), timeZone: 'America/Chicago',
		lanes: lane, borders: [{ id: 'b' }], fills: [{ id: 'f' }], shapes: [{ id: 's' }], colors: [], milestones: [],
		tasks: [],
	}
	const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
	doc.tasks = [
		t('done', { actualStart: ago(20), actualEnd: ago(10), createdAt: ago(60) }),
		t('head', { refinedAt: ago(60), createdAt: ago(60) }),
		t('second', { refinedAt: ago(60), createdAt: ago(60) }),
	]
	const by = Object.fromEntries(readiness(doc).map((r: any) => [r.id, r]))
	assert.equal(by.head.ready, true, JSON.stringify(by.head))
	assert.equal(by.second.ready, false, 'one lane, one thing at a time')
	assert.equal(by.second.waitingOn, 'lane')
	assert.ok(todayOf(doc) === 0 && instantOfDay(0, doc) <= new Date().toISOString())
})
