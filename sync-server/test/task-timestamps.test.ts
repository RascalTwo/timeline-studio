// WHEN A TASK WAS ADDED, AND WHEN ITS WORDING LAST CHANGED.
//
// Two properties, and the second one is the whole design: `updatedAt` moves on
// EXACTLY what voids a sign-off — the label, the description, the duration — and
// on nothing else. A field that moved on every command would report "rewritten"
// when what happened was "rescheduled", and ticking a task off would make it
// look freshly reworded.
//
// The third property is invisible in a single process and expensive to discover
// in production: the applier takes the instant off the COMMAND and never off a
// clock. The same command is applied independently by the server and by every
// client, so a clock read inside `applyCommand` writes a different document in
// each of them — and `/save` decides whether to archive by comparing serialised
// documents, so the plan would read as permanently dirty. Asserting the stamped
// value is the command's own `at`, to the millisecond, is what catches that: a
// clock would write "now" instead. Applying the same command to two copies and
// diffing them was the obvious test and is a WORSE one — two applies inside the
// same millisecond agree even when the applier is wrong.
//
// The fixture is invented, like every other one here.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand, type Doc, type Task } from '../../shared/commands.js'

const AT = '2026-09-20T18:30:00.000Z'
const LATER = '2026-09-21T09:00:00.000Z'

const task = (id: string, over: Partial<Task> = {}): Task => ({
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

const fixture = (tasks: Task[]): Doc => ({
	schemaVersion: 4,
	start: '2026-09-21',
	lanes: [{ id: 'me', label: 'Me', cap: 1 }],
	borders: [{ id: 'b1', label: 'plain', style: 'solid' }],
	fills: [{ id: 'f1', label: 'known', pattern: 'solid' }],
	shapes: [{ id: 's1', label: 'bar', shape: 'soft' }],
	colors: [],
	milestones: [],
	tasks,
})

const only = (doc: Doc) => doc.tasks[0]!

test('Given a task added with a command that carries `at`, then it is stamped created and not edited', () => {
	const doc = fixture([])
	applyCommand(doc, { type: 'addTask', task: { id: 'paint', label: 'Paint', dur: 1 }, at: AT })
	assert.equal(only(doc).createdAt, AT)
	assert.equal(only(doc).updatedAt, undefined, 'being born is not an edit')
})

test('Given a task that already carries createdAt, when it is added, then its own date is kept', () => {
	// An import or a fork restoring a task: rewriting this would date somebody's
	// old work to the moment it was copied.
	const doc = fixture([])
	applyCommand(doc, {
		type: 'addTask',
		task: { id: 'paint', label: 'Paint', dur: 1, createdAt: '2020-01-01T00:00:00.000Z' },
		at: AT,
	})
	assert.equal(only(doc).createdAt, '2020-01-01T00:00:00.000Z')
})

test('Given the three commands that change what a task SAYS, then each one stamps updatedAt and voids the sign-off', () => {
	for (const cmd of [
		{ type: 'renameTask', id: 'paint', label: 'Paint it' },
		{ type: 'setTaskDesc', id: 'paint', desc: 'two coats' },
		{ type: 'setDuration', id: 'paint', dur: 4 },
	]) {
		const doc = fixture([task('paint', { label: 'paint', refinedAt: '2026-09-03T12:00:00.000Z' })])
		applyCommand(doc, { ...cmd, at: LATER })
		assert.equal(only(doc).updatedAt, LATER, `${cmd.type} should have stamped it`)
		assert.equal(only(doc).refinedAt, undefined, `${cmd.type} should have voided the sign-off`)
	}
})

test('Given a command that only reschedules, then the task is not marked as edited', () => {
	// THE FALSIFIER FOR THE WHOLE FIELD. If any of these stamps, "edited" stops
	// meaning "rewritten" and the field is just "touched", which the plan can
	// already tell you from the archive.
	for (const cmd of [
		{ type: 'finishTask', id: 'paint', at: '2026-09-02T14:00:00Z' },
		{ type: 'setTaskChannel', id: 'paint', channel: 'lane', value: 'me' },
		{ type: 'addDep', id: 'paint', dep: 'prep' },
		{ type: 'setDue', id: 'paint', due: '2026-09-09T17:00:00Z' },
		{ type: 'setNoQueue', id: 'paint', noQueue: true },
		{ type: 'setTaskUrl', id: 'paint', url: 'https://example.com/x' },
	]) {
		const doc = fixture([task('prep'), task('paint')])
		applyCommand(doc, { ...cmd, at: LATER })
		const t = doc.tasks.find((x) => x.id === 'paint')!
		assert.equal(t.updatedAt, undefined, `${cmd.type} must not read as an edit`)
	}
})

test('Given a wording command that changes nothing, then nothing is stamped', () => {
	// Every one of the three is sent on blur by a controlled input, so re-focusing
	// a field and tabbing out re-sends the value it already had. That must not
	// count as an edit — for the same reason it must not clear a sign-off.
	const doc = fixture([task('paint', { label: 'paint', refinedAt: '2026-09-03T12:00:00.000Z' })])
	applyCommand(doc, { type: 'renameTask', id: 'paint', label: 'paint', at: LATER })
	assert.equal(only(doc).updatedAt, undefined)
	assert.equal(only(doc).refinedAt, '2026-09-03T12:00:00.000Z', 'and the sign-off survives')
})

test('Given no `at` on the command, then nothing is stamped rather than guessed', () => {
	const doc = fixture([task('paint')])
	applyCommand(doc, { type: 'renameTask', id: 'paint', label: 'Paint it' })
	assert.equal(only(doc).updatedAt, undefined)
	assert.equal(only(doc).label, 'Paint it', 'and the edit itself still happened')
})
