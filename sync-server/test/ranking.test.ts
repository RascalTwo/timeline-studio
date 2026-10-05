// THE RANKING: one plan-level "which should happen first?" ranking, stored as answers only,
// derived with the vendored @rascaltwo/pairwise-sorter, and read by Auto-order as a
// tie-break after dates. Driven through the real command applier, the real reorder search
// and, for Auto-order, a real CommandRoom and worker.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand, rankOf, validateCommand } from '../../shared/commands.js'
import { orderSignature, readiness, suggestReorders } from '../../shared/schedule.js'
import { CommandRoom } from '../src/room'

process.env.DATA_BUCKET ??= 'unused-by-this-test'
const { afterApply, settled } = await import('../src/rooms')

const t0 = Date.parse('2026-09-01T12:00:00Z')
const task = (id: string, i: number, extra: any = {}) => ({
	id, label: id, lane: 'L1', border: 'b', fill: 'f', shape: 's', color: [], deps: [], dur: 60,
	createdAt: new Date(t0 + i * 1000).toISOString(), ...extra,
})
const plan = (ids: string[], extra: any = {}): any => ({
	schemaVersion: 9, title: 't', start: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }),
	timeZone: 'America/Chicago',
	lanes: [{ id: 'L1', label: 'Me', cap: 1 }], borders: [{ id: 'b', label: 'b', style: 'solid' }],
	fills: [{ id: 'f', label: 'f', pattern: 'solid' }], shapes: [{ id: 's', label: 's', shape: 'soft' }],
	colors: [], milestones: [],
	tasks: ids.map((id, i) => task(id, i)),
	...extra,
})
const apply = (doc: any, cmd: any) => { applyCommand(doc, cmd); return doc }
/** Answer every question the ranking asks, preferring whatever `first` puts earlier. */
const rankAll = (doc: any, first: string[]) => {
	for (let n = 0; n < 100; n++) {
		const next = rankOf(doc).next
		if (!next) return doc
		const [a, b] = next
		apply(doc, { type: 'addRankAnswer', a, b, verdict: first.indexOf(a) < first.indexOf(b) ? -1 : 1 })
	}
	throw new Error('ranking never finished')
}
const ranked = (doc: any) => {
	const { rank } = rankOf(doc)
	return [...rank].sort((x, y) => x[1] - y[1]).map(([id]) => id)
}

test('Given rank answers, when validated, then only two different, unfinished, existing tasks and a verdict pass', () => {
	const doc = plan(['a', 'b'])
	doc.tasks[1].done = true; doc.tasks[1].sessions = [{ start: '2026-09-01T00:00:00.000Z', stop: '2026-09-02T00:00:00.000Z' }]
	const v = (cmd: any) => validateCommand(doc, cmd)
	assert.equal(v({ type: 'addRankAnswer', a: 'a', b: 'a', verdict: -1 }), 'a and b must be two different tasks')
	assert.equal(v({ type: 'addRankAnswer', a: 'a', b: 'nope', verdict: -1 }), 'no task "nope" in this plan')
	assert.equal(v({ type: 'addRankAnswer', a: 'a', b: 'b', verdict: -1 }), '"b" is finished — finished work leaves the ranking')
	assert.equal(v({ type: 'addRankAnswer', a: '', b: 'b', verdict: -1 }), 'a must be a task id')
	doc.tasks.push(task('c', 5))
	assert.equal(v({ type: 'addRankAnswer', a: 'a', b: 'c', verdict: 2 }), 'verdict must be -1 (a first), 1 (b first) or 0 (equal)')
	assert.equal(v({ type: 'addRankAnswer', a: 'a', b: 'c', verdict: 0 }), null)
	assert.equal(v({ type: 'removeRankAnswer', a: 'gone', b: 'also-gone' }), null, 'forgetting is idempotent')
	assert.equal(v({ type: 'resetRanking' }), null)
})

test('Given no answers yet, when the ranking is read, then nothing counts as ranked — one task alone is not a ranking', () => {
	const r = rankOf(plan(['a', 'b', 'c']))
	assert.equal(r.rank.size, 0)
	assert.deepEqual(r.unranked, ['a', 'b', 'c'])
	assert.deepEqual(r.next, ['b', 'a'])
})

test('Given dependencies, when the ranking asks, then it never asks what the dependencies already say', () => {
	// GIVEN c waits on b, which waits on a — a chain, so every pair is settled by it
	const doc = plan(['a', 'b', 'c'])
	doc.tasks[1].deps = ['a']; doc.tasks[2].deps = ['b']
	// WHEN the ranking is read with no answers at all
	// THEN nothing is left to ask and the order is the dependency order
	assert.equal(rankOf(doc).next, null)
	assert.deepEqual(ranked(doc), ['a', 'b', 'c'])
	// THEN none of it was written down: it is worked out, not stored
	assert.equal('rankLog' in doc, false)
	// WHEN a stored answer contradicts a dependency
	apply(doc, { type: 'addRankAnswer', a: 'c', b: 'a', verdict: -1 })
	// THEN the dependency wins
	assert.deepEqual(ranked(doc), ['a', 'b', 'c'])
	// WHEN the dependency goes
	doc.tasks[2].deps = []
	// THEN the stored answer it was overruling takes over, and chains through what is left:
	// c before a, a before b — so c lands first with nothing asked
	assert.equal(rankOf(doc).next, null)
	assert.deepEqual(ranked(doc), ['c', 'a', 'b'])
})

test('Given a dependency through finished work, when the ranking asks, then that pair is still settled', () => {
	// GIVEN c waits on b (finished), which waits on a
	const doc = plan(['a', 'b', 'c'])
	doc.tasks[1].deps = ['a']; doc.tasks[2].deps = ['b']
	doc.tasks[1].done = true; doc.tasks[1].sessions = [{ start: '2026-09-01T00:00:00Z', stop: '2026-09-02T00:00:00Z' }]
	// WHEN the ranking is read
	// THEN a comes before c without a question
	assert.equal(rankOf(doc).next, null)
	assert.deepEqual(ranked(doc), ['a', 'c'])
})

test('Given a dependency, when a task retires, then no dependency answer is stored', () => {
	// GIVEN a ranked plan where c waits on b, which waits on a
	const doc = plan(['a', 'b', 'c', 'd'])
	doc.tasks[1].deps = ['a']; doc.tasks[2].deps = ['b']
	rankAll(doc, ['a', 'b', 'c', 'd'])
	// WHEN b finishes — its links stay, so a before c is still settled by them
	apply(doc, { type: 'finishTask', id: 'b', at: '2026-09-02T00:00:00Z' })
	// THEN the stored log still holds nothing about the pair the dependency decides
	assert.equal(doc.rankLog.some(([k]: any) => k === ['a', 'c'].sort().join('\u0001')), false)
	assert.deepEqual(ranked(doc), ['a', 'c', 'd'])
})

test('Given a chain, when the task in the middle is removed, then the pair it joined is not asked again', () => {
	// GIVEN a ranked plan where c waits on b, which waits on a — so a before c is settled
	// only through b
	const doc = plan(['a', 'b', 'c', 'd'])
	doc.tasks[1].deps = ['a']; doc.tasks[2].deps = ['b']
	rankAll(doc, ['d', 'a', 'b', 'c'])
	// WHEN b is removed, which cuts both links
	apply(doc, { type: 'removeTask', id: 'b' })
	// THEN a before c is kept, as an implied answer, rather than asked
	assert.equal(rankOf(doc).next, null)
	assert.deepEqual(ranked(doc), ['d', 'a', 'c'])
})

test('Given answers, when replayed, then the order is the stated preference and nothing is left to ask', () => {
	const doc = rankAll(plan(['a', 'b', 'c', 'd']), ['d', 'b', 'a', 'c'])
	assert.deepEqual(ranked(doc), ['d', 'b', 'a', 'c'])
	assert.deepEqual(rankOf(doc).unranked, [])
	// WHEN the same pair is answered again, THEN the new answer replaces the old one
	const before = doc.rankLog.length
	const [k] = doc.rankLog[0]
	const [x, y] = k.split('\u0001')
	apply(doc, { type: 'addRankAnswer', a: x, b: y, verdict: 0 })
	assert.equal(doc.rankLog.length, before)
})

test('Given a ranked plan, when the queue is reordered, then the ranking does not change', () => {
	const doc = rankAll(plan(['a', 'b', 'c', 'd']), ['c', 'a', 'd', 'b'])
	apply(doc, { type: 'moveTaskInLane', id: 'd', toIndex: 0 })
	apply(doc, { type: 'moveTaskInLane', id: 'a', toIndex: 3 })
	assert.deepEqual(ranked(doc), ['c', 'a', 'd', 'b'], 'arrival order is creation time, not queue order')
	assert.equal(rankOf(doc).next, null)
})

test('Given a ranked plan, when a task finishes or is removed, then it leaves without anything re-asked', () => {
	const doc = rankAll(plan(['c', 'b', 'd', 'a', 'e']), ['a', 'b', 'c', 'd', 'e'])
	apply(doc, { type: 'finishTask', id: 'c', at: '2026-09-02T00:00:00Z' })
	assert.equal(doc.rankLog.some(([k]: any) => k.split('\u0001').includes('c')), false, 'no answer mentions c')
	assert.ok(doc.rankLog.some((e: any) => e[2] === true), 'the answers c carried were filled in as implied')
	assert.deepEqual(ranked(doc), ['a', 'b', 'd', 'e'])
	assert.equal(rankOf(doc).next, null)
	apply(doc, { type: 'removeTask', id: 'b' })
	assert.deepEqual(ranked(doc), ['a', 'd', 'e'])
	assert.equal(rankOf(doc).next, null)
})

test('Given a ranked plan, when the task everything was compared against is removed, then nothing is re-asked', () => {
	// c arrived first, so every later task was placed by comparing it with c
	const doc = rankAll(plan(['c', 'b', 'd', 'a', 'e']), ['a', 'b', 'c', 'd', 'e'])
	apply(doc, { type: 'removeTask', id: 'c' })
	assert.equal(doc.rankLog.some(([k]: any) => k.split('\u0001').includes('c')), false, 'its answers went with it')
	assert.deepEqual(ranked(doc), ['a', 'b', 'd', 'e'])
	assert.equal(rankOf(doc).next, null)
})

test('Given a plan that never ranked, when tasks finish or go, then no ranking appears on it', () => {
	const doc = plan(['a', 'b'])
	apply(doc, { type: 'finishTask', id: 'a', at: '2026-09-02T00:00:00Z' })
	apply(doc, { type: 'removeTask', id: 'b' })
	assert.equal('rankLog' in doc, false)
})

test('Given answers, when one is forgotten or all are reset, then the pair is asked again or the key goes', () => {
	const doc = rankAll(plan(['a', 'b']), ['a', 'b'])
	apply(doc, { type: 'removeRankAnswer', a: 'b', b: 'a' })
	assert.deepEqual(rankOf(doc).next, ['b', 'a'])
	assert.equal('rankLog' in doc, false, 'an empty log is no log')
	rankAll(doc, ['a', 'b'])
	apply(doc, { type: 'resetRanking' })
	assert.equal('rankLog' in doc, false)
})

test('Given dates that do not care, when reorders are suggested, then the ranking decides — after any date move', () => {
	const doc = rankAll(plan(['a', 'b', 'c']), ['c', 'b', 'a'])
	const s = suggestReorders(doc).suggestions
	assert.ok(s.length > 0, 'a ranking move is suggested')
	assert.equal(s[0]!.gain, 0)
	assert.ok((s[0]!.ranked ?? 0) > 0)
	assert.equal(s[0]!.worsens, false)
	// AND a plan with no ranking suggests nothing when the dates tie
	assert.deepEqual(suggestReorders(plan(['a', 'b', 'c'])).suggestions, [])
})

test('Given a deadline, when the ranking wants the other order, then no move makes anything late', () => {
	// `due` is due at the end of its own hour; `later` is ranked above it but moving it ahead
	// would push `due` past that deadline.
	const start = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
	const doc = plan(['due', 'later'])
	doc.tasks[0].due = new Date(Date.parse(`${start}T00:00:00-05:00`) + 3600e3).toISOString()
	rankAll(doc, ['later', 'due'])
	assert.equal(suggestReorders(doc).suggestions.some((m: any) => m.id === 'later' && m.to === 0), false)
})

test('Given a deadline buffer, when a ranking move would eat into it, then the move is not suggested', () => {
	// Nothing is late either way; but putting `later` first leaves `due` deeper inside its
	// buffer. A date term gets worse, so the ranking may not buy that.
	// Due a day and a half after the plan starts, with a two-day buffer: already inside it,
	// not late, and starting it an hour later sits it an hour deeper.
	const doc = plan(['due', 'later'], { dueBuffer: 2 })
	doc.tasks[0].due = new Date(Date.parse(`${doc.start}T00:00:00-05:00`) + 1.5 * 864e5).toISOString()
	rankAll(doc, ['later', 'due'])
	assert.equal(suggestReorders(doc).suggestions.some((m: any) => m.id === 'later' && m.to === 0), false)
	// AND without the buffer, the same ranking move is fine
	delete doc.dueBuffer
	assert.equal(suggestReorders(doc).suggestions.some((m: any) => m.id === 'later' && m.to === 0), true)
})

test('Given a ranking, when an agent asks what is ready, then each task carries its place in it', () => {
	// GIVEN a plan ranked c, a, b with one more task nobody has ranked yet
	const doc = rankAll(plan(['a', 'b', 'c']), ['c', 'a', 'b'])
	doc.tasks.push(task('d', 9))
	// WHEN /api/ready's rows are read
	const rows = Object.fromEntries(readiness(doc).map((r: any) => [r.id, r.rank]))
	// THEN the ranked tasks are numbered from 1 in the stated order
	assert.deepEqual([rows.c, rows.a, rows.b], [1, 2, 3])
	// THEN the unranked one says so rather than guessing
	assert.equal(rows.d, null)
	// THEN a plan that never ranked numbers nothing
	assert.ok(readiness(plan(['a', 'b'])).every((r: any) => r.rank === null))
})

test('Given the ranking changes, when the order signature is taken, then it differs', () => {
	const doc = plan(['a', 'b'])
	const before = orderSignature(doc)
	apply(doc, { type: 'addRankAnswer', a: 'b', b: 'a', verdict: -1 })
	assert.notEqual(orderSignature(doc), before)
})

test('Given Auto-order on, when the ranking is answered, then the queue settles into the ranked order', async () => {
	const room = new CommandRoom({ id: 'rank-ao', doc: plan(['a', 'b', 'c', 'd'], { autoOrder: true }) })
	const prefer = ['d', 'c', 'b', 'a']
	for (let n = 0; n < 50; n++) {
		const next = rankOf(room.doc).next
		if (!next) break
		const [a, b] = next
		const before = orderSignature(room.doc)
		assert.equal(room.apply([{ type: 'addRankAnswer', a, b, verdict: prefer.indexOf(a) < prefer.indexOf(b) ? -1 : 1 } as any], 'me'), null)
		afterApply('rank-ao' as any, room, before)
		await settled('rank-ao' as any)
	}
	assert.deepEqual(room.doc.tasks.map((t: any) => t.id), prefer)
})
