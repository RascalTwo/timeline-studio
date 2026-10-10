// WHY `/api/reorder` DOES NOT RUN ON THE EVENT LOOP.
//
// On 2026-09-04 this service was replaced by ECS six times in an afternoon with
// every test green. `suggestReorders` is synchronous and the task is a single
// 0.25 vCPU container, so a search on the live 135-task plan owned the only
// thread for NINETY SECONDS — and for that whole time the process served nothing,
// including the ALB's `/health`, which has a 5s timeout and two strikes. Measured
// that day: `/api/verdict` answers in 0.2s idle, times out at 60s alongside a
// reorder, and returns to 0.2s the instant the reorder finishes.
//
// WHAT THIS FIXES AND WHAT IT DOES NOT. It does not make the search faster; the
// cost is still roughly cubic in lane length and `sync-server/test/cost.test.ts`
// still guards that. What it changes is who pays: the work moves to a worker
// thread, so the main thread keeps taking its turn and the health check keeps
// being answered. On a machine with spare cores that is near-free. On a 0.25 vCPU
// task it is not free at all — the two threads share one throttled slice — but
// contention is a different failure from starvation: the server gets slower
// instead of getting killed, and a slow answer is a thing a caller can wait for.
//
// MEASURED IN PRODUCTION, 2026-09-07, on the real 135-task plan:
//
//     /api/reorder?limit=8   90,170ms  ->  504 at the gateway
//     /api/health during it  7 samples, worst 383ms, every one a 200
//
// Later the same day, after three exact optimisations inside `sched` (see
// cost.test.ts), the same call is 23,047ms and a 200 carrying 8 suggestions. The
// worker is still what keeps /health answered while it runs.
//
// Both halves matter. The starvation is GONE — on 09-04 the same call left
// /health unanswered past its 5s timeout and two strikes, and ECS replaced the
// task six times. And the feature is still not usable on that plan: ninety
// seconds is longer than the gateway will wait, so the caller gets a 504 exactly
// as before. This change bought the SERVER's life, not the feature's. Making
// `suggestReorders` itself cheaper is the remaining work, and cost.test.ts is
// where its budget lives.
//
// ONE WORKER, AND REQUESTS QUEUE BEHIND IT. A pool would not help: the container
// has a quarter of a core, so a second worker would take its slice from the first
// and from the event loop. One is the honest amount of parallelism available here,
// and it also bounds how much CPU a burst of callers can ask for.
import { Worker } from 'node:worker_threads'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, Pending>()

/** LAZY, so a server that is never asked for a reorder never pays for the thread
 *  — which is most of them, most of the time. */
function ensure(): Worker {
	if (worker) return worker
	const w = new Worker(new URL('./reorder-worker.mjs', import.meta.url))
	w.on('message', (m: { id: number; ok: boolean; out?: unknown; error?: string }) => {
		const p = pending.get(m.id)
		if (!p) return
		pending.delete(m.id)
		m.ok ? p.resolve(m.out) : p.reject(new Error(m.error || 'reorder failed'))
	})
	// A DEAD WORKER MUST NOT HANG ITS CALLERS. If the thread exits — an OOM on a
	// pathological plan is the realistic way — every request waiting on it is
	// rejected and the next call starts a fresh one. Silently leaving them pending
	// would turn one crash into an endless queue of requests nobody answers.
	const die = (why: string) => (err?: Error) => {
		for (const [, p] of pending) p.reject(err ?? new Error(`reorder worker ${why}`))
		pending.clear()
		if (worker === w) worker = null
	}
	w.on('error', die('errored'))
	w.on('exit', () => die('exited')())
	// The process must not be held open by an idle worker.
	w.unref()
	worker = w
	return w
}

/** The same answer `/api/reorder` always returned, computed somewhere else. */
export function runReorder(doc: unknown, opts: { limit?: number; maxLane?: number }): Promise<unknown> {
	const w = ensure()
	const id = ++seq
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject })
		// `ref` while there is work outstanding, so the answer is not lost to the
		// process exiting between the post and the reply.
		w.ref()
		w.postMessage({ id, doc, opts })
	}).finally(() => { if (!pending.size) w.unref() }) as Promise<unknown>
}
