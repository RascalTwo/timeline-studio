// THE EVENT LOOP MUST STAY FREE WHILE A REORDER RUNS.
//
// `cost.test.ts` asks how LONG the search takes. This asks who is blocked while it
// does, which is the property that actually took the service down: on 2026-09-04
// ECS replaced this task six times in an afternoon because a 90-second synchronous
// search on the live 135-task plan meant `/health` went unanswered past its 5s
// timeout and two strikes. Every test was green, because every test measured the
// answer rather than the blocking.
//
// SO THIS MEASURES EVENT-LOOP LAG, not duration. A timer asked to fire every 20ms
// is late by exactly as long as the loop was busy, so the worst lateness over the
// life of a reorder IS how long the health check would have waited.
//
// WHAT A LAPTOP FLATTERS. This machine has cores to spare, so the worker runs
// genuinely in parallel and the lag is near zero. The deployed task has a quarter
// of one, where the two threads share a throttled slice and the honest expectation
// is contention — the server gets slower, not silent. That is still the whole
// point: a slow answer is something a caller can wait for, and a silent one gets
// the container killed. This test proves the work LEFT the main thread; it does
// not predict the number it will cost on 0.25 vCPU.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { laneOrder, suggestReorders } from '../src/scheduler'
import { runReorder } from '../src/reorder-pool'

/** The shape that broke: nine lanes, promotion chains between them, and enough
 *  dependencies that queue order matters. Same generator as cost.test.ts. */
function bigPlan(nTasks = 140) {
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
		const deps: string[] = []
		if (i >= 3) deps.push('t' + (i - 3))
		if (i >= 12 && i % 4 === 0) deps.push('t' + (i - 12))
		tasks.push({
			id: 't' + i, label: 'Task ' + i, lane: lanes[i % lanes.length]!.id,
			color: [], border: borders[i % 4]!.id, fill: 'f1', shape: 's1',
			dur: 1 + (i % 9), deps, ms: i % 2 ? 'm1' : 'm2',
		})
	}
	return {
		schemaVersion: 4, title: 'lag fixture', start: '2026-01-05',
		lanes, borders, colors: [], fills: [{ id: 'f1', label: 'known', pattern: 'solid' }],
		shapes: [{ id: 's1', label: 'none', shape: 'soft' }],
		defaults: { borders: 'b1', shapes: 's1', fills: 'f1' },
		milestones: [{ id: 'm1', label: 'Ship', date: '2026-06-01' },
			{ id: 'm2', label: 'Later', date: '2026-09-01' }],
		workweek: [0, 1, 1, 1, 1, 1, 0], holidays: [], tasks,
	}
}

/** Worst lateness of a 20ms heartbeat while `work` runs. */
async function worstLag(work: () => Promise<unknown> | unknown) {
	let worst = 0, last = performance.now()
	const beat = setInterval(() => {
		const now = performance.now()
		worst = Math.max(worst, now - last - 20)
		last = now
	}, 20)
	// Let the interval settle before the work starts, so the first tick's own
	// scheduling jitter is not counted as lag.
	await new Promise(r => setTimeout(r, 60))
	last = performance.now()
	await work()
	// THE LAST GAP IS MEASURED DIRECTLY, not waited for. If the work is
	// SYNCHRONOUS the interval cannot fire while it runs, and clearing straight
	// afterwards means the one late tick never happens — so the first version of
	// this helper reported near-zero lag for a 1.4s block, which is the exact
	// opposite of the truth. The elapsed time since the last tick IS the blockage,
	// whether or not a callback got to observe it.
	worst = Math.max(worst, performance.now() - last - 20)
	clearInterval(beat)
	return worst
}

test('a reorder does not block the thread that answers /health', async () => {
	const doc = bigPlan()
	const lag = await worstLag(() => runReorder(doc, { limit: 8 }))
	// The ALB gives /health 5s and two strikes. A budget an order of magnitude
	// under that is "the loop kept running", not "we squeaked in".
	assert.ok(lag < 500,
		`the event loop was blocked for ${lag.toFixed(0)}ms during a reorder (budget 500ms). ` +
		`This ran inline until 2026-09-06 and blocked it for the whole search — see ` +
		`the header of src/reorder-pool.ts.`)
})

// THE CONTROL, and the reason the check above is not vacuous. Running the same
// search inline on the same fixture must blow the same budget — otherwise the
// test is only reporting that the fixture is small.
test('the same search inline DOES block it, which is what was fixed', async () => {
	const doc = bigPlan()
	const lag = await worstLag(() => { suggestReorders(doc, { limit: 8 }) })
	assert.ok(lag > 500,
		`running suggestReorders inline blocked the loop for only ${lag.toFixed(0)}ms, ` +
		`under the 500ms this fixture is supposed to exceed. Either the machine got much ` +
		`faster or the fixture stopped being representative — in both cases the test above ` +
		`has stopped proving anything and the fixture needs to grow.`)
})

test('and it returns the same answer as calling it directly', async () => {
	const doc = bigPlan(70)
	const viaWorker = await runReorder(doc, { limit: 8 }) as any
	const inline = suggestReorders(doc, { limit: 8 }) as any
	const inlineLanes = laneOrder(doc)
	assert.deepEqual(viaWorker.suggestions, inline.suggestions,
		'the worker and the direct call disagree — moving the call must not change it')
	// `laneOrder` answers with `{order, backward, total, was, changed}`, not a bare
	// array — the across-lane half of the same question, plus what it cost.
	assert.deepEqual(viaWorker.lanes, inlineLanes,
		'the across-lane answer must survive the thread hop too')
})
