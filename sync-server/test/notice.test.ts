// NOTICE: `notice`, free text pinned above the chart. Display only, so the things to
// pin are what patchDoc accepts and that the scheduler does not read it.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand, NOTICE_MAX, validateCommand } from '../../shared/commands.js'
import { orderSignature } from '../../shared/schedule.js'

const doc = (over: any = {}): any => ({ start: '2026-09-21', lanes: [{ id: 'me', label: 'Me', cap: 1 }], tasks: [], ...over })

test('patchDoc takes text up to NOTICE_MAX characters, or null to clear it', () => {
	const ok = (notice: any) => validateCommand(doc(), { type: 'patchDoc', patch: { notice } })
	for (const good of ['', 'Calendar synced 2:05 PM', 'x'.repeat(NOTICE_MAX), null]) assert.equal(ok(good), null, String(good).slice(0, 20))
	for (const bad of ['x'.repeat(NOTICE_MAX + 1), 7, true, ['a'], { a: 1 }]) assert.match(String(ok(bad)), /notice/, JSON.stringify(bad).slice(0, 20))
})

test('null removes it from the document', () => {
	const d = doc({ notice: 'old' })
	applyCommand(d, { type: 'patchDoc', patch: { notice: null } })
	assert.equal('notice' in d, false)
})

test('the scheduler does not read it', () => {
	assert.equal(orderSignature(doc()), orderSignature(doc({ notice: 'anything' })))
})
