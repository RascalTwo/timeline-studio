// ONE WORKING CALENDAR: `doc.hours` (schema v10, ADR 0021) replaced `workweek`, `holidays` and `workHours`. The
// migration must move no scheduled date, and the calendar must read windows per weekday, several per day, and
// per-date overrides. Day numbers throughout like working-hours.test.ts: day 0 is the plan's start, a Monday, and
// the fraction is the plan zone's wall clock.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyCommand, validateCommand } from '../../shared/commands.js'
import { applyMigrations, calOf, dayNumbers, endOf, offHours, orderSignature, sched, snapFwd, workDaysIn } from '../../shared/schedule.js'
import { hoursOf } from './hours-fixture.js'

const H = 1 / 24
const near = (a: number, b: number, what = '') => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} ≉ ${b}`)
const task = (id: string, over: any = {}): any => ({ id, lane: 'me', dur: 1, deps: [], ...over })
const doc = (over: any = {}): any => ({ start: '2026-09-21', lanes: [{ id: 'me', label: 'Me', cap: 1 }], tasks: [], ...over })
/** One task of `dur` days of work, forecast from day `from` on the calendar `hours` describes. */
const one = (hours: any, dur: number, from = 0) => {
	const d = doc({ hours, tasks: [task('t', { dur })] }), cal = calOf(d)
	const s = snapFwd(from, cal)
	return { s, e: endOf(d.tasks[0], s, cal), cal }
}
const clock = (cal: any, d: number) => cal.win(d).map(([a, b]: number[]) => [Math.round(a! * 24), Math.round(b! * 24)])

// ---- THE MIGRATION KEEPS EVERY DATE -----------------------------------------------------------------------------
// The expected [start, end] pairs below are what the PRE-v10 scheduler produced for the same v9 documents (run once
// against the previous commit's `calOf`/`spanOf`), so this pins "no date moved" rather than the new code agreeing
// with itself.
const v9 = (over: any): any => {
	const t = (id: string, o: any = {}) => ({ id, label: id, lane: 'me', border: 'b', fill: 'f', shape: 's', color: [], dur: 60, deps: [], createdAt: '2026-09-01T00:00:00.000Z', ...o })
	return { schemaVersion: 9, title: 't', start: '2026-09-21', timeZone: 'UTC',
		lanes: [{ id: 'me', label: 'Me', cap: 1 }, { id: 'you', label: 'You', cap: 2 }],
		borders: [{ id: 'b', label: 'b', style: 'solid' }], fills: [{ id: 'f', label: 'f', pattern: 'solid' }],
		shapes: [{ id: 's', label: 's', shape: 'soft' }], colors: [], milestones: [],
		tasks: [t('a', { dur: 1200 }), t('b', { dur: 1200, deps: ['a'] }), t('c', { lane: 'you', dur: 300, notBefore: '2026-09-26T12:00:00.000Z' }),
			t('d', { dur: 45 }), t('e', { dur: 3000, lane: 'you' }), t('f', { dur: 90, deps: ['e'], lane: 'you' })],
		...over }
}
const datesOf = (raw: any) => {
	const d = dayNumbers(applyMigrations(structuredClone(raw))), cal = calOf(d), st = sched(d.tasks, d.lanes!, cal)
	return Object.fromEntries(d.tasks.map((t: any) => [t.id, [st[t.id]!, endOf(t, st[t.id]!, cal)]]))
}
const allOn = { a: [0, 0.8333333333333334], b: [0.8333333333333334, 1.6666666666666667], c: [5.5, 5.708333333333333], d: [1.6666666666666667, 1.6979166666666667], e: [0, 2.0833333333333335], f: [2.0833333333333335, 2.1458333333333335] }
const expectDates = (raw: any, want: Record<string, number[]>) => {
	const got = datesOf(raw)
	for (const id of Object.keys(want)) { near(got[id]![0]!, want[id]![0]!, id + ' start'); near(got[id]![1]!, want[id]![1]!, id + ' end') }
}

test('migration (a): none of the three fields means no hours, and the dates are the all-on ones', () => {
	const out: any = applyMigrations(v9({}))
	assert.equal(out.schemaVersion, 10)
	assert.equal('hours' in out, false)
	expectDates(v9({}), allOn)
})

test('migration (b): workHours alone becomes the same window on every weekday', () => {
	const raw = v9({ workHours: ['08:00', '17:00'] }), out: any = applyMigrations(structuredClone(raw))
	for (const k of ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) assert.deepEqual(out.hours.week[k], [['08:00', '17:00']], k)
	assert.deepEqual(out.hours.dates, {})
	for (const k of ['workweek', 'holidays', 'workHours']) assert.equal(k in out, false, k)
	expectDates(raw, {
		a: [0.3333333333333333, 2.4166666666666665], b: [2.4166666666666665, 4.499999999999999], c: [5.5, 5.708333333333333],
		d: [4.499999999999999, 4.531249999999999], e: [0.3333333333333333, 5.541666666666666], f: [5.541666666666666, 5.604166666666666],
	})
})

test('migration (c): workweek + holidays + workHours keep the mask, the days off and the window', () => {
	const raw = v9({ workweek: [0, 1, 1, 1, 1, 1, 0], holidays: ['2026-09-24', '2026-10-02'], workHours: ['09:00', '17:30'] })
	const out: any = applyMigrations(structuredClone(raw))
	assert.deepEqual(out.hours.week.sun, []); assert.deepEqual(out.hours.week.sat, [])
	assert.deepEqual(out.hours.week.wed, [['09:00', '17:30']])
	assert.deepEqual(out.hours.dates, { '2026-09-24': [], '2026-10-02': [] })
	expectDates(raw, {
		a: [0.375, 2.5], b: [2.5, 7.625], c: [7.375, 7.583333333333333], d: [7.625, 7.65625],
		e: [0.375, 8.6875], f: [8.6875, 9.395833333333334],
	})
	// no window given: the whole day on the allowed weekdays
	const bare: any = applyMigrations(v9({ workweek: [1, 0, 0, 0, 0, 0, 0], holidays: [] }))
	assert.deepEqual(bare.hours.week.sun, [['00:00', '24:00']]); assert.deepEqual(bare.hours.week.mon, [])
})

test('migration (d): a mask with no working day was the all-on calendar, holidays and window ignored', () => {
	const raw = v9({ workweek: [0, 0, 0, 0, 0, 0, 0], holidays: ['2026-09-24'], workHours: ['08:00', '17:00'] })
	const out: any = applyMigrations(structuredClone(raw))
	assert.equal('hours' in out, false)
	for (const k of ['workweek', 'holidays', 'workHours']) assert.equal(k in out, false, k)
	expectDates(raw, allOn)
})

test('migration: holidays alone and a Sunday-only week with a window keep their dates too', () => {
	expectDates(v9({ holidays: ['2026-09-22', '2026-09-23'] }), {
		a: [0, 0.8333333333333334], b: [0.8333333333333334, 3.666666666666667], d: [3.666666666666667, 3.697916666666667],
		e: [0, 4.083333333333334], f: [4.083333333333334, 4.145833333333334],
	})
	expectDates(v9({ workweek: [1, 0, 0, 0, 0, 0, 0], workHours: ['06:00', '24:00'] }), {
		a: [6.25, 13.333333333333334], b: [13.333333333333334, 20.416666666666668], c: [6.25, 6.458333333333333],
		e: [6.25, 20.833333333333332], f: [20.833333333333332, 20.895833333333332],
	})
})

// ---- THE CALENDAR ---------------------------------------------------------------------------------------------
test('each weekday has its own window; a weekday without one is a day off', () => {
	const hours = { week: { mon: [['07:00', '20:00']], fri: [['07:00', '23:00']], sat: [['08:00', '23:00']] } }
	const cal = calOf(doc({ hours }))
	assert.deepEqual(clock(cal, 0), [[7, 20]])                                          // Monday
	assert.deepEqual(clock(cal, 1), [])                                                 // Tuesday
	assert.equal(cal.isWorking(4), true); assert.equal(cal.isWorking(5), true); assert.equal(cal.isWorking(6), false)
	// 14 hours from Monday 07:00: 13 fit before 20:00, the last hour opens on Friday at 07:00
	const { s, e } = one(hours, 14 * H)
	near(s, 7 * H); near(e, 4 + 8 * H)
})

test('two windows in a day: work spans the gap, and the gap is off hours', () => {
	const hours = { week: { tue: [['07:00', '12:00'], ['13:00', '20:00']] } }
	const { s, e, cal } = one(hours, 6 * H, 1)
	near(s, 1 + 7 * H); near(e, 1 + 14 * H)                                              // 5h before lunch, 1h after
	near(snapFwd(1 + 12.5 * H, cal), 1 + 13 * H)                                         // inside the gap: the next opening
	near(snapFwd(1 + 20 * H, cal), 8 + 7 * H)                                            // after the last window: next Tuesday, the only working day
	assert.deepEqual(offHours(1 + 7 * H, 1 + 14 * H, cal).map(([a, b]) => [Math.round((a - 1) * 24), Math.round((b - 1) * 24)]), [[12, 13]])
	near(workDaysIn(1 + 7 * H, 7 * H, cal), 6 * H)                                       // a span holds exactly its work
})

test('a date override replaces its weekday: hours on a day off, none on a working day', () => {
	const hours = { week: { mon: [['08:00', '17:00']], tue: [['08:00', '17:00']] },
		dates: { '2026-09-26': [['08:00', '21:00']], '2026-09-21': [] } }               // Saturday works; Monday is off
	const cal = calOf(doc({ hours }))
	assert.equal(cal.isWorking(0), false); assert.equal(cal.isWorking(1), true); assert.equal(cal.isWorking(5), true)
	assert.deepEqual(clock(cal, 5), [[8, 21]])
	near(one(hours, 1 * H).s, 1 + 8 * H)                                                 // Monday is off: Tuesday morning
	const sat = one(hours, 1 * H, 5)
	near(sat.s, 5 + 8 * H); near(sat.e, 5 + 9 * H)
})

test('an empty week, or no hours, is every hour of every day; dates still apply', () => {
	for (const hours of [undefined, {}, { week: {} }, { week: { mon: [], tue: [] } }]) {
		const { s, e } = one(hours, 30 * H)
		near(s, 0); near(e, 30 * H)
	}
	const hours = { week: {}, dates: { '2026-09-22': [] } }
	const cal = calOf(doc({ hours }))
	assert.equal(cal.isWorking(1), false); assert.equal(cal.isWorking(2), true)
	near(one(hours, 30 * H).e, 2 + 6 * H)                                                // 24h Monday, Tuesday skipped, 6h Wednesday
})

test('the hours are part of what the reorder search reads', () => {
	assert.notEqual(orderSignature(doc()), orderSignature(doc({ hours: hoursOf(['08:00', '17:00']) })))
})

// ---- patchDoc ------------------------------------------------------------------------------------------------
const patch = (p: any) => validateCommand(doc(), { type: 'patchDoc', patch: p })

test('patchDoc takes hours, or null to clear them', () => {
	for (const good of [
		{ week: { mon: [['07:00', '20:00']], tue: [['07:00', '12:00'], ['13:00', '24:00']], sun: [] }, dates: { '2026-10-04': [['08:00', '21:00']], '2026-12-25': [] } },
		{}, { week: {} }, { dates: {} }, { week: { mon: [['07:00', '12:00'], ['12:00', '13:00']] } }, null,
	]) assert.equal(patch({ hours: good }), null, JSON.stringify(good))
	const d = doc({ hours: hoursOf() })
	applyCommand(d, { type: 'patchDoc', patch: { hours: null } })
	assert.equal('hours' in d, false)
})

test('patchDoc refuses workweek, holidays and workHours and says hours replaced them', () => {
	for (const k of ['workweek', 'holidays', 'workHours'])
		assert.match(String(patch({ [k]: null })), new RegExp(`${k} was replaced by hours in schema v10`), k)
	assert.match(String(patch({ hours: null, workHours: ['08:00', '17:00'] })), /replaced by hours/)
})

test('patchDoc refuses bad windows with a message that names the day', () => {
	const bad = (hours: any, re: RegExp) => assert.match(String(patch({ hours })), re, JSON.stringify(hours))
	bad({ week: { mon: [['08:00', '12:00'], ['11:00', '13:00']] } }, /hours\.week\.mon: windows must ascend and not overlap/)
	bad({ week: { mon: [['13:00', '17:00'], ['08:00', '12:00']] } }, /ascend/)
	bad({ week: { mon: [['22:00', '06:00']] } }, /hours\.week\.mon: a window must start before it ends and may not cross midnight/)
	bad({ week: { mon: [['08:00', '08:00']] } }, /start before it ends/)
	bad({ week: { mon: [['8', '17']] } }, /HH:MM/)
	bad({ week: { mon: [['08:00', '24:30']] } }, /within one day/)
	bad({ week: { mon: [['08:00']] } }, /HH:MM/)
	bad({ week: { mon: ['08:00', '17:00'] } }, /HH:MM/)
	bad({ week: { mon: '08:00-17:00' } }, /list of/)
	bad({ week: { monday: [] } }, /no day "monday"/)
	bad({ dates: { '2026-02-30': [] } }, /real "YYYY-MM-DD"/)
	bad({ dates: { 'Dec 25': [] } }, /real "YYYY-MM-DD"/)
	bad({ dates: { '2026-12-25': [['09:00', '08:00']] } }, /hours\.dates\.2026-12-25/)
	bad({ week: [] }, /hours\.week must be an object/)
	bad({ extra: 1 }, /holds only week and dates/)
	bad('08:00', /hours must be an object/)
})
