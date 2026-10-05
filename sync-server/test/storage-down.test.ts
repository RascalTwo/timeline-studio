// THE OUTAGE THAT REPORTED ITSELF AS A TYPO.
//
// On 2026-09-20 colima stopped and took the MinIO container with it. Every plan
// read failed, and what a reader got was `400 {"error":""}` under a page saying
// their link's token "may be wrong or have been revoked" — so a storage outage
// sent people to look at their credentials.
//
// Two things made that possible and both are asserted here. `fail()` sent
// `err.message`, and the message was EMPTY: a dead endpoint on `localhost` is
// two connection attempts (::1 and 127.0.0.1), and node reports both as an
// `AggregateError` whose own `message` is `''` with the detail hidden in
// `.errors`. Anything printing `err.message` printed nothing, which is why the
// server knew and logged nothing. The status was the other half — nothing was
// wrong with the request, so 400 was never the honest answer.
//
// `StorageDown` is the classification the HTTP layer branches on, so the thing
// worth pinning is that it can never again be constructed with nothing to say.
//
// `DATA_BUCKET` before the import, and hence a dynamic one: `s3.ts` throws at
// module scope without it, and a static import is hoisted above any assignment.
process.env.DATA_BUCKET ??= 'test-bucket'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { StorageDown } = await import('../src/s3')

test('Given the AggregateError a dead endpoint throws, when it is classified, then the reason survives', () => {
	// Exactly what the SDK surfaced that day, reproduced against a dead port.
	const real = new AggregateError([
		new Error('connect ECONNREFUSED ::1:9998'),
		new Error('connect ECONNREFUSED 127.0.0.1:9998'),
	])
	assert.equal(real.message, '', 'the premise: this is the error whose message is empty')

	const down = new StorageDown(real)

	assert.notEqual(down.message, '', 'an outage that logs as an empty string is the bug this file is about')
	assert.match(down.message, /ECONNREFUSED ::1:9998/)
	assert.match(down.message, /ECONNREFUSED 127\.0\.0\.1:9998/)
	// The original goes to the log, never to a response — it names the bucket and
	// the endpoint, and everyone holding a share link would see a response.
	assert.equal(down.cause, real)
})

test('Given any shape of failure, when it is classified, then it is still an Error with something to say', () => {
	for (const raw of [new Error('AccessDenied'), 'a thrown string', undefined, new AggregateError([])]) {
		const down = new StorageDown(raw)
		assert.ok(down instanceof Error, 'the HTTP layer branches with instanceof')
		assert.notEqual(down.message, '', `nothing to say for ${String(raw)}`)
	}
})
