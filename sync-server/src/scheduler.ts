// THE SAME SCHEDULER THE PAGE RUNS, not a copy of it — literally the same file,
// since `schedule.js` lives in `shared/` beside the protocol.
//
// The original tool's `api.ts` went out of its way to guarantee this on one
// machine: it imported the scheduler per call with a cache bust, because a static
// specifier resolved to a module Bun had already cached, so editing the scheduler
// updated the page and left the backend running the old one — "the failure mode
// is the backend and the chart quietly disagreeing about a date, which is
// precisely what the chart exists to prevent."
//
// THAT TRICK IS NOT PORTED, AND MUST NOT BE. It solved a dev-server staleness
// problem that does not exist here: this process starts, imports once, and is
// replaced by a new container to change anything. Re-importing per call would
// re-parse 700 lines on every `/verdict` for no benefit.
//
// The hosted shape of the same worry — one file in the repo, two artifacts in
// production — is answered by `shared-hash.ts` and `/health`, for this file and
// every other shared one alike.

import { readiness as _readiness, verdict as _verdict, laneOrder as _laneOrder, suggestReorders as _suggestReorders } from '../../shared/schedule.js'

/** What the plan lands on. Throws on a dependency cycle rather than returning a
 *  wrong answer — behaviour worth preserving across the wire, so callers get a
 *  400 carrying the scheduler's own message. */
export const verdict = _verdict as (doc: unknown) => unknown
export const readiness = _readiness as (doc: unknown) => unknown

/** `/api/ready`: the queue, not the whole plan. Only not-started tasks, best rank first
 *  (unranked last, ties keep plan order); each keeps `ready` and `waitingOn`, so "free
 *  except for the lane" stays visible. `all` is the old answer: every task with its status. */
export function readyRows(doc: unknown, all: boolean) {
	const rows = _readiness(doc as never)
	return all ? rows : rows.filter((r) => r.status === 'todo').sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
}

/** Which row to move within a lane. Suggests; never applies. Each entry is
 *  measured against the current order, so applying one invalidates the rest. */
export const suggestReorders = _suggestReorders as (
	doc: unknown,
	opts?: { limit?: number; maxLane?: number }
) => unknown

/** Which team goes on top — the across-lane half of the same question. */
export const laneOrder = _laneOrder as (doc: unknown) => unknown
