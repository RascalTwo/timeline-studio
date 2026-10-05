// A TASK HOLDS ONLY ITS OWN FIELDS (schema v9). The v8 -> v9 rung drops every other key, and the document check
// refuses one, so a misspelt or retired field can no longer sit in a plan where nothing reads it.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyMigrations } from '../../shared/schedule.js'
import { invalid } from '../src/validate.js'

const doc = (t: any, v = 9): any => ({
	schemaVersion: v, title: 'x', start: '2026-09-21', timeZone: 'UTC', lanes: [{ id: 'me' }], borders: [{ id: 'b' }],
	fills: [{ id: 'f' }], shapes: [{ id: 's' }], colors: [], milestones: [],
	tasks: [{ id: 't', label: 't', lane: 'me', border: 'b', fill: 'f', shape: 's', color: [], deps: [], dur: 60,
		createdAt: '2026-09-20T00:00:00.000Z', ...t }],
})

test('Given a v8 task with a stray key, when it is upgraded, then the key goes and every task field stays', () => {
	const up = applyMigrations(doc({ description: 'misspelt', desc: 'kept', noQueue: true }, 8))
	assert.equal(up.schemaVersion, 9)
	assert.deepEqual(up.tasks[0], doc({ desc: 'kept', noQueue: true }).tasks[0])
	assert.equal(invalid(up), null)
})

test('Given a current document carrying a stray task key, when it is checked, then it is refused by name', () => {
	assert.match(String(invalid(doc({ description: 'x' }))), /task "t": description is not a task field/)
})
