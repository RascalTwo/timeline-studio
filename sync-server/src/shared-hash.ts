// THE PARITY CONTRACT (ADR 0001), covering every shared file rather than just the
// scheduler.
//
// The page loads shared files from the S3 bucket; this process imports them out of
// a container image. Two artifacts, two pipelines, two deploy times — a web-only
// deploy or a backend rollback skews them while the repo still holds exactly one
// copy, so a repo-level byte diff passes and production is wrong.
//
// A SCHEDULER DRIFT MAKES THE DATES DISAGREE, which is at least a number a human
// might catch. A COMMANDS DRIFT IS WORSE: client and server disagree about what an
// edit MEANS — a field one side sets and the other drops, a validation rule the
// client believes it satisfies. Nothing errors at all.
//
// WHY A MAP AND NOT A COMBINED DIGEST. ADR 0001 is explicit: one digest over
// everything would say the sides disagree without saying which file, and "the
// protocol drifted" and "the scheduler drifted" want different responses from
// whoever is holding the pager.
//
// WHY THIS SIDE REPORTS EVERYTHING IN `shared/`, and does not try to work out what
// ships to the bucket. It cannot: what reaches the bucket is decided by the
// symlinks in `web/`, and the Dockerfile deliberately does not copy `web/` into
// this image (the server is required to have no dependency on it). So the
// division of labour is that this reports a SUPERSET — every shared file it has,
// including server-only ones the bucket never gets — and
// `scripts/assert-schedule-parity.sh` derives the files it actually cares about
// from `web/`'s symlinks and looks each one up here.
//
// That keeps the check fail-closed in the direction that matters: a file the
// script wants and this map does not contain is a FAILURE, never a pass.

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The directory the shared modules were ACTUALLY LOADED FROM, resolved through
 *  the module system rather than reconstructed as a path. Anchoring it to a real
 *  import is what keeps "the files this process loaded" true — a hand-written path
 *  could name a directory the process never read, which is the lie this endpoint
 *  exists to make impossible. `schedule.js` is the anchor because `scheduler.ts`
 *  imports it, so if it is not there this server has already failed to start. */
const SHARED_DIR = dirname(fileURLToPath(import.meta.resolve('../../shared/schedule.js')))

/** Filename → sha256 of the bytes on disk, for every file in `shared/`.
 *
 *  NAMED FOR THE WIRE KEY IT BECOMES, deliberately. `healthBody` below builds the
 *  response with ES6 shorthand, so a variable called anything else would silently
 *  emit that other name — which is exactly the bug this once shipped: the map was
 *  called `sharedSha256`, the shorthand published `sharedSha256`, and the parity
 *  gate reading `shared` got `null` on every deploy. Keeping the two identical
 *  makes the wire contract and the variable the same fact.
 *
 *  It is `shared` rather than `sharedSha256` because it is not a sha256 — it is a
 *  map of them, and a rollup digest is deliberately NOT offered: the image carries
 *  all of `shared/` while the bucket carries only what `web/` symlinks, so the two
 *  sides legitimately cover different sets and only a per-file subset check can
 *  express that. ADR 0001 and `scripts/assert-shared-parity.sh` both say `shared`. */
export const shared: Record<string, string> = {}

/** THE HEALTH RESPONSE, built once and used by both routes.
 *
 *  It lives here rather than in server.ts so it can be asserted in a unit test
 *  with no S3 and no socket — see test/health.test.ts. The wire key is the thing
 *  most likely to drift from its consumer and the least likely to be noticed,
 *  because every side is independently reasonable. */
export function healthBody() {
	return { ok: true, shared, commit }
}

// THE COMMIT THE IMAGE WAS BUILT FROM, which a build arg IS the right source for —
// unlike the digests below, this one is a label, not a measurement. The NAS
// deployer compares it with the commit it was told to deploy; `null` outside a CI
// image (local dev, the gate), where nothing is deployed.
const commit = process.env.GIT_SHA || null

// COMPUTED AT STARTUP FROM THE FILES ON DISK IN THE IMAGE. Never a build arg and
// never an env var: both can only confirm what the BUILD believed, and the failure
// being caught is a running server disagreeing with what shipped alongside it, so
// the running server has to be the one doing the measuring.
{
	const entries = await readdir(SHARED_DIR, { withFileTypes: true })
	for (const e of entries) {
		if (!e.isFile()) continue
		shared[e.name] = createHash('sha256').update(await readFile(join(SHARED_DIR, e.name))).digest('hex')
	}
	// AN EMPTY MANIFEST IS A FAILURE, NOT A PASS. A gate that reports nothing to
	// check is the exact shape of a gate protecting nothing, and the script cannot
	// distinguish "this image has no shared/" from "everything matched" unless this
	// side refuses to start. Failing here is louder and earlier than failing there.
	if (!Object.keys(shared).length)
		throw new Error(`no shared files found in ${SHARED_DIR} — the image is missing shared/`)
}
