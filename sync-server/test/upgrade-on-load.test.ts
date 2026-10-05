// AN UPGRADE ON LOAD KEEPS WHAT IT REPLACED. The server migrates an old plan the
// first time it is opened and writes the result over the live draft; this is
// the decision about archiving the draft first, without the storage around it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SCHEMA } from '../../shared/schedule.js'
import { upgradePlan } from '../src/upgrade'

const v6 = (dur: number): any => ({
	schemaVersion: 6, start: '2026-09-19', timeZone: 'America/Chicago', lanes: [],
	tasks: [{ id: 'a', label: 'a', dur, deps: [], color: [], createdAt: '2026-09-19T12:00:00.000Z' }],
})

test('Given a draft with unsaved changes, when it is upgraded on load, then the draft as it was is kept to archive', () => {
	const draft = v6(0.5), saved = v6(1)
	const up = upgradePlan(draft, saved, {})
	assert.equal(up.doc.schemaVersion, SCHEMA)
	assert.equal(up.before, draft, 'the unmigrated draft, to be archived before it is replaced')
	assert.equal(up.before!.schemaVersion, 6, 'and it is not mutated by the migration')
	assert.equal(up.before!.tasks[0].dur, 0.5)
})

test('Given a draft identical to the last save, when it is upgraded, then nothing needs archiving', () => {
	assert.equal(upgradePlan(v6(1), v6(1), {}).before, null, 'History already holds it')
})

test('Given a plan never saved, when it is upgraded, then the draft is archived', () => {
	assert.ok(upgradePlan(v6(1), undefined, {}).before)
})
