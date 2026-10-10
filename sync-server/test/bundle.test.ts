// THE BUNDLER MUST NOT SWALLOW THE SHARED CODE.
//
// `scripts/assert-shared-parity.sh` is the ADR 0001 gate: it proves the
// `shared/schedule.js` going to the bucket is byte-identical to the one inside
// the image, because a stale scheduler still computes *a* date and a stale
// protocol still parses *a* command and quietly means something else by it.
//
// Every word of that reasoning depends on one unstated premise — that the page
// LOADS the file being compared. That premise was free for as long as the page
// was a plain module importing `./schedule.js`. A bundler makes it false by
// default: Rollup's whole job is to inline an import, and if it inlines this one
// the browser starts running a transformed copy while the gate goes on comparing
// two files that still match. Both sides green, nobody running the code.
//
// `web/vite.config.ts` marks the two shared files external to prevent exactly
// that. This is the test that says so out loud, because a config comment cannot
// fail a build. It reads the artefact rather than the config, so it also catches
// the case where the option is still there and has stopped working.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(import.meta.dirname, '..', '..', 'web')
const DIST = join(WEB, 'dist')
const SHARED = join(import.meta.dirname, '..', '..', 'shared')

/** The single JS chunk Vite emits for the page. Named by content hash, so it is
 *  found rather than spelled — the hash is the point of the naming scheme. */
function chunks() {
	const dir = join(DIST, 'assets')
	// A MISSING dist/ IS A FAILURE, NOT A CRASH. `readdirSync` throws ENOENT with
	// no hint of what was supposed to have created it, and every assertion in this
	// file is about a build output — so an unbuilt tree must say which command is
	// missing rather than produce a stack trace about a directory.
	let js: string[]
	try { js = readdirSync(dir).filter(f => f.endsWith('.js')) }
	catch { assert.fail(`web/dist/assets does not exist — the page has not been built. ` +
		`\`npm test\` in sync-server/ builds it in pretest; on its own, run ` +
		`\`npm run build\` in web/.`) }
	// EVERY CHUNK, WHICH THIS ASKED FOR IN ADVANCE. It used to assert there was
	// exactly one and say so: "a code-split build needs this test rewritten to scan
	// every chunk — until then it would only be checking one of them." The reorder
	// worker made that true, and a build gains chunks quietly, so scanning all of
	// them is the version that does not need rewriting again.
	assert.ok(js.length >= 1, 'web/dist/assets has no JS chunk at all')
	return js.map(f => ({ name: f, src: readFileSync(join(dir, f), 'utf8') }))
}

test('the page imports the shared files instead of inlining them', () => {
	const js = chunks().map(c => c.src).join('\n')
	for (const name of ['schedule.js', 'commands.js']) {
		assert.match(js, new RegExp(`from\\s*["']/${name}["']`),
			`web/dist has no root-relative import of /${name}. Either the bundler inlined it — ` +
			`which silently voids assert-shared-parity.sh, see the header — or the specifier is ` +
			`wrong. It has been wrong twice: Rollup rewrote it to "../src/${name}" until ` +
			`output.paths matched on the basename, and to "../../../../../../../../../${name}" ` +
			`until makeAbsoluteExternalsRelative was set to false. Both 404 only in production.`)
	}
})

// DERIVED MARKERS, NOT HARDCODED ONES. A literal like "dependency cycle" spelled
// out here is a marker that keeps passing after somebody rewords the error it
// came from — the test would then be scanning for a string that exists nowhere,
// which cannot fail. Reading them out of the file under test means the markers
// change whenever it does.
const markersOf = (file: string) =>
	[...readFileSync(join(SHARED, file), 'utf8').matchAll(/"([^"\\\n]{25,})"/g)]
		.map(m => m[1]!)

// THE WORKER IS A SECOND WAY TO GET THIS WRONG, and it gets it wrong through a
// different door: Vite builds workers in a SEPARATE rollup pass, so the
// `external` in `build.rollupOptions` does not reach them. Without
// `worker.rollupOptions` saying the same thing, `src/reorder-worker.ts` ships an
// inlined copy of the scheduler — and `assert-shared-parity.sh` goes on comparing
// the two files it knows about and reporting green about bytes nobody runs. The
// test below catches the inlining; this one catches it having stopped importing.
test('the reorder worker imports the scheduler rather than carrying one', () => {
	const worker = chunks().find(c => c.name.includes('reorder-worker'))
	assert.ok(worker, `no reorder-worker chunk in web/dist/assets — found ` +
		`${chunks().map(c => c.name).join(', ')}. If the worker was removed, remove this test; ` +
		`if it was renamed, this is the only thing checking it stays external.`)
	assert.match(worker!.src, /from\s*["']\/schedule\.js["']/,
		`${worker!.name} has no root-relative import of /schedule.js, so it is running its own ` +
		`copy of the scheduler while the parity gate compares two files it does not run.`)
})

test('no shared implementation is copied into the bundle', () => {
	const js = chunks().map(c => c.src).join('\n')
	for (const file of ['schedule.js', 'commands.js']) {
		const markers = markersOf(file)
		assert.ok(markers.length >= 3,
			`found only ${markers.length} long string literals in shared/${file} to fingerprint ` +
			`it with. Too few to tell inlining from coincidence — this test has stopped meaning ` +
			`anything and needs a different marker.`)
		const leaked = markers.filter(m => js.includes(m))
		assert.deepEqual(leaked, [],
			`text from shared/${file} is present in the built page, so the bundler inlined it ` +
			`and the browser is no longer running the file the parity gate compares:\n  ` +
			leaked.map(m => JSON.stringify(m)).join('\n  '))
	}
})

test('index.html names content-hashed assets and nothing else', () => {
	const html = readFileSync(join(DIST, 'index.html'), 'utf8')
	const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]!)
	assert.ok(refs.length >= 2, `web/dist/index.html references ${refs.length} built assets; ` +
		`expected at least the script and the stylesheet`)
	for (const r of refs)
		assert.match(r, /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/,
			`${r} carries no content hash. Unhashed assets are why every entrypoint had to be ` +
			`no-cache before the bundler: a fresh index.html against a stale script is a real ` +
			`window that a CloudFront invalidation cannot close, because it does not reach ` +
			`browser caches.`)
	// The pre-bundler page loaded these by their plain names. If either is still
	// referenced, the deploy would upload a hashed asset nobody asks for.
	assert.doesNotMatch(html, /"\/?app\.js"|"\/?styles\.css"/,
		`web/dist/index.html still references the un-hashed app.js or styles.css`)
})
