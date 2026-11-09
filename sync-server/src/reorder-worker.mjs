// THE SEARCH, ON A THREAD THAT IS NOT THE ONE ANSWERING REQUESTS.
//
// PLAIN ESM, NOT TYPESCRIPT, and that is deliberate. The server runs under `tsx`,
// which registers a loader for the PROCESS — a worker started from a `.ts` file
// would need that loader registered again inside the worker, which is a second
// way for the two halves to disagree about how they are built. This file imports
// the same compiled `shared/schedule.js` the server does, so there is nothing to
// configure: `../../shared/` resolves identically in local dev and in the image,
// which mirrors the repo layout for exactly this reason (see the Dockerfile).
//
// IT IS THE SAME SCHEDULER, still. One copy in `shared/`, imported here and by
// `src/scheduler.ts`, hashed by `/health` and compared by
// `scripts/assert-shared-parity.sh`. Moving the CALL to another thread does not
// make a second implementation, and it must not.
import { parentPort } from 'node:worker_threads'
import { laneOrder, suggestReorders } from '../../shared/schedule.js'

parentPort.on('message', ({ id, doc, opts }) => {
  try {
    // BOTH AXES FROM ONE MESSAGE, matching what `/api/reorder` returns: within a
    // lane which row to move, across lanes which team goes on top. `laneOrder` is
    // sub-millisecond and could have stayed on the main thread; sending it here
    // keeps one round trip instead of two and one place that knows the shape.
    parentPort.postMessage({ id, ok: true,
      out: { ...suggestReorders(doc, opts), lanes: laneOrder(doc) } })
  } catch (err) {
    // A cycle throws out of sched() rather than returning a wrong answer. The
    // MESSAGE crosses the thread boundary; an Error object would not survive
    // structured clone with its prototype, and the caller only needs the words.
    parentPort.postMessage({ id, ok: false, error: err?.message ?? String(err) })
  }
})
