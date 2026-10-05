// /api/ready answers "what can I start", so done and in-flight work must not be in it by default.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Doc, Task } from '../../shared/commands.js'
import { todayISO, todayOf } from '../../shared/schedule.js'
import { readyRows } from '../src/scheduler'

const task = (id: string, over: any = {}): Task => ({
	id, label: id, lane: 'me', border: 'b1', fill: 'f1', shape: 's1', color: [], deps: [], dur: 1, ...over,
})
const doc = (tasks: Task[]): Doc => ({
	schemaVersion: 4, title: 'Q', start: todayISO(),
	lanes: [{ id: 'me', label: 'Me', cap: 10 }],
	borders: [{ id: 'b1', label: 'plain', style: 'solid' }],
	fills: [{ id: 'f1', label: 'known', pattern: 'solid' }],
	shapes: [{ id: 's1', label: 'bar', shape: 'soft' }],
	colors: [], milestones: [], tasks,
})
const t0 = todayOf(doc([]))
const plan = doc([
	task('done', { actualStart: t0 - 5, actualEnd: t0 - 4 }),
	task('doing', { actualStart: t0 - 1 }),   // v4: upgraded to a session of no length, so paused
	task('blocked', { deps: ['todo'], refinedAt: 0 }),
	task('todo', { refinedAt: 0 }),
])

test('Given done and doing work, when the queue is asked for, then only not-started tasks come back, blocked ones included', () => {
	const rows = readyRows(plan, false) as any[]
	assert.deepEqual(rows.map((r) => r.id).sort(), ['blocked', 'todo'])
	assert.equal(rows.find((r) => r.id === 'blocked').waitingOn, 'deps', 'a blocked row keeps its reason')
})

test('Given all=1, when the queue is asked for, then every task is back with its status', () => {
	const rows = readyRows(plan, true) as any[]
	assert.deepEqual(rows.map((r) => r.status).sort(), ['done', 'paused', 'todo', 'todo'])
})
