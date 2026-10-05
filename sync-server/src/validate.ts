// THE DOCUMENT VALIDATOR. Lifted verbatim from `invalid()` in the original
// tool's `api.ts` — same rules, same wording, same order, so a rejection message
// a human has seen before still reads the same.
//
// WHY A COPY AND NOT AN IMPORT, since a second copy is the thing this codebase
// most distrusts: the original lives in a different repository
// (`explorables/viz-pages/timeline-studio/api.ts`), which is in daily use and is
// not a package. There is no import path, and the container build has no way to
// reach it. The honest resolution is not to keep two copies in sync forever —
// it is that this file BECOMES the only copy when the original tool retires,
// which is the point of the rebuild. Until then, treat the original as the
// source: if a rule changes there, change it here.
//
// It is deliberately NOT in `shared/`. `shared/commands.js` says so itself —
// command validation is "a check on whether the COMMAND is well-formed enough to
// be applied at all", and this is the check on the resulting DOCUMENT, which the
// server runs after applying and the browser never runs at all.
//
// It does NOT check for dependency cycles, for the same reason it did not in the
// original: that would be a second copy of the scheduler on this side of the
// wire, and `sched()` refuses them loudly when the plan is opened.

import { TASK_FIELDS } from '../../shared/commands.js'
import { SCHEMA } from '../../shared/schedule.js'

/** Returns a reason the document may not be stored, or `null` if it may. */
export function invalid(doc: any): string | null {
	// The original could assume a parsed file with a `tasks` array because
	// `/save` checked that at the door. Here the doc can also arrive from S3, so
	// the check moves inside rather than being a precondition every caller has to
	// remember.
	if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tasks)) return 'doc.tasks missing'
	if (doc.schemaVersion !== SCHEMA)
		return (
			`schemaVersion must be ${SCHEMA} — got ${JSON.stringify(doc.schemaVersion)}. ` +
			`Older documents are upgraded by the migration ladder when they are opened; write current ones.`
		)
	// REQUIRED FROM v6: the zone the plan's days are counted in. The rung gives
	// every older plan one, so only a hand-built document can arrive without.
	try {
		if (typeof doc.timeZone !== 'string') throw 0
		new Intl.DateTimeFormat('en-US', { timeZone: doc.timeZone })
	} catch {
		return `timeZone must be an IANA zone name like "America/Chicago" — got ${JSON.stringify(doc.timeZone)}`
	}
	const pool = (k: string) => new Set((doc[k] || []).map((x: any) => x && x.id))
	const lanes = pool('lanes'),
		borders = pool('borders'),
		fills = pool('fills')
	const shapes = pool('shapes'),
		colors = pool('colors'),
		miles = pool('milestones')
	const ids = new Set<string>()
	for (const t of doc.tasks) {
		if (!t || typeof t.id !== 'string' || !t.id) return 'every task needs a non-empty string id'
		if (ids.has(t.id)) return `two tasks share the id ${JSON.stringify(t.id)}`
		ids.add(t.id)
	}
	for (const t of doc.tasks) {
		const at = (m: string) => `task ${JSON.stringify(t.id)}: ${m}`
		// ONLY TASK FIELDS FROM v9: the rung drops every other key, so one here is a hand-built or misspelt document.
		const stray = Object.keys(t).find(k => !TASK_FIELDS.has(k))
		if (stray) return at(`${stray} is not a task field`)
		if (typeof t.label !== 'string') return at('label must be a string')
		// REQUIRED FROM v5. The v4 -> v5 rung fills it for every older task, and
		// every command is stamped with `at` on the way in, so `addTask` always
		// has one to give.
		if (typeof t.createdAt !== 'string' || Number.isNaN(Date.parse(t.createdAt)))
			return at('createdAt must be an ISO instant — when the task was added')
		// THE TIMES ARE STORED INSTANTS FROM v6, in the one shape the applier
		// writes. Commands are checked on the way in; this is for a document that
		// arrives whole — an import, a fork, a hand-edited file.
		for (const k of ['notBefore', 'refinedAt', 'due'])
			if (t[k] != null && !(typeof t[k] === 'string' && /Z$/.test(t[k]) && !Number.isNaN(Date.parse(t[k]))))
				return at(`${k} must be a UTC ISO instant ("2026-09-26T08:16:00.000Z") — got ${JSON.stringify(t[k])}`)
		if (t.comments != null) {
			if (!Array.isArray(t.comments)) return at('comments must be an array')
			for (const c of t.comments)
				if (!c || typeof c.id !== 'string' || typeof c.text !== 'string' || typeof c.by !== 'string'
					|| typeof c.at !== 'string' || Number.isNaN(Date.parse(c.at)))
					return at('every comment needs id, text, by and an ISO `at`')
		}
		// SESSIONS ARE THE ONLY RECORD OF WORK FROM v8 (ADR 0016): a finished task
		// says when it finished with a session that is not running.
		if (t.done !== undefined && t.done !== true) return at('done must be true, or absent')
		if (t.sessions != null && !Array.isArray(t.sessions)) return at('sessions must be an array')
		if (t.planned != null && !Array.isArray(t.planned)) return at('planned must be an array of { start, stop }')
		const ss = t.sessions || []
		if (t.done && (!ss.length || ss.some((x: any) => x.stop === null)))
			return at('a finished task needs at least one session, and none still running')
		// WHOLE MINUTES FROM v7. Zero survives here only because a document older
		// than the rule may carry one; commands refuse it.
		if (!Number.isInteger(t.dur) || !(t.dur >= 0))
			return at(`dur must be a whole number of MINUTES, zero or more — got ${JSON.stringify(t.dur)}`)
		if (!Array.isArray(t.deps)) return at('deps must be an array of task ids')
		if (!Array.isArray(t.color))
			return at('color must be an ARRAY of colour ids (a task can touch two systems)')
		if (!lanes.has(t.lane)) return at(`lane ${JSON.stringify(t.lane)} is not one of doc.lanes`)
		if (!borders.has(t.border)) return at(`border ${JSON.stringify(t.border)} is not one of doc.borders`)
		if (!fills.has(t.fill)) return at(`fill ${JSON.stringify(t.fill)} is not one of doc.fills`)
		if (!shapes.has(t.shape)) return at(`shape ${JSON.stringify(t.shape)} is not one of doc.shapes`)
		if (t.ms != null && !miles.has(t.ms)) return at(`ms ${JSON.stringify(t.ms)} is not one of doc.milestones`)
		for (const c of t.color) if (!colors.has(c)) return at(`colour ${JSON.stringify(c)} is not one of doc.colors`)
		for (const d of t.deps) {
			if (d === t.id) return at('depends on itself')
			if (!ids.has(d)) return at(`depends on ${JSON.stringify(d)}, which is not a task in this plan`)
		}
	}
	return null
}

// Plan ids become S3 key components, so they are restricted rather than
// sanitised — ADR 0002 is emphatic that an id is human-meaningful and is NOT the
// capability, so quietly rewriting `../../etc/x` into something adjacent would
// hand back a plan nobody asked for. Same regex as the original tool.
export const okId = (id: unknown): id is string =>
	typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)
