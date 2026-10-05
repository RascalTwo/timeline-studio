// COMMENTS: the conversation on a task. The claim worth pinning is what they do
// NOT do — a comment is commentary, not a change to what the task says, so the
// sign-off and `updatedAt` survive all three commands.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand, validateCommand } from '../../shared/commands.js'

const doc = (): any => ({
	schemaVersion: 10, start: '2026-09-01', timeZone: 'America/Chicago', lanes: [{ id: 'L' }], tasks: [{
		id: 't', label: 't', lane: 'L', border: 'b', fill: 'f', shape: 's', color: [], deps: [], dur: 60,
		createdAt: '2026-09-01T12:00:00.000Z', refinedAt: '2026-09-02T12:00:00.000Z', updatedAt: '2026-09-02T11:00:00.000Z',
	}],
})
const AT = '2026-09-26T15:00:00.000Z', LATER = '2026-09-26T16:00:00.000Z'

test('Given a refined task, when it is commented on, edited and cleaned up, then the sign-off never moves', () => {
	const d = doc(), t = () => d.tasks[0]
	applyCommand(d, { type: 'addComment', id: 't', comment: { id: 'c1', text: 'waiting on **Sam**', by: 'Rascal Two' }, at: AT } as any)
	assert.deepEqual(t().comments, [{ id: 'c1', text: 'waiting on **Sam**', at: AT, by: 'Rascal Two' }])
	applyCommand(d, { type: 'editComment', id: 't', commentId: 'c1', text: 'Leah replied', at: LATER } as any)
	assert.equal(t().comments[0].text, 'Leah replied')
	assert.equal(t().comments[0].editedAt, LATER, 'an edit is dated')
	assert.equal(t().comments[0].at, AT, 'and the original time is kept')
	applyCommand(d, { type: 'removeComment', id: 't', commentId: 'c1' } as any)
	assert.ok(!('comments' in t()), 'the last one gone takes the key with it, like every other null clear')
	assert.equal(t().refinedAt, '2026-09-02T12:00:00.000Z', 'still refined')
	assert.equal(t().updatedAt, '2026-09-02T11:00:00.000Z', 'and not marked edited')
})

test('Given bad comment commands, when they are validated, then each is refused by name', () => {
	const d = doc()
	applyCommand(d, { type: 'addComment', id: 't', comment: { id: 'c1', text: 'x', by: 'a' }, at: AT } as any)
	const v = (cmd: any) => validateCommand(d, cmd)
	assert.match(v({ type: 'addComment', id: 't', comment: { id: 'c1', text: 'again' } })!, /already has a comment/)
	assert.match(v({ type: 'addComment', id: 't', comment: { id: 'c2', text: '   ' } })!, /non-empty/)
	assert.match(v({ type: 'addComment', id: 't', comment: { id: 'c2', text: 'x', at: '2026-09-26T15:00' } })!, /with a zone/)
	assert.match(v({ type: 'editComment', id: 't', commentId: 'nope', text: 'x' })!, /no comment/)
	assert.match(v({ type: 'editComment', id: 't', commentId: 'c1', text: '' })!, /remove the comment instead/)
	assert.match(v({ type: 'removeComment', id: 'nope', commentId: 'c1' })!, /no task/)
})
