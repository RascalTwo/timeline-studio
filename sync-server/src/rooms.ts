// THE ROOM REGISTRY. Everything in here is `CommandRoom` (src/room.ts) wired to
// S3 — the load, the debounced flush of the live draft, saving a version, and the
// close discipline the idle monitor depends on. The room logic itself is next
// door and imports none of this.

import { CommandRoom, type Session } from './room'
import { applyMigrations, orderSignature, SCHEMA } from '../../shared/schedule.js'
import { runReorder } from './reorder-pool'
import { upgradePlan } from './upgrade'
import { listVersionNumbers, loadHistory, loadPlan, loadVersion, type PlanId, putVersion, savePlan } from './s3'
import { invalid, okId } from './validate'

// Debounce window for persisting the changed live draft back to S3. Same 3s the
// sibling `private-tldraw` uses. The draft is a convenience, not the record —
// the record is the archive, which is written synchronously on Save.
const SAVE_DEBOUNCE_MS = 3000

export interface Entry {
	room: CommandRoom
	/** Write the live draft to S3 now, cancelling any pending debounce. */
	flush: () => Promise<void>
}

// Open rooms, keyed by plan id. Stored as promises so two people opening the same
// plan at the same instant share one load and one room rather than racing into
// two live documents.
const rooms = new Map<string, Promise<Entry>>()

/** Rooms currently held in memory. THIS IS THE IDLE SIGNAL — see idle-shutdown.ts
 *  and `closeRoomIfUnused` for why a room that outlives its sessions is not an
 *  untidiness but a service that never scales down. */
export const openRoomCount = () => rooms.size

/** The already-open room for a plan, or undefined. Lets a reader take the live
 *  (freshest) document when someone is connected without OPENING a room just to
 *  read one. */
export const getOpenRoom = (id: PlanId) => rooms.get(id)

const lastSaved = async (id: PlanId) => {
	const ns = await listVersionNumbers(id)
	return ns.length ? (await loadVersion(id, ns.at(-1)!))?.doc : undefined
}

export async function makeOrLoadRoom(id: PlanId): Promise<Entry> {
	if (!okId(id)) throw new Error(`bad plan id ${JSON.stringify(id)}`)
	const existing = rooms.get(id)
	if (existing) return existing

	const promise = (async (): Promise<Entry> => {
		let doc = await loadPlan(id)
		if (!doc) throw new PlanMissing(id)
		// AN OLD PLAN IS UPGRADED HERE, ONCE. The ladder gets the plan's saved
		// history because a rung may need it (v4 -> v5 reconstructs `createdAt`
		// from it), and the result is written straight back, so the next load finds
		// it current and the ladder does nothing. Nothing sweeps stored plans: each
		// is upgraded the first time anyone opens it.
		//
		// SAVED FIRST, AS IT WAS. The write-back replaces the live draft, and before
		// this the draft's pre-upgrade form existed nowhere — a wrong rung would
		// have rewritten somebody's plan with History reaching back only to their
		// last save. So an unsaved draft is archived as a version before it is
		// replaced, exactly as pressing Save would, and any upgrade is one Revert
		// away. (Found when a hot-reloading dev server ran v6 and v7 over a real
		// plan mid-change; both were right, which is luck, not design.)
		if ((doc.schemaVersion ?? 1) < SCHEMA) {
			const from = doc.schemaVersion ?? 1
			const up = upgradePlan(doc, await lastSaved(id), await ladderContext(id))
			doc = up.doc
			if (!invalid(doc)) {
				if (up.before) await serialize(id, async () => {
					const ns = await listVersionNumbers(id)
					await putVersion(id, (ns.at(-1) ?? 0) + 1, {
						at: new Date().toISOString(), by: 'server', doc: up.before!,
						note: `before upgrade v${from} → v${SCHEMA}`,
					})
				})
				await savePlan(id, doc)
				console.log(`[room] ${id} upgraded v${from} -> v${SCHEMA}` + (up.before ? ' (draft archived first)' : ''))
			}
		}
		// A plan that cannot be validated is loaded anyway rather than refused: the
		// room is still readable and still savable-to-history, and refusing to open
		// it would leave the only fix (the browser's migration ladder) unreachable.
		// Every command against it will be rejected with this same message, which is
		// loud and correct — see the note on schemaVersion in validate.ts.
		const wrong = invalid(doc)
		if (wrong) console.warn(`[room] ${id} loaded but does not validate: ${wrong}`)

		let timer: NodeJS.Timeout | undefined
		let pending = false
		const flush = async () => {
			if (timer) clearTimeout(timer)
			timer = undefined
			if (!pending) return
			pending = false
			await savePlan(id, room.doc)
		}
		const room = new CommandRoom({
			id,
			doc,
			onChange() {
				pending = true
				if (timer) clearTimeout(timer)
				timer = setTimeout(() => {
					flush().catch((err: unknown) => console.error('[room] failed to persist draft', id, err))
				}, SAVE_DEBOUNCE_MS)
				timer.unref()
			},
		})
		return { room, flush }
	})()

	// Registered before the await resolves so concurrent callers share it; removed
	// again if the load fails, so a missing plan does not pin a rejected promise
	// in the map and make every later attempt fail the same way.
	rooms.set(id, promise)
	promise.catch(() => {
		if (rooms.get(id) === promise) rooms.delete(id)
	})
	return promise
}

/** What the migration ladder may read for a stored plan: its saved versions,
 *  oldest first, and the time. See `MigrationContext` in shared/schedule.ts. */
const ladderContext = async (id: PlanId) => ({
	history: (await loadHistory(id)).sort((a, b) => a.n - b.n),
	now: new Date().toISOString(),
})

export class PlanMissing extends Error {
	constructor(id: PlanId) {
		super(`no plan ${JSON.stringify(id)}`)
	}
}

/** Detach a session; flush and close the room when it was the last one.
 *
 *  This is the normal teardown path, and the reason `openRoomCount()` is a
 *  faithful "is anyone connected" signal rather than a high-water mark. */
export async function leaveRoom(id: PlanId, sessionId: string): Promise<void> {
	const entry = rooms.get(id)
	if (!entry) return
	const { room, flush } = await entry
	if (room.leave(sessionId) > 0) return
	await flush()
	if (room.sessionCount > 0) return
	rooms.delete(id)
}

/** Flush, close and unregister a room that has no connected sessions.
 *
 *  ROOMS ARE NORMALLY TORN DOWN BY `leaveRoom`, WHICH ONLY FIRES FOR A SESSION.
 *  An HTTP write from an agent opens a room without ever creating one, so on that
 *  path nothing ever removes it: the room pins in memory forever, `openRoomCount()`
 *  never returns 0, and the service never scales to zero. `private-tldraw`
 *  documents this failure in its README and it applies here identically. Call
 *  this after ANY sessionless operation — read, write, save or revert. */
export async function closeRoomIfUnused(id: PlanId): Promise<void> {
	const entry = rooms.get(id)
	if (!entry) return
	// A SETTLING ROOM STAYS OPEN: its moves are still landing, and closing it now
	// would drop them. The settle loop calls this itself when it finishes.
	if (settling.has(id)) return
	let room: CommandRoom
	let flush: () => Promise<void>
	try {
		;({ room, flush } = await entry)
	} catch {
		// The load failed and already removed itself from the map. A caller
		// cleaning up after a 404 should not be handed the same error twice.
		return
	}
	if (room.sessionCount > 0) return
	await flush()
	// ponytail: re-check rather than refcount. A client that connects during the
	// flush above can still have its room dropped underneath it; the draft is
	// already durable and the client reconnects into a reloaded room, so the worst
	// case is a full-document welcome. Add a refcount if that blip ever shows up.
	if (room.sessionCount > 0) return
	rooms.delete(id)
}

// ---------------------------------------------------------------------------
// SAVE — writing the live document into the next archive slot.
//
// Append-only, and anyone holding the link can do it (ADR 0002 has no roles to
// check). The archive is the record; `data/<id>.json` is the draft everyone is
// currently editing.
//
// NOTHING IS REPLAYED HERE. ADR 0001 is explicit that the command log is
// transport, not storage — the server applied every command on arrival, so the
// live document is already what a save should write.
// ---------------------------------------------------------------------------

// One save at a time per plan. The next version number is derived from the
// highest existing one, so two saves that read the listing concurrently would
// both pick N+1 and the second would overwrite the first — losing the note,
// which is the only part of a version a human wrote.
const saveLocks = new Map<string, Promise<unknown>>()

const serialize = <T>(id: PlanId, work: () => Promise<T>): Promise<T> => {
	const next = (saveLocks.get(id) ?? Promise.resolve()).then(work, work)
	saveLocks.set(
		id,
		next.catch(() => {})
	)
	return next
}

export interface SaveResult {
	n: number
	snapshot: boolean
	at: string
	note: string
	by: string
}

/** Archive the live document as the next version. `snapshot: false` means it was
 *  identical to the newest version and no entry was added — the original tool's
 *  rule, kept, because saving twice with nothing changed should not put two rows
 *  in the log a human reads. */
export async function saveRoom(id: PlanId, note: string, by: string): Promise<SaveResult> {
	const { room } = await makeOrLoadRoom(id)
	return serialize(id, async () => {
		const doc = room.doc
		const wrong = invalid(doc)
		if (wrong) throw new Error(wrong)

		const ns = await listVersionNumbers(id)
		const lastN = ns.length ? ns[ns.length - 1]! : 0
		const last = lastN ? await loadVersion(id, lastN) : undefined
		const at = new Date().toISOString()
		// Both sides are serialised by this server from an object that was parsed
		// from JSON, so key order is stable and string equality is the same notion
		// of "changed" the unsaved-changes indicator uses.
		const snapshot = !last || JSON.stringify(last.doc) !== JSON.stringify(doc)
		if (snapshot) await putVersion(id, lastN + 1, { at, note, doc, by })
		return { n: snapshot ? lastN + 1 : lastN, snapshot, at, note, by }
	})
}

// ---------------------------------------------------------------------------
// REVERT
//
// OLD VERSIONS ARE READ-ONLY. Reading one — to view it, or to compare against it
// — never touches the room, which is why there is no "load version" here: doing
// that in place would time-machine everyone who happens to be looking at the
// plan. Revert is the one operation that does change the room, and it announces
// itself and names the version it came from.
// ---------------------------------------------------------------------------

export async function revertRoom(id: PlanId, n: number, by: string): Promise<SaveResult> {
	const { room } = await makeOrLoadRoom(id)
	const target = await loadVersion(id, n)
	if (!target) throw new Error(`no version ${n} in this plan`)

	// ARCHIVE WHAT IS BEING DISCARDED FIRST. Revert throws away the live draft for
	// everyone in the room, and that draft may hold an hour of edits nobody has
	// saved. The archive is append-only and cheap; an unrecoverable revert is not.
	const before = await saveRoom(id, `before revert to v${n}`, by)

	// An archived version is frozen at the schema it was saved in, so it goes up
	// the ladder on its way back into the room, with the history for context.
	const doc = applyMigrations(structuredClone(target.doc), undefined, undefined, await ladderContext(id))
	const wrong = room.replaceDoc(doc, { from: n, note: target.note ?? '', by })
	if (wrong) throw new Error(wrong)
	return before
}

/** Re-export so server.ts has one import for the room-facing surface. */
export type { Session }

// ---------------------------------------------------------------------------
// AUTO-ORDER
//
// A plan with `autoOrder: true` never shows stale Order advice, because the
// server takes it: after any change that could move a queue — anything that
// alters `orderSignature` — it runs the same search `/api/reorder` runs, off the
// event loop, applies the best single move as an ordinary `moveTaskInLane` by
// "Auto-order", and searches again until no single move helps. Everyone in the
// room watches it land like any other edit.
//
// SETTLING FOLLOWS THE CHANGE; IT DOES NOT BLOCK IT. A search is seconds on a
// real plan (8s on 151 tasks in one lane), and the page cannot hold every
// keystroke for that. A caller that must see the settled plan — an agent that
// will read it back and act — passes `settle=1`, and `settled()` is what it
// waits on. A change that arrives mid-search marks the plan dirty and the loop
// starts over from the new state rather than applying a move measured against
// an order that no longer exists.
// ---------------------------------------------------------------------------

/** Moves per settle, a backstop only: every move is a strict improvement, so
 *  the loop ends on its own. */
const MAX_MOVES = 60
const settling = new Map<PlanId, Promise<void>>()
const dirty = new Set<PlanId>()

/** Call after a successful apply, with the signature from before it. */
export function afterApply(id: PlanId, room: CommandRoom, before: string): void {
	if (room.doc.autoOrder !== true || orderSignature(room.doc) === before) return
	dirty.add(id)
	if (settling.has(id)) return
	const run = (async () => {
		try {
			while (dirty.has(id)) {
				dirty.delete(id)
				await settleOnce(id, room)
			}
		} catch (err) {
			// A cycle, or a worker failure: the plan is left as it is — unsettled,
			// never wrong — and the next change tries again.
			console.error(`[auto-order] ${id}:`, (err as Error)?.message ?? err)
		} finally {
			settling.delete(id)
			await closeRoomIfUnused(id)
		}
	})()
	settling.set(id, run)
}

async function settleOnce(id: PlanId, room: CommandRoom): Promise<void> {
	for (let i = 0; i < MAX_MOVES && room.doc.autoOrder === true; i++) {
		const sig = orderSignature(room.doc)
		const out = (await runReorder(room.doc, { limit: 1, maxLane: Infinity })) as {
			suggestions?: { id: string; to: number }[]
		}
		// Somebody changed the plan while the worker searched: this answer is for
		// an order that no longer exists. Start again from what is there now.
		if (orderSignature(room.doc) !== sig) return void dirty.add(id)
		const best = out.suggestions?.[0]
		if (!best) return
		if (room.apply([{ type: 'moveTaskInLane', id: best.id, toIndex: best.to }], 'Auto-order')) return
	}
}

/** Resolves once no Auto-order settle is pending or running for this plan. */
export async function settled(id: PlanId): Promise<void> {
	while (settling.has(id)) await settling.get(id)
}

/** `settled()`, but only for a change that moved `orderSignature` from `before` —
 *  one that cannot move the queue starts no settle, and waiting out somebody
 *  else's would make it pay for a search it has nothing to do with. */
export const settledIfOrderChanged = (id: PlanId, room: CommandRoom, before: string): Promise<void> =>
	orderSignature(room.doc) === before ? Promise.resolve() : settled(id)
