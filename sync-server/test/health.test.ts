// THE WIRE KEY, asserted.
//
// This exists because it already broke once, in the way that is hardest to catch:
// `healthBody` was built with ES6 shorthand from a variable called
// `sharedSha256`, so the published key was `sharedSha256` while
// `scripts/assert-shared-parity.sh` read `shared`. Both sides were internally
// consistent and locally reasonable. Nothing failed until the gate returned
// `null` on a deploy.
//
// It was caught by a human reading the other side's source, which is not a
// strategy. Three separate contract mismatches were caught that way in one day —
// a token format, a header name, and this. So the wire contract gets a test,
// pinned to the literal strings that appear in ADR 0001 and in the script, not to
// whatever the implementation currently produces.
//
// No S3, no socket: `shared-hash.ts` reads `shared/` off disk and nothing else,
// which is why the body is built there rather than in server.ts.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { healthBody, shared } from '../src/shared-hash'

const SHA256 = /^[0-9a-f]{64}$/

test('Given the health body, when it is serialised, then the map is published as "shared"', () => {
	// Round-trip through JSON: the assertion is about what goes on the WIRE, not
	// about the shape of the object in memory.
	const wire = JSON.parse(JSON.stringify(healthBody()))

	assert.deepEqual(Object.keys(wire).sort(), ['commit', 'ok', 'shared'])
	assert.equal(wire.ok, true)
	// Present even when unknown, so a deploy check reads `null` rather than a missing key.
	assert.equal(wire.commit, process.env.GIT_SHA || null)
	// The names the consumers actually read. `sharedSha256` was the real bug and
	// `scheduleSha256` is the retired field — neither may come back by accident.
	assert.equal(wire.sharedSha256, undefined, 'the map is `shared`; `sharedSha256` was the shipped bug')
	assert.equal(wire.scheduleSha256, undefined, 'retired: the gate reads the map, not a single file')
})

test('Given the shared map, when it is read, then every entry is a lowercase 64-hex digest', () => {
	const entries = Object.entries(healthBody().shared)
	// An empty manifest is a failure, not a pass — a gate that reports nothing to
	// check is the exact shape of a gate protecting nothing. shared-hash.ts throws
	// at import if `shared/` is empty, so reaching here at all proves it is not.
	assert.ok(entries.length > 0, 'shared/ must not be empty')
	for (const [name, digest] of entries) {
		assert.match(digest, SHA256, `${name} must be a lowercase 64-hex sha256`)
		assert.ok(!name.includes('/'), `${name} must be a bare filename — the script looks up by basename`)
	}
})

test('Given the files the page loads, when the gate looks them up, then they are present', () => {
	// The script derives what it needs from `web/`'s symlinks and looks each one up
	// here; a file it wants that this map lacks is a FAILURE, never a pass. These
	// two are the ones `web/` symlinks today, so their absence would break the gate
	// rather than merely being untidy.
	for (const name of ['schedule.js', 'commands.js'])
		assert.ok(name in shared, `${name} is symlinked into web/ and must appear in the map`)
})
