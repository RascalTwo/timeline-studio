// THE COMMAND ROOM. What `TLSocketRoom` was in the sibling `private-tldraw`, and
// the one module of this port that is a rewrite rather than an adaptation.
//
// It holds the live document, assigns sequence numbers, validates, applies and
// broadcasts. It has NO import of S3, of `ws`, of fastify, or of anything in
// `web/` — a session is `{ id, send, close }` and persistence is a callback. That
// is not decoration: the whole point of ADR 0001 is that ordering decides dates,
// and logic that can only be exercised by standing up a bucket and a browser is
// logic nobody exercises.
//
// WHAT IS NOT HERE, on purpose:
//   - saving to history      → rooms.ts, because it needs S3 and a per-plan lock
//   - the scheduler          → the browser (see the original tool's README).
//                              The server never computes a date.
//   - presence in the log    → see PRESENCE below

import { applyCommand, validateCommand, type Command, type Doc } from '../../shared/commands.js'
import { invalid } from './validate'
import { randomUUID } from 'node:crypto'
import { hasCycle } from '../../shared/schedule.js'

/** Chart coordinates, not pixels: every client has its own zoom and scroll, so a
 *  pixel from one is meaningless on another. `day` counts from `doc.start` and
 *  may be fractional and negative, exactly like `notBefore`. */
export interface Cursor {
	day: number
	laneRow: number
}

/** Ephemeral, never persisted, never sequenced. Nothing verifies `name` — ADR
 *  0002 removed the identity provider that could have. */
export interface Presence {
	sessionId: string
	name: string
	color: string
	cursor: Cursor | null
}

/** One sequenced command as it sits in the replay buffer and goes on the wire. */
export interface LoggedCommand {
	seq: number
	cmd: Command
	by: string
}

export type ServerFrame =
	/** FULL STATE. Sent on first connect, and on reconnect whenever the client
	 *  cannot be resumed. Receiving this means "discard any optimistic command
	 *  you have not seen acknowledged" — the server decides that, not the client,
	 *  which is why there is no flag on it to get wrong. */
	| {
			type: 'welcome'
			sessionId: string
			id: string
			epoch: string
			seq: number
			doc: Doc
			presence: Presence[]
	  }
	/** The replay path: everything after the client's `since`, in order. */
	| { type: 'resume'; sessionId: string; id: string; epoch: string; seq: number; commands: LoggedCommand[] }
	/** Broadcast to everyone. `ref` is echoed only to the sender, which is how a
	 *  client tells its own optimistic apply from someone else's edit. */
	| { type: 'cmd'; seq: number; cmd: Command; by: string; ref?: string }
	/** To the sender alone. `error` is `validateCommand`'s or `invalid()`'s own
	 *  message, verbatim — the client rolls back and shows it. */
	| { type: 'rejected'; ref?: string; error: string }
	| { type: 'presence'; presence: Presence }
	| { type: 'left'; sessionId: string }
	/** A whole-document replacement, announced. See `replaceDoc`. */
	| { type: 'reverted'; seq: number; epoch: string; doc: Doc; from: number; note: string; by: string }
	| { type: 'saved'; ref?: string; n: number; snapshot: boolean; at: string; note: string; by: string }
	| { type: 'error'; error: string }

export interface Session {
	readonly id: string
	send(frame: ServerFrame): void
	close(): void
}

// HOW MANY COMMANDS THE REPLAY BUFFER HOLDS. The log is transport, not storage
// (ADR 0001) — the live document is always current, so the only thing aging out
// costs is a reconnecting client's ability to keep its optimistic edits, and the
// fallback is a ~28KB document. 1024 is roughly a very busy hour in one room.
const LOG_LIMIT = 1024

export interface RoomOptions {
	id: string
	doc: Doc
	/** Called after any change to the live document. rooms.ts debounces a write
	 *  of `data/<id>.json` behind it; tests pass a counter. */
	onChange?: () => void
}

export class CommandRoom {
	readonly id: string
	/** THE ONLY WRITE SITE IS `apply`. ADR 0001's mitigation for "every mutation
	 *  must be a command" is a Proxy that throws on a direct write — that guard
	 *  is for the browser, which has 28 mutation sites. Here there is one, and it
	 *  swaps in a fresh object rather than mutating: a partially-applied document
	 *  is never observable, and a rejected command leaves nothing to roll back. */
	private _doc: Doc
	private _seq = 0
	private readonly log: LoggedCommand[] = []
	private readonly sessions = new Map<string, Session>()
	private readonly presence = new Map<string, Presence>()
	private readonly onChange: () => void

	/** IDENTITY OF THIS ROOM INSTANCE, not of the plan. Sequence numbers live in
	 *  memory and restart at 0 when the task is replaced or the room is evicted,
	 *  so a client holding `since: 400` from before a restart would otherwise be
	 *  "resumed" against a log that means something entirely different. The client
	 *  echoes the epoch it was given; a mismatch falls through to a full welcome.
	 *  This is also what makes a second Fargate task a config change rather than
	 *  a corruption bug. */
	readonly epoch: string

	constructor(opts: RoomOptions) {
		this.id = opts.id
		this._doc = opts.doc
		this.onChange = opts.onChange ?? (() => {})
		this.epoch = randomId()
	}

	get doc(): Doc {
		return this._doc
	}
	get seq(): number {
		return this._seq
	}
	get sessionCount(): number {
		return this.sessions.size
	}

	/** How many people are VISIBLY here — what `viewers` means to a human, and
	 *  deliberately not `sessionCount`. A lurker holds a session, because the room
	 *  must not scale to zero out from under someone who is reading it; they are
	 *  simply not one of the people you can see. Room lifecycle asks
	 *  `sessionCount`; anything a person reads asks this. */
	get visibleCount(): number {
		return this.presence.size
	}

	// -----------------------------------------------------------------------
	// COMMANDS
	// -----------------------------------------------------------------------

	/** Sequence, validate, apply and broadcast a batch — a single command is a
	 *  batch of one, so there is one code path and no second set of rules for the
	 *  socket to drift from the HTTP surface.
	 *
	 *  ALL OR NOTHING. Each command is checked against the document as the batch
	 *  has built it so far (so `addTask` then `moveTaskInLane` works), but
	 *  `invalid()` runs ONCE at the end — a batch is allowed to pass through
	 *  states no single edit could, which is exactly what an agent adding a lane
	 *  and then moving tasks onto it needs. Nothing is broadcast until the whole
	 *  batch commits, so no client ever sees an intermediate state.
	 *
	 *  Returns the rejection reason, or `null` on success. */
	apply(cmds: Command[], by: string, opts: { from?: Session; ref?: string } = {}): string | null {
		if (!cmds.length) return 'no commands'
		// EVERY COMMAND IS DATED HERE, the one door both the socket and HTTP go
		// through, so `addTask` always has an `at` to stamp `createdAt` with — which
		// v5 requires. The page and `/api/commands` already date theirs; this covers
		// any other socket client. Stamped on the command, before the broadcast, so
		// every copy of the document applies the same instant.
		const at = new Date().toISOString()
		for (const cmd of cmds) if (cmd.at === undefined) cmd.at = at
		// A COMMENT FROM AN API CALLER needs only its text: the id, the time and
		// the author are filled here, on the command, before anybody applies it,
		// so every copy agrees. The page sends all three itself.
		for (const cmd of cmds) if (cmd.type === 'addComment' && cmd.comment && typeof cmd.comment === 'object') {
			cmd.comment.id ??= 'c-' + randomUUID().slice(0, 8)
			cmd.comment.by ??= by
		}
		// A SUGGESTION SENT WITHOUT AN AUTHOR is the caller's, from the same header.
		for (const cmd of cmds) if (cmd.type === 'setRankSuggestion') cmd.by ??= by
		const next = structuredClone(this._doc)
		for (const cmd of cmds) {
			const wrong = validateCommand(next, cmd)
			if (wrong) return this.reject(wrong, opts)
			applyCommand(next, cmd)
		}
		// The document check the original tool ran at `/save`, moved to every
		// mutation — because there is no longer a save that could catch it, and a
		// plan that only breaks when someone presses Save is a plan that breaks in
		// front of a room.
		const wrong = invalid(next)
		if (wrong) return this.reject(wrong, opts)

		// A CYCLE THE BATCH INTRODUCED, refused here as well as on the page.
		//
		// `invalid()` deliberately does not look for one, on the grounds that
		// re-deriving the scheduler behind the wire is the duplication ADR 0001
		// exists to prevent. That reasoning holds for scheduling and not for this:
		// a cycle is a property of the edges, `hasCycle` shares nothing with
		// `sched`, and the page's own guard turned out to be unsound — it asked
		// `sched` to throw, and a cycle running through an already-finished task
		// never stopped it. One got saved and broadcast before this existed.
		//
		// COMPARED AGAINST THE DOCUMENT AS IT WAS, not asserted absolutely. A plan
		// that already contains a cycle must stay editable, or the one command
		// that would fix it — removing the dependency — is refused along with
		// everything else and the plan is frozen by its own validation.
		if (hasCycle(next.tasks) && !hasCycle(this._doc.tasks))
			return this.reject('that would create a dependency cycle', opts)

		this._doc = next
		const logged = cmds.map((cmd) => ({
			seq: ++this._seq,
			// Detached from the caller's object. `addTask` puts `cmd.task` into the
			// document by reference, so without this the replay buffer would hold a
			// task that later commands quietly rewrite underneath it.
			cmd: structuredClone(cmd),
			by,
		}))
		for (const entry of logged) {
			this.log.push(entry)
			this.broadcast({ type: 'cmd', ...entry }, opts.from)
			// The sender gets the same frame carrying its own `ref`, which is how it
			// retires the optimistic copy it already applied instead of applying it
			// twice. A batch echoes the ref on each of its commands.
			opts.from?.send({ type: 'cmd', ...entry, ref: opts.ref })
		}
		if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT)
		this.onChange()
		return null
	}

	private reject(error: string, opts: { from?: Session; ref?: string }): string {
		opts.from?.send({ type: 'rejected', ref: opts.ref, error })
		return error
	}

	/** REPLACE THE WHOLE DOCUMENT, for everyone, announced. This is `revert`, and
	 *  it is deliberately not a `Command`: `shared/commands.js` has no
	 *  whole-document command and `patchDoc` may not touch `tasks`, which is the
	 *  rule ADR 0001 calls "no exceptions". Bolting a `setDoc` command on to make
	 *  revert fit would reopen precisely the whole-array write commands exist to
	 *  prevent, for the one operation that is already explicit, already
	 *  attributed, and already archived.
	 *
	 *  Reverting is NOT viewing an old version. Viewing never touches the room;
	 *  this changes it for everybody, which is why it names what it is discarding.
	 *
	 *  The replay buffer is cleared, so every reconnecting client takes the full
	 *  document path — a command log spanning a revert does not reproduce it. */
	replaceDoc(doc: Doc, meta: { from: number; note: string; by: string }): string | null {
		const wrong = invalid(doc)
		if (wrong) return wrong
		this._doc = structuredClone(doc)
		this._seq += 1
		this.log.length = 0
		this.broadcast({ type: 'reverted', seq: this._seq, epoch: this.epoch, doc: this._doc, ...meta })
		this.onChange()
		return null
	}

	// -----------------------------------------------------------------------
	// SESSIONS
	// -----------------------------------------------------------------------

	/** Attach a session and hand it the state it needs.
	 *
	 *  RESUME OR RESET, and the server decides. A client may resume when it was
	 *  talking to THIS room instance (`epoch`) and every command it has not seen
	 *  is still in the buffer. Otherwise it gets the whole document and must
	 *  discard any optimistic edit it had not seen acknowledged.
	 *
	 *  `since > seq` is not a resume either. That is a client from before a
	 *  restart, or from another task — the epoch check already catches it, and
	 *  the bound is kept because a resume that silently replays the wrong log
	 *  writes a wrong plan rather than failing. */
	// LURKING IS A SESSION WITH NO PRESENCE ENTRY, and that is the whole feature.
	// The alternative — a `hidden` flag on Presence that every consumer has to
	// remember to honour — is one forgotten filter away from a cursor appearing,
	// and the forgotten one is always the path nobody tested. Absence cannot be
	// forgotten: `setPresence` already returns early when there is no entry, so a
	// lurker's cursor frames are dropped without a new branch; `leave` already
	// broadcasts `left` only when the delete removed something, so a lurker
	// leaves as silently as they arrived; and `everyone()` cannot list them.
	//
	// It is not invisibility from the SERVER, and must not be sold as that. A
	// lurker still holds a session, still receives every frame, and every command
	// they send is sequenced and broadcast with their name on it. This hides a
	// cursor and a chip, not an editor.
	join(
		session: Session,
		who: { name: string; color: string },
		since?: { epoch: string; seq: number },
		lurk = false
	): void {
		this.sessions.set(session.id, session)
		const presence: Presence | null = lurk
			? null
			: { sessionId: session.id, name: who.name, color: who.color, cursor: null }
		if (presence) this.presence.set(session.id, presence)

		const oldest = this.log.length ? this.log[0]!.seq : this._seq + 1
		const canResume =
			!!since && since.epoch === this.epoch && since.seq <= this._seq && since.seq >= oldest - 1

		session.send(
			canResume
				? {
						type: 'resume',
						sessionId: session.id,
						id: this.id,
						epoch: this.epoch,
						seq: this._seq,
						commands: this.log.filter((e) => e.seq > since!.seq),
					}
				: {
						type: 'welcome',
						sessionId: session.id,
						id: this.id,
						epoch: this.epoch,
						seq: this._seq,
						doc: this._doc,
						presence: [...this.presence.values()].filter((p) => p.sessionId !== session.id),
					}
		)
		if (presence) this.broadcast({ type: 'presence', presence }, session)
	}

	/** Returns the number of sessions remaining, which is what the caller acts on
	 *  — see `onSessionRemoved` in rooms.ts and why openRoomCount is the idle
	 *  signal rather than a last-activity timestamp. */
	leave(sessionId: string): number {
		this.sessions.delete(sessionId)
		if (this.presence.delete(sessionId)) this.broadcast({ type: 'left', sessionId })
		return this.sessions.size
	}

	// -----------------------------------------------------------------------
	// PRESENCE
	//
	// NOT COMMANDS, and not in the replay buffer. A cursor moves tens of times a
	// second; sequencing it would burn the 1024-entry buffer in under a minute
	// and cost every reconnecting client its optimistic state, to replay pointer
	// positions that are stale by the time they arrive. It is also never
	// persisted — a cursor in `data/<id>.json` would be archived into History and
	// read back tomorrow as if someone were still there.
	// -----------------------------------------------------------------------

	setPresence(sessionId: string, patch: { name?: string; color?: string; cursor?: Cursor | null }): void {
		const p = this.presence.get(sessionId)
		if (!p) return
		if (typeof patch.name === 'string') p.name = patch.name.slice(0, 60)
		if (typeof patch.color === 'string') p.color = patch.color.slice(0, 32)
		if (patch.cursor !== undefined) p.cursor = validCursor(patch.cursor)
		this.broadcast({ type: 'presence', presence: p }, this.sessions.get(sessionId))
	}

	everyone(): Presence[] {
		return [...this.presence.values()]
	}

	// -----------------------------------------------------------------------

	/** `except` is the originating session, which gets its own tailored frame
	 *  (with `ref`) instead of the broadcast one. */
	broadcast(frame: ServerFrame, except?: Session): void {
		for (const s of this.sessions.values()) if (s !== except) s.send(frame)
	}

	closeAll(): void {
		for (const s of this.sessions.values()) s.close()
		this.sessions.clear()
		this.presence.clear()
	}
}

const validCursor = (c: Cursor | null): Cursor | null =>
	c && Number.isFinite(c.day) && Number.isFinite(c.laneRow) ? { day: c.day, laneRow: c.laneRow } : null

// `crypto.randomUUID` without importing node:crypto, so this module stays
// runnable anywhere — it is a global in Node 19+ and in every browser.
const randomId = () => crypto.randomUUID()
