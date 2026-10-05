// WHAT IT COSTS, not just what it answers.
//
// Every other test in this directory asks whether a number is right. None of
// them asks whether it arrives, and on 2026-09-05 that gap cost a production
// incident with all 100 checks green:
//
//   /api/reorder?limit=8 on the live 135-task plan returned a 504 after NINETY
//   SECONDS. `suggestReorders` is synchronous and the task is a single 0.25 vCPU
//   Fargate container, so for that whole time the event loop served nothing —
//   including the ALB's /health, which has a 5s timeout and two strikes. ECS
//   marked the target unhealthy and replaced the task. Six times, on 09-04,
//   before anybody understood why. Measured that day: /api/verdict answers in
//   0.2s idle, times out at 60s alongside a reorder, and returns to 0.2s the
//   instant the reorder finishes.
//
// So on this server LATENCY IS A CORRECTNESS PROPERTY. A function that is right
// and slow does not degrade the feature that calls it; it kills the container
// and takes every other plan in the room down with it.
//
// WHY THE EXISTING TESTS COULD NOT HAVE CAUGHT IT. `suggestReorders` is well
// covered — the shape it finds, its silence on an ordered plan, milestone-only
// wins, the guard. Every one of those fixtures is six lanes and a handful of
// tasks. The search is superlinear in lane length, so at fixture scale it is
// instant and at production scale it is a minute and a half. The bug was never
// in the answer. It was only ever in the size.
//
// HOW TO READ A FAILURE HERE, AND WHAT THIS FILE DOES NOT PROVE.
//
// These are REGRESSION guards, not a proof of production safety, and the
// difference is measurable rather than theoretical. This fixture's 135 tasks run
// `suggestReorders` in ~1.4s on a laptop. The real 135-task plan took OVER 90s
// on the deployed task. That gap is partly the 0.25 vCPU container and partly
// this fixture being kinder than a real plan — the live one carries 28 promotion
// dependencies and dense cross-lane chains that this one does not model. So a
// green run here does NOT mean the endpoint is safe in production; it means the
// algorithm has not got worse since this was written.
//
// WHERE THIS STANDS, measured in production on the live 135-task plan, 2026-09-07:
//
//     before   /api/reorder  90,170ms  ->  504 at the gateway
//     after    /api/reorder  23,047ms  ->  200, 8 suggestions
//
// 3.9x, and the difference between a feature that does not work and one that does.
// It came from three EXACT changes inside `sched` — a counter instead of
// `Object.keys(start).length`, memoising the end of a placed task, and an inner
// loop that stops allocating — which together took the calendar work on that plan
// from 20,292 `isWorking` calls per schedule to 3,131.
//
// IT IS STILL SLOW, and the shape is unchanged: Sigma(lane^2) full schedules, which
// on that plan is 2,932 of them. 23 seconds is inside the gateway's patience and
// nowhere near the page's LOCAL_BUDGET, so the browser still hands this to the
// server — correctly, because 23 seconds is not something to block a keystroke
// for. Closing that gap needs fewer SCHEDULES, not faster ones, and the budgets
// below are what would notice if the cost crept back.
//
// THE STARVATION ITSELF IS FIXED, SEPARATELY FROM THE COST. `/api/reorder` runs
// on a worker thread since 2026-09-07 (`src/reorder-pool.ts`), so a long search no
// longer owns the only thread — measured on this fixture, the same 1.4s of work
// blocks the event loop for 3ms instead of 1388ms. That does NOT make the numbers
// below less important: the search is still roughly cubic, the container still has
// a quarter of a core, and two threads sharing it is contention rather than
// parallelism. What changed is the failure mode — the server gets slower instead
// of getting killed.
//
// `scripts/smoke.sh` is the post-deploy half, and it is honest about being only
// half. It runs against what is actually serving and holds `/api/health` to a
// latency ceiling, so a server already struggling fails the deploy. It does NOT
// generate scheduler load, so it does not REPRODUCE the starvation — that needs an
// authenticated call, and every way of getting a token into CI is refused on
// purpose (see its header). Until the search itself is cheaper, the pair is:
// this file says the algorithm has not got worse, smoke.sh says the deployed
// server is answering quickly, and neither says the two cannot still collide.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { suggestReorders, laneOrder, sched, calOf, verdict } from '../../shared/schedule.js'

/** A plan at PRODUCTION scale, shaped like the real one that broke: nine lanes,
 *  three environments, promotion chains between them. 135 tasks is what the live
 *  plan held on the day of the incident. */
function bigPlan(nTasks = 135) {
	const lanes = ['SRV', 'DB', 'CAB', 'NET', 'QA', 'DEV', 'IAM', 'MBR', 'IAMOPS']
		.map((id, i) => ({ id, label: id, cap: i % 3 === 0 ? 2 : 1 }))
	const borders = [
		{ id: 'b1', label: 'none', style: 'none' },
		{ id: 'dev', label: 'dev', style: 'dotted' },
		{ id: 'QA', label: 'QA', style: 'dashed' },
		{ id: 'prod', label: 'prod', style: 'solid' },
	]
	const tasks = []
	for (let i = 0; i < nTasks; i++) {
		// Every third task waits on the one two behind it, which is what makes the
		// queue order matter — a plan with no dependencies has nothing to reorder.
		const deps: string[] = []
		if (i >= 3) deps.push('t' + (i - 3))
		if (i >= 12 && i % 4 === 0) deps.push('t' + (i - 12))
		tasks.push({
			id: 't' + i,
			label: 'Task ' + i,
			lane: lanes[i % lanes.length]!.id,
			color: [], border: borders[i % 4]!.id, fill: 'f1', shape: 's1',
			dur: 1 + (i % 9), deps,
			ms: i % 2 ? 'm1' : 'm2',
		})
	}
	return {
		schemaVersion: 4, title: 'cost fixture', start: '2026-01-05',
		lanes, borders, colors: [], fills: [{ id: 'f1', label: 'known', pattern: 'solid' }],
		shapes: [{ id: 's1', label: 'none', shape: 'soft' }],
		defaults: { borders: 'b1', shapes: 's1', fills: 'f1' },
		milestones: [{ id: 'm1', label: 'Ship', date: '2026-06-01' },
			{ id: 'm2', label: 'Later', date: '2026-09-01' }],
		workweek: [0, 1, 1, 1, 1, 1, 0], holidays: [],
		tasks,
	}
}

const ms = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t }

/** Worst observed of N runs, so one unlucky GC pause cannot fail the suite and
 *  one lucky run cannot pass a regression. */
function worstOf(n: number, fn: () => unknown) {
	let worst = 0
	for (let i = 0; i < n; i++) worst = Math.max(worst, ms(fn))
	return worst
}

// THE ONE THAT WOULD HAVE CAUGHT IT — as a regression, not as a safety proof.
// Measured at ~1.4s here when written, so 5s is roughly 3.5x headroom for slower
// CI hardware. It is NOT the health check's 5s: see the note above on why laptop
// milliseconds do not convert into container milliseconds.
test('suggestReorders stays inside its budget on a 135-task plan', () => {
	const d = bigPlan()
	const took = worstOf(3, () => suggestReorders(d, { limit: 8 }))
	assert.ok(took < 5000,
		`suggestReorders took ${took.toFixed(0)}ms on 135 tasks (budget 5000ms). ` +
		`This runs synchronously on a 0.25 vCPU task and shares its thread with the ` +
		`ALB health check — see the header of this file.`)
})

test('the scheduler itself stays cheap at production scale', () => {
	const d = bigPlan()
	const cal = calOf(d)
	const took = worstOf(5, () => sched(d.tasks, d.lanes, cal))
	assert.ok(took < 1000, `sched took ${took.toFixed(0)}ms on 135 tasks (budget 1000ms)`)
})

test('verdict stays cheap at production scale', () => {
	const d = bigPlan()
	const took = worstOf(3, () => verdict(d))
	assert.ok(took < 2000, `verdict took ${took.toFixed(0)}ms on 135 tasks (budget 2000ms)`)
})

test('laneOrder stays cheap at production scale', () => {
	const d = bigPlan()
	const took = worstOf(3, () => laneOrder(d))
	assert.ok(took < 2000, `laneOrder took ${took.toFixed(0)}ms on 135 tasks (budget 2000ms)`)
})

// GROWTH, not just a snapshot — and the number this locks in is BAD ON PURPOSE.
//
// Measured when written: doubling the plan (70 -> 140 tasks) multiplied reorder
// cost by 14.6x (98ms -> 1431ms). Quadratic would be 4x. So the search is roughly
// CUBIC, and that — not the container size alone — is why a 135-task plan stalls
// the server for a minute and a half while a 40-task fixture is instant.
//
// This test therefore asserts "no worse than it already is", NOT "good". The
// budget is deliberately set just above observed behaviour so that any further
// steepening fails immediately. If somebody makes the search genuinely cheaper,
// TIGHTEN THIS NUMBER — leaving slack it has earned is how a budget stops
// meaning anything.
test('reorder cost does not grow steeper than it already does', () => {
	const small = worstOf(3, () => suggestReorders(bigPlan(70), { limit: 8 }))
	const big = worstOf(3, () => suggestReorders(bigPlan(140), { limit: 8 }))
	const floor = 2 // ms — below this the ratio is noise, not signal
	if (small < floor) return
	const ratio = big / small
	assert.ok(ratio < 20,
		`doubling the plan multiplied reorder cost by ${ratio.toFixed(1)}x ` +
		`(${small.toFixed(0)}ms -> ${big.toFixed(0)}ms). Budget is 20x, and the ` +
		`14.6x measured when this was written is ALREADY the cause of a production ` +
		`incident — see the header. Steeper than that is a hard regression.`)
})
