// THE ARCHIVE'S NUMBERING, ROUND-TRIPPED.
//
// `versionKey` writes the name and `versionNumber` reads it back, and the next
// version a save writes is one past the highest the reader found. So the two
// disagreeing is not a parse error — it is silent, permanent data loss: a name
// the reader does not recognise keeps the highest-found number where it is, and
// every save after that overwrites the same object.
//
// That is exactly what four-digit-only matching did from version 10000, which is
// why 10000 is in here as a literal rather than as "some big number". Pure string
// functions, so this needs no bucket and no DATA_BUCKET.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brand, historyPrefix, versionKey, versionNumber } from '../src/keys'

const id = brand('a-plan')
const name = (n: number) => versionKey(id, n).slice(historyPrefix(id).length)

test('every version number survives the trip through a key name', () => {
	// 9999 -> 10000 is the width change; the rest bracket it.
	for (const n of [1, 47, 9999, 10000, 10001, 12345]) {
		assert.equal(versionNumber(name(n)), n, `version ${n} came back wrong from ${name(n)}`)
	}
})

test('the reader ignores anything that is not a version object', () => {
	for (const junk of ['index.json', '12.json', '0001.txt', '0001.json.bak', 'abcd.json', '']) {
		assert.equal(versionNumber(junk), undefined, `${junk} was read as a version`)
	}
})
