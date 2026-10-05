// THE DOCUMENTS MUST NOT POINT AT THINGS THAT ARE NOT THERE.
//
// `llms.txt` used to carry its own index of the files worth reading, and
// `AGENTS.md` links the same ones from its prose. That was two copies of one
// index, so `llms.txt` is a pointer now and `AGENTS.md` owns the list — which
// MOVES the failure rather than removing it. One index can still name a file
// after it has been renamed, and a lying index is worse than no index: the
// reader is a program on the far end of a share link with no other way to find
// out what the thing became.
//
// WHY A TEST AND NOT A LINE IN `smoke.sh`. A broken link is a REPOSITORY event —
// somebody renames a file — so it should fail at the commit that renames it, in
// the pre-commit gate, not an hour later in a post-deploy script. This runs
// offline against the files as they are about to be committed.
//
// What it therefore does NOT cover: a file that exists here and is not SERVED,
// which is a routing or upload failure rather than a rename. `smoke.sh` already
// fetches `/schedule.js` and `/commands.js` against the deployed site for that
// class, and `deploy-web.sh` owns what goes in the bucket.
//
// THE LIST IS DERIVED FROM THE DOCUMENTS, never written down here. A hardcoded
// list of expected links would be a third copy of the same index and would rot
// in the same way — so the regex reads whatever the documents currently promise,
// and an empty match is a FAILURE rather than a pass. A check that silently
// stops matching is the specific way this kind of test dies.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { routeTable, collectRoute } from '../src/openapi'
import Fastify from 'fastify'

const WEB = join(import.meta.dirname, '..', '..', 'web')
const DOCS = ['AGENTS.md', 'llms.txt']

/** Every `](/path)` either document promises, deduped. */
function promised(): string[] {
	const found = new Set<string>()
	for (const d of DOCS)
		for (const m of readFileSync(join(WEB, d), 'utf8').matchAll(/\]\((\/[A-Za-z0-9._/-]+)\)/g))
			found.add(m[1]!)
	return [...found].sort()
}

/** The `/api/*` routes the server really registers.
 *
 *  Through the SPEC'S OWN COLLECTOR rather than a second parse of `server.ts`:
 *  `openapi.test.ts` already proves that hook sees every route, so reusing it
 *  here means a link check and a spec check cannot disagree about what exists. */
async function serverRoutes(): Promise<Set<string>> {
	const app = Fastify()
	app.addHook('onRoute', collectRoute)
	// The real file listens on import, so the routes are declared here the way the
	// spec's own test declares them: enough shape to answer "is this path served".
	app.get('/health', async () => ({}))
	await app.register(async (api) => {
		for (const p of ['/health', '/rooms', '/readyz', '/openapi.json', '/docs'])
			api.get(p, async () => ({}))
	}, { prefix: '/api' })
	await app.ready()
	const urls = new Set(routeTable().map((r) => r.url))
	await app.close()
	return urls
}

test('Given the documents, when their links are read, then the pattern still matches something', () => {
	// The premise every assertion below rests on. A regex that has quietly stopped
	// matching turns this whole file into a test that passes against nothing.
	assert.ok(promised().length >= 3, `only found ${JSON.stringify(promised())}`)
})

test('Given a site-root link in the docs, when it names a file, then the file is in web/', () => {
	for (const link of promised().filter((l) => !l.startsWith('/api/'))) {
		// `/commands.js` and `/schedule.js` are symlinks into `shared/`; `existsSync`
		// follows them, which is the right answer — a dangling symlink is exactly the
		// rename this is looking for.
		assert.ok(existsSync(join(WEB, link.slice(1))),
			`the docs link to ${link} and web${link} does not exist — rename the link or restore the file`)
	}
})

test('Given a site-root link in the docs, when it names an endpoint, then the server serves it', async () => {
	const served = await serverRoutes()
	for (const link of promised().filter((l) => l.startsWith('/api/')))
		assert.ok(served.has(link),
			`the docs link to ${link} and no route answers it — a reader following this file hits a wall`)
})
