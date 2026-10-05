// THE BUCKET LAYOUT, and nothing else. Every key this server reads or writes is
// built here, and `scripts/migrate-to-s3.ts` is still the authority on what the
// strings are — if these ever disagree with that file, that file wins.
//
// WHY THIS IS NOT IN s3.ts, where it used to live: s3.ts constructs an S3 client
// and throws at import when `DATA_BUCKET` is unset. That is right for a process
// that is about to talk to a bucket and wrong for a test that is not, so anything
// importing s3.ts for a key builder drags a client and an environment variable in
// behind it. These are pure string functions; keeping them reachable without the
// client is what lets `create.ts` be tested against a Map.

import { createHash } from 'node:crypto'

// THE SAME TWO LOCATIONS THE ORIGINAL TOOL USED, re-rooted into the bucket:
// `data/<id>.json` is the live shared draft and `.history/<id>/NNNN.json` is the
// append-only archive. On disk `.history/` sat inside the data directory; in the
// bucket they are siblings.
export const planKey = (id: PlanId | string) => `data/${id}.json`
const HISTORY_DIR = '.history'
export const historyPrefix = (id: PlanId) => `${HISTORY_DIR}/${id}/`
export const versionKey = (id: PlanId, n: number) => `${historyPrefix(id)}${String(n).padStart(4, '0')}.json`

/** The inverse of `versionKey`, applied to the file name a listing returns —
 *  `undefined` for anything that is not a version object. It lives next to the
 *  builder because the two halves ARE one convention, and they were apart when
 *  they disagreed.
 *
 *  FOUR DIGITS IS A FLOOR, NOT A WIDTH. `padStart` pads and never truncates, so
 *  version 10000 is written `10000.json`, and the reader used to insist on
 *  exactly four. Nothing would have failed: the listing would simply stop seeing
 *  new versions, the highest one found would stay 9999 forever, and since the
 *  next version number is derived from that, every save from 10000 on would
 *  overwrite 10000 again. An archive that silently stops growing looks exactly
 *  like an archive nobody has added to. */
export const versionNumber = (name: string): number | undefined => {
	const m = /^(\d{4,})\.json$/.exec(name)
	return m ? Number(m[1]) : undefined
}

// ADR 0002: the forward index is keyed by the HASH, so `s3:ListBucket` enumerates
// nothing and no raw token lands in an S3 access log or a CloudTrail data event
// as a key name.
export const tokenKey = (token: string) => `tokens/${createHash('sha256').update(token).digest('hex')}.json`

/** The reverse record, and the only place a raw token is stored. ADR 0002 keeps
 *  it because a link has to be re-derivable when someone loses theirs — there is
 *  no `/list` and no picker — and it is keyed by plan id, so listing it reveals
 *  nothing a bucket-lister did not already have. `scripts/list-plans.sh` is the
 *  operator path that reads it. */
export const planTokenKey = (id: PlanId | string) => `plan-tokens/${id}.json`

/** A plan id that the server derived or resolved. NOT just a string, and the
 *  difference is the whole point.
 *
 *  ADR 0002: the server resolves which plan a request is for FROM THE TOKEN
 *  ALONE, and a plan id supplied by the client is never trusted to select a plan.
 *  If a request could carry both a token and an id, one valid token would read
 *  every plan by varying the id — the enumeration the ADR removed `/list` to
 *  prevent, arriving through the back door.
 *
 *  The brand makes that a rule the compiler enforces rather than a convention a
 *  reviewer has to notice: `makeOrLoadRoom(req.query.id)` does not compile. That
 *  matters because the original tool's whole HTTP surface is `?id=`-shaped, so
 *  writing that line is the natural mistake and it would look entirely reasonable
 *  in review. `test/plan-id.guard.ts` fails the build if it ever starts
 *  compiling. */
export type PlanId = string & { readonly __planId: unique symbol }

/** THE ONLY CAST IN THE SERVER, and the line the guard's grep counts — which is
 *  why the recipe for that grep lives in test/plan-id.guard.ts and not here: a
 *  comment quoting the pattern would be a second match and would break the
 *  invariant's own arithmetic.
 *
 *  Two places may decide a string names a plan, and both come through here, so
 *  there is one line to read rather than a habit to audit:
 *
 *    `resolveToken` — a token was presented and the forward record named this id.
 *    `createPlan`   — the id was derived from a title and atomically claimed, so
 *                     it names a plan nobody else had.
 *
 *  Both check `okId` first; neither takes an id from the caller. A third call
 *  site is a change to the trust boundary and should be read as one. */
export const brand = (id: string) => id as PlanId
