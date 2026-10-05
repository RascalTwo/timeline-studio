// EVERY `$("#id")` IN THE PAGE NAMES SOMETHING THAT EXISTS.
//
// NAMED `.test.ts`, NOT `.guard.ts`, AND THE DIFFERENCE MATTERS. `npm test` runs
// `tsx --test test/*.test.ts`; a `.guard.ts` file matches nothing and never runs.
// `plan-id.guard.ts` earns that suffix because it is a COMPILE-time guard picked
// up by `tsc --noEmit`. This one reads a file at runtime, so it has to be a test
// or it is decoration. It was written as `.guard.ts` first and silently did not
// run.
//
// This is the guard for the defect class that did the only real damage in this
// tool's history, and it is `plan-id.guard.ts`'s trick pointed at a second
// invariant: assert a property of the SOURCE that no runtime test can reach.
//
// WHAT HAPPENED. `sched()` throws on a dependency cycle, and it is the ONLY
// cycle handling in the system — `shared/commands.js` and
// `sync-server/src/validate.ts` both decline to check, in as many words, on the
// grounds that "sched() refuses them loudly when the plan is opened"
// (validate.ts:19-21). That refusal wrote its diagnosis into `#verdict` and
// `#verdictsub`. A UI change hundreds of lines away had replaced that block with
// per-milestone chips, so both elements were gone.
//
// `$` is `root.querySelector(sel)` (web/index.html:1552). It returns `null`.
// Silently. Forever. There is no compile step and no type between that write and
// production, so the tool accepted a dependency cycle, sequenced it, broadcast it
// to every viewer and persisted it to S3 — and every chart in the room went blank
// under output that never once said "cycle". At least 13 days on live client
// plans, and recovery means `/api/revert`, which discards the draft for everyone.
//
// WHY A SOURCE SCAN AND NOT A TEST. A behavioural test only catches this if it
// reaches the code path — and the cycle path is, by construction, the one nobody
// exercises. The stale reference is a property of the text. Read the text.
//
// FALSE NEGATIVES ARE ACCEPTABLE HERE; false positives are not. Ids built by
// interpolation (`id="row-${t.id}"`) are unknowable from source, so anything
// containing `${` is skipped rather than guessed at. This catches the LITERAL
// stale reference, which is the one that bit.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// TWO FILES SINCE 2026-09-05, and reading only one is how this guard stopped
// working the moment the script was lifted out of the HTML. Ids are DECLARED in
// the markup (index.html) and also written by the template literals that build
// the inspector and the panels (app.ts); references live in app.ts. Scanning the
// concatenation asks the same question of the same text as before the split.
//
// THE SOURCE, NOT A BUILD OUTPUT. This read the emitted `web/app.js` for the few
// hours that file existed. Reading the bundle instead would be worse than
// useless: Rollup rewrites the identifiers this scans for, and the whole point is
// to catch a selector string that no longer matches an id — a question about what
// somebody TYPED. Reading the source also means the guard runs with nothing built.
//
// GUARD_PAGE overrides with a single file, which is how this was proved: point it
// at the page as it stood before e09ed62 and it reports the two dead ids that
// cost 13 days.
const WEB = join(import.meta.dirname, '..', '..', 'web')

// EVERY SOURCE FILE, DISCOVERED, NOT LISTED. An id is declared in the markup or
// written by a template literal or by JSX, and referenced from wherever the code
// that needs it lives — so both halves of the question move as the page is split
// into modules. A hardcoded list is a list that silently stops covering the file
// somebody added this morning: `#addms` moved from a string in app.ts to JSX in
// ui/MilestoneBar.tsx during the React port, and a two-entry list would have gone
// on passing while checking neither end of it.
const srcFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap(e =>
		e.isDirectory() ? srcFiles(join(dir, e.name))
		: /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [join(dir, e.name)] : [])

const SOURCES = process.env.GUARD_PAGE
	? [process.env.GUARD_PAGE]
	: [join(WEB, 'index.html'), ...srcFiles(join(WEB, 'src'))]
const source = () => SOURCES.map(f => readFileSync(f, 'utf8')).join('\n')

test('every literal $("#id") in the page resolves to an id the page defines', () => {
	const src = source()

	// Every id the page can produce, from ANYWHERE: static markup and the
	// template literals the inspector and panels are built from. One pass over
	// the whole file, because a dynamically written `id="x"` is just as real as a
	// declared one and the guard must not care which it was.
	const defined = new Set<string>()
	for (const m of src.matchAll(/\bid\s*=\s*["']([^"'${}]+)["']/g)) defined.add(m[1]!)
	// `getElementById("x")` implies the author believes x exists; it does not
	// define it, so it is not added — but `setAttribute("id", "x")` does.
	for (const m of src.matchAll(/setAttribute\(\s*["']id["']\s*,\s*["']([^"'${}]+)["']/g))
		defined.add(m[1]!)

	// Every literal single-id lookup. Compound selectors ("#a .b") and anything
	// interpolated are out of scope: the first is a structural query rather than
	// a reference, the second is unknowable.
	const referenced = new Map<string, number>()
	const pat = /\$\(\s*["'`]#([A-Za-z][\w-]*)["'`]\s*[),]/g
	for (const m of src.matchAll(pat)) {
		const id = m[1]!
		if (!referenced.has(id)) referenced.set(id, src.slice(0, m.index).split('\n').length)
	}
	assert.ok(referenced.size > 50,
		`only found ${referenced.size} $("#id") references — the pattern has drifted ` +
		`from the source and this guard is no longer checking anything`)

	const stale = [...referenced].filter(([id]) => !defined.has(id))
	assert.deepEqual(stale.map(([id, line]) => `${id} (line ${line})`), [],
		`$("#…") names an id nothing in the page defines. This is exactly how the ` +
		`dependency-cycle diagnosis was thrown away for 13 days — see the header. ` +
		`Either the element was renamed and this reference was missed, or the id is ` +
		`built by interpolation and this guard needs to learn about it.`)
})

test('getElementById references resolve too', () => {
	const src = source()
	const defined = new Set<string>()
	for (const m of src.matchAll(/\bid\s*=\s*["']([^"'${}]+)["']/g)) defined.add(m[1]!)
	const stale: string[] = []
	for (const m of src.matchAll(/getElementById\(\s*["']([A-Za-z][\w-]*)["']\s*\)/g))
		if (!defined.has(m[1]!)) stale.push(m[1]!)
	assert.deepEqual(stale, [], 'getElementById names an id nothing defines')
})
