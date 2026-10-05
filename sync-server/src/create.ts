// CREATING A PLAN — the one thing this server could not do, and the reason New,
// Fork and Import all threw `noRoute("… no way to mint a share token from the
// page")`. Until this existed a person could open a plan they had a link to and
// could not make one, which is a tool with no front door.
//
// ONE ROUTE FOR THREE BUTTONS. Fork posts the document it is looking at, Import
// posts one out of a file, New posts nothing and gets the starter below. The
// three differ only in what the caller supplies, so three routes would be three
// copies of the same write with three chances to get the token pair wrong — and
// the token pair is the part ADR 0002 says must not be got wrong.
//
// THE ID IS DERIVED HERE AND RETURNED, never accepted. The page used to slug a
// title itself and then probe `idTaken` in a loop until it found a free one;
// both halves are gone. The probe was an existence oracle ADR 0002 refused to
// answer, and it failed OPEN when the backend was asleep — every id read as
// free, so the confirm that was meant to prevent an overwrite never fired. The
// server now picks the id and tells the caller which one it used, so there is
// nothing to predict and nothing to probe.

import { randomBytes } from 'node:crypto'
import { applyMigrations, SCHEMA, DEFAULT_TZ, todayISO } from '../../shared/schedule.js'
import type { Doc } from '../../shared/commands.js'
import { brand, planKey, planTokenKey, tokenKey, versionKey, type PlanId } from './keys'
import type { PlanStore } from './s3'
import { invalid, okId } from './validate'

/** The token's wire format, and ADR 0002 calls it normative: 16 crypto-random
 *  bytes as base64url, exactly 22 characters of `[A-Za-z0-9_-]`, a full 128 bits.
 *
 *  It is normative because more than one component has to recognise a token BY
 *  SHAPE — the page splits `#<token>&<view state>` and must also accept a bare
 *  `#<token>`, which it can only do by testing the shape of what it found. That
 *  test was `/^[0-9a-f]{32}$/` once, against a minting side that produced
 *  base64url, so a real token failed it and was silently discarded as malformed
 *  view state. Both sides were individually reasonable; nothing connected them.
 *  This regex is that connection on the server side, and the test asserts minted
 *  tokens against it. If the format changes it changes in the ADR first. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{22}$/

/** Independent of the plan id by construction. ADR 0002 is explicit that ids are
 *  guessable and must never become the capability, and that a plain hash of a
 *  guessable id is not a secret either — so nothing here is derived from
 *  anything. Strictly more entropy than `crypto.randomUUID()`, which spends 6 of
 *  its 128 bits on version and variant nibbles.
 *
 *  Same construction as `mintShareToken` in `scripts/migrate-to-s3.ts`, which is
 *  the other minting site; that one is Bun and reaches for `getRandomValues`,
 *  this one is Node and reaches for `randomBytes`. Both are the platform CSPRNG
 *  and both produce the format above, which is what `SHARE_TOKEN` is for. */
const mintShareToken = () => randomBytes(16).toString('base64url')

/** A plan id from a human's title — the rule the page used, moved server-side.
 *  Capped at 40 so a disambiguating suffix still fits inside the 64 characters
 *  `okId` allows. Falls back to `plan` rather than empty, because an empty id is
 *  a key of `data/.json`. */
const slug = (s: string) =>
	(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40) || 'plan'

const DAY_MS = 86_400_000

/** What `New` gets, and now THE ONLY COPY of it. The page built this itself and
 *  the server validated it, which is two descriptions of one shape waiting to
 *  disagree — and they had already started to. The page's version went to disk
 *  with no `schemaVersion` at all once, which the migration ladder reads as v1
 *  and then runs three upgrades over, including the one that multiplies every
 *  duration by seven. It also shipped without `shapes`, the one channel every
 *  task is required to point into.
 *
 *  Built here, stamped here, and put through the same `invalid()` a
 *  caller-supplied document goes through, so a starter this file gets wrong
 *  fails loudly at creation rather than quietly at whatever someone does next. */
function starter(title: string, timeZone: string): Doc {
	// TODAY IN THE PLAN'S ZONE. This was the UTC date — a third definition of
	// "today", beside the page's and the scheduler's — so a plan made in the
	// evening in the Americas started tomorrow.
	const today = todayISO({ timeZone })
	return {
		schemaVersion: SCHEMA,
		title,
		timeZone,
		// `order` was the picker's sort position. There is no picker, but it is
		// still a field of the schema, so it keeps meaning what it says.
		order: 99,
		start: today,
		sprint: { weeks: 2, start: today },
		colors: [{ id: 'c1', label: 'Workstream A', color: '#5aa9f0' }],
		borders: [
			{ id: 'b1', label: 'first', style: 'dotted' },
			{ id: 'b2', label: 'second', style: 'solid' },
		],
		fills: [
			{ id: 'known', label: 'known', pattern: 'underline' },
			{ id: 'estimate', label: 'estimated', pattern: 'solid' },
			{ id: 'guess', label: 'guessed', pattern: 'hatch' },
		],
		shapes: [{ id: 's1', label: '—', shape: 'soft' }],
		// NO MILESTONE. A new plan used to arrive with a 'Deadline' 84 days out that
		// nobody had asked for, and until recently it could not even be deleted - the
		// editor refused to drop the last one. A standing plan has no deadline to be
		// measured against, and inventing a date is worse than having none: the chart
		// reports a verdict against it, so the plan looks answered when it is not.
		milestones: [],
		lanes: [
			{ id: 'L1', label: 'Team one' },
			{ id: 'L2', label: 'Team two' },
		],
		tasks: [],
	}
}

export interface Created {
	/** The id the server actually used, which may not be the slug of the title if
	 *  that one was taken. The caller must use this rather than re-deriving it. */
	id: PlanId
	/** THE CAPABILITY. It goes in the response body and straight into the URL
	 *  fragment; it must not be logged, echoed into the document, or written into
	 *  a version note. See the route header in server.ts. */
	shareToken: string
}

export interface CreateInput {
	/** Names the plan and seeds its id. Optional; `doc.title` is the fallback. */
	title?: unknown
	/** The starting document — Fork's current one, Import's uploaded one.
	 *  Omitted by New, which gets `starter()`. UNTRUSTED. */
	doc?: unknown
	/** The note on the plan's first archived version. */
	note?: unknown
	/** IANA zone for a NEW plan — the creating browser sends its own. UNTRUSTED;
	 *  anything `Intl` does not know falls back to the default. Ignored when a
	 *  `doc` is supplied, which carries its own. */
	timeZone?: unknown
	/** Display name for attribution. Nothing verifies it (ADR 0002 removed the
	 *  identity provider that could have); it is a label, not a claim. */
	by: string
}

/**
 * Create a plan and mint its capability.
 *
 * The order of operations is the safety story, so it is worth reading as one:
 * validate, claim the id atomically, archive version 1, then write the token
 * pair last. A caller only ever receives a token for a plan that is already
 * completely on disk.
 */
/** A supplied document is taken at any schema and brought up the ladder —
 *  "migrated on the way in", as the API reference promises. It has no history in
 *  THIS plan, so any task the ladder has to date was added now. Anything that is
 *  not plan-shaped is passed through untouched for `invalid()` to name. */
function upgraded(raw: unknown): unknown {
	if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Doc).tasks)) return raw
	return applyMigrations(structuredClone(raw) as Doc, undefined, undefined, { now: new Date().toISOString() })
}

const zoneFrom = (z: unknown) => {
	try { if (typeof z === 'string') { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z } } catch {}
	return DEFAULT_TZ
}

export async function createPlan(store: PlanStore, input: CreateInput): Promise<Created> {
	const wanted = typeof input.title === 'string' ? input.title : ''
	const doc = (input.doc === undefined ? starter(wanted || 'New plan', zoneFrom(input.timeZone)) : upgraded(input.doc)) as Doc

	// THE UNTRUSTED INPUT IS THE DOCUMENT, and this is the check that exists for
	// it — the same `invalid()` every other write goes through, with its own
	// wording, because the caller can only correct itself against the real
	// message. Note this runs BEFORE anything is written, which is the whole
	// requirement: a document that cannot be stored must not create a plan, a
	// version and a capability on its way to being rejected.
	const wrong = invalid(doc)
	if (wrong) throw new Error(wrong)

	const id = await claimId(store, slug(wanted || (typeof doc.title === 'string' ? doc.title : '')), doc)

	// VERSION 1, ALWAYS. The note is the only description of this act a human ever
	// gets, and for a fork it is the only record anywhere that the plan was one —
	// nothing in the copied document says where it came from. It also means the
	// History panel is never empty, so "compare against the version before your
	// edit" works from the first edit rather than the second.
	await store.put(versionKey(id, 1), {
		at: new Date().toISOString(),
		note: String(input.note ?? 'created'),
		doc,
		by: input.by,
	})

	return { id, shareToken: await issueToken(store, id) }
}

/** How many disambiguating attempts before giving up. Each is a round trip, and
 *  the odds of five straight collisions on a random suffix are not worth a
 *  sixth. */
const SUFFIX_ATTEMPTS = 5

/** Four lowercase alphanumerics. Not a capability — it disambiguates a filename
 *  and ADR 0002 is emphatic that an id is not a secret — so the modulo bias here
 *  costs nothing and is not worth rejection-sampling away. */
const suffix = () => Array.from(randomBytes(4), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')

/**
 * Write the document under a free id and return it.
 *
 * THE CLAIM IS THE WRITE — see `putIfAbsent` in s3.ts for why checking first and
 * writing second is a race that loses somebody's plan.
 *
 * A TAKEN ID IS STEPPED OVER, NEVER ADOPTED, and that is the load-bearing line in
 * this file. Handing back a token for a plan that already exists would make this
 * route "mint me a capability for any plan whose title I can guess", and ADR 0002
 * says `eadvantage-member-api` is guessable on the first try by anyone who knows
 * the client. The existing plan is not read, not written, and not resolved; the
 * only thing that happens to it is that its key is found occupied.
 *
 * Random suffixes rather than `-2`, `-3`: they terminate in a bounded number of
 * round trips instead of scanning, and the default title is the same for
 * everybody, so `new-plan-2` … `new-plan-100` is a real sequence to walk.
 */
async function claimId(store: PlanStore, base: string, doc: Doc): Promise<PlanId> {
	for (let n = 0; n <= SUFFIX_ATTEMPTS; n++) {
		const id = n === 0 ? base : `${base}-${suffix()}`
		// `slug` cannot produce anything `okId` rejects, so this is a belt rather
		// than a branch — but it is the check that stops a string becoming an S3
		// key component, and it costs nothing to keep at the point of use.
		if (!okId(id)) throw new Error(`derived an unusable plan id ${JSON.stringify(id)}`)
		if (await store.putIfAbsent(planKey(id), doc)) return brand(id)
	}
	throw new Error('could not find a free plan id — try a different title')
}

/**
 * Mint the plan's capability and record it in both directions (ADR 0002).
 *
 * THE REVERSE RECORD IS WRITTEN FIRST, and the ordering does real work here even
 * though the ADR says repair-on-run makes ordering irrelevant. That claim is true
 * of the migration, which runs again over the same plan ids and repairs what it
 * finds. This path never revisits an id — a second create claims a different one
 * — so the crash window between the two writes is all there is, and the two
 * orders leave very different wreckage:
 *
 *   reverse first, then crash — `plan-tokens/<id>.json` holds the token and no
 *     forward record resolves it. Nothing was handed out, the plan is findable
 *     with `scripts/list-plans.sh`, and the token is revocable precisely because
 *     it is written down.
 *   forward first, then crash — `tokens/<sha256(token)>.json` resolves and grants
 *     full read/write forever, and nothing anywhere holds the token, so that key
 *     cannot be recomputed and the capability cannot be revoked. This is exactly
 *     the stranded record `findOrphanedTokenRecords` in the migration exists to
 *     sweep up, and the failure ADR 0002 calls out by name.
 *
 * REUSE RATHER THAN RE-MINT when a reverse record is already there: it means a
 * token was issued and may already have been sent to someone, and re-minting
 * would silently invalidate their link with no way back to the plan. That is ADR
 * 0002's rule that idempotency keys on both records existing and never on either
 * alone. On today's create path a fresh id cannot have one, so that branch is a
 * guard rather than a live case — it is here, and exported, so the rule is
 * asserted by a test rather than argued for in a comment.
 */
export async function issueToken(store: PlanStore, id: PlanId): Promise<string> {
	const existing = await store.getJson<{ shareToken?: unknown }>(planTokenKey(id))
	const token =
		typeof existing?.shareToken === 'string' && SHARE_TOKEN.test(existing.shareToken)
			? existing.shareToken
			: mintShareToken()

	await store.put(planTokenKey(id), { shareToken: token })
	await store.put(tokenKey(token), { id })
	return token
}
