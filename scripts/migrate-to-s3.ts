#!/usr/bin/env bun
// ONE-SHOT MIGRATION. Lifts the local plan files into the S3 data bucket and
// mints the `shareToken` that replaces authentication (ADR 0002).
//
// Run it once per environment, then delete nothing and keep the token table.
//
// Why this exists instead of `aws s3 sync <dir> s3://bucket/`, which would do
// the upload in one line:
//   1. The source directory holds things that are NOT plans — a notes markdown
//      file and a dated `.backup-*/` folder of loose non-numbered snapshots. A
//      sync would push those too, and the backup files would land next to the
//      real archive where the History panel would try to read them.
//   2. Each plan needs a token minted, recorded in both directions, and NOT
//      re-minted if the migration is run twice (see `resolveExistingToken`).
//   3. Nothing in `sync` tells you that 21 of 22 archived versions arrived. That
//      is the failure this script is really built to catch — see `verify()`.
//
// SAFETY: the source directory is opened read-only. This script never writes to,
// renames, or deletes anything under it. The plan bucket does have object
// versioning, so an overwrite in the bucket is recoverable — the superseded
// object is retained as a noncurrent version for 90 days. That is a safety net
// for a mistake, not a licence: recovering means someone first has to NOTICE,
// and the failure this script guards against is the silent one.
//
// PRIVACY: plan bodies are a client's real delivery schedule. This script prints
// ids, file names, sizes and counts, and never a byte of document content — the
// JSON parse errors are deliberately re-thrown without the parser's message,
// because V8 and JSC both quote the offending input back at you.
//
// Usage:
//   bun scripts/migrate-to-s3.ts <source-dir> <bucket> --dry-run
//   bun scripts/migrate-to-s3.ts <source-dir> <bucket>            # asks first
//   bun scripts/migrate-to-s3.ts <source-dir> <bucket> --yes      # no pause
//   bun scripts/migrate-to-s3.ts --help
//
// Options:
//   --dry-run          scan and report what would happen; writes nothing
//   --prefix <p>       key prefix inside the bucket (default: none)
//   --region <r>       AWS region (default: $AWS_REGION)
//   --yes              skip the typed confirmation
//   --ecs-cluster <c>  } together, prove the sync server is stopped before
//   --ecs-service <s>  } writing. See "THE FLUSH HAZARD" below.
//   --expect-absent    with --ecs-cluster: assert the compute stack is not
//                      deployed yet, and have that verified. The safest run.
//   --prune-orphans    delete stranded token records instead of reporting them.
//                      Read the report first — see "ORPHANED TOKENS" below.
//   --force            migrate anyway with the sync server up. Read below first.
//   --fault <mode>     REHEARSAL ONLY: deliberately break the upload so you can
//                      watch verification fail. Refuses to run without
//                      S3_ENDPOINT set, so it cannot touch real AWS.
//                      modes: drop-version | corrupt-body
//
// THE FLUSH HAZARD — the reason this script refuses to run by default.
// The sync server holds each open plan in memory and debounce-flushes it to S3.
// A plan that is open in someone's browser while this runs gets the migrated
// object overwritten by that in-memory copy on the next flush. The flush is an
// unconditional PutObject with no precondition, so last writer wins. It is
// silent, and it looks exactly like the migration never ran — bucket versioning
// keeps the bytes, but only for someone who already suspects something is
// wrong. Nothing pre-warms the service, so an idle one is genuinely stopped —
// but any visitor opening a plan wakes it, so "probably nobody is connected" is
// a guess and this script does not run on guesses.
//
// So on a real run this script requires one of:
//   - `--ecs-cluster` + `--expect-absent`, and the cluster really is absent
//     (the documented happy path — docs/CUTOVER.md (removed at extraction; see git history) migrates before the compute
//     stack exists, so no writer can exist), or
//   - `--ecs-cluster` + `--ecs-service`, and the service's runningCount is 0, or
//   - `--force`, said out loud, as a last resort.
// The check runs again after the upload, because a visitor can wake the service
// mid-run and verification cannot see a write that lands after it.
// None of it applies when S3_ENDPOINT is set, because that is a local rehearsal.
//
// Credentials: ambient AWS creds (env or profile) — the OPERATOR's own SSO
// credentials, not the task role, so the compute stack's S3 grants say nothing
// about whether this will be allowed to write. There is a reachability preflight
// before the first upload for exactly that reason. Set S3_ENDPOINT to point the
// whole script at a local MinIO instead — same variable the sync server uses, so
// the migration can be rehearsed end to end offline before it goes near AWS.

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

// --- key layout -----------------------------------------------------------
// The plan and archive key names match the on-disk file names, which is the
// contract iac/data-template.yaml already publishes ("where the sync server
// reads/writes data/<id>.json and .history/<id>/NNNN.json"). Note this is a
// re-rooting, not a copy of the local paths: on disk `.history/` sits INSIDE the
// data directory, whereas in the bucket `data/` and `.history/` are siblings.
//
// Zero-padding NNNN is load-bearing: S3 returns keys in lexicographic order, so
// padded numbers list back in version order for free. `0010` after `0009`, not
// after `0001`. The original does the same thing — `api.ts`'s `history()` sorts
// the directory listing and parses `n` off the filename — so `n` stays out of
// the body here exactly as it is out of the body on disk.
//
// The token pair is the private-tldraw view-link idiom (sync-server/src/s3.ts):
// a forward record so a request carrying only a token can find its plan by
// direct key lookup — ADR 0002 forbids any endpoint that enumerates plans, so
// the server can never scan for a match — and a reverse record so re-running
// this script finds the token it already issued instead of orphaning every link
// that has been handed out.
//
// The forward key is the SHA-256 of the token, not the token. A raw token in the
// key would put the capability itself into S3 server access logs, CloudTrail
// data events, and any bucket listing — so a single `s3:ListBucket` would
// enumerate every capability in the system, which is precisely the plan
// enumeration ADR 0002 removed `/list` to prevent. Hashing costs one digest on
// resolution and makes a listing worthless. The ADR's warning that a hash is not
// a secret is about hashing a *guessable plan id*; a 128-bit random token has no
// preimage worth guessing. The reverse record still holds the real token,
// because a link has to be re-derivable, and it is keyed by plan id so listing
// it leaks nothing that knowing the client does not already leak.
const HISTORY_DIR = '.history'
const planKey = (id: string) => `data/${id}.json`
const versionKey = (id: string, n: number) => `${HISTORY_DIR}/${id}/${pad(n)}.json`
const tokenKey = (token: string) => `tokens/${createHash('sha256').update(token).digest('hex')}.json`
const planTokenKey = (id: string) => `plan-tokens/${id}.json`

const pad = (n: number) => String(n).padStart(4, '0')

// ADR 0002: ids are human-meaningful and become filenames. They are NOT secret
// and must never be treated as the capability.
const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i
const VERSION_FILE = /^(\d{4,})\.json$/

const FAULT_MODES = ['drop-version', 'corrupt-body'] as const
type Fault = (typeof FAULT_MODES)[number]

interface SourceFile {
	path: string
	bytes: number
	md5: string
	body: Buffer
}

interface SourceVersion extends SourceFile {
	n: number
}

interface SourcePlan {
	id: string
	doc: SourceFile
	versions: SourceVersion[]
}

interface Scan {
	plans: SourcePlan[]
	/** Entries under the source dir that are not plans. Reported, never uploaded. */
	ignored: string[]
	/** Anything that makes the source ambiguous. Non-empty means refuse to run. */
	problems: string[]
}

// --- source ---------------------------------------------------------------

/**
 * Read the whole source tree into memory. ~40 files of <30KB, so buffering all
 * of it is cheaper than being clever, and it means the upload pass and the
 * verify pass can each call this independently — which is the entire basis of
 * the verification being able to fail (see `verify`).
 */
async function scanSource(dir: string): Promise<Scan> {
	const ignored: string[] = []
	const problems: string[] = []

	const entries = await readdir(dir, { withFileTypes: true })
	const planIds: string[] = []
	for (const e of entries) {
		if (e.name === HISTORY_DIR) continue
		// `stat`, not the Dirent's `isFile()`. A Dirent reports a symlink as
		// neither file nor directory, so gating on `isFile()` files a symlinked
		// plan under "not a plan" and drops it — silently, if other plans migrate
		// alongside it. Not hypothetical: the source `data/` directory is itself a
		// symlink, and this repo uses symlinks deliberately to avoid drift
		// (`web/schedule.js` -> `../shared/schedule.js`). `stat` follows the link.
		const st = await stat(join(dir, e.name)).catch(() => undefined)
		if (!st) {
			problems.push(`${e.name} could not be resolved — broken symlink?`)
		} else if (st.isFile() && e.name.endsWith('.json')) {
			// A top-level .json here is overwhelmingly likely to BE a plan, so an id
			// that fails the pattern is refused rather than quietly filed under
			// "not a plan". The pattern comes from ADR 0002 and could legitimately
			// change; if it does, this stops the migration instead of silently
			// leaving a plan behind.
			if (PLAN_ID.test(e.name.slice(0, -5))) planIds.push(e.name.slice(0, -5))
			else problems.push(`${e.name} is a .json file whose name is not a valid plan id — is it a plan?`)
		} else {
			ignored.push(st.isDirectory() ? `${e.name}/` : e.name)
		}
	}
	planIds.sort()

	// Archive directories are enumerated separately rather than per-plan, so an
	// archive whose plan file is missing shows up as a problem instead of being
	// skipped by a loop that only ever looks at plans it already found.
	const archiveIds = await readdir(join(dir, HISTORY_DIR)).catch((): string[] => [])
	for (const id of archiveIds.sort()) {
		if (!planIds.includes(id)) {
			problems.push(`archive ${HISTORY_DIR}/${id}/ has no matching ${id}.json — orphaned history`)
		}
	}

	const plans: SourcePlan[] = []
	for (const id of planIds) {
		const doc = await readSourceFile(join(dir, `${id}.json`))
		requireObject(parseJson(doc, `${id}.json`), `${id}.json`, problems)

		const versions: SourceVersion[] = []
		const dirents = await readdir(join(dir, HISTORY_DIR, id)).catch((): string[] => [])
		for (const name of dirents.sort()) {
			const m = VERSION_FILE.exec(name)
			if (!m) {
				// Not silently skipped: an unrecognised file sitting in the archive
				// is either a version this script is about to drop, or junk that
				// would surface in the History panel. Either way a human decides.
				problems.push(`${HISTORY_DIR}/${id}/${name} is not a NNNN.json archive entry`)
				continue
			}
			const file = await readSourceFile(join(dir, HISTORY_DIR, id, name))
			const entry = parseJson(file, `${HISTORY_DIR}/${id}/${name}`)
			// `approx` is optional — the oldest entries predate it.
			if (!isObject(entry) || !isObject(entry.doc) || typeof entry.at !== 'string') {
				problems.push(`${HISTORY_DIR}/${id}/${name} is not a {at, note, doc} archive entry`)
			}
			versions.push({ ...file, n: Number(m[1]) })
		}

		// The numbering must be a contiguous 1..N run. A gap means a version was
		// already lost on disk, and this script would otherwise faithfully
		// reproduce the loss in S3 and call it a success. Only the first break is
		// reported — everything after it is the same gap counted again.
		const firstBreak = versions.findIndex((v, i) => v.n !== i + 1)
		if (firstBreak !== -1) {
			problems.push(
				`${id}: archive numbering breaks — expected ${pad(firstBreak + 1)}, found ${pad(versions[firstBreak]!.n)}`
			)
		}

		if (versions.length === 0) problems.push(`${id}: no archived versions found`)

		plans.push({ id, doc, versions })
	}

	if (plans.length === 0) problems.push(`no plan files found in ${dir}`)
	return { plans, ignored, problems }
}

async function readSourceFile(path: string): Promise<SourceFile> {
	const body = await readFile(path)
	// md5 to compare against S3's ETag, which for a single-part unencrypted or
	// SSE-S3 PUT *is* the md5 of the body. Not a security hash — it is the only
	// content digest S3 hands back in a LIST, so it costs zero extra requests.
	return { path, body, bytes: body.byteLength, md5: createHash('md5').update(body).digest('hex') }
}

/** Parse, discarding the parser's message — it quotes the input back at you. */
function parseJson(file: SourceFile, label: string): unknown {
	try {
		return JSON.parse(file.body.toString('utf8'))
	} catch {
		throw new Error(`${label}: not valid JSON (${file.bytes} bytes) — refusing to migrate`)
	}
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v)

function requireObject(v: unknown, label: string, problems: string[]): void {
	if (!isObject(v)) problems.push(`${label} is not a JSON object`)
}

// --- tokens ---------------------------------------------------------------

/**
 * 16 crypto-random bytes as base64url: 22 URL-safe characters, a full 128 bits.
 * Strictly more entropy than `crypto.randomUUID()`, which spends 6 of its 128
 * bits on the version and variant nibbles.
 *
 * Independent of the plan id by construction. ADR 0002 is explicit that ids are
 * guessable and must never become the capability, and that a plain hash of a
 * guessable id is not a secret either — so there is nothing derived here at all.
 */
function mintShareToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
}

/**
 * The token this plan was already given, if the migration has run before, plus
 * whether its forward record needs rebuilding.
 *
 * Reusing is the point: re-minting corrupts no data, but it silently invalidates
 * every link already sent to a collaborator. They get a 404 with no explanation,
 * and the only fix is an operator running scripts/list-plans.sh and reissuing a
 * link by hand — there is no /list endpoint they can help themselves with.
 *
 * ADR 0002 requires idempotency to key on BOTH records existing, never on either
 * alone, and a missing one to be repaired rather than skipped. So this reports
 * the two independently: a plan whose reverse record survived but whose forward
 * record did not still has a valid, already-distributed token — it just has no
 * way to resolve until the forward record is rewritten, which the caller then
 * does unconditionally.
 *
 * Reads are plain GETs with no versionId, which S3 answers with the current
 * version. A deleted record reads as absent (delete marker) rather than
 * resurrecting a noncurrent one, which is the behaviour we want: a deliberately
 * revoked token must not come back to life on the next run.
 */
async function resolveExistingToken(
	s3: Bun.S3Client,
	id: string
): Promise<{ token: string | undefined; forwardMissing: boolean }> {
	const rec: unknown = await s3
		.file(planTokenKey(id))
		.json()
		.catch(() => undefined)
	if (!isObject(rec) || typeof rec.shareToken !== 'string') return { token: undefined, forwardMissing: false }

	const token = rec.shareToken
	const fwd: unknown = await s3
		.file(tokenKey(token))
		.json()
		.catch(() => undefined)
	return { token, forwardMissing: !isObject(fwd) || fwd.id !== id }
}

/**
 * Forward token records that point at `id` but are not `id`'s current token.
 *
 * These are the residue of a run that died between the two writes: the forward
 * record landed, the reverse one did not, so the next run could not find the
 * token and minted a fresh one. The stranded record still grants full read/write
 * on the plan forever, and it cannot be revoked by key without the token that
 * was never persisted — the whole reason ADR 0002 insists on repair-on-run.
 *
 * Enumerating `tokens/` here is not the plan-enumerating endpoint the ADR
 * forbids: that prohibition is about the server's HTTP surface, and this is a
 * one-shot operator tool holding the operator's own credentials.
 */
async function findOrphanedTokenRecords(
	s3: Bun.S3Client,
	tokens: Map<string, string>
): Promise<{ key: string; id: string }[]> {
	const live = new Set([...tokens.values()].map(tokenKey))
	const orphans: { key: string; id: string }[] = []
	let continuationToken: string | undefined
	do {
		const res = await s3.list({ prefix: 'tokens/', continuationToken })
		for (const c of res.contents ?? []) {
			if (live.has(c.key)) continue
			const body: unknown = await s3
				.file(c.key)
				.json()
				.catch(() => undefined)
			// Scoped to plans THIS RUN migrated. A record pointing at some other plan
			// is not ours to judge: once the server is live it mints tokens for plans
			// created in the app, and to a script reading a laptop directory those are
			// indistinguishable from crash residue. Deleting one would silently revoke
			// the only access anyone has to that plan.
			if (isObject(body) && typeof body.id === 'string' && tokens.has(body.id)) {
				orphans.push({ key: c.key, id: body.id })
			}
		}
		continuationToken = res.isTruncated ? res.nextContinuationToken : undefined
	} while (continuationToken)
	return orphans
}

// --- upload ---------------------------------------------------------------

const JSON_TYPE = 'application/json'

/**
 * Upload one plan: the document, then every archived version in ascending order.
 *
 * Sequential on purpose. 38 objects of under 30KB do not need a concurrency
 * pool, and going in order means an interrupted run leaves a contiguous prefix
 * of the archive in the bucket rather than holes scattered through it — a
 * resumable state instead of a puzzle.
 *
 * Bodies are the source bytes verbatim, never a re-serialisation. The version
 * number lives in the key, not injected into the body, so the byte-count and
 * digest checks in `verify` compare like with like and actually mean something.
 */
async function uploadPlan(
	s3: Bun.S3Client,
	plan: SourcePlan,
	token: string,
	fault: Fault | undefined,
	faultVictim: boolean
): Promise<void> {
	const docBody = fault === 'corrupt-body' && faultVictim ? plan.doc.body.subarray(0, -1) : plan.doc.body
	await s3.write(planKey(plan.id), docBody, { type: JSON_TYPE })

	const dropped = fault === 'drop-version' && faultVictim ? plan.versions.at(-1)?.n : undefined
	for (const v of plan.versions) {
		if (v.n === dropped) continue
		await s3.write(versionKey(plan.id, v.n), v.body, { type: JSON_TYPE })
	}

	// Both directions of the token record. Forward first: if the run dies between
	// the two writes, the plan is reachable by its token (the thing a human is
	// holding) and the next run re-mints only because the reverse record is the
	// one missing — so write the reverse record last and re-run to converge.
	await s3.write(tokenKey(token), JSON.stringify({ id: plan.id }), { type: JSON_TYPE })
	await s3.write(planTokenKey(plan.id), JSON.stringify({ shareToken: token }), { type: JSON_TYPE })
}

// --- verify ---------------------------------------------------------------

/**
 * Confirm the bucket holds the migration, and fail loudly if it does not.
 *
 * The check is built so that it CAN fail, which rules out the obvious shapes:
 *
 *   - It does not compare the upload against the buffers the upload used. Both
 *     sides are derived independently — the expected side is a SECOND, fresh
 *     `scanSource` of the directory, and the actual side is a `LIST` of the
 *     bucket. Neither one is the loop's own bookkeeping.
 *   - It is not a per-object check inside the upload loop. A per-object check is
 *     structurally incapable of noticing a missing object, because the iteration
 *     that skipped version 22 also skips version 22's assertion. This is the
 *     "21 of 22 arrived" failure, and only a whole-set comparison sees it.
 *   - It compares key SETS, so an object landing under a wrong key fails twice
 *     over: missing where it should be, unexpected where it is.
 *
 * Per object it then checks the byte count and the ETag against the source md5.
 * If the bucket ever gains SSE-KMS the ETag stops being an md5; that is detected
 * and announced rather than quietly passing, and the size check still stands.
 *
 * DO NOT turn this into a recurring drift check. Archive objects are mutable:
 * `POST api/histnote` reads one version, rewrites its `.note`, and writes it
 * back. "Bucket bytes equal source bytes" is a true statement at migration time
 * and a false one the moment anybody edits a note, so a scheduled version of
 * this would alarm on entirely normal use.
 *
 * All reads here are of current versions — `ListObjectsV2` returns only current
 * objects (`ListObjectVersions` is the one that walks history), and the token
 * GETs pass no versionId. Bucket versioning therefore cannot make a stale
 * noncurrent object masquerade as a successful migration.
 */
async function verify(
	s3: Bun.S3Client,
	srcDir: string,
	tokens: Map<string, string>,
	before: Scan,
	pruneOrphans: boolean
): Promise<{ failures: string[]; digestsVerified: boolean }> {
	const failures: string[] = []
	const fresh = await scanSource(srcDir)
	failures.push(...fresh.problems.map((p) => `source changed under the migration: ${p}`))

	// Compare the two scans against EACH OTHER, not only each against the bucket.
	// Without this, a source that grew mid-run reports as `MISSING <key>` — the
	// same string a dropped upload produces, while demanding the opposite
	// response. An operator taught "MISSING means a bug" hunts a bug that is not
	// there; one taught "MISSING means re-run" eventually re-runs past a real
	// dropped object. Drift and loss get different words.
	const { drift, explained } = compareScans(before, fresh)
	failures.push(...drift)

	const expected = new Map<string, { bytes: number; md5: string }>()
	for (const plan of fresh.plans) {
		expected.set(planKey(plan.id), plan.doc)
		for (const v of plan.versions) expected.set(versionKey(plan.id, v.n), v)
	}

	const actual = await listAll(s3)
	let etagsUsable = true

	for (const [key, want] of expected) {
		// A discrepancy the drift report already accounts for is not reported twice
		// under a name that means something else.
		if (explained.has(key)) continue
		const got = actual.get(key)
		if (!got) {
			failures.push(`MISSING ${key} — uploaded object not in the bucket, STOP and investigate`)
			continue
		}
		if (got.size !== want.bytes) failures.push(`SIZE ${key}: source ${want.bytes}B, bucket ${got.size}B`)
		if (!/^[0-9a-f]{32}$/.test(got.etag)) {
			etagsUsable = false
		} else if (got.etag !== want.md5) {
			failures.push(`CONTENT ${key}: bucket bytes do not digest to the source's md5`)
		}
	}

	// An object under data/ or .history/ that the source does not account for is
	// a failure, not a curiosity: in the archive it becomes a version the History
	// panel offers a human to restore from.
	for (const key of actual.keys()) {
		const owned = key.startsWith('data/') || key.startsWith(`${HISTORY_DIR}/`)
		if (owned && !expected.has(key) && !explained.has(key)) {
			failures.push(`UNEXPECTED ${key} in the bucket but not in the source`)
		}
	}

	// Stated separately from the key-set comparison even though it is implied by
	// it, because the count is the number a human checks against the report.
	for (const plan of fresh.plans) {
		const prefix = `${HISTORY_DIR}/${plan.id}/`
		const n = [...actual.keys()].filter((k) => k.startsWith(prefix)).length
		if (n !== plan.versions.length) {
			failures.push(`VERSION COUNT ${plan.id}: source has ${plan.versions.length}, bucket has ${n}`)
		}
	}

	// Round-trip both token records by fresh read, so a plan cannot end up with a
	// token nobody can resolve back to it.
	for (const [id, token] of tokens) {
		const fwd: unknown = await s3.file(tokenKey(token)).json().catch(() => undefined)
		if (!isObject(fwd) || fwd.id !== id) failures.push(`TOKEN ${id}: tokens/<sha256>.json does not resolve to it`)
		const rev: unknown = await s3.file(planTokenKey(id)).json().catch(() => undefined)
		if (!isObject(rev) || rev.shareToken !== token) failures.push(`TOKEN ${id}: plan-tokens/${id}.json disagrees`)
	}

	// A forward record pointing at a migrated plan that is not that plan's current
	// token is a live capability nobody can account for. Deleting the key is the
	// ONLY revocation available for it — the token cannot be recovered from the
	// hash, which is the point of hashing it.
	//
	// Report by default, delete only on --prune-orphans. "Orphan" is defined from
	// what the source directory contains, and the source stops being authoritative
	// for tokens the moment the server is live, so the report has to be readable
	// enough for an operator to spot "wait, that's the plan I made last Tuesday"
	// before anything is removed.
	const orphans = await findOrphanedTokenRecords(s3, tokens)
	for (const { key, id } of orphans) {
		const reason = `points at "${id}", which this run wrote a DIFFERENT token for (${tokenKey(tokens.get(id)!)})`
		if (pruneOrphans) {
			await s3.file(key).delete()
			console.log(`  pruned orphan ${key}\n    ${reason}`)
		} else {
			failures.push(
				`ORPHAN TOKEN ${key}\n` +
					`    ${reason}\n` +
					'    It is a live link to that plan that nobody can account for, and its token\n' +
					'    cannot be recovered from the hash — deleting the key is the only revocation.\n' +
					'    Re-run with --prune-orphans to delete it, but read the line above first:\n' +
					'    if that plan legitimately has a second token, this is not an orphan.'
			)
		}
	}

	if (!etagsUsable) {
		console.log('  note: bucket ETags are not MD5s (SSE-KMS or multipart) — sizes verified, content digests not')
	}
	return { failures, digestsVerified: etagsUsable }
}

/**
 * How the source moved between the scan that drove the upload and the scan that
 * checks it, plus the keys whose bucket discrepancy that movement explains.
 *
 * The hazard here is staleness, not truncation. `/save` writes `data/<id>.json`
 * and `.history/<id>/NNNN.json` as two non-atomic writes, in that order, so a
 * scan landing between them captures a NEW document beside an OLD archive. The
 * bucket then holds a current document matching no archive entry, and the
 * version the owner actually saved — carrying the note they typed — can never
 * arrive, because the hosted server will compute `last.n + 1` and take that
 * number for its own first save.
 */
function compareScans(before: Scan, after: Scan): { drift: string[]; explained: Set<string> } {
	const drift: string[] = []
	const explained = new Set<string>()
	const beforeById = new Map(before.plans.map((p) => [p.id, p]))
	const afterIds = new Set(after.plans.map((p) => p.id))

	for (const now of after.plans) {
		const was = beforeById.get(now.id)
		if (!was) {
			drift.push(`SOURCE CHANGED UNDER THE MIGRATION: ${now.id} appeared on disk — re-run`)
			explained.add(planKey(now.id))
			for (const v of now.versions) explained.add(versionKey(now.id, v.n))
			continue
		}
		if (now.versions.length !== was.versions.length) {
			drift.push(
				`SOURCE CHANGED UNDER THE MIGRATION: ${now.id} grew ${was.versions.length} → ${now.versions.length} — re-run`
			)
			for (const v of now.versions) if (v.n > was.versions.length) explained.add(versionKey(now.id, v.n))
		}
		if (now.doc.md5 !== was.doc.md5) {
			drift.push(`SOURCE CHANGED UNDER THE MIGRATION: ${now.id} document was rewritten on disk — re-run`)
			explained.add(planKey(now.id))
		}
	}

	for (const was of before.plans) {
		if (!afterIds.has(was.id)) {
			drift.push(`SOURCE CHANGED UNDER THE MIGRATION: ${was.id} disappeared from disk — STOP, do not re-run blindly`)
		}
	}

	if (drift.length) {
		drift.push(
			'  ^ The source is not frozen. NNNN must mean exactly one version, on exactly\n' +
				'    one side — /save writes the document and the archive entry as two separate\n' +
				'    non-atomic writes, so a scan between them takes a new document with an old\n' +
				'    archive. Freeze the source (docs/CUTOVER.md (removed at extraction; see git history) step 1) and run this again.'
		)
	}
	return { drift, explained }
}

async function listAll(s3: Bun.S3Client): Promise<Map<string, { size: number; etag: string }>> {
	const out = new Map<string, { size: number; etag: string }>()
	let continuationToken: string | undefined
	do {
		const res = await s3.list({ continuationToken })
		for (const c of res.contents ?? []) {
			out.set(c.key, { size: c.size ?? -1, etag: normalizeEtag(c.eTag) })
		}
		continuationToken = res.isTruncated ? res.nextContinuationToken : undefined
	} while (continuationToken)
	return out
}

/**
 * S3 wraps the ETag in quotes. Some implementations (MinIO, via Bun's LIST
 * parser) hand it back with those quotes still XML-escaped as `&#34;`, which a
 * naive quote-strip leaves behind — the digest then never matches, the check
 * degrades to size-only, and the migration passes on a weaker guarantee than it
 * claims. Strip both spellings.
 */
function normalizeEtag(raw: string | undefined): string {
	return (raw ?? '').replace(/&#34;|&quot;|"/g, '').trim().toLowerCase()
}

// --- main -----------------------------------------------------------------

const HELP = `
migrate-to-s3.ts — one-shot migration of local plans into the S3 data bucket

  bun scripts/migrate-to-s3.ts <source-dir> <bucket> [options]

  --dry-run          report what would happen; write nothing
  --prefix <p>       key prefix inside the bucket
  --region <r>       AWS region (default: $AWS_REGION)
  --yes              skip the typed confirmation
  --ecs-cluster <c>  with --ecs-service, prove the sync server is stopped first
  --ecs-service <s>  a running server silently overwrites the migration
  --expect-absent    with --ecs-cluster, assert the compute stack is not deployed
                     yet and have that verified — the safest run
  --prune-orphans    delete stranded token records rather than reporting them
  --force            migrate with the sync server up (read the header comment)
  --fault <mode>     rehearsal only, requires S3_ENDPOINT: ${FAULT_MODES.join(' | ')}
  --help
`.trim()

function die(msg: string): never {
	console.error(`error: ${msg}`)
	process.exit(1)
}

/**
 * The banner the operator needs before they pick a moment to run this.
 *
 * Shown in dry runs too, because the dry run is when the cutover gets planned.
 */
function printCutoverBanner(): void {
	console.log(`
${'-'.repeat(78)}
THIS IS A CUTOVER, NOT A BACKGROUND JOB — see docs/CUTOVER.md (removed at extraction; see git history)
${'-'.repeat(78)}
THE INVARIANT: NNNN must mean exactly one version, on exactly one side.

Archive numbering is always last.n + 1. If the laptop and the hosted server are
both writing, both compute the same next number for different documents, there
is no merge story, and the loss is silent because the count stays plausible. So
the source must be FROZEN before this runs, and after go-live the laptop's
data/ must never accept another write — not "we'll be careful", stop opening the
old tool against that directory at all.

Re-running before go-live is safe and picks up new work: this is a full re-sync
from disk, not an incremental append. Every run re-reads the whole source,
re-uploads every version, and reuses the existing shareToken.

Re-running AFTER go-live is not a recovery path. By then the bucket is the
source of truth and the laptop is a stale fork.
${'-'.repeat(78)}`)
}

/**
 * What ECS says about the sync service.
 *
 * The shapes are kept distinct because they demand opposite responses, and
 * collapsing them is how a fail-closed gate quietly becomes a fail-open one:
 * `absent` is a positive fact that permits the migration, while `unknown`
 * (expired credentials, no network, AccessDenied) must never read as "nobody is
 * connected". Shells out to the aws CLI rather than adding the ECS SDK — it is
 * the one thing this script needs from ECS, and the CLI is the house tool for
 * AWS calls in the sibling deploy scripts.
 */
type EcsProbe =
	| { kind: 'running'; count: number }
	| { kind: 'cluster-absent' }
	| { kind: 'service-absent' }
	| { kind: 'unknown'; detail: string }

async function probeEcs(cluster: string, service: string): Promise<EcsProbe> {
	const res = await Bun.$`aws ecs describe-services --cluster ${cluster} --services ${service} --output json`
		.quiet()
		.nothrow()
	if (res.exitCode !== 0) {
		const stderr = res.stderr.toString()
		// A cluster that does not exist is the documented happy path for migrating
		// before the compute stack is deployed. Every other non-zero exit is a
		// question mark, not a green light.
		if (stderr.includes('ClusterNotFoundException')) return { kind: 'cluster-absent' }
		return { kind: 'unknown', detail: stderr.trim().split('\n').at(-1) ?? `aws exited ${res.exitCode}` }
	}
	try {
		const parsed = JSON.parse(res.stdout.toString()) as {
			services?: { runningCount?: number }[]
			failures?: { reason?: string }[]
		}
		const count = parsed.services?.[0]?.runningCount
		if (typeof count === 'number') return { kind: 'running', count }
		if (parsed.failures?.[0]?.reason === 'MISSING') return { kind: 'service-absent' }
		return { kind: 'unknown', detail: 'describe-services returned neither a service nor a MISSING failure' }
	} catch {
		return { kind: 'unknown', detail: 'could not parse describe-services output' }
	}
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		'dry-run': { type: 'boolean', default: false },
		prefix: { type: 'string', default: '' },
		region: { type: 'string' },
		yes: { type: 'boolean', default: false },
		'ecs-cluster': { type: 'string' },
		'ecs-service': { type: 'string' },
		'expect-absent': { type: 'boolean', default: false },
		'prune-orphans': { type: 'boolean', default: false },
		force: { type: 'boolean', default: false },
		fault: { type: 'string' },
		help: { type: 'boolean', default: false },
	},
})

if (values.help) {
	console.log(HELP)
	process.exit(0)
}

const [srcDir, bucket] = positionals
if (!srcDir || !bucket) die(`need <source-dir> and <bucket>\n\n${HELP}`)

const dryRun = values['dry-run']
const fault = values.fault as Fault | undefined
if (fault) {
	if (!(FAULT_MODES as readonly string[]).includes(fault)) {
		die(`unknown --fault mode ${fault} (want ${FAULT_MODES.join(' | ')})`)
	}
	// Structurally prevents a rehearsal flag from ever damaging the real
	// migration: without S3_ENDPOINT the client talks to AWS, so refuse.
	if (!process.env.S3_ENDPOINT) die('--fault requires S3_ENDPOINT — it is for rehearsing against MinIO, never AWS')
}

console.log(`\n→ scanning ${srcDir} (read-only)`)
const scan = await scanSource(srcDir)

let totalVersions = 0
let totalBytes = 0
for (const plan of scan.plans) {
	const versionBytes = plan.versions.reduce((a, v) => a + v.bytes, 0)
	totalVersions += plan.versions.length
	totalBytes += plan.doc.bytes + versionBytes
	console.log(
		`  ${plan.id}  doc ${kb(plan.doc.bytes)}  archive ${plan.versions.length} versions ` +
			`(${pad(1)}..${pad(plan.versions.length)}, ${kb(versionBytes)})`
	)
}
// Objects per plan: 1 document + N archive entries + the 2 token records.
const objectCount = scan.plans.length * 3 + totalVersions
console.log(`\n  ${scan.plans.length} plans, ${totalVersions} versions, ${kb(totalBytes)} — ${objectCount} objects to write`)
if (scan.ignored.length) console.log(`  not plans, will not be uploaded: ${scan.ignored.join(', ')}`)

if (scan.problems.length) {
	console.error('\nrefusing to migrate — the source is not in a state this script can migrate faithfully:')
	for (const p of scan.problems) console.error(`  - ${p}`)
	process.exit(1)
}

const s3 = new Bun.S3Client({
	bucket,
	region: values.region ?? process.env.AWS_REGION,
	endpoint: process.env.S3_ENDPOINT,
	// MinIO needs path-style addressing; real S3 does not care that this is set
	// only when an endpoint override is in play.
	virtualHostedStyle: process.env.S3_ENDPOINT ? false : undefined,
})

const target = `s3://${bucket}/${values.prefix}`

if (dryRun) {
	console.log(`\n→ DRY RUN — nothing will be written to ${target}`)
	for (const plan of scan.plans) {
		// Best effort: a dry run has to be useful on a laptop with no AWS creds,
		// so an unreachable bucket is reported, not fatal.
		const probe = await resolveExistingToken(s3, plan.id).catch(() => 'unreachable' as const)
		const verdict =
			probe === 'unreachable'
				? 'bucket unreachable — would mint a token if none exists'
				: probe.token
					? probe.forwardMissing
						? 'has a shareToken but its forward record is MISSING — would reuse and repair'
						: 'already has a shareToken — would REUSE it, not re-mint'
					: 'would mint a new 128-bit shareToken'
		console.log(`  ${plan.id}: ${verdict}`)
		console.log(`    ${planKey(plan.id)}  +  ${versionKey(plan.id, 1)} .. ${versionKey(plan.id, plan.versions.length)}`)
	}
	printCutoverBanner()
	console.log('→ dry run complete. No tokens were minted; re-run without --dry-run to migrate.\n')
	process.exit(0)
}

// --- the flush hazard gate -------------------------------------------------
const cluster = values['ecs-cluster']
const service = values['ecs-service']
// Whether the gate RUNS and whether it is REQUIRED are separate questions.
// It runs whenever the operator supplies ECS arguments, including during a local
// rehearsal — that is what makes the gate itself rehearsable. It is only
// *required* on a real run, because MinIO has no sync server in front of it.
const gateActive = Boolean(cluster && (service || values['expect-absent']))

if (gateActive && cluster) {
	const err = await syncServerHazard(cluster, service, values['expect-absent'])
	if (err && !values.force) die(err)
	if (err) console.log(`\n!! --force: proceeding past the sync-server check.\n   ${err.split('\n')[0]}`)
} else if (!process.env.S3_ENDPOINT) {
	if (!values.force) {
		die(
			'refusing to migrate without checking whether the sync server is running.\n' +
				'  A running server debounce-flushes its in-memory copy of any open plan over\n' +
				'  the objects this script writes, with no precondition — last writer wins, and\n' +
				'  it is silent. Bucket versioning keeps the bytes, but nothing tells you to\n' +
				'  go looking for them.\n\n' +
				'  Migrating BEFORE the compute stack exists is the documented happy path\n' +
				'  (the happy path in docs/CUTOVER.md (removed at extraction; see git history)). Say so and have it verified:\n' +
				'    --ecs-cluster <c> --expect-absent\n' +
				'  Or, if the stack does exist:\n' +
				'    --ecs-cluster <c> --ecs-service <s>\n' +
				'  --force skips the check entirely and should be the last resort.'
		)
	} else {
		console.log('\n!! --force: skipping the sync-server check. A live flush will silently undo this.')
	}
}

/**
 * The gate, as a reusable check: returns an error message, or undefined if the
 * sync server provably cannot write right now.
 *
 * Run at both ends of the migration. Once is not enough — nothing pre-warms the
 * service, but any visitor opening a plan calls the wake Lambda, so a run that
 * begins against a stopped service can have one started underneath it at any
 * moment. A task starting does not itself write (that needs a client session),
 * but it removes the only thing that was keeping the writer away.
 *
 * `--expect-absent` is the operator ASSERTING that the compute stack has not
 * been deployed, which this then verifies. It exists because the safest run of
 * all — before DNS points anywhere — has no cluster to query, and without it the
 * only way through the gate is `--force`. That would teach `--force` as the
 * normal path and spend the warning's credibility on the one run where it means
 * nothing. Asserting-and-verifying keeps the check fail-closed: a typo cannot
 * pass, because confirming absence is the assertion's whole job.
 */
async function syncServerHazard(
	clusterName: string,
	serviceName: string | undefined,
	expectAbsent: boolean
): Promise<string | undefined> {
	const probe = await probeEcs(clusterName, serviceName ?? 'unspecified')

	if (expectAbsent) {
		if (probe.kind === 'cluster-absent') {
			console.log(`\n→ confirmed: cluster ${clusterName} does not exist, so nothing can write`)
			return undefined
		}
		if (probe.kind === 'unknown') {
			return (
				`--expect-absent was passed, but the assertion could not be VERIFIED: ${probe.detail}\n` +
				'  This is not "the cluster is present" — it is "I could not tell", which fails\n' +
				'  closed for the same reason everything else here does. Fix the credentials or\n' +
				'  the cluster name and retry.'
			)
		}
		return (
			`--expect-absent was passed, but cluster ${clusterName} is NOT absent (${probe.kind}).\n` +
			'  The compute stack exists, so the assertion is false and the safe sequence has\n' +
			'  already been broken. Drop --expect-absent and pass --ecs-service <s> so the\n' +
			'  running count can actually be checked.'
		)
	}

	switch (probe.kind) {
		case 'running':
			if (probe.count === 0) {
				console.log(`\n→ sync server confirmed stopped (${serviceName} on ${clusterName}: runningCount=0)`)
				return undefined
			}
			return (
				`the sync server is UP (${serviceName} on ${clusterName}: runningCount=${probe.count}).\n` +
				'  A plan open in a browser will be flushed over your migration and it will look\n' +
				'  like this script never ran. Scale the service to 0 and retry — and note that\n' +
				'  a visitor can wake it again, so do not leave a long gap before the run.'
			)
		case 'service-absent':
			console.log(`\n→ service ${serviceName} does not exist on ${clusterName}, so nothing can write`)
			return undefined
		case 'cluster-absent':
			return (
				`cluster ${clusterName} does not exist.\n` +
				'  If that is expected — migrating before the compute stack is deployed — say so\n' +
				'  explicitly with --expect-absent so it is an assertion this can verify, rather\n' +
				'  than an error it has to guess the meaning of.'
			)
		case 'unknown':
			return (
				`could not determine whether the sync server is running: ${probe.detail}\n` +
				'  Refusing to guess. "I could not tell" is not "nobody is connected" — fix the\n' +
				'  credentials or the names and retry.'
			)
	}
}

// The operator's own SSO credentials are what authorise this, not the task role
// the compute stack grants S3 to — so failing here with a clear message beats a
// raw 403 from the first PutObject.
try {
	await s3.list({ maxKeys: 1 })
} catch (err) {
	die(
		`cannot read s3://${bucket} — ${(err as Error).name ?? 'request failed'}.\n` +
			'  This runs as YOUR credentials, not the sync server task role. Check that they\n' +
			'  are current and for the right account, and that the bucket name is right.'
	)
}

if (fault) {
	console.log(`\n!! FAULT INJECTION ACTIVE (--fault ${fault}) — this run will produce a BROKEN migration.`)
	console.log('!! It exists so you can watch verification fail. Verification SHOULD report errors below.')
}

if (!values.yes) {
	printCutoverBanner()
	console.log(`→ about to write ${scan.plans.length} plans and ${totalVersions} versions to ${target}`)
	console.log('  The source directory is not touched. Overwrites in the bucket are')
	console.log('  recoverable for 90 days as noncurrent versions — but only if someone notices.')
	if (prompt('  Type "migrate" to proceed (anything else aborts):')?.trim() !== 'migrate') {
		die('aborted — nothing was written')
	}
}

console.log(`\n→ uploading to ${target}`)
const tokens = new Map<string, string>()
for (const [i, plan] of scan.plans.entries()) {
	const { token: existing, forwardMissing } = await resolveExistingToken(s3, plan.id)
	const token = existing ?? mintShareToken()
	tokens.set(plan.id, token)
	await uploadPlan(s3, plan, token, fault, i === 0)
	const tokenNote = existing ? (forwardMissing ? 'token reused, forward record REPAIRED' : 'token reused') : 'token minted'
	console.log(`  ${plan.id}: ${1 + plan.versions.length} objects, ${tokenNote}`)
}

console.log('\n→ verifying against a fresh scan of the source and a fresh listing of the bucket')
const { failures, digestsVerified } = await verify(s3, srcDir, tokens, scan, values['prune-orphans'])

// Re-check the other writer at the END, not only at the start. Verification
// compares the bucket against the source at the moment it runs and cannot see a
// write that lands after it passes — and any visitor opening a plan can bring
// the service up mid-run via the wake Lambda. Same shape as
// re-scanning the source rather than trusting the upload loop's bookkeeping.
if (gateActive && cluster) {
	const late = await syncServerHazard(cluster, service, values['expect-absent'])
	if (late) {
		failures.push(
			`SYNC SERVER CAME UP DURING THE MIGRATION — ${late.split('\n')[0]}\n` +
				'  Verification above compared a snapshot; anything the server flushes after it\n' +
				'  ran is invisible to this check. Treat this migration as unverified.'
		)
	}
}
if (failures.length) {
	console.error(`\nVERIFICATION FAILED — ${failures.length} problem(s):`)
	for (const f of failures) console.error(`  - ${f}`)
	console.error('\nThe bucket does NOT faithfully hold the source. Do not delete the local data.')
	process.exit(1)
}
// Worded to match what was actually checked. When the ETags are not MD5s only
// the byte counts were compared, and saying "byte for byte" there would be a
// stronger claim than the evidence supports.
const strength = digestsVerified ? 'match the source byte for byte' : 'match the source in count and size (digests unavailable)'
console.log(`  ok — ${scan.plans.length} plans and ${totalVersions} versions ${strength}`)

// --- the only index that will ever exist ----------------------------------
const rule = '='.repeat(78)
console.log(`\n${rule}`)
console.log('SHARE TOKENS — SAVE THIS NOW, IN A PASSWORD MANAGER')
console.log(rule)
console.log('By design there is no /list endpoint and no plan picker (ADR 0002), so nothing')
console.log('the app can reach will ever show you this again. If it is lost, the recovery')
console.log('path is scripts/list-plans.sh — an operator tool, run from a laptop against the')
console.log('bucket with your own AWS credentials, not a route anyone can call.')
console.log('')
console.log('Anyone holding a token has full read/write on that plan. Treat each line as a')
console.log('credential: password manager, not Slack, not a ticket, not a shell history.')
console.log('')
console.log('A share link is the token on the end of the site:  <site>/#<token>  — nothing')
console.log('else needed, because the token names the plan. Never ?t= and never a path:')
console.log('browsers do not send fragments to servers, so the capability stays out of')
console.log('CloudFront and ALB access logs and out of Referer. A query string or a path')
console.log('puts it into all of them.')
console.log('')
for (const [id, token] of tokens) console.log(`  ${id}\n    ${token}`)
console.log(`\n${rule}\n`)

function kb(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)}KB`
}
