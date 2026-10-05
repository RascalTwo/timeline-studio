// A COMPILE-TIME TEST, and the only kind that can catch this one.
//
// ADR 0002: a plan id supplied by the client is never trusted to select a plan.
// The danger is not that today's code gets it wrong — it doesn't — but that the
// original tool's entire HTTP surface is `?id=`-shaped, so `makeOrLoadRoom(
// req.query.id)` is the natural line to write, and it reads as obviously correct.
// One of those turns a single valid token into a reader of every plan.
//
// So the rule is enforced by the type system: `PlanId` is branded and
// `resolveToken` is the only thing that mints one. Each `@ts-expect-error` below
// FAILS THE BUILD IF THE ERROR STOPS HAPPENING — that is the falsifier. Delete
// the brand and `npm run typecheck` goes red here rather than going quiet.
//
// Deliberately named `.guard.ts`, not `.test.ts`: there is nothing to run, and
// every import is type-only so this file executes no code and touches no S3.

import type { issueToken } from '../src/create'
import type { closeRoomIfUnused, leaveRoom, makeOrLoadRoom, revertRoom, saveRoom } from '../src/rooms'
import type { PlanStore } from '../src/s3'
import type { loadHistory, loadPlan, loadVersion, PlanId } from '../src/s3'

/** What a request hands you: a query param, a body field, a URL fragment. */
declare const fromClient: string
/** What `resolveToken` hands you, and the only thing that may address a plan. */
declare const fromToken: PlanId

declare const open: typeof makeOrLoadRoom
declare const save: typeof saveRoom
declare const revert: typeof revertRoom
declare const leave: typeof leaveRoom
declare const close: typeof closeRoomIfUnused
declare const readPlan: typeof loadPlan
declare const readHistory: typeof loadHistory
declare const readVersion: typeof loadVersion
declare const mint: typeof issueToken
declare const store: PlanStore

// --- A client-supplied id must not compile anywhere that addresses a plan ---

// @ts-expect-error — ADR 0002: a plan id from the client may not select a plan
open(fromClient)
// @ts-expect-error — ADR 0002
save(fromClient, 'note', 'agent')
// @ts-expect-error — ADR 0002
revert(fromClient, 1, 'agent')
// @ts-expect-error — ADR 0002
leave(fromClient, 'session')
// @ts-expect-error — ADR 0002
close(fromClient)
// @ts-expect-error — ADR 0002: this one reads a client's plan straight out of S3
readPlan(fromClient)
// @ts-expect-error — ADR 0002
readHistory(fromClient)
// @ts-expect-error — ADR 0002
readVersion(fromClient, 1)
// @ts-expect-error — ADR 0002: minting is the sharpest case. A token for an id the
// caller named is "give me a capability for any plan whose title I can guess",
// which is the enumeration the ADR removed `/list` to prevent, wearing a
// different hat. `createPlan` reaches this only with an id it just CLAIMED — one
// that provably did not exist a moment earlier — and `claimId` steps over a taken
// id rather than adopting it.
mint(store, fromClient)

// --- The token-derived id must still work, or the brand is just breaking things ---

open(fromToken)
save(fromToken, 'note', 'agent')
revert(fromToken, 1, 'agent')
leave(fromToken, 'session')
close(fromToken)
readPlan(fromToken)
readHistory(fromToken)
readVersion(fromToken, 1)
mint(store, fromToken)

// --- And a cast must be the loud, greppable thing it is ---
//
// `as PlanId` still compiles — TypeScript has no way to forbid an assertion. That
// is the residual hole, and it is deliberately left visible rather than papered
// over: `grep -rn 'as PlanId' src/` should return exactly one hit, in `brand` in
// src/keys.ts. If it ever returns two, read the second one very carefully.
//
// `brand` has two callers and they are the two trust boundaries: `resolveToken`,
// where a token was presented and the forward record named the id, and
// `createPlan`, where the id was derived from a title and atomically claimed. Both
// check `okId` first and neither takes an id from the caller. A THIRD caller is a
// change to the trust boundary, not a convenience — `grep -rn 'brand(' src/`.
