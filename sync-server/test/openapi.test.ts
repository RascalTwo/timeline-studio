// THE SPEC CANNOT SILENTLY ROT — it can only fail here.
//
// `src/openapi.ts` is a hand-authored structure, and the honest objection to a
// hand-authored spec is that it describes the API as it was on the day somebody
// wrote it. These checks are the answer: every route in `server.ts` must be in
// the spec and every route in the spec must be in `server.ts`, and the command
// vocabulary must match `shared/commands.js` in BOTH directions.
//
// THE SPEC'S PATHS ARE DERIVED AT RUNTIME from Fastify's own route table, so a
// route cannot be MISSING from the served document — the direction that actually
// burned somebody. What a route table cannot tell you is that prose exists
// describing a route nobody serves, or that the prose has gone stale, and those
// are what these checks are for.
//
// WHY READING THE SOURCE RATHER THAN THE SERVER. `server.ts` listens on import,
// so a test cannot pull the live table out of it without binding a port. Parsing
// is cruder, and the crudeness is contained by asserting a plausible route count
// — a regex that has quietly stopped matching fails loudly instead of passing
// with an empty set, which is the specific way this kind of check rots. The
// collector mechanism itself is exercised separately, below, against a real
// Fastify instance.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSpec, collectRoute, routeTable, ROUTE_DOCS, COMMAND_TYPES, INSTANT } from '../src/openapi'
import { TASK_FIELDS, validateCommand } from '../../shared/commands.js'

const SRC = join(import.meta.dirname, '..', 'src', 'server.ts')
const COMMANDS = join(import.meta.dirname, '..', '..', 'shared', 'commands.js')

/** Every route `server.ts` registers, as `METHOD /path`. Three registration
 *  shapes, because the file uses three: the bare `app.get('/health')` outside
 *  the prefix, `api.<verb>('/x')` inside it, and `api.route({ method: [...] })`
 *  for the endpoints that answer to both GET and POST. */
function registeredRoutes(): Set<string> {
	const src = readFileSync(SRC, 'utf8')
	const found = new Set<string>()

	// `app` MEANS TWO DIFFERENT INSTANCES IN THIS FILE, and the first version of
	// this parser got it wrong — which is the whole argument for having it. The
	// websocket is registered inside `api.register(async (app) => ...)`, where the
	// parameter SHADOWS the outer server with the `/api`-prefixed scope. So a
	// `app.get` before the prefix block is a bare route and one after it is not.
	const prefixStart = src.indexOf('app.register(async (api)')
	assert.ok(prefixStart > 0, 'the /api prefix block has moved — this parser assumes it exists')
	for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g))
		found.add(m.index! < prefixStart
			? `${m[1]!.toUpperCase()} ${m[2]}`
			: `${m[1]!.toUpperCase()} /api${m[2]}`)
	for (const m of src.matchAll(/\bapi\.(get|post|put|patch|delete)\(\s*'([^']+)'/g))
		found.add(`${m[1]!.toUpperCase()} /api${m[2]}`)
	// `api.route({ method: ['GET', 'POST'], url: '/ready', ... })`
	for (const m of src.matchAll(/\bapi\.route\(\{\s*method:\s*\[([^\]]+)\],\s*url:\s*'([^']+)'/g))
		for (const verb of m[1]!.split(',')) {
			const v = verb.trim().replace(/['"]/g, '')
			if (v) found.add(`${v.toUpperCase()} /api${m[2]}`)
		}
	return found
}

test('every route the server registers is in the spec, and vice versa', () => {
	const live = registeredRoutes()
	// THE GUARD ON THE GUARD. If the regexes stop matching — a reformat, a switch
	// to `app.route`, a different quote style — the two sets agree by both being
	// nearly empty and this file starts passing while proving nothing.
	assert.ok(live.size >= 15,
		`only found ${live.size} routes in server.ts — the parser has stopped matching, ` +
		`not the server stopped having routes. Fix the patterns in this file.`)

	const documented = new Set(Object.keys(ROUTE_DOCS))
	const undocumented = [...live].filter(r => !documented.has(r)).sort()
	const phantom = [...documented].filter(r => !live.has(r)).sort()

	// They would still REACH the spec — `buildSpec` lists them flagged — but a
	// flagged entry is a finding, not a description, and it should not survive a
	// commit.
	assert.deepEqual(undocumented, [],
		'these routes exist and have no ROUTE_DOCS entry — the spec will list them as undocumented')
	assert.deepEqual(phantom, [],
		'src/openapi.ts describes these and the server does not serve them')
})

test('the command vocabulary in the spec is the one the protocol accepts', () => {
	const src = readFileSync(COMMANDS, 'utf8')
	const apply = src.slice(src.indexOf('export function applyCommand('))
	const real = [...new Set([...apply.matchAll(/case\s+"([A-Za-z]+)"/g)].map(m => m[1]!))].sort()

	assert.ok(real.length >= 15,
		`only found ${real.length} commands in shared/commands.js — the parser has stopped matching`)

	const spec = [...COMMAND_TYPES].sort()
	assert.deepEqual(spec, real,
		'the spec\'s command enum and applyCommand\'s switch disagree — one of them has moved')

	// And the enum that actually ships is built from that list, not typed twice.
	const enumInDoc = (buildSpec(specRoutes()).components.schemas.Command.properties.type as { enum: string[] }).enum
	assert.deepEqual([...enumInDoc].sort(), real)
})

// EACH COMMAND'S PAYLOAD IS IN THE SPEC, AND IT IS THE `Command` UNION. The spec
// used to list the command names and defer every field to `shared/commands.js`,
// which the API host does not serve — so a caller holding only the API guessed
// `addTask`'s shape (2026-09-28). Each union member in `shared/types.ts` must have
// a variant with the same fields, required exactly where the type requires them.
test('every command\'s payload is in the spec, field for field with the Command type', () => {
	const src = readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'types.ts'), 'utf8')
	const union = src.slice(src.indexOf('export type Command = Issued & ('))
	const members = [...union.slice(0, union.indexOf('\n)')).matchAll(/\| \{ (.*) \}$/gm)].map(m => m[1]!)
	assert.ok(members.length >= 15, `only found ${members.length} Command members in shared/types.ts — the parser has stopped matching`)

	const spec = buildSpec(specRoutes()).components.schemas as Record<string, {
		oneOf?: { $ref: string }[], discriminator?: { mapping: Record<string, string> },
		properties?: Record<string, unknown>, required?: string[]
	}>
	const mapping = spec.Command!.discriminator?.mapping ?? {}
	for (const m of members) {
		// Top-level fields only: split on `;` outside braces, so `comment: { … }` stays one field.
		const fields: string[] = []
		let depth = 0, cur = ''
		for (const ch of m) {
			if (ch === '{') depth++
			if (ch === '}') depth--
			if (ch === ';' && !depth) { fields.push(cur.trim()); cur = '' } else cur += ch
		}
		fields.push(cur.trim())
		const type = /^type: "(\w+)"$/.exec(fields[0]!)![1]!
		const ref = mapping[type]
		assert.ok(ref, `the spec has no payload for ${type}`)
		const variant = spec[ref!.split('/').pop()!]!
		const names = fields.map(f => /^(\w+)/.exec(f)![1]!)
		const required = fields.filter(f => /^\w+:/.test(f)).map(f => /^(\w+)/.exec(f)![1]!)
		assert.deepEqual(Object.keys(variant.properties ?? {}).filter(k => k !== 'at').sort(), [...names].sort(),
			`${type}: the spec's fields and shared/types.ts disagree`)
		assert.deepEqual([...(variant.required ?? [])].sort(), [...required].sort(),
			`${type}: the spec's required fields and shared/types.ts disagree`)
	}
	assert.equal(Object.keys(mapping).length, members.length, 'the spec has payloads for commands the type does not')
})

// THE SPEC'S LINKS ANSWER ON THE HOST THAT SERVES THE SPEC. It linked
// `/AGENTS.md`, `/llms.txt` and the command code, and on a local API port all three
// 404ed (2026-09-28). Derived from the prose, so a new link is held to it too.
test('every path the spec links is a route on this server', () => {
	const intro = (buildSpec(specRoutes()).info as { description: string }).description
	const where = intro.slice(intro.indexOf('## Where the rest of it is'))
	assert.ok(where.length < intro.length, 'the "Where the rest of it is" list has moved — this test reads it')
	const linked = [...new Set([...where.matchAll(/`(\/[A-Za-z0-9._-]+)`/g)].map(m => m[1]!))]
	assert.ok(linked.length >= 3, `only found ${linked.length} linked paths — the parser has stopped matching`)
	const live = registeredRoutes()
	for (const p of linked) assert.ok(live.has(`GET ${p}`), `the spec links ${p} and this server does not serve it`)
})

// THE TASK SCHEMA IS THE TASK TYPE. Its prose went stale twice — no `refinedAt`,
// `createdAt` or `updatedAt`, and a `dur` still called "zero is the default" a week
// after zero was refused — while the served AGENTS.md said day numbers carry no time
// of day long after they did. So the field list is checked against
// `shared/types.ts`, and the two rules a caller trips on against the code.
test('the Task schema is the Task type, and states what the applier enforces', () => {
	const src = readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'types.ts'), 'utf8')
	const body = src.slice(src.indexOf('export interface Task {'))
	const real = [...body.slice(0, body.indexOf('\n}')).matchAll(/^\t(\w+)\??:/gm)].map(m => m[1]!).sort()
	assert.ok(real.length >= 15, `only found ${real.length} Task fields in shared/types.ts — the parser has stopped matching`)

	const task = buildSpec(specRoutes()).components.schemas.Task as {
		properties: Record<string, { description?: string, exclusiveMinimum?: number }>
	}
	assert.deepEqual(Object.keys(task.properties).sort(), real,
		'the spec\'s Task and shared/types.ts disagree — one of them has moved')
	assert.deepEqual([...TASK_FIELDS].sort(), real, 'addTask accepts a different field list (TASK_FIELDS) than Task has')

	// `dur > 0`, stated as schema rather than prose, and true of the real validator.
	assert.equal(task.properties.dur!.exclusiveMinimum, 0)
	const add = (dur: number) => validateCommand({ tasks: [], lanes: [] } as never,
		{ type: 'addTask', task: { id: 'x', label: 'x', dur } })
	assert.ok(add(0), 'the spec says dur > 0 but the applier accepted zero')
	assert.match(add(0.5) ?? '', /whole number of MINUTES/, 'a fractional dur was accepted — v7 durations are whole minutes')
	assert.doesNotMatch(add(15) ?? '', /dur/, 'fifteen minutes was refused')

	// Every task time shares ONE definition, so the instant rule is stated once.
	for (const f of ['notBefore', 'due', 'refinedAt'])
		assert.ok(task.properties[f]!.description!.includes(INSTANT), `${f} does not use INSTANT`)
})

/** The routes as the source declares them — what the served spec will be built
 *  from once Fastify has registered them. */
const specRoutes = () => [...registeredRoutes()].map(k => {
	const [method, ...rest] = k.split(' ')
	return { method: method!, url: rest.join(' ') }
})

test('the collector records what Fastify registers, including a prefixed child', async () => {
	// THE MECHANISM, not the content. `onRoute` is the whole basis for "a route
	// cannot be missing", and it has one property worth pinning: a hook added at
	// the root has to see routes registered inside an encapsulated child, or every
	// route under `/api` — which is all of them — would silently not be collected.
	const { default: fastify } = await import('fastify')
	const app = fastify()
	const seen: { method: string; url: string }[] = []
	app.addHook('onRoute', r => {
		for (const m of Array.isArray(r.method) ? r.method : [r.method])
			if (m !== 'HEAD' && m !== 'OPTIONS') seen.push({ method: m, url: r.url })
	})
	app.get('/bare', async () => ({}))
	await app.register(async (api) => {
		api.get('/inside', async () => ({}))
		api.route({ method: ['GET', 'POST'], url: '/both', handler: async () => ({}) })
	}, { prefix: '/api' })
	await app.ready()
	const keys = seen.map(r => `${r.method} ${r.url}`).sort()
	assert.deepEqual(keys, ['GET /api/both', 'GET /api/inside', 'GET /bare', 'POST /api/both'])
	await app.close()

	// And `collectRoute` itself dedupes and drops HEAD, which Fastify adds beside
	// every GET without anybody writing one.
	const before = routeTable().length
	collectRoute({ method: ['GET', 'HEAD'], url: '/x' })
	collectRoute({ method: 'GET', url: '/x' })
	assert.equal(routeTable().length, before + 1)
})

test('the document is well-formed enough to serve', () => {
	const spec = buildSpec(specRoutes())
	assert.equal(spec.openapi, '3.1.0')
	assert.ok(spec.info.title && spec.info.version)
	assert.ok(Object.keys(spec.paths).length >= 12)

	// EVERY $ref RESOLVES. A dangling one renders as an empty box in Scalar and as
	// nothing at all to a model reading the JSON — a failure that looks like the
	// endpoint having no body rather than like a typo.
	const names = new Set(Object.keys(spec.components.schemas))
	const refs = [...JSON.stringify(spec).matchAll(/"#\/components\/schemas\/([A-Za-z]+)"/g)]
		.map(m => m[1]!)
	const dangling = [...new Set(refs)].filter(r => !names.has(r)).sort()
	assert.deepEqual(dangling, [], 'unresolvable $ref in the spec')

	// Every authenticated operation says so, or the docs invite a 404.
	for (const [url, ops] of Object.entries(spec.paths))
		for (const [verb, op] of Object.entries(ops as Record<string, { security: unknown[] }>)) {
			const key = `${verb.toUpperCase()} ${url}`
			const wants = ROUTE_DOCS[key]!.auth
			assert.equal(op.security.length > 0, wants, `${key} security does not match its auth`)
		}

	// EVERY operationId UNIQUE. They are derived from the path, so a collision is
	// not a typo — it is two routes whose names differ only by the `/api` prefix
	// this drops, and a generated client would silently define one of them twice.
	const ids: string[] = []
	for (const ops of Object.values(spec.paths))
		for (const op of Object.values(ops as Record<string, { operationId: string }>))
			ids.push(op.operationId)
	assert.equal(new Set(ids).size, ids.length,
		`duplicate operationId: ${ids.filter((v, i) => ids.indexOf(v) !== i).join(', ')}`)
	assert.ok(ids.every(i => /^[a-z][A-Za-z0-9]*$/.test(i)), `not an identifier: ${ids.join(', ')}`)

	// It has to survive the round trip it will actually make.
	assert.doesNotThrow(() => JSON.parse(JSON.stringify(spec)))
})
