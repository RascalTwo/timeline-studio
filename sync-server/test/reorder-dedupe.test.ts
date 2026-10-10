// THE FAST SEARCH GIVES THE OLD SEARCH'S ANSWERS, BYTE FOR BYTE.
//
// `suggestReorders` skips candidate orders that schedule the same as one already
// scored, counts the ranking tie-break incrementally, and reads end dates off the
// schedule instead of re-walking them; `sched` scans only unplaced tasks. None of
// that may change an answer. These digests were recorded from the code BEFORE
// those changes (2026-09-27) over seeded random plans that mix finished,
// in-progress and parallel work, multi-slot and multiple lanes, dependencies,
// deadlines, milestones, working hours and ranking answers.
//
// A digest that stops matching means Auto-order, /api/reorder or the chart now
// decide something differently. If that is the intent, say so in the commit and
// re-record: `SCHEDULE_MODULE=<old schedule.js> npx tsx --test` prints them.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock, test } from 'node:test'
import { applyCommand } from '../../shared/commands.js'

const m = await import(process.env.SCHEDULE_MODULE ?? '../../shared/schedule.js')

let seed = 1
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!
const day = (n: number) => new Date(Date.parse('2026-09-21T00:00:00Z') + n * 864e5).toISOString()

function plan(s: number): any {
	seed = s * 7919 + 1
	const lanes = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => ({ id: 'L' + i, label: 'L' + i, cap: rnd() < 0.3 ? 2 : 1 }))
	const n = 4 + Math.floor(rnd() * 22)
	const ms = rnd() < 0.5 ? [{ id: 'm1', label: 'm1', date: '2026-10-05' }, { id: 'm2', label: 'm2', date: '2026-10-20' }] : []
	const tasks: any[] = []
	for (let i = 0; i < n; i++) {
		const t: any = { id: 't' + i, label: 't' + i, lane: pick(lanes).id, border: 'b', fill: 'f', shape: 's', color: [], deps: [],
		                 dur: pick([30, 60, 120, 240, 480, 1440, 2880]), createdAt: day(-10 - i) }
		if (i > 0 && rnd() < 0.3) t.deps.push('t' + Math.floor(rnd() * i))
		if (i > 1 && rnd() < 0.15) t.deps.push('t' + Math.floor(rnd() * i))
		t.deps = [...new Set(t.deps)]
		const r = rnd()
		// v7 actuals, upgraded on the way in like any stored plan
		if (r < 0.35) { t.actualStart = day(-5 + rnd() * 4); t.actualEnd = new Date(Date.parse(t.actualStart) + (1 + rnd() * 48) * 36e5).toISOString() }
		else if (r < 0.45) { t.actualStart = day(-2 + rnd()); t.sessions = [{ start: t.actualStart, stop: null }] }   // as every v7 start had
		if (rnd() < 0.15) t.noQueue = true
		if (rnd() < 0.35) t.due = day(1 + rnd() * 20)
		if (rnd() < 0.15) t.notBefore = day(rnd() * 10)
		if (ms.length && rnd() < 0.6) t.ms = pick(ms).id
		tasks.push(t)
	}
	const doc: any = { schemaVersion: 7, title: 'p' + s, start: '2026-09-21', timeZone: 'America/Chicago',
		lanes, borders: [{ id: 'b', label: 'b', style: 'solid' }], fills: [{ id: 'f', label: 'f', pattern: 'solid' }],
		shapes: [{ id: 's', label: 's', shape: 'soft' }], colors: [], milestones: ms, tasks }
	if (rnd() < 0.5) doc.workHours = ['08:00', '17:00']
	if (rnd() < 0.4) doc.workweek = [0, 1, 1, 1, 1, 1, 0]
	if (rnd() < 0.3) doc.dueBuffer = 1
	const open = tasks.filter(t => !t.actualEnd)
	for (let k = 0; k < open.length && rnd() < 0.7; k++) {
		const a = pick(open), b = pick(open)
		if (a.id === b.id) continue
		try { applyCommand(doc, { type: 'addRankAnswer', a: a.id, b: b.id, verdict: pick([-1, 1, 0]) } as any) } catch {}
	}
	return doc
}

// THE CLOCK IS PINNED. The scheduler floors forecasts at today and caps recorded
// work at now, and the search reads both itself, so a live clock would make every
// digest a function of the day the suite ran.
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-23T15:30:00Z') })
const digest = (f: (doc: any) => unknown) => {
	const h = createHash('sha256')
	for (let s = 1; s <= 250; s++) {
		let out: unknown
		try { out = f(plan(s)) } catch (e) { out = { error: (e as Error).message } }
		h.update(JSON.stringify(out) + '\n')
	}
	return h.digest('hex').slice(0, 16)
}
const schedOf = (raw: any) => {
	const d = m.dayNumbers(m.applyMigrations(structuredClone(raw)))
	const st = m.sched(d.tasks, d.lanes, m.calOf(d), m.todayOf(d), m.nowOf(d))
	return [{ ...st }, st.why, st.whyGap, st.whyWho]
}
const OPTS = [{}, { limit: 1, maxLane: Infinity }, { limit: Infinity, maxLane: Infinity }]
// Re-recorded 2026-09-27 for the reorder digests only, on purpose: the search
// now forecasts from NOW rather than midnight (FORECASTS START NOW in
// schedule.ts). `sched` is called with an explicit floor here and did not move.
// Re-recorded 2026-10-04 when sessions became the only record of work (v8): the plans now give every started
// task the running session every real v7 start had, and these were printed by the v7 code (no migration) and by
// the v8 code (upgrading on the way in) — identical, so the upgrade moves no schedule and no suggestion.
// Re-recorded 2026-10-04 for the reorder digests only, on purpose: the search moves only rows that queue (ONLY A ROW
// THAT QUEUES in schedule.ts). Over these 250 plans against the code before: 188 identical, 53 the same moves (row,
// gains) landing beside another row for the same schedule, 9 short only ranking moves that a row which does not queue
// is in. No date move was lost.
const EXPECTED = { sched: 'b8df67db139b90f5', reorder0: 'e178066c51b1c9fe', reorder1: '243a118249f4a7b1', reorder2: 'e178066c51b1c9fe' }
const actual = {
	sched: digest(schedOf),
	...Object.fromEntries(OPTS.map((o, i) => [`reorder${i}`, digest(doc => m.suggestReorders(doc, o))])),
}
mock.timers.reset()

if (process.env.SCHEDULE_MODULE) console.log(JSON.stringify(actual))

test('Given seeded random plans, when scheduled and searched, then every answer matches the pre-optimisation code', () => {
	assert.deepEqual(actual, EXPECTED)
})
