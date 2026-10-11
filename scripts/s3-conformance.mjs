// Probe an S3-compatible server for exactly the properties the sync server depends on.
//
//   node scripts/s3-conformance.mjs <endpoint> <access-key> <secret-key>
//
// WHY THIS EXISTS. `s3.ts` says to re-run a put-if-absent check before trusting a new
// storage substrate, because a server that ignores `If-None-Match: *` degrades silently
// to an overwrite, and two people creating a plan at once lose one. This is that check,
// plus the rest of what the server leans on: 404 on a missing key, a dot-prefixed key
// (`.history/`), pagination by prefix. It is how MinIO's replacement (Versity Gateway)
// was chosen in 2026-10; run it again on every storage upgrade, from this repo against
// a local server, or inside the api container against the NAS (copy it to /tmp there and
// set SDK_FROM=/app/sync-server/ so it finds the SDK).
//
// It works in its own throwaway `probe-*` bucket and deletes it at the end. Exits 1 if
// any check fails.
import { createRequire } from 'node:module'

const require = createRequire(process.env.SDK_FROM ?? new URL('../sync-server/', import.meta.url))
const s3sdk = require('@aws-sdk/client-s3')
const { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } = s3sdk

const [endpoint, ak, sk] = process.argv.slice(2)
if (!sk) {
	console.error('usage: node scripts/s3-conformance.mjs <endpoint> <access-key> <secret-key>')
	process.exit(2)
}
const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: ak, secretAccessKey: sk } })
const Bucket = 'probe-' + Math.random().toString(36).slice(2, 8)
const out = {}
const code = (e) => (e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412 ? '412' : `${e?.name}/${e?.$metadata?.httpStatusCode}`)
const put = (Key, Body, extra = {}) => s3.send(new PutObjectCommand({ Bucket, Key, Body, ...extra }))
const get = async (Key) => (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToString()
const step = async (name, fn) => {
	try {
		out[name] = await fn()
	} catch (e) {
		out[name] = 'ERR ' + code(e) + ' ' + String(e.message).slice(0, 60)
	}
}

await step('create bucket', async () => (await s3.send(new CreateBucketCommand({ Bucket })), 'ok'))
await step('head bucket', async () => (await s3.send(new HeadBucketCommand({ Bucket })), 'ok'))
await step('put + get', async () => (await put('a/b.json', '{"x":1}'), (await get('a/b.json')) === '{"x":1}' ? 'ok' : 'WRONG BODY'))
await step('get missing is 404', async () => {
	try {
		await get('nope')
		return 'NO ERROR'
	} catch (e) {
		return e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404 ? 'ok' : 'ERR ' + code(e)
	}
})
await step('dot-prefixed key', async () => (await put('.history/p/0001.json', 'h'), (await get('.history/p/0001.json')) === 'h' ? 'ok' : 'WRONG'))
await step('overwrite (no precondition)', async () => (await put('o', '1'), await put('o', '2'), (await get('o')) === '2' ? 'ok' : 'NOT OVERWRITTEN'))
await step('put-if-absent: first', async () => (await put('c', 'first', { IfNoneMatch: '*' }), 'ok'))
await step('put-if-absent: second is 412', async () => {
	try {
		await put('c', 'second', { IfNoneMatch: '*' })
		return 'FAIL: second write ACCEPTED, body now ' + (await get('c'))
	} catch (e) {
		return code(e) === '412' ? 'ok' : 'ERR ' + code(e)
	}
})
await step('put-if-absent: 30-way race', async () => {
	const bodies = Array.from({ length: 30 }, (_, i) => 'writer-' + i)
	const res = await Promise.all(bodies.map((b) => put('race', b, { IfNoneMatch: '*' }).then(() => ({ b, ok: true }), (e) => ({ b, ok: false, c: code(e) }))))
	const wins = res.filter((r) => r.ok)
	const final = await get('race')
	const lost412 = res.filter((r) => !r.ok && r.c === '412').length
	const pass = wins.length === 1 && wins[0].b === final && lost412 === 29
	return `${pass ? 'ok' : 'FAIL'}: ${wins.length} winner(s), ${lost412}/29 got 412, final=${final}`
})
await step('list 1250 keys, paginated by prefix', async () => {
	const keys = Array.from({ length: 1250 }, (_, i) => `pg/${String(i).padStart(4, '0')}.json`)
	for (let i = 0; i < keys.length; i += 50) await Promise.all(keys.slice(i, i + 50).map((k) => put(k, 'x')))
	await put('pgx/other.json', 'x')
	const seen = []
	let token, pages = 0
	do {
		const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: 'pg/', ContinuationToken: token }))
		pages++
		seen.push(...(r.Contents ?? []).map((o) => o.Key))
		token = r.IsTruncated ? r.NextContinuationToken : undefined
	} while (token)
	const sorted = seen.every((k, i) => i === 0 || seen[i - 1] < k)
	const isolated = !seen.some((k) => k.startsWith('pgx'))
	const pass = seen.length === 1250 && sorted && isolated && pages >= 2
	return `${pass ? 'ok' : 'FAIL'}: ${seen.length}/1250 keys in ${pages} page(s), sorted=${sorted}, prefix-isolated=${isolated}`
})

// Clean up: everything in the probe bucket, then the bucket.
await step('cleanup', async () => {
	let token
	do {
		const r = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken: token }))
		const Objects = (r.Contents ?? []).map(({ Key }) => ({ Key }))
		if (Objects.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects } }))
		token = r.IsTruncated ? r.NextContinuationToken : undefined
	} while (token)
	await s3.send(new DeleteBucketCommand({ Bucket }))
	return 'ok'
})

console.log(JSON.stringify(out, null, 1))
process.exit(Object.values(out).every((v) => v.startsWith('ok')) ? 0 : 1)
