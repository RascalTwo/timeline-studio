// THE MIGRATOR, WHICH NOTHING TESTED.
//
// `applyMigrations` is the one piece of this tool that rewrites documents people
// already have, and it runs on EVERY document the page adopts — see `adopt()`,
// `importFile()` and `forkVersion()`. It had no test at all.
//
// The two places that exercised it were both something else. The page ran a
// synthetic ladder inside `selftest()` on every load, which was a unit test
// shipped to readers and has since been deleted along with the rest of that
// duplication. And `docs/original/verify.interactions.ts` drove one too — 3,793
// lines needing a live deployment and an external runner, which nothing in this
// repo or its CI could execute, so it had not run in a long time. That file is
// gone; this is the part of it that earned keeping, as a node test that runs in
// twenty milliseconds.
//
// SEQUENCING IS THE SUBJECT, not any individual migration. `applyMigrations` says
// so itself — "the migrations are trivial, the sequencing is what silently ruins
// data" — which is why it takes its ladder as a parameter. A rung applied twice,
// or skipped, or run out of order, produces a document that is structurally
// valid and quietly wrong, and the durations one multiplies by seven.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyMigrations, MIGRATIONS, SCHEMA, dayOfInstant } from '../../shared/schedule.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Doc } from '../../shared/commands.js'

/** A ladder that records the order it was walked in, so the test can assert the
 *  WALK rather than the destination. Each rung stamps its own index into a trail
 *  on the document. */
const traced = () => {
	const trail: number[] = []
	const ladder = [null, ...[1, 2, 3].map(n => (d: any) => {
		trail.push(n)
		return { ...d, trail: [...(d.trail || []), n] }
	})]
	return { trail, ladder }
}

const plain = (over: Partial<Doc> = {}) => ({ title: 'p', start: '2026-01-05', lanes: [], tasks: [], ...over }) as any

test('an unstamped document is v1, not v0 — every rung runs', () => {
	const { trail, ladder } = traced()
	// A plan written before versioning existed is structurally a v1. Treating it
	// as v0 would demand a v0->v1 rung that does nothing, which is a step that
	// exists only to be tripped over.
	const out = applyMigrations(plain(), ladder as any, 4)
	assert.deepEqual(trail, [1, 2, 3])
	assert.equal(out.schemaVersion, 4)
})

test('the walk starts at the version the document claims, and skips nothing before it', () => {
	const { trail, ladder } = traced()
	applyMigrations(plain({ schemaVersion: 3 } as any), ladder as any, 4)
	assert.deepEqual(trail, [3], 'a v3 document runs the v3->v4 rung and only that one')
})

test('a document already at the target is left completely alone', () => {
	const { trail, ladder } = traced()
	const out = applyMigrations(plain({ schemaVersion: 4 } as any), ladder as any, 4)
	assert.deepEqual(trail, [])
	assert.equal(out.trail, undefined, 'no rung ran, so nothing was rewritten')
})

test('each rung runs exactly once, in order, and sees the previous one’s output', () => {
	// THE FAILURE THIS EXCLUDES is a rung applied twice. It is invisible in the
	// result of a widening migration and catastrophic in a multiplying one: the
	// v3->v4 rung multiplies every duration by seven, so running it twice turns a
	// two-day task into a ninety-eight-day one and the document stays valid.
	const { ladder } = traced()
	const out = applyMigrations(plain(), ladder as any, 4)
	assert.deepEqual(out.trail, [1, 2, 3])
})

test('a document from a newer version is refused rather than downgraded', () => {
	// There is no way back down a ladder, and pretending otherwise would hand
	// somebody a plan with fields silently dropped.
	assert.throws(() => applyMigrations(plain({ schemaVersion: SCHEMA + 1 } as any), MIGRATIONS as any, SCHEMA),
		/newer version/)
})

test('a missing rung stops the walk instead of stepping over it', () => {
	// A hole in the ladder must not be treated as "nothing to do". Skipping it
	// would stamp the document with the target version while leaving it in the
	// shape of an older one — which is the one outcome nothing downstream can
	// detect, because the stamp is the only thing anybody checks.
	const holed = [null, null, (d: any) => d, (d: any) => d]
	assert.throws(() => applyMigrations(plain(), holed as any, 4), /no migration from v1/)
})

// ---- the real ladder, at the rungs where a mistake is not recoverable --------

test('v1 -> v2 widens a colour into a list, and a null colour into an empty one', () => {
	const out = applyMigrations(
		plain({ schemaVersion: 1, tasks: [{ id: 'a', color: 'c1' }, { id: 'b', color: null }] } as any),
		MIGRATIONS as any, 2)
	// `[]` is a real state — "no system" — and not an error. A task can genuinely
	// touch nothing, which is the honest bottom of a LIST.
	assert.deepEqual(out.tasks.map((t: any) => t.color), [['c1'], []])
})

test('v3 -> v4 multiplies durations and start constraints by seven, and nothing else', () => {
	const out = applyMigrations(plain({
		schemaVersion: 3,
		start: '2026-01-05',
		sprint: { weeks: 2 },
		milestones: [{ id: 'm1', label: 'Ship', date: '2026-04-01' }],
		tasks: [{ id: 'a', dur: 2, notBefore: 1.5 }, { id: 'b', dur: 0.5 }],
	} as any), MIGRATIONS as any, 4)
	assert.deepEqual(out.tasks.map((t: any) => t.dur), [14, 3.5])
	assert.equal(out.tasks[0].notBefore, 10.5)
	assert.equal(out.tasks[1].notBefore, undefined, 'a task without a constraint does not grow one')
	// LOSSLESS, which is the good news about doing it this way round: half a week
	// was the finest thing the old unit could express, and 0.5 * 7 = 3.5 is exact
	// in binary. No plan loses a hair of precision going through.
	assert.equal(out.tasks[1].dur, 3.5)
	// NOT in the base unit and therefore not touched: dates are ISO strings, and
	// a sprint IS a number of weeks — it converts where it is rendered.
	assert.equal(out.start, '2026-01-05')
	assert.equal(out.milestones![0]!.date, '2026-04-01')
	assert.deepEqual(out.sprint, { weeks: 2 })
})

test('the whole real ladder takes an unstamped document to the current schema', () => {
	// The end-to-end walk, which is what an imported file from somebody's
	// downloads folder actually does — the most likely thing in this tool to be
	// old, and the reason import migrates on the way IN.
	const out = applyMigrations(plain({
		lanes: [{ id: 'L', label: 'Team' }],
		tasks: [{ id: 'a', lane: 'L', color: 'c1', dur: 2 }],
	} as any), MIGRATIONS as any, SCHEMA)
	assert.equal(out.schemaVersion, SCHEMA)
	assert.deepEqual(out.tasks[0].color, ['c1'], 'the v1 rung ran')
	assert.equal(out.tasks[0].dur, 14 * 1440, 'the v4 rung ran exactly once (2 weeks -> 14 days), then v7 made it minutes')
})

// ---- v4 -> v5: every task says when it was added ---------------------------
const t4 = (id: string, over: Record<string, unknown> = {}) =>
	({ id, label: id, dur: 1, deps: [], color: [], lane: 'l', border: 'b', fill: 'f', shape: 's', ...over })
const v4 = (tasks: any[]) => plain({ schemaVersion: 4, tasks })
const save = (at: string, tasks: any[], schemaVersion = 4) => ({ at, doc: plain({ schemaVersion, tasks }) })
const task5 = (d: any, id: string) => d.tasks.find((t: any) => t.id === id)

test('Given saved history, when a v4 plan is upgraded, then createdAt is the first save a task is in and updatedAt its last wording change', () => {
	const history = [
		save('2026-09-19T10:00:00.000Z', [t4('a')]),
		save('2026-09-20T10:00:00.000Z', [t4('a', { label: 'renamed' }), t4('b')]),
		save('2026-09-21T10:00:00.000Z', [t4('a', { label: 'renamed' }), t4('b', { notBefore: 3 })]),
	]
	const d = applyMigrations(v4([t4('a', { label: 'renamed' }), t4('b', { notBefore: 3 })]), MIGRATIONS, SCHEMA,
		{ history, now: '2026-09-26T00:00:00.000Z' })
	assert.equal(d.schemaVersion, SCHEMA)
	assert.equal(task5(d, 'a').createdAt, '2026-09-19T10:00:00.000Z')
	assert.equal(task5(d, 'a').updatedAt, '2026-09-20T10:00:00.000Z', 'the save its label changed in')
	assert.equal(task5(d, 'b').createdAt, '2026-09-20T10:00:00.000Z')
	// A constraint is not wording: `notBefore` moved, the task was never EDITED.
	assert.equal(task5(d, 'b').updatedAt, undefined, 'absent means never edited')
})

test('Given a task the server already stamped, when upgraded, then its stamps are kept', () => {
	const d = applyMigrations(v4([t4('a', { createdAt: '2026-09-25T08:00:00.000Z' })]), MIGRATIONS, SCHEMA,
		{ history: [save('2026-09-19T10:00:00.000Z', [t4('a')])], now: '2026-09-26T00:00:00.000Z' })
	assert.equal(task5(d, 'a').createdAt, '2026-09-25T08:00:00.000Z')
})

test('Given no save contains a task, when upgraded, then it was added now — and given no now, it is left absent', () => {
	const now = '2026-09-26T00:00:00.000Z'
	assert.equal(task5(applyMigrations(v4([t4('a')]), MIGRATIONS, SCHEMA, { now }), 'a').createdAt, now)
	// A read-only view of an archive passes nothing, and gets nothing invented.
	assert.equal(task5(applyMigrations(v4([t4('a')])), 'a').createdAt, undefined)
})

test('Given a save from before durations were days, when compared, then the unit change is not an edit', () => {
	// v3 stored weeks: 1 week is 7 days, so this task's wording never changed.
	const history = [save('2026-09-01T10:00:00.000Z', [t4('a', { dur: 1 })], 3), save('2026-09-02T10:00:00.000Z', [t4('a', { dur: 7 })])]
	const d = applyMigrations(v4([t4('a', { dur: 7 })]), MIGRATIONS, SCHEMA, { history })
	assert.equal(task5(d, 'a').createdAt, '2026-09-01T10:00:00.000Z')
	assert.equal(task5(d, 'a').updatedAt, undefined)
})

// ---- v5 -> v6: the five task times become instants ------------------------
//
// THE FALSIFIER IS A DATE THAT MOVED. Every value must become the instant the
// scheduler already meant by it — so projecting it back gives the same number —
// or somebody's recorded work is silently shifted by the upgrade.
const v5 = (tasks: any[], over: any = {}) => plain({ schemaVersion: 5, start: '2026-09-19', tasks, ...over })
const t5 = (id: string, over: Record<string, unknown> = {}) =>
	({ id, label: id, dur: 1, deps: [], createdAt: '2026-09-19T12:00:00.000Z', ...over })

test('Given day numbers, when a v5 plan is upgraded, then each becomes the instant the scheduler meant', () => {
	const d = applyMigrations(v5([
		t5('whole', { actualStart: 7, actualEnd: 8 }),              // "all of Sep 26"
		t5('timed', { actualStart: 7.151388888888889, actualEnd: 7.152083333333333 }),
		t5('early', { notBefore: -2, due: 20, refinedAt: 1.5 }),    // negative is legal
	]), MIGRATIONS, 6)   // to v6, where the actuals still were; v8 turns them into sessions
	assert.equal(d.schemaVersion, 6)
	assert.equal(d.timeZone, 'America/Chicago', 'every pre-v6 plan was written in Central time')
	const t = (id: string): any => d.tasks.find((x: any) => x.id === id)
	// A whole-day end is local midnight STARTING the next day — the same instant.
	assert.deepEqual([t('whole').actualStart, t('whole').actualEnd],
		['2026-09-26T05:00:00.000Z', '2026-09-27T05:00:00.000Z'])
	assert.equal(t('timed').actualStart, '2026-09-26T08:38:00.000Z', '3:38am Central')
	assert.equal(t('early').notBefore, '2026-09-17T05:00:00.000Z')
	for (const [id, k, n] of [['timed', 'actualEnd', 7.152083333333333], ['early', 'refinedAt', 1.5], ['early', 'due', 20]] as const)
		assert.ok(Math.abs(dayOfInstant(t(id)[k], d) - n) < 1e-9, `${id}.${k} round-trips`)
})

test('Given a day across the end of daylight time, when it is upgraded, then noon is still noon', () => {
	// Nov 1 2026 is 25 hours long in Chicago. Noon is 18:00Z after the change,
	// 17:00Z before it; a conversion that added 12h to midnight would be an hour out.
	const d: any = applyMigrations(v5([t5("a", { actualStart: 7, actualEnd: 7.5 })], { start: "2026-10-25" }), MIGRATIONS, 6)
	assert.deepEqual([d.tasks[0].actualStart, d.tasks[0].actualEnd], ['2026-11-01T05:00:00.000Z', '2026-11-01T18:00:00.000Z'])
})

test('Given a plan that already names its zone, when it is upgraded, then that zone is used', () => {
	const d: any = applyMigrations(v5([t5("a", { actualStart: 7, actualEnd: 7.5 })], { timeZone: "Asia/Tokyo" }), MIGRATIONS, 6)
	assert.equal(d.tasks[0].actualStart, '2026-09-25T15:00:00.000Z')
})

test('Given the process in another zone, when a plan is upgraded, then the instants are identical', () => {
	// THE RUNG MAY NOT ASK THE PROCESS WHERE IT IS: the page migrates history
	// with the browser's zone and the server with the container's, and both
	// must produce the same document.
	const lib = fileURLToPath(new URL('../../shared/schedule.js', import.meta.url))
	const doc = v5([t5('a', { actualStart: 7.151388888888889, actualEnd: 8, due: 9.25 })])
	const script = `import(${JSON.stringify(lib)}).then(S => process.stdout.write(JSON.stringify(S.applyMigrations(${JSON.stringify(doc)}))))`
	const run = (TZ: string) => spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ } }).stdout.toString()
	const here = JSON.stringify(applyMigrations(structuredClone(doc)))
	assert.equal(run('Asia/Tokyo'), here)
	assert.equal(run('UTC'), here)
})

// ---- v6 -> v7: dur becomes whole minutes ------------------------------------
test('Given durations in days, when a v6 plan is upgraded, then exact ones convert and decimal guesses round to five', () => {
	const d: any = applyMigrations(plain({ schemaVersion: 6, timeZone: 'America/Chicago', tasks: [
		{ id: 'day', dur: 1 }, { id: 'hour', dur: 1 / 24 }, { id: 'quarter', dur: 0.010416666666666666 },
		{ id: 'odd', dur: 0.03 }, { id: 'odd2', dur: 0.02 }, { id: 'tiny', dur: 0.001 }, { id: 'zero', dur: 0 },
	] } as any))
	const by = Object.fromEntries(d.tasks.map((t: any) => [t.id, t.dur]))
	// A day is 1440 — the scheduler's day is 24 hours of lane time.
	assert.deepEqual([by.day, by.hour, by.quarter], [1440, 60, 15], 'exact values are exact')
	// 0.03 days is 43.2 minutes nobody meant: nearest five, not nearest minute.
	assert.deepEqual([by.odd, by.odd2], [45, 30])
	assert.equal(by.tiny, 5, 'never rounded to zero, which is not a duration')
	assert.equal(by.zero, 0, 'a legacy zero is left for invalid() to judge, not invented into five')
})
