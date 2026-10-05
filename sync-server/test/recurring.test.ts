// A REPEATING TASK is a series of ordinary tasks, each carrying `recur`. The rule lives on the newest copy; finishing a copy
// (or setting the rule) keeps `ahead` copies waiting beyond the open one. No clock is read: the copies are derived from the
// anchor, so the page and the server build the same ones.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand } from '../../shared/commands.js'

const fixture = (task: any, timeZone = 'UTC'): any => ({
	schemaVersion: 10, title: 'T', start: '2026-01-01', timeZone,
	lanes: [{ id: 'me', label: 'Me', cap: 1 }],
	borders: [{ id: 'b1', label: 'plain', style: 'solid' }],
	fills: [{ id: 'f1', label: 'known', pattern: 'solid' }],
	shapes: [{ id: 's1', label: 'bar', shape: 'soft' }],
	colors: [], milestones: [],
	tasks: [{ id: 'rent', label: 'Pay rent', lane: 'me', border: 'b1', fill: 'f1', shape: 's1', color: [], dur: 30, deps: [], ...task }],
})
const dates = (doc: any) => doc.tasks.map((t: any) => t.notBefore)

test('Given a monthly rule with one copy ahead, when it is set, then the next month waits, and finishing the first adds another', () => {
	const doc = fixture({ notBefore: '2026-01-01T15:00:00Z', refinedAt: '2026-01-01T00:00:00Z' })
	applyCommand(doc, { type: 'setRecur', id: 'rent', recur: { n: 1, unit: 'month' }, at: '2026-01-01T00:00:00Z' })
	assert.deepEqual(dates(doc), ['2026-01-01T15:00:00Z', '2026-02-01T15:00:00.000Z'].map((x) => doc.tasks.find((t: any) => t.notBefore.startsWith(x.slice(0, 10))).notBefore))
	assert.deepEqual(doc.tasks.map((t: any) => t.id), ['rent', 'rent-1'])
	applyCommand(doc, { type: 'finishTask', id: 'rent', at: '2026-01-02T00:00:00Z' })
	assert.deepEqual(doc.tasks.map((t: any) => t.id), ['rent', 'rent-1', 'rent-2'])
	assert.equal(doc.tasks[2].notBefore, '2026-03-01T15:00:00.000Z')
})

test('Given a copy, then it keeps the sign-off and the due offset but none of the history', () => {
	const doc = fixture({ notBefore: '2026-01-01T09:00:00Z', due: '2026-01-03T09:00:00Z', refinedAt: '2026-01-01T00:00:00Z', comments: [{ id: 'c', text: 'x', at: '2026-01-01T00:00:00Z' }], sessions: [{ start: '2026-01-01T09:00:00Z', stop: '2026-01-01T09:30:00Z' }] })
	applyCommand(doc, { type: 'setRecur', id: 'rent', recur: { n: 1, unit: 'week' }, at: '2026-01-01T00:00:00Z' })
	const c = doc.tasks[1]
	assert.equal(c.refinedAt, '2026-01-01T00:00:00Z')
	assert.equal(c.notBefore, '2026-01-08T09:00:00.000Z')
	assert.equal(c.due, '2026-01-10T09:00:00.000Z')
	assert.equal(c.createdAt, '2026-01-01T00:00:00Z')
	assert.ok(!c.comments && !c.sessions && !c.done)
})

test('Given a daily task at 9:30 Central, when the clocks go back, then the copy is still 9:30 on the wall', () => {
	const doc = fixture({ notBefore: '2026-10-31T14:30:00Z' }, 'America/Chicago') // 9:30 CDT
	applyCommand(doc, { type: 'setRecur', id: 'rent', recur: { n: 1, unit: 'day' } })
	assert.equal(doc.tasks[1].notBefore, '2026-11-01T15:30:00.000Z') // 9:30 CST, not 8:30
})

test('Given the 31st, when it repeats monthly, then short months clamp and the 31st comes back', () => {
	const doc = fixture({ notBefore: '2026-01-31T12:00:00Z' })
	applyCommand(doc, { type: 'setRecur', id: 'rent', recur: { n: 1, unit: 'month', ahead: 2 } })
	assert.deepEqual(doc.tasks.map((t: any) => t.notBefore.slice(0, 10)), ['2026-01-31', '2026-02-28', '2026-03-31'])
})

test('Given ahead 3, then three copies wait beyond the open one; given ahead 0, none do', () => {
	const doc = fixture({ notBefore: '2026-01-01T12:00:00Z' })
	applyCommand(doc, { type: 'setRecur', id: 'rent', recur: { n: 1, unit: 'day', ahead: 3 } })
	assert.equal(doc.tasks.length, 4)
	const none = fixture({ notBefore: '2026-01-01T12:00:00Z' })
	applyCommand(none, { type: 'setRecur', id: 'rent', recur: { n: 1, unit: 'day', ahead: 0 } })
	applyCommand(none, { type: 'finishTask', id: 'rent', at: '2026-01-01T13:00:00Z' })
	assert.equal(none.tasks.length, 2, 'finishing the only open copy brings the next one')
})

test('Given a series, when it is switched off, then no copy repeats; and a rule needs a notBefore and cannot change interval', () => {
	const doc = fixture({ notBefore: '2026-01-01T12:00:00Z' })
	applyCommand(doc, { type: 'setRecur', id: 'rent', recur: { n: 1, unit: 'day' } })
	assert.throws(() => applyCommand(doc, { type: 'setRecur', id: 'rent', recur: { n: 2, unit: 'day' } }), /already repeats/)
	applyCommand(doc, { type: 'setRecur', id: 'rent', recur: null })
	assert.ok(doc.tasks.every((t: any) => !t.recur))
	applyCommand(doc, { type: 'finishTask', id: 'rent', at: '2026-01-01T13:00:00Z' })
	assert.equal(doc.tasks.length, 2)
	assert.throws(() => applyCommand(fixture({}), { type: 'setRecur', id: 'rent', recur: { n: 1, unit: 'day' } }), /notBefore/)
})

test('Given a task with only a due date, when it repeats, then the copies are due on the calendar and have no start', () => {
	const doc = fixture({ due: '2026-10-26T22:00:00Z' })
	applyCommand(doc, { type: 'setRecur', id: 'rent', recur: { n: 1, unit: 'month', ahead: 2 } })
	assert.deepEqual(doc.tasks.map((t: any) => t.due.slice(0, 10)), ['2026-10-26', '2026-11-26', '2026-12-26'])
	assert.ok(doc.tasks.every((t: any) => !t.notBefore))
})

test('Given one copy whose due date was edited, when the series tops up, then later copies keep the rule, not the edit', () => {
	const doc = fixture({ due: '2026-10-26T22:00:00Z' })
	applyCommand(doc, { type: 'setRecur', id: 'rent', recur: { n: 1, unit: 'month', ahead: 1 } })
	doc.tasks[1].due = '2026-11-28T22:00:00Z' // Joseph: the 28th this once
	applyCommand(doc, { type: 'finishTask', id: 'rent', at: '2026-10-21T12:00:00Z' })
	assert.equal(doc.tasks[2].due.slice(0, 10), '2026-12-26')
})
