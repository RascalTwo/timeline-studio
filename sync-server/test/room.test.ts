// The room's behaviour, with no AWS and no socket. A session here is an object
// that collects frames — which is the whole reason `CommandRoom` takes one rather
// than a `WebSocket`.
//
// The fixture is invented. Nothing in this repo describes a real plan.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Doc, Task } from '../../shared/commands.js'
import { CommandRoom, type ServerFrame, type Session } from '../src/room'
import { SCHEMA } from '../../shared/schedule.js'

const task = (id: string, over: Partial<Task> = {}): Task => ({
	id,
	label: id,
	lane: 'build',
	createdAt: '2026-08-17T09:00:00.000Z',
	border: 'b1',
	fill: 'f1',
	shape: 's1',
	color: [],
	dur: 5,
	deps: [],
	...over,
})

const fixture = (): Doc => ({
	schemaVersion: SCHEMA,
	title: 'Demo',
	start: '2026-08-17',
	timeZone: 'America/Chicago',
	lanes: [
		{ id: 'build', label: 'Build' },
		{ id: 'qa', label: 'QA' },
	],
	borders: [{ id: 'b1', label: 'prod', style: 'solid' }],
	fills: [{ id: 'f1', label: 'known', pattern: 'solid' }],
	shapes: [{ id: 's1', label: 'none', shape: 'soft' }],
	colors: [{ id: 'rates', label: 'Rates', color: '#5aa9f0' }],
	milestones: [],
	tasks: [task('lease'), task('permits'), task('plumbing'), task('health', { lane: 'qa' })],
})

class Fake implements Session {
	readonly frames: ServerFrame[] = []
	closed = false
	constructor(readonly id: string) {}
	send(f: ServerFrame) {
		this.frames.push(f)
	}
	close() {
		this.closed = true
	}
	last(type: ServerFrame['type']) {
		return [...this.frames].reverse().find((f) => f.type === type)
	}
	of(type: ServerFrame['type']) {
		return this.frames.filter((f) => f.type === type)
	}
}

const room = (over: Partial<{ onChange: () => void }> = {}) =>
	new CommandRoom({ id: 'demo', doc: fixture(), ...over })

const join = (r: CommandRoom, id: string, since?: { epoch: string; seq: number }, lurk = false) => {
	const s = new Fake(id)
	r.join(s, { name: id, color: '#000' }, since, lurk)
	return s
}
const lurk = (r: CommandRoom, id: string) => join(r, id, undefined, true)

// --- applying ------------------------------------------------------------

test('Given a joined session, when a command applies, then it is sequenced and broadcast', () => {
	const r = room()
	const alice = join(r, 'alice')
	const bob = join(r, 'bob')

	assert.equal(r.apply([{ type: 'setDuration', id: 'lease', dur: 12 }], 'alice', { from: alice, ref: 'r1' }), null)

	assert.equal(r.seq, 1)
	assert.equal(r.doc.tasks.find((t) => t.id === 'lease')!.dur, 12)
	// The sender gets its own ref back; everyone else gets the same command without one.
	assert.equal((alice.last('cmd') as any).ref, 'r1')
	assert.equal((bob.last('cmd') as any).ref, undefined)
	assert.equal((bob.last('cmd') as any).seq, 1)
})

test('Given a command the protocol refuses, when it is applied, then the sender is told and nothing changes', () => {
	const r = room()
	const alice = join(r, 'alice')

	// NEGATIVE, not zero. Zero became legal when tasks that consume no working
	// time arrived — someone else's work, and work that is done the moment it is
	// started — so it is no longer an example of a refused command. Negative
	// still is, and the point of this test is the refusal path, not the number.
	const why = r.apply([{ type: 'setDuration', id: 'lease', dur: -1 }], 'alice', { from: alice, ref: 'r1' })

	// validateCommand's own words, not ours.
	assert.match(why!, /whole number of MINUTES greater than zero/)
	assert.equal((alice.last('rejected') as any).ref, 'r1')
	assert.equal(r.seq, 0)
	assert.equal(r.doc.tasks.find((t) => t.id === 'lease')!.dur, 5)
})

test('Given a command that would break the document, when it is applied, then invalid() rejects it after apply', () => {
	const r = room()
	const alice = join(r, 'alice')

	// Well-formed as a command; the resulting plan points at a lane that is gone.
	const why = r.apply([{ type: 'patchDoc', patch: { lanes: [{ id: 'qa', label: 'QA' }] } }], 'alice', {
		from: alice,
	})

	assert.match(why!, /lane "build" is not one of doc\.lanes/)
	assert.equal(r.seq, 0)
	assert.equal((r.doc.lanes as any[]).length, 2)
})

test('Given a batch, when one command in it fails, then the whole batch is discarded', () => {
	const r = room()
	const alice = join(r, 'alice')

	r.apply(
		[
			{ type: 'renameTask', id: 'lease', label: 'Sign lease' },
			{ type: 'setDuration', id: 'nope', dur: 3 },
		],
		'alice',
		{ from: alice }
	)

	assert.equal(r.seq, 0)
	assert.equal(r.doc.tasks.find((t) => t.id === 'lease')!.label, 'lease')
})

test('Given a batch that is only valid at the end, when it is applied, then it commits', () => {
	const r = room()
	// Adding a lane and moving a task onto it: after command 1 the plan is fine,
	// but a batch is allowed to pass through states no single edit could.
	const why = r.apply(
		[
			{ type: 'patchDoc', patch: { lanes: [{ id: 'build' }, { id: 'qa' }, { id: 'ops' }] } },
			{ type: 'setTaskChannel', id: 'health', channel: 'lane', value: 'ops' },
		],
		'agent'
	)
	assert.equal(why, null)
	assert.equal(r.seq, 2)
	assert.equal(r.doc.tasks.find((t) => t.id === 'health')!.lane, 'ops')
})

test('Given a lane reorder, when it applies, then only that lane’s slots permute', () => {
	const r = room()
	r.apply([{ type: 'moveTaskInLane', id: 'plumbing', toIndex: 0 }], 'alice')
	assert.deepEqual(
		r.doc.tasks.map((t) => t.id),
		['plumbing', 'lease', 'permits', 'health']
	)
})

test('Given a task exempted from the queue, when it applies, then the flag is set and clearing removes it', () => {
	const r = room()
	r.apply([{ type: 'setNoQueue', id: 'permits', noQueue: true }], 'alice')
	assert.equal(r.doc.tasks.find((t) => t.id === 'permits')!.noQueue, true)

	// Cleared rather than stored as false: absence IS the default, and a document
	// full of `noQueue: false` archives a version for every toggle and untoggle.
	r.apply([{ type: 'setNoQueue', id: 'permits', noQueue: false }], 'alice')
	assert.ok(!('noQueue' in r.doc.tasks.find((t) => t.id === 'permits')!))
})

test('Given a task given a link, when it applies, then the url is stored and null removes it', () => {
	const r = room()
	r.apply([{ type: 'setTaskUrl', id: 'permits', url: 'https://wiki.example.com/permits' }], 'alice')
	assert.equal(r.doc.tasks.find((t) => t.id === 'permits')!.url, 'https://wiki.example.com/permits')

	// Cleared rather than stored as '', for the same reason `desc` is: /save
	// decides whether to archive by comparing serialised documents, and an empty
	// string where the browser writes nothing is a spurious History entry.
	r.apply([{ type: 'setTaskUrl', id: 'permits', url: null }], 'alice')
	assert.ok(!('url' in r.doc.tasks.find((t) => t.id === 'permits')!))
})

test('Given a task given a ticket ref, when it applies, then it is trimmed and null removes it', () => {
	const r = room()
	r.apply([{ type: 'setTaskRef', id: 'permits', ref: '  STRY0181477  ' }], 'alice')
	assert.equal(r.doc.tasks.find((t) => t.id === 'permits')!.ref, 'STRY0181477')

	r.apply([{ type: 'setTaskRef', id: 'permits', ref: null }], 'alice')
	assert.ok(!('ref' in r.doc.tasks.find((t) => t.id === 'permits')!))
})

// A REF IS NOT A URL AND IS NOT CHECKED LIKE ONE — the base is supplied by the
// viewer and the ref is encodeURIComponent'd into it, so no scheme rule applies.
// What is refused is the shape that is never a ticket id.
test('Given a ref that is a line of text, when it is applied, then it is refused', () => {
	const r = room()
	const alice = join(r, 'alice')

	const why = r.apply([{ type: 'setTaskRef', id: 'permits', ref: 'STRY1\nSTRY2' }], 'alice', {
		from: alice,
		ref: 'r1',
	})

	assert.match(why!, /single identifier/)
	assert.equal(r.seq, 0)
	assert.ok(!('ref' in r.doc.tasks.find((t) => t.id === 'permits')!))
})

test('Given a blank ref, when it is applied, then it is refused rather than stored empty', () => {
	const r = room()
	const alice = join(r, 'alice')
	const why = r.apply([{ type: 'setTaskRef', id: 'permits', ref: '   ' }], 'alice', {
		from: alice,
		ref: 'r1',
	})
	assert.match(why!, /pass null to clear/)
	assert.equal(r.seq, 0)
})

// THE ONE THAT IS NOT ABOUT SHAPE. A url becomes an `href` in every other
// viewer's browser and a plan is reachable by anyone holding its link, so a
// `javascript:` url is script execution in someone else's tab. It has to be
// refused by the vocabulary, not only skipped by the renderer.
test('Given a javascript: url, when it is applied, then it is refused and nothing changes', () => {
	const r = room()
	const alice = join(r, 'alice')

	const why = r.apply(
		[{ type: 'setTaskUrl', id: 'permits', url: 'javascript:alert(1)' }],
		'alice',
		{ from: alice, ref: 'r1' }
	)

	assert.match(why!, /must start with http/)
	assert.equal(r.seq, 0)
	assert.ok(!('url' in r.doc.tasks.find((t) => t.id === 'permits')!))
})

test('Given setNoQueue with a non-boolean, when it is applied, then the sender is told and nothing changes', () => {
	const r = room()
	const alice = join(r, 'alice')

	const why = r.apply([{ type: 'setNoQueue', id: 'permits', noQueue: 'yes' } as any], 'alice', {
		from: alice,
		ref: 'r1',
	})

	assert.match(why!, /does not occupy a lane slot/)
	assert.equal(r.seq, 0)
	assert.ok(!('noQueue' in r.doc.tasks.find((t) => t.id === 'permits')!))
})

test('Given an addTask already applied, when a later command edits it, then the replay buffer is not rewritten', () => {
	const r = room()
	r.apply([{ type: 'addTask', task: task('paint') }], 'alice')
	r.apply([{ type: 'renameTask', id: 'paint', label: 'Paint it' }], 'alice')

	const rejoin = join(r, 'late', { epoch: r.epoch, seq: 0 })
	const [first] = (rejoin.last('resume') as any).commands
	assert.equal(first.cmd.task.label, 'paint')
})

// --- reconnect -----------------------------------------------------------

test('Given a client that missed commands, when it rejoins in range, then it is resumed', () => {
	const r = room()
	r.apply([{ type: 'setDuration', id: 'lease', dur: 7 }], 'alice')
	r.apply([{ type: 'setDuration', id: 'permits', dur: 8 }], 'alice')

	const back = join(r, 'back', { epoch: r.epoch, seq: 1 })

	const resume = back.last('resume') as any
	assert.ok(resume, 'expected a resume, not a welcome')
	assert.equal(back.last('welcome'), undefined)
	assert.deepEqual(
		resume.commands.map((c: any) => c.seq),
		[2]
	)
})

test('Given a client whose position has aged out of the buffer, when it rejoins, then it gets the whole document', () => {
	const r = room()
	// The buffer holds 1024; push past it so seq 1 is gone.
	for (let i = 0; i < 1100; i++) r.apply([{ type: 'setDuration', id: 'lease', dur: 1 + (i % 9) }], 'alice')

	const back = join(r, 'back', { epoch: r.epoch, seq: 1 })

	assert.ok(back.last('welcome'), 'expected a full-document welcome')
	assert.equal(back.last('resume'), undefined)
	assert.equal((back.last('welcome') as any).seq, r.seq)
})

test('Given a client from a previous room instance, when it rejoins, then the epoch mismatch forces a reset', () => {
	const r = room()
	r.apply([{ type: 'setDuration', id: 'lease', dur: 7 }], 'alice')

	// Exactly what a task restart looks like: the client holds a seq the new
	// instance would happily have accepted, against a log that means nothing.
	const back = join(r, 'back', { epoch: 'some-older-instance', seq: 1 })

	assert.ok(back.last('welcome'))
	assert.equal(back.last('resume'), undefined)
})

test('Given a client ahead of the server, when it rejoins, then it is not resumed', () => {
	const r = room()
	const back = join(r, 'back', { epoch: r.epoch, seq: 99 })
	assert.ok(back.last('welcome'))
})

// --- presence ------------------------------------------------------------

test('Given a cursor move, when it is broadcast, then it is not sequenced and not in the buffer', () => {
	const r = room()
	const alice = join(r, 'alice')
	const bob = join(r, 'bob')

	r.setPresence(alice.id, { cursor: { day: 12.5, laneRow: 2 } })

	assert.equal(r.seq, 0)
	assert.deepEqual((bob.last('presence') as any).presence.cursor, { day: 12.5, laneRow: 2 })
	// A rejoin at seq 0 still resumes with nothing — presence never entered the log.
	const back = join(r, 'back', { epoch: r.epoch, seq: 0 })
	assert.deepEqual((back.last('resume') as any).commands, [])
})

test('Given a cursor that is not a chart coordinate, when it is set, then it is dropped', () => {
	const r = room()
	const alice = join(r, 'alice')
	r.setPresence(alice.id, { cursor: { day: Number.NaN, laneRow: 0 } })
	assert.equal(r.everyone()[0]!.cursor, null)
})

// --- lurking -------------------------------------------------------------
// A LURKER IS A SESSION WITH NO PRESENCE ENTRY. Every assertion below is really
// the same one asked from a different direction, because the point of building
// it that way is that there is no filter anywhere to forget.

test('Given a lurker joins, when they do, then nobody is told and the roster does not grow', () => {
	const r = room()
	const bob = join(r, 'bob')
	const ghost = lurk(r, 'ghost')

	assert.equal(bob.last('presence'), undefined)
	assert.deepEqual(r.everyone().map((p) => p.sessionId), ['bob'])
	// They are still in the room: the plan must not scale to zero under a reader.
	assert.equal(r.sessionCount, 2)
	assert.equal(r.visibleCount, 1)
	// And they got the document like anyone else.
	assert.ok((ghost.last('welcome') as any).doc)
})

test('Given a lurker, when they move their pointer, then no cursor reaches anyone', () => {
	const r = room()
	const bob = join(r, 'bob')
	const ghost = lurk(r, 'ghost')

	r.setPresence(ghost.id, { cursor: { day: 12.5, laneRow: 2 } })

	assert.equal(bob.last('presence'), undefined)
	assert.equal(r.everyone().length, 1)
})

test('Given a lurker, when they leave, then no one is told they were ever there', () => {
	const r = room()
	const bob = join(r, 'bob')
	const ghost = lurk(r, 'ghost')

	assert.equal(r.leave(ghost.id), 1)
	assert.equal(bob.last('left'), undefined)
})

test('Given a lurker, when they send a command, then it is sequenced and attributed like anyone else', () => {
	const r = room()
	const bob = join(r, 'bob')
	const ghost = lurk(r, 'ghost')

	assert.equal(r.apply([{ type: 'setDuration', id: 'lease', dur: 12 }], 'ghost', { from: ghost, ref: 'r1' }), null)

	// THIS IS THE LIMIT OF THE FEATURE, asserted so nobody mistakes it for more.
	// Hiding a cursor is not hiding an editor, and the broadcast still says who.
	assert.equal(r.seq, 1)
	assert.equal((bob.last('cmd') as any).by, 'ghost')
})

test('Given a lurker who becomes visible, when they rejoin without the flag, then they appear', () => {
	const r = room()
	const bob = join(r, 'bob')
	const ghost = lurk(r, 'ghost')
	assert.equal(r.visibleCount, 1)

	// What the client does on the toggle: drop the socket, join again as yourself.
	r.leave(ghost.id)
	join(r, 'ghost')

	assert.equal((bob.last('presence') as any).presence.sessionId, 'ghost')
	assert.equal(r.visibleCount, 2)
})

test('Given a session that leaves, when it does, then its presence goes with it', () => {
	const r = room()
	const alice = join(r, 'alice')
	const bob = join(r, 'bob')
	assert.equal(r.leave(alice.id), 1)
	assert.equal((bob.last('left') as any).sessionId, alice.id)
	assert.equal(r.everyone().length, 1)
})

// --- revert --------------------------------------------------------------

test('Given a revert, when it lands, then everyone gets the document and the buffer is cleared', () => {
	const r = room()
	const alice = join(r, 'alice')
	r.apply([{ type: 'setDuration', id: 'lease', dur: 30 }], 'alice')

	const old = fixture()
	assert.equal(r.replaceDoc(old, { from: 3, note: 'before the re-plan', by: 'alice' }), null)

	const frame = alice.last('reverted') as any
	assert.equal(frame.from, 3)
	assert.equal(frame.note, 'before the re-plan')
	assert.equal(r.doc.tasks.find((t) => t.id === 'lease')!.dur, 5)

	// A log spanning a revert does not reproduce it, so nobody may resume across one.
	const back = join(r, 'back', { epoch: r.epoch, seq: 1 })
	assert.ok(back.last('welcome'))
})

test('Given a version that does not validate, when it is reverted to, then the room is untouched', () => {
	const r = room()
	const broken = fixture()
	;(broken as any).schemaVersion = 3
	assert.match(r.replaceDoc(broken, { from: 1, note: '', by: 'alice' })!, new RegExp(`schemaVersion must be ${SCHEMA}`))
	assert.equal(r.doc.schemaVersion, SCHEMA)
})

// --- persistence signal --------------------------------------------------

test('Given a rejected command, when it is applied, then no draft write is scheduled', () => {
	let changes = 0
	const r = new CommandRoom({ id: 'demo', doc: fixture(), onChange: () => changes++ })
	r.apply([{ type: 'setDuration', id: 'lease', dur: -1 }], 'alice')
	assert.equal(changes, 0)
	r.apply([{ type: 'setDuration', id: 'lease', dur: 6 }], 'alice')
	assert.equal(changes, 1)
})

test('Given a batch that would close a dependency cycle, when it is applied, then the server refuses it', () => {
	const r = room()
	const alice = join(r, 'alice')

	// A chain first: plumbing <- permits <- lease.
	assert.equal(r.apply([
		{ type: 'addDep', id: 'permits', dep: 'lease' },
		{ type: 'addDep', id: 'plumbing', dep: 'permits' },
	], 'alice', { from: alice }), null)

	// Now close the loop. The page guards this too, but its guard was unsound
	// once — it asked the scheduler to throw, and a cycle running through an
	// already-finished task never stopped it — so a cyclic document reached the
	// server and was broadcast to everyone in the room.
	const why = r.apply([{ type: 'addDep', id: 'lease', dep: 'plumbing' }], 'alice', { from: alice })

	assert.match(why!, /dependency cycle/)
	assert.deepEqual(r.doc.tasks.find((t) => t.id === 'lease')!.deps, [],
		'and nothing was written')
})

test('Given a plan that is ALREADY cyclic, when an edit arrives, then it is still editable', () => {
	const r = room()
	const alice = join(r, 'alice')

	// Forced in the way a buggy client managed it, bypassing apply().
	r.doc.tasks.find((t) => t.id === 'lease')!.deps = ['plumbing']
	r.doc.tasks.find((t) => t.id === 'plumbing')!.deps = ['lease']

	// THE FALSIFIER FOR AN ABSOLUTE CHECK. Refusing every command while a cycle
	// exists refuses the one command that would fix it, and the plan is frozen
	// by its own validation with no way out but a hand-edited file. So the
	// question is whether this batch INTRODUCED one, not whether one is present.
	assert.equal(r.apply([{ type: 'renameTask', id: 'health', label: 'Inspection' }],
		'alice', { from: alice }), null)
	assert.equal(r.apply([{ type: 'removeDep', id: 'lease', dep: 'plumbing' }],
		'alice', { from: alice }), null, 'and the fix itself goes through')
})

test('Given an addTask with no at, when it applies, then the room dates it and the task has createdAt', () => {
	// v5 requires `createdAt`, and `addTask` can only stamp one from `at`. The page
	// and /api/commands date their commands; any other socket client may not.
	const r = room()
	const { createdAt: _none, ...bare } = task('undated')
	const err = r.apply([{ type: 'addTask', task: bare } as any], 'bot')
	assert.equal(err, null)
	const t = r.doc.tasks.find((x) => x.id === 'undated')!
	assert.equal(typeof t.createdAt, 'string')
	assert.ok(!Number.isNaN(Date.parse(t.createdAt!)))
})
