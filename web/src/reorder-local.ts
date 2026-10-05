// TALKING TO THE SEARCH THREAD — the browser half of what `sync-server/src/
// reorder-pool.ts` does on the server, and deliberately the same shape.
//
// ONE WORKER, AND REQUESTS QUEUE BEHIND IT. Not for the server's reason — this
// machine has cores to spare — but for a simpler one: the page only ever wants
// the newest answer. A second concurrent search would be computing advice about a
// document that has already been superseded, and paying a core to do it.
//
// LAZY, so a session that never opens the Order panel never starts a thread. Most
// sessions are that.
//
// IT IS NOT A SERVICE WORKER, which is the thing with the update lifecycle people
// get stuck on. This has no install step, no persistence and no network
// interception; it is a thread that dies with the tab. The script itself is a
// content-hashed `/assets/reorder-worker-<hash>.js`, so a stale copy is
// impossible by construction, and the `/schedule.js` it imports is served
// `no-cache` (see `scripts/deploy-web.sh`).

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

/** Every request outstanding is failed, and the next call starts a fresh thread.
 *  Silently leaving them pending would turn one crash into a panel that spins
 *  forever — the same failure the server's pool guards against. */
function die(why: string) {
	for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`reorder worker ${why}`)); }
	pending.clear();
	worker = null;
}

function ensure(): Worker {
	if (worker) return worker;
	// `new URL(..., import.meta.url)` is the form Vite understands: it emits the
	// worker as its own hashed chunk rather than trying to inline it.
	const w = new Worker(new URL("./reorder-worker.js", import.meta.url), { type: "module" });
	w.addEventListener("message", (e: MessageEvent<{ id: number; ok: boolean; out?: unknown; error?: string }>) => {
		const p = pending.get(e.data.id);
		if (!p) return;
		pending.delete(e.data.id);
		clearTimeout(p.timer);
		e.data.ok ? p.resolve(e.data.out) : p.reject(new Error(e.data.error || "reorder failed"));
	});
	w.addEventListener("error", () => die("errored"));
	worker = w;
	return w;
}

export interface LocalReorder {
	out: unknown;
	/** How long it actually took on THIS machine. The point of measuring rather
	 *  than predicting: the page can decide what to do next from a fact about the
	 *  device in front of it instead of from a constant somebody tuned once. */
	ms: number;
}

/** Run the search on this machine. Rejects on a cycle, a dead thread, or a
 *  timeout — every one of which the caller answers the same way, by asking the
 *  server instead. */
export function localReorder(doc: unknown, limit: number, timeoutMs: number,
                             maxLane?: number): Promise<LocalReorder> {
	const w = ensure();
	const id = ++seq;
	const t0 = performance.now();
	return new Promise<unknown>((resolve, reject) => {
		// A CEILING, because "this device is too slow for this plan" has to be
		// survivable rather than merely unlikely. Twenty times slower than a current
		// laptop is 41s on the real plan, and something has to give up before a
		// reader concludes the panel is broken.
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`local reorder exceeded ${timeoutMs}ms`));
		}, timeoutMs) as unknown as number;
		pending.set(id, { resolve, reject, timer });
		w.postMessage({ id, doc, limit, maxLane });
	}).then(out => ({ out, ms: Math.round(performance.now() - t0) }));
}
