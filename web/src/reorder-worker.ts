/// <reference lib="webworker" />
// THE QUEUE-ORDER SEARCH, ON THE VIEWER'S OWN MACHINE AND OFF ITS MAIN THREAD.
//
// `suggestReorders` runs Σ(lane²) FULL SCHEDULES of the whole plan — 2,932 of
// them on the real 135-task plan. That is not going to get cheap; what changed is
// where it runs. Measured on the same plan through this same `/schedule.js`:
//
//     the server   23s   (Fargate, Cpu: '256' — a quarter of one core)
//     a laptop    1.8s
//
// The server is not slow because the code is slow. It is slow because it is the
// smallest container AWS sells, and the machine the plan is being read on is
// sitting idle with twelve cores. Measured across emulated devices, the browser
// keeps winning until the client is about THIRTEEN TIMES slower than a current
// laptop — worse than any current laptop and most phones — so the server route
// stays as the fallback rather than the default.
//
// WHY A WORKER AND NOT JUST CALLING IT. 1.8s on the main thread is 1.8s of frozen
// page, which is worse than a slow answer. Here it is 1.8s of a thread nobody is
// looking at. That is the entire reason this file exists — the search is
// unchanged, and deliberately so.
//
// IT IMPORTS `/schedule.js` RATHER THAN BUNDLING IT, and that is load-bearing
// rather than incidental. `web/vite.config.ts` marks the shared files external
// for the worker build exactly as it does for the page: if Rollup inlined a copy
// here, the browser would run transformed bytes while `assert-shared-parity.sh`
// went on comparing the two files it knows about and reporting green about a file
// nobody loads. ADR 0001 is that gate, and a worker is not an exception to it.
import { suggestReorders, laneOrder } from "./schedule.js";

export interface ReorderRequest {
	id: number;
	doc: unknown;
	limit: number;
	/** How long a lane may be before the search declines to look at it.
	 *  `suggestReorders` defaults it to 40; the page sends `Infinity`, because
	 *  off the main thread the honest guard is the caller's timeout and not a
	 *  constant. See the note at `localReorder`'s call site. */
	maxLane?: number;
}

addEventListener("message", (e: MessageEvent<ReorderRequest>) => {
	const { id, doc, limit, maxLane } = e.data;
	try {
		// BOTH AXES IN ONE ANSWER, matching the shape `/api/reorder` returns, so the
		// page's two routes are interchangeable at the call site and the fallback
		// needs no second reader.
		const d = doc as never;
		postMessage({ id, ok: true, out: { ...suggestReorders(d, { limit, maxLane }), lanes: laneOrder(d) } });
	} catch (err) {
		// A CYCLE IS A NORMAL ANSWER HERE, not a crash. `sched()` throws on one, and
		// a plan can hold one while somebody is midway through fixing it — the page
		// already says so through `schedulerDown`, so this only has to not take the
		// thread down with it.
		postMessage({ id, ok: false, error: (err as Error)?.message || String(err) });
	}
});
