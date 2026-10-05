// THE API, DESCRIBED ONCE, IN A FORM A MACHINE CAN READ.
//
// DERIVED FROM THE FASTIFY ROUTE TABLE, which is the requirement and not a
// detail: the failure that put this in the plan was a cold agent reading the
// docs end to end and still missing an endpoint. A hand-written spec cannot fix
// that — it fails in exactly that direction, by omission, and silently. So the
// PATHS come from an `onRoute` hook that sees every route Fastify registers, and
// a route that nobody has written prose for still appears, flagged. The spec can
// be thin about an endpoint. It cannot be missing one.
//
// WHAT IS HAND-WRITTEN IS THE PROSE, in `ROUTE_DOCS` below — summaries, bodies,
// response shapes. That is the half no route table contains.
//
// WHY NOT @fastify/swagger, which is the obvious answer to all of this. It builds
// a spec out of each route's `schema`, and not one route on this server has one,
// so it would emit a list of paths and nothing else. Adding `schema.response` to
// get the bodies back turns on fast-json-stringify, which STRIPS any property the
// schema forgot — and `/plan` returns a whole plan whose shape is the user's, not
// ours. A document endpoint quietly losing fields is a worse outcome than a thin
// spec. So: their route collection, our descriptions, nobody's serializer.
//
// `test/openapi.test.ts` closes the other direction — prose describing a route
// that does not exist — and pins the command vocabulary to `applyCommand`'s own
// switch, in both directions.
//
// IT IS WRITTEN FOR AN AGENT FIRST. `web/AGENTS.md` is the prose companion and
// says WHY you would call something; this says what goes on the wire. The rule
// between them is that a mechanical fact lives here and is referred to there.

/** Every command `type` the protocol accepts. Mirrors the switch in
 *  `shared/commands.js`; the test asserts the two agree, in both directions. */
export const COMMAND_TYPES = [
	'addTask', 'removeTask', 'renameTask', 'setTaskDesc', 'setTaskUrl', 'setTaskRef',
	'setDuration', 'addDep', 'removeDep', 'setTaskChannel', 'setTaskColors',
	'setNotBefore', 'setNoQueue', 'setPlanned', 'completePlanned', 'setRecur', 'startTask', 'stopTask', 'finishTask', 'reopenTask', 'setSessions', 'setRefined', 'setMilestone', 'setDue',
	'moveTaskInLane', 'patchDoc', 'addComment', 'editComment', 'removeComment',
	'addRankAnswer', 'removeRankAnswer', 'resetRanking',
	'setRankSuggestion',
] as const

/** What every task time means, stated once — the test holds each of them to it. */
export const INSTANT =
	'An ISO instant WITH a zone — `2026-09-26T08:16:00Z`, or any offset like `2026-09-26T03:16:00-05:00`, ' +
	'stored as UTC. A time with no zone is refused, and so is a number: these were day numbers ' +
	'until schema v6. Which calendar day an instant falls on is decided in `doc.timeZone`.'

/** EACH COMMAND'S PAYLOAD, so the spec alone says what goes on the wire. The
 *  `Command` union in `shared/types.ts` is the source; `test/openapi.test.ts`
 *  holds every variant here to it, field for field, in both directions. */
const id = { type: 'string', description: 'The task it acts on.' }
const when = (what: string) => ({ type: ['string', 'null'], description: `${what} ${INSTANT} \`null\` clears it.` })
const text = (what: string) => ({ type: ['string', 'null'], description: `${what} \`null\` clears it.` })
const COMMAND_PAYLOADS: Record<(typeof COMMAND_TYPES)[number], { summary: string; properties: Record<string, unknown>; required: string[] }> = {
	addTask: { summary: 'Append a task, last in its lane\'s queue.', required: ['task'], properties: {
		task: { $ref: '#/components/schemas/Task',
			description: '`Task` fields only — any other key is refused; only `id` is required. Channel fields left out are filled from the plan\'s `defaults`. `createdAt` is stamped from the envelope\'s `at`.' } } },
	removeTask: { summary: 'Delete a task.', required: ['id'], properties: { id } },
	renameTask: { summary: 'Change a task\'s label. Clears its sign-off (`refinedAt`).', required: ['id', 'label'], properties: { id, label: { type: 'string' } } },
	setTaskDesc: { summary: 'Change a task\'s description. Clears its sign-off; log progress with `addComment` instead.', required: ['id', 'desc'], properties: { id, desc: text('Markdown.') } },
	setTaskUrl: { summary: 'Set a task\'s link.', required: ['id', 'url'], properties: { id, url: text('A URL.') } },
	setTaskRef: { summary: 'Set a task\'s external reference (a ticket id, say).', required: ['id', 'ref'], properties: { id, ref: text('Free text.') } },
	setDuration: { summary: 'Change a task\'s duration. Clears its sign-off.', required: ['id', 'dur'], properties: { id, dur: { type: 'integer', exclusiveMinimum: 0, description: 'Whole MINUTES, as `Task.dur`.' } } },
	addDep: { summary: 'Make `id` wait on `dep`.', required: ['id', 'dep'], properties: { id, dep: { type: 'string', description: 'The task it waits on.' } } },
	removeDep: { summary: 'Stop `id` waiting on `dep`.', required: ['id', 'dep'], properties: { id, dep: { type: 'string' } } },
	setTaskChannel: { summary: 'Set one of a task\'s channels to a value the plan defines.', required: ['id', 'channel', 'value'], properties: { id,
		channel: { type: 'string', enum: ['lane', 'border', 'fill', 'shape'] },
		value: { type: 'string', description: 'The id of a lane, border, fill or shape in the plan.' } } },
	setTaskColors: { summary: 'Set a task\'s project colours.', required: ['id', 'colors'], properties: { id, colors: { type: 'array', items: { type: 'string' }, description: 'Ids from the plan\'s `colors`.' } } },
	setNotBefore: { summary: 'The earliest a task may start.', required: ['id', 'notBefore'], properties: { id, notBefore: when('Not before this instant.') } },
	setNoQueue: { summary: 'Keep a task out of its lane\'s capacity (an agent\'s own work, say).', required: ['id', 'noQueue'], properties: { id, noQueue: { type: 'boolean' } } },
	setPlanned: { summary: 'Replace the task\'s PLANNED stretches: what is promised, in the same shape as `sessions` (what happened) but each with an end. In order, no overlaps; `[]` clears them. The scheduler holds those times in wall-clock time (outside working hours is fine), works the rest of the plan around them, and does not queue the task. A planned task ignores what it waits on: check the slack chip. Refused on a finished task. Repeating tasks do not carry planned stretches to their copies.', required: ['id', 'planned'], properties: { id, planned: { type: 'array', items: { type: 'object', required: ['start', 'stop'], properties: { start: when('When this stretch is promised to begin.'), stop: when('When it is promised to end; after `start`.') } } } } },
	completePlanned: { summary: 'That planned stretch happened: moves it from `planned` into `sessions`. `start` and `stop` default to the stretch\'s own times and may be corrected (it ran 1:05 to 3:10, not 1 to 3). Refused if the resulting sessions would overlap. Finishing a never-started task does the same for the stretches already under way.', required: ['id', 'index'], properties: { id, index: { type: 'integer', minimum: 0, description: 'Position in `planned`.' }, start: when('When it really began; default the stretch\'s start.'), stop: when('When it really ended; default the stretch\'s end.') } },
	setRecur: { summary: 'Repeat a task on the calendar, every `n` days, weeks or months counted from its `notBefore` (the first occurrence), or from its `due` when it has no start. Each copy is an ordinary task that keeps the sign-off; `ahead` copies wait beyond the open one, and finishing a copy adds the next. `null` ends the series. Changing `n` or `unit` on a repeating task is refused: end it first.', required: ['id', 'recur'], properties: { id,
		recur: { nullable: true, type: 'object', required: ['n', 'unit'], properties: { n: { type: 'integer', minimum: 1, maximum: 999 }, unit: { type: 'string', enum: ['day', 'week', 'month'] }, ahead: { type: 'integer', minimum: 0, maximum: 30, description: 'Copies waiting beyond the open one. Default 1.' } } } } },
	startTask: { summary: 'Start working on a task now: opens a session. Refused on a finished task (reopen it first) or one already running. Never clears the sign-off.', required: ['id'], properties: { id } },
	stopTask: { summary: 'Stop working on a task now: closes its running session. This is pausing, not finishing: the task stays in progress.', required: ['id'], properties: { id } },
	finishTask: { summary: 'Finish a task now: sets `done` and stops its running session. A task never started gets a session of no length at this moment, so every finished task says when it finished (its last stop). Takes it out of the ranking; a repeating copy adds the next.', required: ['id'], properties: { id } },
	reopenTask: { summary: 'Un-finish a task: clears `done` and keeps its sessions, so it is paused. Start it to work on it again.', required: ['id'], properties: { id } },
	setSessions: { summary: 'Replace the task\'s whole list of work sessions, which is how you correct one: stopped at 4pm, not when you noticed. In order, no overlaps, only the last may still run (`stop: null`), and none on a finished task. A task that has sessions keeps at least one: there is no way back to not started (split the task to start over). Never clears the sign-off.', required: ['id', 'sessions'], properties: { id,
		sessions: { type: 'array', items: { type: 'object', required: ['start', 'stop'], properties: { start: when('When this stretch of work began.'), stop: when('When it ended; null while it runs.') } } } } },
	setRefined: { summary: 'The person\'s sign-off. An agent never sends this for its own work.', required: ['id', 'refinedAt'], properties: { id, refinedAt: when('When it was signed off.') } },
	setMilestone: { summary: 'Put a task under a milestone.', required: ['id', 'ms'], properties: { id, ms: text('A milestone id from the plan.') } },
	setDue: { summary: 'A task\'s due date.', required: ['id', 'due'], properties: { id, due: when('Due by this instant.') } },
	addComment: { summary: 'Append a comment: how to log progress without touching the description.', required: ['id', 'comment'], properties: { id,
		comment: { type: 'object', required: ['text'], description: 'Over HTTP the server fills `id` and `by` when they are missing.', properties: {
			id: { type: 'string' }, text: { type: 'string', description: 'Markdown.' }, at: { type: 'string', description: INSTANT }, by: { type: 'string' } } } } },
	editComment: { summary: 'Rewrite a comment.', required: ['id', 'commentId', 'text'], properties: { id, commentId: { type: 'string' }, text: { type: 'string' } } },
	removeComment: { summary: 'Delete a comment.', required: ['id', 'commentId'], properties: { id, commentId: { type: 'string' } } },
	moveTaskInLane: { summary: 'Move a task within its lane\'s queue.', required: ['id', 'toIndex'], properties: { id, toIndex: { type: 'integer', minimum: 0, description: 'Its new position in the lane\'s queue.' } } },
	addRankAnswer: { summary: 'Record the person\'s answer to "which should happen first?".', required: ['a', 'b', 'verdict'], properties: {
		a: { type: 'string', description: 'One of the two tasks in the pair.' },
		b: { type: 'string', description: 'The other task in the pair.' },
		verdict: { type: 'integer', enum: [-1, 0, 1], description: 'Which should happen first — `-1` `a`, `1` `b`, `0` equal. It is the USER\'s preference: record what the user said, never an answer of your own.' } } },
	removeRankAnswer: { summary: 'Withdraw an answer.', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } },
	resetRanking: { summary: 'Forget every answer.', required: [], properties: {} },
	setRankSuggestion: { summary: 'Propose an order for the ranking WITHOUT answering for the person: held apart as `doc.rankSuggestion`, a backdrop beneath their answers. A newer suggestion replaces it; there is no adopting or discarding.', required: ['order'], properties: {
		by: { type: 'string', description: 'Who is suggesting. Over HTTP the server fills it from `x-timeline-by` when missing.' },
		order: { type: 'array', minItems: 2, description: 'The tasks, first to happen first. Unfinished tasks only, each once. A task you leave out has no suggested place.', items: { type: 'object', required: ['id', 'why'], properties: {
			id: { type: 'string' },
			why: { type: 'string', description: 'One line on why it sits here. Required: it is what lets the person check the placement instead of trusting it.' },
			toss: { type: 'boolean', description: 'True when this placement is close to a coin flip, so the person looks there first.' } } } } } },
	patchDoc: { summary: 'Change document-level fields (title, lanes, colors, milestones, …) by sending their new values.', required: ['patch'], properties: {
		patch: { type: 'object', additionalProperties: true, description: 'Top-level `Doc` fields and their new values. There is no `addMilestone`: send the whole new `milestones` list.' } } },
}

/** `Command` as a tagged union, one schema per command, named `<Type>Command`. */
function commandSchemas() {
	const name = (t: string) => t[0]!.toUpperCase() + t.slice(1) + 'Command'
	const variants = Object.fromEntries(COMMAND_TYPES.map(t => [name(t), {
		type: 'object',
		description: COMMAND_PAYLOADS[t].summary,
		properties: {
			type: { const: t },
			at: { type: 'string', description: `Optional, any command: when the sender issued it. ${INSTANT}` },
			...COMMAND_PAYLOADS[t].properties,
		},
		required: ['type', ...COMMAND_PAYLOADS[t].required],
	}]))
	return { variants, oneOf: COMMAND_TYPES.map(t => ({ $ref: `#/components/schemas/${name(t)}` })),
		mapping: Object.fromEntries(COMMAND_TYPES.map(t => [t, `#/components/schemas/${name(t)}`])) }
}

/** Every route the server has registered, in registration order. Filled by the
 *  `onRoute` hook — see `collectRoute`. */
const registered: { method: string; url: string }[] = []

/** Fastify's `onRoute` hook shape, narrowed to the two fields this needs.
 *  `method` is a string or an array of them for a multi-method route. */
export function collectRoute(r: { method: string | string[]; url: string }) {
	for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
		// HEAD IS FASTIFY'S, NOT OURS. It adds one automatically beside every GET;
		// documenting it would double the spec with operations nobody wrote.
		if (m === 'HEAD' || m === 'OPTIONS') continue
		const key = `${m.toUpperCase()} ${r.url}`
		if (!registered.some(x => `${x.method} ${x.url}` === key)) registered.push({ method: m.toUpperCase(), url: r.url })
	}
}

export const routeTable = () => registered.slice()

/** The prose overlay, keyed `METHOD /path` exactly as Fastify reports it. A key
 *  here that no route answers to is caught by the test; a route with no key here
 *  still reaches the spec, marked `x-undocumented`. */
export const ROUTE_DOCS: Record<string, {
	summary: string
	description?: string
	tags: string[]
	auth: boolean
	/** Only where the derived name would collide or mislead. See `opIdFor`. */
	opId?: string
	query?: Record<string, { type: string; description: string }>
	body?: unknown
	ok?: unknown
}> = {
	'GET /health': {
		// `getHealth` belongs to the one anybody can reach; this is the origin-only
		// twin, and a generated client calling it would be talking past CloudFront.
		opId: 'getOriginHealth',
		summary: 'Liveness, and the shared-code digest',
		description:
			'Served at the origin without the `/api` prefix because the ALB target group ' +
			'health-checks it directly. Carries the sha256 of `shared/schedule.js` and ' +
			'`shared/commands.js`, so a server running a different protocol from the page ' +
			'is visible here rather than only in behaviour (ADR 0001). `commit` is the git sha the ' +
			'image was built from (`null` outside a CI image), which a deploy checks against.',
		tags: ['service'], auth: false,
	},
	'GET /api/health': {
		summary: 'Liveness, reachable through CloudFront',
		description: 'The same handler as the bare `/health`. Both exist because only `/api/*` ' +
			'is forwarded to this service.',
		tags: ['service'], auth: false,
	},
	'GET /api/readyz': {
		summary: 'Readiness — can this server actually serve a plan',
		description:
			'`200` when the plan store answers, `503` when it does not. NOT the same question as ' +
			'`/health`, which is liveness: the ALB replaces a task that fails that one, so making it ' +
			'depend on S3 would turn a slow bucket into a restart loop. This is what ' +
			'`scripts/smoke.sh` gates a deploy on, so a deploy into an environment whose bucket is ' +
			'unreachable fails instead of going green.\n\n' +
			'Nothing should poll it: a poll holds the service awake and defeats the idle shutdown. ' +
			'For "what work can I pick up now", you want `/api/ready`.',
		tags: ['service'], auth: false,
		ok: {
			type: 'object',
			properties: { ok: { type: 'boolean' }, store: { type: 'string', enum: ['ok', 'unreachable'] } },
			required: ['ok', 'store'],
		},
	},
	'GET /api/rooms': {
		summary: 'How many plans are held in memory',
		description: 'The one place a leaked room is visible from outside: a room still loaded ' +
			'with nobody connected keeps this above zero and the service never scales to zero.',
		tags: ['service'], auth: false,
		ok: { type: 'object', properties: { openRooms: { type: 'integer' } }, required: ['openRooms'] },
	},
	'POST /api/plan/new': {
		summary: 'Create a plan and mint its share token',
		description:
			'The only route that takes no token, and it cannot take one: minting the ' +
			'caller\'s first capability is the whole point. New, Fork and Import are this ' +
			'one operation differing only in what `doc` you send.\n\n' +
			'**The token comes back in the BODY and nowhere else** — not the URL, not a ' +
			'response header — because bodies are the one place generic tracing and proxy ' +
			'logging do not capture by default. Treat `shareToken` as the whole credential.',
		tags: ['plan'], auth: false,
		body: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Display name. A hint for humans; the token is the address.' },
				doc: { $ref: '#/components/schemas/Doc', description: 'Omit for the starter plan. Supply one to fork or import.' },
				note: { type: 'string', description: 'Note on the first archived version.' },
			},
		},
		ok: {
			type: 'object',
			properties: {
				ok: { const: true },
				id: { type: 'string', description: 'Display hint. Reaches nothing on its own.' },
				shareToken: { type: 'string', description: '22 characters of base64url. THE credential — read/write on this plan for anyone holding it.' },
			},
			required: ['ok', 'id', 'shareToken'],
		},
	},
	'GET /api/plan': {
		summary: 'The live shared draft',
		description: 'What everyone in the room is looking at right now, including edits nobody ' +
			'has saved. `seq` and `epoch` together identify a position in the room\'s sequence.',
		tags: ['plan'], auth: true,
		ok: {
			type: 'object',
			properties: {
				id: { type: 'string' },
				seq: { type: 'integer', description: 'Commands applied since this room was loaded.' },
				epoch: { type: 'string', description: 'Which room instance produced that `seq`. Changes when the room reloads.' },
				viewers: { type: 'integer', description: 'Sessions with a presence. Lurkers are not counted.' },
				doc: { $ref: '#/components/schemas/Doc' },
			},
			required: ['id', 'seq', 'epoch', 'viewers', 'doc'],
		},
	},
	'POST /api/commands': {
		summary: 'Apply one or more commands to the live plan',
		description:
			'The write path, and the same `apply` a click goes through — connected clients ' +
			'see the result immediately.\n\n' +
			'**A batch is atomic and ordered.** Either every command applies or none does, ' +
			'and a rejection answers 400 with the validator\'s own words. Each command\'s ' +
			'payload is its `<Type>Command` schema, under `Command`; `/commands.js` is the ' +
			'code both sides run.\n\n' +
			'Applying is not saving — `POST /api/save` writes the version that carries a note.',
		tags: ['plan'], auth: true,
		body: {
			type: 'object',
			description: 'Exactly one of `cmd` or a non-empty `cmds`.',
			properties: {
				cmd: { $ref: '#/components/schemas/Command' },
				cmds: { type: 'array', items: { $ref: '#/components/schemas/Command' }, minItems: 1 },
			},
		},
		ok: {
			type: 'object',
			properties: { ok: { const: true }, applied: { type: 'integer' }, seq: { type: 'integer' } },
			required: ['ok', 'applied', 'seq'],
		},
	},
	'POST /api/save': {
		summary: 'Archive a version, with a note',
		description: 'The note is the only description of a change anybody gets later. ' +
			'`snapshot` is false when the document is byte-identical to the last version — ' +
			'saving twice with no edit between does not mint a second copy.',
		tags: ['history'], auth: true,
		body: { type: 'object', properties: { note: { type: 'string' } } },
		ok: {
			type: 'object',
			properties: {
				ok: { const: true }, id: { type: 'string' }, n: { type: 'integer' },
				snapshot: { type: 'boolean' }, at: { type: 'string', format: 'date-time' },
				note: { type: 'string' }, by: { type: 'string' },
			},
			required: ['ok', 'id', 'n', 'snapshot', 'at'],
		},
	},
	'GET /api/history': {
		summary: 'Every archived version',
		tags: ['history'], auth: true,
		query: {
			meta: { type: 'string', description: 'Any value drops the `doc` from each entry. Send it unless you need the documents — a full history is large.' },
			last: { type: 'string', description: 'Any value returns only the newest version. This is the one that is CHEAP: `meta` trims the response but still reads every version out of storage, because the metadata lives inside each one.' },
		},
		ok: { type: 'object', properties: { versions: { type: 'array', items: { $ref: '#/components/schemas/Version' } } }, required: ['versions'] },
	},
	'GET /api/version': {
		summary: 'One archived version',
		tags: ['history'], auth: true,
		query: { n: { type: 'integer', description: 'Version number, 1-based. Required.' } },
		ok: { allOf: [{ $ref: '#/components/schemas/Version' }, { type: 'object', properties: { n: { type: 'integer' } } }] },
	},
	'POST /api/histnote': {
		summary: 'Rewrite the note on an archived version',
		description: 'The note only. The document in a version is never edited — that is what ' +
			'makes it an archive.',
		tags: ['history'], auth: true,
		body: { type: 'object', properties: { n: { type: 'integer' }, note: { type: 'string' } }, required: ['n'] },
	},
	'POST /api/revert': {
		summary: 'Make an archived version the live plan again',
		description: 'Archives the current state first, so a revert is never a way to lose ' +
			'work. `archived` is the version number that state was written to.',
		tags: ['history'], auth: true,
		body: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
		ok: { type: 'object', properties: { ok: { const: true }, from: { type: 'integer' }, archived: { type: 'integer' } }, required: ['ok', 'from'] },
	},
	'GET /api/ready': {
		summary: 'What could be started right now',
		description: 'Not-started tasks with every dependency finished or dropped, their ' +
			'earliest date passed and their team free. GET asks about the live plan.\n\n' +
			'**Only not-started (`todo`) tasks come back, best `rank` first.** A row that is not ' +
			'startable yet is still there with `ready: false` and `waitingOn` saying why. ' +
			'`?all=1` returns every task with its `status` (`todo`, `running`, `paused`, `done`) instead.\n\n' +
			'Each row also carries `rank`: where the task sits in the plan\'s "what should happen ' +
			'first?" ranking (1 is first, ties share a number), or null when it is not ranked yet. ' +
			'The ranking is the person\'s answer — read it, never answer it for them. `suggestedRank` is the ' +
			'same number from a suggestion (`doc.rankSuggestion`), or null when none covers the task; ' +
			'it is never mixed into `rank`.',
		tags: ['answers'], auth: true,
		query: { all: { type: 'string', description: '`1` returns every task with its status, not just the not-started ones.' } },
	},
	'POST /api/ready': {
		summary: 'What could be started in a plan you supply',
		description: 'Same answer against a hypothetical `doc`. Opens no room and changes nothing.',
		tags: ['answers'], auth: true,
		body: { type: 'object', properties: { doc: { $ref: '#/components/schemas/Doc' } } },
	},
	'GET /api/verdict': {
		summary: 'What this plan lands on, and whether each milestone is met',
		description: 'A cycle throws rather than returning a wrong answer — that is a 400, ' +
			'not an empty result.',
		tags: ['answers'], auth: true,
	},
	'POST /api/verdict': {
		summary: 'What a plan you supply would land on',
		tags: ['answers'], auth: true,
		body: { type: 'object', properties: { doc: { $ref: '#/components/schemas/Doc' } } },
	},
	'GET /api/reorder': {
		summary: 'Which row to move, and which team goes on top',
		description:
			'`/verdict` says what the plan lands on; this says what it would land on with the ' +
			'queues in a better order — the one scheduling input that leaves no trace in the ' +
			'document and no arrow on the chart.\n\n' +
			'**It suggests, it never applies.** Every entry is measured against the CURRENT ' +
			'order, so taking one invalidates the rest: apply a single `moveTaskInLane` and ask again.\n\n' +
			'Dates come first. When no move changes any date, a move that puts a paused task ahead of ' +
			'unstarted work comes next, with `paused: true` and `ranked` counting the paused-before-unstarted ' +
			'pairs it fixes (ADR 0019); the moves below never break one of those pairs. Then a move that brings the queue closer to ' +
			'the plan\'s ranking is suggested with `gain: 0` and `ranked`: how many ranked pairs it ' +
			'puts in the order the person asked for. After those, and only where the person\'s own ranking is ' +
			'indifferent, a move toward a SUGGESTION (`doc.rankSuggestion`) is offered the same way, ' +
			'with `suggested: true` and `ranked` counting suggested pairs; `useRankSuggestion: false` turns that off.',
		tags: ['answers'], auth: true,
		query: {
			limit: { type: 'integer', description: 'Suggestions to return. Default 20.' },
			maxLane: { type: 'integer', description: 'Largest lane to search within. Default 40 — the search is quadratic in lane size.' },
		},
	},
	'POST /api/reorder': {
		summary: 'Reorder suggestions for a plan you supply',
		tags: ['answers'], auth: true,
		body: { type: 'object', properties: { doc: { $ref: '#/components/schemas/Doc' } } },
	},
	'GET /api/connect': {
		summary: 'The live room (WebSocket)',
		description:
			'**Not an HTTP route — an Upgrade.** OpenAPI cannot describe a WebSocket, so it is ' +
			'listed for completeness and the frame protocol is not here. Open it, send ' +
			'`{type:"hello", token}`, and you receive every command applied by anyone. ' +
			'`{type:"cmd", cmd}` writes. `{lurk:true}` joins without a presence.\n\n' +
			'Everything the socket can do, `/api/commands` can do too — the socket exists so ' +
			'you SEE other people\'s edits, not so you can make your own.',
		tags: ['service'], auth: true,
	},
	'GET /api/openapi.json': {
		summary: 'This document',
		tags: ['service'], auth: false,
	},
	'GET /api/docs': {
		summary: 'This document, rendered',
		tags: ['service'], auth: false,
	},
	'GET /commands.js': {
		summary: 'The command code the page and this server both run',
		description: '`shared/commands.js`. Every payload is also in this document, under `Command`.',
		tags: ['service'], auth: false,
	},
	'GET /AGENTS.md': {
		summary: 'The prose companion to this document',
		description: 'Why you would call a thing, and the plan conventions this API does not state. ' +
			'In production the page serves it; here it answers so a local API is not a dead end.',
		tags: ['service'], auth: false,
	},
	'GET /llms.txt': {
		summary: 'The short version, for an agent arriving with only a link',
		tags: ['service'], auth: false,
	},
}

const errorResponse = {
	description: 'The request could not be served. `error` is the validator\'s own words.',
	content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
}

/** DERIVED, NOT TYPED TWICE. `operationId` is the name every code generator and
 *  every model reaching for a tool will use, so it must be stable and unique —
 *  and a hand-written one is a third place for the path to drift away from.
 *  `POST /api/plan/new` becomes `postPlanNew`; the `/api` prefix is dropped
 *  because every route has it and it names nothing. The uniqueness this relies
 *  on is asserted in the test rather than assumed. */
function opIdFor(method: string, url: string): string {
	const parts = url.replace(/^\/api\//, '/').split('/').filter(Boolean)
	return method.toLowerCase() + parts
		.map(p => p.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string) => (c ? c.toUpperCase() : '')))
		.map(p => p.charAt(0).toUpperCase() + p.slice(1))
		.join('')
}

/** Assemble the OpenAPI document from a route table.
 *
 *  THE TABLE IS AN ARGUMENT rather than a global read, and that is what makes
 *  both halves testable: the server hands it the routes Fastify actually
 *  registered, and the test hands it the routes `server.ts` textually declares.
 *  Same function, two sources, and they have to agree with the same overlay. */
export function buildSpec(routes: { method: string; url: string }[] = routeTable()) {
	const commands = commandSchemas()
	const paths: Record<string, Record<string, unknown>> = {}
	for (const { method, url } of routes) {
		const key = `${method} ${url}`
		// A ROUTE NOBODY DESCRIBED STILL GETS AN ENTRY. This is the whole reason the
		// paths come from the route table: the way a spec fails a reader is by
		// leaving an endpoint out, and an entry saying "undocumented" is a thing
		// somebody can see and fix. Missing is not.
		const r = ROUTE_DOCS[key] ?? {
			summary: 'Undocumented',
			description: 'This route is registered but has no entry in `ROUTE_DOCS` (sync-server/src/openapi.ts). ' +
				'It is listed because it exists, not because anybody has said what it does.',
			tags: ['undocumented'], auth: false,
		}
		const op: Record<string, unknown> = {
			operationId: r.opId ?? opIdFor(method, url),
			summary: r.summary,
			tags: r.tags,
			...(ROUTE_DOCS[key] ? {} : { 'x-undocumented': true }),
			...(r.description ? { description: r.description } : {}),
			...(r.auth ? { security: [{ planToken: [] }] } : { security: [] }),
			parameters: [
				...(r.auth ? [{
					name: 'x-timeline-by', in: 'header', required: false,
					schema: { type: 'string', maxLength: 60 },
					description: 'Who to attribute the change to. Nothing verifies it — ADR 0002 removed the identity provider that could. Defaults to `agent`.',
				}, {
					// EVERY PLAN CALL TAKES IT, so it is stated once here rather than per route.
					name: 'settle', in: 'query', required: false, schema: { type: 'string', enum: ['1'] },
					description: 'Wait for Auto-order. On a plan with `autoOrder: true` the server reorders queues in the background after a change; with `settle=1` a read waits for that to finish first, and `POST /api/commands` returns only after it has settled the change you just sent (its `seq` then counts the Auto-order moves). A write does not wait for a settle that was already running, and one that cannot move the queue (a comment, a rename, a description) returns at once. Costs seconds on a large plan. No effect when `autoOrder` is off.',
				}] : []),
				...Object.entries(r.query ?? {}).map(([name, q]) => ({
					name, in: 'query', required: false,
					schema: { type: q.type }, description: q.description,
				})),
			],
			...(r.body ? {
				requestBody: { required: true, content: { 'application/json': { schema: r.body } } },
			} : {}),
			responses: {
				'200': {
					description: 'OK',
					...(r.ok ? { content: { 'application/json': { schema: r.ok } } } : {}),
				},
				'400': errorResponse,
				...(r.auth ? { '404': { ...errorResponse, description: 'No plan answers to that token — which is also the answer for a token that never existed.' } } : {}),
			},
		}
		;(paths[url] ??= {})[method.toLowerCase()] = op
	}

	return {
		openapi: '3.1.0',
		info: {
			title: 'Timeline Studio API',
			version: '1.0.0',
			license: { name: 'UNLICENSED', identifier: 'LicenseRef-proprietary' },
			description:
				'A delivery plan with real dependencies, shared live. Everything a click can do, ' +
				'a call here can do — the same `apply`, the same room, the same broadcast.\n\n' +
				'## The link is the key\n\n' +
				'There is no login, no account and no owner. A plan is addressed by a share ' +
				'token, and holding it is read AND write. There is no `/list` and there must ' +
				'not be one: an endpoint enumerating plans would hand anyone with one valid ' +
				'link the address of every other. A lost token cannot be recovered.\n\n' +
				'## Where the rest of it is\n\n' +
				'- `Command`, below — every command and its payload, held to the code by tests.\n' +
				'- `/commands.js` — that code itself (`shared/commands.js`), which the page and ' +
				'this server both run.\n' +
				'- `/AGENTS.md` — the prose companion: why you would call a thing, and the four ' +
				'plan conventions this API does not state.\n' +
				'- `/llms.txt` — the short version, for a agent arriving with only a link.',
		},
		servers: [{ url: '/', description: 'Same origin as the page. `/api/*` is forwarded to this service.' }],
		tags: [
			{ name: 'plan', description: 'Reading and writing the live shared draft.' },
			{ name: 'history', description: 'Archived versions, and the notes that describe them.' },
			{ name: 'answers', description: 'Questions about a plan. These compute; none of them writes.' },
			{ name: 'service', description: 'Liveness, the room count, and this document.' },
			{ name: 'undocumented', description: 'Registered routes nobody has described yet. This group being present IS the finding.' },
		],
		components: {
			securitySchemes: {
				planToken: {
					type: 'apiKey', in: 'header', name: 'x-timeline-token',
					description: 'The share token — the part of a plan link after the `#`. The whole credential: keep it out of URLs, logs and commits.',
				},
			},
			schemas: {
				Error: {
					type: 'object',
					properties: { error: { type: 'string' } },
					required: ['error'],
				},
				Command: {
					description:
						'One edit, tagged by `type`: each `<Type>Command` schema below is one command\'s ' +
						'payload. Task-level operations get named, semantic commands because that is where ' +
						'two people collide; everything at DOCUMENT level shares one `patchDoc`. There is no ' +
						'`addMilestone` and no `addChannelValue` for that reason — send the new ' +
						'`milestones` or `colors` list through `patchDoc`. `shared/commands.js` (served at ' +
						'`/commands.js`) is the code both the page and this server run.',
					properties: { type: { type: 'string', enum: [...COMMAND_TYPES] } },
					required: ['type'],
					oneOf: commands.oneOf,
					discriminator: { propertyName: 'type', mapping: commands.mapping },
				},
				...commands.variants,
				Version: {
					type: 'object',
					properties: {
						at: { type: 'string', format: 'date-time' },
						note: { type: 'string', description: 'The only description of a change anybody gets later.' },
						by: { type: 'string' },
						approx: { type: 'boolean', description: 'The timestamp was reconstructed rather than recorded.' },
						doc: { $ref: '#/components/schemas/Doc' },
					},
					required: ['at', 'note'],
				},
				Task: {
					type: 'object',
					description: 'Dates are NOT in here. A task carries how long the work takes and what ' +
						'it waits on; when it happens is computed from those and from how much its lane ' +
						'can run at once. `sessions` are the exception — those are facts, not forecasts: a ' +
						'running or `done` task starts at its first session, and a `done` one ends at its last stop. A paused task is ' +
						'forecast again: what is left of it waits its turn in its lane (ADR 0018).',
					properties: {
						id: { type: 'string' },
						label: { type: 'string' },
						desc: { type: 'string', description: 'Markdown.' },
						lane: { type: 'string', description: 'The team whose queue it sits in.' },
						dur: { type: 'integer', exclusiveMinimum: 0, description: 'Whole MINUTES of lane time, required (schema v7; it was a float of days before). Minutes of WORK: 15 is fifteen minutes, 120 two hours, 1440 twenty-four hours. With `hours` set they are only spent inside its windows, so 480 is one 08:00–16:00 day. Zero is refused: a zero-length task consumes no lane capacity, so every other date would be computed as though it did not exist.' },
						deps: { type: 'array', items: { type: 'string' }, description: 'Task ids this cannot start before.' },
						notBefore: { type: 'string', format: 'date-time', description: 'A floor on starting, never a position; the scheduler may push past it. ' + INSTANT },
						due: { type: 'string', format: 'date-time', description: 'When it must FINISH. Constrains nothing; exists to be compared against the computed date. ' + INSTANT },
						sessions: { type: 'array', items: { type: 'object', required: ['start', 'stop'], properties: { start: { type: 'string', format: 'date-time' }, stop: { type: ['string', 'null'], format: 'date-time' } } }, description: 'The stretches of work actually done, written by startTask/stopTask/finishTask/setSessions, and the only record of work (schema v8). Worked time is their wall-clock sum; what is left of `dur` is forecast from now while a session is open, and from its turn in the lane while paused, never under a minute. The first start is when the task started; for a `done` task, the last stop is when it finished.' },
						done: { type: 'boolean', enum: [true], description: 'Finished: written by `finishTask`, cleared by `reopenTask`. Absent means not finished. A done task has at least one session and none running. Status is derived: done; else running (a session open); else paused (sessions, none open); else not started.' },
						refinedAt: { type: 'string', format: 'date-time', description: 'When a human last read the label, description and duration and agreed. The applier clears it when any of those three changes. Never set it on a human\'s behalf. ' + INSTANT },
						createdAt: { type: 'string', format: 'date-time', description: 'When the task was added. An ISO instant, not a day number. Set from the command\'s `at`.' },
						updatedAt: { type: 'string', format: 'date-time', description: 'When the label, description or duration last changed. Absent means never edited.' },
						comments: { type: 'array', description: 'The conversation on the task, oldest first — like comments on a GitHub issue. Commentary over time (progress, findings, links); `desc` is what the task IS. Adding, editing or removing a comment never clears `refinedAt` or moves `updatedAt`. Written with `addComment` (only `text` is required over the API — the server fills `id`, `at` and `by` from `x-timeline-by`), `editComment` (sets `editedAt`) and `removeComment`.',
							items: { type: 'object', properties: {
								id: { type: 'string' }, text: { type: 'string', description: 'Markdown.' },
								at: { type: 'string', format: 'date-time' }, by: { type: 'string' },
								editedAt: { type: 'string', format: 'date-time' } } } },
						recur: { type: 'object', description: 'Present on every copy of a repeating task; written by `setRecur`, which also fills in the bookkeeping (`series`, `i`, `from`).' },
						planned: { type: 'array', items: { type: 'object', required: ['start', 'stop'], properties: { start: { type: 'string', format: 'date-time' }, stop: { type: 'string', format: 'date-time' } } }, description: 'Promised stretches (a claim about the future; `sessions` are the facts). The scheduler works around them; written by `setPlanned`, moved into `sessions` by `completePlanned`.' },
						noQueue: { type: 'boolean', description: 'Does not consume a slot in its lane. How somebody else\'s work is modelled — their task, named after them, that yours depends on.' },
						ms: { type: 'string', description: 'Milestone this feeds.' },
						url: { type: 'string', description: 'The real artefact, when the work is tracked elsewhere.' },
						ref: { type: 'string', description: 'A tracker identifier. Half a URL; the other half is per-browser.' },
						color: { type: 'array', items: { type: 'string' }, description: 'A LIST — a task can carry several.' },
						border: { type: 'string' }, fill: { type: 'string' }, shape: { type: 'string' },
					},
					required: ['id'],
					additionalProperties: false,
				},
				Doc: {
					type: 'object',
					description: 'A whole plan. `shared/types.d.ts` is the authority on this shape.',
					properties: {
						schemaVersion: { type: 'integer', description: 'The server refuses anything that is not current. Old documents are migrated on the way in.' },
						title: { type: 'string' },
						start: { type: 'string', description: 'Day zero of the chart, as YYYY-MM-DD. Moving it moves the axis, never a recorded time.' },
						autoOrder: { type: 'boolean', description: 'When true the server keeps every lane\'s queue settled: after each change that could move it, it runs the `/api/reorder` search and applies the moves itself, attributed "Auto-order", until no single move helps. Pass `settle=1` to wait for that. Patchable.' },
						rankLog: {
							type: 'array', items: { type: 'array' },
							description: 'The RANKING\'s answers to "which should happen first?" — one plan-level ranking over unfinished work, ' +
								'asked a pair at a time. Only answers are stored (`[pairKey, verdict, implied?]`); the order is derived. ' +
								'Written by `addRankAnswer` / `removeRankAnswer` / `resetRanking`, and by finishing or removing a task, ' +
								'which takes it out without re-asking anything (answers it carried are filled in, marked implied). ' +
								'Auto-order and `/api/reorder` use the ranking only to break ties: dates always win. Not patchable.',
						},
						useRankSuggestion: { type: 'boolean', description: 'Whether a `rankSuggestion` steers Auto-order and `/api/reorder`, as a weaker key under the person\'s own ranking. Absent means yes; `false` makes the suggestion display only. Patchable.' },
						rankSuggestion: {
							type: 'object',
							description: 'An agent\'s PROPOSED ranking, held apart from `rankLog` as a backdrop beneath it. `order` is the tasks first to happen first; ' +
								'the answers it implies are worked out on every read with the current dependencies, so nothing goes stale. `notes` has the reason (and `toss`) per task, ' +
								'`by`/`at` say who and when. One slot: a newer suggestion replaces it. Finishing or removing a task takes it out; ' +
								'a task added later has no suggested place. Written by `setRankSuggestion`. Not patchable.',
						},
						timeZone: { type: 'string', description: 'IANA zone the plan\'s days are counted in, e.g. `America/Chicago`. Decides which day an instant falls on, for the server and the page alike. Patchable.' },
						hours: {
							type: 'object', nullable: true,
							description: 'The ONE working calendar (schema v10; it replaced `workweek`, `holidays` and `workHours`). Wall clock in `timeZone`. Work is only scheduled inside a window, and a task started outside one burns nothing until it opens. A window is `["HH:MM", "HH:MM"]`, start before end, `"24:00"` a legal end, nothing crossing midnight; the windows of a day ascend and do not overlap, and a day may have several (a lunch gap). Absent, or a `week` with no window at all, means every hour of every day is working time. Patchable; send `null` to clear. `patchDoc` refuses `workweek`, `holidays` and `workHours` and says so.',
							properties: {
								week: { type: 'object', description: 'Windows per weekday, keys `sun mon tue wed thu fri sat`. A day that is missing or `[]` is a day off.', additionalProperties: { type: 'array', items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', pattern: '^\\d\\d:[0-5]\\d$' } } } },
								dates: { type: 'object', description: '`YYYY-MM-DD` -> the windows that REPLACE that date\'s weekday hours; `[]` means that date is off (a holiday).', additionalProperties: { type: 'array', items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', pattern: '^\\d\\d:[0-5]\\d$' } } } },
							},
						},
						notice: { type: 'string', maxLength: 1000, description: 'Free text shown above the chart to everyone with the link, rendered as markdown (links work). Absent means no notice; `null` in a patch clears it. One string shared by every writer: an automation that keeps a status line in it (e.g. when a calendar sync last ran) should rewrite only its own line and keep the rest. Display only. Patchable.' },
						weekStart: { type: 'integer', minimum: 0, maximum: 6, description: 'The day a week begins on, counted like `getUTCDay()`: 0 is Sunday, 1 Monday. Absent or null means Sunday. Where the calendar view starts its week and where the timeline draws its week rules; the scheduler never reads it. Patchable.' },
						lanes: {
							type: 'array', description: 'Teams. A lane is a QUEUE with a capacity, not a label.',
							items: { type: 'object', properties: {
								id: { type: 'string' }, label: { type: 'string' },
								cap: { type: 'integer', description: 'How many of its tasks can run at once.' },
							}, required: ['id'] },
						},
						milestones: {
							type: 'array', description: 'Dates an outcome is measured against.',
							items: { type: 'object', properties: {
								id: { type: 'string' }, label: { type: 'string' },
								date: { type: 'string' },
							}, required: ['id'] },
						},
						tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } },
						colors: { type: 'array', items: { type: 'object' }, description: 'Channel values. Ids here are what a task\'s `color` names.' },
						borders: { type: 'array', items: { type: 'object' } },
						fills: { type: 'array', items: { type: 'object' } },
						shapes: { type: 'array', items: { type: 'object' } },
						channelLabels: { type: 'object', description: 'What this plan calls each channel.' },
					},
					required: ['tasks'],
					additionalProperties: true,
				},
			},
		},
		paths,
	}
}
