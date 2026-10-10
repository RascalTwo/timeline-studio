// SESSIONS ARE THE ONLY RECORD OF WORK (schema v8, ADR 0016). A task says it is finished with `done`, and every
// date the chart used to read off `actualStart`/`actualEnd` is read off the sessions instead: the first start,
// and the last stop of a done task. Status is derived: done > running > paused > not started.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand, validateCommand } from '../../shared/commands.js'
import { SCHEMA, applyMigrations, boardColumns, dayNumbers, readiness, statusOf, todayISO } from '../../shared/schedule.js'
import { invalid } from '../src/validate.js'

const fixture = (t: any = {}, more: any[] = []): any => ({
	schemaVersion: 10, start: '2026-09-21', timeZone: 'UTC', lanes: [{ id: 'me', label: 'Me', cap: 1 }],
	tasks: [{ id: 't', lane: 'me', dur: 240, deps: [], refinedAt: '2026-09-20T00:00:00.000Z', ...t }, ...more],
})
const run = (doc: any, cmd: any) => applyCommand(doc, cmd)
const bad = (doc: any, cmd: any) => validateCommand(doc, cmd)!
const S = (start: string, stop: string | null) => ({ start, stop })

// ---- the commands --------------------------------------------------------------------------------------
test('Given a field Task does not have, when addTask carries it, then it is refused by name', () => {
	for (const k of ['description', 'actualStart'])
		assert.match(bad(fixture(), { type: 'addTask', task: { id: 'n', dur: 5, [k]: 'x' } }), new RegExp(`task\\.${k} is not a task field`))
	assert.doesNotMatch(String(validateCommand(fixture(), { type: 'addTask', task: { id: 'n', label: 'n', dur: 5, desc: 'x', noQueue: true } })), /not a task field/)
})

test('Given a task never started, when it is finished, then it holds one session of no length at the finish', () => {
	const doc = fixture()
	run(doc, { type: 'finishTask', id: 't', at: '2026-09-21T10:00:00Z' })
	assert.deepEqual(doc.tasks[0].sessions, [S('2026-09-21T10:00:00.000Z', '2026-09-21T10:00:00.000Z')])
	assert.equal(doc.tasks[0].done, true)
	assert.equal(statusOf(doc.tasks[0]), 'done')
	assert.ok(doc.tasks[0].refinedAt, 'finishing is a fact, not an edit')
})

test('Given a running task, when it is finished, then the running session stops at the finish', () => {
	const doc = fixture()
	run(doc, { type: 'startTask', id: 't', at: '2026-09-21T09:00:00Z' })
	run(doc, { type: 'finishTask', id: 't', at: '2026-09-21T11:00:00Z' })
	assert.deepEqual(doc.tasks[0].sessions, [S('2026-09-21T09:00:00.000Z', '2026-09-21T11:00:00.000Z')])
	assert.equal(doc.tasks[0].done, true)
})

test('Given a paused task, when it is finished, then its sessions are untouched', () => {
	const doc = fixture({ sessions: [S('2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z')] })
	run(doc, { type: 'finishTask', id: 't', at: '2026-09-22T12:00:00Z' })
	assert.deepEqual(doc.tasks[0].sessions, [S('2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z')])
	assert.equal(doc.tasks[0].done, true)
})

test('Given finish and reopen, when they do not apply, then they are refused', () => {
	const doc = fixture({ sessions: [S('2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z')] })
	assert.match(bad(doc, { type: 'reopenTask', id: 't' }), /not finished/)
	assert.match(bad(doc, { type: 'finishTask', id: 't', at: '2026-09-21T09:30:00Z' }), /before its last session/)
	assert.match(bad(doc, { type: 'finishTask', id: 't' }), /needs `at`/)
	run(doc, { type: 'finishTask', id: 't', at: '2026-09-21T10:00:00Z' })
	assert.match(bad(doc, { type: 'finishTask', id: 't', at: '2026-09-21T11:00:00Z' }), /already finished/)
	assert.match(bad(doc, { type: 'startTask', id: 't', at: '2026-09-21T11:00:00Z' }), /reopenTask/)
})

test('Given a finished task, when it is reopened, then it is paused with its sessions kept', () => {
	const doc = fixture({ done: true, sessions: [S('2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z')] })
	run(doc, { type: 'reopenTask', id: 't', at: '2026-09-22T09:00:00Z' })
	assert.equal(doc.tasks[0].done, undefined, 'cleared, not written false')
	assert.equal(doc.tasks[0].sessions.length, 1)
	assert.equal(statusOf(doc.tasks[0]), 'paused')
})

test('Given a worked task, when its sessions are emptied, then it is refused — it cannot go back to not started', () => {
	const doc = fixture({ sessions: [S('2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z')] })
	assert.match(bad(doc, { type: 'setSessions', id: 't', sessions: [] }), /split it/)
	const done = fixture({ done: true, sessions: [S('2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z')] })
	assert.match(bad(done, { type: 'setSessions', id: 't', sessions: [S('2026-09-21T09:00:00Z', null)] }), /running session/)
	assert.equal(bad(fixture(), { type: 'setSessions', id: 't', sessions: [] }), null, 'a task never worked on has nothing to lose')
})

test('Given a repeating task, when a copy is finished, then the series is topped up and the copy is not done', () => {
	const doc = fixture({ notBefore: '2026-09-21T09:00:00.000Z' })
	run(doc, { type: 'setRecur', id: 't', recur: { n: 1, unit: 'week', ahead: 1 }, at: '2026-09-20T00:00:00Z' })
	const before = doc.tasks.length
	run(doc, { type: 'finishTask', id: 't', at: '2026-09-21T10:00:00Z' })
	assert.equal(doc.tasks.length, before + 1)
	const fresh = doc.tasks[doc.tasks.length - 1]
	assert.equal(fresh.done, undefined)
	assert.equal(fresh.sessions, undefined)
})

// ---- status, as the API and the board read it ---------------------------------------------------------
test('Given each kind of task, when its status is derived, then done > running > paused > not started', () => {
	assert.equal(statusOf({}), 'todo')
	assert.equal(statusOf({ sessions: [S('2026-09-21T09:00:00Z', null)] }), 'running')
	assert.equal(statusOf({ sessions: [S('2026-09-21T09:00:00Z', '2026-09-21T10:00:00Z')] }), 'paused')
	assert.equal(statusOf({ done: true, sessions: [S('2026-09-21T09:00:00Z', '2026-09-21T10:00:00Z')] }), 'done')
})

test('Given running and paused work, when the board is built, then In progress holds them as two groups', () => {
	const today = todayISO()
	const at = (h: number) => new Date(Date.parse(today + 'T00:00:00Z') + h * 3600e3).toISOString()
	const doc = fixture({ id: 'run', sessions: [S(at(-30), at(-29)), S(at(-2), null)] }, [
		{ id: 'old', lane: 'me', dur: 60, deps: [], sessions: [S(at(-50), at(-49))] },
		{ id: 'new', lane: 'me', dur: 60, deps: [], sessions: [S(at(-5), at(-4))] },
	])
	doc.start = today
	const c = boardColumns(doc)
	assert.deepEqual(c.running.map((r: any) => r.id), ['run'])
	assert.deepEqual(c.paused.map((r: any) => r.id), ['old', 'new'], 'oldest-started first')
	assert.deepEqual(readiness(doc).map((r: any) => r.status), ['running', 'paused', 'paused'])
})

test('Given a done task, when it is projected for the scheduler, then it ran from the first start to the last stop', () => {
	const d = dayNumbers(fixture({ done: true, sessions: [S('2026-09-21T06:00:00.000Z', '2026-09-21T09:00:00.000Z'),
		S('2026-09-22T06:00:00.000Z', '2026-09-22T12:00:00.000Z')] }))
	assert.equal(d.tasks[0]!.actualStart, 0.25)
	assert.equal(d.tasks[0]!.actualEnd, 1.5)
	const open = dayNumbers(fixture({ sessions: [S('2026-09-21T06:00:00.000Z', '2026-09-21T09:00:00.000Z')] }))
	assert.equal(open.tasks[0]!.actualEnd, undefined, 'paused is not finished')
})

// ---- the migration ---------------------------------------------------------------------------------------
const v7 = (tasks: any[]): any => ({ schemaVersion: 7, title: 'x', start: '2026-09-21', timeZone: 'UTC', lanes: [{ id: 'me', label: 'Me', cap: 1 }],
	borders: [{ id: 'b' }], fills: [{ id: 'f' }], shapes: [{ id: 's' }], colors: [], milestones: [], tasks })
const T = (id: string, over: any = {}) => ({ id, label: id, lane: 'me', border: 'b', fill: 'f', shape: 's', color: [], dur: 60, deps: [],
	createdAt: '2026-09-20T00:00:00.000Z', ...over })

test('Given finished work with no sessions, when a v7 plan is upgraded, then it is done with one session over its actuals', () => {
	const d = applyMigrations(v7([T('a', { actualStart: '2026-09-21T09:00:00.000Z', actualEnd: '2026-09-21T10:00:00.000Z' })]))
	assert.equal(d.schemaVersion, SCHEMA)
	assert.deepEqual(d.tasks[0], T('a', { sessions: [S('2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z')], done: true }))
})

test('Given worked tasks, when upgraded, then sessions are kept and only a start or finish outside them is marked', () => {
	const ss = [S('2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z')]
	const d = applyMigrations(v7([
		T('same', { actualStart: ss[0]!.start, actualEnd: ss[0]!.stop, sessions: ss }),
		T('typed', { actualStart: '2026-09-20T09:00:00.000Z', sessions: ss }),
		T('late', { actualStart: ss[0]!.start, actualEnd: '2026-09-22T10:00:00.000Z', sessions: ss }),
		T('paused', { actualStart: ss[0]!.start, sessions: ss }),
		T('running', { actualStart: ss[0]!.start, sessions: [S(ss[0]!.start, null)] }),
		T('bare', { actualStart: '2026-09-21T09:00:00.000Z' }),
		T('todo'),
	]))
	const by = Object.fromEntries(d.tasks.map((t: any) => [t.id, t]))
	assert.deepEqual(by.same, T('same', { sessions: ss, done: true }))
	assert.deepEqual(by.typed.sessions, [S('2026-09-20T09:00:00.000Z', '2026-09-20T09:00:00.000Z'), ...ss], 'the typed start survives, with no work in it')
	assert.deepEqual(by.late.sessions, [...ss, S('2026-09-22T10:00:00.000Z', '2026-09-22T10:00:00.000Z')], 'the later finish survives, with no work in it')
	assert.equal(by.late.done, true)
	assert.deepEqual(by.paused, T('paused', { sessions: ss }))
	assert.deepEqual(by.running, T('running', { sessions: [S(ss[0]!.start, null)] }))
	assert.deepEqual(by.bare, T('bare', { sessions: [S('2026-09-21T09:00:00.000Z', '2026-09-21T09:00:00.000Z')] }))
	assert.deepEqual(by.todo, T('todo'))
	for (const t of d.tasks) assert.ok(!('actualStart' in t) && !('actualEnd' in t), `${t.id} keeps no actuals`)
})

test('Given a plan shaped like the live one, when upgraded, then every status count and every date is unchanged', () => {
	// The shape of the real plan on 2026-10-04: mostly finished without sessions, some with, a few in flight.
	const h = (n: number) => new Date(Date.parse('2026-09-21T00:00:00Z') + n * 3600e3).toISOString()
	const tasks: any[] = []
	for (let i = 0; i < 40; i++) tasks.push(T(`old${i}`, { actualStart: h(i), actualEnd: h(i + 0.3) }))
	for (let i = 0; i < 12; i++) tasks.push(T(`worked${i}`, { actualStart: h(100 + i), actualEnd: h(100.5 + i), sessions: [S(h(100 + i), h(100.5 + i))] }))
	tasks.push(T('running', { actualStart: h(200), sessions: [S(h(200), null)] }))
	tasks.push(T('paused', { actualStart: h(190), sessions: [S(h(190), h(191))] }))
	for (let i = 0; i < 10; i++) tasks.push(T(`todo${i}`))
	const old = v7(tasks)
	const oldStatus = (t: any) => t.actualEnd != null ? 'done' : t.actualStart != null ? 'doing' : 'todo'
	const count = (xs: string[]) => xs.reduce((m: any, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {})
	const before = count(old.tasks.map(oldStatus))
	const d = applyMigrations(structuredClone(old))
	const after = count(d.tasks.map((t: any) => { const s = statusOf(t); return s === 'running' || s === 'paused' ? 'doing' : s }))
	assert.deepEqual(after, before)
	assert.deepEqual(before, { done: 52, doing: 2, todo: 10 })
	assert.equal(invalid(d as any), null, 'the upgraded plan passes the document check')
	// Every date the scheduler reads is the same instant it was.
	const day = (iso: string) => (Date.parse(iso) - Date.parse('2026-09-21T00:00:00Z')) / 864e5
	const proj = dayNumbers(d)
	for (const t of old.tasks) {
		const p = proj.tasks.find((x: any) => x.id === t.id)!
		assert.equal(p.actualStart, t.actualStart == null ? undefined : day(t.actualStart), `${t.id} start`)
		assert.equal(p.actualEnd, t.actualEnd == null ? undefined : day(t.actualEnd), `${t.id} end`)
	}
})

test('Given a v8 document arriving whole, when it is checked, then unfinished finishes are refused', () => {
	const base = (t: any) => ({ ...fixture(), title: 'x', borders: [{ id: 'b' }], fills: [{ id: 'f' }], shapes: [{ id: 's' }], colors: [],
		milestones: [], tasks: [{ id: 't', label: 't', lane: 'me', border: 'b', fill: 'f', shape: 's', color: [], deps: [], dur: 60, createdAt: '2026-09-20T00:00:00.000Z', ...t }] })
	assert.equal(invalid(base({}) as any), null)
	assert.match(String(invalid(base({ done: true }) as any)), /needs at least one session/)
	assert.match(String(invalid(base({ done: true, sessions: [S('2026-09-21T10:00:00.000Z', null)] }) as any)), /none still running/)
})
