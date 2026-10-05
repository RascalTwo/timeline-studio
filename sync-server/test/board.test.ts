import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCommand, type Doc, type Task } from '../../shared/commands.js'
import { boardColumns, todayISO, todayOf } from '../../shared/schedule.js'

// A plan whose origin is TODAY, so day numbers are offsets from now and the
// Done window can be tested without a clock.
const today = todayISO()
// v4 FIXTURES, day numbers and all: `boardColumns` migrates, so they arrive as v6.
const task = (id: string, over: any = {}): Task => ({
	id, label: id, lane: 'me', border: 'b1', fill: 'f1', shape: 's1', color: [], deps: [], dur: 1, ...over,
})
const plan = (tasks: Task[], over: Partial<Doc> = {}): Doc => ({
	schemaVersion: 4, title: 'Board', start: today,
	lanes: [{ id: 'me', label: 'Me', cap: 10 }], // roomy, so only deps and sign-off hold anything
	borders: [{ id: 'b1', label: 'plain', style: 'solid' }],
	fills: [{ id: 'f1', label: 'known', pattern: 'solid' }],
	shapes: [{ id: 's1', label: 'bar', shape: 'soft' }],
	colors: [], milestones: [], tasks, ...over,
})
const ids = (rows: any[]) => rows.map((r) => r.id)

test('Given a plan, when it is put on the board, then each task lands in the column /api/ready implies', () => {
	const t0 = todayOf(plan([]))
	const c = boardColumns(plan([
		task('ready', { refinedAt: 0 }),
		task('waits', { deps: ['ready'], refinedAt: 0 }),
		task('unread', { noQueue: true }),
		task('doing', { actualStart: t0 - 2 }),
		task('fresh', { actualStart: t0 - 1, actualEnd: t0 + 1 }),
		task('stale', { actualStart: t0 - 30, actualEnd: t0 - 20 }),
	]))
	assert.deepEqual(ids(c.ready), ['ready'])
	// Unrefined goes to Blocked, with the reason the API gives — not softened.
	assert.deepEqual(ids(c.blocked).sort(), ['unread', 'waits'])
	assert.equal(c.blocked.find((r) => r.id === 'unread').waitingOn, 'unrefined')
	// A v4 start with no sessions upgrades to a session of no length: worked on, not running.
	assert.deepEqual(ids(c.paused), ['doing'])
	assert.deepEqual(ids(c.running), [])
	// Finished today is in; finished three weeks ago is outside the 7-day default.
	assert.deepEqual(ids(c.done), ['fresh'])
})

test('Given a look-back, when the board is built, then Done holds exactly that many days', () => {
	const t0 = todayOf(plan([]))
	// last day worked = actualEnd - 1: today, 2 days ago, 3 days ago
	const tasks = [
		task('today', { actualStart: t0, actualEnd: t0 + 1 }),
		task('two', { actualStart: t0 - 2, actualEnd: t0 - 1 }),
		task('three', { actualStart: t0 - 3, actualEnd: t0 - 2 }),
	]
	assert.deepEqual(ids(boardColumns(plan(tasks), 3).done), ['today', 'two'])
	assert.deepEqual(ids(boardColumns(plan(tasks), 4).done), ['today', 'two', 'three'])
	assert.deepEqual(ids(boardColumns(plan(tasks), 0).done), [])
})

test('Given the look-back, when a caller tries to save it on the plan, then it is refused', () => {
	// A view setting since 2026-09-26: looking back is not an edit to the plan.
	assert.match(String(validateCommand(plan([]), { type: 'patchDoc', patch: { doneWindow: 14 } } as any)), /may not touch "doneWindow"/)
})
