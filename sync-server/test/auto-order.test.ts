// AUTO-ORDER: after a change that could move a queue, the server searches and
// applies the moves itself until no single move helps, and `settled()` is what a
// `settle=1` caller waits on. Driven through a real CommandRoom and the real
// reorder worker; storage is never touched on this path (the room is not
// registered, so `closeRoomIfUnused` has nothing to flush).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orderSignature } from '../../shared/schedule.js'
import { CommandRoom } from '../src/room'

process.env.DATA_BUCKET ??= 'unused-by-this-test'
const { afterApply, settled, settledIfOrderChanged } = await import('../src/rooms')

const now = new Date()
const iso = (d: Date) => d.toISOString()
const plan = (autoOrder: boolean): any => ({
	schemaVersion: 9, title: 't', start: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }),
	timeZone: 'America/Chicago', autoOrder,
	lanes: [{ id: 'L1', label: 'Me', cap: 1 }], borders: [{ id: 'b', label: 'b', style: 'solid' }],
	fills: [{ id: 'f', label: 'f', pattern: 'solid' }], shapes: [{ id: 's', label: 's', shape: 'soft' }],
	colors: [], milestones: [],
	tasks: [
		{ id: 'big', label: 'big', lane: 'L1', border: 'b', fill: 'f', shape: 's', color: [], deps: [], dur: 5 * 1440, createdAt: iso(now) },
		{ id: 'small', label: 'small', lane: 'L1', border: 'b', fill: 'f', shape: 's', color: [], deps: [], dur: 60,
		  due: iso(new Date(+now + 864e5)), createdAt: iso(now) },
	],
})
const change = (room: CommandRoom, id: any) => {
	const before = orderSignature(room.doc)
	assert.equal(room.apply([{ type: 'setDuration', id: 'big', dur: 6 * 1440 } as any], 'me'), null)
	afterApply(id, room, before)
}

test('Given Auto-order on, when a change could move the queue, then it settles and settled() waits for it', async () => {
	const room = new CommandRoom({ id: 'ao-on', doc: plan(true) })
	change(room, 'ao-on')
	await settled('ao-on' as any)
	assert.deepEqual(room.doc.tasks.map((t: any) => t.id), ['small', 'big'],
		'the 1-hour task due tomorrow moved ahead of the 5-day one')
})

test('Given Auto-order off, when the same change lands, then nothing moves', async () => {
	const room = new CommandRoom({ id: 'ao-off', doc: plan(false) })
	change(room, 'ao-off')
	await settled('ao-off' as any)
	assert.deepEqual(room.doc.tasks.map((t: any) => t.id), ['big', 'small'])
})

test('Given a change that cannot move the queue, when it lands, then no search runs', async () => {
	const room = new CommandRoom({ id: 'ao-desc', doc: plan(true) })
	const before = orderSignature(room.doc)
	room.apply([{ type: 'setTaskDesc', id: 'big', desc: 'words' } as any], 'me')
	afterApply('ao-desc' as any, room, before)
	const t0 = Date.now()
	await settled('ao-desc' as any)
	assert.ok(Date.now() - t0 < 50, 'settled immediately — nothing was scheduled')
	assert.deepEqual(room.doc.tasks.map((t: any) => t.id), ['big', 'small'], 'and nothing moved')
})

test('Given a settle running, when a write that cannot move the queue waits, then it returns without waiting for that settle', async () => {
	const room = new CommandRoom({ id: 'ao-w1', doc: plan(true) })
	change(room, 'ao-w1') // starts a settle that is still searching
	let running = true
	const settle = settled('ao-w1' as any).then(() => { running = false })
	const before = orderSignature(room.doc)
	room.apply([{ type: 'setTaskDesc', id: 'big', desc: 'words' } as any], 'me')
	await settledIfOrderChanged('ao-w1' as any, room, before)
	assert.ok(running, 'returned while the other write\'s settle was still searching')
	await settle
})

test('Given a write that moves the queue, when it waits, then it returns only once the queue has settled', async () => {
	const room = new CommandRoom({ id: 'ao-w2', doc: plan(true) })
	const before = orderSignature(room.doc)
	room.apply([{ type: 'setDuration', id: 'big', dur: 6 * 1440 } as any], 'me')
	afterApply('ao-w2' as any, room, before)
	await settledIfOrderChanged('ao-w2' as any, room, before)
	assert.deepEqual(room.doc.tasks.map((t: any) => t.id), ['small', 'big'])
})
