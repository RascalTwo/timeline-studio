import {
	GetObjectCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'
import type { Doc } from '../../shared/commands.js'
import { brand, historyPrefix, planKey, tokenKey, versionKey, versionNumber, type PlanId } from './keys'
import { okId } from './validate'

/** Re-exported so the rest of the server has one import for the plan-store
 *  surface. The type itself lives in keys.ts, which has no S3 client. */
export type { PlanId }

const BUCKET = process.env.DATA_BUCKET
if (!BUCKET) throw new Error('DATA_BUCKET environment variable is required')

// In prod, talk to real S3 with the task role's ambient creds + region (the
// `{}` config). For local dev and the NAS, set S3_ENDPOINT to an S3-compatible
// server (Versity Gateway; MinIO until 2026-10) so the entire data path runs
// offline. It needs path-style addressing and explicit creds (the `minioadmin`
// pair is only the local default, a leftover name); the prod path is
// byte-for-byte unchanged whenever S3_ENDPOINT is unset.
const s3 = new S3Client(
	process.env.S3_ENDPOINT
		? {
				endpoint: process.env.S3_ENDPOINT,
				region: process.env.AWS_REGION ?? 'us-east-1',
				forcePathStyle: true,
				credentials: {
					accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'minioadmin',
					secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'minioadmin',
				},
			}
		: {}
)

// Every key is built in keys.ts — see the note there for why they are not here.

/** An archived version, exactly the shape the original tool wrote. `approx` rides
 *  along untouched — it marks a date that was reconstructed rather than recorded,
 *  and dropping it would promote a guess to a fact. */
export interface Version {
	at: string
	approx?: boolean
	note: string
	doc: Doc
	by?: string
}

/** A storage failure, as opposed to something the caller got wrong. The HTTP
 *  layer answers this with 503 and the top-level handler's fixed wording — see
 *  `fail()` in server.ts. Before it existed every one of these came back as
 *  `400 {"error":""}`, which told a reader their token was bad while the real
 *  problem was that the bucket was gone.
 *
 *  THE CAUSE IS FOR THE LOG, NEVER FOR A RESPONSE. The SDK's message names the
 *  bucket and the endpoint, and everyone holding a share link would see it.
 *
 *  `why()` exists because the message is sometimes EMPTY, which is how this
 *  stayed invisible: a dead endpoint on `localhost` is TWO connection attempts
 *  (::1 and 127.0.0.1) and node reports both as an `AggregateError` whose own
 *  `message` is `''` and whose detail is in `.errors`. Anything that prints
 *  `err.message` prints nothing at all. */
export class StorageDown extends Error {
	override readonly name = 'StorageDown'
	constructor(cause: unknown) {
		super(why(cause), { cause })
	}
}

const why = (e: unknown): string =>
	e instanceof AggregateError ? e.errors.map(why).join('; ') || e.message || e.name
		: e instanceof Error ? e.message || e.name
			: String(e)

/** Every call to the bucket ends here, so a storage failure is classified in one
 *  place rather than at each of the dozen callers. The two answers a caller DOES
 *  interpret — `NoSuchKey` and `PreconditionFailed` — are read off the original
 *  error before it is wrapped; see `getJson` and `putIfAbsent`. */
const down = (err: unknown): never => {
	throw new StorageDown(err)
}

function isNotFound(err: unknown): boolean {
	const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
	return e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404
}

async function getJson<T>(Key: string): Promise<T | undefined> {
	try {
		const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }))
		return JSON.parse(await res.Body!.transformToString()) as T
	} catch (err) {
		if (isNotFound(err)) return undefined
		return down(err)
	}
}

// `null, 1` matches what the original tool wrote and what the migration copied,
// so a plan that round-trips through this server is diffable against its own
// backup instead of collapsing to one line.
const putJson = (Key: string, body: unknown, extra: { IfNoneMatch?: string } = {}) =>
	s3.send(
		new PutObjectCommand({
			Bucket: BUCKET,
			Key,
			Body: JSON.stringify(body, null, 1),
			ContentType: 'application/json',
			...extra,
		})
	)

// --- The live shared draft ------------------------------------------------

export const loadPlan = (id: PlanId) => getJson<Doc>(planKey(id))
export const savePlan = (id: PlanId, doc: Doc) => putJson(planKey(id), doc).catch(down)

// --- The append-only archive ----------------------------------------------

/** Version numbers present for a plan, ascending.
 *
 *  PAGINATED, and not as ceremony: a truncated listing produces a wrong "highest
 *  N", and the next save then writes over a version that already exists. Bucket
 *  versioning would keep the overwritten object, but only if someone noticed. */
export async function listVersionNumbers(id: PlanId): Promise<number[]> {
	const out: number[] = []
	let ContinuationToken: string | undefined
	do {
		const res = await s3
			.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: historyPrefix(id), ContinuationToken }))
			.catch(down)
		for (const o of res.Contents ?? []) {
			const n = versionNumber(o.Key?.slice(historyPrefix(id).length) ?? '')
			if (n !== undefined) out.push(n)
		}
		ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
	} while (ContinuationToken)
	return out.sort((a, b) => a - b)
}

export const loadVersion = (id: PlanId, n: number) => getJson<Version>(versionKey(id, n))
export const putVersion = (id: PlanId, n: number, v: Version) => putJson(versionKey(id, n), v).catch(down)

/** Every version, oldest first, each carrying its whole document — the History
 *  panel shows what each one landed on and only the browser's scheduler can
 *  compute that.
 *
 *  ponytail: reads the whole archive, and only the History panel needs that —
 *  it schedules every version to say what each one landed on. Measured
 *  2026-09-20: 2.9 MB over 50 versions, and it grows by the size of the whole
 *  document on every save. The panel is opened deliberately and rarely, so this
 *  is the ceiling it is allowed to have; `loadLatest` is what the paths that run
 *  on every page load use instead. If the PANEL itself ever gets slow, the fix
 *  is to keep each version's stats beside its metadata rather than re-deriving
 *  them from the document. */
export async function loadHistory(id: PlanId): Promise<Array<Version & { n: number }>> {
	const ns = await listVersionNumbers(id)
	const versions = await Promise.all(ns.map(async (n) => ({ n, ...(await loadVersion(id, n))! })))
	return versions.filter((v) => v.doc !== undefined)
}

/** The newest version, as a list of nothing or one, so a caller that wants "the
 *  last save" reads ONE object instead of the whole archive.
 *
 *  A list because the route returns `versions` either way, and the shape of that
 *  answer should not depend on which question was asked. */
export async function loadLatest(id: PlanId): Promise<Array<Version & { n: number }>> {
	const ns = await listVersionNumbers(id)
	const n = ns[ns.length - 1]
	if (n === undefined) return []
	const v = await loadVersion(id, n)
	return v?.doc ? [{ n, ...v }] : []
}

// --- Capability tokens (ADR 0002) -----------------------------------------


/** Resolve a share token to a plan id, or `undefined`. There is no other auth.
 *
 *  THIS DIRECTION IS THE ONLY ONE AVAILABLE FOR AN EXISTING PLAN. It used to be
 *  the only one at all — the note here said nothing in this server could turn a
 *  plan id into a token — and `create.ts` changes that, so read the difference
 *  carefully rather than the old sentence: `issueToken` mints a token for a plan
 *  id it has just CLAIMED, one that provably did not exist a moment earlier. It
 *  cannot be pointed at a plan that is already there. If a route ever mints for
 *  an arbitrary id, that is "give me a capability for any plan whose title I can
 *  guess", which is the enumeration ADR 0002 removed `/list` to prevent.
 *
 *  THE TRUST BOUNDARY IS HERE, which is why the id is checked here rather than
 *  at the S3 calls downstream. The record's `id` becomes a key component, so a
 *  token record holding `{"id":"../../elsewhere"}` — corrupted, or written by
 *  something that should not have — would otherwise build a key that walks out of
 *  its prefix. A bad record is treated as no record: the token resolves to
 *  nothing and the caller gets the same 404 an unknown token gets. */
export async function resolveToken(token: string): Promise<PlanId | undefined> {
	const record = await getJson<{ id: string }>(tokenKey(token))
	if (!record) return undefined
	if (!okId(record.id)) {
		// The id, not the token — logging the token would write the capability into
		// CloudWatch, which is the exact thing hashing the key avoids.
		console.error('[token] record resolves to an unusable plan id', JSON.stringify(record.id))
		return undefined
	}
	return brand(record.id)
}

// --- The raw object surface, as a seam -------------------------------------

/** The three operations `create.ts` needs, named as an interface so a test can
 *  supply a Map instead of a bucket.
 *
 *  This is the `CommandRoom`-takes-a-`Session` trick again, and for the same
 *  reason: the properties worth testing here are not reachable through real S3.
 *  ADR 0002's central safety rule is about what a crash BETWEEN two writes
 *  leaves behind, and the only way to assert that is to run the create path
 *  against a store that can be told to fail on the second one. */
export interface PlanStore {
	getJson<T>(key: string): Promise<T | undefined>
	put(key: string, body: unknown): Promise<void>
	/** Write only if the key is absent; `false` means it was already there and
	 *  nothing was written. */
	putIfAbsent(key: string, body: unknown): Promise<boolean>
}

/** The real bucket. */
export const bucket: PlanStore = {
	getJson,
	put: async (key, body) => void (await putJson(key, body).catch(down)),

	// ATOMIC, VIA `If-None-Match: *`. S3 answers 412 `PreconditionFailed` when the
	// key already exists, which turns "is this plan id free" and "take it" into one
	// operation. A read-then-write would be a race whose losing side is somebody's
	// plan overwritten by a fresh starter document, with no error raised anywhere —
	// and the two racers are two people clicking New at the same time, which is not
	// exotic given the default title is the same for everyone.
	//
	// Verified against the servers this runs on (MinIO, then Versity Gateway), not
	// just against the S3 docs: without enforcement this silently degrades to a
	// plain overwrite, which is the failure that looks like success. If the storage
	// substrate is ever swapped, run `scripts/s3-conformance.mjs` against it first.
	putIfAbsent: async (key, body) => {
		try {
			await putJson(key, body, { IfNoneMatch: '*' })
			return true
		} catch (err) {
			const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
			if (e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412) return false
			return down(err)
		}
	},
}

// --- Readiness -------------------------------------------------------------

/** Can this process reach the bucket at all — the one question `/health` cannot
 *  answer and the reason `/api/readyz` exists. A HEAD on the bucket: no object
 *  read, no listing, and it fails the same way every other call fails when the
 *  store is gone.
 *
 *  ponytail: no caching. Nothing polls readiness — a poll would hold the service
 *  awake and defeat the idle shutdown this tool scales to zero with — so the
 *  only callers are `scripts/smoke.sh` and a human. Memoise it the day something
 *  starts probing it on an interval. */
export const storeReachable = () =>
	s3
		.send(new HeadBucketCommand({ Bucket: BUCKET }))
		.then(() => true)
		.catch(() => false)
