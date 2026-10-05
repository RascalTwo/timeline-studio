import websocketPlugin from '@fastify/websocket'
import fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { WebSocket } from 'ws'
import type { Command } from '../../shared/commands.js'
import { orderSignature } from '../../shared/schedule.js'
import { createPlan } from './create'
import { startIdleShutdown } from './idle-shutdown'
import type { ServerFrame, Session } from './room'
import {
	closeRoomIfUnused,
	getOpenRoom,
	leaveRoom,
	makeOrLoadRoom,
	openRoomCount,
	PlanMissing,
	revertRoom,
	saveRoom,
	afterApply,
	settled,
	settledIfOrderChanged,
} from './rooms'
import {
	bucket,
	loadHistory,
	loadLatest,
	loadVersion,
	type PlanId,
	putVersion,
	resolveToken,
	StorageDown,
	storeReachable,
} from './s3'
import { readyRows, verdict } from './scheduler'
import { runReorder } from './reorder-pool'
import { healthBody } from './shared-hash'
import { buildSpec, collectRoute } from './openapi'

const PORT = Number(process.env.PORT ?? 8080)

// SIZED AGAINST THE SMALLEST INTERMEDIARY WE CANNOT SEE, not against the one we
// can. ADR 0003 is explicit about this and it is the opposite of the obvious
// reasoning: the shared ALB's 300s `idle_timeout` is merely the timeout we know
// about. CloudFront's behaviour for an established WebSocket is undocumented, and
// the corporate proxies and NAT gateways between a client and us impose their
// own — typically 60–120s, and not ours to configure.
//
// So 30s is not "well within 300s". It is inside a 60s proxy with margin to lose
// a couple of pings to a slow network. DO NOT WIDEN THIS TOWARD 300s: that reads
// as obviously safe, and it breaks exactly one case — a plan open in a meeting
// behind someone's corporate proxy, which is the setting this tool exists for.
// Raising the ALB timeout is not the fix either, and ADR 0003 explains why it is
// not even ours to raise (it is a load-balancer attribute shared by every tenant).
//
// ONE PING COVERS EVERY HOP, which is the other reason it beats a bigger number.
// The socket is on `/api/connect`, so the ping travels client → proxy →
// CloudFront → ALB → here and resets each one's idle timer on the way. A larger
// ALB timeout would only ever have addressed the last hop, and the hop that
// actually drops a meeting is the first one.
const PING_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// TOKEN RESOLUTION — the whole of the auth model (ADR 0002).
//
// A 128-bit random share token hashes to a key under `tokens/`, and that object
// names the plan. There is nothing else to check: no roles, no identity, no
// session. A leaked link is full read/write for anyone on the internet, and that
// consequence was accepted deliberately — see the ADR before changing this.
//
// AND THERE IS NO ENDPOINT THAT LISTS PLANS. Not `/list`, not a picker, not a
// "recent" convenience. One valid link must not expose a second plan, and an
// enumerating endpoint defeats the entire model in one call.
//
// THE TOKEN IS NOT IN THE URL HERE, which is a deliberate narrowing of the ADR's
// "carried in the URL". The ADR is about the page a human is sent; this is the
// wire underneath it. A query string lands in ALB access logs, so the WebSocket
// sends its token in the first frame and HTTP sends it in a header — neither of
// which is logged. It costs nothing and is strictly less exposure.
// ---------------------------------------------------------------------------

// Successful resolutions only. Bounded by the number of plans that exist, so
// there is nothing for a token-spraying client to fill: a miss is never cached,
// which also means revoking a token (deleting `tokens/<sha256>`) takes effect for
// anyone who has not already resolved it. A live room keeps its holder connected
// until they disconnect — revocation is not a kick.
const resolved = new Map<string, PlanId>()

async function planFor(token: unknown): Promise<PlanId | undefined> {
	if (typeof token !== 'string' || !token) return undefined
	const hit = resolved.get(token)
	if (hit) return hit
	const id = await resolveToken(token)
	if (id) resolved.set(token, id)
	return id
}

// NO CORS PLUGIN, deliberately. One CloudFront distribution fronts both origins
// — default to the S3 page, `api/*` to this service — so every request the
// browser makes is same-origin and there is nothing to negotiate. The sibling
// `private-tldraw` registers `@fastify/cors` because its page and its sync server
// are on two hostnames; that is the difference, not an omission here.
//
// It is also the safer shape given ADR 0002. The capability is a bearer value in
// a header (or the `hello` frame), never a cookie, so nothing is ambiently
// attached to a cross-origin request and there is no credential for an origin
// policy to be protecting. A configured-but-unused CORS plugin on a service whose
// only access control is a secret in a link is a loosening waiting to happen.
const app = fastify()

// THE SPEC'S PATH LIST IS THIS HOOK, and it has to be added before anything is
// registered or it sees nothing. A root `onRoute` hook does reach into the
// encapsulated `/api` child — which is where every real route lives, so that is
// not a detail; `test/openapi.test.ts` pins it against a real Fastify instance.
//
// Deriving the paths rather than typing them is the whole requirement: a spec
// fails a reader by OMISSION, and an endpoint that exists cannot be left out of
// a list the router itself produced.
app.addHook('onRoute', collectRoute)
app.register(websocketPlugin)

// Anything that escapes a handler is infrastructure (S3 unreachable, a bad
// response), not something the caller phrased wrongly — every error a caller CAN
// cause is already answered with its own message and a 4xx. Log the detail and
// return none of it: fastify's default 500 body quotes the underlying error,
// which here means bucket names and endpoints going to whoever holds the link.
app.setErrorHandler((err, req, reply) => {
	console.error('[http]', req.method, req.url, err)
	// 503 WHEN IT IS THE STORE, and it reaches here on the paths where the
	// failure happens OUTSIDE a route's try — `ctx()` resolving a token is the
	// common one. Same body either way: it is already the honest sentence, and
	// the SDK's own message names the bucket and the endpoint.
	reply.code(err instanceof StorageDown ? 503 : 500).send({ error: 'the plan store is unavailable' })
})

// ONE BODY, TWO PATHS. Defined here rather than inline so the bare `/health` the
// ALB probes and the `/api/health` the parity script reaches through CloudFront
// cannot report different things — two literals would be two copies of the
// contract, and the one that went stale would be the one nobody probes.
//
// `shared` is a MAP, filename -> digest, not a combined hash — ADR 0001 rejects a
// rollup because it would say the sides disagree without saying which file, and a
// protocol drift and a scheduler drift want different responses. The body itself
// is built in shared-hash.ts so a test can assert the wire key without S3.


// ALB health check, and the ADR 0001 parity contract.
//
// `shared` is the digest of every shared file THIS PROCESS HAS ON DISK (see
// shared-hash.ts). It rides on the health check rather than a separate endpoint
// because `scripts/assert-schedule-parity.sh` has to be able to ask a server it
// may have just woken, and because a health check that reports "up" while running
// a different protocol from the page is reporting the wrong kind of healthy.
app.get('/health', async () => healthBody())

// THE SPEC'S OWN LINKS, ANSWERED HERE TOO. In production one CloudFront
// distribution serves the page and `/api/*` on one host, so `/commands.js`,
// `/AGENTS.md` and `/llms.txt` come from the page's bucket and never reach this
// service. Locally the API and the page are two ports, and the spec served from
// this one linked three paths that 404ed on it: an agent holding only the API had
// nowhere to read how to write a command (2026-09-28). The image carries `shared/`
// but not `web/`, so there only `/commands.js` would answer — and nothing routes
// the other two here in production anyway.
const served = (file: URL, type: string) => async (_req: FastifyRequest, reply: FastifyReply) => {
	try { return reply.type(type).send(await readFile(file, 'utf8')) }
	catch { return reply.code(404).send({ error: 'not in this image' }) }
}
app.get('/commands.js', served(new URL('../../shared/commands.js', import.meta.url), 'text/javascript; charset=utf-8'))
app.get('/AGENTS.md', served(new URL('../../web/AGENTS.md', import.meta.url), 'text/markdown; charset=utf-8'))
app.get('/llms.txt', served(new URL('../../web/llms.txt', import.meta.url), 'text/plain; charset=utf-8'))

// EVERY APP ROUTE LIVES UNDER /api, and that is a routing fact rather than a
// naming preference. One CloudFront distribution fronts both origins: the
// default behaviour serves the page from S3 and `/api/*` forwards to the ALB.
// CloudFront does NOT strip the matched pattern, so `/api/save` arrives here as
// `/api/save` — an unprefixed route is simply never reached, and the failure
// looks like a broken server rather than a routing miss.
//
// THE BARE `/health` ABOVE IS THE DELIBERATE EXCEPTION: the ALB target group
// health-checks `/health` directly, origin-side, never through CloudFront. Move
// it under the prefix and the service never passes a health check and never
// stabilises. It is ALSO served at `/api/health` below, because anything
// reaching this service through CloudFront — including
// `scripts/assert-schedule-parity.sh` — can only get here via `/api/*`.
app.register(async (api) => {
	// The parity contract again, reachable from outside. Same handler, same digest;
	// see the bare `/health` above for why both exist.
	api.get('/health', async () => healthBody())

	// Rooms held in memory. Exactly the number the idle monitor scales to zero on, so
	// this is the one place a leaked room is visible from outside: a room that stayed
	// loaded with nobody connected keeps this above zero forever and the service never
	// scales down. Costs nothing to expose and is otherwise unobservable.
	api.get('/rooms', async () => ({ openRooms: openRoomCount() }))

	// READINESS, WHICH IS NOT THE HEALTH CHECK ABOVE, and the two must not be
	// merged. `/health` is LIVENESS: the ALB replaces a task that fails it, so
	// making it depend on S3 turns a slow bucket into a restart loop — the same
	// shape as the outage on 2026-09-04, arrived at deliberately this time.
	//
	// This answers the question liveness cannot: the process is up, but can it
	// serve a plan? It went unasked for a whole outage on 2026-09-20 — `/health`
	// said 200 throughout, and `scripts/smoke.sh` gates the deploy on `/health`,
	// so a deploy into an environment whose bucket is misconfigured or unreachable
	// went green. Smoke checks this one now, which is the point of it existing.
	//
	// NOT `/ready` — that is the plan question, "what can I pick up now".
	api.get('/readyz', async (_req, reply) => {
		const store = await storeReachable()
		return reply.code(store ? 200 : 503).send({ ok: store, store: store ? 'ok' : 'unreachable' })
	})

	// ---------------------------------------------------------------------------
	// THE API, DESCRIBED. Unauthenticated on purpose: it is a description of the
	// shape of the thing, it names no plan and carries no token, and a spec you
	// need a credential to read is one nobody finds before they need it. It is
	// also the answer to "how do I drive this" that does not involve pasting
	// prose into a prompt — see the header of openapi.ts for why it is a
	// structure in this repo rather than a schema scraper.
	api.get('/openapi.json', async (_req, reply) => {
		// A day. The spec changes when the image does, and both sit behind the same
		// CachingDisabled policy on `api/*`, so this is for the browser and for
		// whatever is reading it repeatedly.
		reply.header('cache-control', 'public, max-age=86400')
		return buildSpec()
	})

	// SCALAR, FROM A CDN, IN ONE STRING. The alternative is a dependency that
	// bundles a React app into an image whose whole job is to hold a scheduler —
	// and this service has no static assets, no build step for them and no CSP to
	// widen. If the CDN is unreachable the JSON above is still the artefact; this
	// is the nice way to read it, not the way to get it.
	api.get('/docs', async (_req, reply) => {
		reply.header('content-type', 'text/html; charset=utf-8')
		reply.header('cache-control', 'public, max-age=86400')
		return `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Timeline Studio API</title>
</head><body>
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
<script>
  Scalar.createApiReference('#app', {
    url: '/api/openapi.json',
    // The page it documents is dark, and a docs page that flashes white next to
    // it reads as somebody else's site.
    darkMode: true,
    hideDownloadButton: false,
  })
</script>
</body></html>`
	})

	// ---------------------------------------------------------------------------
	// THE HTTP SURFACE.
	//
	// This is the programmatic path from the original tool's AGENTS.md, re-pointed at
	// the live room: a write here goes through the same `apply` a click goes through,
	// so connected clients see it immediately and the same debounce persists it.
	//
	// EVERY SESSIONLESS OPERATION CLOSES THE ROOM AFTER ITSELF. An HTTP call opens a
	// room but never creates a session, so nothing would ever tear it down — see
	// `closeRoomIfUnused` in rooms.ts for why that is a service that never scales to
	// zero rather than a tidiness problem.
	// ---------------------------------------------------------------------------

	interface Ctx {
		id: PlanId
		by: string
	}

	/** Nothing verifies this. ADR 0002 removed the identity provider that could
	 *  have, so attribution is a self-chosen name and is treated as a label. */
	const displayName = (req: FastifyRequest) => String(req.headers['x-timeline-by'] ?? 'agent').slice(0, 60)

	/** Resolve the token header to a plan, or send the failure. Returns undefined
	 *  when it has already replied. */
	async function ctx(req: FastifyRequest, reply: FastifyReply, waitFirst = true): Promise<Ctx | undefined> {
		const id = await planFor(req.headers['x-timeline-token'])
		if (!id) {
			reply.code(404).send({ error: 'no such plan' })
			return undefined
		}
		// `settle=1` waits out a running Auto-order settle before the call does
		// anything, so a read returns the settled plan. `/commands` passes
		// `waitFirst: false`: a write applies mid-settle safely (the loop sees the
		// signature move and searches again), so it waits only AFTER — see there.
		if (waitFirst && wantsSettle(req)) await settled(id)
		return { id, by: displayName(req) }
	}
	const wantsSettle = (req: FastifyRequest) => {
		const v = (req.query as { settle?: string } | undefined)?.settle
		return v !== undefined && v !== '0' && v !== 'false'
	}

	/** Turn the one error a caller can actually cause into a 404.
	 *
	 *  A STORAGE OUTAGE IS NOT A BAD REQUEST. Everything that was not `PlanMissing`
	 *  used to come back as a 400 carrying `err.message` — so a dead bucket
	 *  answered `400 {"error":""}` (the empty message is an `AggregateError`; see
	 *  `StorageDown`) and the page told the reader their token had been revoked.
	 *  Nothing was wrong with the request, and nothing was logged either: the
	 *  server knew and said so nowhere. 503, the store named, and a line in the
	 *  log with the SDK's own words — which do NOT go in the body, because they
	 *  name the bucket and the endpoint to whoever holds the link. */
	function fail(reply: FastifyReply, err: unknown) {
		if (err instanceof PlanMissing) return reply.code(404).send({ error: err.message })
		if (err instanceof StorageDown) {
			console.error('[store]', err.message, err.cause)
			return reply.code(503).send({ error: 'the plan store is unavailable' })
		}
		return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
	}

	// -------------------------------------------------------------------------
	// CREATE — New, Fork and Import, which are one operation with one difference:
	// what document the caller supplies. New supplies none and gets the starter.
	//
	// THE ONLY ROUTE ON THIS SERVER THAT TAKES NO TOKEN, and it cannot take one.
	// Somebody arriving at the page with no link holds no capability to present,
	// and minting their first one is the entire point of the route — a create that
	// required a token could only ever be reached by someone who already had a
	// plan. ADR 0002's "no authentication at the door" is written about reading an
	// existing plan; this widens it to writing a NEW one, which the ADR does not
	// discuss and should be amended to cover. The practical consequence is that
	// anyone on the internet can put objects in the bucket, bounded by fastify's
	// 1MB body limit and nothing else. It grants no access to any plan that
	// already exists — see `claimId` — but it is a cost and abuse surface that did
	// not exist before, and it is the thing to put a rate limit in front of if one
	// is ever wanted.
	//
	// WHERE THE TOKEN TRAVELS, and what keeps it out of the logs. It goes in the
	// RESPONSE BODY, as `shareToken`, and nowhere else:
	//
	//   - Not in the URL. The request is `POST /api/plan/new` with no query string,
	//     so the only thing an ALB or CloudFront access log can record is that
	//     path, and the same goes for the `req.url` this file's error handler
	//     prints. This is ADR 0002's own argument for the URL fragment, applied to
	//     the minting side: the capability must not become a routine field in
	//     operational data.
	//   - Not in a response header, which is the tempting alternative and the worse
	//     one. Response headers are what generic tooling captures by default —
	//     tracing instrumentation records them as span attributes, WAFs and proxies
	//     log them, and "capture these headers" is a checkbox in a dozen products.
	//     Response BODIES are captured by almost nothing, because they are large.
	//     Both are invisible to the logs enabled today; the body is the one that
	//     stays invisible when somebody turns something on for debugging six months
	//     from now, which the ADR says is exactly how this gets lost.
	//   - Not into anything this server writes down. The plan document, the version
	//     note and the `by` attribution never see it, so it cannot reach the
	//     archive. Nothing on the create path logs, and if that ever changes the
	//     rule is `resolveToken`'s: print the id, never the token.
	//   - Not into a cache. `no-store` below, on top of the `CachingDisabled`
	//     policy `api/*` already uses. A POST is not cached by CloudFront anyway;
	//     the header is for the browser and for whatever corporate middlebox is
	//     between them, and it costs one line.
	//
	// The remaining exposure is the one ADR 0002 already accepted: it lands in the
	// URL fragment, and a leaked link is full read/write for anyone.
	api.post('/plan/new', async (req, reply) => {
		const body = (req.body ?? {}) as { title?: unknown; doc?: unknown; note?: unknown }
		try {
			const { id, shareToken } = await createPlan(bucket, { ...body, by: displayName(req) })
			reply.header('cache-control', 'no-store')
			// `id` is a display hint for the fragment and a name for a human; the
			// token is the address. The page needs both to navigate to what it just
			// made — it has no other way to reach it, because there is no `/list`.
			return { ok: true, id, shareToken }
		} catch (err) {
			// `invalid()`'s own words, unchanged, the way /commands and /save report.
			return fail(reply, err)
		}
	})

	// The live shared draft — what everyone in the room is looking at right now.
	api.get('/plan', async (req, reply) => {
		const c = await ctx(req, reply)
		if (!c) return
		try {
			const { room } = await makeOrLoadRoom(c.id)
			const out = {
				id: c.id,
				seq: room.seq,
				epoch: room.epoch,
				// Connected clients right now — i.e. is anyone looking at this plan live.
				// AGENTS.md warns that a human's open tab is a second writer; on this
				// server that is no longer a lost-update race, but it is still the thing
				// an agent wants to know before it starts moving bars around.
				// Visible viewers, not sessions: a lurker is deliberately not someone an
				// agent or a human can see, and leaking them as a number nobody can put
				// a name to would be the same tell in a smaller place.
				viewers: room.visibleCount,
				doc: room.doc,
			}
			await closeRoomIfUnused(c.id)
			return out
		} catch (err) {
			await closeRoomIfUnused(c.id)
			return fail(reply, err)
		}
	})

	// Apply commands. `{cmd}` or `{cmds: [...]}` — a batch commits atomically, which
	// is what "add a lane then move tasks onto it" needs and what AGENTS.md's "batch
	// your edits" advice was always describing.
	api.post('/commands', async (req, reply) => {
		const c = await ctx(req, reply, false)
		if (!c) return
		const body = (req.body ?? {}) as { cmd?: Command; cmds?: Command[] }
		const cmds = body.cmds ?? (body.cmd ? [body.cmd] : [])
		if (!Array.isArray(cmds) || !cmds.length)
			return reply.code(400).send({ error: 'body must have `cmd` or a non-empty `cmds` array' })
		// STAMPED HERE, AND ONLY ON THIS PATH. `at` says when a command was issued
		// and the applier is forbidden from reading a clock (see `edited()` in
		// commands.ts), so it has to be set where a command enters the system. An
		// HTTP caller has no copy of the document and applies nothing locally, so
		// the server is that point for this path and filling it in is the only way
		// an agent's edits are dated at all.
		//
		// A SOCKET COMMAND IS NOT TOUCHED, and the asymmetry is the whole care
		// here: that sender already applied the command to its own document and
		// retires the echo rather than re-applying it, so a value added after the
		// fact would live in every copy except the one belonging to the person who
		// made the edit. A caller that sent its own `at` keeps it.
		for (const cmd of cmds)
			if (cmd && typeof cmd === 'object' && (cmd as Command).at === undefined)
				(cmd as Command).at = new Date().toISOString()
		try {
			const { room } = await makeOrLoadRoom(c.id)
			const before = orderSignature(room.doc)
			const wrong = room.apply(cmds, c.by)
			if (!wrong) afterApply(c.id, room, before)
			// THE PROMISE `settle=1` MAKES: when this returns, Auto-order has finished
			// with the change it just made, and `seq` counts its moves too. A change
			// that cannot move the queue made no settle and returns at once.
			if (!wrong && wantsSettle(req)) await settledIfOrderChanged(c.id, room, before)
			await closeRoomIfUnused(c.id)
			// The rejection is `validateCommand`'s or `invalid()`'s own message,
			// unchanged. Inventing a friendlier one here would be a second copy of the
			// rules, and the caller can only correct itself against the real one.
			if (wrong) return reply.code(400).send({ error: wrong })
			return { ok: true, applied: cmds.length, seq: room.seq }
		} catch (err) {
			await closeRoomIfUnused(c.id)
			return fail(reply, err)
		}
	})

	// Archive the live document as the next version. Append-only, anyone may.
	api.post('/save', async (req, reply) => {
		const c = await ctx(req, reply)
		if (!c) return
		const note = String((req.body as { note?: unknown })?.note ?? '')
		try {
			const result = await saveRoom(c.id, note, c.by)
			const open = await getOpenRoom(c.id)
			open?.room.broadcast({ type: 'saved', ...result })
			await closeRoomIfUnused(c.id)
			return { ok: true, id: c.id, ...result }
		} catch (err) {
			await closeRoomIfUnused(c.id)
			return fail(reply, err)
		}
	})

	// The archive, oldest first. `meta=1` drops the documents — the History panel
	// needs them (it schedules each version to show what it landed on) but the top
	// bar only wants the newest note and its date.
	//
	// `last=1` IS THE ONE THAT SAVES ANYTHING. `meta=1` only trims the response:
	// the metadata lives inside each version object, so answering it still reads
	// every document out of the bucket and then throws them away — 2.9 MB of
	// storage reads to send 6.7 KB, on a call the page makes every time a plan
	// loads. `last=1` reads one object, which is all that caller ever wanted.
	api.get('/history', async (req, reply) => {
		const c = await ctx(req, reply)
		if (!c) return
		const q = req.query as { meta?: string; last?: string }
		const versions = q.last ? await loadLatest(c.id) : await loadHistory(c.id)
		return { versions: q.meta ? versions.map(({ doc, ...meta }) => meta) : versions }
	})

	// ONE OLD VERSION, READ-ONLY. View and compare; there is deliberately no way to
	// load one in place, because that would time-machine everyone in the room. The
	// operation that does change the room is /revert, and it says so.
	api.get('/version', async (req, reply) => {
		const c = await ctx(req, reply)
		if (!c) return
		const n = Number((req.query as { n?: string }).n)
		if (!Number.isInteger(n) || n < 1) return reply.code(400).send({ error: 'bad version number' })
		const v = await loadVersion(c.id, n)
		if (!v) return reply.code(404).send({ error: `no version ${n} in this plan` })
		return { n, ...v }
	})

	// The note is the ONLY mutable part of an entry. The snapshot itself is frozen:
	// an archive you can edit is not an archive.
	api.post('/histnote', async (req, reply) => {
		const c = await ctx(req, reply)
		if (!c) return
		const { n, note } = (req.body ?? {}) as { n?: unknown; note?: unknown }
		if (!Number.isInteger(n) || (n as number) < 1)
			return reply.code(400).send({ error: 'bad version number' })
		const v = await loadVersion(c.id, n as number)
		if (!v) return reply.code(404).send({ error: `no version ${n} in this plan` })
		await putVersion(c.id, n as number, { ...v, note: String(note ?? '') })
		return { ok: true }
	})

	// Discard the live document for EVERYONE and put version N in its place. The
	// broadcast names what it discarded; the discarded draft is archived first, so
	// the act is undoable by reverting again.
	api.post('/revert', async (req, reply) => {
		const c = await ctx(req, reply)
		if (!c) return
		const n = Number((req.body as { n?: unknown })?.n)
		if (!Number.isInteger(n) || n < 1) return reply.code(400).send({ error: 'bad version number' })
		try {
			const archived = await revertRoom(c.id, n, c.by)
			await closeRoomIfUnused(c.id)
			return { ok: true, from: n, archived }
		} catch (err) {
			await closeRoomIfUnused(c.id)
			return fail(reply, err)
		}
	})

	// --- Reading the schedule back --------------------------------------------
	//
	// Unblocked: `schedule.js` moved into `shared/`, so these run the same file the
	// page runs rather than anything re-derived. See scheduler.ts.
	//
	// BOTH TAKE A DOCUMENT AS WELL AS ANSWERING FOR THE STORED ONE, which is the
	// shape AGENTS.md documents and the reason it is useful: the question worth
	// asking is "what WOULD this cost", before the edit rather than after it. A
	// posted `doc` prices a hypothetical — it selects nothing, reads nothing, and
	// touches no room, so it is not a way to name a plan you were not given.

	/** Either the live document for this token's plan, or a hypothetical one the
	 *  caller posted. Opens no room for the posted case. */
	async function subject(c: Ctx, req: FastifyRequest): Promise<{ doc: unknown; opened: boolean }> {
		const posted = (req.body as { doc?: unknown } | undefined)?.doc
		if (posted) return { doc: posted, opened: false }
		const { room } = await makeOrLoadRoom(c.id)
		return { doc: room.doc, opened: true }
	}

	// WHAT CAN BE PICKED UP RIGHT NOW, and what is holding back everything else.
	//
	// The chart has always been able to say this and the API could not, which is
	// the exact drift ADR 0008 forbids: `sched` computes WHY each task starts
	// where it does and hangs it off its result with `Object.defineProperty`, so
	// it is non-enumerable and never survives `JSON.stringify`. An agent asking
	// "what should I do next" had to fetch `/schedule.js` and run the scheduler
	// itself.
	//
	// Same shape as `/verdict` — GET for the live plan, POST a `{doc}` to price
	// one that has not been sent.
	api.route({
		method: ['GET', 'POST'],
		url: '/ready',
		handler: async (req, reply) => {
			const c = await ctx(req, reply)
			if (!c) return
			try {
				const { doc, opened } = await subject(c, req)
				const out = readyRows(doc, (req.query as { all?: string }).all === '1')
				if (opened) await closeRoomIfUnused(c.id)
				return out
			} catch (err) {
				await closeRoomIfUnused(c.id)
				return fail(reply, err)
			}
		},
	})

	// WHAT DOES THIS PLAN LAND ON. Structural validation proves a document is
	// well-formed, never that it says what its author meant.
	api.route({
		method: ['GET', 'POST'],
		url: '/verdict',
		handler: async (req, reply) => {
			const c = await ctx(req, reply)
			if (!c) return
			try {
				const { doc, opened } = await subject(c, req)
				// A cycle throws out of sched() rather than returning a wrong answer, and
				// that is the behaviour worth preserving across the wire too.
				const out = verdict(doc)
				if (opened) await closeRoomIfUnused(c.id)
				return out
			} catch (err) {
				await closeRoomIfUnused(c.id)
				return fail(reply, err)
			}
		},
	})

	// WHICH ROW TO MOVE. `/verdict` says what the plan lands on; this says what it
	// would land on if the queues were in a better order — the one scheduling input
	// that leaves no trace in the document and no arrow on the chart.
	//
	// It suggests; it never applies. Each entry is measured against the CURRENT
	// order, so applying one invalidates the rest — apply a single
	// `{type:"moveTaskInLane", id, toIndex: to}` and ask again.
	api.route({
		method: ['GET', 'POST'],
		url: '/reorder',
		handler: async (req, reply) => {
			const c = await ctx(req, reply)
			if (!c) return
			const q = req.query as { limit?: string; maxLane?: string }
			const num = (v: string | undefined, d: number) => {
				const n = Number(v)
				return Number.isFinite(n) && n > 0 ? n : d
			}
			try {
				const { doc, opened } = await subject(c, req)
				// BOTH AXES OF ORDER FROM ONE CALL. Within a lane, which row to move;
				// across lanes, which team goes on top. An agent cannot press the Sort
				// button and AGENTS.md tells it not to drive the UI, so the law has to be
				// reachable here or it may as well not exist for half the tool's callers.
				//
				// OFF THE EVENT LOOP. This ran inline and it is the reason ECS replaced
				// this task six times on 2026-09-04: the search is synchronous, the
				// container has one thread, and ninety seconds of it meant `/health` went
				// unanswered past its 5s timeout. `reorder-pool.ts` has the full account —
				// including what this does NOT fix, which is the cost itself.
				const out = await runReorder(doc, { limit: num(q.limit, 20), maxLane: num(q.maxLane, 40) })
				if (opened) await closeRoomIfUnused(c.id)
				return out
			} catch (err) {
				await closeRoomIfUnused(c.id)
				return fail(reply, err)
			}
		},
	})

	// ---------------------------------------------------------------------------
	// THE WEBSOCKET
	// ---------------------------------------------------------------------------

	interface ClientHello {
		type: 'hello'
		token: string
		name?: string
		color?: string
		/** The client's position in the sequence, and which room instance it got that
		 *  position from. Both, or neither — see `join` in room.ts. */
		since?: { epoch: string; seq: number }
		/** Join without a presence: no cursor, no chip, not counted in `viewers`.
		 *  Sent at `hello` because that is when presence is created; the client
		 *  reconnects to change it rather than this becoming a second way to
		 *  mutate a room. */
		lurk?: boolean
	}

	type ClientFrame =
		| ClientHello
		| { type: 'cmd'; ref?: string; cmd: Command }
		| { type: 'presence'; name?: string; color?: string; cursor?: { day: number; laneRow: number } | null }
		| { type: 'save'; ref?: string; note?: string }
		| { type: 'revert'; ref?: string; n: number }

	/** What an `error` frame says. THE SOCKET IS THE PAGE'S LOAD PATH — a browser
	 *  never calls `GET /api/plan` — so this is where a storage outage reaches a
	 *  human, and it was reaching them as an empty string under a panel about
	 *  revoked tokens. Same wording and the same withholding of detail as `fail()`
	 *  on the HTTP side; everything else is still the validator's own words,
	 *  which are the only ones that can tell a caller what to fix. */
	const wireError = (err: unknown) =>
		err instanceof StorageDown
			? 'the plan store is unavailable'
			: err instanceof Error
				? err.message
				: String(err)

	api.register(async (app) => {
		app.get('/connect', { websocket: true }, (socket: WebSocket) => {
			const session: Session = {
				id: randomUUID(),
				send: (frame: ServerFrame) => {
					if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
				},
				close: () => socket.close(),
			}

			let planId: PlanId | undefined

			// EVERY FRAME IS HANDLED IN ORDER, one at a time. `hello` has to await an S3
			// load, and a client that sends `hello` then immediately `cmd` would
			// otherwise have the command reach a room that does not exist yet. Chaining
			// costs one promise per message and removes the whole class.
			let chain: Promise<void> = Promise.resolve()
			socket.on('message', (raw: Buffer) => {
				chain = chain.then(() => handle(raw)).catch((err: unknown) => {
					console.error('[ws] frame failed', planId, err)
					session.send({ type: 'error', error: wireError(err) })
				})
			})

			// KEEPALIVE, and it is not optional. Every hop between a client and this
			// process reaps an idle WebSocket on its own schedule — the ALB at 300s,
			// CloudFront on an undocumented one, a corporate proxy on whatever it likes.
			// Without a ping, a room where nobody happens to type has every socket
			// dropped underneath it, and this tool's whole purpose is a plan on a shared
			// screen while a meeting argues about dates: the room would reconnect en
			// masse mid-sentence. See PING_INTERVAL_MS for why it is sized the way it is.
			//
			// The pong also does dead-peer detection, which the idle monitor depends on.
			// A client that vanishes without a close frame — laptop lid, dropped Wi-Fi —
			// leaves a session attached forever, so the room never reaches zero sessions,
			// never closes, and `openRoomCount()` never returns 0. The service would then
			// never scale to zero, which is exactly the leak `closeRoomIfUnused` exists
			// to prevent on the HTTP side. A missed pong terminates the socket, which
			// fires 'close' below and tears the session down properly.
			let alive = true
			socket.on('pong', () => {
				alive = true
			})
			const heartbeat = setInterval(() => {
				if (!alive) return socket.terminate()
				alive = false
				socket.ping()
			}, PING_INTERVAL_MS)

			socket.on('close', () => {
				clearInterval(heartbeat)
				if (planId) leaveRoom(planId, session.id).catch((err: unknown) => console.error('[ws] leave failed', err))
			})

			async function handle(raw: Buffer): Promise<void> {
				let frame: ClientFrame
				try {
					frame = JSON.parse(raw.toString())
				} catch {
					return session.send({ type: 'error', error: 'frames must be JSON' })
				}

				if (frame.type === 'hello') {
					if (planId) return session.send({ type: 'error', error: 'already joined' })
					const id = await planFor(frame.token)
					if (!id) {
						session.send({ type: 'error', error: 'no such plan' })
						return socket.close()
					}
					try {
						const { room } = await makeOrLoadRoom(id)
						planId = id
						room.join(
							session,
							{
								// Prefilled with a random handle on the client and unverified here
								// — ADR 0002 again. A blank name is a real state, not an error.
								name: String(frame.name ?? '').slice(0, 60),
								color: String(frame.color ?? '').slice(0, 32),
							},
							frame.since,
							frame.lurk === true
						)
					} catch (err) {
						console.error('[ws] hello failed', id, err)
						session.send({ type: 'error', error: wireError(err) })
						socket.close()
					}
					return
				}

				if (!planId) return session.send({ type: 'error', error: 'send hello first' })
				const { room } = await makeOrLoadRoom(planId)

				switch (frame.type) {
					case 'cmd':
						// The rejection goes back to this session alone, carrying the ref it
						// sent, so the client rolls its optimistic copy back and shows the
						// validator's own words.
						{
							const before = orderSignature(room.doc)
							if (!room.apply([frame.cmd], nameOf(room.everyone(), session.id), { from: session, ref: frame.ref }))
								afterApply(planId, room, before)
						}
						return

					case 'presence':
						room.setPresence(session.id, frame)
						return

					case 'save': {
						const result = await saveRoom(planId, String(frame.note ?? ''), nameOf(room.everyone(), session.id))
						room.broadcast({ type: 'saved', ...result }, session)
						session.send({ type: 'saved', ref: frame.ref, ...result })
						return
					}

					case 'revert':
						await revertRoom(planId, frame.n, nameOf(room.everyone(), session.id))
						return

					default:
						session.send({ type: 'error', error: 'unknown frame' })
				}
			}
		})
	})
}, { prefix: '/api' })

const nameOf = (everyone: { sessionId: string; name: string }[], sessionId: string) =>
	everyone.find((p) => p.sessionId === sessionId)?.name || 'someone'

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
	if (err) {
		console.error(err)
		process.exit(1)
	}
	console.log(`timeline-studio sync server started on port ${PORT}`)
	// Scale the service to zero once no plans have been open for a while. No-op
	// locally and in the gate (ECS_CLUSTER unset); the wake Lambda scales it back.
	startIdleShutdown(openRoomCount)
})
