// THE SUGGESTED RANKING: an agent's proposed order, held apart from the person's own
// answers until they Adopt it. Driven through the real command validator and applier — the
// same two functions the page and the server run — and read back only through the public
// readers (`rankOf`, `suggestedRankOf`) and the document, never the internals.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand, rankOf, suggestedRankOf, validateCommand } from '../../shared/commands.js'
import { instantOfDay, orderSignature, readiness, suggestReorders } from '../../shared/schedule.js'
import { flipOfIds, orient, pairKeyOf, replay } from '../../shared/pairwise.js'
import { CommandRoom } from '../src/room'

process.env.DATA_BUCKET ??= 'unused-by-this-test'
const { afterApply, settled } = await import('../src/rooms')

const t0 = Date.parse('2026-09-01T12:00:00Z')
const task = (id: string, i: number, extra: any = {}) => ({
	id, label: id, lane: 'L1', border: 'b', fill: 'f', shape: 's', color: [], deps: [], dur: 60,
	createdAt: new Date(t0 + i * 1000).toISOString(), ...extra,
})
const plan = (ids: string[], extra: any = {}): any => ({
	schemaVersion: 10, title: 't', start: '2026-09-01', timeZone: 'America/Chicago',
	lanes: [{ id: 'L1', label: 'Me', cap: 1 }], borders: [{ id: 'b', label: 'b', style: 'solid' }],
	fills: [{ id: 'f', label: 'f', pattern: 'solid' }], shapes: [{ id: 's', label: 's', shape: 'soft' }],
	colors: [], milestones: [],
	tasks: ids.map((id, i) => task(id, i)),
	...extra,
})
const apply = (doc: any, cmd: any) => { applyCommand(doc, { at: '2026-10-03T12:00:00.000Z', ...cmd }); return doc }
const suggest = (doc: any, ids: string[], extra: any = {}) =>
	apply(doc, { type: 'setRankSuggestion', by: 'Claude', order: ids.map(id => ({ id, why: `because ${id}` })), ...extra })
/** The suggested order, first to last, as the public reader reports it. */
const suggested = (doc: any) => [...suggestedRankOf(doc).rank].sort((x, y) => x[1] - y[1]).map(([id]) => id)
const yours = (doc: any) => [...rankOf(doc).rank].sort((x, y) => x[1] - y[1]).map(([id]) => id)

test('Given a suggestion, when validated, then it needs two or more unfinished, known, distinct tasks, a reason each and an author', () => {
	// GIVEN a plan with a finished task
	const doc = plan(['a', 'b', 'c'])
	doc.tasks[2].done = true; doc.tasks[2].sessions = [{ start: '2026-09-01T00:00:00.000Z', stop: '2026-09-02T00:00:00.000Z' }]
	const v = (order: any, by: any = 'Claude') => validateCommand(doc, { type: 'setRankSuggestion', by, order } as any)
	const row = (id: string, why: any = 'r') => ({ id, why })

	// WHEN each malformed suggestion is validated THEN it is refused with the reason
	assert.equal(v([row('a')]), 'order must list at least two tasks')
	assert.equal(v('a'), 'order must list at least two tasks')
	assert.equal(v([row('a'), row('nope')]), 'no task "nope" in this plan')
	assert.equal(v([row('a'), row('c')]), '"c" is finished — finished work leaves the ranking')
	assert.equal(v([row('a'), row('a')]), '"a" is listed twice')
	assert.equal(v([row('a'), row('b', '  ')]), '"b" needs a reason (why)')
	assert.equal(v([row('a'), row('b', 7)]), '"b" needs a reason (why)')
	assert.equal(v([row('a'), { ...row('b'), toss: 'yes' }]), '"b": toss must be true or false')
	assert.equal(v([row('a'), { ...row('b'), toss: true }]), null)
	assert.equal(v([row('a'), row('b')], ''), 'by must say who is suggesting')
	// THEN a well-formed one passes
	assert.equal(v([row('a'), row('b')]), null)
})

test('Given a suggested order over nine tasks, when it is applied, then the suggested ranking reads back exactly that order and asks nothing further', () => {
	// GIVEN nine tasks created a..i and an order that shares nothing with that arrival order
	const doc = plan(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
	const order = ['e', 'a', 'h', 'c', 'i', 'b', 'g', 'd', 'f']

	// WHEN Claude suggests it
	suggest(doc, order)

	// THEN the suggested ranking is that order, complete
	assert.deepEqual(suggested(doc), order)
	assert.equal(suggestedRankOf(doc).next, null)
})

test('Given a suggestion, when it is applied, then the person\'s own ranking and answers are untouched', () => {
	// GIVEN a plan where the person has answered one pair
	const doc = plan(['a', 'b', 'c'])
	apply(doc, { type: 'addRankAnswer', a: 'a', b: 'b', verdict: 1 })
	const before = structuredClone(doc.rankLog)

	// WHEN Claude suggests an order
	suggest(doc, ['c', 'b', 'a'])

	// THEN the person's answers are exactly as they were — the suggestion is never written as theirs
	assert.deepEqual(doc.rankLog, before)
})

test('Given thirty-eight tasks, when an order is suggested, then it is reproduced exactly with nothing left to ask', () => {
	// GIVEN 38 tasks and a fixed scramble of them as the suggested order (a stride coprime with 38)
	const ids = Array.from({ length: 38 }, (_, i) => 't' + String(i).padStart(2, '0'))
	const order = ids.map((_, i) => ids[(i * 7 + 3) % 38]!)
	const doc = plan(ids)

	// WHEN it is suggested
	suggest(doc, order)

	// THEN the order is exact
	assert.deepEqual(suggested(doc), order)
	// THEN nothing is left to ask
	assert.equal(suggestedRankOf(doc).next, null)
})

test('Given a suggestion, when it is stored, then it records who, when and why per task, and a newer one replaces it', () => {
	// GIVEN a plan with a suggestion that marks one row a toss-up
	const doc = plan(['a', 'b', 'c'])
	apply(doc, { type: 'setRankSuggestion', by: 'Claude', order: [{ id: 'b', why: 'blocks c' }, { id: 'a', why: 'quick', toss: true }, { id: 'c', why: 'last' }] })

	// THEN the document says who, when and why
	assert.equal(doc.rankSuggestion.by, 'Claude')
	assert.equal(doc.rankSuggestion.at, '2026-10-03T12:00:00.000Z')
	assert.deepEqual(doc.rankSuggestion.notes, { b: { why: 'blocks c' }, a: { why: 'quick', toss: true }, c: { why: 'last' } })

	// WHEN a newer suggestion is applied
	suggest(doc, ['c', 'a'], { by: 'Someone else' })

	// THEN it replaces the first outright: new author, only its two tasks covered
	assert.equal(doc.rankSuggestion.by, 'Someone else')
	assert.deepEqual(suggested(doc), ['c', 'a'])
	assert.deepEqual(Object.keys(doc.rankSuggestion.notes).sort(), ['a', 'c'])
})

test('Given a plan that never had a suggestion, when ordinary commands run, then no suggestion field appears', () => {
	// GIVEN a plan with no suggestion
	const doc = plan(['a', 'b'])

	// WHEN ordinary ranking commands run
	apply(doc, { type: 'addRankAnswer', a: 'a', b: 'b', verdict: -1 })
	apply(doc, { type: 'resetRanking' })

	// THEN old documents stay byte-for-byte what they were
	assert.equal('rankSuggestion' in doc, false)
	assert.deepEqual(yours(doc), [])
})

test('Given a suggestion that puts a task before its prerequisite, when it is applied, then it is stored and the dependency still wins on reading', () => {
	// GIVEN b is a prerequisite of a
	const doc = plan(['a', 'b', 'c'])
	doc.tasks[0].deps = ['b']

	// WHEN Claude suggests a first anyway
	// THEN the command is accepted — a suggestion is an opinion, not a plan error
	assert.equal(validateCommand(doc, { type: 'setRankSuggestion', by: 'Claude', order: [{ id: 'a', why: 'x' }, { id: 'c', why: 'y' }, { id: 'b', why: 'z' }] } as any), null)
	suggest(doc, ['a', 'c', 'b'])

	// THEN reading puts the prerequisite before the task that waits on it
	const order = suggested(doc)
	assert.ok(order.indexOf('b') < order.indexOf('a'), `got ${order}`)
})

test('Given a suggestion written while a dependency held, when that dependency is removed, then the suggestion is still complete and says what was suggested', () => {
	// GIVEN a depends on b, and the suggestion puts a before c before b before d
	const doc = plan(['a', 'b', 'c', 'd'])
	doc.tasks[0].deps = ['b']
	suggest(doc, ['a', 'c', 'b', 'd'])
	assert.ok(suggested(doc).indexOf('b') < suggested(doc).indexOf('a'), 'while the dependency holds, b comes first')

	// WHEN the dependency is removed
	apply(doc, { type: 'removeDep', id: 'a', dep: 'b' })

	// THEN the suggestion is exactly what was suggested, with nothing left to ask
	assert.deepEqual(suggested(doc), ['a', 'c', 'b', 'd'])
	assert.equal(suggestedRankOf(doc).next, null)

	// WHEN a dependency is added again
	apply(doc, { type: 'addDep', id: 'a', dep: 'b' })

	// THEN it wins again, still complete
	assert.ok(suggested(doc).indexOf('b') < suggested(doc).indexOf('a'))
	assert.equal(suggestedRankOf(doc).next, null)
})

test('Given a suggestion, when a task in it is finished, then the rest keep their suggested order and the finished one leaves it', () => {
	// GIVEN a suggested order over eight tasks
	const doc = plan(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
	const order = ['d', 'a', 'f', 'b', 'h', 'e', 'c', 'g']
	suggest(doc, order)

	// WHEN b and h are finished
	for (const id of ['b', 'h']) apply(doc, { type: 'finishTask', id, at: '2026-09-02T00:00:00.000Z' })

	// THEN the others are in their suggested order, still complete, and the finished are gone from it
	assert.deepEqual(suggested(doc), ['d', 'a', 'f', 'e', 'c', 'g'])
	assert.equal(suggestedRankOf(doc).next, null)
	assert.deepEqual(Object.keys(doc.rankSuggestion.notes).sort(), ['a', 'c', 'd', 'e', 'f', 'g'])
	assert.deepEqual(doc.rankSuggestion.order, ['d', 'a', 'f', 'e', 'c', 'g'])
})

test('Given a suggestion, when a task in it is removed, then the rest keep their suggested order', () => {
	// GIVEN a suggested order over six tasks
	const doc = plan(['a', 'b', 'c', 'd', 'e', 'f'])
	suggest(doc, ['e', 'c', 'a', 'f', 'b', 'd'])

	// WHEN c is removed
	apply(doc, { type: 'removeTask', id: 'c' })

	// THEN the others keep their order
	assert.deepEqual(suggested(doc), ['e', 'a', 'f', 'b', 'd'])
	assert.equal(suggestedRankOf(doc).next, null)
})

test('Given a suggestion, when a task is added afterwards, then it has no suggested place and the others are unchanged', () => {
	// GIVEN a suggested order over three tasks
	const doc = plan(['a', 'b', 'c'])
	suggest(doc, ['c', 'a', 'b'])

	// WHEN a new task arrives
	apply(doc, { type: 'addTask', task: task('z', 99) })

	// THEN it is not in the suggested ranking, and the order of the rest is as suggested
	assert.deepEqual(suggested(doc), ['c', 'a', 'b'])
	assert.equal(suggestedRankOf(doc).rank.has('z'), false)
})

test('Given a suggestion over two tasks, when one is finished, then no suggestion is left', () => {
	// GIVEN a two-task suggestion
	const doc = plan(['a', 'b', 'c'])
	suggest(doc, ['b', 'a'])

	// WHEN one of them is finished
	apply(doc, { type: 'finishTask', id: 'a', at: '2026-09-02T00:00:00.000Z' })

	// THEN one task is not an order, so the suggestion is gone
	assert.equal('rankSuggestion' in doc, false)
})

test('Given a suggestion over twelve tasks, when any one of them is removed or finished, then the rest are still in exactly their suggested order with nothing left to ask', () => {
	// GIVEN twelve tasks and a scrambled suggested order
	const ids = Array.from({ length: 12 }, (_, i) => 'k' + String(i).padStart(2, '0'))
	const order = ids.map((_, i) => ids[(i * 5 + 2) % 12]!)

	for (const victim of order) {
		for (const how of ['remove', 'finish'] as const) {
			const doc = plan(ids)
			suggest(doc, order)

			// WHEN that one task is removed, or finished
			if (how === 'remove') apply(doc, { type: 'removeTask', id: victim })
			else apply(doc, { type: 'finishTask', id: victim, at: '2026-09-02T00:00:00.000Z' })

			// THEN the other eleven are in their suggested order and the ranking is complete
			assert.deepEqual(suggested(doc), order.filter(id => id !== victim), `${how} ${victim}`)
			assert.equal(suggestedRankOf(doc).next, null, `${how} ${victim}`)
		}
	}
})

test('Given a room, when a caller suggests an order with no author, then the server fills in who and when, and a bad suggestion changes nothing', () => {
	// GIVEN a room with four tasks
	const room = new CommandRoom({ id: 'rank-sugg', doc: plan(['a', 'b', 'c', 'd']) })

	// WHEN an API caller named "Claude" suggests an order, sending no `by`
	assert.equal(room.apply([{ type: 'setRankSuggestion', order: [{ id: 'd', why: 'first' }, { id: 'b', why: 'then' }, { id: 'a', why: 'next' }, { id: 'c', why: 'last' }] } as any], 'Claude'), null)

	// THEN the document records who (from the header) and a real time
	assert.equal(room.doc.rankSuggestion?.by, 'Claude')
	assert.ok(!Number.isNaN(Date.parse(room.doc.rankSuggestion!.at)), 'stamped with a real instant')
	// THEN it is a suggestion only: the person's ranking is empty
	assert.equal(room.doc.rankLog, undefined)

	// WHEN a malformed one arrives
	const before = JSON.stringify(room.doc)
	const wrong = room.apply([{ type: 'setRankSuggestion', order: [{ id: 'd', why: '' }, { id: 'b', why: 'x' }] } as any], 'Claude')

	// THEN it is refused with the reason and the document is untouched
	assert.equal(wrong, '"d" needs a reason (why)')
	assert.equal(JSON.stringify(room.doc), before)
})

// ---- STEERING AUTO-ORDER: a suggestion is a second sort key under the person's own.

/** Send commands the way the server does, then let Auto-order settle, and return the queue. */
const queue = async (room: any, ...cmds: any[]) => {
	const before = orderSignature(room.doc)
	assert.equal(room.apply(cmds, 'Claude'), null)
	afterApply(room.doc.id ?? 'steer' as any, room, before)
	await settled(room.doc.id ?? 'steer' as any)
	return room.doc.tasks.map((t: any) => t.id)
}
const answerAll = (doc: any, first: string[]) => {
	for (let n = 0; n < 100; n++) {
		const next = rankOf(doc).next
		if (!next) return doc
		const [a, b] = next
		apply(doc, { type: 'addRankAnswer', a, b, verdict: first.indexOf(a) < first.indexOf(b) ? -1 : 1 })
	}
	throw new Error('ranking never finished')
}
const sug = (ids: string[]) => ({ type: 'setRankSuggestion', by: 'Claude', order: ids.map(id => ({ id, why: 'r' })) })

test('Given Auto-order on and a suggestion over undated tasks, when it arrives, then the queue settles into the suggested order', async () => {
	// GIVEN four undated tasks queued a b c d, Auto-order on, and nothing the person has ranked
	const room = new CommandRoom({ id: 'steer-1', doc: plan(['a', 'b', 'c', 'd'], { autoOrder: true }) })

	// WHEN Claude suggests d c b a
	const q = await queue(room, sug(['d', 'c', 'b', 'a']))

	// THEN the queue follows the suggestion
	assert.deepEqual(q, ['d', 'c', 'b', 'a'])
	// THEN it was never written as the person's ranking
	assert.equal(room.doc.rankLog, undefined)
})

test('Given the person switched suggestions off, when one arrives, then the queue is left alone', async () => {
	// GIVEN Auto-order on and the plan's switch for suggestions set to false
	const room = new CommandRoom({ id: 'steer-2', doc: plan(['a', 'b', 'c'], { autoOrder: true, useRankSuggestion: false }) })

	// WHEN a suggestion arrives
	const q = await queue(room, sug(['c', 'b', 'a']))

	// THEN nothing moves
	assert.deepEqual(q, ['a', 'b', 'c'])

	// WHEN the switch is turned on again
	const q2 = await queue(room, { type: 'patchDoc', patch: { useRankSuggestion: true } })

	// THEN the same suggestion now steers
	assert.deepEqual(q2, ['c', 'b', 'a'])
})

test('Given a switch, when it is patched, then only a boolean is accepted', () => {
	const doc = plan(['a', 'b'])
	assert.equal(validateCommand(doc, { type: 'patchDoc', patch: { useRankSuggestion: false } } as any), null)
	assert.match(validateCommand(doc, { type: 'patchDoc', patch: { useRankSuggestion: 'no' } } as any) as string, /useRankSuggestion must be true or false/)
})

test('Given a suggestion that disagrees with the person on tasks they ranked, when Auto-order settles, then the person wins', async () => {
	// GIVEN the person ranked c, b, a, and Claude suggests the opposite
	const doc = answerAll(plan(['a', 'b', 'c'], { autoOrder: true }), ['c', 'b', 'a'])
	const room = new CommandRoom({ id: 'steer-3', doc })

	// WHEN the suggestion arrives
	const q = await queue(room, sug(['a', 'b', 'c']))

	// THEN the queue is the person's order — the suggestion speaks only where they have not
	assert.deepEqual(q, ['c', 'b', 'a'])
})

test('Given the person called two tasks equal, when a suggestion prefers one, then Auto-order leaves them as they are', async () => {
	// GIVEN the person said a and b are equal, and the queue is a, b
	const doc = plan(['a', 'b'], { autoOrder: true })
	apply(doc, { type: 'addRankAnswer', a: 'a', b: 'b', verdict: 0 })
	const room = new CommandRoom({ id: 'steer-tie', doc })

	// WHEN Claude suggests b before a
	const q = await queue(room, sug(['b', 'a']))

	// THEN the queue stays a, b — a pair the person has settled, even as "equal", is not the suggestion's to break
	assert.deepEqual(q, ['a', 'b'])
})

test('Given the person ranked three tasks and a fourth is new, when a suggestion places the new one, then it fills only the gap', async () => {
	// GIVEN the person ranked c, b, a; d arrived later and is unranked
	const doc = answerAll(plan(['a', 'b', 'c'], { autoOrder: true }), ['c', 'b', 'a'])
	doc.tasks.push(task('d', 9))
	const room = new CommandRoom({ id: 'steer-4', doc })

	// WHEN Claude suggests d first, and the opposite of the person's order for the rest
	const q = await queue(room, sug(['d', 'a', 'b', 'c']))

	// THEN d is first (the gap), and c b a stay in the person's order
	assert.deepEqual(q, ['d', 'c', 'b', 'a'])
})

test('Given a deadline, when a suggestion wants the other order, then no move makes anything late or eats into its buffer', () => {
	// GIVEN `due` is due at the end of its first hour and Claude suggests `later` first
	const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
	const late = plan(['due', 'later'], { start: today })
	late.tasks[0].due = new Date(Date.parse(instantOfDay(0, late)) + 3600e3).toISOString()
	apply(late, sug(['later', 'due']))
	// THEN putting `later` ahead is not offered — it would make `due` late
	assert.equal(suggestReorders(late).suggestions.some((m: any) => m.id === 'later' && m.to === 0), false)

	// GIVEN instead a deadline a day and a half out with a two-day buffer: nothing is late either way,
	// but starting `due` an hour later sits it deeper inside its buffer
	const tight = plan(['due', 'later'], { start: today, dueBuffer: 2 })
	tight.tasks[0].due = new Date(Date.parse(instantOfDay(0, tight)) + 1.5 * 864e5).toISOString()
	apply(tight, sug(['later', 'due']))
	// THEN a suggestion may not buy that either
	assert.equal(suggestReorders(tight).suggestions.some((m: any) => m.id === 'later' && m.to === 0), false)
	// AND without the buffer the same suggestion move is fine, so the refusal above was the buffer's
	delete tight.dueBuffer
	assert.equal(suggestReorders(tight).suggestions.some((m: any) => m.id === 'later' && m.to === 0), true)
})

test('Given the person ranked a before b, when a suggestion would fix a pair by putting b ahead of a, then that move is not offered', () => {
	// GIVEN a ranked a, b by the person; c arrived later unranked; the queue is a, c, b
	const doc = answerAll(plan(['a', 'b']), ['a', 'b'])
	doc.tasks.push(task('c', 9))
	doc.tasks = [doc.tasks[0], doc.tasks[2], doc.tasks[1]]
	// GIVEN Claude suggests b, c, a — b before c, but also b before a, which the person has settled
	apply(doc, sug(['b', 'c', 'a']))

	// WHEN reorders are suggested
	const moves = suggestReorders(doc).suggestions

	// THEN b is never moved ahead of a (that would cost the person a pair), though b can still be moved past c
	const b = moves.find((m: any) => m.id === 'b')
	assert.ok(b, 'b has a suggested move past c')
	assert.notEqual(b.to, 0, 'not ahead of a')
})

test('Given a move for the person\'s ranking and a bigger one for a suggestion, when reorders are suggested, then the person\'s comes first', () => {
	// GIVEN a ranked a, b by the person while the queue has b before a; c and d are unranked, behind them
	const doc = answerAll(plan(['a', 'b']), ['a', 'b'])
	doc.tasks.push(task('c', 9), task('d', 10))
	doc.tasks = [doc.tasks[1], doc.tasks[0], doc.tasks[2], doc.tasks[3]]
	// GIVEN Claude suggests d, c, b, a — moving d to the front fixes three suggested pairs
	apply(doc, sug(['d', 'c', 'b', 'a']))

	// WHEN reorders are suggested
	const moves = suggestReorders(doc).suggestions

	// THEN the first is the person's own pair (one pair fixed), ahead of the suggestion's three
	assert.ok(!moves[0]!.suggested, JSON.stringify(moves[0]))
	assert.ok(moves.some((m: any) => m.suggested && m.ranked > (moves[0]!.ranked ?? 0)), 'the suggestion has the bigger move')
})

test('Given a suggestion, when reorders are suggested, then a move made only for it says so, and the person\'s own ranking moves do not', () => {
	// GIVEN a suggestion alone
	const solo = plan(['a', 'b', 'c'])
	apply(solo, sug(['c', 'b', 'a']))
	const s = suggestReorders(solo).suggestions
	// THEN its moves carry gain 0, a count of pairs brought into line, and the suggested flag
	assert.ok(s.length > 0)
	assert.ok(s.every((m: any) => m.gain === 0 && m.ranked > 0 && m.suggested === true), JSON.stringify(s))

	// GIVEN the person's own ranking instead
	const mine = answerAll(plan(['a', 'b', 'c']), ['c', 'b', 'a'])
	// THEN its moves are not flagged as suggested
	assert.ok(suggestReorders(mine).suggestions.every((m: any) => !m.suggested))
})

test('Given a suggestion arrives, when the order signature is taken, then it differs, so Auto-order re-settles', () => {
	// GIVEN a plan
	const doc = plan(['a', 'b', 'c'])
	const none = orderSignature(doc)

	// WHEN a suggestion arrives THEN the signature changes
	apply(doc, sug(['c', 'b', 'a']))
	const withIt = orderSignature(doc)
	assert.notEqual(withIt, none)

	// WHEN the switch is flipped THEN it changes again
	apply(doc, { type: 'patchDoc', patch: { useRankSuggestion: false } })
	assert.notEqual(orderSignature(doc), withIt)
})

test('Given a ranking and a suggestion, when an agent asks what is ready, then each task carries both places, kept apart', () => {
	// GIVEN the person ranked c, a, b; d arrived later; Claude suggests d first and a second
	const doc = answerAll(plan(['a', 'b', 'c']), ['c', 'a', 'b'])
	doc.tasks.push(task('d', 9))
	apply(doc, sug(['d', 'a']))

	// WHEN /api/ready's rows are read
	const rows = Object.fromEntries(readiness(doc).map((r: any) => [r.id, r]))

	// THEN the person's own places are unchanged and the suggestion adds none of its own to them
	assert.deepEqual([rows.c.rank, rows.a.rank, rows.b.rank, rows.d.rank], [1, 2, 3, null])
	// THEN the suggested places are separate, and only for the tasks it covers
	assert.deepEqual([rows.d.suggestedRank, rows.a.suggestedRank, rows.b.suggestedRank, rows.c.suggestedRank], [1, 2, null, null])
})

test('Given a plan with no suggestion, when an agent asks what is ready, then every task says it has no suggested place', () => {
	assert.ok(readiness(plan(['a', 'b'])).every((r: any) => r.suggestedRank === null))
})

/** A small deterministic generator, so a failure names its case and re-runs identically. */
const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const shuffled = <T,>(xs: T[], r: () => number) => xs.map(x => [r(), x] as const).sort((a, b) => a[0] - b[0]).map(x => x[1])

test('Given a large suggestion, when it is read again after a queue move, then the second read is instant — and a dependency change still takes effect', () => {
	// GIVEN a suggestion over 120 tasks, read once
	const ids = Array.from({ length: 120 }, (_, i) => 'm' + String(i).padStart(3, '0'))
	const order = ids.map((_, i) => ids[(i * 7 + 3) % 120]!)
	const doc = plan(ids)
	suggest(doc, order)
	assert.deepEqual(suggested(doc), order)

	// WHEN Auto-order moves tasks about in the queue and it is read again
	const t = doc.tasks.splice(5, 1)[0]; doc.tasks.push(t)
	const start = performance.now()
	assert.deepEqual(suggested(doc), order)
	// THEN it is answered from memory, not recomputed (recomputing takes hundreds of milliseconds)
	assert.ok(performance.now() - start < 30, `took ${performance.now() - start}ms`)

	// WHEN a dependency is added that contradicts the suggestion
	const [first, second] = [order[0]!, order[1]!]
	apply(doc, { type: 'addDep', id: first, dep: second })

	// THEN the memory is not trusted: the prerequisite now comes first
	const after = suggested(doc)
	assert.ok(after.indexOf(second) < after.indexOf(first))
})

test('Given a move that would break one of the person\'s pairs while fixing another, when a suggestion would also gain from it, then the move is not offered', () => {
	// GIVEN the person ranked a < b < c; d is unranked; the queue is b, c, a, d
	const doc = answerAll(plan(['a', 'b', 'c']), ['a', 'b', 'c'])
	doc.tasks.push(task('d', 9))
	doc.tasks = [doc.tasks[1], doc.tasks[2], doc.tasks[0], doc.tasks[3]]
	// GIVEN Claude suggests d first
	apply(doc, sug(['d', 'b', 'a', 'c']))

	// WHEN reorders are suggested
	const moves = suggestReorders(doc).suggestions

	// THEN b is not moved to the back past c, a and d: that puts b after a (fixing the person's a < b) but
	// also after c (breaking b < c) — it nets to zero for them, and a suggestion may not cost them a pair
	assert.equal(moves.some((m: any) => m.id === 'b' && m.to === 3), false, JSON.stringify(moves))
})

test('Given tasks named like object internals, when they are suggested, then only the listed ones are covered', () => {
	// GIVEN tasks whose ids are also properties every object has
	const doc = plan(['constructor', 'toString', 'plain'])

	// WHEN only two of them are suggested
	suggest(doc, ['plain', 'toString'])

	// THEN the third is not covered by inheritance, and the order is as suggested
	assert.deepEqual(suggested(doc), ['plain', 'toString'])
	assert.equal(suggestedRankOf(doc).rank.has('constructor'), false)
})

test('Given a plan of a hundred and sixty tasks, when its suggestion is read from a fresh copy of the document, then it takes milliseconds, not most of a second', () => {
	// GIVEN a suggestion over 160 tasks, as the live plan has
	const ids = Array.from({ length: 160 }, (_, i) => 'p' + String(i).padStart(3, '0'))
	const order = ids.map((_, i) => ids[(i * 37 + 11) % 160]!)
	const doc = plan(ids)
	suggest(doc, order)

	// WHEN it is read from copies, as the page and the server do after every change
	const start = performance.now()
	for (let k = 0; k < 5; k++) assert.deepEqual(suggested(structuredClone(doc)), order)
	const each = (performance.now() - start) / 5

	// THEN each read is cheap (it was ~650ms each, which pegged the page and the server)
	assert.ok(each < 60, `${each.toFixed(0)}ms per read`)
})

test('Given the suggestion is only ever a backdrop, when adopting or discarding is attempted, then neither command exists', () => {
	// The suggestion orders the queue beneath the person's answers; it is never turned into their answers and
	// never thrown away — a newer one replaces it. So neither command is part of the protocol.
	const doc = plan(['a', 'b'])
	suggest(doc, ['b', 'a'])
	for (const type of ['adoptRankSuggestion', 'clearRankSuggestion']) {
		assert.match(String(validateCommand(doc, { type } as any)), /unknown|not a command|no such/i, type)
	}
	assert.deepEqual(doc.rankSuggestion.order, ['b', 'a'])
})

test('Given random plans with dependencies, when a suggestion is read, then it orders the tasks exactly as the sorter does when asked pair by pair from the start', () => {
	// The independent judge: the plainest way to say what the suggestion means — give the sorter the dependencies as
	// answers, then ask it its next question, answer it from the suggested order, and start over — which is far too
	// slow for a real plan. The single-pass version must agree with it on the order, for any dependencies.
	const r = rng(23)
	for (let c = 0; c < 300; c++) {
		const n = 3 + Math.floor(r() * 12)
		const ids = Array.from({ length: n }, (_, i) => 'k' + i)
		const order = shuffled(ids, r)
		const doc = plan(ids)
		// each task may wait on one EARLIER task, so there are no cycles; chains give transitive pairs
		const prereqs = new Map<string, string[]>()
		doc.tasks.forEach((t: any, i: number) => {
			if (i > 0 && r() < 0.4) t.deps = [ids[Math.floor(r() * i)]!]
			prereqs.set(t.id, t.deps)
		})
		const items = doc.tasks.map((t: any) => ({ key: t.id, title: t.label, tags: [] }))
		const known: any[] = []
		for (const t of ids) {
			const seen = new Set<string>(), stack = [...(prereqs.get(t) ?? [])]
			while (stack.length) { const d = stack.pop()!; if (seen.has(d)) continue; seen.add(d); stack.push(...(prereqs.get(d) ?? []))
				known.push([pairKeyOf(d, t), orient(-1, flipOfIds(d, t)), true]) }
		}
		for (let q = replay(items, known).next; q; q = replay(items, known).next) {
			const a = items[q[0]].key, b = items[q[1]].key
			known.push([pairKeyOf(a, b), orient(order.indexOf(a) < order.indexOf(b) ? -1 : 1, flipOfIds(a, b))])
		}
		const expected = replay(items, known).order.map((i: number) => items[i].key)

		suggest(doc, order)

		assert.deepEqual(suggested(doc), expected, `case ${c}: n=${n} order=${order} deps=${JSON.stringify(doc.tasks.map((t: any) => t.deps))}`)
		assert.equal(suggestedRankOf(doc).next, null, `case ${c}`)
	}
})
