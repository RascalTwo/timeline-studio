// CREATING A PLAN, against a Map instead of a bucket.
//
// The store is a fake rather than a mock — it really stores things, `putIfAbsent`
// really refuses an occupied key, and the assertions are about what ends up in
// it. That is what makes the interesting test writable at all: ADR 0002's central
// rule is about what a crash BETWEEN the two token writes leaves behind, and the
// only way to observe that is a store that can be told to fail on the second one.
//
// Nothing here imports the S3 client, so nothing here needs `DATA_BUCKET` or a
// container. `src/keys.ts` exists so that stays true.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createPlan, issueToken, SHARE_TOKEN } from '../src/create'
import { brand } from '../src/keys'
import { SCHEMA } from '../../shared/schedule.js'
import type { PlanStore } from '../src/s3'

/** A bucket that is a Map. `failOn` makes the next write to a matching key throw,
 *  which is how a crash mid-create is staged. */
class Fake implements PlanStore {
	readonly objects = new Map<string, unknown>()
	failOn: RegExp | undefined

	async getJson<T>(key: string): Promise<T | undefined> {
		return this.objects.has(key) ? (JSON.parse(JSON.stringify(this.objects.get(key))) as T) : undefined
	}
	async put(key: string, body: unknown): Promise<void> {
		if (this.failOn?.test(key)) throw new Error(`staged failure writing ${key}`)
		this.objects.set(key, body)
	}
	async putIfAbsent(key: string, body: unknown): Promise<boolean> {
		if (this.failOn?.test(key)) throw new Error(`staged failure writing ${key}`)
		if (this.objects.has(key)) return false
		this.objects.set(key, body)
		return true
	}
	keys(prefix: string) {
		return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
	}
}

const forwardKey = (token: string) => `tokens/${createHash('sha256').update(token).digest('hex')}.json`

/** A document that passes `invalid()`. Invented — nothing in this repo describes
 *  a real plan. */
const doc = (over: Record<string, unknown> = {}) => ({
	schemaVersion: 4,
	title: 'Borrowed Plan',
	start: '2026-08-17',
	lanes: [{ id: 'build', label: 'Build' }],
	borders: [{ id: 'b1', label: 'prod', style: 'solid' }],
	fills: [{ id: 'f1', label: 'known', pattern: 'solid' }],
	shapes: [{ id: 's1', label: 'none', shape: 'soft' }],
	colors: [],
	milestones: [],
	tasks: [{ id: 't1', label: 'dig', lane: 'build', border: 'b1', fill: 'f1', shape: 's1', color: [], dur: 5, deps: [] }],
	...over,
})

// --- New: the starter ------------------------------------------------------

test('Given no document, when a plan is created, then the starter is stored and it validates', async () => {
	const store = new Fake()

	const { id } = await createPlan(store, { title: 'Q3 Replatform', by: 'agent' })

	assert.equal(id, 'q3-replatform')
	const stored = (await store.getJson<{ schemaVersion: number; tasks: unknown[]; title: string }>(
		'data/q3-replatform.json'
	))!
	// `createPlan` puts the starter through `invalid()` itself, so reaching here at
	// all proves it validates. These pin the two things that were wrong the last
	// time a starter was built by hand and shipped.
	assert.equal(stored.schemaVersion, SCHEMA, 'an unstamped starter is read as v1 and gets three migrations run over it')
	assert.deepEqual(stored.tasks, [])
	assert.equal(stored.title, 'Q3 Replatform')
	assert.ok(Array.isArray((stored as { shapes?: unknown[] }).shapes), 'every task must have a `shapes` to point into')
	// AND NO INVENTED DEADLINE. The starter used to ship an 'm1 / Deadline' dated 84
	// days out that nobody asked for, which the chart then reported a verdict
	// against — so a brand-new plan looked like it had been answered. A plan with no
	// deadline is a real state and is now the state you start in.
	assert.deepEqual((stored as { milestones?: unknown[] }).milestones, [],
		'a new plan must not arrive with a milestone nobody asked for')
})

test('Given a title with nothing usable in it, when a plan is created, then the id is still a legal key', async () => {
	const store = new Fake()

	// An id of "" would be a key of `data/.json`, which is a real object in a real
	// bucket and belongs to nobody.
	const { id } = await createPlan(store, { title: '!!! ***', by: 'agent' })

	assert.match(id, /^[a-z0-9][a-z0-9-]{0,63}$/i)
	assert.equal(id, 'plan')
})

// --- Fork and Import: a supplied document ----------------------------------

test('Given a supplied document, when a plan is created, then that document is what is stored', async () => {
	const store = new Fake()

	const { id } = await createPlan(store, { doc: doc({ title: 'Forked Thing' }), note: 'forked from x', by: 'jo' })

	assert.equal(id, 'forked-thing', 'the id falls back to the document title when no title is given')
	assert.equal((await store.getJson<{ title: string }>(`data/${id}.json`))!.title, 'Forked Thing')
	const v1 = (await store.getJson<{ note: string; by: string }>(`.history/${id}/0001.json`))!
	// For a fork this note is the ONLY record anywhere that the plan was one —
	// nothing in the copied document says where it came from.
	assert.equal(v1.note, 'forked from x')
	assert.equal(v1.by, 'jo')
})

test('Given an invalid supplied document, when a plan is created, then it is refused and NOTHING is written', async () => {
	const store = new Fake()

	await assert.rejects(
		() => createPlan(store, { doc: doc({ tasks: [{ id: 't1', label: 'dig', dur: -1 }] }), by: 'agent' }),
		// `invalid()`'s own wording, not a friendlier one invented at the route.
		/dur must be a whole number of MINUTES, zero or more/
	)

	// The falsifier: a document that cannot be stored must not leave a plan, a
	// version or — worst — a live capability behind on its way to being rejected.
	assert.deepEqual([...store.objects.keys()], [], 'validation must run before the first write')
})

// --- Collisions ------------------------------------------------------------

test('Given the slug is taken, when a plan is created, then a different id is used and the existing plan is untouched', async () => {
	const store = new Fake()
	const first = await createPlan(store, { title: 'New plan', by: 'agent' })
	const before = JSON.stringify(store.objects.get(`data/${first.id}.json`))

	const second = await createPlan(store, { title: 'New plan', by: 'someone else' })

	assert.notEqual(second.id, first.id)
	assert.match(second.id, /^new-plan-[a-z0-9]{4}$/)
	// THE LOAD-BEARING ASSERTION. Adopting a taken id instead of stepping over it
	// would make this route "mint me a capability for any plan whose title I can
	// guess" — and ADR 0002 says the ids are guessable on the first try.
	assert.equal(JSON.stringify(store.objects.get(`data/${first.id}.json`)), before, 'the existing plan was rewritten')
	assert.notEqual(second.shareToken, first.shareToken)
	assert.equal(
		(await store.getJson<{ id: string }>(forwardKey(second.shareToken)))!.id,
		second.id,
		'the new token must not resolve to the plan that was already there'
	)
})

// --- The token pair (ADR 0002) ---------------------------------------------

test('Given a plan is created, when the token is minted, then it matches the normative wire format', async () => {
	const store = new Fake()

	const { shareToken } = await createPlan(store, { title: 'Shape Test', by: 'agent' })

	// 22 characters of base64url. The page discriminates a token from view state by
	// this shape alone; it tested `/^[0-9a-f]{32}$/` once, against a minting side
	// that produced exactly this, and silently discarded every real token.
	assert.match(shareToken, SHARE_TOKEN)
	assert.equal(shareToken.length, 22)
})

test('Given a plan is created, when the records are read, then BOTH exist and the forward key is the hash', async () => {
	const store = new Fake()

	const { id, shareToken } = await createPlan(store, { title: 'Both Records', by: 'agent' })

	// Forward: `tokens/<sha256(token)>.json` -> {id}. The hash is recomputed here
	// rather than borrowed from the implementation, so this checks the layout
	// rather than checking the code against itself.
	assert.deepEqual(await store.getJson(forwardKey(shareToken)), { id })
	// Reverse: `plan-tokens/<id>.json` -> {shareToken}. This one holds the real
	// token, because a link has to be re-derivable when someone loses theirs.
	assert.deepEqual(await store.getJson(`plan-tokens/${id}.json`), { shareToken })
	// And the raw token is NOT a key anywhere: `s3:ListBucket` must not enumerate
	// capabilities, which is the entire reason the forward key is hashed.
	assert.equal(
		[...store.objects.keys()].some((k) => k.includes(shareToken)),
		false
	)
})

test('Given the forward write fails, when creation crashes, then the token is on record and grants nothing', async () => {
	const store = new Fake()
	// A crash in the window ADR 0002 names: between the two token writes.
	store.failOn = /^tokens\//

	await assert.rejects(() => createPlan(store, { title: 'Half Made', by: 'agent' }))

	// Reverse first means the wreckage is RECOVERABLE. The token was written down,
	// so `scripts/list-plans.sh` finds the plan and the capability can be revoked
	// by simply never writing the forward record.
	const rev = (await store.getJson<{ shareToken: string }>('plan-tokens/half-made.json'))!
	assert.match(rev.shareToken, SHARE_TOKEN)
	// The falsifier for the ordering, and the failure the ADR calls out by name:
	// had the forward record landed first, it would resolve forever while nothing
	// anywhere held the token, so `tokens/<sha256(token)>` could not be recomputed
	// and the capability could not be revoked. Flip the two writes in
	// `issueToken` and this line goes red.
	assert.deepEqual(store.keys('tokens/'), [], 'an unrevokable capability was stranded')
	assert.equal(await store.getJson(forwardKey(rev.shareToken)), undefined)
})

test('Given a plan that already has a reverse record, when a token is issued, then the existing one is reused', async () => {
	const store = new Fake()
	const id = brand('already-issued')
	const handedOut = await issueToken(store, id)
	// Simulate the forward record having been lost — a delete, a crash, a bucket
	// mishap. The token is still valid and may already be in somebody's chat log.
	store.objects.delete(forwardKey(handedOut))

	const again = await issueToken(store, id)

	// ADR 0002: idempotency keys on BOTH records existing, never on either alone,
	// and a missing one is REPAIRED rather than skipped. Re-minting here would
	// corrupt no data and would silently kill a link already sent to a
	// collaborator — with no `/list`, there is no way back to the plan afterwards.
	assert.equal(again, handedOut, 're-minting invalidates a link that is already out')
	assert.deepEqual(await store.getJson(forwardKey(handedOut)), { id }, 'the missing record must be repaired')
})

// --- The token must not reach a log ----------------------------------------

test('Given a plan is created, when the console is watched, then the token appears in nothing written to it', async () => {
	const store = new Fake()
	const said: string[] = []
	const real = { log: console.log, warn: console.warn, error: console.error }
	const spy = (...args: unknown[]) => void said.push(args.map((a) => String(a)).join(' '))
	console.log = console.warn = console.error = spy

	let shareToken: string
	try {
		;({ shareToken } = await createPlan(store, { title: 'Quiet Please', by: 'agent' }))
	} finally {
		Object.assign(console, real)
	}

	// ADR 0002: the capability must not become a routine field in operational data,
	// and CloudWatch is operational data. `resolveToken` already follows this rule
	// — it logs the id when a record is unusable, never the token. The falsifier is
	// direct: add a `console.log(token)` anywhere on this path and this goes red.
	for (const line of said) assert.equal(line.includes(shareToken!), false, `the token was logged: ${line}`)
})
