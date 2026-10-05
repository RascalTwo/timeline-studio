// WEEK START: `weekStart`, the day a week begins on, 0 (Sunday) to 6. Display only —
// the calendar's week and the timeline's week rules — so the one thing to pin here is
// what patchDoc accepts, and that the scheduler does not read it.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCommand } from '../../shared/commands.js'
import { orderSignature } from '../../shared/schedule.js'

const doc = (over: any = {}): any => ({ start: '2026-09-21', lanes: [{ id: 'me', label: 'Me', cap: 1 }], tasks: [], ...over })

test('patchDoc takes a weekday from 0 (Sunday) to 6, or null for Sunday', () => {
	const ok = (weekStart: any) => validateCommand(doc(), { type: 'patchDoc', patch: { weekStart } })
	for (const good of [0, 1, 6, null]) assert.equal(ok(good), null, JSON.stringify(good))
	for (const bad of [7, -1, 1.5, '1', 'mon', true]) assert.match(String(ok(bad)), /weekStart/, JSON.stringify(bad))
})

test('the scheduler does not read it', () => {
	assert.equal(orderSignature(doc()), orderSignature(doc({ weekStart: 1 })))
})
